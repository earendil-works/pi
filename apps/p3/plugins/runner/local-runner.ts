// The local runner: each session's worker as a process on this machine (`worker-process.ts`). Per session one
// operation at a time: a start waits for the previous worker's exit. A worker that crashes fails its session until
// `retry` or a rollout (no restart loop); one that stopped itself idle, or was stopped, starts again on the next hold.
// The rollout step ships changed scripts to every running worker and clears the failures.

import { join } from "node:path";
import { type Context, type Link, Session } from "@earendil-works/p3/v1";
import type { PluginScript, ServerRuntime, WorkerRunner, WorkerState } from "@earendil-works/p3/v1/server";
import { keyOf, WorkerProcess } from "./worker-process.ts";

/** One session's worker: the tail of its operations (one at a time), its worker process, its failure. */
type WorkerQueue = { tail: Promise<unknown>; worker: WorkerProcess | undefined; failed: string | undefined };

/** The local runner over `runtime` (read at each use: a reload of the base never happens, a plugin's may). */
export class LocalRunner implements WorkerRunner {
	readonly #runtime: () => ServerRuntime;
	readonly #workers = new Map<string, WorkerQueue>();

	constructor(runtime: () => ServerRuntime) {
		this.#runtime = runtime;
	}

	start(address: { readonly params: { readonly id: string } }, context: Context): Promise<Link> {
		const { id } = address.params;
		const queue = this.#queueOf(id);
		return this.#enqueue(queue, async () => {
			if (queue.worker !== undefined) await queue.worker.gone;
			if (queue.failed !== undefined) throw new Error(`p3: session ${id}: worker ${queue.failed}`);
			const runtime = this.#runtime();
			const worker = new WorkerProcess({
				session: id,
				entry: runtime.worker.entry,
				execArgv: runtime.worker.execArgv,
				env: { NODE_COMPILE_CACHE: join(runtime.dataDir, "cache", "node") },
				dir: join(runtime.dataDir, "workers", id),
				idleMs: runtime.workerIdleMs,
				scripts: await runtime.workerScripts(context),
				store: runtime.store,
			});
			queue.worker = worker;
			void worker.gone.then((exit) => {
				if (queue.worker === worker) queue.worker = undefined;
				if (exit.kind === "crash") {
					queue.failed = exit.reason;
					console.error(`p3 runner: ${id}: worker ${exit.reason}`);
				}
			});
			return worker.link;
		});
	}

	async stop(id: string): Promise<void> {
		const queue = this.#workers.get(id);
		if (queue === undefined) return;
		await this.#enqueue(queue, async () => {
			await queue.worker?.stop();
		});
	}

	retry(id: string): void {
		const queue = this.#workers.get(id);
		if (queue !== undefined) queue.failed = undefined;
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

	readonly rollout = {
		name: "workers",
		kinds: ["worker"],
		reload: async (_built: unknown, context: Context) => {
			// A rollout clears the failures: the new scripts may be the fix.
			for (const [id, queue] of this.#workers) if (queue.failed !== undefined) this.retry(id);
			const scripts = await this.#runtime().workerScripts(context);
			return { hosts: await Promise.all(this.#reloads(scripts)) };
		},
	};

	/** Stops every worker: the runner's object ends. */
	async close(): Promise<void> {
		await Promise.all([...this.#workers.values()].map(({ worker }) => worker?.stop()));
	}

	/** Ships `scripts` to every running worker that runs another set: one result each. */
	#reloads(scripts: readonly PluginScript[]) {
		const key = keyOf(scripts);
		return [...this.#workers]
			.filter(([, { worker }]) => worker?.status === "running" && worker.shipped !== key)
			.map(([id, { worker }]) => worker!.reload(id, scripts));
	}

	/** Session `id`'s worker queue, made by its first use. */
	#queueOf(id: string): WorkerQueue {
		let queue = this.#workers.get(id);
		if (queue === undefined) {
			queue = { tail: Promise.resolve(), worker: undefined, failed: undefined };
			this.#workers.set(id, queue);
		}
		return queue;
	}

	/** Runs `operation` after the session's earlier ones. */
	#enqueue<T>(queue: WorkerQueue, operation: () => Promise<T>): Promise<T> {
		const run = queue.tail.then(operation);
		queue.tail = run.catch(() => {});
		return run;
	}
}
