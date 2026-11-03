// The `unbound_long` report (decision "Mistakes that wait are reported at once" (c)): a request waiting unbound after
// the host's publication (a type or registry not served here, not at its version, a registry whose first `compose`
// threw) is reported once through `onError` after 5 s, naming what it waits for and why; it keeps waiting as before.
// One clock per host, one timer armed for the earliest wait not reported yet: no timer per request.

import type { ChordError } from "../data/index.ts";

/** What the clock reports: a request waiting unbound for `waitingFor` since `since` (`Date.now()` time), and why. */
export type UnboundLong = {
	readonly kind: "unbound_long";
	/** The type's name, or `registry <name>`. */
	readonly waitingFor: string;
	readonly error: ChordError;
	readonly since: number;
};

/** One wait not reported yet: what it waits for, its latest error, since when. */
type Wait = { readonly waitingFor: string; error: ChordError; readonly since: number };

/** How long a request waits unbound before it is reported (decided: 5 s). */
const REPORTED_AFTER = 5_000;

/** A host's waits not reported yet and the one timer of their sweep. */
export class UnboundClock {
	/** By request, in the order they started, so by `since`: the sweep reads from the front and stops at the first due later. */
	readonly #waits = new Map<object, Wait>();
	readonly #report: (error: UnboundLong) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(report: (error: UnboundLong) => void) {
		this.#report = report;
	}

	/** `request` waits unbound for `waitingFor` with `error`: reported after 5 s unless it stops before. */
	start(request: object, waitingFor: string, error: ChordError): void {
		if (this.#waits.has(request)) return;
		this.#waits.set(request, { waitingFor, error, since: Date.now() });
		this.#timer ??= setTimeout(() => this.#sweep(), REPORTED_AFTER);
	}

	/** The wait of `request` has a new error (a registry's failure changed): the report names the latest. */
	failed(request: object, error: ChordError): void {
		const wait = this.#waits.get(request);
		if (wait !== undefined) wait.error = error;
	}

	/** `request` bound, ended or was woken: no report for this wait. */
	stop(request: object): void {
		if (!this.#waits.delete(request) || this.#waits.size > 0) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** The host closed: nothing is reported any more. */
	close(): void {
		this.#waits.clear();
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Reports every wait due, each once, then arms the timer for the next one, if any. */
	#sweep(): void {
		this.#timer = undefined;
		const now = Date.now();
		for (const [request, wait] of this.#waits) {
			const due = wait.since + REPORTED_AFTER;
			if (due > now) {
				this.#timer = setTimeout(() => this.#sweep(), due - now);
				return;
			}
			this.#waits.delete(request);
			const { waitingFor, error, since } = wait;
			this.#report({ kind: "unbound_long", waitingFor, error, since });
		}
	}
}
