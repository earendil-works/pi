import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { applyImmutable, isBase, type Op, type Prepared, type Tracker, track } from "../delta/index.ts";
import { JsonRevisionValidator } from "../delta/revision-validator.ts";
import type {
	AttachedReplicatedState,
	Context,
	JsonValue,
	MutableReplicatedState,
	ReplicatedState,
	ReplicatedStateDelivery,
	ReplicatedStateSource,
	ReplicatedStateSourceAttachment,
	ReplicatedStateSourceFrame,
	ReplicatedStateSourceOptions,
} from "../types.ts";
import { registerReplicatedStateInternals } from "./state-internals.ts";

type StateListener<T> = (value: T, context: Context, delivery: ReplicatedStateDelivery) => void;
type SourceListener = (ops: readonly Op[], sequence: number, context: Context) => void;

type Publication<T> = {
	readonly value: T;
	readonly ops: readonly Op[];
	readonly sequence: number;
	readonly context: Context;
};

/** Maintains local publication order independently of how revisions are produced. */
class ReplicatedStatePublisher<T> {
	readonly #listeners = new Map<StateListener<T>, number>();
	readonly #sourceListeners = new Set<SourceListener>();
	readonly #publications: Publication<T>[] = [];
	#value: T;
	#sequence = 0;
	#delivering = false;

	constructor(initial: T) {
		this.#value = initial;
	}

	get value(): T {
		return this.#value;
	}

	snapshot(): { readonly value: T; readonly sequence: number } {
		return { value: this.#value, sequence: this.#sequence };
	}

	subscribe(listener: StateListener<T>): () => void {
		const { value, sequence } = this.snapshot();
		this.#listeners.set(listener, sequence);
		try {
			listener(value, serviceDeliveryContext(), { kind: "hydrate", sequence });
		} catch (error) {
			this.#listeners.delete(listener);
			throw error;
		}
		return () => this.#listeners.delete(listener);
	}

	subscribeSource(listener: SourceListener): () => void {
		this.#sourceListeners.add(listener);
		return () => this.#sourceListeners.delete(listener);
	}

	/** Publish an already-prepared immutable revision and return isolated listener failures. */
	publish(value: T, ops: readonly Op[], context: Context): unknown[] {
		this.#value = value;
		this.#sequence += 1;
		this.#publications.push({ value, ops, sequence: this.#sequence, context });
		if (this.#delivering) return [];

		this.#delivering = true;
		const errors: unknown[] = [];
		try {
			for (
				let publication = this.#publications.shift();
				publication !== undefined;
				publication = this.#publications.shift()
			) {
				for (const listener of [...this.#sourceListeners]) {
					try {
						listener(publication.ops, publication.sequence, publication.context);
					} catch (error) {
						errors.push(error);
					}
				}
				const delivery = { kind: "update", sequence: publication.sequence } as const;
				for (const [listener, hydratedSequence] of [...this.#listeners]) {
					if (publication.sequence <= hydratedSequence) continue;
					try {
						listener(publication.value, publication.context, delivery);
					} catch (error) {
						errors.push(error);
					}
				}
			}
		} finally {
			this.#delivering = false;
		}
		return errors;
	}
}

export class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	readonly #tracker: Tracker<T>;
	readonly #publisher: ReplicatedStatePublisher<T>;
	#changing = false;

	constructor(initial: T) {
		this.#tracker = track(initial);
		this.#publisher = new ReplicatedStatePublisher(this.#tracker.value);
		registerReplicatedStateInternals(this, {
			snapshot: () => this.#publisher.snapshot(),
			subscribe: (listener) => this.#publisher.subscribeSource(listener),
		});
	}

	get value(): T {
		return this.#tracker.value;
	}

	change(context: Context, mutate: Parameters<MutableReplicatedState<T>["change"]>[1]): void {
		if (this.#changing) throw new Error("Replicated state cannot be changed reentrantly from a change callback");
		this.#changing = true;
		let prepared: Prepared<T>;
		try {
			const change = this.#tracker.beginChange();
			try {
				const outcome = (mutate as (draft: typeof change.state) => unknown)(change.state);
				if (isPromiseLike(outcome)) {
					void Promise.resolve(outcome).catch(() => undefined);
					throw new TypeError("Replicated state change callbacks must be synchronous");
				}
				prepared = change.prepare();
			} catch (error) {
				change.abort();
				throw error;
			}
		} finally {
			this.#changing = false;
		}

		this.#tracker.adopt(prepared);
		if (prepared.ops.length === 0) return;
		throwCollectedErrors(
			this.#publisher.publish(prepared.value, prepared.ops, context),
			"Replicated state listeners failed",
		);
	}

	replace(context: Context, value: T): void {
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		const prepared = this.#tracker.prepareReplace(value);
		this.#tracker.adopt(prepared);
		if (prepared.ops.length === 0) return;
		throwCollectedErrors(
			this.#publisher.publish(prepared.value, prepared.ops, context),
			"Replicated state listeners failed",
		);
	}

	subscribe(listener: StateListener<T>): () => void {
		return this.#publisher.subscribe(listener);
	}
}

class AttachedReplicatedStateImpl<T> implements AttachedReplicatedState<T> {
	readonly #publisher: ReplicatedStatePublisher<T>;
	readonly #attachment: ReplicatedStateSourceAttachment<T>;
	readonly #reportError: (error: Error) => void;
	#cursor: number;
	#disposed = false;

	constructor(attachment: ReplicatedStateSourceAttachment<T>, options: ReplicatedStateSourceOptions) {
		const { snapshot } = attachment;
		assertCursor(snapshot.cursor, "snapshot");
		this.#attachment = attachment;
		this.#cursor = snapshot.cursor;
		this.#publisher = new ReplicatedStatePublisher(snapshot.value);
		this.#reportError = options.onError ?? reportErrorAsync;
		registerReplicatedStateInternals(this, {
			snapshot: () => this.#publisher.snapshot(),
			subscribe: (listener) => this.#publisher.subscribeSource(listener),
		});
	}

	get value(): T {
		return this.#publisher.value;
	}

	subscribe(listener: StateListener<T>): () => void {
		return this.#publisher.subscribe(listener);
	}

	activate(): void {
		this.#attachment.activate((frame) => this.#receive(frame));
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#attachment.dispose();
	}

	#receive(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		try {
			assertCursor(frame.cursor, "frame");
			const expected = this.#cursor + 1;
			if (frame.cursor !== expected) {
				throw new Error(`Replicated state source cursor has a gap: expected ${expected}, received ${frame.cursor}`);
			}
			this.#cursor = frame.cursor;
			const errors = this.#publisher.publish(frame.value, frame.ops, frame.context);
			if (errors.length === 1) this.#report(errors[0]);
			else if (errors.length > 1) this.#report(new AggregateError(errors, "Replicated state listeners failed"));
		} catch (error) {
			this.#fail(toError(error));
		}
	}

	#fail(error: Error): void {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.#attachment.dispose();
		} catch (disposeError) {
			this.#report(new AggregateError([error, disposeError], "Replicated state source contract failed"));
			return;
		}
		this.#report(error);
	}

	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (reportError) {
			reportErrorAsync(toError(reportError));
		}
	}
}

/** Attach a publication-only replicated state to one authoritative immutable source stream. */
export function attachReplicatedStateSource<T>(
	source: ReplicatedStateSource<T>,
	options: ReplicatedStateSourceOptions = {},
): AttachedReplicatedState<T> {
	const attachment = source.attach();
	try {
		const state = new AttachedReplicatedStateImpl(attachment, options);
		state.activate();
		return state;
	} catch (error) {
		try {
			attachment.dispose();
		} catch (disposeError) {
			throw new AggregateError([error, disposeError], "Failed to attach replicated state source");
		}
		throw error;
	}
}

/** A cold read-only state used by service consumers until a complete snapshot arrives. */
export class ReplicatedStateReplica<T extends JsonValue = JsonValue> implements ReplicatedState<T> {
	readonly #listeners = new Set<StateListener<T>>();
	readonly #reportError: (error: Error) => void;
	readonly #validator = new JsonRevisionValidator();
	#value: T | undefined;
	#sequence: number | undefined;

	constructor(reportError: (error: Error) => void) {
		this.#reportError = reportError;
	}

	get value(): T | undefined {
		return this.#value;
	}

	subscribe(listener: StateListener<T>): () => void {
		this.#listeners.add(listener);
		if (this.#value !== undefined) {
			this.#deliver(listener, this.#value, serviceDeliveryContext(), {
				kind: "hydrate",
				sequence: this.#sequence!,
			});
		}
		return () => this.#listeners.delete(listener);
	}

	hydrate(sequence: number, ops: readonly Op[], context: Context): void {
		let next: T;
		try {
			if (!isBase(ops)) throw new Error("Replicated state snapshot is not a base operation batch");
			next = this.#validator.validate(applyImmutable<T>(undefined, ops));
		} catch (error) {
			this.clear();
			throw error;
		}
		this.#sequence = sequence;
		this.#value = next;
		this.#deliverAll(context, { kind: "hydrate", sequence });
	}

	update(sequence: number, ops: readonly Op[], context: Context): void {
		if (this.#sequence === undefined || this.#value === undefined) {
			throw new Error("Replicated state received an update before hydration");
		}
		if (sequence !== this.#sequence + 1) {
			this.clear();
			throw new Error("Replicated state update sequence has a gap");
		}
		let next: T;
		try {
			next = this.#validator.validate(applyImmutable(this.#value, ops));
		} catch (error) {
			this.clear();
			throw error;
		}
		this.#sequence = sequence;
		this.#value = next;
		this.#deliverAll(context, { kind: "update", sequence });
	}

	clear(): void {
		this.#value = undefined;
		this.#sequence = undefined;
	}

	#deliverAll(context: Context, delivery: ReplicatedStateDelivery): void {
		if (this.#value === undefined) return;
		for (const listener of this.#listeners) this.#deliver(listener, this.#value, context, delivery);
	}

	#deliver(listener: StateListener<T>, value: T, context: Context, delivery: ReplicatedStateDelivery): void {
		try {
			listener(value, context, delivery);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

/** @internal Context for synthetic service deliveries without a caller. */
export function serviceDeliveryContext(): Context {
	// TODO: Add delivery-scoped cancellation or metadata if deliveries gain an owned lifecycle.
	return BACKGROUND_CONTEXT;
}

function assertCursor(cursor: number, kind: "snapshot" | "frame"): void {
	if (!Number.isSafeInteger(cursor))
		throw new TypeError(`Replicated state source ${kind} cursor must be a safe integer`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

function reportErrorAsync(error: Error): void {
	queueMicrotask(() => {
		throw error;
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
