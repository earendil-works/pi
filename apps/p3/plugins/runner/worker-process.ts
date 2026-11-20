// One session worker as a forked process: forked as a detached process group (its tools' processes die with it), its
// IPC link made at the fork (it queues the worker's frames), the start message sent at once. It records what the
// worker reports (`ready`, `closed` when it stopped itself idle, `reloaded`), ships reloads one after another, stops it (`shutdown`, then the
// group killed after a grace), and resolves `gone` once its exit counts: after the commits its calls queued in the
// server's store settled (a worker that closed itself finished them already; a crashed one may not have), so nothing
// it reported lands after it.

import { type ChildProcess, fork } from "node:child_process";
import { type ChordStore, type IpcPort, ipcLink, type Link, type ReloadReport } from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost } from "@earendil-works/p3/v1/server";
import { type FromWorker, workerControl, workerMessage } from "@earendil-works/p3/v1/server";

/** How long a stopping worker gets before its process group is killed. */
const GRACE_MS = 5000;

/** How long a worker may take to be ready before it is killed. */
const START_MS = 60_000;

/** How a worker process starts. */
export type WorkerStart = {
	readonly session: string;
	readonly entry: string;
	readonly execArgv: readonly string[];
	/** Added to the server's environment (the compile cache's directory). */
	readonly env: Readonly<Record<string, string>>;
	/** The worker's private directory. */
	readonly dir: string;
	readonly idleMs: number;
	readonly scripts: readonly PluginScript[];
	/** The server's store: an exit counts once the commits queued in it settled. */
	readonly store: ChordStore;
};

/** How a worker's exit ended: asked (a stop, or the worker leaving idle), or a crash with its reason. */
export type Exit = { readonly kind: "clean" } | { readonly kind: "crash"; readonly reason: string };

/** A reload's outcome on this worker, as a rollout step lists it. */
export type Reloaded = Exclude<RolloutHost, { readonly kind: "stopped" }>;

/** One worker process of a session. */
export class WorkerProcess {
	readonly link: Link;
	/** Resolves once its exit counts. */
	readonly gone: Promise<Exit>;
	status: "starting" | "running" | "stopping" = "starting";
	/** The set of scripts it runs: its start's, or its last reload without failures. */
	shipped: string;
	readonly #process: ChildProcess;
	readonly #session: string;
	#reloaded: ((message: Extract<FromWorker, { readonly kind: "reloaded" | "reload_failed" }>) => void) | undefined;
	#reloading: Promise<unknown> = Promise.resolve();
	#grace: ReturnType<typeof setTimeout> | undefined;

	constructor(start: WorkerStart) {
		this.#session = start.session;
		this.shipped = keyOf(start.scripts);
		this.#process = fork(start.entry, [], {
			execArgv: [...start.execArgv],
			env: { ...process.env, ...start.env },
			detached: true,
			serialization: "advanced",
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		// A forked child is an IPC port.
		this.link = ipcLink(this.#process as unknown as IpcPort);
		const exited = Promise.withResolvers<Exit>();
		this.gone = exited.promise;
		const startTimer = setTimeout(() => this.#kill(), START_MS);
		this.#process.on("message", (message: unknown) => this.#control(workerControl<FromWorker>(message), startTimer));
		this.#process.once("exit", (code, signal) => {
			clearTimeout(startTimer);
			clearTimeout(this.#grace);
			this.#kill();
			this.#reloaded?.({ kind: "reload_failed", error: "worker: exited" });
			const exit: Exit =
				this.status === "stopping"
					? { kind: "clean" }
					: { kind: "crash", reason: `exited (${signal ?? `code ${code}`})` };
			void start.store.settled().then(() => exited.resolve(exit));
		});
		this.#process.once("error", (error) => {
			// A fork that failed has no pid and no `exit`.
			if (this.#process.pid === undefined)
				exited.resolve({ kind: "crash", reason: `fork failed: ${error.message}` });
		});
		const { session, dir, idleMs, scripts } = start;
		this.#process.send(workerMessage({ kind: "start", session, dir, idleMs, scripts }));
	}

	/** Its process id, `-1` before the fork gave one. */
	get pid(): number {
		return this.#process.pid ?? -1;
	}

	/** Asks it to shut down; kills its group after the grace. Resolves once its exit counts. */
	stop(): Promise<Exit> {
		if (this.status !== "stopping") {
			this.status = "stopping";
			if (this.#process.connected) this.#process.send(workerMessage({ kind: "shutdown" }), () => {});
			this.#grace = setTimeout(() => this.#kill(), GRACE_MS);
		}
		return this.gone;
	}

	/** Ships `scripts` after its outstanding reload: the report, or the error. */
	reload(host: string, scripts: readonly PluginScript[]): Promise<Reloaded> {
		const key = keyOf(scripts);
		const reload = this.#reloading.then(
			() =>
				new Promise<Reloaded>((resolve) => {
					this.#reloaded = (message) => {
						this.#reloaded = undefined;
						if (message.kind === "reload_failed")
							resolve({ kind: "failed", host, error: new Error(message.error) });
						else {
							if (message.failed.length === 0) this.shipped = key;
							resolve({ kind: "reloaded", host, report: reportOf(message.failed) });
						}
					};
					this.#process.send(workerMessage({ kind: "reload", scripts }), () => {});
				}),
		);
		this.#reloading = reload;
		return reload;
	}

	/** A control message from the worker. */
	#control(message: FromWorker | undefined, startTimer: ReturnType<typeof setTimeout>): void {
		if (message?.kind === "ready") {
			clearTimeout(startTimer);
			if (this.status === "starting") this.status = "running";
			if (message.failed.length > 0) console.error(`p3 runner: ${this.#session}: plugins failed:`, message.failed);
		} else if (message?.kind === "closed") this.status = "stopping";
		else if (message?.kind === "reloaded" || message?.kind === "reload_failed") this.#reloaded?.(message);
	}

	/** Kills its process group (its tools' processes too); the child alone when it has no group. */
	#kill(): void {
		const pid = this.#process.pid;
		if (pid === undefined) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			this.#process.kill("SIGKILL");
		}
	}
}

/** A set of scripts' identity: its plugins and digests. */
export function keyOf(scripts: readonly PluginScript[]): string {
	return scripts
		.map(({ plugin, built }) => `${plugin.name}@${built.kind === "script" ? built.digest : "failed"}`)
		.sort()
		.join("\n");
}

/** A worker's reload as a report: the plugins that failed there. */
function reportOf(failed: readonly string[]): ReloadReport {
	return {
		plugins: { added: [], changed: [], removed: [] },
		failed: failed.map((plugin) => ({ plugin, error: new Error(`${plugin}: failed on the worker`) })),
		objects: [],
	};
}
