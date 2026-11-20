// p3's API v1 for worker facets (`@earendil-works/p3/v1/worker`): the worker's process values (`WorkerRuntime`) and
// what keeps it alive (`WorkerBusy`), both served by the base.

import { type ChordStore, defineRegistry, type Host } from "@earendil-works/chord";
import type { P3Principal } from "../../app.ts";

/** A session worker's process values, for plugins: what only the base has. */
export type WorkerRuntime = {
	/** The session's id. */
	readonly session: string;
	readonly host: Host<P3Principal>;
	readonly store: ChordStore;
	/** The worker's private directory (its store lives in it). */
	readonly dir: string;
	/** How long the worker may idle before it stops itself (the runner's choice, from its start). */
	readonly idleMs: number;
	/**
	 * Stops the worker: it tells the server it leaves (a clean exit), closes its host and store (the store's close settles
	 * its queued commits), exits.
	 */
	close(): void;
};

/** The worker's process values (`WorkerRuntime`), served by the base. */
export const WorkerRuntime = defineRegistry<never, WorkerRuntime>("p3.worker-runtime", { version: 1 });

/**
 * Work that keeps the worker alive besides holds, calls and jobs: each plugin contributes a count, fixed or a
 * watchable (the harness: 1 while a run is active). The runner's worker facet stops the worker once every count and
 * its host's activity stayed 0 for its idle time. The composed value is the sum.
 */
export const WorkerBusy = defineRegistry<number, number>("p3.worker-busy", { version: 1 });
