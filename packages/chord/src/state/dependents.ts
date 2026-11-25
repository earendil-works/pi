// A source's dependents (§12): the derives, reference members and decisions reading it, marked when it changes. Most
// sources have none or one (a derive over a member, an admission over its derive), which this keeps without a set: a
// set of one costs 184 B, and every source of every object had one (the hold-memory bench). Whatever its dependents do
// while they are told (add, remove, clear, tell again), it tells exactly whom a set's iteration would, in its order.

import type { Dependent } from "./watchable.ts";

/** What reads one source, in the order added: marked by its changes, each removing itself when it stops. */
export class Dependents {
	/**
	 * Without a set: the only dependent, if there is one. With a set: the dependent the set was made around, while it
	 * is still the entry it was as the only one (not removed since), so one being told then knows its place in the set.
	 */
	#only: Dependent | undefined;
	/** Counts the dependents that became the only one: tells an entry from a later one of the same dependent. */
	#entry = 0;
	/** Every dependent, from the second one on; kept once made (a source with several keeps getting them). */
	#several: Set<Dependent> | undefined;

	/** How many there are. */
	get size(): number {
		if (this.#several !== undefined) return this.#several.size;
		return this.#only === undefined ? 0 : 1;
	}

	/** Adds `dependent` (once, however often it is added). */
	add(dependent: Dependent): void {
		if (this.#several !== undefined) {
			this.#several.add(dependent);
		} else if (this.#only === undefined) {
			this.#only = dependent;
			this.#entry++;
		} else if (this.#only !== dependent) {
			this.#several = new Set([this.#only, dependent]);
		}
	}

	/** Removes `dependent`, if it is one. */
	delete(dependent: Dependent): void {
		if (this.#several !== undefined && !this.#several.delete(dependent)) return;
		if (this.#only === dependent) this.#only = undefined;
	}

	/** Removes every dependent. */
	clear(): void {
		this.#several?.clear();
		this.#only = undefined;
	}

	/** The source changed in the current batch: every dependent is marked (flags only, `Dependent.invalidate`). */
	invalidate(): void {
		this.#tell(mark);
	}

	/** The source's document was retired in the current batch: every dependent is told (`Dependent.sourceRetired`). */
	sourceRetired(visited: Set<Dependent>): void {
		// A closure per retirement, which is rare.
		this.#tell((dependent) => dependent.sourceRetired(visited));
	}

	/**
	 * Calls `tell` with every dependent as a set's iteration would: in the order added, one added meanwhile too, one
	 * removed meanwhile not, one removed and added again once more.
	 */
	#tell(tell: (dependent: Dependent) => void): void {
		for (;;) {
			const several = this.#several;
			if (several !== undefined) {
				for (const dependent of several) tell(dependent);
				return;
			}
			const only = this.#only;
			if (only === undefined) return;
			const entry = this.#entry;
			tell(only);
			const made = this.#several;
			if (made !== undefined) {
				// A set was made meanwhile. Still around the entry just told: that is its first, the rest follows it.
				const rest = made.values();
				if (this.#only === only && this.#entry === entry) rest.next();
				for (const dependent of rest) tell(dependent);
				return;
			}
			// The same entry, or none: all are told. Another entry took its place meanwhile: it is told next.
			if (this.#entry === entry) return;
		}
	}
}

/** Marks one dependent: one shared function, so a change allocates nothing to tell its dependents. */
function mark(dependent: Dependent): void {
	dependent.invalidate();
}
