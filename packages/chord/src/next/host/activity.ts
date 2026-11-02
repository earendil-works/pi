// Keep-alive counts (§3, R26): `host.activity`, a JSON watchable of the work keeping a host busy, for the app's
// supervisor. Counters are kept where the work happens; their changes in one microtask turn are one publication.

import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { Source } from "../state/internal.ts";

/** What `host.activity` counts. */
export type ActivityCounts = {
	/** Holds arriving over links and served here. */
	readonly references: number;
	/** Method calls running on this host, local and remote. */
	readonly calls: number;
	/** Running jobs (slice 5). */
	readonly jobs: number;
	/** Objects kept live by their type's `linger` after their last reference. */
	readonly lingering: number;
};

/**
 * `host.activity`. A count marks it changed; while it is watched or derived from, the first change of a microtask turn
 * schedules one publication, a batch that gives its watches the counts as they are then (`[["r", counts]]`: a slow
 * watch gets the newest counts) and marks derives over it. Its value is built from the counters when read or
 * published.
 */
export class Activity extends Source {
	readonly #counts = { references: 0, calls: 0, jobs: 0, lingering: 0 };
	/** The counts as last read, until the next change. */
	#value: ActivityCounts | undefined;
	#scheduled = false;

	get value(): JsonValue {
		this.#value ??= { ...this.#counts };
		return this.#value;
	}

	/**
	 * Adds `delta` to the count of `kind`; published with the turn's other changes. Nothing is scheduled while nobody
	 * watches or derives from it: a later watch or derive reads the counts as they are then.
	 */
	count(kind: keyof ActivityCounts, delta: number): void {
		this.#counts[kind] += delta;
		this.#value = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}

	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}
}
