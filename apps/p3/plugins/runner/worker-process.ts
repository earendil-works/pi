// One session worker as a forked process: forked as a detached process group (killed as one at its end; the tools'
// processes get groups of their own, which the worker kills itself, with the harness core, ERNDL-855), its IPC link made
// at the fork (it queues the worker's frames), the start message sent at once. It records what the worker reports
// (`locked` once it holds its session's lock, `ready`, `closed` when it stops itself idle, `reloaded`), ships reloads one
// after another once it is ready, stops it (`shutdown`, then the group killed after a grace), and resolves `gone` once
// its exit counts: its link closed first, then the commits its calls queued in the server's store settled (a worker that
// closed itself finished them already; a crashed one may not have), so nothing it reported lands after it.

import { type ChildProcess, type ForkOptions, fork, type SpawnOptions } from "node:child_process";
import {
	type ChordStore,
	type Context,
	type IpcPort,
	ipcLink,
	type Link,
	type ReloadReport,
	reportError,
} from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost, ToWorker } from "@earendil-works/p3/v1/server";
import { type FromWorker, workerControl, workerMessage } from "@earendil-works/p3/v1/server";

/** How a worker process starts. */
export type WorkerStart = {
	/** What the worker is sent first: its session, directory, lock, idle time and scripts. */
	readonly message: Extract<ToWorker, { readonly kind: "start" }>;
	readonly entry: string;
	readonly execArgv: readonly string[];
	/** Added to the server's environment (the compile cache's directory). */
	readonly env: Readonly<Record<string, string>>;
	/** How long it may take to be ready before it is killed. */
	readonly startMs: number;
	/** The server's store: an exit counts once the commits queued in it settled. */
	readonly store: ChordStore;
};

/** How a worker's exit ended: asked (a stop, or the worker leaving idle), or a crash with its reason. */
export type Exit = { readonly kind: "clean" } | { readonly kind: "crash"; readonly reason: string };

/** What settles a reload: the worker's answer, or its exit (a reload it never answers, or one queued after it). */
type ReloadReply = Extract<FromWorker, { readonly kind: "reloaded" | "reload_failed" }> | { readonly kind: "exited" };

/** How long a stopping worker gets before its process group is killed. */
const GRACE_MS = 5000;

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
	/** How many reloads are queued and not settled: with none, a reload of what it runs needs no turn. */
	#queued = 0;
	#reloaded: ((reply: ReloadReply) => void) | undefined;
	/** How it exited, once it did: a reload whose turn comes after settles with it. */
	#exit: Exit | undefined;
	/** Whether it said it holds its session's lock: a start that times out without it waited for a previous worker. */
	#locked = false;
	/** Why it was killed before it was ready (its start timed out). */
	#cause: string | undefined;
	readonly #startTimer: ReturnType<typeof setTimeout>;
	/** Armed by the first `stop`: once, whatever the worker announced before. */
	#grace: ReturnType<typeof setTimeout> | undefined;

	/** Forks the worker of `start`, in `context`'s work (the route's start). */
	constructor(start: WorkerStart, context: Context) {
		this.#session = start.message.session;
		this.#context = context;
		this.shipped = keyOf(start.message.scripts);
		// `fork` hands its options to `spawn`, which takes `windowsHide`; Node's types leave it out of `ForkOptions`.
		const options: ForkOptions & Pick<SpawnOptions, "windowsHide"> = {
			execArgv: [...start.execArgv],
			env: { ...process.env, ...start.env },
			detached: true,
			windowsHide: true,
			serialization: "advanced",
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		};
		this.#process = fork(start.entry, [], options);
		// A forked child is an IPC port.
		this.link = ipcLink(this.#process as unknown as IpcPort);
		const exited = Promise.withResolvers<Exit>();
		this.gone = exited.promise;
		this.#startTimer = setTimeout(() => {
			const within = `did not start within ${start.startMs / 1000} s`;
			this.#cause = this.#locked
				? within
				: `${within}: the session's previous worker still holds the session's lock (it has not exited)`;
			this.#kill();
		}, start.startMs);
		const ended = (exit: Exit): void => {
			clearTimeout(this.#startTimer);
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
		this.#process.on("message", (message: unknown) => this.#control(workerControl<FromWorker>(message)));
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
		this.#process.send(workerMessage(start.message));
	}

	/** Its process id, `-1` before the fork gave one. */
	get pid(): number {
		return this.#process.pid ?? -1;
	}

	/**
	 * Asks it to shut down and kills its group after the grace, armed once (also when it announced it leaves idle: one
	 * that then hangs is killed too); once it exited, nothing is left to stop. Resolves once its exit counts.
	 */
	stop(): Promise<Exit> {
		if (this.#exit !== undefined || this.#grace !== undefined) return this.gone;
		this.status = "stopping";
		if (this.#process.connected) this.#process.send(workerMessage({ kind: "shutdown" }), () => {});
		this.#grace = setTimeout(() => this.#kill(), GRACE_MS);
		return this.gone;
	}

	/**
	 * Ships `scripts` after its start and its outstanding reloads: the report, the error, or `stopped`/`failed` once it
	 * exited (a send to a child that is gone settles too); no result when it runs them already. That is decided at the
	 * reload's turn: a reload back to what it runs, behind one not answered yet, still ships.
	 */
	reload(scripts: readonly PluginScript[]): Promise<RolloutHost | undefined> {
		const key = keyOf(scripts);
		if (this.#queued === 0 && this.shipped === key) return Promise.resolve(undefined);
		this.#queued++;
		const reload = this.#reloading.then(() => this.#ship(scripts, key));
		this.#reloading = reload;
		return reload;
	}

	/** A reload's turn: sends `scripts` (identified by `key`) unless it exited or runs them already. */
	#ship(scripts: readonly PluginScript[], key: string): Promise<RolloutHost | undefined> {
		return new Promise((resolve) => {
			const settle = (entry: RolloutHost | undefined): void => {
				this.#reloaded = undefined;
				this.#queued--;
				resolve(entry);
			};
			if (this.#exit !== undefined) return settle(this.#entry({ kind: "exited" }, key));
			if (this.shipped === key) return settle(undefined);
			const answered = (reply: ReloadReply): void => settle(this.#entry(reply, key));
			this.#reloaded = answered;
			this.#process.send(workerMessage({ kind: "reload", scripts }), (error: Error | null) => {
				if (error !== null && this.#reloaded === answered)
					answered({ kind: "reload_failed", error: error.message });
			});
		});
	}

	/** A reload's result from `reply`; a reload without failures marks `key` shipped. */
	#entry(reply: ReloadReply, key: string): RolloutHost {
		const host = this.#session;
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
	#control(message: FromWorker | undefined): void {
		switch (message?.kind) {
			case "locked":
				this.#locked = true;
				return;
			case "ready":
				clearTimeout(this.#startTimer);
				if (this.status === "starting") this.status = "running";
				this.#started.resolve();
				if (message.failed.length > 0) {
					reportError(`p3 runner: ${this.#session}: plugins failed`, message.failed, this.#context);
				}
				return;
			case "closed":
				this.status = "stopping";
				return;
			case "reloaded":
			case "reload_failed":
				this.#reloaded?.(message);
		}
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
