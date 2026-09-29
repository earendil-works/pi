import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineDoc,
	defineEntry,
	defineTask,
	type EntryId,
	Harness,
	MemoryStorage,
	type RegistryReader,
	type RegistrySnapshot,
	StorageRejected,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { user } from "./harness-support.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { aborted, abortedWith, completed, deferred, eventually, openTasks, settled } from "./task-support.ts";

type Step = { phase: "run" };
type StepRuntime<R> = TaskRuntime<null, Step, R, object>;

/** A one-phase task; the default abort handler settles `aborted` with reason "test". */
function oneStep<R = null>(
	name: string,
	run: (task: { readonly id: TaskId<R> }, runtime: StepRuntime<R>, context: Context) => Promise<void>,
	abort: (runtime: StepRuntime<R>, context: Context) => Promise<void> = (runtime, ctx) =>
		runtime.commit(() => abortedWith("test"), ctx),
) {
	return defineTask<null, Step, R>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, ctx) => run(task, runtime, ctx) },
		abort: (_task, runtime, ctx) => abort(runtime, ctx),
	});
}

/** A one-phase task that waits for `gate` and completes with null. */
function gated(name: string, gate: Promise<void>) {
	return oneStep(name, async (_task, runtime, ctx) => {
		await gate;
		await runtime.commit(() => completed(null), ctx);
	});
}

async function start<R>(
	conversation: Conversation,
	task: ReturnType<typeof oneStep<R>>,
	options: { readonly after?: readonly TaskId[]; readonly background?: boolean } = {},
): Promise<TaskId<R>> {
	return conversation.commit((tx) => tx.createTask(task, null, options), context);
}

async function openRoot(
	tasks: Parameters<typeof openTasks>[1],
	options: Parameters<typeof openTasks>[2] & { readonly storage?: MemoryStorage } = {},
) {
	const opened = await openTasks(options.storage ?? new MemoryStorage(), tasks, options);
	const root = await opened.harness.root(context);
	return { ...opened, root };
}

/** Start `abortTask()` and resolve once its mark is durable, before it has joined the run. */
async function markDurably(
	harness: Awaited<ReturnType<typeof openRoot>>["harness"],
	id: TaskId,
): Promise<{ readonly aborting: Promise<unknown> }> {
	const aborting = harness.abortTask(id, context);
	while (!(await harness.getTask(id, context))?.abortRequested) await flush();
	return { aborting };
}

function withSignal(signal: AbortSignal): Context {
	return { ...context, abortSignal: signal };
}

describe("task phases", () => {
	it("continues one invocation through checkpoint progress and completes with a typed result", async () => {
		const seen: number[] = [];
		const runtimes = new Set<unknown>();
		const Counter = defineTask<{ to: number }, { phase: "count"; n: number }, number>({
			name: "test.counter",
			version: 1,
			initial: () => ({ phase: "count", n: 0 }),
			phases: {
				count: async (task, runtime, ctx) => {
					seen.push(task.state.checkpoint.n);
					runtimes.add(runtime);
					await runtime.commit((_tx, current) => {
						const n = current.state.checkpoint.n + 1;
						return n === task.input.to ? completed(n) : { status: "running", checkpoint: { phase: "count", n } };
					}, ctx);
				},
			},
			abort: async () => {},
		});
		const { harness, root } = await openRoot([Counter]);
		const id = await root.commit((tx) => tx.createTask(Counter, { to: 3 }), context);
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		const result: number | undefined =
			receipt.state.outcome.status === "completed" ? receipt.state.outcome.result : undefined;
		expect(result).toBe(3);
		expect(seen).toEqual([0, 1, 2]);
		expect(runtimes.size).toBe(1);
		await harness.close(context);
	});

	it("faults a phase without durable progress and a throwing phase", async () => {
		const Idle = oneStep("test.idle", async () => {});
		const DocumentOnly = oneStep("test.document-only", async (_task, runtime, ctx) => {
			// A commit that returns no state is not progress.
			await runtime.commit(() => undefined, ctx);
		});
		const Throws = oneStep("test.throws", async () => {
			throw new Error("boom");
		});
		const { harness, root } = await openRoot([Idle, DocumentOnly, Throws]);
		const ids = [await start(root, Idle), await start(root, DocumentOnly), await start(root, Throws)];
		harness.resume();
		const outcomes = await Promise.all(ids.map(async (id) => (await harness.waitForTask(id, context)).state.outcome));
		expect(outcomes).toEqual([
			{ status: "faulted", error: { message: "Task test.idle phase run returned without durable progress" } },
			{
				status: "faulted",
				error: { message: "Task test.document-only phase run returned without durable progress" },
			},
			{ status: "faulted", error: { message: "boom" } },
		]);
		await harness.close(context);
	});

	it("keeps a committed terminal outcome when the handler throws afterwards", async () => {
		let lateCommit: unknown;
		const Done = oneStep<string>("test.done", async (_task, runtime, ctx) => {
			await runtime.commit(() => completed("ok"), ctx);
			lateCommit = await runtime.commit(() => undefined, ctx).catch((error: unknown) => error);
			throw new Error("after terminal");
		});
		const { harness, root } = await openRoot([Done]);
		const id = await start(root, Done);
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: "ok" });
		await eventually(() => lateCommit !== undefined);
		expect(String(lateCommit)).toContain(`Task ${id} is terminal`);
		await harness.close(context);
	});

	it("compares checkpoints by value, including arrays", async () => {
		const Collect = defineTask<null, { phase: "collect"; items: string[] }, null>({
			name: "test.collect",
			version: 1,
			initial: () => ({ phase: "collect", items: [] }),
			phases: {
				collect: async (task, runtime, ctx) => {
					const items = task.state.checkpoint.items;
					// Two rounds of progress, then an equal copy of the checkpoint, which is no progress.
					const next = items.length < 2 ? [...items, `item${items.length}`] : [...items];
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "collect", items: next } }), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness, root } = await openRoot([Collect]);
		const id = await root.commit((tx) => tx.createTask(Collect, null), context);
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "faulted",
			error: { message: "Task test.collect phase collect returned without durable progress" },
		});
		await harness.close(context);
	});

	it("commits results with entries atomically, keeps memos until terminal, and retires task documents", async () => {
		const Progress = defineDoc<{ lines: string[] }>({
			kind: "test.task-progress",
			version: 1,
			scope: "task",
			initial: () => ({ lines: [] }),
		});
		const Answer = defineEntry("answer");
		const Child = oneStep("test.child", async (_task, runtime, ctx) => {
			await runtime.commit(() => completed(null), ctx);
		});
		let childId: TaskId | undefined;
		let progressSeen: unknown;
		const Writer = defineTask<null, { phase: "write" } | { phase: "answer" }, { entryId: EntryId }>({
			name: "test.writer",
			version: 1,
			initial: () => ({ phase: "write" }),
			phases: {
				write: async (task, runtime, ctx) => {
					expect(await runtime.memo("choice", ctx)).toBeUndefined();
					const winners = await Promise.all([runtime.memo("choice", "a", ctx), runtime.memo("choice", "b", ctx)]);
					expect(winners).toEqual(["a", "a"]);
					expect(await runtime.memo("choice", ctx)).toBe("a");
					// Memo names never resolve to inherited object properties.
					expect(await runtime.memo("toString", ctx)).toBeUndefined();
					expect(await runtime.memo("toString", "own", ctx)).toBe("own");
					await runtime.commit(async (tx) => {
						(await tx.doc(Progress, task.id)).lines.push("wrote");
						// Task creation defaults to the task's own conversation.
						childId = await tx.createTask(Child, null);
						return { status: "running", checkpoint: { phase: "answer" } };
					}, ctx);
				},
				answer: async (task, runtime, ctx) => {
					expect(task.memos).toEqual({ choice: "a", toString: "own" });
					await runtime.commit(async (tx) => {
						progressSeen = [...(await tx.doc(Progress, task.id)).lines];
					}, ctx);
					await runtime.commit(async (tx, current) => {
						const entry = await tx.appendEntry(current.conversationId, { kind: "answer", model: [user("done")] });
						return completed({ entryId: entry.id });
					}, ctx);
				},
			},
			abort: async () => {},
		});
		const { harness, root } = await openRoot([Writer, Child]);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const id = await conversation.commit((tx) => tx.createTask(Writer, null), context);
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state).not.toHaveProperty("checkpoint");
		expect(receipt).not.toHaveProperty("memos");
		const outcome = receipt.state.outcome;
		if (outcome.status !== "completed") throw new Error("expected completion");
		const entry = await harness.commit((tx) => tx.entry(outcome.result.entryId), context);
		expect(Answer.is(entry)).toBe(true);
		expect(entry?.conversationId).toBe(conversation.id);
		expect(progressSeen).toEqual(["wrote"]);
		expect(await harness.snapshot(Progress, id, context)).toBeUndefined();
		expect(await harness.getTask(id, context)).toEqual(receipt);
		expect((await harness.waitForTask(childId!, context)).conversationId).toBe(conversation.id);
		expect(root.id).not.toBe(conversation.id);
		await harness.close(context);
	});

	it("waits for dependencies, which any terminal outcome satisfies", async () => {
		const gate = deferred();
		const order: string[] = [];
		const First = oneStep("test.first", async (_task, runtime, ctx) => {
			order.push("first");
			await gate.promise;
			await runtime.commit(() => completed(null), ctx);
		});
		const Faulting = oneStep("test.faulting", async () => {
			order.push("faulting");
			throw new Error("fails");
		});
		const Second = oneStep("test.second", async (_task, runtime, ctx) => {
			order.push("second");
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([First, Faulting, Second]);
		const first = await start(root, First);
		const faulting = await start(root, Faulting, { after: [first] });
		const second = await start(root, Second, { after: [first, faulting] });
		harness.resume();
		await eventually(() => order.length === 1);
		await flush();
		expect(order).toEqual(["first"]);
		expect((await harness.getTask(second, context))?.state.status).toBe("pending");
		gate.resolve();
		await harness.waitForTask(second, context);
		expect(order).toEqual(["first", "faulting", "second"]);
		expect((await harness.getTask(faulting, context))?.state).toMatchObject({ outcome: { status: "faulted" } });
		await harness.close(context);
	});

	it("keeps one registry snapshot per phase and refreshes it at the phase boundary", async () => {
		const seen: { phase: string; tools: string[]; same: boolean }[] = [];
		const phaseGate = deferred();
		const entered = deferred();
		const tools = (snapshot: RegistrySnapshot) => snapshot.toolNames().slice();
		const Snapshots = defineTask<null, { phase: "a" } | { phase: "b" }, null>({
			name: "test.snapshots",
			version: 1,
			initial: () => ({ phase: "a" }),
			phases: {
				a: async (_task, runtime, ctx) => {
					const before = runtime.registry;
					entered.resolve();
					await phaseGate.promise;
					seen.push({ phase: "a", tools: tools(runtime.registry), same: runtime.registry === before });
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "b" } }), ctx);
				},
				b: async (_task, runtime, ctx) => {
					seen.push({ phase: "b", tools: tools(runtime.registry), same: true });
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness, registry, root } = await openRoot([Snapshots]);
		const id = await root.commit((tx) => tx.createTask(Snapshots, null), context);
		harness.resume();
		await entered.promise;
		registry.tools.add({
			name: "late",
			description: "late",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({}),
		});
		phaseGate.resolve();
		await harness.waitForTask(id, context);
		expect(seen).toEqual([
			{ phase: "a", tools: [], same: true },
			{ phase: "b", tools: ["late"], same: true },
		]);
		await harness.close(context);
	});
});

describe("task runtime", () => {
	it("rejects runtime operations after the invocation ends and stops its watches", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.task-notes",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		let captured: StepRuntime<null> | undefined;
		let watchClosed: Promise<unknown> | undefined;
		const delivered: string[] = [];
		const Absent = defineDoc<{ text: string }>({
			kind: "test.task-absent",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		let absent: unknown = "unset";
		const Watcher = oneStep("test.watcher", async (_task, runtime, ctx) => {
			captured = runtime;
			absent = await runtime.watchDoc(Absent, ctx);
			const watch = await runtime.watchDoc(Notes, ctx);
			watch!.start(async (value) => {
				delivered.push(value?.text ?? "retired");
			});
			watchClosed = watch?.closed;
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([Watcher]);
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "hello";
		}, context);
		const id = await start(root, Watcher);
		harness.resume();
		await harness.waitForTask(id, context);
		expect(absent).toBeUndefined();
		// The watch stops when the step after the phase ends the invocation; later commits deliver nothing.
		expect(await watchClosed).toEqual({ reason: "stopped" });
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "after";
		}, context);
		await flush();
		expect(delivered).toEqual([]);
		const runtime = captured!;
		await expect(runtime.commit(() => {}, context)).rejects.toThrow("invocation has ended");
		await expect(runtime.memo("x", context)).rejects.toThrow("invocation has ended");
		await expect(runtime.memo("x", 1, context)).rejects.toThrow("invocation has ended");
		await expect(runtime.sleep(0, context)).rejects.toThrow("invocation has ended");
		await expect(runtime.watchDoc(Notes, context)).rejects.toThrow("invocation has ended");
		await harness.close(context);
	});

	it("reads committed documents and context through the runtime, and forwards the clock and reports", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.runtime-notes",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ text: "" }),
		});
		let captured: StepRuntime<null> | undefined;
		const seen: unknown[] = [];
		const Reader = oneStep("test.reader", async (_task, runtime, ctx) => {
			captured = runtime;
			const [first, second] = [...(await runtime.context(runtime.conversationId, ctx)).entries].map(
				(entry) => entry.id,
			);
			seen.push((await runtime.snapshot(Notes, runtime.conversationId, ctx))?.text);
			seen.push((await runtime.snapshotAsOf(Notes, runtime.conversationId, first!, ctx))?.text);
			seen.push((await runtime.context(runtime.conversationId, ctx, first)).entries.length);
			seen.push((await runtime.context(runtime.conversationId, ctx, second)).messages.length);
			seen.push(runtime.now());
			runtime.report(new Error("reported"));
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root, reports } = await openRoot([Reader], { now: () => 1234 });
		for (const text of ["one", "two"]) {
			await root.commit(async (tx) => {
				(await tx.doc(Notes, root.id)).text = text;
				await tx.appendEntry(root.id, { kind: "message", model: [user(text)] });
			}, context);
		}
		const id = await start(root, Reader);
		harness.resume();
		await harness.waitForTask(id, context);
		expect(seen).toEqual(["two", "one", 1, 2, 1234]);
		expect(reports).toEqual([new Error("reported")]);
		// The step after the phase ends the invocation.
		await flush();
		await expect(captured!.snapshot(Notes, root.id, context)).rejects.toThrow("invocation has ended");
		await expect(captured!.context(root.id, context)).rejects.toThrow("invocation has ended");
		await harness.close(context);
	});

	it("orders runtime commits against the step: one queued before it lands, one after it rejects", async () => {
		const storage = new ControlledStorage();
		let before: Promise<void> | undefined;
		let after: Promise<void> | undefined;
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		const Detached = oneStep<string>("test.detached", async (_task, runtime) => {
			// Hold the line, queue a commit without awaiting it, and return; the step queues behind that commit.
			held = storage.holdCommits();
			void harnessRef!.commit(async (tx) => {
				await tx.appendEntry(runtime.conversationId, { kind: "blocker" });
			}, context);
			before = runtime.commit(() => completed("before"), context);
			// Queued after the handler returned, so after the step.
			setTimeout(() => {
				after = runtime.commit(() => completed("after"), context);
			}, 0);
		});
		const { harness, root } = await openRoot([Detached], { storage });
		harnessRef = harness;
		const id = await start(root, Detached);
		harness.resume();
		await eventually(() => held !== undefined);
		await held!.entered;
		await eventually(() => after !== undefined);
		held!.release();
		await before;
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: "before" });
		await expect(after).rejects.toThrow(/invocation has ended|is terminal/);
		await harness.close(context);
	});

	it("stops a watch whose acquisition finishes after the invocation ended", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.late-watch",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const storage = new ControlledStorage();
		let watching: Promise<unknown> | undefined;
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		const Late = oneStep("test.late-watch", async (_task, runtime) => {
			held = storage.holdCommits();
			void harnessRef!.commit(async (tx) => {
				await tx.appendEntry(runtime.conversationId, { kind: "blocker" });
			}, context);
			// Starts after the handler returned, so its line job queues behind the step that ends the invocation.
			setTimeout(() => {
				watching = runtime.watchDoc(Notes, context).catch((error: unknown) => error);
			}, 0);
		});
		const { harness, root } = await openRoot([Late], { storage });
		harnessRef = harness;
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "x";
		}, context);
		const id = await start(root, Late);
		harness.resume();
		await eventually(() => held !== undefined);
		await held!.entered;
		await eventually(() => watching !== undefined);
		held!.release();
		expect(String(await watching)).toContain("invocation has ended");
		expect((await harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "faulted" });
		await harness.close(context);
	});

	it("sleeps until the Harness clock reaches the deadline, rechecking after each timer", async () => {
		let clock = 1_000;
		const woke = deferred();
		const Sleeper = oneStep("test.sleeper", async (_task, runtime, ctx) => {
			await runtime.sleep(900, ctx);
			await runtime.sleep(1_005, ctx);
			woke.resolve();
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([Sleeper], { now: () => clock });
		const id = await start(root, Sleeper);
		harness.resume();
		// The clock stands still, so real timers keep firing without waking the task.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await settled(woke.promise)).toBe(false);
		clock = 1_005;
		await harness.waitForTask(id, context);
		await harness.close(context);
	});

	it("rejects a sleep when the invocation is signalled or the sleep's own context is cancelled", async () => {
		const results: string[] = [];
		const sleeping = deferred();
		const Signalled = oneStep("test.sleep-signalled", async (_task, runtime, ctx) => {
			sleeping.resolve();
			await runtime.sleep(Date.now() + 60_000, ctx).catch((error: unknown) => {
				results.push(`signalled:${(error as Error).name}`);
				throw error;
			});
		});
		const Cancelled = oneStep("test.sleep-cancelled", async (_task, runtime, ctx) => {
			const controller = new AbortController();
			const sleeping = runtime.sleep(Date.now() + 60_000, withSignal(controller.signal));
			controller.abort(new Error("stop sleeping"));
			await sleeping.catch((error: unknown) => results.push(`cancelled:${(error as Error).message}`));
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([Signalled, Cancelled]);
		const signalled = await start(root, Signalled);
		const cancelled = await start(root, Cancelled);
		harness.resume();
		await harness.waitForTask(cancelled, context);
		await sleeping.promise;
		await harness.abortTask(signalled, context);
		expect((await harness.waitForTask(signalled, context)).state.outcome).toEqual({
			status: "aborted",
			reason: "test",
		});
		expect(results).toEqual(["cancelled:stop sleeping", "signalled:AbortError"]);
		await harness.close(context);
	});
});

describe("task scheduling", () => {
	it("retries reservation on the next wakeup after a rejected reservation commit", async () => {
		let runs = 0;
		const Once = oneStep("test.once", async (_task, runtime, ctx) => {
			runs++;
			await runtime.commit(() => completed(null), ctx);
		});
		const storage = new ControlledStorage();
		const { harness, root, registry, reports } = await openRoot([Once], { storage });
		const id = await start(root, Once);
		storage.failNextCommit(new StorageRejected("busy"));
		harness.resume();
		await eventually(() => reports.length === 1);
		expect((await harness.getTask(id, context))?.state.status).toBe("pending");
		// Any wakeup, here a registry change, reserves again.
		registry.tools.add({
			name: "wake",
			description: "wake",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({}),
		});
		await harness.waitForTask(id, context);
		expect(runs).toBe(1);
		await harness.close(context);
	});

	it("keeps a wakeup that arrives while a rejected reservation commit is in storage", async () => {
		const First = oneStep("test.wake-first", async (_task, runtime, ctx) => {
			await runtime.commit(() => completed(null), ctx);
		});
		const Late = oneStep("test.wake-late", async (_task, runtime, ctx) => {
			await runtime.commit(() => completed(null), ctx);
		});
		const storage = new ControlledStorage();
		const { harness, root, registry } = await openRoot([First], { storage });
		const first = await start(root, First);
		const late = await start(root, Late);
		const held = storage.holdCommits();
		storage.failNextCommit(new StorageRejected("busy"));
		harness.resume();
		await held.entered;
		// Registering the missing definition wakes the scheduler while the doomed reservation is in storage.
		registry.tasks.add(Late);
		held.release();
		await harness.waitForTask(first, context);
		await harness.waitForTask(late, context);
		await harness.close(context);
	});

	it("reruns a task whose fault write was rejected", async () => {
		let runs = 0;
		const storage = new ControlledStorage();
		const Throws = oneStep("test.rejected-fault", async () => {
			runs++;
			// The next commit is the step's fault write.
			if (runs === 1) storage.failNextCommit(new StorageRejected("busy"));
			throw new Error("boom");
		});
		const { harness, root, reports } = await openRoot([Throws], { storage });
		const id = await start(root, Throws);
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "faulted",
			error: { message: "boom" },
		});
		expect(runs).toBe(2);
		expect(reports.map(String)).toEqual(["StorageRejected: busy"]);
		await harness.close(context);
	});

	it("waits for Harness and conversation idleness, counting blocked work and ignoring background tasks", async () => {
		const gates = new Map<TaskId, () => void>();
		const Gated = oneStep("test.gated", async (task, runtime, ctx) => {
			await new Promise<void>((resolve) => gates.set(task.id, resolve));
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([Gated]);
		await harness.waitForIdle(context);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const foreground = await start(root, Gated);
		const background = await start(root, Gated, { background: true });
		const elsewhere = await start(other, Gated);
		// Work that has not started yet is live; cancelling a wait only rejects that wait.
		const cancelled = new AbortController();
		const cancelledWait = harness.waitForIdle(withSignal(cancelled.signal));
		cancelled.abort(new Error("stop waiting"));
		await expect(cancelledWait).rejects.toThrow("stop waiting");
		const aborted = new AbortController();
		aborted.abort(new Error("already cancelled"));
		await expect(root.waitForIdle(withSignal(aborted.signal))).rejects.toThrow("already cancelled");
		harness.resume();
		await eventually(() => gates.size === 3);
		const rootIdle = root.waitForIdle(context);
		const harnessIdle = harness.waitForIdle(context);
		gates.get(foreground)!();
		await rootIdle;
		expect(await settled(harnessIdle)).toBe(false);
		gates.get(elsewhere)!();
		await harnessIdle;
		expect((await harness.getTask(background, context))?.state.status).toBe("running");
		gates.get(background)!();
		await harness.waitForTask(background, context);
		await harness.close(context);
		await expect(harness.waitForIdle(context)).rejects.toThrow("closed");
		await expect(root.waitForIdle(context)).rejects.toThrow("closed");
	});

	it("rejects unknown tasks and reports terminal tasks", async () => {
		const Done = oneStep("test.quick", async (_task, runtime, ctx) => {
			await runtime.commit(() => completed(null), ctx);
		});
		const { harness, root } = await openRoot([Done]);
		const unknown = 999_999 as TaskId;
		expect(await harness.getTask(unknown, context)).toBeUndefined();
		await expect(harness.waitForTask(unknown, context)).rejects.toThrow("does not exist");
		await expect(harness.abortTask(unknown, context)).rejects.toThrow("does not exist");
		const id = await start(root, Done);
		harness.resume();
		await harness.waitForTask(id, context);
		expect(await harness.waitForTask(id, context)).toMatchObject({ state: { status: "terminal" } });
		expect(await harness.abortTask(id, context)).toBe("terminal");
		await harness.close(context);
		expect(() => harness.resume()).toThrow("closed");
	});

	it("rejects task waits cancelled or closed while queued on the line, and pending waits on close", async () => {
		const gate = deferred();
		const Blocking = gated("test.wait-close", gate.promise);
		const storage = new ControlledStorage();
		const { harness, root } = await openRoot([Blocking], { storage });
		const id = await start(root, Blocking);

		// Hold the line with a commit, then queue waits behind it.
		const held = storage.holdCommits();
		const blocker = harness.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "blocker" });
		}, context);
		await held.entered;
		const controller = new AbortController();
		const cancelledWhileQueued = harness.waitForTask(id, withSignal(controller.signal));
		controller.abort(new Error("wait cancelled"));
		held.release();
		await blocker;
		await expect(cancelledWhileQueued).rejects.toThrow("wait cancelled");

		const pending = harness.waitForTask(id, context);
		const idle = harness.waitForIdle(context);
		const conversationIdle = root.waitForIdle(context);
		await flush();
		const heldAgain = storage.holdCommits();
		const blockerAgain = harness.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "blocker" });
		}, context);
		await heldAgain.entered;
		const closedWhileQueued = harness.waitForTask(id, context);
		const closing = harness.close(context);
		heldAgain.release();
		await blockerAgain;
		await expect(closedWhileQueued).rejects.toThrow("closed");
		await expect(pending).rejects.toThrow("closed");
		await expect(idle).rejects.toThrow("closed");
		await expect(conversationIdle).rejects.toThrow("closed");
		gate.resolve();
		await closing;
	});
});

describe("task abort", () => {
	it("rejects the run's commits and memo writes after the mark, and settles through a fresh abort invocation", async () => {
		const reached = deferred();
		const errors: string[] = [];
		let memoRead: unknown;
		const abortRuntimes: unknown[] = [];
		let runRuntime: unknown;
		const Marked = oneStep(
			"test.marked",
			async (_task, runtime, ctx) => {
				runRuntime = runtime;
				await runtime.memo("kept", 1, ctx);
				reached.resolve();
				// Keep working after the signal: every later write of this run must reject.
				await aborted(runtime.signal).catch(() => {});
				memoRead = await runtime.memo("kept", context);
				await runtime.memo("late", 2, context).catch((error: unknown) => errors.push((error as Error).message));
				await runtime
					.commit(() => completed(null), context)
					.catch((error: unknown) => {
						errors.push((error as Error).message);
					});
			},
			async (runtime, ctx) => {
				abortRuntimes.push(runtime);
				await runtime.commit((_tx, current) => {
					expect(current.abortRequested).toBe(true);
					expect(current.memos).toEqual({ kept: 1 });
					return abortedWith("mark");
				}, ctx);
			},
		);
		const { harness, root } = await openRoot([Marked]);
		const id = await start(root, Marked);
		harness.resume();
		await reached.promise;
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "mark" });
		expect(memoRead).toBe(1);
		expect(errors).toEqual([`Task ${id} has a durable abort mark`, `Task ${id} has a durable abort mark`]);
		expect(abortRuntimes).toHaveLength(1);
		expect(abortRuntimes[0]).not.toBe(runRuntime);
		await harness.close(context);
	});

	it("starts no further phase after a mark that lands during a phase with progress", async () => {
		const reached = deferred();
		const proceed = deferred();
		const phases: string[] = [];
		const Two = defineTask<null, { phase: "one" } | { phase: "two" }, null>({
			name: "test.mark-boundary",
			version: 1,
			initial: () => ({ phase: "one" }),
			phases: {
				one: async (_task, runtime, ctx) => {
					phases.push("one");
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "two" } }), ctx);
					reached.resolve();
					// Ignores the signal and returns normally after the mark.
					await proceed.promise;
				},
				two: async () => {
					phases.push("two");
				},
			},
			abort: async (_task, runtime, ctx) => {
				phases.push("abort");
				await runtime.commit(() => abortedWith("boundary"), ctx);
			},
		});
		const { harness, root } = await openRoot([Two]);
		const id = await root.commit((tx) => tx.createTask(Two, null), context);
		harness.resume();
		await reached.promise;
		const { aborting } = await markDurably(harness, id);
		proceed.resolve();
		expect(await aborting).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "boundary" });
		expect(phases).toEqual(["one", "abort"]);
		await harness.close(context);
	});

	it("signals and joins the run before returning, then runs the abort handler", async () => {
		const reached = deferred();
		let runEnded = false;
		const Signalled = oneStep("test.signalled", async (_task, runtime) => {
			reached.resolve();
			try {
				await aborted(runtime.signal);
			} finally {
				runEnded = true;
			}
		});
		const { harness, root } = await openRoot([Signalled]);
		const id = await start(root, Signalled);
		harness.resume();
		await reached.promise;
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect(runEnded).toBe(true);
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "test" });
		await harness.close(context);
	});

	it("aborts pending work regardless of dependencies and faults abort handlers that throw or settle nothing", async () => {
		const gate = deferred();
		const First = gated("test.dependency", gate.promise);
		const Lazy = oneStep(
			"test.lazy-abort",
			async () => {},
			async () => {},
		);
		const Throwing = oneStep(
			"test.throwing-abort",
			async () => {},
			async () => {
				throw new Error("abort failed");
			},
		);
		const { harness, root } = await openRoot([First, Lazy, Throwing]);
		const first = await start(root, First);
		const lazy = await start(root, Lazy, { after: [first] });
		const throwing = await start(root, Throwing, { after: [first] });
		harness.resume();
		await harness.abortTask(lazy, context);
		await harness.abortTask(throwing, context);
		expect((await harness.waitForTask(lazy, context)).state.outcome).toEqual({
			status: "faulted",
			error: { message: `Abort handler of task ${lazy} returned without a terminal outcome` },
		});
		expect((await harness.waitForTask(throwing, context)).state.outcome).toEqual({
			status: "faulted",
			error: { message: "abort failed" },
		});
		expect((await harness.getTask(first, context))?.state.status).toBe("running");
		gate.resolve();
		await harness.waitForTask(first, context);
		await harness.close(context);
	});

	it("does not signal a running abort handler when aborted again, and a cancelled caller leaves the mark durable", async () => {
		const reached = deferred();
		const proceed = deferred();
		const runRelease = deferred();
		let abortSignalled: boolean | undefined;
		let aborts = 0;
		const Run = oneStep(
			"test.abort-again",
			async () => {
				// Ignores the signal, so the first caller is still joining when it gives up.
				await runRelease.promise;
			},
			async (runtime, ctx) => {
				aborts++;
				reached.resolve();
				await proceed.promise;
				abortSignalled = runtime.signal.aborted;
				await runtime.commit(() => abortedWith("once"), ctx);
			},
		);
		const { harness, root } = await openRoot([Run]);
		const id = await start(root, Run);
		harness.resume();
		await flush();
		// This caller gives up while joining; the mark and the abort invocation are unaffected.
		const controller = new AbortController();
		const cancelled = harness.abortTask(id, withSignal(controller.signal));
		while (!(await harness.getTask(id, context))?.abortRequested) await flush();
		controller.abort(new Error("caller gave up"));
		await expect(cancelled).rejects.toThrow("caller gave up");
		runRelease.resolve();
		await reached.promise;
		expect(await harness.abortTask(id, context)).toBe("marked");
		proceed.resolve();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "once" });
		expect(abortSignalled).toBe(false);
		expect(aborts).toBe(1);
		await harness.close(context);
	});

	it("keeps a terminal outcome committed by an abort handler that throws afterwards", async () => {
		const Run = oneStep(
			"test.abort-then-throw",
			async (_task, runtime) => {
				await aborted(runtime.signal);
			},
			async (runtime, ctx) => {
				await runtime.commit(() => abortedWith("done"), ctx);
				throw new Error("after terminal");
			},
		);
		const { harness, root } = await openRoot([Run]);
		const id = await start(root, Run);
		harness.resume();
		await flush();
		await harness.abortTask(id, context);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "done" });
		await harness.close(context);
	});

	it("never starts phase one when the abort lands while the reservation settles", async () => {
		let ran = false;
		const Reserved = oneStep("test.reserved", async (_task, runtime) => {
			ran = true;
			await aborted(runtime.signal);
		});
		const storage = new ControlledStorage();
		const { harness, root } = await openRoot([Reserved], { storage });
		const id = await start(root, Reserved);
		const held = storage.holdCommits();
		harness.resume();
		await held.entered;
		// The reservation commit is in storage; the abort mark commit queues behind it.
		const aborting = harness.abortTask(id, context);
		held.release();
		expect(await aborting).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "test" });
		expect(ran).toBe(false);
		await harness.close(context);
	});

	it("lets an abort mark win over a fault that races it", async () => {
		const storage = new ControlledStorage();
		let marking: Promise<unknown> | undefined;
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		const Racing = oneStep("test.racing-fault", async (task) => {
			held = storage.holdCommits();
			marking = harnessRef!.abortTask(task.id, context);
			await held.entered;
			// The mark is in storage but not committed when the handler throws, so the fault commit queues behind it.
			throw new Error("would fault");
		});
		const { harness, root } = await openRoot([Racing], { storage });
		harnessRef = harness;
		const id = await start(root, Racing);
		harness.resume();
		await eventually(() => held !== undefined);
		await held!.entered;
		await flush();
		held!.release();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "test" });
		expect(await marking).toBe("marked");
		await harness.close(context);
	});
});

describe("task close", () => {
	it("stops without outcomes and starts no fresh phase or abort invocation while closing", async () => {
		const reached = deferred();
		const proceed = deferred();
		const phases: string[] = [];
		let abortRan = false;
		const Two = defineTask<null, { phase: "one" } | { phase: "two" }, null>({
			name: "test.two",
			version: 1,
			initial: () => ({ phase: "one" }),
			phases: {
				one: async (_task, runtime, ctx) => {
					phases.push("one");
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "two" } }), ctx);
					reached.resolve();
					// Ignores signals and returns normally once released; the closing rule wins over the next phase.
					await proceed.promise;
				},
				two: async () => {
					phases.push("two");
				},
			},
			abort: async () => {
				abortRan = true;
			},
		});
		const storage = new ControlledStorage();
		const { harness, root } = await openRoot([Two], { storage });
		const id = await root.commit((tx) => tx.createTask(Two, null), context);
		harness.resume();
		await reached.promise;
		const { aborting } = await markDurably(harness, id);
		const record = await harness.getTask(id, context);
		const commits = storage.commits.length;
		const closing = harness.close(context);
		proceed.resolve();
		await closing;
		expect(await aborting).toBe("marked");
		expect(storage.commits.length).toBe(commits);
		expect(phases).toEqual(["one"]);
		expect(abortRan).toBe(false);
		expect(record).toMatchObject({
			abortRequested: true,
			state: { status: "running", checkpoint: { phase: "two" } },
		});
		await expect(harness.commit(() => {}, context)).rejects.toThrow("closed");
	});

	it("seals admission before signalling handlers and stops watches before joining them", async () => {
		const Notes = defineDoc<{ text: string }>({
			kind: "test.close-notes",
			version: 1,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const reached = deferred();
		let fromListener: Promise<unknown> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		let watchEnd: unknown;
		const Stubborn = oneStep("test.stubborn", async (_task, runtime) => {
			// Uses a context close does not cancel, then waits for the watch to close.
			const watch = await runtime.watchDoc(Notes, context);
			runtime.signal.addEventListener("abort", () => {
				fromListener = harnessRef!.commit(() => {}, context);
			});
			reached.resolve();
			watchEnd = await watch!.closed;
		});
		const { harness, root } = await openRoot([Stubborn]);
		harnessRef = harness;
		await harness.commit(async (tx) => {
			(await tx.doc(Notes)).text = "x";
		}, context);
		await start(root, Stubborn);
		harness.resume();
		await reached.promise;
		await harness.close(context);
		await expect(fromListener).rejects.toThrow("closed");
		expect(watchEnd).toEqual({ reason: "session_closed" });
	});

	it("writes no fault when close seals while the step after a failed phase is queued", async () => {
		const storage = new ControlledStorage();
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		const Throws = oneStep("test.close-fault", async (_task, runtime) => {
			held = storage.holdCommits();
			void harnessRef!.commit(async (tx) => {
				await tx.appendEntry(runtime.conversationId, { kind: "blocker" });
			}, context);
			throw new Error("would fault");
		});
		const { harness, root } = await openRoot([Throws], { storage });
		harnessRef = harness;
		const id = await start(root, Throws);
		harness.resume();
		await eventually(() => held !== undefined);
		await held!.entered;
		await flush();
		const closing = harness.close(context);
		held!.release();
		await closing;
		const taskWrites = storage.commits.flatMap((writes) =>
			writes.filter((write) => write.type === "task" && write.value.id === id),
		);
		expect(taskWrites.map((write) => (write.type === "task" ? write.value.state.status : ""))).toEqual([
			"pending",
			"running",
		]);
	});

	it("starts no abort handler whose reservation settles while closing", async () => {
		let ran = false;
		const Marked = oneStep(
			"test.close-abort-reservation",
			async () => {},
			async () => {
				ran = true;
			},
		);
		const storage = new ControlledStorage();
		const { harness, root } = await openRoot([Marked], { storage });
		const id = await start(root, Marked);
		expect(await harness.abortTask(id, context)).toBe("marked");
		const held = storage.holdCommits();
		harness.resume();
		await held.entered;
		const closing = harness.close(context);
		held.release();
		await closing;
		expect(ran).toBe(false);
		const writes = storage.commits.at(-1)!.filter((write) => write.type === "task");
		expect(writes).toMatchObject([{ value: { id, abortRequested: true, state: { status: "running" } } }]);
	});

	it("rejects a runtime commit that was queued on the line when close sealed it", async () => {
		const storage = new ControlledStorage();
		let queued: Promise<unknown> | undefined;
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		const proceed = deferred();
		const Queued = oneStep("test.close-queued-commit", async (_task, runtime) => {
			held = storage.holdCommits();
			void harnessRef!.commit(async (tx) => {
				await tx.appendEntry(runtime.conversationId, { kind: "blocker" });
			}, context);
			queued = runtime.commit(() => completed(null), context).catch((error: unknown) => error);
			// Ignores the close signal, so the invocation is still alive when the queued commit reaches the line.
			await proceed.promise;
		});
		const { harness, root } = await openRoot([Queued], { storage });
		harnessRef = harness;
		const id = await start(root, Queued);
		harness.resume();
		await eventually(() => held !== undefined);
		await held!.entered;
		await flush();
		const closing = harness.close(context);
		held!.release();
		expect(String(await queued)).toContain("Harness is closed");
		proceed.resolve();
		await closing;
		const taskWrites = storage.commits.flatMap((writes) =>
			writes.filter((write) => write.type === "task" && write.value.id === id),
		);
		expect(taskWrites).toHaveLength(2);
	});

	it("starts no next phase when close seals during a step that decided to continue", async () => {
		const phases: string[] = [];
		const registry = createRegistry();
		let harnessRef: Awaited<ReturnType<typeof openRoot>>["harness"] | undefined;
		let closing: Promise<void> | undefined;
		let closeOnSnapshot = false;
		// The step refreshes the snapshot after progress, inside its line callback and after its closing check.
		const reader: RegistryReader = {
			snapshot: () => {
				if (closeOnSnapshot) {
					closeOnSnapshot = false;
					closing = harnessRef!.close(context);
				}
				return registry.snapshot();
			},
			subscribe: (listener) => registry.subscribe(listener),
		};
		const Two = defineTask<null, { phase: "one" } | { phase: "two" }, null>({
			name: "test.close-in-step",
			version: 1,
			initial: () => ({ phase: "one" }),
			phases: {
				one: async (_task, runtime, ctx) => {
					phases.push("one");
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "two" } }), ctx);
					closeOnSnapshot = true;
				},
				two: async () => {
					phases.push("two");
				},
			},
			abort: async () => {},
		});
		registry.tasks.add(Two);
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: reader }, context);
		harnessRef = harness;
		const root = await harness.root(context);
		await root.commit((tx) => tx.createTask(Two, null), context);
		harness.resume();
		await eventually(() => closing !== undefined);
		await closing;
		expect(phases).toEqual(["one"]);
	});

	it("joins a reservation that settles while closing without starting its handler", async () => {
		let ran = false;
		const Never = oneStep("test.close-reservation", async () => {
			ran = true;
		});
		const storage = new ControlledStorage();
		const { harness, root } = await openRoot([Never], { storage });
		const id = await start(root, Never);
		const held = storage.holdCommits();
		harness.resume();
		await held.entered;
		const closing = harness.close(context);
		held.release();
		await closing;
		expect(ran).toBe(false);
		const writes = storage.commits.at(-1)!.filter((write) => write.type === "task");
		expect(writes).toMatchObject([{ type: "task", value: { id, state: { status: "running" } } }]);
	});
});
