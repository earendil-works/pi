// Watch handles: the watch types and the one implementation of their lifecycle, for JSON and native values.
import { type Context, withoutAbortSignal } from "./context/index.ts";
import { type Op, PendingOps } from "./delta/index.ts";
import type { JsonValue } from "./json.ts";

/**
 * Terminal result of one watch.
 *
 * - `stopped`: `stop()` was called.
 * - `cancelled`: the context the watch was acquired with was cancelled.
 * - `ended`: the source closed (its owner ended or closed).
 * - `listener_error`: the listener threw or rejected with `error`.
 * - `failed`: the source failed with `error`.
 */
export type WatchEnd =
	| { readonly reason: "stopped" | "cancelled" | "ended" }
	| { readonly reason: "listener_error"; readonly error: Error }
	| { readonly reason: "failed"; readonly error: unknown };

/**
 * One call of a JSON watch's listener, and one change a source hands its watch: the newest value, the ops that turn the
 * previous value into it, and whether the document the watch follows was retired since the previous call. A retirement
 * does not end the watch: `value` is then what the address shows after it (the source decides; a Durable document keeps
 * the last value the watch was given, with no ops), and a document created there later arrives as `[["r", value]]`,
 * possibly in the same call. Plain data: the frame's context is the listener's second argument, never part of the
 * change.
 */
export type WatchChange<T> = { readonly value: T; readonly ops: readonly Op[]; readonly retired: boolean };

/** One call of a native watch's listener: the new value. */
export type NativeWatchChange<T> = { readonly value: T };

/**
 * Serialized observation of an immutable value: one listener call at a time; changes made meanwhile arrive folded into
 * the next call.
 */
export interface WatchHandle<T> {
	/** Acquisition revision before start; latest delivered immutable revision afterward. */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (change: WatchChange<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

/**
 * A value that changes and can be watched: documents, derives, members of references. Values are immutable by
 * convention (JSON for state); each watch starts at the current value and then gets the changes, folded while its
 * listener is busy.
 */
export interface Watchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then its changes; the context's cancellation ends it. */
	watch(context: Context): Promise<WatchHandle<T>>;
}

/**
 * An in-process value that changes and can be watched (it may hold anything, errors and functions included): a change
 * is a new value by identity, delivered without ops.
 */
export interface NativeWatchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then one frame per new value; the context's cancellation ends it. */
	watch(context: Context): Promise<NativeWatchHandle<T>>;
}

/**
 * Serialized observation of an in-process value: as `WatchHandle`, but each new value is its own call, in order, without
 * ops.
 */
export interface NativeWatchHandle<T> {
	/** Acquisition value before start; latest delivered value afterward. */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (change: NativeWatchChange<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

type Listener<C> = (change: C, context: Context) => Promise<void>;

/**
 * The lifecycle both handles share: serialized delivery and termination. A source feeds it and ends it explicitly;
 * termination drops every reference the watch holds into its source, so a stopped watch that is still referenced keeps
 * nothing but its last value alive. Subclasses keep what is pending, each change apart from its frame's context, so the
 * change a listener gets carries nothing but its data.
 */
abstract class WatchLifecycle<T, C extends { readonly value: T }> {
	#detach: (() => void) | undefined;
	#report: ((error: unknown) => void) | undefined;
	readonly #closed = Promise.withResolvers<WatchEnd>();
	#value: T;
	#listener: Listener<C> | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	/** Set by `endAfterDelivery()`: the source sends nothing more; the watch ends `ended` once it delivered the rest. */
	#ending = false;
	/** Set once, by `#terminate()`. */
	#end: WatchEnd | undefined;
	#cancellationSignal: AbortSignal | undefined;
	#cancellationListener: (() => void) | undefined;

	constructor(value: T, detach: () => void, report: (error: unknown) => void) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
	}

	get value(): T {
		return this.#value;
	}

	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}

	start(listener: Listener<C>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		this.#schedule();
	}

	stop(): Promise<WatchEnd> {
		this.#terminate({ reason: "stopped" });
		return this.#closed.promise;
	}

	/** End the watch `cancelled` when `signal` aborts; installed once. */
	observeCancellation(signal: AbortSignal): void {
		if (this.#cancellationSignal !== undefined) throw new Error("Watch cancellation is already installed");
		if (this.#end !== undefined) return;
		this.#cancellationSignal = signal;
		this.#cancellationListener = () => this.cancel();
		signal.addEventListener("abort", this.#cancellationListener, { once: true });
		if (signal.aborted) this.cancel();
	}

	/** End the watch `cancelled`: its acquisition context was cancelled. */
	cancel(): void {
		this.#terminate({ reason: "cancelled" });
	}

	/**
	 * The source closed: end with `ended`, or with `failed` and the error when the source failed, at once, dropping what
	 * is pending.
	 */
	end(failure?: { readonly error: unknown }): void {
		this.#terminate(failure === undefined ? { reason: "ended" } : { reason: "failed", error: failure.error });
	}

	/**
	 * The source sends nothing more after its last frames, such as a retirement: take no more frames, deliver what is
	 * pending, then end `ended`, after the running call returns, if one runs. Until then the watch stays attached, so
	 * `end()`, `stop()`, cancellation, and a throwing listener still end it first; a watch never started keeps what is
	 * pending until one of them or `start()`.
	 */
	endAfterDelivery(): void {
		if (this.#end !== undefined || this.#ending) return;
		this.#ending = true;
		if (!this.#running && this.pendingContext === undefined) this.#terminate({ reason: "ended" });
	}

	/** Whether the watch still takes frames: it has not ended, and its source has not ended. */
	protected get open(): boolean {
		return this.#end === undefined && !this.#ending;
	}

	/** The context of the newest frame the next call covers, or undefined when nothing is pending. */
	protected abstract get pendingContext(): Context | undefined;

	/** Take the next change; called only while something is pending. */
	protected abstract next(): C;

	/** Drop everything pending and every reference into the source; called once, on termination. */
	protected abstract release(): void;

	/** Something became pending: deliver it once started, never inline. */
	protected pending(): void {
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

	/**
	 * Deliver until nothing is pending; what arrives during a call is taken after it returns. A watch whose source ended
	 * ends once it delivered the rest and its last call returned.
	 */
	async #drain(): Promise<void> {
		if (this.#running || this.#end !== undefined || !this.#started) return;
		this.#running = true;
		try {
			while (this.#end === undefined) {
				const listener = this.#listener;
				if (listener === undefined) break;
				const frameContext = this.pendingContext;
				if (frameContext === undefined) {
					if (this.#ending) this.#terminate({ reason: "ended" });
					break;
				}
				const change = this.next();
				this.#value = change.value;
				try {
					await listener(change, withoutAbortSignal(frameContext));
				} catch (error) {
					if (this.#end === undefined) {
						this.#report?.(error);
						this.#terminate({ reason: "listener_error", error: toError(error) });
					}
					break;
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/**
	 * End the watch, once: detach, drop what is pending and every reference into the source, and settle `closed`. A
	 * callback already running keeps running.
	 */
	#terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#listener = undefined;
		this.release();
		if (this.#cancellationListener !== undefined) {
			this.#cancellationSignal?.removeEventListener("abort", this.#cancellationListener);
		}
		this.#cancellationSignal = undefined;
		this.#cancellationListener = undefined;
		detach?.();
		this.#closed.resolve(end);
	}
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	try {
		return new Error(String(error));
	} catch {
		return new Error(Object.prototype.toString.call(error));
	}
}

/**
 * The watch handle of a JSON source. Frames that arrive before `start()` or while the listener runs wait in one
 * `PendingOps` queue; the next call gets the newest value, the folded ops of every frame since the previous call (or
 * `[["r", newest]]` after the queue overflowed), `retired` when any of them was a retirement, and the newest frame's
 * context. A frame delivered alone is passed on as the source made it. `detach` unsubscribes it from its source on
 * termination; `report` gets a listener's throw, which also ends the watch.
 */
export class Watch<T> extends WatchLifecycle<T, WatchChange<T>> implements WatchHandle<T> {
	readonly #ops = new PendingOps();
	/**
	 * The source's change while it is the only frame pending: the call passes it on, with no allocation. A second frame
	 * drops it, so its ops stay only as long as `PendingOps` keeps them (folded, or dropped by an overflow).
	 */
	#lone: WatchChange<T> | undefined;
	/** The newest frame's value and context, while a call is pending; the context also marks that one is. */
	#newestValue: T | undefined;
	#newestContext: Context | undefined;
	/** A pending frame was a retirement. */
	#retired = false;

	/**
	 * Queue the frame `change`: its ops turn the previous value into its value, and `retired` says the document the
	 * watch follows was retired, which the next call reports however many frames it folds.
	 */
	advance(change: WatchChange<T>, context: Context): void {
		if (!this.open) return;
		this.#lone = this.#newestContext === undefined ? change : undefined;
		this.#ops.push(change.ops);
		this.#newestValue = change.value;
		this.#newestContext = context;
		if (change.retired) this.#retired = true;
		this.pending();
	}

	protected get pendingContext(): Context | undefined {
		return this.#newestContext;
	}

	protected next(): WatchChange<T> {
		const lone = this.#lone;
		// Set with the context, which says a frame is pending.
		const value = this.#newestValue as T;
		const batch = this.#ops.take();
		const retired = this.#retired;
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
		// One frame never folds or overflows: its change is the call's.
		if (lone !== undefined) return lone;
		// Values of a JSON watch are JSON; `T` is the source's narrower or wider view of them (e.g. a typed document).
		const ops: readonly Op[] = batch.kind === "ops" ? batch.ops : [["r", value as JsonValue]];
		return { value, ops, retired };
	}

	protected release(): void {
		this.#ops.take();
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
	}
}

/** Maximum values retained behind one unavailable native watch listener. */
const MAX_PENDING_NATIVE_VALUES = 100;

/**
 * The watch handle of a native source: every value in order, one call each; past 100 pending values they collapse to
 * one, `replace()` or by default the newest value. `detach` and `report` as for `Watch`.
 */
export class NativeWatch<T> extends WatchLifecycle<T, NativeWatchChange<T>> implements NativeWatchHandle<T> {
	/**
	 * Pending values in order, each followed by its frame's context, from `#head` on. Values are kept raw: the change a
	 * call gets is built when it is taken, so a value an overflow drops costs no object. A read index instead of
	 * `shift()` takes a backlog in constant time per value; taken slots are cleared at once, the array is emptied once
	 * all of it was taken, and its taken prefix dropped after 100 values.
	 */
	readonly #pending: Array<T | Context | undefined> = [];
	#head = 0;
	#replace: (() => T) | undefined;

	constructor(value: T, detach: () => void, report: (error: unknown) => void, replace?: () => T) {
		super(value, detach, report);
		this.#replace = replace;
	}

	/** Queue `value`, the source's new value. */
	advance(value: T, context: Context): void {
		if (!this.open) return;
		if (this.#pending.length - this.#head < 2 * MAX_PENDING_NATIVE_VALUES) {
			this.#pending.push(value, context);
		} else {
			this.#pending.length = 0;
			this.#head = 0;
			this.#pending.push(this.#replace === undefined ? value : this.#replace(), context);
		}
		this.pending();
	}

	protected get pendingContext(): Context | undefined {
		// The slot after a value holds its context; past the end it is empty.
		return this.#pending[this.#head + 1] as Context | undefined;
	}

	protected next(): NativeWatchChange<T> {
		const head = this.#head;
		const pending = this.#pending;
		// The slot at `#head` holds a value.
		const value = pending[head] as T;
		if (head + 2 === pending.length) {
			pending.length = 0;
			this.#head = 0;
		} else if (head + 2 >= 2 * MAX_PENDING_NATIVE_VALUES) {
			// A backlog that never drains: drop the taken prefix, at most once per 100 values, so the array stays bounded.
			pending.copyWithin(0, head + 2);
			pending.length -= head + 2;
			this.#head = 0;
		} else {
			pending[head] = undefined;
			pending[head + 1] = undefined;
			this.#head = head + 2;
		}
		return { value };
	}

	protected release(): void {
		this.#pending.length = 0;
		this.#head = 0;
		this.#replace = undefined;
	}
}
