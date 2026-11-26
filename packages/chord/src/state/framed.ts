// Framed sources: a JSON source whose owner sets its value whole (a live query's rows, a list's pages joined), one
// frame per batch as the diff from the value its watches had, however often the batch set it (a list sets once per
// page a commit touched); it may fail and recover, as a derive does (design §11).

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { diffRevisions, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { Batch } from "./batch.ts";
import { handedOut, Source, type WatchStart } from "./watchable.ts";

/** Who a framed source belongs to: named in errors, and told its failures after its first value (once per episode). */
export type FramedOwner = {
	readonly label: string;
	report(error: unknown): void;
};

/**
 * Where a framed source stands: before its first value, with a value, failed (its last good value kept for a watch
 * opened meanwhile), or detached (its owner ended).
 */
type FramedState =
	| { readonly kind: "loading" }
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "detached"; readonly error: unknown };

/** What the watches of a failed source had: no value, so its next one replaces the value whole. */
const NO_VALUE: unique symbol = Symbol("no value");

/**
 * A source its subclass feeds with `set` and `failWith`, inside a batch, as often as it likes: the batch delivers one
 * frame, of the state it ended in. A failure makes it a failed member (as a throwing derive): its watches get one
 * failure call, its owner one report per failure episode; the next value replaces the value whole (`[["r", value]]`).
 */
export abstract class FramedSource extends Source {
	readonly #owner: FramedOwner;
	#state: FramedState = { kind: "loading" };
	/**
	 * The value its watches have, kept from its first change in a batch to that batch's frame; `undefined`: not listed
	 * in the batch.
	 */
	#framed: JsonValue | typeof NO_VALUE | undefined;
	/** Set from a failure until the next value: a failure episode is reported once. */
	#failing = false;

	constructor(batch: Batch, owner: FramedOwner) {
		super(batch);
		this.#owner = owner;
	}

	/** Whether it has a value. */
	get ready(): boolean {
		return this.#state.kind === "value";
	}

	/** Its failure while it is failed; `undefined` with a value, before its first one and once detached. */
	get failure(): { readonly error: unknown } | undefined {
		return this.#state.kind === "failed" ? this.#state : undefined;
	}

	/** Whether its owner ended. */
	get detached(): boolean {
		return this.#state.kind === "detached";
	}

	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "value") return state.value;
		if (state.kind === "loading") {
			throw new ChordError({ code: "not_ready", message: `${this.#owner.label}: read before its first value` });
		}
		throw state.error;
	}

	/** Its value, or while failed its failure and last good value (a detached one throws). */
	override start(): WatchStart {
		const state = this.#state;
		if (state.kind === "failed") return { kind: "failed", error: state.error, last: state.last };
		return { kind: "value", value: this.value };
	}

	/** Its next failure is not reported: whoever awaits its first value reports that failure itself. */
	protected quiet(): void {
		this.#failing = true;
	}

	/** Takes `value`, inside a batch: listed for the batch's frame when watched, its dependents marked. */
	protected set(value: JsonValue): void {
		if (this.#state.kind === "detached") return;
		this.#failing = false;
		this.#change({ kind: "value", value });
	}

	/** Fails with `error`, inside a batch, keeping its last good value for a watch opened meanwhile. */
	protected failWith(error: unknown): void {
		const state = this.#state;
		if (state.kind === "detached") return;
		if (!this.#failing) this.#owner.report(handedOut(error));
		this.#failing = true;
		const last = state.kind === "value" ? state.value : state.kind === "failed" ? state.last : undefined;
		this.#change({ kind: "failed", error, last });
	}

	/**
	 * Delivers the batch's one frame, of the state the batch left: the diff from the value its watches had before
	 * the batch, or one failure call when they had a value.
	 */
	deliver(context: Context): void {
		const before = this.#framed;
		this.#framed = undefined;
		const state = this.#state;
		if (state.kind === "value") {
			// Listed by a change, so `before` was kept (a detach in the batch leaves no value).
			const after = state.value;
			const ops: readonly Op[] = before === NO_VALUE ? [["r", after]] : this.#diff(before!, after);
			if (ops.length > 0) this.publish(after, ops, false, context);
			return;
		}
		// Still failed since the last call: nothing new for the watches.
		if (state.kind === "failed" && before !== NO_VALUE) this.failWatches(state.error, context);
	}

	/**
	 * The ops from `before` to `after`: the ones a frame of this commit made already for these two values when there
	 * are some (the sources a shared read feeds, `store/shared-read.ts`, all go from the same value to the same next
	 * one in one batch, which is diffed once).
	 */
	#diff(before: JsonValue, after: JsonValue): readonly Op[] {
		// A primitive (a count) diffs at once.
		if (typeof before !== "object" || before === null) return diffRevisions(before, after);
		const diffs = this.batch.diffs;
		const made = diffs.get(before);
		if (made?.after === after) return made.ops;
		const ops = diffRevisions(before, after);
		diffs.set(before, { after, ops });
		return ops;
	}

	/** Its owner ended: reads throw `error`, its watches end `ended`. */
	protected end(error: Error): void {
		this.#state = { kind: "detached", error };
		this.#framed = undefined;
		this.endWatches();
	}

	/**
	 * Its state becomes `next` in the batch running now. The first change of a batch lists it for that batch's frame
	 * and keeps what its watches have, which the frame diffs from; a later one lists nothing (a source listed twice
	 * delivers twice: two frames of one member in one commit, which a link refuses). Every change marks its
	 * dependents: one may have read the value since the last.
	 */
	#change(next: FramedState): void {
		if (this.watched && this.#framed === undefined) {
			const state = this.#state;
			this.#framed = state.kind === "value" ? state.value : NO_VALUE;
			this.batch.changed(this);
		}
		this.#state = next;
		this.dependents.invalidate();
	}
}
