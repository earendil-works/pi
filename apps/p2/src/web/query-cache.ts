/**
 * Remembers the last answer per key and shares requests in flight, for listings that Back and revisits show at once:
 * a tap starts the request together with its navigation step, and the screen that renders afterwards joins that
 * request instead of sending another.
 *
 * An answer is fresh until `invalidate` matches its key, for example when the source reports a change; a stale one is
 * still shown while a new request runs. Without change reports, invalidate before every use.
 */
export class QueryCache<T> {
	readonly #limit: number;
	readonly #values = new Map<string, T>();
	readonly #pending = new Map<string, Promise<T>>();
	readonly #fresh = new Set<string>();
	/** Counts invalidations: an answer to a request started before one is not fresh. */
	#generation = 0;
	/** The latest request per key: an older one finishing later must not replace its answer. */
	readonly #latest = new Map<string, number>();
	#requests = 0;

	constructor(limit = 200) {
		this.#limit = limit;
	}

	/** The last answer for `key`, if any. */
	get(key: string): T | undefined {
		return this.#values.get(key);
	}

	/** Whether the last answer for `key` is still valid: no invalidation has matched it since its request started. */
	fresh(key: string): boolean {
		return this.#fresh.has(key);
	}

	/** Answers for matching keys become stale; requests in flight for them are no longer joined. */
	invalidate(matches: (key: string) => boolean): void {
		this.#generation++;
		for (const key of this.#fresh) if (matches(key)) this.#fresh.delete(key);
		for (const key of this.#pending.keys()) if (matches(key)) this.#pending.delete(key);
	}

	/** The answer for `key`: the request already in flight, or a new one. */
	fetch(key: string, request: () => Promise<T>): Promise<T> {
		const pending = this.#pending.get(key);
		if (pending) return pending;
		const generation = this.#generation;
		const id = ++this.#requests;
		this.#latest.set(key, id);
		const started = request().then(
			(value) => {
				if (this.#latest.get(key) !== id) return value;
				this.#latest.delete(key);
				this.#values.delete(key);
				this.#values.set(key, value);
				if (generation === this.#generation) this.#fresh.add(key);
				else this.#fresh.delete(key);
				// Least recently answered first.
				while (this.#values.size > this.#limit) {
					const oldest = this.#values.keys().next().value;
					if (oldest === undefined) break;
					this.#values.delete(oldest);
					this.#fresh.delete(oldest);
				}
				return value;
			},
			(error: unknown) => {
				if (this.#latest.get(key) !== id) throw error;
				this.#latest.delete(key);
				this.#values.delete(key);
				this.#fresh.delete(key);
				throw error;
			},
		);
		const tracked = started.finally(() => {
			if (this.#pending.get(key) === tracked) this.#pending.delete(key);
		});
		this.#pending.set(key, tracked);
		return tracked;
	}

	/** Start `fetch` for a likely next screen; failures surface when that screen asks. */
	prefetch(key: string, request: () => Promise<T>): void {
		void this.fetch(key, request).catch(() => {});
	}
}
