// A job's `running` (§15): a JSON watchable of its unsettled runs, one entry per run in start order, tagged by phase.
// It is a source of its own (keyed state documents publish nothing): the job tells it each change in the commit step,
// and a frame carries exactly the ops of those changes, a run's state ops re-pathed under its entry.

import type { Context } from "../../context/index.ts";
import type { NonEmptyPath, Op, Path } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { ChordError } from "../data/index.ts";
import { type Batch, Source } from "../state/internal.ts";
import type { BlockedReason } from "./run.ts";

/**
 * One entry of `running`: a running or finishing run with its args (and state, when the job has a state document), or
 * a blocked run, which carries neither (it may be of another version than the code).
 */
export type RunningEntry<A, S> =
	| ({
			readonly id: string;
			readonly version: number;
			readonly key?: string;
			readonly args: A;
			readonly phase: "running" | "finishing";
	  } & ([S] extends [undefined] ? unknown : { readonly state: S }))
	| { readonly id: string; readonly version: number; readonly phase: "blocked"; readonly reason: BlockedReason };

const EMPTY: readonly JsonValue[] = [];

/**
 * The list behind `running`. Every change copies the list (O(unsettled runs)) and, while it is watched, records its
 * ops; the batch delivers them as one frame. Unwatched, no op is built.
 */
export class Running extends Source {
	/** The job in errors. */
	readonly #label: string;
	/** `undefined` once its object ended: reads throw `released`, and no ended run's args or state are kept. */
	#list: readonly JsonValue[] | undefined = EMPTY;
	/** The ops of the current batch's changes, kept only while watched. */
	#ops: Op[] = [];
	/** Whether the current batch listed this source for a frame. */
	#listed = false;

	constructor(batch: Batch, label: string) {
		super(batch);
		this.#label = label;
	}

	get value(): JsonValue {
		// A list of JSON entries, shared and never mutated once published.
		return this.#current() as JsonValue;
	}

	/** Appends the entry of a new run. */
	add(entry: JsonValue): void {
		const list = [...this.#current(), entry];
		this.#list = list;
		if (this.#mark()) this.#ops.push(["p", [], list.length - 1, 0, [entry]]);
	}

	/** Replaces a run's entry `before` by `after` (its record changed). */
	replace(before: JsonValue, after: JsonValue): void {
		const index = this.#replaced(before, after);
		if (this.#mark()) this.#ops.push(["s", [index], after]);
	}

	/** Replaces a run's entry `before` by `after`, whose state document changed by `ops`. */
	stateChanged(before: JsonValue, after: JsonValue, ops: readonly Op[]): void {
		const index = this.#replaced(before, after);
		if (this.#mark()) for (const op of ops) this.#ops.push(under([index, "state"], op));
	}

	/** Removes a run's entry. */
	remove(entry: JsonValue): void {
		const list = this.#current();
		const index = list.indexOf(entry);
		this.#list = list.toSpliced(index, 1);
		if (this.#mark()) this.#ops.push(["p", [], index, 1, []]);
	}

	deliver(context: Context): void {
		const ops = this.#ops;
		this.#ops = [];
		this.#listed = false;
		this.publish(this.#current() as JsonValue, ops, false, context);
	}

	/** Its object ended: every watch ends, and the list goes. */
	end(): void {
		this.#list = undefined;
		this.#ops = [];
		this.endWatches();
	}

	#current(): readonly JsonValue[] {
		if (this.#list === undefined) {
			throw new ChordError({ code: "released", reason: "ended", message: `${this.#label}: ended` });
		}
		return this.#list;
	}

	/** Copies the list with `after` in the place of `before`; returns that place. */
	#replaced(before: JsonValue, after: JsonValue): number {
		const list = this.#current();
		const index = list.indexOf(before);
		this.#list = list.with(index, after);
		return index;
	}

	/**
	 * Records that the list changed, in the batch running now: derives over it are marked; while watched it is listed
	 * once per batch for a frame. Returns whether the change's ops are to be recorded (only while watched).
	 */
	#mark(): boolean {
		if (!this.watched) {
			this.changed();
			return false;
		}
		if (!this.#listed) {
			this.#listed = true;
			this.changed();
		}
		return true;
	}
}

/** `op` of a value at `prefix` inside a larger one: a replacement becomes a set there. */
function under(prefix: readonly [number, string], op: Op): Op {
	const at = (path: Path): NonEmptyPath => [prefix[0], prefix[1], ...path];
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
	}
}
