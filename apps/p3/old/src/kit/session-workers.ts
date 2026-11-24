// Session workers on the server: every session's host runs as a forked process (Chord's workers component: one per
// address, started by its first hold the route admits, stopped when idle). What the start script decides of them, and
// what the server sends a worker at its start. The worker's side is `worker.ts`.

import type { Host, Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { Plugins } from "@earendil-works/chord/plugins";
import { createWorkers, type Workers, type WorkersError } from "@earendil-works/chord/workers";
import { Session } from "@earendil-works/p3/v1";
import { NAME, PRINCIPALS } from "../app.ts";
import type { P3Principal } from "../principals.ts";
import { mayReachSession, sessionExists } from "../session-route.ts";
import { type Layout, workerDirectory } from "./layout.ts";

/** How a session's worker starts: what the start script decides. */
export type WorkerOptions = {
	/**
	 * The worker's entry module (it calls `startWorker`), bundled with the base code it imports at start (every worker
	 * runs that snapshot until the server restarts), and its Node flags.
	 */
	readonly entry: string;
	readonly execArgv?: readonly string[];
};

/** What the server sends a worker at its start: its directory. */
export type WorkerStart = { readonly dir: string };

/** The facet kind a worker loads. */
export const WORKER_FACET = "worker";

/**
 * The workers component of sessions on `host` (its base built by `build`, into `cache/worker/`): the route's policy is
 * `session-route.ts`'s, each worker gets its directory under the data directory and acts as `PRINCIPALS.worker`.
 */
export function sessionWorkers(
	options: WorkerOptions,
	server: { readonly host: Host<P3Principal>; readonly store: Store; readonly plugins: Plugins },
	layout: Layout,
	onError: (error: WorkersError) => void,
	context: Context,
): Workers<typeof Session> {
	const { dataDir } = layout;
	return createWorkers(
		server.host,
		Session,
		{
			kind: WORKER_FACET,
			entry: options.entry,
			...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
			baseDir: layout.workerBase,
			compileCache: layout.compileCache,
			// The server's: a worker's exit is published after the commits its calls queued there.
			store: server.store,
			authorize: mayReachSession,
			admit: sessionExists,
			principal: PRINCIPALS.worker,
			start: (address): WorkerStart => ({ dir: workerDirectory(dataDir, address) }),
			lock: (address) => `${NAME}-worker:${dataDir}:${address.key}`,
			plugins: server.plugins,
			onError,
		},
		context,
	);
}
