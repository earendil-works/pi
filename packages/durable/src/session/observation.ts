import type {
	Context,
	JsonValue,
	ReplicatedStateSource,
	ReplicatedStateSourceAttachment,
	ReplicatedStateSourceFrame,
} from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonObject, WatchEnd, WatchHandle } from "../types.ts";

export type ObservedDocumentValue = Readonly<JsonObject> | null;

/** Maximum exact committed frames retained behind one unavailable watch listener. */
const MAX_PENDING_WATCH_FRAMES = 100;

/** Canonical terminal update for a retired document incarnation. */
export const RETIREMENT_OPERATIONS: readonly Op[] = [["r", null]];

/**
 * Session-to-Chord bridge owned one-to-one by one attached state: a document, or a conversation view. A `null` value
 * retires it. @internal
 */
export class CommittedStateSource<T = ObservedDocumentValue> implements ReplicatedStateSource<T> {
	readonly #attachments = new Set<SessionSourceAttachment<T>>();
	#release: (() => void) | undefined;
	/** Released on disposal. */
	#value: T | undefined;
	#cursor = 0;
	#retired = false;
	#closed = false;

	constructor(value: T, release: () => void) {
		this.#value = value;
		this.#release = release;
	}

	attach(): ReplicatedStateSourceAttachment<T> {
		if (this.#closed) throw new Error("State source is closed");
		const attachment = new SessionSourceAttachment({ value: this.#value as T, cursor: this.#cursor }, () => {
			this.#attachments.delete(attachment);
			if (this.#attachments.size === 0) this.#finishDisposal();
		});
		this.#attachments.add(attachment);
		return attachment;
	}

	advance(value: T, ops: readonly Op[], context: Context): void {
		if (this.#closed || this.#retired) return;
		this.#value = value;
		this.#cursor += 1;
		if (value === null) this.#retired = true;
		const frame: ReplicatedStateSourceFrame<T> = {
			cursor: this.#cursor,
			value,
			ops,
			context,
		};
		for (const attachment of [...this.#attachments]) attachment.publish(frame);
	}

	closeSession(): void {
		if (this.#closed) return;
		for (const attachment of [...this.#attachments]) attachment.dispose();
		this.#finishDisposal();
	}

	#finishDisposal(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#value = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

class SessionSourceAttachment<T> implements ReplicatedStateSourceAttachment<T> {
	readonly snapshot: { readonly value: T; readonly cursor: number };
	#release: (() => void) | undefined;
	readonly #frames: ReplicatedStateSourceFrame<T>[] = [];
	#listener: ((frame: ReplicatedStateSourceFrame<T>) => void) | undefined;
	#activated = false;
	#disposed = false;
	#scheduled = false;
	#delivering = false;

	constructor(snapshot: { readonly value: T; readonly cursor: number }, release: () => void) {
		this.snapshot = snapshot;
		this.#release = release;
	}

	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void {
		if (this.#activated) throw new Error("State attachment is already active");
		if (this.#disposed) throw new Error("State attachment is disposed");
		this.#activated = true;
		this.#listener = listener;
		this.#drain();
	}

	publish(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		this.#frames.push(frame);
		if (!this.#activated || this.#delivering || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (this.#disposed) return;
			try {
				this.#drain();
			} catch {
				// Chord's frame listener contains source-contract failures. Isolate an
				// unexpected direct listener failure to this attachment as well.
				this.dispose();
			}
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#frames.length = 0;
		this.#listener = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}

	#drain(): void {
		const listener = this.#listener;
		if (listener === undefined || this.#delivering || this.#disposed) return;
		this.#delivering = true;
		try {
			while (!this.#disposed) {
				const frame = this.#frames.shift();
				if (frame === undefined) break;
				listener(frame);
			}
		} finally {
			this.#delivering = false;
		}
	}
}

type WatchFrame<T> = {
	readonly value: T;
	readonly ops: readonly Op[];
	readonly context: Context;
};

/**
 * Serialized exact-frame watch bound to one document incarnation or conversation view. A `null` value retires it.
 * @internal
 */
export class CommittedWatch<T = ObservedDocumentValue> implements WatchHandle<T> {
	readonly #detach: () => void;
	readonly #replace: (() => T) | undefined;
	readonly #closedPromise: Promise<WatchEnd>;
	readonly #pending: WatchFrame<T>[] = [];
	#resolveClosed!: (end: WatchEnd) => void;
	#value: T;
	#listener: ((value: T, ops: readonly Op[], context: Context) => Promise<void>) | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	#detached = false;
	#retired = false;
	#end: WatchEnd | undefined;
	#resolved = false;
	#cancellationSignal: AbortSignal | undefined;
	#cancellationListener: (() => void) | undefined;

	/** `replace` gives the value an overflow delivers; by default the newest value. */
	constructor(value: T, detach: () => void, replace?: () => T) {
		this.#value = value;
		this.#detach = detach;
		this.#replace = replace;
		this.#closedPromise = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	get value(): T {
		return this.#value;
	}

	get closed(): Promise<WatchEnd> {
		return this.#closedPromise;
	}

	start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		if (this.#pending.length > 0) this.#schedule();
	}

	stop(): Promise<WatchEnd> {
		this.#terminate({ reason: "stopped" });
		return this.#closedPromise;
	}

	observeCancellation(signal: AbortSignal): void {
		if (this.#cancellationSignal !== undefined) throw new Error("Watch cancellation is already installed");
		if (this.#end !== undefined) return;
		this.#cancellationSignal = signal;
		this.#cancellationListener = () => this.cancel();
		signal.addEventListener("abort", this.#cancellationListener, { once: true });
		if (signal.aborted) this.cancel();
	}

	cancel(): void {
		this.#terminate({ reason: "cancelled" });
	}

	closeSession(): void {
		this.#terminate({ reason: "session_closed" });
	}

	advance(value: T, ops: readonly Op[], context: Context): void {
		if (this.#end !== undefined || this.#retired) return;
		if (value === null) this.#retired = true;
		if (this.#pending.length >= MAX_PENDING_WATCH_FRAMES) {
			this.#pending.length = 0;
			const replacement = this.#replace?.() ?? value;
			this.#pending.push({ value: replacement, ops: [["r", replacement as JsonValue]], context });
		} else {
			this.#pending.push({ value, ops, context });
		}
		if (this.#started) this.#schedule();
	}

	#schedule(): void {
		if (this.#scheduled || this.#running || this.#end !== undefined) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#running || this.#end !== undefined || !this.#started) {
			this.#finishIfReady();
			return;
		}
		this.#running = true;
		try {
			while (this.#end === undefined) {
				const frame = this.#pending.shift();
				if (frame === undefined) break;
				this.#value = frame.value;
				const deliveryContext = withoutAbortSignal(frame.context);
				try {
					await this.#listener!(frame.value, frame.ops, deliveryContext);
				} catch (error) {
					if (this.#end === undefined) {
						this.#terminate({ reason: "listener_error", error: toError(error) });
					}
					break;
				}
				if (frame.value === null) {
					this.#terminate({ reason: "retired" });
					break;
				}
			}
		} finally {
			this.#running = false;
			if (this.#end === undefined && this.#pending.length > 0) this.#schedule();
			this.#finishIfReady();
		}
	}

	#terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		this.#detachNow();
		this.#pending.length = 0;
		this.#finishIfReady();
	}

	#detachNow(): void {
		if (this.#detached) return;
		this.#detached = true;
		this.#detach();
	}

	#finishIfReady(): void {
		if (this.#resolved || this.#end === undefined) return;
		this.#resolved = true;
		if (this.#cancellationSignal !== undefined && this.#cancellationListener !== undefined) {
			this.#cancellationSignal.removeEventListener("abort", this.#cancellationListener);
		}
		this.#resolveClosed(this.#end);
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
