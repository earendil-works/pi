// Signals and the wakes of parked tasks: delivery results, sleeps on signals and deadlines, `any` waits, kept wakes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	defineSignal,
	defineTask,
	MemoryStorage,
	ReadAfterWrite,
	ROOT_CONVERSATION_ID,
	type SignalState,
	type TaskId,
	type WakeReason,
} from "@earendil-works/pi-durable";
import { bigint, bytes, int, obj, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, abortedWith, completed, eventually, openTasks } from "./task-support.ts";

const Answer = defineSignal({ name: "test.answer", version: 1, schema: obj({ text: str() }) });

type AskInput = { readonly keys: readonly string[]; readonly until?: number };
type AskState = { phase: "ask" } | { phase: "answered" };
type AskResult = { readonly wake: WakeReason | undefined; readonly states: (SignalState<{ text: string }> | null)[] };

/** Sleeps on `Answer` under `keys` (and `until`), then completes with its wake and every key's state (`null`: none). */
const Ask = defineTask<AskInput, AskState, AskResult>({
	name: "test.ask",
	version: 1,
	initial: () => ({ phase: "ask" }),
	phases: {
		ask: async (task, runtime, ctx) => {
			const { keys, until } = task.input;
			await runtime.commit(
				() => ({
					status: "sleeping",
					checkpoint: { phase: "answered" },
					signals: keys.map((key) => Answer.key(key)),
					...(until === undefined ? {} : { until }),
				}),
				ctx,
			);
		},
		answered: async (task, runtime, ctx) => {
			const states: AskResult["states"] = [];
			for (const key of task.input.keys) states.push((await runtime.readSignal(Answer, key, ctx)) ?? null);
			const wake = task.state.wake;
			await runtime.commit(() => completed({ wake, states }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
});

async function start(harness: Awaited<ReturnType<typeof openTasks>>["harness"], input: AskInput) {
	const root = await harness.root(context);
	return root.commit((tx) => tx.createTask(Ask, input, { ownership: { kind: "conversation" } }), context);
}

async function statusOf(harness: Awaited<ReturnType<typeof openTasks>>["harness"], id: TaskId) {
	return (await harness.getTask(id, context))?.state.status;
}

/** The wake of a `pending` or `running` state. */
function wakeOf(state: { readonly status: string } | undefined): WakeReason | undefined {
	return state !== undefined && "wake" in state ? (state.wake as WakeReason) : undefined;
}

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-signals-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

describe("defineSignal", () => {
	it("rejects names with a slash, bad versions, non-JSON schemas, and empty keys", () => {
		expect(() => defineSignal({ name: "a/b", version: 1, schema: str() })).toThrow(/without "\/"/);
		expect(() => defineSignal({ name: "a", version: 0, schema: str() })).toThrow(/positive integer/);
		expect(() => defineSignal({ name: "a", version: 1, schema: obj({ n: bigint() }) })).toThrow(/bigint/);
		expect(() => defineSignal({ name: "a", version: 1, schema: obj({ b: bytes() }) })).toThrow(/bytes/);
		const dependent = { type: "object", dependencies: { a: ["b"], b: obj({ n: bigint() }) } };
		expect(() => defineSignal({ name: "a", version: 1, schema: dependent })).toThrow(/bigint/);
		// Annotations are values, not schemas.
		expect(() =>
			defineSignal({ name: "a", version: 1, schema: obj({ type: str() }, { examples: [{ type: "bigint" }] }) }),
		).not.toThrow();
		expect(() => Answer.key("")).toThrow(/non-empty/);
		expect(Answer.key("k")).toEqual({ signal: "test.answer", key: "k" });
	});
});

describe("delivery", () => {
	it("answers not_found, invalid, delivered, duplicate, and closed", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a"] });
		expect(await harness.signal(999_999 as TaskId, Answer, "a", { text: "x" }, context)).toBe("not_found");
		expect(await harness.signal(id, Answer, "a", { text: 1 } as never, context)).toBe("invalid");
		// The schema admits it, but NaN is not JSON.
		const Open = defineSignal({ name: "test.open", version: 1, schema: obj({ text: str() }, { open: true }) });
		expect(await harness.signal(id, Open, "a", { text: "x", n: Number.NaN } as { text: string }, context)).toBe(
			"invalid",
		);
		expect(await harness.signal(id, Answer, "a", { text: "yes" }, context)).toBe("delivered");
		expect(await harness.signal(id, Answer, "a", { text: "again" }, context)).toBe("duplicate");
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toMatchObject({ status: "completed" });
		expect(await harness.signal(id, Answer, "b", { text: "late" }, context)).toBe("closed");
		await harness.close(context);
	});

	it("answers closed for an abort-marked task", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a"] });
		await harness.abortTask(id, context);
		expect(await harness.signal(id, Answer, "a", { text: "yes" }, context)).toBe("closed");
		await harness.close(context);
	});

	it("decides deliveries started together in one commit against each other", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a", "b"] });
		const results = await harness.commit(
			(tx) =>
				Promise.all([
					tx.signal(id, Answer, "a", { text: "first" }),
					tx.signal(id, Answer, "a", { text: "second" }),
					tx.signal(id, Answer, "b", { text: "bee" }),
				]),
			context,
		);
		expect(results).toEqual(["delivered", "duplicate", "delivered"]);
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toMatchObject({
			result: { states: [{ value: { text: "first" } }, { value: { text: "bee" } }] },
		});
		await harness.close(context);
	});

	it("reads the task, so it throws ReadAfterWrite after a table write", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a"] });
		const second = harness.commit(async (tx) => {
			await tx.signal(id, Answer, "a", { text: "one" });
			await tx.signal(id, Answer, "b", { text: "two" });
		}, context);
		await expect(second).rejects.toBeInstanceOf(ReadAfterWrite);
		await harness.close(context);
	});
});

describe("sleeping on signals", () => {
	it("keeps a value delivered before the sleep, which then wakes at once", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a"] });
		// Not running yet: the value waits in the task.
		expect(await harness.signal(id, Answer, "a", { text: "early" }, context)).toBe("delivered");
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({
			status: "completed",
			result: {
				wake: { reason: "signal", signal: "test.answer", key: "a" },
				states: [{ value: { text: "early" } }],
			},
		});
		await harness.close(context);
	});

	it("holds no invocation while it waits, and wakes on the first listed key holding a value", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask], { onWake: () => {} });
		const graph = await harness.watchTaskGraph(context);
		graph.start(async () => {});
		const id = await start(harness, { keys: ["a", "b"] });
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		await eventually(() => !harness.wake().active);
		expect(graph.value.tasks[String(id)]?.state).toEqual({
			status: "sleeping",
			phase: "answered",
			signals: [Answer.key("a"), Answer.key("b")],
		});
		await graph.stop();
		// Without `until` there is no deadline to wake for.
		expect(harness.wake()).toEqual({ active: false });
		const inspection = await harness.inspect(context);
		expect(inspection.tasks.find((task) => task.record.id === id)?.state).toEqual({ kind: "sleeping" });
		expect(await harness.signal(id, Answer, "b", { text: "bee" }, context)).toBe("delivered");
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({
			status: "completed",
			result: {
				wake: { reason: "signal", signal: "test.answer", key: "b" },
				states: [null, { value: { text: "bee" } }],
			},
		});
		await harness.close(context);
	});

	it("expires its keys at the deadline, so a late delivery is closed", async () => {
		let clock = 1_000;
		const { harness } = await openTasks(new MemoryStorage(), [Ask], { now: () => clock, onWake: () => {} });
		const id = await start(harness, { keys: ["a"], until: 2_000 });
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		await eventually(() => !harness.wake().active);
		expect(harness.wake()).toEqual({ active: false, at: 2_000 });
		clock = 2_000;
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({
			status: "completed",
			result: { wake: { reason: "expired" }, states: [{ expired: true }] },
		});
		await harness.close(context);
	});

	it("answers a delivery after the deadline closed and expires the key, before the sleep is reserved", async () => {
		let clock = 1_000;
		const { harness } = await openTasks(new MemoryStorage(), [Ask], { now: () => clock, onWake: () => {} });
		const id = await start(harness, { keys: ["a"], until: 2_000 });
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		// Due, but no pass ran since: the delivery itself finds the deadline passed.
		clock = 2_500;
		expect(await harness.signal(id, Answer, "a", { text: "late" }, context)).toBe("closed");
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toMatchObject({
			result: { wake: { reason: "expired" }, states: [{ expired: true }] },
		});
		await harness.close(context);
	});

	it("rejects a sleep on a key that already woke a wait, and one without until or signals", async () => {
		const outcomes: string[] = [];
		const Twice = defineTask<{ readonly signals: boolean }, { phase: "first" } | { phase: "second" }, null>({
			name: "test.twice",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: (task, runtime, ctx) =>
					runtime.commit(
						() =>
							task.input.signals
								? { status: "sleeping", checkpoint: { phase: "second" }, signals: [Answer.key("a")] }
								: { status: "sleeping", checkpoint: { phase: "second" } },
						ctx,
					),
				second: async (_task, runtime, ctx) => {
					try {
						await runtime.commit(
							() => ({ status: "sleeping", checkpoint: { phase: "first" }, signals: [Answer.key("a")] }),
							ctx,
						);
					} catch (error) {
						outcomes.push((error as Error).message);
						await runtime.commit(() => completed(null), ctx);
					}
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Twice]);
		const root = await harness.root(context);
		const consumed = await root.commit(
			(tx) => tx.createTask(Twice, { signals: true }, { ownership: { kind: "conversation" } }),
			context,
		);
		await harness.signal(consumed, Answer, "a", { text: "once" }, context);
		await harness.waitForTask(consumed, context);
		expect(outcomes).toEqual([`Task ${consumed} cannot sleep on signal test.answer key a: it already woke a wait`]);
		const empty = await root.commit(
			(tx) => tx.createTask(Twice, { signals: false }, { ownership: { kind: "conversation" } }),
			context,
		);
		const receipt = await harness.waitForTask(empty, context);
		expect(receipt.state.outcome).toMatchObject({
			status: "faulted",
			error: { message: `Task ${empty} cannot sleep without until or signals` },
		});
		await harness.close(context);
	});

	it("wakes on the first listed key in order, and keeps the other key's value for a later sleep", async () => {
		type Wakes = (WakeReason | undefined)[];
		const Two = defineTask<
			null,
			{ phase: "first" } | { phase: "second"; wakes: Wakes } | { phase: "done"; wakes: Wakes },
			Wakes
		>({
			name: "test.two",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({
							status: "sleeping",
							checkpoint: { phase: "second", wakes: [] },
							signals: [Answer.key("a"), Answer.key("b")],
						}),
						ctx,
					),
				second: (task, runtime, ctx) =>
					runtime.commit(
						() => ({
							status: "sleeping",
							checkpoint: { phase: "done", wakes: [task.state.wake] },
							signals: [Answer.key("b")],
						}),
						ctx,
					),
				done: (task, runtime, ctx) =>
					runtime.commit(() => completed([...task.state.checkpoint.wakes, task.state.wake]), ctx),
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Two]);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Two, null, { ownership: { kind: "conversation" } }), context);
		// Both before the first sleep; `b` is delivered first, but `a` is listed first.
		await harness.commit(async (tx) => tx.signal(id, Answer, "b", { text: "bee" }), context);
		await harness.commit(async (tx) => tx.signal(id, Answer, "a", { text: "ay" }), context);
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({
			status: "completed",
			result: [
				{ reason: "signal", signal: "test.answer", key: "a" },
				{ reason: "signal", signal: "test.answer", key: "b" },
			],
		});
		await harness.close(context);
	});

	it("rejects a sleep on a key that expired", async () => {
		let clock = 1_000;
		const errors: string[] = [];
		const Again = defineTask<null, { phase: "first" } | { phase: "second" }, null>({
			name: "test.again",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({
							status: "sleeping",
							checkpoint: { phase: "second" },
							signals: [Answer.key("a")],
							until: 2_000,
						}),
						ctx,
					),
				second: async (_task, runtime, ctx) => {
					await runtime
						.commit(
							() => ({ status: "sleeping", checkpoint: { phase: "first" }, signals: [Answer.key("a")] }),
							ctx,
						)
						.catch((error: Error) => errors.push(error.message));
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Again], { now: () => clock, onWake: () => {} });
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Again, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		clock = 2_000;
		harness.resume();
		await harness.waitForTask(id, context);
		expect(errors).toEqual([`Task ${id} cannot sleep on signal test.answer key a: it expired`]);
		await harness.close(context);
	});

	it("ends a sleep on signals at once when aborted", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask]);
		const id = await start(harness, { keys: ["a"] });
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		await harness.abortTask(id, context);
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({ status: "aborted", reason: "test" });
		await harness.close(context);
	});

	it("throws on reading a value of a newer version, or of an older one without migrate", async () => {
		const V1 = defineSignal({ name: "test.versioned", version: 1, schema: obj({ n: int() }) });
		const V2 = defineSignal({ name: "test.versioned", version: 2, schema: obj({ n: int() }) });
		const errors: string[] = [];
		const Read = defineTask<{ readonly token: 1 | 2 }, { phase: "read" }, null>({
			name: "test.read-versions",
			version: 1,
			initial: () => ({ phase: "read" }),
			phases: {
				read: async (task, runtime, ctx) => {
					await runtime
						.readSignal(task.input.token === 1 ? V1 : V2, "k", ctx)
						.catch((error: Error) => errors.push(error.message));
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Read]);
		const root = await harness.root(context);
		const create = (token: 1 | 2) =>
			root.commit((tx) => tx.createTask(Read, { token }, { ownership: { kind: "conversation" } }), context);
		const newer = await create(1);
		await harness.signal(newer, V2, "k", { n: 2 }, context);
		const older = await create(2);
		await harness.signal(older, V1, "k", { n: 1 }, context);
		await harness.waitForTask(newer, context);
		await harness.waitForTask(older, context);
		expect(errors).toEqual([
			"Signal test.versioned value has version 2, newer than 1",
			"Signal test.versioned has no migration from version 1",
		]);
		await harness.close(context);
	});

	it("migrates a value stored by an older version when it is read", async () => {
		const Old = defineSignal({ name: "test.count", version: 1, schema: obj({ n: str() }) });
		const New = defineSignal({
			name: "test.count",
			version: 2,
			schema: obj({ n: int() }),
			migrate: (value) => ({ n: Number((value as { n: string }).n) }),
		});
		const reads: unknown[] = [];
		const Read = defineTask<null, { phase: "read" }, null>({
			name: "test.read",
			version: 1,
			initial: () => ({ phase: "read" }),
			phases: {
				read: async (_task, runtime, ctx) => {
					reads.push(await runtime.readSignal(New, "k", ctx));
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Read]);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Read, null, { ownership: { kind: "conversation" } }), context);
		expect(await harness.signal(id, Old, "k", { n: "42" }, context)).toBe("delivered");
		await harness.waitForTask(id, context);
		expect(reads).toEqual([{ value: { n: 42 } }]);
		await harness.close(context);
	});

	it("composes a signal with the task's own state change in one commit", async () => {
		const Self = defineTask<null, { phase: "start" } | { phase: "woke" }, WakeReason | undefined>({
			name: "test.self",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: (_task, runtime, ctx) =>
					runtime.commit(async (tx) => {
						expect(await tx.signal(runtime.taskId, Answer, "self", { text: "me" })).toBe("delivered");
						return { status: "sleeping", checkpoint: { phase: "woke" }, signals: [Answer.key("self")] };
					}, ctx),
				woke: (task, runtime, ctx) => runtime.commit(() => completed(task.state.wake), ctx),
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const { harness } = await openTasks(new MemoryStorage(), [Self]);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Self, null, { ownership: { kind: "conversation" } }), context);
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({
			status: "completed",
			result: { reason: "signal", signal: "test.answer", key: "self" },
		});
		await harness.close(context);
	});
});

/** Waits `any` on two `Ask` children; once woken, aborts the one still live and completes with its wake. */
const Parent = defineTask<null, { phase: "spawn" } | { phase: "joined"; on: TaskId[] }, WakeReason | undefined>({
	name: "test.any",
	version: 1,
	initial: () => ({ phase: "spawn" }),
	phases: {
		spawn: (_task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const own = { ownership: { kind: "task", taskId: runtime.taskId } } as const;
				const on = [await tx.createTask(Ask, { keys: ["a"] }, own), await tx.createTask(Ask, { keys: ["a"] }, own)];
				return { status: "waiting", checkpoint: { phase: "joined", on }, on, policy: "any" };
			}, ctx),
		joined: async (task, runtime, ctx) => {
			const wake = task.state.wake;
			for (const id of task.state.checkpoint.on) await runtime.abortOwned(id, ctx);
			await runtime.commit(() => completed(wake), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
});

/** Start `Parent` and wait until it waits on its two children, both asleep; returns its ID and theirs. */
async function startParent(harness: Awaited<ReturnType<typeof openTasks>>["harness"]) {
	const root = await harness.root(context);
	const id = await root.commit((tx) => tx.createTask(Parent, null, { ownership: { kind: "conversation" } }), context);
	harness.resume();
	await eventually(async () => (await statusOf(harness, id)) === "waiting");
	const record = await harness.getTask(id, context);
	const [first, second] = (record!.state as { readonly on: readonly TaskId[] }).on as [TaskId, TaskId];
	await eventually(async () => (await statusOf(harness, first)) === "sleeping");
	await eventually(async () => (await statusOf(harness, second)) === "sleeping");
	return { id, first, second };
}

describe("waits with policy any", () => {
	it("resumes once one task in on is terminal, with the ended ones as its wake", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Ask, Parent]);
		const { id, first, second } = await startParent(harness);
		await harness.signal(second, Answer, "a", { text: "done" }, context);
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({ status: "completed", result: { reason: "tasks", ended: [second] } });
		expect((await harness.getTask(first, context))?.state).toMatchObject({ outcome: { status: "aborted" } });
		await harness.close(context);
	});

	it("is active in wake() once a task in on is terminal, not while all are live", async () => {
		const storage = new ControlledStorage();
		let { harness } = await openTasks(storage, [Ask, Parent]);
		const { id, first } = await startParent(harness);
		await harness.close(context);
		// Reopened paused, without `Ask`: the children are blocked, and only the waiter can become active.
		({ harness } = await openTasks(storage.reopen(), [Parent], { onWake: () => {} }));
		await eventually(() => !harness.wake().active);
		expect(harness.wake()).toEqual({ active: false });
		// Aborting a blocked child settles it `orphaned` at once, without scheduling.
		await harness.abortTask(first, context);
		expect((await harness.getTask(first, context))?.state.status).toBe("terminal");
		await eventually(() => harness.wake().active);
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({ status: "completed", result: { reason: "tasks", ended: [first] } });
		await harness.close(context);
	});
});

describe("wakes", () => {
	it("keeps a sleep on signals asleep across reopen, active once a value is delivered", async () => {
		const path = await sqlitePath();
		let { harness } = await openTasks(await openNodeSqliteStorage(path), [Ask], { onWake: () => {} });
		const id = await start(harness, { keys: ["a"] });
		harness.resume();
		await eventually(async () => (await statusOf(harness, id)) === "sleeping");
		await harness.close(context);
		({ harness } = await openTasks(await openNodeSqliteStorage(path), [Ask], { onWake: () => {} }));
		// Scheduling is paused: once open's recovery pass landed, the sleep needs no process.
		await eventually(() => !harness.wake().active);
		expect(harness.wake()).toEqual({ active: false });
		// A commit of its own delivers without enabling scheduling: the task can run now.
		await harness.commit((tx) => tx.signal(id, Answer, "a", { text: "later" }), context);
		await eventually(() => harness.wake().active);
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toMatchObject({ result: { states: [{ value: { text: "later" } }] } });
		await harness.close(context);
	});

	it("counts no progress for a woken task that commits its checkpoint again", async () => {
		const path = await sqlitePath();
		const restarts: (number | undefined)[] = [];
		const Again = defineTask<null, { phase: "woke" } | { phase: "next" }, null>({
			name: "test.recommit",
			version: 1,
			initial: () => ({ phase: "woke" }),
			phases: {
				woke: async (_task, runtime, ctx) => {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "woke" } }), ctx);
					const record = await runtime.getTask(runtime.taskId, ctx);
					restarts.push(record?.restarts);
					expect(wakeOf(record?.state)).toEqual({ reason: "time" });
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), ctx);
				},
				next: async (_task, runtime, ctx) => {
					restarts.push((await runtime.getTask(runtime.taskId, ctx))?.restarts);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const first = await openTasks(await openNodeSqliteStorage(path), [Again]);
		await first.harness.root(context);
		await first.harness.close(context);
		// A woken task cut off by a crash: `running` with its wake, as a dead process left it.
		const storage = await openNodeSqliteStorage(path);
		const id = await storage.mintId<TaskId<JsonValue>>();
		const record = {
			id,
			conversationId: ROOT_CONVERSATION_ID,
			kind: "test.recommit",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			state: { status: "running", checkpoint: { phase: "woke" }, wake: { reason: "time" } },
		} as const;
		await commitWrites(storage, [{ type: "task", value: record }], context);
		const { harness } = await openTasks(storage, [Again]);
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "woke" },
			wake: { reason: "time" },
		});
		await harness.waitForTask(id, context);
		// The same checkpoint again keeps the count; the next one starts it over.
		expect(restarts).toEqual([1, undefined]);
		await harness.close(context);
	});

	it("keeps the wake through a commit of the same checkpoint and a reopen, and drops it with the next checkpoint", async () => {
		const path = await sqlitePath();
		const seen: (WakeReason | undefined)[] = [];
		let runs = 0;
		const Keep = defineTask<null, { phase: "sleep" } | { phase: "woke" } | { phase: "after" }, null>({
			name: "test.keep",
			version: 1,
			initial: () => ({ phase: "sleep" }),
			phases: {
				sleep: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({ status: "sleeping", checkpoint: { phase: "woke" }, signals: [Answer.key("k")] }),
						ctx,
					),
				woke: async (task, runtime, ctx) => {
					seen.push(task.state.wake);
					// Intent: the same checkpoint again keeps the wake.
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "woke" } }), ctx);
					seen.push(wakeOf((await runtime.getTask(runtime.taskId, ctx))?.state));
					// The first run is stopped by the close.
					if (runs++ === 0) await aborted(runtime.signal);
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "after" } }), ctx);
				},
				after: async (_task, runtime, ctx) => {
					seen.push(wakeOf((await runtime.getTask(runtime.taskId, ctx))?.state));
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		let { harness } = await openTasks(await openNodeSqliteStorage(path), [Keep]);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Keep, null, { ownership: { kind: "conversation" } }), context);
		await harness.signal(id, Answer, "k", { text: "go" }, context);
		await eventually(() => seen.length === 2);
		const wake = { reason: "signal", signal: "test.answer", key: "k" };
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "running",
			checkpoint: { phase: "woke" },
			wake,
		});
		// Close stops the phase and writes the task back as pending, with its wake.
		await harness.close(context);
		expect(seen).toEqual([wake, wake]);
		({ harness } = await openTasks(await openNodeSqliteStorage(path), [Keep]));
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "woke" },
			wake,
		});
		harness.resume();
		await harness.waitForTask(id, context);
		expect(seen).toEqual([wake, wake, wake, wake, undefined]);
		await harness.close(context);
	});
});
