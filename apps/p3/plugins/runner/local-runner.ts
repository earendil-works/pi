// The local runner: each session's worker as a process on this machine (`worker-process.ts`). Per session one
// operation at a time: a start waits for the previous worker's exit. A worker that crashes fails its session until
// `retry` or a rollout (no restart loop); one that stopped itself idle starts again on the next hold, one that was
// stopped (`stop` suspends its session) once `retry` ends the suspension. The rollout step ships changed scripts to
// every running or starting worker and clears the failures. `close` (its plugin's object ends) refuses new starts and
// stops every worker after what its session queued.

import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Context, type Link, reportError, Session, untilAborted } from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost, ServerRuntime, WorkerRunner, WorkerState } from "@earendil-works/p3/v1/server";
import { keyOf, WorkerProcess } from "./worker-process.ts";

/**
 * One session's operations, one at a time (`tail`, and how many are `pending`), its worker process and its failure;
 * kept only while it has one of them.
 */
type WorkerQueue = {
	readonly id: string;
	tail: Promise<void>;
	pending: number;
	worker: WorkerProcess | undefined;
	failed: string | undefined;
};

/** How long a worker may take to be ready before it is killed, by default. */
const START_MS = 60_000;

/** What a local runner takes besides its runtime. */
export type LocalRunnerOptions = {
	/** How long a worker may take to be ready before it is killed: 60 s by default. */
	readonly startMs?: number;
};

/**
 * The local runner over `runtime` (read at each use: a reload of the base never happens, a plugin's may), with
 * `options`.
 */
export class LocalRunner implements WorkerRunner {
	readonly #runtime: () => ServerRuntime;
	readonly #startMs: number;
	readonly #workers = new Map<string, WorkerQueue>();
	/** Set once `close` started: nothing forks after it. */
	#closing = false;

	constructor(runtime: () => ServerRuntime, options: LocalRunnerOptions = {}) {
		this.#runtime = runtime;
		this.#startMs = options.startMs ?? START_MS;
	}

	start(address: { readonly params: { readonly id: string } }, context: Context): Promise<Link> {
		if (this.#closing) return Promise.reject(closed());
		const { id } = address.params;
		const queue = this.#queueOf(id);
		return this.#enqueue(queue, async () => {
			if (queue.worker !== undefined) await queue.worker.gone;
			if (queue.failed !== undefined) throw new Error(`p3: session ${id}: worker ${queue.failed}`);
			const runtime = this.#runtime();
			const scripts = await runtime.workerScripts(context);
			const lock = await lockOf(runtime.dataDir, id);
			// After the last wait, in the step that forks: a close that started meanwhile found no worker to stop.
			if (this.#closing) throw closed();
			const worker = new WorkerProcess(
				{
					session: id,
					entry: runtime.worker.entry,
					execArgv: runtime.worker.execArgv,
					env: { NODE_COMPILE_CACHE: join(runtime.dataDir, "cache", "node") },
					dir: join(runtime.dataDir, "workers", id),
					lock,
					idleMs: runtime.workerIdleMs,
					scripts,
					startMs: this.#startMs,
					store: runtime.store,
				},
				context,
			);
			queue.worker = worker;
			void worker.gone.then((exit) => {
				if (queue.worker === worker) queue.worker = undefined;
				if (exit.kind === "crash") {
					queue.failed = exit.reason;
					reportError(`p3 runner: ${id}: worker`, exit.reason, context);
				}
				this.#forget(queue);
			});
			return worker.link;
		});
	}

	async stop(id: string): Promise<void> {
		// A held session's route would start it again once its link drops: suspended until `retry` or its last release.
		this.#runtime().sessions.suspend(Session({ id }));
		const queue = this.#workers.get(id);
		if (queue === undefined) return;
		await this.#enqueue(queue, () => this.#stopWorker(queue));
	}

	retry(id: string): void {
		const queue = this.#workers.get(id);
		if (queue !== undefined) {
			queue.failed = undefined;
			this.#forget(queue);
		}
		this.#runtime().sessions.retry(Session({ id }));
	}

	state(): Readonly<Record<string, WorkerState>> {
		const state: Record<string, WorkerState> = {};
		for (const [id, { worker, failed }] of this.#workers) {
			if (failed !== undefined) state[id] = { status: "failed", reason: failed };
			else if (worker !== undefined) state[id] = { status: worker.status, pid: worker.pid };
		}
		return state;
	}

	async reload(_built: unknown, context: Context) {
		// A rollout clears the failures: the new scripts may be the fix.
		for (const [id, queue] of this.#workers) if (queue.failed !== undefined) this.retry(id);
		const scripts = await this.#runtime().workerScripts(context);
		return { hosts: await Promise.all(this.#reloads(scripts, context)) };
	}

	/** Refuses new starts, then stops every worker after its session's queued operations (a start then forks nothing). */
	async close(): Promise<void> {
		this.#closing = true;
		await Promise.all(
			[...this.#workers.values()].map((queue) => this.#enqueue(queue, () => this.#stopWorker(queue))),
		);
	}

	/** Stops `queue`'s worker, if one runs; resolves once its exit counted. */
	async #stopWorker(queue: WorkerQueue): Promise<void> {
		await queue.worker?.stop();
	}

	/**
	 * Ships `scripts` to every worker that runs another set, a starting one too (it forked with an older set; it gets
	 * them once ready): one result each, bounded by `context`.
	 */
	#reloads(scripts: readonly PluginScript[], context: Context): Promise<RolloutHost>[] {
		const key = keyOf(scripts);
		const entries: Promise<RolloutHost>[] = [];
		for (const [id, { worker }] of this.#workers) {
			if (worker === undefined || worker.status === "stopping" || worker.shipped === key) continue;
			entries.push(bounded(id, worker.reload(id, scripts), context));
		}
		return entries;
	}

	/** Session `id`'s worker queue, made by its first use. */
	#queueOf(id: string): WorkerQueue {
		let queue = this.#workers.get(id);
		if (queue === undefined) {
			queue = { id, tail: Promise.resolve(), pending: 0, worker: undefined, failed: undefined };
			this.#workers.set(id, queue);
		}
		return queue;
	}

	/** Runs `operation` after the session's earlier ones; the tail keeps only that it ended, never its value. */
	#enqueue<T>(queue: WorkerQueue, operation: () => Promise<T>): Promise<T> {
		queue.pending++;
		const run = queue.tail.then(operation);
		const done = (): void => {
			queue.pending--;
			this.#forget(queue);
		};
		queue.tail = run.then(done, done);
		return run;
	}

	/** Forgets `queue` once it has no operation, no worker and no failure. */
	#forget(queue: WorkerQueue): void {
		if (queue.pending > 0 || queue.worker !== undefined || queue.failed !== undefined) return;
		if (this.#workers.get(queue.id) === queue) this.#workers.delete(queue.id);
	}
}

/** What a start rejects with once the runner closes. */
function closed(): Error {
	return new Error("p3: the runner closed");
}

/**
 * Session `id`'s lock socket, in the data directory's private `locks/` (made here; the worker only listens): named by
 * a hash of the id, since a socket path holds at most 104 bytes and `workers/<id>/` may not fit one.
 */
async function lockOf(dataDir: string, id: string): Promise<string> {
	const locks = join(dataDir, "locks");
	await mkdir(locks, { recursive: true, mode: 0o700 });
	// `mode` applies only to a directory it creates.
	await chmod(locks, 0o700);
	return join(locks, createHash("sha256").update(id).digest("hex").slice(0, 16));
}

/** `entry`, or `host` failed with the reason once `context` is aborted first. */
function bounded(host: string, entry: Promise<RolloutHost>, context: Context): Promise<RolloutHost> {
	const aborted = untilAborted(context).then(
		(): RolloutHost => ({ kind: "failed", host, error: context.abortSignal?.reason }),
	);
	return Promise.race([entry, aborted]);
}
