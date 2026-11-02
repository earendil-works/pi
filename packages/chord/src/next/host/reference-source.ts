// A reference's member as consumers follow it (decision "References are the only indirection", §7): a consumer's
// watches and derives over `ref.member` (or a key of a keyed member) attach here, and this passes them straight through
// to the object instance's own document or derive (its watches and subscribers subscribe there: no extra hop on
// commits, the commit's value and ops by reference). When the reference's target moves to a new instance (or a new
// object of its identity), it moves them and sends one frame, a diff from the last value; while it points at nothing it
// keeps the last value (a pointer, no copy), with one `failed` call when its target failed (none while it loads).

import type { Context } from "../../context/index.ts";
import { diffRevisions, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { Watch, type WatchCall, type WatchEnd } from "../../watch.ts";
import type { ChordError } from "../data/index.ts";
import {
	type Batch,
	type Dependent,
	type DeriveSource,
	handedOut,
	Source,
	type Subscriber,
	type WatchStart,
} from "../state/internal.ts";

/**
 * Where a reference's source stands: never had a value (`unbound`: reads throw what its reference has instead),
 * following an instance's member, holding its last value while pointing at nothing (`failure` while its target is
 * failed: new watches start with it; `told`: its watches got a failure since that value, so the next is whole), failed
 * (a member its target's live variant lacks, or its compute threw when it was held: reads throw, `last` is the last
 * good value) or ended with its reference (nothing kept).
 */
type SourceState =
	| { readonly kind: "unbound" }
	| { readonly kind: "bound"; readonly source: DeriveSource }
	| { readonly kind: "held"; readonly value: JsonValue; readonly failure: unknown; readonly told: boolean }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

/** A reference owning its sources: what a read of one that never had a value throws. */
export interface SourceOwner {
	none(): ChordError;
}

const ENDED: WatchEnd = { kind: "ended" };

/** No failure told: a held value's `failure` while its target loads. */
const NO_FAILURE = undefined;

/**
 * One member (or key) of one reference. Bound, it is a dependent of the instance's member (its own dependents are
 * marked with it); its watches and subscribers subscribe to that member itself, so the member's frames reach them as
 * they are, and a derive member stays lazy while nothing follows it; holding or moving moves them.
 */
export class ReferenceSource extends Source implements Dependent {
	#state: SourceState = { kind: "unbound" };
	/**
	 * Its watches and subscribers, each subscribed to the bound member while bound; held, they get nothing. Made by the
	 * first.
	 */
	#passed: Set<Subscriber> | undefined;
	/** What its watches had at a re-bind (`undefined` for no value: they had a failure), until the re-bind's frame. */
	#framed: { readonly value: JsonValue | undefined } | undefined;
	/** Its reference: what a read throws while it never had a value (its failure, `not_ready`, or `released`). */
	readonly #owner: SourceOwner;

	constructor(batch: Batch, owner: SourceOwner) {
		super(batch);
		this.#owner = owner;
	}

	/** Whether it never had a value (a watch waits for its reference's values first). */
	get unbound(): boolean {
		return this.#state.kind === "unbound";
	}

	get value(): JsonValue {
		const state = this.#state;
		switch (state.kind) {
			case "bound":
				return state.source.value;
			case "held":
				// A derive over a failed reference's member computes on its last value too (owner, G2: A).
				return state.value;
			case "unbound":
				throw this.#owner.none();
			default:
				throw state.error;
		}
	}

	/** What a new watch starts at: the bound member's start, the held value (after its failure), or the failure. */
	start(): WatchStart {
		const state = this.#state;
		switch (state.kind) {
			case "bound":
				return state.source instanceof Source ? state.source.start() : { kind: "value", value: state.source.value };
			case "held":
				return state.failure === NO_FAILURE
					? { kind: "value", value: state.value }
					: { kind: "failed", error: state.failure, last: state.value };
			case "failed":
				return { kind: "failed", error: state.error, last: state.last };
			case "unbound":
				throw this.#owner.none();
			case "ended":
				throw state.error;
		}
	}

	/**
	 * A watch subscribed to the bound member itself (as `Source.openWatch` starts one: on a failed member at its last
	 * good value, the failure first).
	 */
	openWatch(context: Context): Watch<JsonValue> {
		this.batch.assertOutside("watch");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const value = start.kind === "value" ? start.value : start.last!;
		const watch: Watch<JsonValue> = new Watch(value, () => this.unsubscribe(watch), this.batch.reportListener);
		this.subscribe(watch);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		if (start.kind === "failed") watch.fail(handedOut(start.error), context);
		return watch;
	}

	/** Whether anything follows it: a watch, a subscriber or a derive (moving or ending it then needs a batch). */
	get inUse(): boolean {
		return this.watched || this.dependents.size > 0;
	}

	/** Whether a watch or a subscriber follows it (through the bound member). */
	get watched(): boolean {
		return (this.#passed?.size ?? 0) > 0;
	}

	/** Feeds `subscriber` the bound member's frames (it subscribes there) and the moves' frames. */
	subscribe(subscriber: Subscriber): void {
		this.#passed ??= new Set();
		this.#passed.add(subscriber);
		const state = this.#state;
		if (state.kind === "bound" && state.source instanceof Source) state.source.subscribe(subscriber);
	}

	/** As `Source.unsubscribe`. */
	unsubscribe(subscriber: Subscriber): void {
		this.#passed?.delete(subscriber);
		const state = this.#state;
		if (state.kind === "bound" && state.source instanceof Source) state.source.unsubscribe(subscriber);
	}

	/** The bound member changed: its dependents are marked (its frames reach the subscribers directly). */
	invalidate(): void {
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** The bound member's document was retired: its dependents carry the flag on. */
	sourceRetired(visited: Set<Dependent>): void {
		for (const dependent of this.dependents) dependent.sourceRetired(visited);
	}

	/**
	 * Follows `source`, an instance's member, inside a batch: watches get one frame from the last value (a full one
	 * after a failure); derives downstream are marked and recompute, a failed one included (self-healing).
	 */
	bind(source: DeriveSource): void {
		const state = this.#state;
		if (state.kind === "ended" || (state.kind === "bound" && state.source === source)) return;
		this.#leave();
		if (this.watched) this.#framed = { value: this.#shown() };
		this.#state = { kind: "bound", source };
		this.#hook(source);
		// Marks the derives downstream: a failed one recomputes too (self-healing).
		this.changed();
	}

	/** Its target loads (a restart, a retry, a new object not live yet): it keeps its last value, and tells nothing. */
	hold(): void {
		const state = this.#state;
		if (state.kind === "held") {
			// Its watches had the failure: the next value stays whole (`told`).
			if (state.failure !== NO_FAILURE) this.#state = { ...state, failure: NO_FAILURE };
			return;
		}
		if (state.kind === "bound") this.#keep(NO_FAILURE);
	}

	/**
	 * Its target failed (`error`: its cause's, a refused version's, a removed type's), inside a batch: it keeps its last
	 * value, its watches and subscribers get one failure call (once per failure) and stay open.
	 */
	fail(error: ChordError, context: Context): void {
		// Kept: its stack made text now, so it keeps none of the failed instance's frames.
		handedOut(error);
		const state = this.#state;
		if (state.kind === "held") {
			if (state.failure !== NO_FAILURE) return;
			this.#state = { kind: "held", value: state.value, failure: error, told: true };
		} else if (state.kind === "bound") {
			if (!this.#keep(error)) return;
		} else {
			return;
		}
		this.#call({ kind: "failed", error }, context);
	}

	/**
	 * Its target's live variant lacks the member, inside a batch: reads throw `error`; watches and subscribers get one
	 * failure call and stay open (a later instance may bring the member back, as `[["r", value]]`).
	 */
	vanish(error: ChordError, context: Context): void {
		const state = this.#state;
		if (state.kind === "ended") return;
		const last = state.kind === "unbound" ? undefined : this.#lastGood();
		this.#leave();
		this.#state = { kind: "failed", error: handedOut(error), last };
		this.#call({ kind: "failed", error }, context);
		this.changed();
	}

	/**
	 * Its reference ended, inside a batch: reads throw `error`, watches end `ended`, and derives over it are marked
	 * (their next read throws it, no cached value stays).
	 */
	end(error: ChordError): void {
		this.#leave();
		this.#state = { kind: "ended", error };
		this.#framed = undefined;
		// A copy: an ending watch unsubscribes itself.
		const passed = this.#passed;
		this.#passed = undefined;
		if (passed !== undefined) for (const subscriber of [...passed]) subscriber.end(ENDED);
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** Delivers a move's frame: the diff from the watches' value to the new member's. */
	deliver(context: Context): void {
		const framed = this.#framed;
		this.#framed = undefined;
		if (framed === undefined) return;
		let after: JsonValue;
		try {
			after = this.value;
		} catch (error) {
			if (framed.value !== undefined) this.#call({ kind: "failed", error: handedOut(error) }, context);
			return;
		}
		const before = framed.value;
		if (after === before) return;
		// After a failure (no value framed): whole, even when unchanged.
		const ops: readonly Op[] = before === undefined ? [["r", after]] : diffRevisions(before, after);
		if (ops.length > 0) this.#call({ kind: "value", value: after, ops, retired: false }, context);
	}

	/**
	 * Stops following the bound member and keeps its value (`failure`: the failure it is held with); a member whose value
	 * throws becomes failed. Whether it holds a value.
	 */
	#keep(failure: unknown): boolean {
		const state = this.#state as Extract<SourceState, { readonly kind: "bound" }>;
		const start = state.source instanceof Source ? state.source.start() : undefined;
		this.#leave();
		if (start === undefined || start.kind === "value") {
			const value = start === undefined ? state.source.value : start.value;
			this.#state = { kind: "held", value, failure, told: failure !== NO_FAILURE };
			return true;
		}
		this.#state = { kind: "failed", error: handedOut(start.error), last: start.last };
		return false;
	}

	/** A call of its own (a move's frame, a failure) to its watches and subscribers. */
	#call(call: WatchCall<JsonValue>, context: Context): void {
		if (this.#passed !== undefined) for (const subscriber of this.#passed) subscriber.advance(call, context);
	}

	/**
	 * The value its watches have before a move; `undefined` when they had a failure since it (their next value is whole,
	 * `[["r", value]]`, even when unchanged).
	 */
	#shown(): JsonValue | undefined {
		const state = this.#state;
		if (state.kind === "unbound" || (state.kind === "held" && state.told)) return undefined;
		const start = this.start();
		return start.kind === "value" ? start.value : undefined;
	}

	/** Its last good value, which watches opened while it is failed start at; `undefined` when it never had one. */
	#lastGood(): JsonValue | undefined {
		const start = this.start();
		return start.kind === "value" ? start.value : start.last;
	}

	/** Starts reading `source`: its changes mark this source's dependents, its frames reach the subscribers. */
	#hook(source: DeriveSource): void {
		if (!(source instanceof Source)) return;
		source.dependents.add(this);
		if (this.#passed !== undefined) for (const subscriber of this.#passed) source.subscribe(subscriber);
	}

	/** Stops following the bound source, when bound: no more marks or frames from it. */
	#leave(): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		const { source } = state;
		if (!(source instanceof Source)) return;
		source.dependents.delete(this);
		if (this.#passed !== undefined) for (const subscriber of this.#passed) source.unsubscribe(subscriber);
	}
}
