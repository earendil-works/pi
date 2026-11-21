// One session worker as a forked process: a process group of its own (killed as one at its end; the tools' processes
// get groups of their own, which the worker kills itself, with the harness core, ERNDL-855), its IPC link made at the
// fork. It ships reloads one after another once the worker is ready, knows per plugin which script the worker runs, and
// counts its exit only once its link closed and the commits its calls queued in the server's store settled, so nothing
// it reported lands after it.

import { type ChildProcess, type ForkOptions, fork, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { type Context, type IpcPort, ipcLink, type Link, type ReloadReport, reportError } from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost, ServerRuntime, ToWorker } from "@earendil-works/p3/v1/server";
import { type FromWorker, workerControl, workerMessage } from "@earendil-works/p3/v1/server";

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
	readonly #process: ChildProcess;
	readonly #session: string;
	/** The start's context: what the worker reports later is reported in it. */
	readonly #context: Context;
	/**
	 * The script each plugin runs as, by its digest (Chord keeps a failed plugin's loaded facet; one that never loaded
	 * has none); `undefined` once unknown (a reload that threw), so every reload ships.
	 */
	#runs: Map<string, string> | undefined;
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

	/**
	 * Forks the worker `start` describes on `runtime`'s server, in `context`'s work (the route's start); one not ready
	 * within `startMs` is killed.
	 */
	constructor(
		runtime: ServerRuntime,
		start: Extract<ToWorker, { readonly kind: "start" }>,
		startMs: number,
		context: Context,
	) {
		this.#session = start.session;
		this.#context = context;
		// What failed at the start is told by `ready`; a failed build runs nothing (nothing ran before).
		this.#runs = runsOf(start.scripts, [], new Map());
		// `fork` hands its options to `spawn`, which takes `windowsHide`; Node's types leave it out of `ForkOptions`.
		const options: ForkOptions & Pick<SpawnOptions, "windowsHide"> = {
			execArgv: [...runtime.worker.execArgv],
			env: { ...process.env, NODE_COMPILE_CACHE: join(runtime.dataDir, "cache", "node") },
			detached: true,
			windowsHide: true,
			serialization: "advanced",
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		};
		this.#process = fork(runtime.worker.entry, [], options);
		// A forked child is an IPC port.
		this.link = ipcLink(this.#process as unknown as IpcPort);
		const exited = Promise.withResolvers<Exit>();
		this.gone = exited.promise;
		this.#startTimer = setTimeout(() => {
			const within = `did not start within ${startMs / 1000} s`;
			this.#cause = this.#locked
				? within
				: `${within}: the session's previous worker still holds the session's lock (it has not exited)`;
			this.#kill();
		}, startMs);
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
			void runtime.store.settled().then(() => exited.resolve(exit));
		};
		this.#process.on("message", (message: unknown) => this.#control(workerControl<FromWorker>(message)));
		this.#process.once("exit", (code, signal) => ended(this.#exitOf(code, signal)));
		this.#process.once("error", (error) => {
			// A fork that failed has no pid and no `exit`.
			if (this.#process.pid === undefined) ended({ kind: "crash", reason: `fork failed: ${error.message}` });
		});
		this.#process.send(workerMessage(start));
	}

	/** Its process id, `-1` before the fork gave one. */
	get pid(): number {
		return this.#process.pid ?? -1;
	}

	/** Whether its process lives: forked and not exited (its exit may not count yet). */
	get alive(): boolean {
		return this.#process.pid !== undefined && this.#exit === undefined;
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
	 * exited (a send to a child that is gone settles too); no result when nothing is queued and it runs them already. A
	 * reload back to what it runs, behind one not answered yet, still ships.
	 */
	reload(scripts: readonly PluginScript[]): Promise<RolloutHost | undefined> {
		if (this.#queued === 0 && this.#runsAll(scripts)) return Promise.resolve(undefined);
		this.#queued++;
		const reload = this.#reloading.then(() => this.#ship(scripts));
		this.#reloading = reload;
		return reload;
	}

	/** How its process's exit with `code` or `signal` counts. */
	#exitOf(code: number | null, signal: NodeJS.Signals | null): Exit {
		// Asked to stop (or leaving idle) and gone by itself with 0, or killed after the grace. A non-zero code is its own
		// close failing: its store may not have settled.
		if (this.status === "stopping" && (code === 0 || signal !== null)) return { kind: "clean" };
		return { kind: "crash", reason: this.#cause ?? `exited (${signal ?? `code ${code}`})` };
	}

	/** Whether it runs exactly `scripts`: every plugin at its digest, no other plugin. */
	#runsAll(scripts: readonly PluginScript[]): boolean {
		const runs = this.#runs;
		return (
			runs !== undefined &&
			runs.size === scripts.length &&
			scripts.every(({ plugin, built }) => built.kind === "script" && runs.get(plugin.name) === built.digest)
		);
	}

	/** A reload's turn: sends `scripts` unless it exited. */
	#ship(scripts: readonly PluginScript[]): Promise<RolloutHost | undefined> {
		return new Promise((resolve) => {
			const settle = (entry: RolloutHost | undefined): void => {
				this.#reloaded = undefined;
				this.#queued--;
				resolve(entry);
			};
			if (this.#exit !== undefined) return settle(this.#entry({ kind: "exited" }, scripts));
			const answered = (reply: ReloadReply): void => settle(this.#entry(reply, scripts));
			this.#reloaded = answered;
			this.#process.send(workerMessage({ kind: "reload", scripts }), (error: Error | null) => {
				if (error !== null && this.#reloaded === answered)
					answered({ kind: "reload_failed", error: error.message });
			});
		});
	}

	/** A reload's result from `reply`, and what the worker runs after it. */
	#entry(reply: ReloadReply, scripts: readonly PluginScript[]): RolloutHost {
		const host = this.#session;
		switch (reply.kind) {
			case "reloaded":
				this.#runs = runsOf(scripts, reply.failed, this.#runs);
				return { kind: "reloaded", host, report: reportOf(reply.failed) };
			case "reload_failed":
				this.#runs = undefined;
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
				// A plugin that failed at the start runs nothing.
				for (const plugin of message.failed) this.#runs?.delete(plugin);
				this.#started.resolve();
				if (message.failed.length > 0) {
					reportError(`p3 runner: ${this.#session}: plugins failed`, message.failed, this.#context);
				}
				return;
			case "closed":
				// It leaves idle: one that then hangs is killed after the grace, or its session's next start would wait.
				void this.stop();
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

/**
 * What a worker runs after it loaded `scripts` with `failed` failing: the new digest of each plugin that loaded, for a
 * failed one what it ran before (`before`, Chord keeps its loaded facet), none for one never loaded. `undefined` when a
 * failed plugin's script was unknown.
 */
function runsOf(
	scripts: readonly PluginScript[],
	failed: readonly string[],
	before: ReadonlyMap<string, string> | undefined,
): Map<string, string> | undefined {
	const runs = new Map<string, string>();
	for (const { plugin, built } of scripts) {
		const failing = failed.includes(plugin.name) || built.kind !== "script";
		if (failing && before === undefined) return undefined;
		const digest = failing ? before?.get(plugin.name) : built.digest;
		if (digest !== undefined) runs.set(plugin.name, digest);
	}
	return runs;
}

/** A worker's reload as a report: the plugins that failed there. */
function reportOf(failed: readonly string[]): ReloadReport {
	return {
		plugins: { added: [], changed: [], removed: [] },
		failed: failed.map((plugin) => ({ plugin, error: new Error(`${plugin}: failed on the worker`) })),
		objects: [],
	};
}
