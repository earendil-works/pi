// Derives (§12): values computed from watchables, pulled when read and marked dirty by commits; and `mapShared`, which
// keeps unchanged elements identical so a derive's diff stays cheap.

import type { Context } from "../../context/index.ts";
import { diffRevisions, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Batch } from "./batch.ts";
import { NativeSource } from "./native-source.ts";
import { type Constant, type Dependent, handedOut, Source, type WatchStart } from "./watchable.ts";

/** A JSON watchable as Chord follows it (a state member, a JSON derive source): a source, or a constant. */
export type DeriveSource = Source | Constant;

/** What a derive reads: a JSON source or constant, or a native source (a `writable`, a registry value, `ref.state`). */
export type DeriveInput = DeriveSource | NativeSource;

/**
 * Where a derive stands. `dirty`: a source changed since the last compute (or there was none). A failed derive (its
 * compute threw) throws its error until a source it reads changes or is re-bound, then recomputes (self-healing, design
 * §11); a detached one (its object ended) throws its object's error for good.
 */
type DeriveState =
	| { readonly kind: "dirty" }
	| { readonly kind: "clean"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "detached"; readonly error: unknown };

const DIRTY: DeriveState = { kind: "dirty" };

const NO_OPS: readonly Op[] = [];

/** What a failed derive's watches had: no value, so its next value frame replaces the value whole. */
const NO_VALUE: unique symbol = Symbol("no value");

/**
 * A derive: `compute` over its sources' values, recomputed on read when dirty, so each compute runs at most once per
 * batch and after its sources. A commit only marks it; the batch recomputes it only when something watched depends on
 * it.
 */
export class Derive extends Source implements Dependent {
	readonly #compute: (values: readonly unknown[]) => JsonValue;
	/** The sources as declared, until `attach` resolves them. */
	#declared: readonly unknown[] | undefined;
	#sources: readonly DeriveInput[] = [];
	#state: DeriveState = { kind: "dirty" };
	/** The value this derive's watches have, kept from its marking to its frame in the batch. */
	#framed: JsonValue | typeof NO_VALUE | undefined;
	/** Whether a source's document was retired in the current batch while this derive is watched (rule 21). */
	#retired = false;
	/** Reports a failure of its compute to its owner (`attach`); once per failure episode, which a value ends. */
	#report: ((error: unknown) => void) | undefined;
	#failing = false;
	/** Its last good value, which a watch opened while it is failed starts at (`NO_VALUE` before the first). */
	#good: JsonValue | typeof NO_VALUE = NO_VALUE;

	constructor(sources: readonly unknown[], compute: (values: readonly unknown[]) => JsonValue, batch: Batch) {
		super(batch);
		this.#declared = sources;
		this.#compute = compute;
	}

	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "clean") return state.value;
		if (state.kind === "dirty") return this.#recompute();
		throw state.error;
	}

	/** Its value, or while failed its failure and last good value (a detached derive throws). */
	start(): WatchStart {
		try {
			return { kind: "value", value: this.value };
		} catch (error) {
			if (this.#state.kind !== "failed") throw error;
			return { kind: "failed", error, last: this.#good === NO_VALUE ? undefined : this.#good };
		}
	}

	/**
	 * Starts reading its sources, as `resolve` maps the declared ones (at activation); the first read computes.
	 * `report` gets a throw of its compute, once per failure episode (a value ends it); a failing source's error is its
	 * source's to report.
	 */
	attach(resolve: (source: unknown, index: number) => DeriveInput, report: (error: unknown) => void): void {
		this.#report = report;
		this.#sources = this.#declared!.map(resolve);
		this.#declared = undefined;
		for (const source of this.#sources) {
			if (source instanceof Source || source instanceof NativeSource) source.dependents.add(this);
		}
	}

	/** Its object ended: no source keeps it, its watches end `ended`, reads throw `error` (the object's). */
	detach(error: Error): void {
		for (const source of this.#sources) {
			if (source instanceof Source || source instanceof NativeSource) source.dependents.delete(this);
		}
		this.#sources = [];
		this.#declared = undefined;
		this.#state = { kind: "detached", error };
		this.#framed = undefined;
		this.endWatches();
	}

	/**
	 * A source changed: mark this derive and its dependents dirty, flags only; a failed one too, which recomputes on its
	 * next read and heals when its sources give a value it can compute. An already dirty derive has dirty dependents
	 * (every read recomputes its sources first), so marking stops there.
	 */
	invalidate(): void {
		const state = this.#state;
		if (state.kind === "dirty" || state.kind === "detached") return;
		if (this.watched) this.#framed = state.kind === "clean" ? state.value : NO_VALUE;
		this.#state = DIRTY;
		this.changed();
	}

	/**
	 * A source's document was retired in this batch (`Source.retiredInBatch`): a watched derive's frame carries the
	 * flag, and the derives reading this one are told too.
	 */
	sourceRetired(visited: Set<Dependent>): void {
		// Once per derive per retirement: a diamond of derives is walked in its size, not once per path.
		if (visited.has(this)) return;
		visited.add(this);
		if (this.watched) this.#retired = true;
		for (const derive of this.dependents) derive.sourceRetired(visited);
	}

	/**
	 * Delivers the frame: the diff from the watches' value, a retirement even without ops (rule 21). A compute that
	 * throws gives one failure call when the watches had a value (one per failure episode), the watches stay open; a
	 * retirement waits for the next value.
	 */
	deliver(context: Context): void {
		const before = this.#framed!;
		const retired = this.#retired;
		this.#framed = undefined;
		let after: JsonValue;
		try {
			after = this.value;
		} catch (error) {
			// Still failed since the last call: nothing new for the watches.
			if (before !== NO_VALUE) this.failWatches(error, context);
			return;
		}
		this.#retired = false;
		let ops: readonly Op[] = NO_OPS;
		if (after !== before) {
			this.batch.count("chord.derive.diffs");
			ops = before === NO_VALUE ? [["r", after]] : diffRevisions(before, after);
		}
		if (ops.length > 0 || retired) this.publish(after, ops, retired, context);
	}

	#recompute(): JsonValue {
		return this.batch.compute(() => {
			try {
				this.batch.count("chord.derive.computes");
				// A failing source throws its own error here, so a derive over a failed derive fails with the same error.
				const values = this.#sources.map((source) => source.value);
				let value: JsonValue;
				try {
					value = this.#compute(values);
				} catch (error) {
					if (!this.#failing) this.#report?.(handedOut(error));
					this.#failing = true;
					throw error;
				}
				this.#failing = false;
				this.#state = { kind: "clean", value };
				this.#good = value;
				return value;
			} catch (error) {
				this.#state = { kind: "failed", error };
				throw error;
			}
		});
	}
}

/**
 * Maps an array calling `f` only for object elements not seen before (by identity), returning the previous result for
 * the others; primitive elements are mapped every time. The cache is weak: dropped elements take their results along.
 */
export function mapShared<E, R extends JsonValue>(f: (element: E) => R): (elements: readonly E[]) => R[] {
	const results = new WeakMap<object, R>();
	return (elements) =>
		elements.map((element) => {
			// The decided rule: identity caching for objects only.
			if (typeof element !== "object" || element === null) return f(element);
			let result = results.get(element);
			if (result === undefined) {
				result = f(element);
				results.set(element, result);
			}
			return result;
		});
}
