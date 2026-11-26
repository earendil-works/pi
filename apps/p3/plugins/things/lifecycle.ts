// The kinds' hooks around a thing's life, run by the things store: a new thing's `create` hook (what is in it), a
// removed thing's `delete` hook (clearing it). Both are kept durable in `things.pending`, written in the commit that
// made or removed the thing: a create that fails, is cancelled or is cut off by the store's end leaves nothing behind
// (the thing is removed again, under the store's own context), and a delete that fails is tried again, with backoff and
// at every start, until it succeeds. The two hooks of one thing never overlap: the delete waits for a create still
// preparing the thing, so cleaning up always comes last. A delete whose kind no loaded plugin contributes waits until
// one does; a kind that contributes no delete hook needs none.

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

/** What waits for a thing's hook: its `create` (made, not prepared yet) or its `delete` (removed, not cleared yet). */
export const Pending = defineTable("things.pending", {
	version: 1,
	columns: { thing: str(), kind: str(), step: str() },
	key: ["thing"],
});

/** A row of `Pending`. */
export type PendingRow = { readonly thing: string; readonly kind: string; readonly step: string };

/** What the lifecycle needs of the store: its writes (one commit each, the index following) and its reads. */
export type LifecycleStore = {
	/** Runs `fn` as one write of the store under `ctx`. */
	write<R>(fn: (tx: Tx) => Promise<R>, ctx: Ctx<P3Principal>): Promise<R>;
	/** Removes `thing` (of `kind`) as an unlink of its last link does, if it is still there. */
	remove(thing: string, kind: string, ctx: Ctx<P3Principal>): Promise<void>;
	/** Every pending row. */
	pending(ctx: Ctx<P3Principal>): Promise<readonly PendingRow[]>;
	/** The kinds' hooks now. */
	hooks(): ReadonlyMap<string, TableItem<ThingHook>>;
	/** The pending table. */
	readonly table: TableOf<typeof Pending>;
};

/** The delay after a delete hook's first failure; it doubles up to `LONGEST`. */
const FIRST_DELAY = 1_000;
const LONGEST = 60_000;

/** The hooks of one store object's things (see the file's head). */
export class Lifecycle {
	readonly #store: LifecycleStore;
	readonly #live = Promise.withResolvers<Ctx<P3Principal>>();
	/** Per thing: the hook that runs now, so the next waits for it. */
	readonly #locks = new Map<string, Promise<unknown>>();
	/** The things whose create runs in this attempt: a start's resume leaves them alone. */
	readonly #creating = new Set<string>();
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

	/**
	 * Runs `kind`'s create hook for the new `thing` under the caller's `ctx`; a hook that throws (or rejects) gets the
	 * thing removed again by the store, and its error is thrown.
	 */
	async created(thing: string, kind: string, input: unknown, ctx: Ctx<P3Principal>): Promise<void> {
		this.#creating.add(thing);
		try {
			await this.#locked(thing, () => this.#create(thing, kind, input, ctx));
		} finally {
			this.#creating.delete(thing);
		}
	}

	/** `thing`, removed in a commit that wrote its pending delete: its kind's delete hook runs (again, until it succeeds). */
	retire(thing: string, kind: string): void {
		void this.#retire(thing, kind);
	}

	/**
	 * What is pending on disk, again: a create no call runs any more (cut off by an end) is undone, a delete tried. Run
	 * at the start and whenever the kinds' hooks change (a plugin that was missing is back).
	 */
	async resume(): Promise<void> {
		const ctx = await this.#live.promise;
		for (const { thing, kind, step } of await this.#store.pending(ctx)) {
			if (step === "retire") this.retire(thing, kind);
			else if (!this.#creating.has(thing)) void this.#locked(thing, () => this.#store.remove(thing, kind, ctx));
		}
	}

	async #create(thing: string, kind: string, input: unknown, caller: Ctx<P3Principal>): Promise<void> {
		try {
			await this.#store.hooks().get(kind)?.value.create?.(thing, input, caller);
		} catch (error) {
			await this.#store.remove(thing, kind, await this.#live.promise);
			throw error;
		}
		await this.#settle(thing, "create", await this.#live.promise);
	}

	async #retire(thing: string, kind: string): Promise<void> {
		if (this.#retiring.has(thing)) return;
		this.#retiring.add(thing);
		try {
			const ctx = await this.#live.promise;
			for (let delay = FIRST_DELAY; ; delay = Math.min(delay * 2, LONGEST)) {
				if (await this.#locked(thing, () => this.#retireOnce(thing, kind, ctx))) return;
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
		await this.#settle(thing, "retire", ctx);
		return true;
	}

	/** `thing`'s pending row is done, if it still waits for `step`. */
	#settle(thing: string, step: string, ctx: Ctx<P3Principal>): Promise<null> {
		return this.#store.write(async (tx) => {
			if ((await tx.get(this.#store.table, { thing }))?.step === step) tx.delete(this.#store.table, { thing });
			return null;
		}, ctx);
	}

	/** Runs `fn` once every hook of `thing` before it ended. */
	#locked<T>(thing: string, fn: () => Promise<T>): Promise<T> {
		const before = this.#locks.get(thing) ?? Promise.resolve();
		const run = before.then(fn);
		const after = run.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(thing, after);
		void after.then(() => {
			if (this.#locks.get(thing) === after) this.#locks.delete(thing);
		});
		return run;
	}
}
