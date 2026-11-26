// Lists (slice 14 §4): `self.list(name, sources, { first })`, a named query a screen loads more of. Its value is
// `{ rows, moreAfter }`: the rows of its pages joined in order (`tiling.ts`). Loaded rows stay live, "load more"
// sends only the new rows, and a row that moves (a list by last touch) leaves one page and enters another in the
// same commit: no gap, no duplicate. The object keeps the bookmarks across its attempts.

import { awaitWithContext, type Context } from "../context/index.ts";
import { type FramedOwner, FramedSource } from "../state/internal.ts";
import { DecodedRows } from "../store/decoded-rows.ts";
import type { LiveTarget } from "../store/live-query.ts";
import type { ReadSite } from "../store/open-query.ts";
import type { Position } from "../store/read-plan.ts";
import type { Reading } from "./query-reader.ts";
import { Tiling } from "./tiling.ts";

/** What `self.list` takes besides its name and sources. */
export type ListOptions = {
	/** The rows of a page: what the first page and each `more` load. A positive integer. */
	readonly first: number;
};

/**
 * What an object keeps of a list across its attempts (a reload, a restart): the bookmarks, whether the last page was
 * open at its end, and the order they are positions of. It goes with the object.
 */
export type ListMemory = { signature: string; bookmarks: readonly Position[]; open: boolean };

/**
 * A list as a JSON source, read as a reader reads (`Reading`): each `read` opens every page again under its
 * bookmark, for the new target, and the list switches in one frame once each has run; bookmarks of another order
 * start it again with a first page.
 */
export class List extends FramedSource implements Reading {
	readonly #site: ReadSite;
	readonly #first: number;
	readonly #memory: ListMemory;
	readonly #rows = new DecodedRows();
	/** The tiling its value is of, and the one that replaces it once every page of it ran. */
	#current: Tiling | undefined;
	#next: Tiling | undefined;
	/** The `more` calls in turn: one at a time per list. */
	#loading: Promise<unknown> = Promise.resolve();
	/** Resolved when the list has another current tiling, or none (a switch, a failure, its end). */
	#switched = Promise.withResolvers<void>();

	constructor(site: ReadSite, owner: FramedOwner, first: number, memory: ListMemory) {
		super(site.batch, owner);
		this.#site = site;
		this.#first = first;
		this.#memory = memory;
	}

	/**
	 * Reads `target` from now on: its pages open under the bookmarks the list has (when they are positions of its
	 * order: another order starts again with a first page). The list shows its previous rows until every page of the
	 * new tiling ran, then switches in one frame. Resolves once every page's load settled.
	 */
	read(target: LiveTarget, context: Context): Promise<void> {
		if (this.detached) return Promise.resolve();
		this.#next?.close();
		const owner = { adopted: () => this.#adopted(tiling), rebound: () => this.#rebound(tiling) };
		const tiling: Tiling = new Tiling(this.#site, target, this.#first, owner, context);
		this.#next = tiling;
		const memory = this.#memory;
		const kept = memory.signature === tiling.signature;
		return tiling.start(kept ? memory.bookmarks : [], kept ? memory.open : true);
	}

	/**
	 * What it should read cannot be read (its arguments threw, its provider refused them): a failed member with its
	 * last rows. Its pages close: neither the previous target's pages nor a pending tiling may publish or heal the
	 * failure; the next `read` does.
	 */
	fail(error: unknown, context: Context): void {
		if (this.detached) return;
		this.#close();
		this.batch.within(() => this.failWith(error), context);
	}

	/** Its attempt ended: no commit runs its pages again, reads throw `error`, its watches end. */
	detach(error: Error): void {
		this.#close();
		this.end(error);
	}

	/**
	 * Loads one more page of `first` rows behind the last one; calls run one at a time. A call waits while the list
	 * is about to show other pages, and loads behind those: while a tiling is pending (new arguments, a changed
	 * binding; its pages may not have run yet: a table they read is held) and while the provider restarts (its query
	 * is closed, its successor's not read yet: nothing is read with the old code's statement). The caller's wait ends
	 * with `context`; the load goes on.
	 */
	more(context: Context): Promise<null> {
		const loaded = this.#loading.then(async () => {
			while (this.#next !== undefined || this.#current?.retired === true) await this.#switched.promise;
			await this.#current?.more();
			return null;
		});
		// A failed load is its caller's; the next call runs after it either way.
		this.#loading = loaded.catch(() => {});
		return awaitWithContext(loaded, context);
	}

	#close(): void {
		this.#current?.close();
		this.#next?.close();
		this.#next = undefined;
		this.#show(undefined);
	}

	/** `tiling` is the current one from now on; the `more` calls waiting for another one go on. */
	#show(tiling: Tiling | undefined): void {
		this.#current = tiling;
		this.#switched.resolve();
		this.#switched = Promise.withResolvers<void>();
	}

	/**
	 * A binding of `tiling`'s query changed: its target is read again as one new tiling under the list's bookmarks,
	 * and the list switches in one frame once every page of it ran, as for new arguments. A current tiling that a
	 * pending one is about to replace is left alone: the pending one reads again for itself.
	 */
	#rebound(tiling: Tiling): void {
		if (this.detached) return;
		const pending = this.#next;
		if (tiling === pending || (tiling === this.#current && pending === undefined)) {
			// A failed page fails the list, as any read's failure does; nothing awaits the loads.
			void this.read(tiling.target, tiling.context);
		}
	}

	/**
	 * A run of `tiling` was adopted, inside a batch. A pending tiling becomes the current one once every page of it
	 * ran: never a first page alone, never rows of two targets. A failed page of it fails the list at once, and the
	 * previous target's pages close: they may not heal that failure. The current tiling's run makes the list's value,
	 * and its bookmarks are what the object keeps.
	 */
	#adopted(tiling: Tiling): void {
		if (this.detached) return;
		if (tiling === this.#next) {
			const failure = tiling.failure;
			if (failure === undefined && !tiling.complete) return;
			this.#current?.close();
			this.#next = undefined;
			this.#show(tiling);
			this.#rows.reset();
		} else if (tiling !== this.#current) return;
		const failure = tiling.failure;
		if (failure !== undefined) {
			this.failWith(failure.error);
			return;
		}
		// A page of the current tiling that has not run (its table was held when the list opened): no value yet.
		if (!this.ready && !tiling.complete) return;
		const memory = this.#memory;
		memory.signature = tiling.signature;
		memory.bookmarks = tiling.bookmarks;
		memory.open = tiling.open;
		try {
			const rows = this.#rows.decode(tiling.rows(), tiling.target, tiling.context);
			this.set({ rows, moreAfter: tiling.moreAfter });
		} catch (error) {
			this.failWith(error);
		}
	}
}
