// `startWorker`: a worker of p3, in its entry module. Chord's `workerMain` plus the kit's part: the worker's directory
// with its store, the host at the worker's address acting as `PRINCIPALS.worker`, connected to the server first, its
// plugins loaded with the kit's worker facet (`WorkerInfo`).

import { flushCompileCache } from "node:module";
import { join } from "node:path";
import { type Address, createHost, type Host, openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { workerMain } from "@earendil-works/chord/workers/child";
import type { Session } from "@earendil-works/p3/v1";
import { API, PRINCIPALS } from "../app.ts";
import type { P3Principal } from "../principals.ts";
import { workerInfoFacet } from "./info.ts";
import { privateDirectory, privateStore } from "./layout.ts";
import { WORKER_FACET, type WorkerStart } from "./session-workers.ts";

/** What the worker hands the code that runs its session: its store and its host. */
export type WorkerSession = { readonly store: Store; readonly host: Host<P3Principal> };

/**
 * Runs this process as a worker of p3: once the start message arrived, its host is up and its plugins loaded. Then
 * `session` runs on the worker's store and host, if given: a test and interim hook, only the memory test's worker entry
 * passes one. It is not the harness's shape: slice 3's harness becomes an object in the worker's core facet (design
 * §24: opened during the load, closed by Chord, resumed after it), and replaces this hook.
 */
export function startWorker(options: {
	/** The worker host's errors (`HostError`) and a failed start's. */
	readonly onError: (error: unknown) => void;
	readonly session?: (worker: WorkerSession, context: Context) => void;
}): void {
	workerMain(
		async ({ address: started, start, parent, plugins, onClose }, context) => {
			// The server's `sessionWorkers` forks workers of sessions only, each with a `WorkerStart`.
			const address = started as Address<typeof Session>;
			const { dir } = start as WorkerStart;
			const file = join(dir, "store.sqlite");
			await privateDirectory(dir);
			await privateStore(file);
			const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(file)), context);
			onClose((ctx) => store.close(ctx));
			const principal = PRINCIPALS.worker(address);
			const host = createHost<P3Principal>({ address, principal, store, onError: options.onError });
			onClose((ctx) => host.close(ctx));
			// First: the server sees the worker started, then the load runs.
			host.connect(parent, { principal: PRINCIPALS.server, trusted: true }, context);
			const core = [{ name: "p3.worker-info", facet: workerInfoFacet(address) }];
			await plugins.load(host, { kind: WORKER_FACET, core }, context);
			// Node writes its compile cache only at exit otherwise: the next workers start from this one's, warm.
			flushCompileCache();
			options.session?.({ store, host }, context);
			return {};
		},
		{
			hostPackages: API.modules,
			// Worker errors are public: a fixed message, never the error's own.
			redact: () => ({ message: "worker failed" }),
			onError: options.onError,
		},
	);
}
