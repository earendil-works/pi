// A session worker's bootstrap (the process a runner forks): everything that must exist before plugins can load. It
// makes the link to the server at once (it queues the server's frames until the host listens), waits for its start
// message, takes the session's lock (a socket, `<data directory>/locks/<hash>`, named by the runner: a previous
// worker of the session that still closes, as after a server's crash, finishes with the store first), opens the
// session's store, creates the host and connects it, serves `WorkerRuntime` and `WorkerBusy`, loads the shipped worker
// plugins and reports `ready`, then applies reloads. It makes its own directory and the data directory's `locks/`,
// private, and says `locked` once it holds the lock (a start that times out without it waited for a previous worker).
// `WorkerRuntime.close` (the runner's worker facet calls it once the worker idled) says `closed` (the runner counts the
// exit as clean), then closes its host and store (the store's close settles its queued commits) and exits 0. On
// `shutdown`, a disconnect, `SIGTERM` or `SIGINT` it closes its host and store and exits. Control messages travel
// beside the link's frames on the same IPC channel (`api/v1/control.ts`).

import { flushCompileCache } from "node:module";
import { dirname, join } from "node:path";
import { createHost, defineFacet, type Facet, type IpcPort, ipcLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createPluginRuntime, type PluginScript } from "@earendil-works/chord/plugins/runtime";
import * as v1 from "@earendil-works/p3/v1";
import { reportError, Session } from "@earendil-works/p3/v1";
import * as v1worker from "@earendil-works/p3/v1/worker";
import { WorkerBusy, WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { type FromWorker, type ToWorker, workerControl, workerMessage } from "./api/v1/control.ts";
import { type P3Principal, SERVER, workerPrincipal } from "./app.ts";
import { openPrivateStore, privateDirectory } from "./files.ts";
import { waitForSocket } from "./local-socket.ts";

/** How long a shutdown's closes get before the worker exits anyway. */
const FORCED_EXIT_MS = 3000;

/** The start message. */
type Start = Extract<ToWorker, { readonly kind: "start" }>;

// Only as the process's entry, forked by a runner: the test topology imports the base's facets from here.
if (import.meta.main && process.send !== undefined) runWorker(process as unknown as IpcPort);

/** Runs this process as a session worker on the IPC channel `port`. */
function runWorker(port: IpcPort): void {
	const parent = ipcLink(port);
	const runtime = createPluginRuntime();
	let started: WorkerRuntime | undefined;
	let stopping = false;
	/** Reloads apply one after another. */
	let reloading: Promise<void> = Promise.resolve();
	/** Sends `message` to the server; resolves once it was sent (at once when the channel is gone). */
	const sent = (message: FromWorker): Promise<void> =>
		new Promise((resolve) => {
			if (port.connected) process.send?.(workerMessage(message), undefined, undefined, () => resolve());
			else resolve();
		});
	/** Whether this is the first stop: nothing applies after it, and the worker exits within 3 s whatever happens. */
	const stopsNow = (): boolean => {
		if (stopping) return false;
		stopping = true;
		setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
		return true;
	};
	/** Closes its host and store, then exits 0. */
	const exit = async (): Promise<void> => {
		try {
			await started?.host.close(context);
			await started?.store.close(context);
		} finally {
			process.exit(0);
		}
	};
	/** Stops the worker (`shutdown`, a disconnect, a signal). */
	const shutdown = (): void => {
		if (stopsNow()) void exit();
	};
	/**
	 * The worker stops itself (`WorkerRuntime.close`): the server hears `closed` while the link still stands, then it
	 * exits; its store's close settles the queued commits before the exit.
	 */
	const leave = async (): Promise<void> => {
		if (!stopsNow()) return;
		await sent({ kind: "closed" });
		await exit();
	};
	const start = async (message: Start): Promise<void> => {
		await privateDirectory(message.dir);
		await privateDirectory(dirname(message.lock));
		// Held until this process exits. The wait is bounded by the runner's start timeout, which kills a worker not ready
		// and names the lock when it never said `locked`.
		await waitForSocket(message.lock, context);
		void sent({ kind: "locked" });
		started = await open(message, parent, () => void leave());
		const report = await runtime.load(
			started.host,
			{ kind: "worker", core: workerCoreFacets(started), scripts: message.scripts, modules: WORKER_MODULES },
			context,
		);
		// Node writes its compile cache only at exit otherwise: the next workers start from this one's, warm.
		flushCompileCache();
		void sent({ kind: "ready", failed: report.failed.map(({ plugin }) => plugin) });
	};
	const reload = (scripts: readonly PluginScript[]): void => {
		reloading = reloading.then(async () => {
			if (started === undefined || stopping) return;
			try {
				const report = await runtime.reload(started.host, scripts, context);
				void sent({ kind: "reloaded", failed: report.failed.map(({ plugin }) => plugin) });
			} catch (error) {
				void sent({ kind: "reload_failed", error: error instanceof Error ? error.message : String(error) });
			}
		});
	};
	port.on("message", (message) => {
		const control = workerControl<ToWorker>(message);
		if (control?.kind === "start") start(control).catch(fatal);
		else if (control?.kind === "reload") reload(control.scripts);
		else if (control?.kind === "shutdown") shutdown();
	});
	port.on("disconnect", shutdown);
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
}

/**
 * Opens the session's store (its lock is held) and host, connected to the server over `parent`; `close` is what
 * `WorkerRuntime.close` does.
 */
async function open(message: Start, parent: ReturnType<typeof ipcLink>, close: () => void): Promise<WorkerRuntime> {
	const store = await openPrivateStore(join(message.dir, "store.sqlite"), context);
	const host = createHost<P3Principal>({
		address: Session({ id: message.session }),
		principal: workerPrincipal(message.session),
		store,
		onError: (error) => reportError(`p3 worker ${message.session}`, error, context),
	});
	host.connect(parent, { principal: SERVER, trusted: true }, context);
	return { session: message.session, host, store, dir: message.dir, idleMs: message.idleMs, close };
}

/** An error nothing handles: printed (the server's log gets it), and the worker exits 1. */
function fatal(error: unknown): void {
	reportError("p3 worker: fatal", error, context);
	process.exit(1);
}

/**
 * The API's modules a session worker evaluates its plugins' worker facets with: this process's instances, by
 * specifier; never the server's module, which holds the HTTP stack.
 */
export const WORKER_MODULES = { "@earendil-works/p3/v1": v1, "@earendil-works/p3/v1/worker": v1worker };

/** The base's facets on a worker: `WorkerRuntime` (the process values) and `WorkerBusy` (the sum of the counts). */
export function workerCoreFacets(
	runtime: WorkerRuntime,
): { readonly name: string; readonly facet: Facet<P3Principal> }[] {
	const facet = defineFacet<P3Principal>((host) => {
		host.serve(WorkerRuntime, { compose: () => runtime });
		host.serve(WorkerBusy, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
	});
	return [{ name: "p3.worker", facet }];
}
