// One thing at a time per key: a login's requests for its auth (and with them its refresh), a person's sign-in moves.
// Each key's work runs after the work queued before it settled, whatever its outcome; a key with nothing queued holds
// nothing.

/** Work queued per key, run one after another. */
export class Turns {
	readonly #last = new Map<string, Promise<unknown>>();

	/** Runs `fn` once every earlier `fn` of `key` settled; its result. */
	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.#last.get(key) ?? Promise.resolve()).then(fn, fn);
		const settled = run.catch(() => undefined);
		this.#last.set(key, settled);
		void settled.then(() => {
			if (this.#last.get(key) === settled) this.#last.delete(key);
		});
		return run;
	}
}
