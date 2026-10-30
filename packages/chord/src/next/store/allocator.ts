// The store's id allocator (slice 6b D3, §1.2): one counter for every id in the store (Durable's `mintId`, Chord's
// document ids), synchronous, raised by explicit ids, saturating at `Number.MAX_SAFE_INTEGER`.

/** The first id the allocator gives: id 1 is Durable's root conversation. */
export const FIRST_ID = 2;

/**
 * The allocator: `value` is the next id it gives. An id raised to `Number.MAX_SAFE_INTEGER` is accepted, the value
 * stays there, and every later `mint` throws: no id past the safe range (it would stop counting exactly and repeat).
 */
export class IdAllocator {
	#next: number;

	constructor(next: number) {
		this.#next = next;
	}

	/** The next id `mint` gives; what each commit persists. */
	get value(): number {
		return this.#next;
	}

	/** Takes the next id; throws "ID space is exhausted" once saturated (Durable's message). */
	mint(): number {
		if (this.#next >= Number.MAX_SAFE_INTEGER) throw new Error("ID space is exhausted");
		return this.#next++;
	}

	/** Raises the counter above `id`, an id written explicitly (Durable mints ahead), saturating. */
	raise(id: number): void {
		if (id >= this.#next) this.#next = Math.min(id + 1, Number.MAX_SAFE_INTEGER);
	}
}
