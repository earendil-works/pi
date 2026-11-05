// Reload cycles (decision "Reload restarts every affected object; old work finishes on old code", rule 6): a wait of
// old work on an object whose activation waits, through its parked dependencies or the gates its opener waits at, on
// the old attempt that very work runs on. Nothing would end it but the reload drain bound, so it fails at once with
// `unavailable/reload_cycle`, naming the chain. Checked when the wait starts and again whenever an attempt parks or an
// opener starts waiting at a gate (a cycle may close after the wait began).

import type { Contract } from "../contracts/index.ts";
import { ChordError } from "../data/index.ts";
import type { ChordObject } from "./object.ts";
import type { OldWorkSource } from "./old-work.ts";

/** One wait of old work: on what, for which version, under which attempts (its call chain's), and how it is cut. */
type OldWait = {
	readonly target: ChordObject;
	readonly contract: Contract;
	readonly chain: ReadonlySet<OldWorkSource>;
	readonly cut: (error: ChordError) => void;
};

/** A host's waits of old work on objects that are not live, while they last. */
export class ReloadCycles {
	readonly #waits = new Set<OldWait>();

	/**
	 * `waiting` (a getter's or a gate's wait on `target`, for `contract`'s version) as old work under `chain` makes it:
	 * rejected at once with `unavailable/reload_cycle` if it closes a cycle through that work's own drain, now or once a
	 * later park closes it.
	 */
	wait<T>(
		waiting: Promise<T>,
		target: ChordObject,
		contract: Contract,
		chain: ReadonlySet<OldWorkSource>,
	): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const wait: OldWait = {
			target,
			contract,
			chain,
			cut: (error) => {
				this.#waits.delete(wait);
				reject(error);
			},
		};
		this.#waits.add(wait);
		waiting.then(
			(value) => {
				this.#waits.delete(wait);
				resolve(value);
			},
			(error: unknown) => {
				this.#waits.delete(wait);
				reject(error);
			},
		);
		this.#check(wait);
		return promise;
	}

	/** An attempt parked, or an opener began waiting at a gate: every wait is checked again. */
	recheck(): void {
		if (this.#waits.size === 0) return;
		for (const wait of [...this.#waits]) this.#check(wait);
	}

	#check(wait: OldWait): void {
		if (!this.#waits.has(wait)) return;
		const cycle = cycleFrom(wait.target, wait.contract, wait.chain);
		if (cycle === undefined) return;
		const chain = cycle.join(" → ");
		const message = `${wait.target.label}: work its reload drains waits for it, and it waits for that drain (${chain})`;
		wait.cut(new ChordError({ code: "unavailable", reason: "reload_cycle", message }));
	}
}

/**
 * The labels of a chain of waits from `start` to an object whose open old attempt is in `chain`; `undefined` when
 * there is none. The start itself counts only through its edges: if its open old attempt serves `contract`'s version,
 * the old work is routed there (or sees it live) and does not wait at all.
 */
function cycleFrom(start: ChordObject, contract: Contract, chain: ReadonlySet<OldWorkSource>): string[] | undefined {
	if (start.oldServes(contract.version, contract.fingerprint)) return undefined;
	const visited = new Set<ChordObject>([start]);
	const walk = (object: ChordObject): string[] | undefined => {
		for (const next of object.waitEdges()) {
			if (visited.has(next)) continue;
			visited.add(next);
			const old = next.openOldAttempt;
			if (old !== undefined && chain.has(old)) return [next.label];
			const rest = walk(next);
			if (rest !== undefined) return [next.label, ...rest];
		}
		return undefined;
	};
	const rest = walk(start);
	return rest === undefined ? undefined : [start.label, ...rest];
}
