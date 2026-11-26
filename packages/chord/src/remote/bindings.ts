// The bindings of a remote object (its references), in the order they joined: a set's semantics without a set for
// the one reference most objects have (a `Set` with its table costs 152 B; the hold-memory benches).

/**
 * Members in insertion order, as a `Set` keeps them (adding a member again changes nothing, a member removed and added
 * again goes last); only snapshots are iterated (`list`). The first member stays in a field until a second joins; the
 * later ones go in a set after it, and once that set exists every add goes there, so the field's member stays first.
 */
export class Bindings<T> {
	#first: T | undefined;
	#later: Set<T> | undefined;

	get size(): number {
		return (this.#first === undefined ? 0 : 1) + (this.#later?.size ?? 0);
	}

	has(member: T): boolean {
		return this.#first === member || this.#later?.has(member) === true;
	}

	/** Adds `member` last; nothing when it is one already. */
	add(member: T): void {
		if (this.has(member)) return;
		if (this.#later !== undefined) this.#later.add(member);
		else if (this.#first === undefined) this.#first = member;
		else this.#later = new Set([member]);
	}

	/** Removes `member`; whether it was one. */
	delete(member: T): boolean {
		if (this.#first !== member) return this.#later?.delete(member) ?? false;
		this.#first = undefined;
		return true;
	}

	/** The members now, in their order: a copy, as `[...set]` makes it. */
	list(): T[] {
		const first = this.#first;
		if (this.#later === undefined) return first === undefined ? [] : [first];
		return first === undefined ? [...this.#later] : [first, ...this.#later];
	}

	clear(): void {
		this.#first = undefined;
		this.#later = undefined;
	}
}
