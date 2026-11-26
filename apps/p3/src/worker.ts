// A session worker's bootstrap (the process a runner forks): everything that must exist before plugins can load. It
// takes the session's lock (Chord's `processLock`, named by the runner) before it opens the session's store, so a
// previous worker that still closes it (after a server's crash) finishes first, and says `locked`; then it connects its
// host, serves `WorkerRuntime` and `WorkerBusy`, loads the shipped plugins, says `ready` and applies reloads. It stops on
// `WorkerRuntime.close` (saying `closed` first: a clean exit), `shutdown`, a disconnect or a signal: it closes its host,
// then its store (which settles the queued commits), and exits 0, non-zero when a close failed or did not finish in 3 s.
// Control messages travel beside the link's frames on the same IPC channel (`api/v1/control.ts`).

import { flushCompileCache } from "node:module";
import { join } from "node:path";
import { createHost, defineFacet, type Facet, type IpcPort, ipcLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createPluginRuntime, type PluginScript } from "@earendil-works/chord/plugins/runtime";
import { processLock } from "@earendil-works/chord/workers/child";
import * as v1 from "@earendil-works/p3/v1";
import { reportError, Session } from "@earendil-works/p3/v1";
import * as v1worker from "@earendil-works/p3/v1/worker";
import { WorkerBusy, WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { type FromWorker, type ToWorker, workerControl, workerMessage } from "./api/v1/control.ts";
import { type P3Principal, SERVER, workerPrincipal } from "./app.ts";
import { openPrivateStore, privateDirectory } from "./files.ts";

/** How long a shutdown's closes get before the worker exits anyway. */
const FORCED_EXIT_MS = 3000;

/** The start message. */
type Start = Extract<ToWorker, { readonly kind: "start" }>;

// Only as the process's entry, forked by a runner: the test topology imports the base's facets from here.
if (import.meta.main && process.send !== undefined) runWorker();

/** Runs this process as a session worker on its IPC channel. */
function runWorker(): void {
	// A forked process is an IPC port.
	const parent = ipcLink(process as unknown as IpcPort);
	const runtime = createPluginRuntime();
	let started: WorkerRuntime | undefined;
	let stopping = false;
	/** Sends `message` to the server; resolves once it was sent (at once when the channel is gone). */
	const sent = (message: FromWorker): Promise<void> =>
		new Promise((resolve) => {
			if (process.connected) process.send?.(workerMessage(message), undefined, undefined, () => resolve());
			else resolve();
		});
	/** Whether this is the first stop: nothing applies after it, and the worker exits within 3 s whatever happens. */
	const stopsNow = (): boolean => {
		if (stopping) return false;
		stopping = true;
		setTimeout(() => {
			reportError("p3 worker", new Error(`its close did not finish within ${FORCED_EXIT_MS / 1000} s`), context);
			process.exit(1);
		}, FORCED_EXIT_MS).unref();
		return true;
	};
	/** Closes its host, then its store, each also when the other failed; exits 0, or 1 when one failed. */
	const exit = async (): Promise<void> => {
		const failed: unknown[] = [];
		for (const close of [() => started?.host.close(context), () => started?.store.close(context)]) {
			try {
				await close();
			} catch (error) {
				failed.push(error);
			}
		}
		if (failed.length > 0) reportError("p3 worker: its close failed", failed, context);
		process.exit(failed.length === 0 ? 0 : 1);
	};
	/** Stops the worker (`shutdown`, a disconnect, a signal). */
	const shutdown = (): void => {
		if (stopsNow()) void exit();
	};
	/** The worker stops itself (`WorkerRuntime.close`): the server hears `closed` while the link still stands. */
	const leave = async (): Promise<void> => {
		if (!stopsNow()) return;
		await sent({ kind: "closed" });
		await exit();
	};
	const start = async (message: Start): Promise<void> => {
		await privateDirectory(message.dir);
		// Held until this process exits. The wait is bounded by the runner's start timeout, which kills a worker not ready
		// and names the lock when it never said `locked`.
		await processLock(message.lock, context);
		void sent({ kind: "locked" });
		started = await open(message, parent, () => void leave());
		const report = await runtime.load(
			started.host,
			{
				kind: "worker",
				core: [{ name: "p3.worker", facet: workerCoreFacet(started) }],
				scripts: message.scripts,
				modules: WORKER_MODULES,
			},
			context,
		);
		// Node writes its compile cache only at exit otherwise: the next workers start from this one's, warm.
		flushCompileCache();
		void sent({ kind: "ready", failed: report.failed.map(({ plugin }) => plugin) });
	};
	// The runner sends a reload only once the previous one was answered, and the plugin runtime queues a host's reloads.
	const reload = async (scripts: readonly PluginScript[]): Promise<void> => {
		if (started === undefined || stopping) return;
		try {
			const report = await runtime.reload(started.host, scripts, context);
			void sent({ kind: "reloaded", failed: report.failed.map(({ plugin }) => plugin) });
		} catch (error) {
			void sent({ kind: "reload_failed", error: error instanceof Error ? error.message : String(error) });
		}
	};
	process.on("message", (message) => {
		const control = workerControl<ToWorker>(message);
		if (control?.kind === "start") start(control).catch(fatal);
		else if (control?.kind === "reload") void reload(control.scripts);
		else if (control?.kind === "shutdown") shutdown();
	});
	process.on("disconnect", shutdown);
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
}

/**
 * Opens the session's store (its lock is held) and host, connected to the server over `parent`; `close` is what
 * `WorkerRuntime.close` does.
 */
async function open(message: Start, parent: ReturnType<typeof ipcLink>, close: () => void): Promise<WorkerRuntime> {
	// The store's outbox keeps its persisted setting: the backup plugin switches it (`store.setOutbox`) as backup is
	// turned on or off for the session.
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

/** The base's facet on a worker: it serves `WorkerRuntime` (the process values) and `WorkerBusy` (the counts' sum). */
export function workerCoreFacet(runtime: WorkerRuntime): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) => {
		host.serve(WorkerRuntime, { compose: () => runtime });
		host.serve(WorkerBusy, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
	});
}
