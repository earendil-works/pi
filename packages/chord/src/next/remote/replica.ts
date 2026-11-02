// Replicas (§7, §22): a state member of a remote reference on the consumer, built from the snapshot and then changed
// by the provider's ops, decoded with the member's own Delta decoder and applied without validation or copy
// (`applyImmutable` shares structure); replaced by the snapshot of each re-hold.

import type { Context } from "../../context/index.ts";
import { applyImmutable, decoder, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { ChordError } from "../data/index.ts";
import { type Batch, handedOut, Source, type WatchStart } from "../state/internal.ts";

/**
 * Where a replica stands: a value, a failed member (reads throw; the provider's member failed, or a newly bound variant
 * lacks it, and either may come back; `last` is its last good value, `undefined` when it had none), or ended with its
 * reference.
 */
type ReplicaState =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

/** A member as a snapshot has it: a value, or failed. */
export type MemberSnapshot =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown };

const NO_OPS: readonly Op[] = [];

/** One state member of a hold, as the consumer reads and watches it; changed only inside the consumer's batch. */
export class Replica extends Source {
	#state: ReplicaState;
	/** The member's decoder, started with the snapshot as the provider's encoder was; a new one per snapshot. */
	#decoder = decoder();
	/** The ops of the current batch's frame, and whether the provider's document was retired in it. */
	#ops = NO_OPS;
	#retired = false;
	/** A retirement that reached it while failed: its next value carries the flag. */
	#retiredWhileFailed = false;

	constructor(batch: Batch, state: MemberSnapshot) {
		super(batch);
		this.#state = state.kind === "value" ? state : { kind: "failed", error: handedOut(state.error), last: undefined };
	}

	get value(): JsonValue {
		const state = this.#state;
		if (state.kind === "value") return state.value;
		throw state.error;
	}

	/** Its value, or while failed its failure and last good value. */
	start(): WatchStart {
		const state = this.#state;
		if (state.kind === "failed") return { kind: "failed", error: state.error, last: state.last };
		return { kind: "value", value: this.value };
	}

	/**
	 * The value `wire` (this member's wire ops from one state part) makes, and its ops; changes nothing yet. Throws on
	 * ops that do not fit (a protocol error): an ended member's, and a failed member's other than its recovery, which
	 * the provider sends as `[["r", value]]`.
	 */
	decode(wire: unknown): { readonly value: JsonValue; readonly ops: readonly Op[] } {
		// Trust boundary: fresh JSON from the link; Delta's decoder checks each op.
		if (!Array.isArray(wire)) throw new Error("part: a member's changes are a list of ops");
		const ops = this.#decoder.decode(wire);
		const state = this.#state;
		if (state.kind === "ended") throw state.error;
		if (state.kind === "value") return { value: applyImmutable(state.value, ops), ops };
		if (ops[0]?.[0] !== "r") throw new Error("part: a failed member recovers with a root replacement");
		return { value: applyImmutable(null, ops), ops };
	}

	/**
	 * Adopts the member's new value, the ops that made it and whether the provider's document was retired, in the
	 * current batch (one adoption per member and batch).
	 */
	adopt(value: JsonValue, ops: readonly Op[], retired: boolean): void {
		const flagged = retired || this.#retiredWhileFailed;
		this.#state = { kind: "value", value };
		this.#ops = ops;
		this.#retired = flagged;
		this.#retiredWhileFailed = false;
		this.changed();
		if (flagged) this.retiredInBatch();
	}

	/**
	 * The provider's document was retired with no ops for this member (a derive whose value stayed, rule 21), in the
	 * current batch: the flag alone; while failed it waits for the next value (a failed member's value is never read).
	 */
	retireAlone(): void {
		const state = this.#state;
		if (state.kind === "value") this.adopt(state.value, NO_OPS, true);
		else if (state.kind === "failed") this.#retiredWhileFailed = true;
	}

	/**
	 * A re-hold's snapshot of the member, in the batch that applies it, with a fresh decoder (the provider's encoder
	 * starts anew with it): a value is one frame `[["r", value]]`, a failed member fails.
	 */
	reset(state: MemberSnapshot): void {
		this.#decoder = decoder();
		if (state.kind === "failed") this.fail(state.error);
		else this.adopt(state.value, [["r", state.value]], false);
	}

	/**
	 * The provider's member failed, in the batch that applies it: reads throw `error`, watches get one failure call and
	 * stay open, derives over it fail; its recovery is `[["r", value]]`.
	 */
	fail(error: unknown): void {
		const state = this.#state;
		const last = state.kind === "value" ? state.value : state.kind === "failed" ? state.last : undefined;
		this.#state = { kind: "failed", error: handedOut(error), last };
		// Failed already: its watches and derives have the failure (one call per failure episode).
		if (state.kind !== "failed") this.changed();
	}

	deliver(context: Context): void {
		const state = this.#state;
		if (state.kind === "failed") this.failWatches(state.error, context);
		else if (state.kind === "value") this.publish(state.value, this.#ops, this.#retired, context);
		else this.endWatches();
		this.#ops = NO_OPS;
		this.#retired = false;
	}

	/**
	 * The member is not in a newly bound variant, in the batch that binds it: as a failure (`fail`) with `error`; a later
	 * binding of a variant that has it brings it back (`reset`), as on the provider's host.
	 */
	vanish(error: ChordError): void {
		this.fail(error);
	}

	/** Its reference ended (outside a batch): reads throw `error`, watches end `ended`. */
	end(error: ChordError): void {
		this.#state = { kind: "ended", error };
		this.endWatches();
	}
}
