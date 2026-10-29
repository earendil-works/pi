// Residency of keyed documents (slice 6a §10, rule 23): which keyed documents are in memory, and the eviction of
// persisted ones nobody pinned and nobody read or wrote for the retention. One idle structure and one timer per
// object, Durable's (`Session.#touchDocument`): an insertion-ordered map whose oldest entry the timer waits for, a
// touch moving an entry to the back at most once per granule (O(1) per touch, no timer per key).

import type { Tracker } from "../../delta/index.ts";
import type { JsonObject } from "./definition.ts";
import type { Stored } from "./persistence.ts";

/** One keyed document in memory: its slot, its tracker and, persisted, what is stored of it. */
export class Resident {
	readonly slot: { evict(resident: Resident): void };
	readonly key: string;
	tracker: Tracker<JsonObject>;
	stored: Stored | undefined;
	/** The definition version the tracker's value is at: below the slot's, it migrates on its next access. */
	version: number;

	constructor(
		slot: { evict(resident: Resident): void },
		key: string,
		tracker: Tracker<JsonObject>,
		stored: Stored | undefined,
		version: number,
	) {
		this.slot = slot;
		this.key = key;
		this.tracker = tracker;
		this.stored = stored;
		this.version = version;
	}
}

/** How long an unpinned persisted keyed document stays in memory after its last read or write (slice 6a §10). */
export const RETENTION_MS = 10 * 60_000;

/** A touch moves an entry at most once per granule: a tenth of the retention, up to 1 s (Durable's rule). */
const GRANULE_MS = Math.min(1_000, RETENTION_MS / 10);

/** The idle persisted keyed documents of one object, oldest first, and the one timer evicting them. */
export class Residency {
	/** Runs a sweep on the object's line. */
	readonly #onLine: (sweep: () => void) => void;
	readonly #idle = new Map<Resident, number>();
	/** The pending sweep: when it is due and its timer; stays set until its job runs on the line. */
	#sweep: { readonly at: number; timer: ReturnType<typeof setTimeout> | undefined } | undefined;
	#ended = false;

	constructor(onLine: (sweep: () => void) => void) {
		this.#onLine = onLine;
	}

	/** A use of an unpinned `resident`: it becomes the newest idle one (once per granule), and a sweep is scheduled. */
	touch(resident: Resident): void {
		const now = Date.now();
		const since = this.#idle.get(resident);
		// A hot document moves at most once per granule: it may then leave up to a granule early (a reload).
		if (since !== undefined && now - since < GRANULE_MS) return;
		this.#idle.delete(resident);
		this.#idle.set(resident, now);
		if (this.#sweep === undefined) this.#schedule();
	}

	/** `resident` is pinned or left memory: it is no longer idle. */
	forget(resident: Resident): void {
		this.#idle.delete(resident);
	}

	/** The object ended: nothing is evicted any more, the timer is cleared. */
	end(): void {
		this.#ended = true;
		this.#idle.clear();
		clearTimeout(this.#sweep?.timer);
		this.#sweep = undefined;
	}

	/** Schedules the eviction of the oldest idle document when its retention expires. */
	#schedule(): void {
		const oldest = this.#idle.values().next();
		if (this.#ended || oldest.done === true) return;
		const at = oldest.value + RETENTION_MS;
		const sweep: { readonly at: number; timer: ReturnType<typeof setTimeout> | undefined } = { at, timer: undefined };
		this.#sweep = sweep;
		// A timer firing early sweeps nothing and schedules the next one.
		sweep.timer = setTimeout(
			() =>
				this.#onLine(() => {
					if (this.#sweep === sweep) this.#sweep = undefined;
					this.#evictExpired();
				}),
			Math.max(0, at - Date.now()),
		);
	}

	/**
	 * On the line: evicts the idle documents whose retention passed, oldest first, then schedules the next sweep. No
	 * load in flight needs a pin against it: cold loads run on the line too, so a sweep never runs during one, and a
	 * load installing an unpinned key touches it (it is then the newest idle one).
	 */
	#evictExpired(): void {
		if (this.#ended) return;
		const expired = Date.now() - RETENTION_MS;
		for (const [resident, since] of this.#idle) {
			if (since > expired) break;
			this.#idle.delete(resident);
			resident.slot.evict(resident);
		}
		if (this.#sweep === undefined) this.#schedule();
	}
}
