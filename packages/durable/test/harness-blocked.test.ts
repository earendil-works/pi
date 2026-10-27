import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRegistry,
	defineExtension,
	defineTask,
	type Registry,
	type Storage,
	type TaskId,
	type Wake,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { context, flush } from "./session-support.ts";
import { completed, deferred, eventually, openTasks } from "./task-support.ts";

const directories = new Set<string>();

/** Storages of killed Harnesses, never closed by them: closed after each test. */
const killed = new Set<Storage>();

afterEach(async () => {
	for (const storage of killed) await storage.close(context).catch(() => {});
	killed.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-blocked-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** A task that hangs in its phase while `crashing`, as one killed every time would, and completes otherwise. */
function crashLoop(state: { crashing: boolean; started: number }) {
	return defineTask<null, { phase: "run" }, null>({
		name: "test.crash-loop",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, ctx) => {
				state.started++;
				if (state.crashing)
					await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve()));
				else await runtime.commit(() => completed(null), ctx);
			},
		},
		abort: async () => {},
	});
}

/**
 * Open a Harness over `path`. `kill()` simulates a crash: every later call of its storage hangs, so it writes nothing
 * more, not even the `pending` records a close writes for the tasks it stops.
 */
async function openWith(path: string, registry: Registry, settings: { restartLimit?: number } = {}) {
	const wakes: Wake[] = [];
	const inner = await openNodeSqliteStorage(path);
	let dead = false;
	const storage = new Proxy(inner, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => (dead ? new Promise(() => {}) : value.apply(target, args));
		},
	});
	const { harness, infos } = await openTasks(storage, [], {
		registry,
		settings,
		onWake: (wake) => wakes.push(wake),
	});
	const kill = (): void => {
		dead = true;
		killed.add(inner);
	};
	return { harness, wakes, infos, kill };
}

describe("recovery at open", () => {
	it("keeps the host's wake active until open's recovery pass has landed", async () => {
		const path = await sqlitePath();
		const Held = defineTask<null, { phase: "run" }, null>({
			name: "test.held",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async () => {} },
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "held", tasks: [Held] }));
		const first = await openWith(path, registry);
		const id = await (await first.harness.root(context)).commit(
			(tx) => tx.createTask(Held, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.harness.close(context);
		// A crash left the task holding its outcome: the next open's recovery pass makes it terminal.
		const raw = await openNodeSqliteStorage(path);
		const record = (await raw.task(id, context))!;
		const { memos: _memos, ...rest } = record;
		const completing = {
			...rest,
			state: { status: "completing", outcome: { status: "completed", result: null } },
		} as const;
		await raw.commit([{ type: "task", value: completing }], () => {}, context);
		await raw.close(context);

		// That pass's commit fails, as on a platform reset.
		const inner = await openNodeSqliteStorage(path);
		let failNext = true;
		const failing = new Proxy(inner, {
			get(target, property) {
				if (property === "commit") {
					return (...args: Parameters<typeof inner.commit>) => {
						if (!failNext) return target.commit(...args);
						failNext = false;
						return Promise.reject(new Error("reset"));
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const wakes: Wake[] = [];
		const { harness } = await openTasks(failing, [], { registry, onWake: (wake) => wakes.push(wake) });
		expect((await harness.closed).reason).toBe("failed");
		// The host was told work is underway, and never that it ended: its recovery alarm stays.
		expect(wakes).toEqual([{ active: true }]);
	});
});

describe("tasks that cannot run", () => {
	it("parks a task cut off restartLimit times in a row, shows why, and runs it again on retryTask()", async () => {
		const path = await sqlitePath();
		const state = { crashing: true, started: 0 };
		const registry = createRegistry();
		const Loop = crashLoop(state);
		registry.install(defineExtension({ name: "loop", tasks: [Loop] }));
		let opened = await openWith(path, registry, { restartLimit: 3 });
		const root = await opened.harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Loop, null, { ownership: { kind: "conversation" } }), context);
		// Each open runs the phase, and each crash cuts it off: three restarts.
		for (let run = 1; run <= 3; run++) {
			opened.harness.resume();
			await eventually(() => state.started === run);
			opened.kill(); // a crash: a close would not count
			opened = await openWith(path, registry, { restartLimit: 3 });
		}
		const { harness, infos } = opened;
		expect((await harness.getTask(id, context))?.restarts).toBe(3);
		expect(infos).toEqual([
			{ type: "task_parked", task: { id, kind: "test.crash-loop", conversationId: root.id }, extension: "loop" },
		]);
		const inspection = await harness.inspect(context);
		expect(inspection.tasks.find((task) => task.record.id === id)?.state).toEqual({
			kind: "blocked",
			reason: "restart_limit",
		});
		const graph = await harness.watchTaskGraph(context);
		// A started watch keeps its value current.
		graph.start(async () => {});
		expect(graph.value.tasks[String(id)]?.blocked).toBe("restart_limit");
		// Parked work needs no process: nothing is active.
		await eventually(() => !harness.wake().active);
		expect(harness.wake()).toEqual({ active: false });
		harness.resume();
		// A scheduling pass runs within a few turns; it leaves the parked task out.
		for (let turn = 0; turn < 5; turn++) await flush();
		expect(state.started).toBe(3);

		state.crashing = false;
		await harness.retryTask(id, context);
		expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		expect(state.started).toBe(4);
		await graph.stop();
		await harness.close(context);
	});

	it("counts no restart for a task a close stopped", async () => {
		const path = await sqlitePath();
		const state = { crashing: true, started: 0 };
		const registry = createRegistry();
		const Loop = crashLoop(state);
		registry.install(defineExtension({ name: "loop", tasks: [Loop] }));
		let opened = await openWith(path, registry, { restartLimit: 1 });
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Loop, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await eventually(() => state.started === 1);
		await opened.harness.close(context);
		opened = await openWith(path, registry, { restartLimit: 1 });
		expect(await opened.harness.getTask(id, context)).toMatchObject({ state: { status: "pending" } });
		expect((await opened.harness.getTask(id, context))?.restarts).toBeUndefined();
		state.crashing = false;
		expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		await opened.harness.close(context);
	});

	it("keeps an abort mark admitted before close in the record close writes back", async () => {
		const path = await sqlitePath();
		const state = { crashing: true, started: 0 };
		const registry = createRegistry();
		const Loop = crashLoop(state);
		registry.install(defineExtension({ name: "loop", tasks: [Loop] }));
		const { harness } = await openWith(path, registry);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Loop, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await eventually(() => state.started === 1);
		// Hold the line; the abort mark is admitted behind it, then close begins.
		const gate = deferred();
		const holding = root.commit(() => gate.promise, context);
		const aborting = harness.abortTask(id, context);
		const closing = harness.close(context);
		// The invocation ends while the line is held; its write-back waits behind the abort mark.
		await flush();
		gate.resolve();
		await holding;
		expect(await aborting).toBe("marked");
		await closing;
		const raw = await openNodeSqliteStorage(path);
		expect(await raw.task(id, context)).toMatchObject({ abortRequested: true, state: { status: "pending" } });
		await raw.close(context);
	});

	it("faults a task whose abort handler is cut off restartLimit times", async () => {
		const path = await sqlitePath();
		let aborts = 0;
		const Stuck = defineTask<null, { phase: "run" }, null>({
			name: "test.stuck-abort",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: (_task, runtime) =>
					new Promise((resolve) => runtime.signal.addEventListener("abort", () => resolve())),
			},
			abort: (_task, runtime) => {
				aborts++;
				return new Promise((resolve) => runtime.signal.addEventListener("abort", () => resolve()));
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "stuck", tasks: [Stuck] }));
		let opened = await openWith(path, registry, { restartLimit: 1 });
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Stuck, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		void opened.harness.abortTask(id, context);
		await eventually(() => aborts === 1);
		opened.kill(); // a crash in the abort handler
		opened = await openWith(path, registry, { restartLimit: 1 });
		const settled = await opened.harness.waitForTask(id, context);
		expect(settled.state.outcome).toMatchObject({
			status: "faulted",
			error: { detail: { reason: "restart_limit" } },
		});
		// The receipt keeps no restart count.
		expect(settled.restarts).toBeUndefined();
		expect(aborts).toBe(1);
		await eventually(() => opened.infos.length > 0);
		expect(opened.infos).toMatchObject([{ type: "task_faulted", task: { id }, reason: "restart_limit" }]);
		await opened.harness.close(context);
	});

	it("runs a parked task once a raised restartLimit no longer parks it", async () => {
		const path = await sqlitePath();
		const state = { crashing: true, started: 0 };
		const registry = createRegistry();
		const Loop = crashLoop(state);
		registry.install(defineExtension({ name: "loop", tasks: [Loop] }));
		const settings: { restartLimit?: number } = { restartLimit: 1 };
		let opened = await openWith(path, registry, settings);
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Loop, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await eventually(() => state.started === 1);
		opened.kill(); // a crash: a close would not count
		opened = await openWith(path, registry, settings);
		const graph = await opened.harness.watchTaskGraph(context);
		// A started watch keeps its value current.
		graph.start(async () => {});
		opened.harness.resume();
		await eventually(() => graph.value.tasks[String(id)]?.blocked === "restart_limit");
		// Let a scheduling pass leave the parked task out.
		for (let turn = 0; turn < 5; turn++) await flush();
		state.crashing = false;
		// The host's live settings change; the next pass runs the task.
		settings.restartLimit = Number.POSITIVE_INFINITY;
		opened.harness.resume();
		expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		expect(state.started).toBe(2);
		await graph.stop();
		await opened.harness.close(context);
	});

	it("still runs the abort handler of a parked task", async () => {
		const path = await sqlitePath();
		const state = { crashing: true, started: 0 };
		const aborted: TaskId[] = [];
		const registry = createRegistry();
		const Loop = defineTask<null, { phase: "run" }, null>({
			...crashLoop(state).definition,
			abort: async (task, runtime, ctx) => {
				aborted.push(task.id);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		registry.install(defineExtension({ name: "loop", tasks: [Loop] }));
		let opened = await openWith(path, registry, { restartLimit: 1 });
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Loop, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await eventually(() => state.started === 1);
		opened.kill(); // a crash: a close would not count
		opened = await openWith(path, registry, { restartLimit: 1 });
		await opened.harness.abortTask(id, context);
		expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		expect(aborted).toEqual([id]);
		expect(state.started).toBe(1);
		await opened.harness.close(context);
	});

	it("does not count the same checkpoint committed again as progress", async () => {
		const path = await sqlitePath();
		let started = 0;
		const Intent = defineTask<null, { phase: "run" }, null>({
			name: "test.intent",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					started++;
					// Intent before an effect, then the effect never returns: the checkpoint is unchanged.
					await runtime.commit(() => ({ status: "running", checkpoint: task.state.checkpoint }), ctx);
					await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve()));
				},
			},
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "intent", tasks: [Intent] }));
		let opened = await openWith(path, registry, { restartLimit: 2 });
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Intent, null, { ownership: { kind: "conversation" } }),
			context,
		);
		for (let run = 1; run <= 2; run++) {
			opened.harness.resume();
			await eventually(() => started === run);
			await eventually(async () => (await opened.harness.getTask(id, context))?.state.status === "running");
			opened.kill(); // a crash: a close would not count
			opened = await openWith(path, registry, { restartLimit: 2 });
		}
		expect((await opened.harness.getTask(id, context))?.restarts).toBe(2);
		expect((await opened.harness.inspect(context)).tasks[0]?.state).toEqual({
			kind: "blocked",
			reason: "restart_limit",
		});
		await opened.harness.close(context);
	});

	it("starts the count over when the task makes progress", async () => {
		const path = await sqlitePath();
		let crashing = true;
		let started = 0;
		const Steps = defineTask<null, { phase: "one" } | { phase: "two" }, null>({
			name: "test.steps",
			version: 1,
			initial: () => ({ phase: "one" }),
			phases: {
				one: async (_task, runtime, ctx) => {
					started++;
					if (crashing)
						await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve()));
					else await runtime.commit(() => ({ status: "running", checkpoint: { phase: "two" } }), ctx);
				},
				two: async (_task, runtime) => {
					started++;
					await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve()));
				},
			},
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "steps", tasks: [Steps] }));
		let opened = await openWith(path, registry, { restartLimit: 2 });
		const id: TaskId = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Steps, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await eventually(() => started === 1);
		opened.kill(); // a crash: a close would not count
		opened = await openWith(path, registry, { restartLimit: 2 });
		expect((await opened.harness.getTask(id, context))?.restarts).toBe(1);
		// Progress: phase one commits phase two, which resets the count.
		crashing = false;
		opened.harness.resume();
		await eventually(() => started === 3);
		expect((await opened.harness.getTask(id, context))?.restarts).toBeUndefined();
		await opened.harness.close(context);
	});

	it("tells the graph and the host when a migration fails", async () => {
		const path = await sqlitePath();
		const run = { phases: { run: async () => {} }, abort: async () => {} } as const;
		const V1 = defineTask<null, { phase: "run" }, null>({
			name: "test.migrating",
			version: 1,
			initial: () => ({ phase: "run" }),
			...run,
		});
		const V2 = defineTask<null, { phase: "run" }, null>({
			name: "test.migrating",
			version: 2,
			initial: () => ({ phase: "run" }),
			...run,
			migrate: () => {
				throw new Error("cannot migrate");
			},
		});
		const first = createRegistry();
		first.install(defineExtension({ name: "v1", tasks: [V1] }));
		let opened = await openWith(path, first);
		// Created, never run: scheduling stays off.
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(V1, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await opened.harness.close(context);
		const second = createRegistry();
		second.install(defineExtension({ name: "v2", tasks: [V2] }));
		opened = await openWith(path, second);
		const graph = await opened.harness.watchTaskGraph(context);
		// A started watch keeps its value current.
		graph.start(async () => {});
		opened.harness.resume();
		await eventually(() => graph.value.tasks[String(id)]?.blocked === "migration_failed");
		await eventually(() => !opened.harness.wake().active);
		expect(opened.harness.wake()).toEqual({ active: false });
		await eventually(() => opened.wakes.at(-1)?.active === false);
		await graph.stop();
		await opened.harness.close(context);
	});

	it("shows an abandoned task waiting for its definition as blocked", async () => {
		const path = await sqlitePath();
		const Abandoned = defineTask<null, { phase: "run" }, null>({
			name: "test.abandoned",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async () => {} },
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "abandoned", tasks: [Abandoned] }));
		let opened = await openWith(path, registry);
		const id = await (await opened.harness.root(context)).commit(
			(tx) => tx.createTask(Abandoned, null, { ownership: { kind: "conversation" }, abandonOnRestart: true }),
			context,
		);
		await opened.harness.close(context);
		// The next open marks it `restart`; without its definition, it waits for one to clean up.
		opened = await openWith(path, createRegistry());
		const graph = await opened.harness.watchTaskGraph(context);
		// A started watch keeps its value current.
		graph.start(async () => {});
		opened.harness.resume();
		await eventually(async () => (await opened.harness.getTask(id, context))?.abortReason === "restart");
		await eventually(() => graph.value.tasks[String(id)]?.blocked === "missing_task");
		await graph.stop();
		await opened.harness.close(context);
	});

	it("shows a task without a definition as blocked, and wakes the host once a registry change unblocks it", async () => {
		const Missing = defineTask<null, { phase: "run" }, null>({
			name: "test.missing",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
			abort: async () => {},
		});
		const registry = createRegistry();
		const path = await sqlitePath();
		const { harness, wakes } = await openWith(path, registry);
		const graph = await harness.watchTaskGraph(context);
		// A started watch keeps its value current.
		graph.start(async () => {});
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Missing, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(() => graph.value.tasks[String(id)]?.blocked === "missing_task");
		await eventually(() => !harness.wake().active);
		registry.install(defineExtension({ name: "late", tasks: [Missing] }));
		// The graph follows the registry; the host hears it can run work now.
		await eventually(() => graph.value.tasks[String(id)]?.blocked === undefined);
		await eventually(() => wakes.some((wake) => wake.active));
		expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		await graph.stop();
		await harness.close(context);
	});
});
