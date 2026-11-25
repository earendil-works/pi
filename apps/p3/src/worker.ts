// A session worker's bootstrap (the process a runner forks): everything that must exist before plugins can load. It
// makes the link to the server at once (it queues the server's frames until the host listens), waits for its start
// message, opens the session's store, creates the host and connects it, serves `WorkerRuntime` and `WorkerBusy`, loads
// the shipped worker plugins and reports `ready`, then applies reloads. `WorkerRuntime.close` (the runner's worker facet
// calls it once the worker idled) closes its host and store, says `closed` once everything finished, and only then
// exits 0. On `shutdown`, a disconnect, `SIGTERM` or `SIGINT` it closes its host and store and exits. Control messages travel
// beside the link's frames on the same IPC channel (`api/v1/control.ts`).

import { access } from "node:fs/promises";
import { flushCompileCache } from "node:module";
import { join } from "node:path";
import { type ChordStore, createHost, type IpcPort, ipcLink, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createPluginRuntime, type PluginScript } from "@earendil-works/chord/plugins/runtime";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { Session } from "@earendil-works/p3/v1";
import { BACKUP_MARKER, type WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { type FromWorker, type ToWorker, workerControl, workerMessage } from "./api/v1/control.ts";
import { SERVER, workerPrincipal } from "./app.ts";
import { privateDirectory, privateStore } from "./files.ts";
import { WORKER_MODULES } from "./modules-worker.ts";
import type { P3Principal } from "./principals.ts";
import { workerCoreFacets } from "./worker-core.ts";

/** How long a shutdown's closes get before the worker exits anyway. */
const FORCED_EXIT_MS = 3000;

/** The start message. */
type Start = Extract<ToWorker, { readonly kind: "start" }>;

// Only when forked by a runner.
if (process.send !== undefined) runWorker(process as unknown as IpcPort);

/** Runs this process as a session worker on the IPC channel `port`. */
function runWorker(port: IpcPort): void {
	const parent = ipcLink(port);
	const runtime = createPluginRuntime();
	let started: WorkerRuntime | undefined;
	let stopping = false;
	/** Reloads apply one after another. */
	let reloading: Promise<void> = Promise.resolve();
	const send = (message: FromWorker): void => {
		if (port.connected) process.send?.(workerMessage(message), undefined, undefined, () => {});
	};
	/**
	 * Stops the worker, exiting 0 (forced after 3 s). With `told` (it stops itself): its store's queued commits settle
	 * first, then the server hears why while the link still stands, then the host and store close.
	 */
	const shutdown = async (told?: FromWorker): Promise<void> => {
		if (stopping) return;
		stopping = true;
		setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
		try {
			if (told !== undefined && started !== undefined) {
				await started.store.settled();
				await new Promise<void>((resolve) => {
					if (port.connected) process.send?.(workerMessage(told), undefined, undefined, () => resolve());
					else resolve();
				});
			}
			await started?.host.close(context);
			await started?.store.close(context);
		} finally {
			process.exit(0);
		}
	};
	const start = async (message: Start): Promise<void> => {
		started = await open(message, parent, (reason) => void shutdown({ kind: "closed", reason }));
		const report = await runtime.load(
			started.host,
			{ kind: "worker", core: workerCoreFacets(started), scripts: message.scripts, modules: WORKER_MODULES },
			context,
		);
		// Node writes its compile cache only at exit otherwise: the next workers start from this one's, warm.
		flushCompileCache();
		send({ kind: "ready", failed: report.failed.map(({ plugin }) => plugin) });
	};
	const reload = (scripts: readonly PluginScript[]): void => {
		reloading = reloading.then(async () => {
			if (started === undefined || stopping) return;
			try {
				const report = await runtime.reload(started.host, scripts, context);
				send({ kind: "reloaded", failed: report.failed.map(({ plugin }) => plugin) });
			} catch (error) {
				send({ kind: "reload_failed", error: error instanceof Error ? error.message : String(error) });
			}
		});
	};
	port.on("message", (message) => {
		const control = workerControl<ToWorker>(message);
		if (control?.kind === "start") start(control).catch(fatal);
		else if (control?.kind === "reload") reload(control.scripts);
		else if (control?.kind === "shutdown") void shutdown();
	});
	port.on("disconnect", () => void shutdown());
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void shutdown());
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
}

/** Opens the session's store and host, connected to the server over `parent`; `close` is what `WorkerRuntime.close` does. */
async function open(
	message: Start,
	parent: ReturnType<typeof ipcLink>,
	close: (reason: "idle") => void,
): Promise<WorkerRuntime> {
	await privateDirectory(message.dir);
	const file = join(message.dir, "store.sqlite");
	await privateStore(file);
	// Backup is on for this session (the backup plugin's marker): the store records an outbox, which the plugin
	// uploads. Without the marker the outbox is off, its pending commits dropped.
	const outbox = await access(join(message.dir, BACKUP_MARKER)).then(
		() => true,
		() => false,
	);
	// `openStore` makes the one kind of store there is.
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(file)), context, {
		outbox,
	})) as ChordStore;
	const host = createHost<P3Principal>({
		address: Session({ id: message.session }),
		principal: workerPrincipal(message.session),
		store,
		onError: (error) => console.error(`p3 worker ${message.session}:`, error),
	});
	host.connect(parent, { principal: SERVER, trusted: true }, context);
	return { session: message.session, host, store, dir: message.dir, idleMs: message.idleMs, close };
}

/** An error nothing handles: printed (the server's log gets it), and the worker exits 1. */
function fatal(error: unknown): void {
	console.error("p3 worker: fatal:", error);
	process.exit(1);
}
