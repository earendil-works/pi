// Group commit and the scheduler (docs/group-commit.md §6): decisions read the scheduler's memory in regions that
// wait for the unpublished commits whose keys they read, memberships written at admission, outcomes, and close.
import type { JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	type Harness,
	type TaskId,
	type TaskRecord,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULER_INDEX_SIZES } from "../src/harness/harness.ts";
import { ownedKey, ROOTS_KEY } from "../src/session/keys.ts";
import type { SessionImpl } from "../src/session/session.ts";
import type { Transaction } from "../src/session/transaction.ts";
import { ControlledStorage, context, flush, followCommits } from "./session-support.ts";
import { aborted, type Deferred, deferred, eventually, openTasks, settled } from "./task-support.ts";

const gates = new Map<string, Deferred<void>>();
function gate(name: string): Deferred<void> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<void>();
		gates.set(name, found);
	}
	return found;
}

/** How often each named phase ran. */
const runs = new Map<string, number>();
function ran(name: string): number {
	return runs.get(name) ?? 0;
}
function count(name: string): void {
	runs.set(name, ran(name) + 1);
}

afterEach(() => {
	gates.clear();
	runs.clear();
});

const COMPLETED = { status: "terminal", outcome: { status: "completed", result: null } } as const;

function completedWith<R>(result: R) {
	return { status: "terminal", outcome: { status: "completed", result } } as const;
}

/** Holds until its named gate opens, then completes; its abort handler ends it `aborted`. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "gc.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			count(task.input.name);
			await Promise.race([gate(task.input.name).promise, aborted(runtime.signal)]);
			await runtime.commit(() => COMPLETED, ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Commits its next phase, returns once `<name>.return` opens; the next phase counts its run and completes. */
const TwoPhases = defineTask<{ name: string }, { phase: "one" } | { phase: "two" }, null>({
	name: "gc.two-phases",
	version: 1,
	initial: () => ({ phase: "one" }),
	phases: {
		one: async (task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "two" } }), ctx);
			await gate(`${task.input.name}.return`).promise;
		},
		two: async (task, runtime, ctx) => {
			count(`${task.input.name}.two`);
			await runtime.commit(() => COMPLETED, ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Once its gate opens, waits on the task in its input; records why a refused wait was refused, then completes. */
const Waits = defineTask<{ name: string; on?: TaskId }, { phase: "wait" } | { phase: "done" }, null>({
	name: "gc.waits",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, ctx) => {
			await gate(task.input.name).promise;
			const on = await runtime.memo<number>("on", ctx);
			try {
				await runtime.commit(
					() => ({ status: "waiting", checkpoint: { phase: "done" }, on: [on as TaskId], policy: "allSettled" }),
					ctx,
				);
			} catch (error) {
				refusals.set(task.input.name, error);
				await runtime.commit(() => COMPLETED, ctx);
			}
		},
		done: async (_task, runtime, ctx) => runtime.commit(() => COMPLETED, ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
const refusals = new Map<string, unknown>();

async function status(harness: Harness, id: TaskId): Promise<string | undefined> {
	return (await harness.getTask(id, context))?.state.status;
}

/** Stage a task record as is, the way only the scheduler and recovery write them. */
function setTask(tx: unknown, record: TaskRecord<JsonValue, JsonValue, JsonValue>): void {
	(tx as Transaction).setTask(record);
}

describe("group commit: scheduler regions", () => {
	it("holds a live owner whose end races a creation below its ended tasks: live P, ended B and A, empty C", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		harness.resume();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, b, a, c: c.id };
		}, context);
		gate("a").resolve();
		await harness.waitForTask(tree.a, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		// The creation of D in C is admitted and in flight when P commits its end.
		const held = storage.holdCommits();
		const c = (await harness.conversation(tree.c, context))!;
		const creating = c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await held.entered;
		// P's decision reads what the creation writes, so it waits for its publication, holding the line.
		gate("p").resolve();
		await flush();
		held.release();
		const d = await creating;
		await eventually(async () => (await status(harness, tree.p)) === "completing");
		gate("d").resolve();
		await harness.waitForTask(d, context);
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("holds an owner whose end follows a creation below its child's pending end: live P, ending B, conversation C", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		harness.resume();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { p, b, c: c.id };
		}, context);
		const c = (await harness.conversation(tree.c, context))!;
		await eventually(async () => (await status(harness, tree.b)) === "running");
		// A call in flight, so what follows is admitted and stays unpublished, in this order.
		const held = storage.holdCommits();
		const blocker = root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await held.entered;
		// B ends; then D is created in C while B still shows live; then P ends.
		gate("b").resolve();
		await flush();
		const creating = c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await flush();
		gate("p").resolve();
		await flush();
		held.release();
		await blocker;
		const d = await creating;
		// In line order D's creation precedes P's decision: P holds while D is live.
		await eventually(async () => (await status(harness, tree.p)) === "completing");
		expect(await status(harness, d)).toBe("running");
		gate("d").resolve();
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("ends a child before its next phase when its owner's abort mark is unpublished at its step", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold, TwoPhases]);
		const root = await harness.root(context);
		harness.resume();
		const { owner, child } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "o" }, { ownership: { kind: "conversation" } });
			const child = await tx.createTask(TwoPhases, { name: "t" }, { ownership: { kind: "task", taskId: owner } });
			return { owner, child };
		}, context);
		await eventually(async () => {
			const record = await harness.getTask(child, context);
			return record?.state.status === "running" && (record.state.checkpoint as { phase: string }).phase === "two";
		});
		const held = storage.holdCommits();
		const marking = harness.abortTask(owner, context);
		await held.entered;
		// The child's phase returns: its step reads the intent set, which the unpublished mark changes.
		gate("t.return").resolve();
		await flush();
		expect(ran("t.two")).toBe(0);
		held.release();
		expect(await marking).toBe("marked");
		expect((await harness.waitForTask(child, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(owner, context)).state.outcome.status).toBe("aborted");
		expect(ran("t.two")).toBe(0);
		await harness.close(context);
	});

	it("refuses the second of two opposite waits admitted behind each other", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Waits]);
		const root = await harness.root(context);
		const { x, y } = await root.commit(async (tx) => {
			const x = await tx.createTask(Waits, { name: "x" }, { ownership: { kind: "conversation" } });
			const y = await tx.createTask(Waits, { name: "y" }, { ownership: { kind: "conversation" } });
			return { x, y };
		}, context);
		// Each waits on the other, named in a memo.
		await root.commit(async (tx) => {
			// Every table read before the first write.
			const records = [(await tx.task(x))!, (await tx.task(y))!];
			setTask(tx, { ...records[0]!, memos: { on: y } } as TaskRecord<JsonValue, JsonValue, JsonValue>);
			setTask(tx, { ...records[1]!, memos: { on: x } } as TaskRecord<JsonValue, JsonValue, JsonValue>);
		}, context);
		harness.resume();
		await eventually(
			async () => (await status(harness, x)) === "running" && (await status(harness, y)) === "running",
		);
		const held = storage.holdCommits();
		gate("x").resolve();
		await held.entered;
		gate("y").resolve();
		await flush();
		held.release();
		await harness.waitForTask(y, context);
		expect(String(refusals.get("y"))).toContain("wait cycle");
		expect(refusals.has("x")).toBe(false);
		expect((await harness.waitForTask(x, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("starts no invocation on a reservation before the reservation is published", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Hold, { name: "r" }, { ownership: { kind: "conversation" } }),
			context,
		);
		// The reservation's write is in flight: a scheduler commit with writes is never delivered before it is published.
		const held = storage.holdCommits();
		harness.resume();
		await held.entered;
		await flush();
		expect(ran("r")).toBe(0);
		held.release();
		await eventually(() => ran("r") === 1);
		expect(await status(harness, id)).toBe("running");
		gate("r").resolve();
		await harness.waitForTask(id, context);
		await harness.close(context);
	});

	it("runs a migration once although its reservation waits for an unpublished write of the task", async () => {
		const storage = new ControlledStorage();
		let migrations = 0;
		const V2 = defineTask<{ name: string }, { phase: "hold" }, null>({
			name: "gc.migrated",
			version: 2,
			initial: () => ({ phase: "hold" }),
			migrate: (input, checkpoint) => {
				migrations++;
				return { input: input as { name: string }, checkpoint: checkpoint as { phase: "hold" } };
			},
			phases: { hold: async (_task, runtime, ctx) => runtime.commit(() => COMPLETED, ctx) },
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "v2", tasks: [V2] }));
		const { harness } = await openTasks(storage, [], { registry });
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(V2, { name: "m" }, { ownership: { kind: "conversation" } }),
			context,
		);
		// Stored at version 1, and written again by a commit that is in flight when the reservation reads it.
		const held = storage.holdCommits();
		const writing = root.commit(async (tx) => {
			const record = (await tx.task(id))!;
			setTask(tx, { ...record, version: 1, memos: { touched: true } } as TaskRecord<
				JsonValue,
				JsonValue,
				JsonValue
			>);
		}, context);
		await held.entered;
		harness.resume();
		await flush();
		expect(migrations).toBe(0);
		held.release();
		await writing;
		expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		expect(migrations).toBe(1);
		await harness.close(context);
	});

	it("reports a failed migration once although its reservation waits for an unpublished write of the task", async () => {
		const storage = new ControlledStorage();
		let migrations = 0;
		const V2 = defineTask<{ name: string }, { phase: "hold" }, null>({
			name: "gc.unmigratable",
			version: 2,
			initial: () => ({ phase: "hold" }),
			migrate: () => {
				migrations++;
				throw new Error("cannot migrate");
			},
			phases: { hold: async (_task, runtime, ctx) => runtime.commit(() => COMPLETED, ctx) },
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "v2", tasks: [V2] }));
		const { harness, infos } = await openTasks(storage, [], { registry });
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(V2, { name: "m" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const held = storage.holdCommits();
		const writing = root.commit(async (tx) => {
			const record = (await tx.task(id))!;
			setTask(tx, { ...record, version: 1 } as TaskRecord<JsonValue, JsonValue, JsonValue>);
		}, context);
		await held.entered;
		harness.resume();
		await flush();
		held.release();
		await writing;
		await eventually(() => migrations > 0);
		await flush();
		expect(migrations).toBe(1);
		expect(infos.filter((info) => info.kind === "migration_failed")).toHaveLength(1);
		await harness.close(context);
	});

	it("makes a reader of the roots wait for a creation under a root a pending end would unlist", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		harness.resume();
		// Root R is listed for its last live task, T.
		const last = await root.commit(
			(tx) => tx.createTask(Hold, { name: "t" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await status(harness, last)) === "running");
		const published = new Set<TaskId>();
		followCommits(harness, (publication) => {
			if (publication.kind !== "stored") return;
			for (const change of publication.changes) if (change.type === "task") published.add(change.value.id);
		});
		// T's end is in flight; a creation under R is admitted after it, while R still shows listed.
		const held = storage.holdCommits();
		gate("t").resolve();
		await held.entered;
		let created: TaskId | undefined;
		const creating = root.commit(async (tx) => {
			created = await tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } });
			return created;
		}, context);
		await flush();
		// A reader of the roots on the line (global idle's key) waits until the creation is published too.
		const session = harness as unknown as SessionImpl;
		const reading = session.readOnLine(async () => {
			const gate = session.touch(ROOTS_KEY);
			if (gate !== undefined) await gate;
			return created !== undefined && published.has(created);
		});
		held.release();
		await creating;
		expect(await reading).toBe(true);
		gate("d").resolve();
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("walks a creation's memberships past an ancestor whose pending end is unpublished", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		harness.resume();
		// Live P, in the root conversation, owns the empty conversation C.
		const { p, c } = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: p } });
			return { p, c: c.id };
		}, context);
		await eventually(async () => (await status(harness, p)) === "running");
		const published = new Set<TaskId>();
		followCommits(harness, (publication) => {
			if (publication.kind !== "stored") return;
			for (const change of publication.changes) if (change.type === "task") published.add(change.value.id);
		});
		// P's end is in flight; a creation in C is admitted after it. Its chain must not stop at P, which shows live.
		const conversation = (await harness.conversation(c, context))!;
		const held = storage.holdCommits();
		gate("p").resolve();
		await held.entered;
		let created: TaskId | undefined;
		const creating = conversation.commit(async (tx) => {
			created = await tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } });
			return created;
		}, context);
		await flush();
		const session = harness as unknown as SessionImpl;
		const reading = session.readOnLine(async () => {
			const gate = session.touch(ROOTS_KEY);
			if (gate !== undefined) await gate;
			return created !== undefined && published.has(created);
		});
		held.release();
		await creating;
		expect(await reading).toBe(true);
		gate("d").resolve();
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("reserves the live work of the owner above an ancestor whose end is pending, for a creation below it", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		harness.resume();
		// Live G owns P, which owns the empty conversation C.
		const { g, p, c } = await root.commit(async (tx) => {
			const g = await tx.createTask(Hold, { name: "g" }, { ownership: { kind: "conversation" } });
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "task", taskId: g } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: p } });
			return { g, p, c: c.id };
		}, context);
		await eventually(async () => (await status(harness, p)) === "running");
		const published = new Set<TaskId>();
		followCommits(harness, (publication) => {
			if (publication.kind !== "stored") return;
			for (const change of publication.changes) if (change.type === "task") published.add(change.value.id);
		});
		// P's end is in flight; a creation in C is admitted after it, while P still shows live.
		const conversation = (await harness.conversation(c, context))!;
		const held = storage.holdCommits();
		gate("p").resolve();
		await held.entered;
		let created: TaskId | undefined;
		const creating = conversation.commit(async (tx) => {
			created = await tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } });
			return created;
		}, context);
		await flush();
		// A reader of G's live work (as G's end decision is) waits until the creation is published too.
		const session = harness as unknown as SessionImpl;
		const reading = session.readOnLine(async () => {
			const gate = session.touch(ownedKey(g));
			if (gate !== undefined) await gate;
			return created !== undefined && published.has(created);
		});
		held.release();
		await creating;
		expect(await reading).toBe(true);
		gate("d").resolve();
		gate("g").resolve();
		await harness.waitForTask(g, context);
		await harness.close(context);
	});

	it("keeps the nodes a chain load installed for an unpublished creation through the sweep", async () => {
		const storage = new ControlledStorage();
		let opened = await openTasks(storage, [Hold]);
		const root = await opened.harness.root(context);
		opened.harness.resume();
		const tree = await root.commit(async (tx) => {
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { b, c: c.id };
		}, context);
		gate("b").resolve();
		await opened.harness.waitForTask(tree.b, context);
		await opened.harness.close(context);
		// After reopen, B and C's edge are known only once a chain load reads them.
		opened = await openTasks(storage.reopen(), [Hold]);
		const harness = opened.harness;
		const sizes = () =>
			(harness as unknown as Record<symbol, { settled: number; unloaded: number; pins: number }>)[
				SCHEDULER_INDEX_SIZES
			]!;
		expect(sizes().settled).toBe(0);
		const c = (await harness.conversation(tree.c, context))!;
		const held = storage.holdCommits();
		const creating = c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await held.entered;
		// The admission loaded B; the sweep that load scheduled has run on the line since, and kept it.
		await harness.waitForIdle(context);
		await flush();
		expect(sizes().settled).toBe(1);
		expect(sizes().pins).toBeGreaterThan(0);
		held.release();
		await creating;
		// Published below a known chain: nothing is left to load, and no pin is left.
		expect(sizes().unloaded).toBe(0);
		expect(sizes().pins).toBe(0);
		expect(await settled(harness.waitForIdle(context))).toBe(false);
		harness.resume();
		gate("d").resolve();
		await harness.waitForIdle(context);
		await harness.close(context);
	});
});

describe("group commit: records a decision copies", () => {
	type Probe = { readonly name: string };
	/** Runtimes of running probes, by name, so a test commits for them. */
	const runtimes = new Map<string, TaskRuntime<Probe, { phase: "hold"; n: number }, null, object>>();
	const untilAborted = (signal: AbortSignal) =>
		new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	/** Holds until aborted, its runtime exposed; fails once its gate opens. Its abort handler holds too. */
	const Probe = defineTask<Probe, { phase: "hold"; n: number }, null>({
		name: "gc.probe",
		version: 1,
		initial: () => ({ phase: "hold", n: 0 }),
		phases: {
			hold: async (task, runtime, ctx) => {
				runtimes.set(task.input.name, runtime);
				const failing = gate(task.input.name).promise.then(() => "fail" as const);
				if ((await Promise.race([failing, untilAborted(runtime.signal)])) !== "fail") return;
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: { message: "gate" } } }),
					ctx,
				);
			},
		},
		abort: async (_task, runtime) => untilAborted(runtime.signal),
	});
	/** Creates probes `x` and `y` and waits on them `failFast`. */
	const Waiter = defineTask<null, { phase: "spawn" } | { phase: "done" }, null>({
		name: "gc.fail-fast",
		version: 1,
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: async (task, runtime, ctx) =>
				runtime.commit(async (tx) => {
					const on: TaskId[] = [];
					for (const name of ["x", "y"]) {
						on.push(await tx.createTask(Probe, { name }, { ownership: { kind: "task", taskId: task.id } }));
					}
					return { status: "waiting", checkpoint: { phase: "done" }, on, policy: "failFast" };
				}, ctx),
			done: async (_task, runtime, ctx) => runtime.commit(() => COMPLETED, ctx),
		},
		abort: async (_task, runtime) => untilAborted(runtime.signal),
	});

	afterEach(() => {
		runtimes.clear();
	});

	/** Advance probe `name` to `n = 1` while the mark-writing commit is in flight, and run a reconcile pass meanwhile. */
	async function raceMark(storage: ControlledStorage, harness: Harness, name: string, mark: () => Promise<unknown>) {
		const heldMark = storage.holdCommits();
		const marking = mark();
		await heldMark.entered;
		let prepared = false;
		const advancing = runtimes.get(name)!.commit(() => {
			prepared = true;
			return { status: "running", checkpoint: { phase: "hold", n: 1 } };
		}, context);
		await eventually(() => prepared);
		await flush();
		// Global idle schedules a reconcile pass, which reaches the line while both are unpublished.
		harness.waitForIdle(context).catch(() => {});
		await flush();
		const heldAdvance = storage.holdCommits();
		heldMark.release();
		await heldAdvance.entered;
		await flush();
		heldAdvance.release();
		await Promise.all([marking, advancing]);
		await flush();
	}

	it("marks a child in a cascade from its current record, not one its pending commit replaces", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Probe]);
		const root = await harness.root(context);
		const { parent, child } = await root.commit(async (tx) => {
			const parent = await tx.createTask(Probe, { name: "p" }, { ownership: { kind: "conversation" } });
			const child = await tx.createTask(Probe, { name: "c" }, { ownership: { kind: "task", taskId: parent } });
			return { parent, child };
		}, context);
		harness.resume();
		await eventually(() => runtimes.has("c"));
		await flush();
		await raceMark(storage, harness, "c", () => harness.abortTask(parent, context));
		await eventually(async () => (await harness.getTask(child, context))?.abortRequested === true);
		expect((await harness.getTask(child, context))?.state).toMatchObject({ checkpoint: { n: 1 } });
		await harness.close(context);
	});

	it("marks the other tasks of a failFast wait from their current records", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Probe, Waiter]);
		const root = await harness.root(context);
		await root.commit((tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await eventually(() => runtimes.has("x") && runtimes.has("y"));
		await flush();
		const y = runtimes.get("y")!.taskId;
		// X fails while its commit is in flight; the pass that marks Y runs while Y's own commit is pending.
		await raceMark(storage, harness, "y", async () => {
			gate("x").resolve();
		});
		await eventually(async () => (await harness.getTask(y, context))?.abortRequested === true);
		expect((await harness.getTask(y, context))?.state).toMatchObject({ checkpoint: { n: 1 } });
		await harness.close(context);
	});
});

describe("group commit: reads on the line", () => {
	it("reads no task record from Storage for more live and awaited tasks than the record cache's count", async () => {
		class Counting extends ControlledStorage {
			taskReads = 0;
			override task(...args: Parameters<ControlledStorage["task"]>) {
				this.taskReads++;
				return super.task(...args);
			}
		}
		const Child = defineTask<null, { phase: "end" }, number>({
			name: "gc.child",
			version: 1,
			initial: () => ({ phase: "end" }),
			phases: { end: async (task, runtime, ctx) => runtime.commit(() => completedWith(task.id), ctx) },
			abort: async () => {},
		});
		const Parent = defineTask<null, { phase: "spawn" } | { phase: "read"; on: TaskId[] }, number>({
			name: "gc.parent",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (task, runtime, ctx) =>
					runtime.commit(async (tx) => {
						const on: TaskId[] = [];
						for (let n = 0; n < 300; n++) {
							on.push(await tx.createTask(Child, null, { ownership: { kind: "task", taskId: task.id } }));
						}
						return { status: "waiting", checkpoint: { phase: "read", on }, on, policy: "allSettled" };
					}, ctx),
				read: async (task, runtime, ctx) => {
					const outcomes = await runtime.outcomes(task.state.checkpoint.on, ctx);
					const sum = outcomes.reduce((total, outcome) => total + (outcome.status === "completed" ? 1 : 0), 0);
					await runtime.commit(() => completedWith(sum), ctx);
				},
			},
			abort: async () => {},
		});
		const storage = new Counting();
		const { harness } = await openTasks(storage, [Parent, Child]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Parent, null, { ownership: { kind: "conversation" } }),
			context,
		);
		storage.taskReads = 0;
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: 300 });
		// Each change of a live task, and the parent's read of the outcomes it waited on, finds the record in memory.
		expect(storage.taskReads).toBe(0);
		await harness.close(context);
	});
});

describe("group commit: outcomes and publication through the Harness", () => {
	it("finds the submission an unpublished commit admitted with the same request ID", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const draft = { type: "write", entry: { kind: "note", data: {} }, requestId: "r1" } as const;
		const held = storage.holdCommits();
		const first = root.submit(draft, context);
		await held.entered;
		const second = root.submit(draft, context);
		await flush();
		held.release();
		expect((await second).id).toBe((await first).id);
		await harness.close(context);
	});

	it("runs a wait continuation of one commit before the next commit of the same call is published", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [Hold]);
		const root = await harness.root(context);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const one = await root.commit(
			(tx) => tx.createTask(Hold, { name: "one" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const two = await other.commit(
			(tx) => tx.createTask(Hold, { name: "two" }, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(
			async () => (await status(harness, one)) === "running" && (await status(harness, two)) === "running",
		);
		const ended = new Set<TaskId>();
		followCommits(harness, (publication) => {
			if (publication.kind !== "stored") return;
			for (const change of publication.changes) {
				if (change.type === "task" && change.value.state.status === "terminal") ended.add(change.value.id);
			}
		});
		// Both end in one call, behind a commit in flight.
		const held = storage.holdCommits();
		const blocker = root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await held.entered;
		let seen: boolean | undefined;
		const waited = harness.waitForTask(one, context).then(() => {
			seen = ended.has(two);
		});
		gate("one").resolve();
		await flush();
		gate("two").resolve();
		await flush();
		held.release();
		await blocker;
		await waited;
		await harness.waitForTask(two, context);
		expect(seen).toBe(false);
		await harness.close(context);
	});

	it("signals an invocation when it closes during a call in flight, and stores that call before Storage closes", async () => {
		const storage = new ControlledStorage();
		const signalled = deferred<void>();
		const Listens = defineTask<null, { phase: "wait" }, null>({
			name: "gc.listens",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime) => {
					await aborted(runtime.signal).catch(() => signalled.resolve());
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(storage, [Listens]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Listens, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(async () => (await status(harness, id)) === "running");
		const held = storage.holdCommits();
		const entry = root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await held.entered;
		const closing = harness.close(context);
		await signalled.promise;
		expect(await settled(closing)).toBe(false);
		held.release();
		await entry;
		await closing;
		const reopened = await openTasks(storage.reopen(), [Listens]);
		const conversation = (await reopened.harness.conversation(root.id as ConversationId, context))!;
		expect((await conversation.entries({}, 10, undefined, context)).items.map((item) => item.kind)).toContain("note");
		// Close wrote the task it stopped back as pending.
		expect(await status(reopened.harness, id)).toBe("pending");
		await reopened.harness.close(context);
	});
});
