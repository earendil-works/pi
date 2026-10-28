// Member sources (slice 6a §1.2, §1.4): a local object's state member as its references and other objects' derives
// follow it across attempts. While an attempt is live it passes that attempt's member on; while the object is failed
// or activating again it keeps the last value and gets no frames; when a new attempt goes live it re-binds to that
// attempt's member of the same name (one frame from the last value), as a remote reference's re-hold does.

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
 * Where a member source stands: following the live attempt's member, frozen at its last value, failed (its value
 * threw when frozen, or a new attempt's variant lacks the member: a later attempt may bring it back; `last` is the
 * last good value, `undefined` when there was none) or ended with its object.
 */
type MemberState =
	| { readonly kind: "bound"; readonly source: DeriveSource }
	| { readonly kind: "frozen"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

const ENDED: WatchEnd = { kind: "ended" };

/**
 * One state member of a local object across its attempts. Bound, it is a dependent of the attempt's member (its own
 * dependents are marked with it). Its watches and subscribers (holds over a link, member sources re-exposing it)
 * subscribe to the bound member itself, so the member's frames reach them as they are, with no extra hop, and a derive
 * member stays lazy while nothing follows it; a freeze or a re-bind moves them.
 */
export class MemberSource extends Source implements Dependent {
	#state: MemberState;
	/** Its watches and subscribers, each subscribed to the bound member while bound; frozen, they get nothing. */
	readonly #passed = new Set<Subscriber>();
	/** What its watches had at a re-bind (`undefined` for no value: the member had failed), until the re-bind's frame. */
	#framed: { readonly value: JsonValue | undefined } | undefined;

	constructor(source: DeriveSource, batch: Batch) {
		super(batch);
		this.#state = { kind: "bound", source };
		this.#hook(source);
	}

	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "bound") return state.source.value;
		if (state.kind === "frozen") return state.value;
		throw state.error;
	}

	/** What a new watch starts at: the bound member's start, the frozen value, or the failure with its last value. */
	start(): WatchStart {
		const state = this.#state;
		if (state.kind === "bound") {
			return state.source instanceof Source ? state.source.start() : { kind: "value", value: state.source.value };
		}
		if (state.kind === "frozen") return { kind: "value", value: state.value };
		if (state.kind === "failed") return { kind: "failed", error: state.error, last: state.last };
		throw state.error;
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

	/** Whether a watch or a subscriber follows it (through the bound member). */
	get watched(): boolean {
		return this.#passed.size > 0;
	}

	/** Feeds `subscriber` the bound member's frames (it subscribes there) and the re-binds' frames. */
	subscribe(subscriber: Subscriber): void {
		this.#passed.add(subscriber);
		const state = this.#state;
		if (state.kind === "bound" && state.source instanceof Source) state.source.subscribe(subscriber);
	}

	/** As `Source.unsubscribe`. */
	unsubscribe(subscriber: Subscriber): void {
		this.#passed.delete(subscriber);
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

	/** Its object failed live and its admitted commits adopted: it keeps the member's value (or error) from now on. */
	freeze(): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		this.#leave();
		const start = state.source instanceof Source ? state.source.start() : undefined;
		if (start === undefined || start.kind === "value") {
			this.#state = { kind: "frozen", value: start === undefined ? state.source.value : start.value };
		} else {
			this.#state = { kind: "failed", error: start.error, last: start.last };
		}
	}

	/**
	 * A new attempt went live: follows its member `source`, inside a batch. Watches get one frame from the last value
	 * (a full one after a failure); derives downstream are marked and recompute, a failed one included (self-healing).
	 */
	bind(source: DeriveSource): void {
		if (this.#state.kind === "ended") return;
		this.#leave();
		if (this.watched) this.#framed = { value: this.#shown() };
		this.#state = { kind: "bound", source };
		this.#hook(source);
		// Marks the derives downstream: a failed one recomputes too (self-healing).
		this.changed();
	}

	/**
	 * A new attempt's variant lacks the member, inside a batch: reads throw `error`; watches and subscribers get one
	 * failure call and stay open (a later attempt may bring the member back, as `[["r", value]]`).
	 */
	vanish(error: ChordError, context: Context): void {
		if (this.#state.kind === "ended") return;
		const last = this.#lastGood();
		this.#leave();
		this.#state = { kind: "failed", error, last };
		this.#call({ kind: "failed", error: handedOut(error) }, context);
		this.changed();
	}

	/**
	 * Its object ended, inside a batch: reads throw `error`, watches end `ended`, and derives over it are marked (their
	 * next read throws it, no cached value stays). Its other subscribers end with their owners (a hold with its object).
	 */
	objectEnded(error: ChordError): void {
		this.#leave();
		this.#state = { kind: "ended", error };
		this.#framed = undefined;
		// A copy: an ending watch unsubscribes itself.
		for (const subscriber of [...this.#passed]) subscriber.end(ENDED);
		this.#passed.clear();
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** Delivers a re-bind's frame: the diff from the watches' value to the new member's. */
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
		const ops: readonly Op[] = before === undefined ? [["r", after]] : diffRevisions(before, after);
		if (ops.length > 0) this.#call({ kind: "value", value: after, ops, retired: false }, context);
	}

	/** A call of its own (a re-bind's frame, a vanished member) to its watches and subscribers. */
	#call(call: WatchCall<JsonValue>, context: Context): void {
		for (const subscriber of this.#passed) subscriber.advance(call, context);
	}

	/** The value its watches have before a re-bind; `undefined` when they had a failure (their next value is whole). */
	#shown(): JsonValue | undefined {
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
		for (const subscriber of this.#passed) source.subscribe(subscriber);
	}

	/** Stops following the bound source, when bound: no more marks or frames from it. */
	#leave(): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		const { source } = state;
		if (!(source instanceof Source)) return;
		source.dependents.delete(this);
		for (const subscriber of this.#passed) source.unsubscribe(subscriber);
	}
}
