/**
 * Replicated state: an immutable JSON value with ordered, serialized change notifications. Either authoritative and
 * mutable (`replicatedState(initial)`) or a publication-only view of an external revision source
 * (`replicatedState(source)`).
 */
import { BACKGROUND_CONTEXT, type Context } from "./context/index.ts";
import { type Draft, type Op, type Prepared, type Tracker, track } from "./delta/index.ts";

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/**
	 * Contract-immutable value, or undefined until hydration. It is not frozen and may share containers with an
	 * in-process provider; consumers must not mutate it. Later updates do not mutate previously returned values.
	 */
	readonly value: T | undefined;
	/**
	 * Each subscription serializes callbacks, awaiting hydration before updates. Values are immutable and may
	 * share unchanged revision data. At most 100 deliveries wait behind the running callback; overflow keeps
	 * only the newest pending value/context/delivery, so update sequences may skip. Failures are reported in
	 * isolation and delivery continues. Unsubscribe discards pending work without aborting or joining a callback.
	 */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>): () => void;
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/**
	 * Atomically publish one synchronous overlay mutation. Draft handles are unusable after the callback returns.
	 * Values placed through the draft are cloned by value; assigning `undefined` to an object property deletes it.
	 */
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	/**
	 * Atomically take immutable ownership of an alias-free strict-JSON replacement.
	 * The caller must not mutate the transferred root after this call.
	 */
	replace(context: Context, value: T): void;
}

/** One immutable authoritative revision committed after an attachment snapshot. */
export interface ReplicatedStateSourceFrame<T> {
	/** Monotonic source cursor. The first frame after a snapshot must be `snapshot.cursor + 1`. */
	readonly cursor: number;
	/** The exact immutable value produced by this commit. */
	readonly value: T;
	/** The exact immutable operation batch that produced `value` from the preceding source revision. */
	readonly ops: readonly Op[];
	readonly context: Context;
}

export interface ReplicatedStateSourceAttachment<T> {
	/** Fixed immutable snapshot captured at the atomic attachment boundary. */
	readonly snapshot: { readonly value: T; readonly cursor: number };
	/**
	 * Install the sole listener and synchronously drain every buffered frame in source commit order.
	 * This method is single-use. After it begins, every new committed frame must also be delivered in order
	 * until disposal, including commits made reentrantly while a prior frame is being delivered.
	 */
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	/** Stop delivery and release source resources. Disposal must be idempotent. */
	dispose(): void;
}

/**
 * An authoritative immutable revision source.
 *
 * `attach()` must synchronously and atomically capture one snapshot and register the returned attachment to buffer
 * every later committed frame. The snapshot must include every commit before that boundary; buffered frames must
 * include every commit after it, with no overlap or gap. Snapshot values, frame values, and operation batches are
 * immutable and remain valid after delivery. Chord only publishes these references; it never applies or re-diffs them.
 */
export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}

export interface ReplicatedStateSourceOptions {
	/** Receives source-contract and publication-listener failures without throwing them into the source. */
	readonly onError?: (error: Error) => void;
}

/** A synchronously hydrated publication-only state backed by one source attachment. */
export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	/** Idempotently release the source attachment. The last published value remains readable. */
	dispose(): void;
}

/** The void signature also accepts synchronous callbacks that return an ignored value. */
type StateListener<T> = (value: T, context: Context, delivery: ReplicatedStateDelivery) => void;

type StateDelivery<T> = {
	readonly value: T;
	readonly context: Context;
	readonly delivery: ReplicatedStateDelivery;
};

/** One public subscription, independent of producer and other subscriber progress. */
class StateSubscriber<T> {
	readonly #listener: StateListener<T>;
	readonly #reportError: (error: Error) => void;
	readonly #pending: StateDelivery<T>[] = [];
	#running = false;
	#started = false;
	#closed = false;

	constructor(listener: StateListener<T>, reportError: (error: Error) => void) {
		this.#listener = listener;
		this.#reportError = reportError;
	}

	push(frame: StateDelivery<T>): void {
		if (this.#closed) return;
		if (this.#pending.length === 100) {
			// A cold replica can queue updates reentrantly before this subscriber's first hydration starts.
			const hydration = this.#started ? undefined : this.#pending[0];
			this.#pending.length = 0;
			if (hydration !== undefined) this.#pending.push(hydration);
		}
		this.#pending.push(frame);
	}

	drain(): void {
		if (this.#running || this.#closed) return;
		this.#running = true;
		for (let frame = this.#pending.shift(); frame !== undefined; frame = this.#pending.shift()) {
			this.#started = true;
			try {
				const result: unknown = this.#listener(frame.value, frame.context, frame.delivery);
				if (isPromiseLike(result)) {
					void Promise.resolve(result).then(
						() => this.#resume(),
						(error: unknown) => {
							this.#report(error);
							this.#resume();
						},
					);
					return;
				}
			} catch (error) {
				this.#report(error);
			}
		}
		this.#running = false;
	}

	clear(): void {
		this.#pending.length = 0;
	}

	close(): void {
		this.#closed = true;
		this.clear();
	}

	#resume(): void {
		this.#running = false;
		this.drain();
	}

	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (reportError) {
			reportErrorAsync(toError(reportError));
		}
	}
}

type Publication<T> = {
	readonly value: T;
	readonly sequence: number;
	readonly context: Context;
};

/** Maintains local publication order independently of how revisions are produced. */
class ReplicatedStatePublisher<T> {
	readonly #listeners = new Map<StateSubscriber<T>, number>();
	readonly #reportError: (error: Error) => void;
	readonly #publications: Publication<T>[] = [];
	#value: T;
	#sequence = 0;
	#delivering = false;

	constructor(initial: T, reportError: (error: Error) => void = reportErrorAsync) {
		this.#value = initial;
		this.#reportError = reportError;
	}

	get value(): T {
		return this.#value;
	}

	snapshot(): { readonly value: T; readonly sequence: number } {
		return { value: this.#value, sequence: this.#sequence };
	}

	subscribe(listener: StateListener<T>): () => void {
		const { value, sequence } = this.snapshot();
		const subscriber = new StateSubscriber(listener, this.#reportError);
		this.#listeners.set(subscriber, sequence);
		// Hydration has no caller; it is delivered with the background context.
		subscriber.push({ value, context: BACKGROUND_CONTEXT, delivery: { kind: "hydrate", sequence } });
		subscriber.drain();
		return () => {
			subscriber.close();
			this.#listeners.delete(subscriber);
		};
	}

	/** Publish an already-prepared immutable revision. Subscriber failures are reported, never thrown. */
	publish(value: T, context: Context): void {
		this.#value = value;
		this.#sequence += 1;
		this.#publications.push({ value, sequence: this.#sequence, context });
		if (this.#delivering) return;

		this.#delivering = true;
		try {
			for (
				let publication = this.#publications.shift();
				publication !== undefined;
				publication = this.#publications.shift()
			) {
				const delivery = { kind: "update", sequence: publication.sequence } as const;
				for (const [subscriber, hydratedSequence] of [...this.#listeners]) {
					if (publication.sequence <= hydratedSequence) continue;
					subscriber.push({ value: publication.value, context: publication.context, delivery });
					subscriber.drain();
				}
			}
		} finally {
			this.#delivering = false;
		}
	}
}

class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	readonly #tracker: Tracker<T>;
	readonly #publisher: ReplicatedStatePublisher<T>;
	#changing = false;

	constructor(initial: T) {
		this.#tracker = track(initial);
		this.#publisher = new ReplicatedStatePublisher(this.#tracker.value);
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
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
	}

	replace(context: Context, value: T): void {
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		const prepared = this.#tracker.prepareReplace(value);
		this.#tracker.adopt(prepared);
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
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
		this.#reportError = options.onError ?? reportErrorAsync;
		this.#publisher = new ReplicatedStatePublisher(snapshot.value, (error) => this.#report(error));
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
			this.#publisher.publish(frame.value, frame.context);
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
function attachReplicatedStateSource<T>(
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

function reportErrorAsync(error: Error): void {
	queueMicrotask(() => {
		throw error;
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function replicatedState<T>(
	source: ReplicatedStateSource<T>,
	options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;
/**
 * Create authoritative state by taking immutable ownership of an alias-free strict-JSON root.
 * The caller must not mutate `initial` after this call.
 */
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
export function replicatedState(
	initialOrSource: object | ReplicatedStateSource<unknown>,
	options?: ReplicatedStateSourceOptions,
): MutableReplicatedState<object> | AttachedReplicatedState<unknown> {
	if (isReplicatedStateSource(initialOrSource)) return attachReplicatedStateSource(initialOrSource, options);
	return new MutableReplicatedStateImpl(initialOrSource);
}

function isReplicatedStateSource(value: object): value is ReplicatedStateSource<unknown> {
	return typeof (value as { readonly attach?: unknown }).attach === "function";
}
