// One session worker as a forked process: forked as a detached process group (killed as one at its end; the tools'
// processes get groups of their own, which the worker kills itself, with the harness core, ERNDL-855), its IPC link made
// at the fork (it queues the worker's frames), the start message sent at once. It records what the worker reports
// (`ready`, `closed` when it stopped itself idle, `reloaded`), ships reloads one after another once it is ready, stops
// it (`shutdown`, then the group killed after a grace), and resolves `gone` once its exit counts: its link closed
// first, then the commits its calls queued in the server's store settled (a worker that closed itself finished them
// already; a crashed one may not have), so nothing it reported lands after it.

import { type ChildProcess, fork } from "node:child_process";
import {
	type ChordStore,
	type Context,
	type IpcPort,
	ipcLink,
	type Link,
	type ReloadReport,
	reportError,
} from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost } from "@earendil-works/p3/v1/server";
import { type FromWorker, workerControl, workerMessage } from "@earendil-works/p3/v1/server";

/** How long a stopping worker gets before its process group is killed. */
const GRACE_MS = 5000;

/** How a worker process starts. */
export type WorkerStart = {
	readonly session: string;
	readonly entry: string;
	readonly execArgv: readonly string[];
	/** Added to the server's environment (the compile cache's directory). */
	readonly env: Readonly<Record<string, string>>;
	/** The worker's private directory. */
	readonly dir: string;
	/** The session's lock socket, which the worker takes before it opens its store. */
	readonly lock: string;
	readonly idleMs: number;
	readonly scripts: readonly PluginScript[];
	/** How long it may take to be ready before it is killed. */
	readonly startMs: number;
	/** The server's store: an exit counts once the commits queued in it settled. */
	readonly store: ChordStore;
};

/** How a worker's exit ended: asked (a stop, or the worker leaving idle), or a crash with its reason. */
export type Exit = { readonly kind: "clean" } | { readonly kind: "crash"; readonly reason: string };

/** What settles a reload: the worker's answer, or its exit (a reload it never answers, or one queued after it). */
type ReloadReply = Extract<FromWorker, { readonly kind: "reloaded" | "reload_failed" }> | { readonly kind: "exited" };

/** A worker process of a session. */
export class WorkerProcess {
	readonly link: Link;
	/** Resolves once its exit counts. */
	readonly gone: Promise<Exit>;
	status: "starting" | "running" | "stopping" = "starting";
	/** The set of scripts it runs: its start's, or its last reload without failures. */
	shipped: string;
	readonly #process: ChildProcess;
	readonly #session: string;
	/** The start's context: what the worker reports later is reported in it. */
	readonly #context: Context;
	/** Settles once it is ready or exited: the worker takes reloads only after its start. */
	readonly #started = Promise.withResolvers<void>();
	/** Its reloads, one after another, the first after its start. */
	#reloading: Promise<unknown> = this.#started.promise;
	#reloaded: ((reply: ReloadReply) => void) | undefined;
	/** How it exited, once it did: a reload whose turn comes after settles with it. */
	#exit: Exit | undefined;
	/** Why it was killed before it was ready (its start timed out). */
	#cause: string | undefined;
	#grace: ReturnType<typeof setTimeout> | undefined;

	/** Forks the worker of `start`, in `context`'s work (the route's start). */
	constructor(start: WorkerStart, context: Context) {
		this.#session = start.session;
		this.#context = context;
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
		const startTimer = setTimeout(() => {
			this.#cause = `did not start within ${start.startMs / 1000} s`;
			this.#kill();
		}, start.startMs);
		const ended = (exit: Exit): void => {
			clearTimeout(startTimer);
			clearTimeout(this.#grace);
			this.#kill();
			// Before its exit counts: what the channel still holds is never handled, and the calls it made are aborted (the
			// channel closes by itself only later, on its own event), so no commit is queued after the store settled.
			this.link.close();
			this.#exit = exit;
			this.#started.resolve();
			this.#reloaded?.({ kind: "exited" });
			void start.store.settled().then(() => exited.resolve(exit));
		};
		this.#process.on("message", (message: unknown) => this.#control(workerControl<FromWorker>(message), startTimer));
		this.#process.once("exit", (code, signal) =>
			ended(
				this.status === "stopping"
					? { kind: "clean" }
					: { kind: "crash", reason: this.#cause ?? `exited (${signal ?? `code ${code}`})` },
			),
		);
		this.#process.once("error", (error) => {
			// A fork that failed has no pid and no `exit`.
			if (this.#process.pid === undefined) ended({ kind: "crash", reason: `fork failed: ${error.message}` });
		});
		const { session, dir, lock, idleMs, scripts } = start;
		this.#process.send(workerMessage({ kind: "start", session, dir, lock, idleMs, scripts }));
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

	/**
	 * Ships `scripts` after its start and its outstanding reload: the report, the error, or `stopped`/`failed` once it
	 * exited (a send to a child that is gone settles too).
	 */
	reload(host: string, scripts: readonly PluginScript[]): Promise<RolloutHost> {
		const key = keyOf(scripts);
		const reload = this.#reloading.then(
			() =>
				new Promise<RolloutHost>((resolve) => {
					const settle = (reply: ReloadReply): void => {
						this.#reloaded = undefined;
						resolve(this.#entry(host, reply, key));
					};
					if (this.#exit !== undefined) return settle({ kind: "exited" });
					this.#reloaded = settle;
					this.#process.send(workerMessage({ kind: "reload", scripts }), (error: Error | null) => {
						if (error !== null && this.#reloaded === settle)
							settle({ kind: "reload_failed", error: error.message });
					});
				}),
		);
		this.#reloading = reload;
		return reload;
	}

	/** A reload's result on `host` from `reply`; a reload without failures marks `key` shipped. */
	#entry(host: string, reply: ReloadReply, key: string): RolloutHost {
		switch (reply.kind) {
			case "reloaded":
				if (reply.failed.length === 0) this.shipped = key;
				return { kind: "reloaded", host, report: reportOf(reply.failed) };
			case "reload_failed":
				return { kind: "failed", host, error: new Error(reply.error) };
			case "exited":
				return this.#exit?.kind === "crash"
					? { kind: "failed", host, error: new Error(`worker: ${this.#exit.reason}`) }
					: { kind: "stopped", host };
		}
	}

	/** A control message from the worker. */
	#control(message: FromWorker | undefined, startTimer: ReturnType<typeof setTimeout>): void {
		if (message?.kind === "ready") {
			clearTimeout(startTimer);
			if (this.status === "starting") this.status = "running";
			this.#started.resolve();
			if (message.failed.length > 0) {
				reportError(`p3 runner: ${this.#session}: plugins failed`, message.failed, this.#context);
			}
		} else if (message?.kind === "closed") this.status = "stopping";
		else if (message?.kind === "reloaded" || message?.kind === "reload_failed") this.#reloaded?.(message);
	}

	/** Kills its process group; the child alone when it has no group. */
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
