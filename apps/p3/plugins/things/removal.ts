// Removing a workspace and telling the kinds a workspace is gone. A removal cuts the workspace's line in one commit
// (its whole subtree gives nothing from then on: the index finds no way up), and a durable row in `things.removing`
// keeps the rest due: background commits of one workspace each clear the subtree (links, grants, switches, members,
// the things linked nowhere else with their delete hooks), the deepest text first is not needed (every workspace below
// a cut line is gone already). Each cleared workspace, and one a session archived, gets a durable row in
// `things.gone`, and every kind's `workspaceGone` hook runs for it, again with backoff and at every start, until all
// succeeded. One routine per store attempt; a removal or a telling never runs twice at once.

import {
	type Ctx,
	defineTable,
	type P3Principal,
	query,
	reportError,
	sleep,
	str,
	type TableItem,
	type TableOf,
	type Tx,
	untilAborted,
} from "@earendil-works/p3/v1";
import type { ThingHook } from "./contract.server.ts";

/** A workspace being removed, with its path text: what is under it is cleared in background commits. */
export const Removing = defineTable("things.removing", {
	version: 1,
	columns: { workspace: str(), pathText: str() },
	key: ["workspace"],
});

/** A workspace gone (removed, or a session archived) whose kinds' `workspaceGone` hooks have not all run yet. */
export const Gone = defineTable("things.gone", {
	version: 1,
	columns: { workspace: str() },
	key: ["workspace"],
});

/** What the removal needs of the store: its writes (one commit each, the index following) and its reads. */
export type RemovalStore = {
	readonly removing: TableOf<typeof Removing>;
	readonly gone: TableOf<typeof Gone>;
	/** Runs `fn` as one transaction of the store that writes nothing the index reads. */
	read<R>(fn: (tx: Tx) => Promise<R>, ctx: Ctx<P3Principal>): Promise<R>;
	/** One workspace under `pathPrefix` that still has its line, if any. */
	under(tx: Tx, pathPrefix: string): Promise<string | undefined>;
	/**
	 * Clears workspace `workspace` in one write: everything written there, its line and thing; its `Gone` row put;
	 * with `removed`, its `Removing` row goes in the same commit.
	 */
	clear(workspace: string, removed: boolean, ctx: Ctx<P3Principal>): Promise<void>;
	/** The kinds' hooks now. */
	hooks(): ReadonlyMap<string, TableItem<ThingHook>>;
};

/** The delay after a failure; it doubles up to `LONGEST`. */
const FIRST_DELAY = 1_000;
const LONGEST = 60_000;

/** The removals and gone workspaces of one store object (see the file's head). */
export class Removal {
	readonly #store: RemovalStore;
	readonly #live = Promise.withResolvers<Ctx<P3Principal>>();
	/** The removals and tellings running, by workspace, so none runs twice at once. */
	readonly #running = new Map<string, Promise<void>>();

	constructor(store: RemovalStore) {
		this.#store = store;
	}

	/**
	 * The store's routine while it is live (its `ctx` the store's own): resumes what was due, then waits; once the
	 * attempt ends, it ends after the work it started (the next attempt's resume never overlaps it).
	 */
	async serve(ctx: Ctx<P3Principal>): Promise<void> {
		this.#live.resolve(ctx);
		await this.resume();
		await untilAborted(ctx);
		await Promise.all(this.#running.values());
	}

	/** Every removal and telling due, started again: at the start, and whenever the kinds' hooks change. */
	async resume(): Promise<void> {
		const ctx = await this.#live.promise;
		const { removing, gone } = await this.#store.read(async (tx) => {
			const removing = [];
			const gone = [];
			// Whole tables: the removals and tellings due are few rows, read at the start and when the hooks change.
			for await (const row of tx.rows(this.#store.removing, query(Removing))) removing.push(row);
			for await (const row of tx.rows(this.#store.gone, query(Gone))) gone.push(row);
			return { removing, gone };
		}, ctx);
		for (const { workspace, pathText } of removing)
			this.#start(`remove ${workspace}`, () => this.#clear(workspace, pathText));
		for (const { workspace } of gone) this.tell(workspace);
	}

	/** The subtree of `workspace`, whose line a commit cut with its `Removing` row: cleared in the background. */
	removed(workspace: string, pathText: string): void {
		this.#start(`remove ${workspace}`, () => this.#clear(workspace, pathText));
	}

	/** `workspace` is gone and its `Gone` row written: every kind's `workspaceGone` runs (again, until all succeed). */
	tell(workspace: string): void {
		this.#start(`gone ${workspace}`, () => this.#tell(workspace));
	}

	/** Runs `work` under `key` unless it runs already. */
	#start(key: string, work: () => Promise<void>): void {
		if (this.#running.has(key)) return;
		const running = work().finally(() => this.#running.delete(key));
		this.#running.set(key, running);
	}

	/** Clears every workspace under `pathText`, one commit each, then `workspace` itself with its `Removing` row. */
	async #clear(workspace: string, pathText: string): Promise<void> {
		await this.#retried(`things: the removal of workspace ${workspace}`, async (ctx) => {
			const store = this.#store;
			for (;;) {
				const below = await store.read((tx) => store.under(tx, pathText), ctx);
				if (below === undefined) break;
				await store.clear(below, false, ctx);
				this.tell(below);
			}
			await store.clear(workspace, true, ctx);
			this.tell(workspace);
			return true;
		});
	}

	/** One telling of `workspace`: every kind's hook, then its row goes; whether all succeeded. */
	async #tell(workspace: string): Promise<void> {
		await this.#retried(`things: telling the kinds workspace ${workspace} is gone`, async (ctx) => {
			let all = true;
			for (const [kind, { value }] of this.#store.hooks()) {
				try {
					await value.workspaceGone?.(workspace, ctx);
				} catch (error) {
					all = false;
					reportError(`things: ${kind}'s workspaceGone for ${workspace}; tried again later`, error, ctx);
				}
			}
			if (!all) return false;
			await this.#store.read(async (tx) => {
				tx.delete(this.#store.gone, { workspace });
				return null;
			}, ctx);
			return true;
		});
	}

	/** Tries `once` until it answers true, with backoff; a throw is reported and tried again at the next start. */
	async #retried(what: string, once: (ctx: Ctx<P3Principal>) => Promise<boolean>): Promise<void> {
		const ctx = await this.#live.promise;
		try {
			for (let delay = FIRST_DELAY; !(await once(ctx)); delay = Math.min(delay * 2, LONGEST))
				await sleep(delay, ctx);
		} catch (error) {
			// The store's attempt ended (its context aborted the wait): the next one resumes from what is due.
			if (ctx.abortSignal?.aborted === true) return;
			reportError(`${what}; tried again at the next start`, error, ctx);
		}
	}
}
