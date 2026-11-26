// A set that keeps its one member without a `Set`: what most objects have one of (their holders). A `Set` of one costs
// 184 B for as long as its owner lives. Iterated while its members change (added, removed, cleared, added again), it
// yields exactly what a `Set`'s iteration would, in its order: the technique of a source's `Dependents`
// (`state/dependents.ts`), which tells its members without an iterator object.

import { NO_ITEMS } from "./lists.ts";

/** Members in the order added, each once; a `Set` only from the second member on. */
export class SmallSet<T> implements Iterable<T> {
	/**
	 * Without a set: the only member, if there is one. With a set: the member the set was made around, while it is
	 * still the entry it was as the only one (not removed since), so an iteration that yielded it knows its place.
	 */
	#only: T | undefined;
	/** Counts the members that became the only one: tells an entry from a later one of the same member. */
	#entry = 0;
	/** Every member, from the second one on; kept once made (an owner with several keeps getting them). */
	#several: Set<T> | undefined;

	/** How many there are. */
	get size(): number {
		if (this.#several !== undefined) return this.#several.size;
		return this.#only === undefined ? 0 : 1;
	}

	/** Adds `member` (once, however often it is added). */
	add(member: T): void {
		if (this.#several !== undefined) {
			this.#several.add(member);
		} else if (this.#only === undefined) {
			this.#only = member;
			this.#entry++;
		} else if (this.#only !== member) {
			this.#several = new Set([this.#only, member]);
		}
	}

	/** Removes `member`; whether it was one. */
	delete(member: T): boolean {
		if (this.#several !== undefined) {
			if (!this.#several.delete(member)) return false;
			if (this.#only === member) this.#only = undefined;
			return true;
		}
		if (this.#only !== member) return false;
		this.#only = undefined;
		return true;
	}

	/** Removes every member. */
	clear(): void {
		this.#several?.clear();
		this.#only = undefined;
	}

	/**
	 * Calls `each` with every member as a set's iteration would: in the order added, one added meanwhile too, one
	 * removed meanwhile not, one removed and added again once more. Allocates nothing for none or one (an iteration
	 * makes a generator).
	 */
	forEach(each: (member: T) => void): void {
		for (;;) {
			const several = this.#several;
			if (several !== undefined) {
				for (const member of several) each(member);
				return;
			}
			const only = this.#only;
			if (only === undefined) return;
			const entry = this.#entry;
			each(only);
			const made = this.#several;
			if (made !== undefined) {
				// A set was made meanwhile. Still around the entry just told: that is its first, the rest follows it.
				const rest = made.values();
				if (this.#only === only && this.#entry === entry) rest.next();
				for (const member of rest) each(member);
				return;
			}
			// The same entry, or none: all were told. Another entry took its place meanwhile: it is told next.
			if (this.#entry === entry) return;
		}
	}

	/** Its members now, as a list: what spreading a set made (no generator). */
	snapshot(): readonly T[] {
		if (this.#several !== undefined) return [...this.#several];
		return this.#only === undefined ? NO_ITEMS : [this.#only];
	}

	/**
	 * Its members as a set's iteration yields them, as `forEach` tells them (the same steps, as a generator: for code
	 * that iterates any iterable).
	 */
	*[Symbol.iterator](): Generator<T, void, undefined> {
		for (;;) {
			const several = this.#several;
			if (several !== undefined) {
				yield* several;
				return;
			}
			const only = this.#only;
			if (only === undefined) return;
			const entry = this.#entry;
			yield only;
			const made = this.#several;
			if (made !== undefined) {
				// A set was made meanwhile. Still around the entry just yielded: that is its first, the rest follows it.
				const rest = made.values();
				if (this.#only === only && this.#entry === entry) rest.next();
				yield* rest;
				return;
			}
			// The same entry, or none: all were yielded. Another entry took its place meanwhile: it is yielded next.
			if (this.#entry === entry) return;
		}
	}
}
