// An object's line (§9): its transactions, cold loads, key pages and eviction sweeps run on it one at a time, in the
// order they asked.

/** An object's line: `acquire()` resolves with the release once every earlier holder released; releasing twice is harmless. */
export class Line {
	#tail: Promise<void> = Promise.resolve();

	/** Resolves with this holder's release once every earlier holder released. */
	acquire(): Promise<() => void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = this.#tail;
		this.#tail = promise;
		return previous.then(() => resolve);
	}
}
