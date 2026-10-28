// Chord's JSON watchables: sources (documents and derives, with their watches and dependent derives) and constants.

import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { Watch, type Watchable, type WatchCall, type WatchEnd } from "../../watch.ts";
import type { Batch } from "./batch.ts";

/**
 * A synchronous subscriber of a source (a hold over a link, a member source): fed the source's call inside the batch
 * that made it, before the batch ends, so everything one commit changed can leave in one message. The watch's own sink
 * shape (`Watch.advance`, `Watch.end`).
 */
export interface Subscriber {
	/**
	 * The source's call of this batch, in its batch's `context`: a value (the ops from the previous one, and whether its
	 * document was retired in it, or for a derive one of its sources' documents), or a failure it may recover from; the
	 * next value after a failure is `[["r", value]]`.
	 */
	advance(call: WatchCall<JsonValue>, context: Context): void;
	/** The source ended for good with `end`; nothing follows, and the subscriber is dropped. */
	end(end: WatchEnd): void;
	/**
	 * The source ended for good after its last call (a followed runtime ended): a subscriber delivering later (a watch)
	 * ends `ended` once it delivered what it was given, others end now.
	 */
	endAfterDelivery(): void;
}

/**
 * What a new watch of a source starts at (design §11): its value, or, while it is failed, the failure and its last good
 * value (`undefined` when it never had one: a watch cannot start then, there is nothing to start at).
 */
export type WatchStart =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined };

/**
 * An error Chord hands to apps (a failure call, a report), its stack made text first: until then V8 keeps the frames'
 * receivers, which would keep the host behind the throw alive for as long as an app keeps the error.
 */
export function handedOut<E>(error: E): E {
	if (error instanceof Error) void error.stack;
	return error;
}

/**
 * What reads a source and is marked by its changes: a derive, or a member source forwarding to derives (`Source.
 * dependents`).
 */
export interface Dependent {
	/** The source changed in the current batch: flags only, no compute. */
	invalidate(): void;
	/** A source's document was retired in the current batch (rule 21); `visited` keeps a diamond walked once. */
	sourceRetired(visited: Set<Dependent>): void;
}

const ENDED: WatchEnd = { kind: "ended" };

/**
 * A changing value on a host (a singleton document, a derive, a replica): its watches and subscribers get one frame
 * per batch that changed it, and the derives reading it are marked dirty when it changes.
 */
export abstract class Source implements Watchable<JsonValue> {
	/** Derives reading this source (and member sources forwarding to some); each removes itself when it stops. */
	readonly dependents = new Set<Dependent>();
	protected readonly batch: Batch;
	readonly #watches = new Set<Watch<JsonValue>>();
	readonly #subscribers = new Set<Subscriber>();

	constructor(batch: Batch) {
		this.batch = batch;
	}

	abstract get value(): JsonValue;

	/** Whether a watch or a subscriber follows this source. */
	get watched(): boolean {
		return this.#watches.size > 0 || this.#subscribers.size > 0;
	}

	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.openWatch(context);
	}

	/**
	 * `watch` without the Promise, for references, which must register the watch before anything else runs. On a failed
	 * source it opens at the last good value and its first call is the failure; with no value to start at it throws the
	 * failure.
	 */
	openWatch(context: Context): Watch<JsonValue> {
		this.batch.assertOutside("watch");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const value = start.kind === "value" ? start.value : start.last!;
		const watch: Watch<JsonValue> = new Watch(value, () => this.#watches.delete(watch), this.batch.reportListener);
		this.#watches.add(watch);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		if (start.kind === "failed") watch.fail(start.error, context);
		return watch;
	}

	/** What a new watch starts at; a source that can fail and recover tells its failure (`WatchStart`). */
	start(): WatchStart {
		return { kind: "value", value: this.value };
	}

	/** Feeds `subscriber` every frame from now on, inside each batch; the caller took the current value first. */
	subscribe(subscriber: Subscriber): void {
		this.#subscribers.add(subscriber);
	}

	unsubscribe(subscriber: Subscriber): void {
		this.#subscribers.delete(subscriber);
	}

	/** Delivers this batch's frame to its watches; called once per batch that listed it with `changed`. */
	abstract deliver(context: Context): void;

	/** Records a change in the current batch: listed for a frame when watched, and every dependent marked dirty. */
	protected changed(): void {
		if (this.watched) this.batch.changed(this);
		for (const derive of this.dependents) derive.invalidate();
	}

	/**
	 * Records a retirement of this source's document in the current batch: every derive reading it, directly or
	 * through other derives, carries the flag on in its frame (rule 21). Called after `changed`.
	 */
	protected retiredInBatch(): void {
		// Allocated only for a retirement, which is rare.
		const visited = new Set<Dependent>();
		for (const derive of this.dependents) derive.sourceRetired(visited);
	}

	/** Queues one frame on every watch and feeds it to every subscriber. */
	protected publish(value: JsonValue, ops: readonly Op[], retired: boolean, context: Context): void {
		this.forward({ kind: "value", value, ops, retired }, context);
	}

	/** Queues `call` on every watch and feeds it to every subscriber, as it is (a member source passes one on). */
	protected forward(call: WatchCall<JsonValue>, context: Context): void {
		for (const watch of this.#watches) watch.advance(call, context);
		for (const subscriber of this.#subscribers) subscriber.advance(call, context);
	}

	/**
	 * Gives every watch and subscriber one failure call (design §11): the source cannot compute its value now and may
	 * recover; they stay open, and its next value is `[["r", value]]`.
	 */
	protected failWatches(error: unknown, context: Context): void {
		this.forward({ kind: "failed", error: handedOut(error) }, context);
	}

	/**
	 * Ends every watch and subscriber for good once what they were given is delivered (a followed runtime ended after a
	 * last call, Durable's `endAfterDelivery`): `ended`; nothing follows.
	 */
	protected endWatchesAfterDelivery(): void {
		for (const watch of [...this.#watches]) watch.endAfterDelivery();
		if (this.#subscribers.size === 0) return;
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.endAfterDelivery();
	}

	/** Ends every watch and subscriber for good (its owner ended): `ended`; nothing follows. */
	protected endWatches(): void {
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		for (const watch of this.#watches) watch.end(ENDED);
		if (this.#subscribers.size === 0) return;
		// A copy: a subscriber may unsubscribe as it ends.
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.end(ENDED);
	}
}

/** A watchable that never changes (start data, §18); usable as a state member and as a derive source. */
export function constant<const T extends JsonValue>(value: T): Watchable<T> {
	// The constant holds `value` as it was given.
	return new Constant(value) as unknown as Watchable<T>;
}

/** The watchable behind `constant(value)`: its watches never get a frame and end only by stop or cancellation. */
export class Constant implements Watchable<JsonValue> {
	readonly value: JsonValue;

	constructor(value: JsonValue) {
		this.value = value;
	}

	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.openWatch(context);
	}

	/** As `Source.openWatch`; nothing is delivered, so nothing is reported. */
	openWatch(context: Context): Watch<JsonValue> {
		const watch = new Watch<JsonValue>(
			this.value,
			() => {},
			() => {},
		);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		return watch;
	}
}
