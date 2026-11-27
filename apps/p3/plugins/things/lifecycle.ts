// A removed thing's `delete` hook (clearing what its kind keeps in it), run by the things store and kept durable in
// `things.pending`, written in the commit that removed the thing: a hook that fails is tried again, with backoff and
// at every start, until it succeeds. A delete whose kind no loaded plugin contributes waits until one does; a kind
// that contributes no delete hook needs none. One thing's delete never runs twice at once: a store attempt that ends
// waits for the hooks it started before the next one resumes. (A new thing's `create` hook runs before the commit that
// makes it, item 34: see `store.ts`; what it prepared for an id that does not stand is cleared the same way, `undo`.)

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
	/** The store's own context once it serves. */
	#serving: Ctx<P3Principal> | undefined;
	/** The things whose delete is being tried, so one is never tried twice at once, and their tries. */
	readonly #retiring = new Map<string, Promise<void>>();

	constructor(store: LifecycleStore) {
		this.#store = store;
	}

	/**
	 * The store's routine while it is live (its `ctx` the store's own): resumes what was pending, then waits; once the
	 * attempt ends, it ends after the delete hooks it started (the next attempt's `resume` never overlaps them).
	 */
	async serve(ctx: Ctx<P3Principal>): Promise<void> {
		this.#serving = ctx;
		this.#live.resolve(ctx);
		await this.resume(ctx);
		await untilAborted(ctx);
		await Promise.all(this.#retiring.values());
	}

	/**
	 * `thing`, removed in a commit that wrote its pending row: its kind's delete hook runs (again, until it succeeds).
	 */
	retire(thing: string, kind: string): void {
		if (this.#retiring.has(thing)) return;
		const trying = this.#retire(thing, kind).finally(() => this.#retiring.delete(thing));
		this.#retiring.set(thing, trying);
	}

	/**
	 * Every pending delete, tried again: at the start, and whenever the kinds' hooks change (a missing plugin back). It
	 * ends with `ctx` (the routine's) when the store never got to serve (its `onLive` failed first, a close or a reload
	 * during it), so a close never waits for it (ERNDL-1187).
	 */
	async resume(ctx: Ctx<P3Principal>): Promise<void> {
		const own = await this.#served(ctx);
		if (own === undefined) return;
		for (const { thing, kind } of await this.#store.pending(own)) this.retire(thing, kind);
	}

	/**
	 * Kind `kind`'s create hook prepared `thing`, which does not stand (its commit failed, or another seeded thing won):
	 * a pending row, written under the store's own context (`ctx`, the caller's, may be cancelled), keeps the cleanup
	 * due until the kind's delete hook ran, also when its plugin went meanwhile (it runs once one serves the kind
	 * again). A storage failure is reported: what is left is the accepted crash case, content under an id nobody knows.
	 */
	async undo(thing: string, kind: string, ctx: Ctx<P3Principal>): Promise<void> {
		const own = await this.#served(ctx);
		if (own === undefined) {
			reportError(
				`things: the cleanup of ${kind}'s ${thing}, never made, could not be kept (the store closed)`,
				undefined,
				ctx,
			);
			return;
		}
		try {
			await this.#store.write(async (tx) => {
				tx.put(this.#store.table, { thing, kind });
				return null;
			}, own);
		} catch (error) {
			reportError(`things: the cleanup of ${kind}'s ${thing}, never made, could not be kept`, error, ctx);
			return;
		}
		this.retire(thing, kind);
	}

	/**
	 * The store's own context once it serves; `undefined` if `ctx` aborts first (the store never served). Once served
	 * it is answered at once (no listener on `ctx`).
	 */
	async #served(ctx: Ctx<P3Principal>): Promise<Ctx<P3Principal> | undefined> {
		if (this.#serving !== undefined) return this.#serving;
		return Promise.race([this.#live.promise, untilAborted(ctx).then(() => undefined)]);
	}

	async #retire(thing: string, kind: string): Promise<void> {
		const ctx = await this.#live.promise;
		try {
			for (
				let delay = FIRST_DELAY;
				!(await this.#retireOnce(thing, kind, ctx));
				delay = Math.min(delay * 2, LONGEST)
			) {
				await sleep(delay, ctx);
			}
		} catch (error) {
			// The store's attempt ended (its context aborted the wait): the next one resumes from what is pending.
			if (ctx.abortSignal?.aborted === true) return;
			reportError(`things: the delete of ${kind}'s ${thing}; tried again at the next start`, error, ctx);
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
