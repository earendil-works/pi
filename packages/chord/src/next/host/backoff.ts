// Retry backoff per identity (§6): after a transient failure an identity waits 1 s, doubling up to 60 s. The entries
// hold no object, so a failed object is collected after its last reference while its window still runs.

/** The delay after the first transient failure. */
const FIRST_DELAY = 1_000;

/** The longest delay. */
const MAX_DELAY = 60_000;

/**
 * The delay after a failure: 1 s after the first (no `previous` delay), then the previous one doubled, up to 60 s.
 * Identities, routines and job finishes back off alike.
 */
export function nextDelay(previous: number | undefined): number {
	return previous === undefined ? FIRST_DELAY : Math.min(previous * 2, MAX_DELAY);
}

/**
 * One identity's backoff: the delay of its last window, when that window ends (`Date.now()` time), and the timer ending
 * a window still running.
 */
type Entry = { readonly delay: number; readonly until: number; timer: ReturnType<typeof setTimeout> | undefined };

/**
 * The host's backoff map. When a window ends, `due(identity)` runs: the host retries the identity's object, or
 * deletes the entry when there is none. An entry is deleted on success, on a broken failure, and when its window has
 * passed with nothing left to retry.
 */
export class Backoff {
	readonly #entries = new Map<string, Entry>();
	readonly #due: (identity: string) => void;

	constructor(due: (identity: string) => void) {
		this.#due = due;
	}

	/** Records a transient failure: a window of the previous delay doubled (1 s at first), then `due`. */
	failed(identity: string): void {
		const previous = this.#entries.get(identity);
		clearTimeout(previous?.timer);
		const delay = nextDelay(previous?.delay);
		const entry: Entry = { delay, until: Date.now() + delay, timer: undefined };
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			this.#due(identity);
		}, delay);
		this.#entries.set(identity, entry);
	}

	/** Whether `identity` is inside a window: a new object for it waits for `due` before its first attempt. */
	waiting(identity: string): boolean {
		return this.#entries.get(identity)?.timer !== undefined;
	}

	/** When the window of `identity` ends, while one runs: a failed reference's `retryAt`. */
	until(identity: string): number | undefined {
		const entry = this.#entries.get(identity);
		return entry?.timer === undefined ? undefined : entry.until;
	}

	/** Ends the window at once (its object is retried now, R18); the delay stays for the next failure. */
	skip(identity: string): void {
		const entry = this.#entries.get(identity);
		clearTimeout(entry?.timer);
		if (entry !== undefined) entry.timer = undefined;
	}

	/** Its object ended: an entry whose window has passed gets no outcome any more and goes. */
	ended(identity: string): void {
		if (this.#entries.has(identity) && !this.waiting(identity)) this.#entries.delete(identity);
	}

	/** Forgets `identity` (success, a broken failure, or a window that passed with nothing to retry). */
	delete(identity: string): void {
		clearTimeout(this.#entries.get(identity)?.timer);
		this.#entries.delete(identity);
	}

	/** Forgets every identity (the host closes). */
	clear(): void {
		for (const identity of [...this.#entries.keys()]) this.delete(identity);
	}
}
