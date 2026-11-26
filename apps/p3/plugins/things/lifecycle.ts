// A removed thing's `delete` hook (clearing what its kind keeps in it), run by the things store and kept durable in
// `things.pending`, written in the commit that removed the thing: a hook that fails is tried again, with backoff and
// at every start, until it succeeds. A delete whose kind no loaded plugin contributes waits until one does; a kind
// that contributes no delete hook needs none. (A new thing's `create` hook runs before the commit that makes it, item
// 34: see `store.ts`; a commit that fails after it gets the kind's delete hook here, once, `undo`.)

import {
	type Ctx,
	defineTable,
	type P3Principal,
	reportError,
	sleep,
	str,
	type TableItem,
	type TableOf,
	type Tx,
	untilAborted,
} from "@earendil-works/p3/v1";
import type { ThingHook } from "./contract.server.ts";

/** A thing removed whose kind has not cleared it yet. */
export const Pending = defineTable("things.pending", {
	version: 1,
	columns: { thing: str(), kind: str() },
	key: ["thing"],
});

/** A row of `Pending`. */
export type PendingRow = { readonly thing: string; readonly kind: string };

/** What the lifecycle needs of the store: its writes (one commit each, the index following) and its reads. */
export type LifecycleStore = {
	/** The pending table. */
	readonly table: TableOf<typeof Pending>;
	/** Runs `fn` as one write of the store under `ctx`. */
	write<R>(fn: (tx: Tx) => Promise<R>, ctx: Ctx<P3Principal>): Promise<R>;
	/** Every pending row. */
	pending(ctx: Ctx<P3Principal>): Promise<readonly PendingRow[]>;
	/** The kinds' hooks now. */
	hooks(): ReadonlyMap<string, TableItem<ThingHook>>;
};

/** The delay after a delete hook's first failure; it doubles up to `LONGEST`. */
const FIRST_DELAY = 1_000;
const LONGEST = 60_000;

/** The delete hooks of one store object's removed things (see the file's head). */
export class Lifecycle {
	readonly #store: LifecycleStore;
	readonly #live = Promise.withResolvers<Ctx<P3Principal>>();
	/** The things whose delete is being tried, so one is never tried twice at once. */
	readonly #retiring = new Set<string>();

	constructor(store: LifecycleStore) {
		this.#store = store;
	}

	/** The store's routine while it is live (its `ctx` the store's own): resumes what was pending, then waits. */
	async serve(ctx: Ctx<P3Principal>): Promise<void> {
		this.#live.resolve(ctx);
		await this.resume();
		await untilAborted(ctx);
	}

	/** `thing`, removed in a commit that wrote its pending row: its kind's delete hook runs (again, until it succeeds). */
	retire(thing: string, kind: string): void {
		void this.#retire(thing, kind);
	}

	/** Every pending delete, tried again: at the start, and whenever the kinds' hooks change (a missing plugin back). */
	async resume(): Promise<void> {
		const ctx = await this.#live.promise;
		for (const { thing, kind } of await this.#store.pending(ctx)) this.retire(thing, kind);
	}

	/**
	 * The commit making `thing` failed after its kind's create hook prepared it: the kind's delete hook clears it, once,
	 * under the store's own context (a failure is reported; nothing on disk names the thing).
	 */
	async undo(thing: string, kind: string): Promise<void> {
		const ctx = await this.#live.promise;
		try {
			await this.#store.hooks().get(kind)?.value.delete?.(thing, ctx);
		} catch (error) {
			reportError(`things: the delete hook of ${kind} for ${thing}, never made`, error, ctx);
		}
	}

	async #retire(thing: string, kind: string): Promise<void> {
		if (this.#retiring.has(thing)) return;
		this.#retiring.add(thing);
		try {
			const ctx = await this.#live.promise;
			for (
				let delay = FIRST_DELAY;
				!(await this.#retireOnce(thing, kind, ctx));
				delay = Math.min(delay * 2, LONGEST)
			) {
				await sleep(delay, ctx);
			}
		} catch {
			// The store's attempt ended (its context aborted the wait): the next one resumes from what is pending.
		} finally {
			this.#retiring.delete(thing);
		}
	}

	/** One try of `thing`'s delete: whether it is over (cleared, nothing to clear, or waiting for its kind's plugin). */
	async #retireOnce(thing: string, kind: string, ctx: Ctx<P3Principal>): Promise<boolean> {
		const entry = this.#store.hooks().get(kind);
		// No plugin contributes the kind now: it waits, and the next `resume` (the plugin back) tries again.
		if (entry === undefined) return true;
		try {
			await entry.value.delete?.(thing, ctx);
		} catch (error) {
			reportError(`things: the delete hook of ${kind} for ${thing}; tried again later`, error, ctx);
			return false;
		}
		await this.#store.write(async (tx) => {
			tx.delete(this.#store.table, { thing });
			return null;
		}, ctx);
		return true;
	}
}
