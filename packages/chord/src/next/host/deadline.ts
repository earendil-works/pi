// An activation's `readyTimeout` deadline (slice 6a §9): one timer that eager migration work pauses and resumes with
// the budget it had left, so a long migration does not fail its object while other activations keep their bounds.

/** A deadline of `ms` calling `expired` once when reached; paused time does not count. */
export class Deadline {
	readonly #expired: () => void;
	/** The budget left when the timer last started (or paused). */
	#remaining: number;
	#started = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#cleared = false;

	constructor(ms: number, expired: () => void) {
		this.#expired = expired;
		this.#remaining = ms;
		this.#start();
	}

	/** Stops the clock; `resume` restarts it with the budget left. */
	pause(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#remaining = Math.max(0, this.#remaining - (Date.now() - this.#started));
	}

	/** Restarts a paused clock. */
	resume(): void {
		if (this.#timer === undefined && !this.#cleared) this.#start();
	}

	/** Ends the deadline: `expired` is never called. */
	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#cleared = true;
	}

	#start(): void {
		this.#started = Date.now();
		this.#timer = setTimeout(this.#expired, this.#remaining);
	}
}
