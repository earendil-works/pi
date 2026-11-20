// The local runner: each session's worker as a process on this machine (`worker-process.ts`). Per session one
// operation at a time: a start waits for the previous worker's exit. A worker that crashes fails its session until
// `retry` or a rollout (no restart loop); one that stopped itself idle starts again on the next hold, one that was
// stopped (`stop` suspends its session) once `retry` ends the suspension. The rollout step ships changed scripts to
// every running or starting worker, a start that has not forked yet included, and clears the failures. `close` (its
// plugin's object ends) refuses new starts, forks nothing for a start under way and stops every worker at once, not
// after what its session queued: a start queued behind the exit of a worker that no longer answers would otherwise
// wait for that exit forever.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Address, type Context, type Link, reportError, Session, untilAborted } from "@earendil-works/p3/v1";
import type { PluginScript, RolloutHost, ServerRuntime, WorkerRunner, WorkerState } from "@earendil-works/p3/v1/server";
import { WorkerProcess } from "./worker-process.ts";

/**
 * One session's operations, one at a time (`tail`, and how many are `pending`), its worker process, the start under
 * way that has not forked yet (`forking`: its worker, `undefined` when it forked none) and its failure; kept only while
 * it has one of them.
 */
type WorkerQueue = {
	readonly id: string;
	tail: Promise<void>;
	pending: number;
	worker: WorkerProcess | undefined;
	forking: Promise<WorkerProcess | undefined> | undefined;
	failed: string | undefined;
};

/** How long a worker may take to be ready before it is killed, by default. */
const START_MS = 60_000;

/**
 * The local runner over `runtime` (read at each use: a reload of the base never happens, a plugin's may); a worker
 * not ready within `startMs` is killed.
 */
export class LocalRunner implements WorkerRunner {
	readonly #runtime: () => ServerRuntime;
	readonly #startMs: number;
	readonly #queues = new Map<string, WorkerQueue>();
	/** Set once `close` started: nothing forks after it. */
	#closing = false;

	constructor(runtime: () => ServerRuntime, startMs = START_MS) {
		this.#runtime = runtime;
		this.#startMs = startMs;
	}

	start(address: Address<typeof Session>, context: Context): Promise<Link> {
		if (this.#closing) return Promise.reject(closed());
		const { id } = address.params;
		const queue = this.#queueOf(id);
		return this.#enqueue(queue, async () => {
			if (queue.worker !== undefined) await queue.worker.gone;
			if (this.#closing) throw closed();
			if (queue.failed !== undefined) throw new Error(`p3: session ${id}: worker ${queue.failed}`);
			const forked = Promise.withResolvers<WorkerProcess | undefined>();
			queue.forking = forked.promise;
			try {
				const worker = await this.#fork(queue, context);
				forked.resolve(worker);
				return worker.link;
			} catch (error) {
				forked.resolve(undefined);
				throw error;
			} finally {
				queue.forking = undefined;
			}
		});
	}

	async stop(id: string): Promise<void> {
		// A held session's route would start it again once its link drops: suspended until `retry` or its last release.
		this.#runtime().sessions.suspend(Session({ id }));
		const queue = this.#queues.get(id);
		if (queue === undefined) return;
		// The live worker at once: a start queued behind its exit waits for it. Then whatever that start forks.
		void queue.worker?.stop();
		await this.#enqueue(queue, async () => void (await queue.worker?.stop()));
	}

	retry(id: string): void {
		const queue = this.#queues.get(id);
		if (queue !== undefined) {
			queue.failed = undefined;
			this.#forget(queue);
		}
		this.#runtime().sessions.retry(Session({ id }));
	}

	state(): Readonly<Record<string, WorkerState>> {
		const state: Record<string, WorkerState> = {};
		for (const [id, { worker, failed }] of this.#queues) {
			if (failed !== undefined) state[id] = { status: "failed", reason: failed };
			else if (worker !== undefined) state[id] = { status: worker.status, pid: worker.pid };
		}
		return state;
	}

	async reload(_built: unknown, context: Context) {
		// A rollout clears the failures: the new scripts may be the fix.
		for (const [id, queue] of this.#queues) if (queue.failed !== undefined) this.retry(id);
		const scripts = await this.#runtime().workerScripts(context);
		const aborted = untilAborted(context).then(() => context.abortSignal?.reason);
		const entries = await Promise.all(
			[...this.#queues.values()].map((queue) => bounded(queue.id, this.#reloadOf(queue, scripts), aborted)),
		);
		return { hosts: entries.filter((entry) => entry !== undefined) };
	}

	/**
	 * Refuses new starts (a start under way forks nothing), then stops every worker at once and resolves once each exit
	 * counted.
	 */
	async close(): Promise<void> {
		this.#closing = true;
		await Promise.all([...this.#queues.values()].map((queue) => this.#closeWorker(queue)));
	}

	/**
	 * Forks session `queue.id`'s worker with the current scripts. They are read last: nothing waits between that read
	 * and the fork, and a rollout meanwhile waits for `forking`.
	 */
	async #fork(queue: WorkerQueue, context: Context): Promise<WorkerProcess> {
		const { id } = queue;
		const runtime = this.#runtime();
		const scripts = await runtime.workerScripts(context);
		// After the last wait, in the step that forks: a close that started meanwhile found no worker to stop.
		if (this.#closing) throw closed();
		const worker = new WorkerProcess(
			{
				message: {
					kind: "start",
					session: id,
					dir: join(runtime.dataDir, "workers", id),
					// Named by a hash of the id: a socket path holds at most 104 bytes; the worker makes `locks/`, private.
					lock: join(runtime.dataDir, "locks", createHash("sha256").update(id).digest("hex").slice(0, 16)),
					idleMs: runtime.workerIdleMs,
					scripts,
				},
				entry: runtime.worker.entry,
				execArgv: runtime.worker.execArgv,
				env: { NODE_COMPILE_CACHE: join(runtime.dataDir, "cache", "node") },
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
		return worker;
	}

	/**
	 * Stops `queue`'s worker for the runner's close. One stopped before it was ready may have had its link closed before
	 * its handshake, which fails its holders until a new resolve: the route resolves it again, then on the next runner.
	 */
	async #closeWorker(queue: WorkerQueue): Promise<void> {
		const worker = queue.worker;
		if (worker === undefined) return;
		const starting = worker.status === "starting";
		await worker.stop();
		if (starting) this.#runtime().sessions.retry(Session({ id: queue.id }));
	}

	/**
	 * Ships `scripts` to `queue`'s worker unless it stops: once a start under way forked (it may have read the scripts
	 * before this rollout), and after the worker's earlier reloads. No result when it runs them already.
	 */
	async #reloadOf(queue: WorkerQueue, scripts: readonly PluginScript[]): Promise<RolloutHost | undefined> {
		const worker = queue.worker ?? (await queue.forking);
		if (worker === undefined || worker.status === "stopping") return undefined;
		return worker.reload(scripts);
	}

	/** Session `id`'s worker queue, made by its first use. */
	#queueOf(id: string): WorkerQueue {
		let queue = this.#queues.get(id);
		if (queue === undefined) {
			queue = { id, tail: Promise.resolve(), pending: 0, worker: undefined, forking: undefined, failed: undefined };
			this.#queues.set(id, queue);
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
		if (this.#queues.get(queue.id) === queue) this.#queues.delete(queue.id);
	}
}

/** What a start rejects with once the runner closes. */
function closed(): Error {
	return new Error("p3: the runner closed");
}

/** `entry`, or `host` failed with the reason once `aborted` (the rollout's abort) settles first. */
function bounded(
	host: string,
	entry: Promise<RolloutHost | undefined>,
	aborted: Promise<unknown>,
): Promise<RolloutHost | undefined> {
	return Promise.race([entry, aborted.then((error): RolloutHost => ({ kind: "failed", host, error }))]);
}
