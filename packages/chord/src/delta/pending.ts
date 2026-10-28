// The pending queue: the ops a slow consumer of one state has not taken yet, folded while they wait.
import type { JsonValue } from "../json.ts";
import type { NonEmptyPath, Op, Path } from "./index.ts";

/**
 * What `PendingOps.take()` hands over: the pending ops, folded, or `replace` after an overflow, which the owner of the
 * queue turns into a root replacement with the current value.
 */
export type PendingTake = { readonly kind: "ops"; readonly ops: readonly Op[] } | { readonly kind: "replace" };

/** Pending ops past which only "replace with the current value" stays pending. */
export const MAX_PENDING_OPS = 10_000;

/** A leaf op: an append, or a set of a primitive. The leaf index points at these only. */
type LeafOp = readonly ["a", NonEmptyPath, string] | readonly ["s", NonEmptyPath, JsonValue];

type Folding = {
	readonly kind: "folding";
	/** Owned by the queue until `take()` hands it over; never one of the received op arrays. */
	readonly ops: Op[];
	/** Path key to the position of the last pending leaf op on that path. */
	readonly leaves: Map<string, number>;
};

type State =
	| { readonly kind: "empty" }
	/** One batch, kept by reference: a consumer that keeps up never pays for folding. */
	| { readonly kind: "batch"; readonly ops: readonly Op[] }
	| Folding
	/** Overflowed: nothing more accumulates until `take()` or a batch that starts with `r`. */
	| { readonly kind: "replace" };

const EMPTY: State = { kind: "empty" };

const REPLACE: State = { kind: "replace" };

const NO_OPS: PendingTake = { kind: "ops", ops: [] };

const REPLACE_TAKE: PendingTake = { kind: "replace" };

/**
 * Pending ops of one state for one consumer, in order and raw (never encoded while they wait). `r` drops everything
 * before it. A leaf op merges into the last pending leaf op on the same path (`a` + `a` joined, `s` replaces `s` or `a`,
 * `a` after a string `s` appends into it); any other op clears the leaf index. Leaf ops on different paths commute,
 * except after an ancestor primitive `s`, after which the descendant cannot be written until a structural op clears the
 * index. Past `MAX_PENDING_OPS` only "replace with the current value" stays pending.
 *
 * Ops are only those of Delta's tracker, `diffRevisions()` and `appendText()`; received op arrays and tuples are never
 * mutated (they feed other consumers too), a merge makes a new tuple.
 */
export class PendingOps {
	#state: State = EMPTY;

	/** Queue the ops of one commit. */
	push(ops: readonly Op[]): void {
		if (ops.length === 0) return;
		const state = this.#state;
		// A batch that starts with `r` (the tracker's and `diffRevisions()`'s only place for it) drops everything
		// pending, also an overflow, and is kept as received.
		if (ops[0]![0] === "r") {
			this.#state = { kind: "batch", ops };
			return;
		}
		switch (state.kind) {
			case "empty":
				this.#state = { kind: "batch", ops };
				return;
			case "batch": {
				const folding: Folding = { kind: "folding", ops: [], leaves: new Map() };
				this.#state = folding;
				if (this.#fold(state.ops, folding)) this.#fold(ops, folding);
				return;
			}
			case "folding":
				this.#fold(ops, state);
				return;
			case "replace":
				return;
		}
	}

	/**
	 * Pending ops after folding; 1 once overflowed (the replacement the owner sends). One batch is counted as received,
	 * so a single commit larger than `MAX_PENDING_OPS` counts in full until a second one arrives and overflows.
	 */
	get size(): number {
		const state = this.#state;
		if (state.kind === "empty") return 0;
		return state.kind === "replace" ? 1 : state.ops.length;
	}

	/** Hand over everything pending and start empty. */
	take(): PendingTake {
		const state = this.#state;
		this.#state = EMPTY;
		switch (state.kind) {
			case "empty":
				return NO_OPS;
			case "batch":
			case "folding":
				return { kind: "ops", ops: state.ops };
			case "replace":
				return REPLACE_TAKE;
		}
	}

	/** Fold `ops` into `folding`; false once the queue overflowed into `replace`. */
	#fold(ops: readonly Op[], folding: Folding): boolean {
		for (const op of ops) {
			switch (op[0]) {
				case "r":
					folding.ops.length = 0;
					folding.leaves.clear();
					break;
				case "a":
					if (mergeLeaf(op, folding)) continue;
					break;
				case "s":
					if (isPrimitive(op[2])) {
						if (mergeLeaf(op, folding)) continue;
					} else if (folding.leaves.size > 0) folding.leaves.clear();
					break;
				default:
					if (folding.leaves.size > 0) folding.leaves.clear();
			}
			folding.ops.push(op);
			if (folding.ops.length > MAX_PENDING_OPS) {
				this.#state = REPLACE;
				return false;
			}
		}
		return true;
	}
}

const isPrimitive = (value: JsonValue): boolean => value === null || typeof value !== "object";

/**
 * Merge the leaf op `op` into the last pending leaf op on its path, or index it as that op at the position it is about
 * to be pushed to. True when merged.
 */
function mergeLeaf(op: LeafOp, folding: Folding): boolean {
	const key = pathKey(op[1]);
	const at = folding.leaves.get(key);
	if (at !== undefined) {
		// The index points at leaf ops only.
		const merged = merge(folding.ops[at] as LeafOp, op);
		if (merged !== undefined) {
			folding.ops[at] = merged;
			return true;
		}
	}
	folding.leaves.set(key, folding.ops.length);
	return false;
}

/**
 * The key of a path in the leaf index. Injective, as merging two distinct paths would lose a write: `["a.b"]` and
 * `["a", "b"]` are different keys. A number and its string (`1`, `"1"`) may share one: within one index lifetime a
 * parent is either an array or an object, as changing it is a structural op that clears the index.
 */
function pathKey(path: Path): string {
	return JSON.stringify(path);
}

/** `next` folded into `previous` (same path), or undefined when they do not fold. */
function merge(previous: LeafOp, next: LeafOp): LeafOp | undefined {
	if (next[0] === "s") return next;
	if (previous[0] === "a") return ["a", previous[1], previous[2] + next[2]];
	// Only a string set takes an append; the tracker never appends to another primitive.
	if (typeof previous[2] === "string") return ["s", previous[1], previous[2] + next[2]];
	return undefined;
}
