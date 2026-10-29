// Scheduler memory is bounded by live work: an ended task or a conversation edge is kept only while live work is
// below it, and a chain dropped that way is loaded again from storage when work appears below it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Conversation,
	defineTask,
	type Harness,
	LiveDoc,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULER_INDEX_SIZES } from "../src/harness/harness.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { context } from "./session-support.ts";
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

/** How often each named task started its phase. */
const runs = new Map<string, number>();

/** Holds until its gate opens, then completes; its abort handler ends it `aborted`. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.retention.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			runs.set(task.input.name, (runs.get(task.input.name) ?? 0) + 1);
			const opened = await Promise.race([gate(task.input.name).promise.then(() => true), aborted(runtime.signal)]);
			if (opened !== true) return;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Holds until its gate opens, then creates a held task `inside.<name>` in conversation `input.into` and ends. */
const Spawner = defineTask<{ name: string; into: number }, { phase: "hold" }, null>({
	name: "test.retention.spawner",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			const opened = await Promise.race([gate(task.input.name).promise.then(() => true), aborted(runtime.signal)]);
			if (opened !== true) return;
			await runtime.commit(async (tx) => {
				await tx.createTask(
					Hold,
					{ name: `inside.${task.input.name}` },
					{ ownership: { kind: "conversation" }, conversationId: task.input.into as never },
				);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Rejected commits it caught. */
const rejections: unknown[] = [];

/**
 * Holds until `rejected` opens, then tries one terminal commit that creates a task in conversation `into` and a child of
 * its own, which the Transaction rejects as the task is ending. Catches the rejection and holds.
 */
const Rejected = defineTask<{ into: number }, { phase: "hold" }, null>({
	name: "test.retention.rejected",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			const opened = await Promise.race([gate("rejected").promise.then(() => true), aborted(runtime.signal)]);
			if (opened !== true) return;
			try {
				await runtime.commit(async (tx) => {
					await tx.createTask(
						Hold,
						{ name: "staged" },
						{ ownership: { kind: "conversation" }, conversationId: task.input.into as never },
					);
					await tx.createTask(Hold, { name: "child" }, { ownership: { kind: "task", taskId: task.id } });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			} catch (error) {
				rejections.push(error);
			}
			await aborted(runtime.signal);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type Sizes = Record<"live" | "settled" | "edges" | "below" | "roots" | "unloaded" | "dropQueue", number>;
function sizes(harness: Harness): Sizes {
	return (harness as unknown as Record<symbol, Sizes>)[SCHEDULER_INDEX_SIZES]!;
}

const directories: string[] = [];
afterEach(async () => {
	gates.clear();
	runs.clear();
	rejections.length = 0;
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-retention-"));
	directories.push(directory);
	return join(directory, "session.sqlite");
}

/** Count the task and conversation reads a storage serves. */
function countReads(storage: Storage): { tasks: number; conversations: number } {
	const reads = { tasks: 0, conversations: 0 };
	const task = storage.task.bind(storage);
	const conversation = storage.conversation.bind(storage);
	storage.task = (id, readContext) => {
		reads.tasks++;
		return task(id, readContext);
	};
	storage.conversation = (id, readContext) => {
		reads.conversations++;
		return conversation(id, readContext);
	};
	return reads;
}

async function open(storage?: Storage) {
	const opened = await openTasks(storage ?? (await openNodeSqliteStorage(await sqlitePath())), [
		Hold,
		Spawner,
		Rejected,
	]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

async function status(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

/** Under live `parent`: tool task T owning conversation C, a task in C; all of them end. Returns C. */
async function subagentCycle(harness: Harness, root: Conversation, parent: TaskId, n: number) {
	const { tool, inner, child } = await root.commit(async (tx) => {
		const tool = await tx.createTask(Hold, { name: `tool${n}` }, { ownership: { kind: "task", taskId: parent } });
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: tool } });
		const inner = await tx.createTask(
			Hold,
			{ name: `inner${n}` },
			{ ownership: { kind: "conversation" }, conversationId: child.id },
		);
		return { tool, inner, child: child.id };
	}, context);
	gate(`inner${n}`).resolve();
	gate(`tool${n}`).resolve();
	await harness.waitForTask(inner, context);
	await harness.waitForTask(tool, context);
	return child;
}

describe("scheduler retention", () => {
	it("forgets ended subagent chains once their work ends", async () => {
		const { harness, root } = await open();
		const parent = await root.commit(
			(tx) => tx.createTask(Hold, { name: "parent" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await subagentCycle(harness, root, parent, 0);
		const baseline = sizes(harness);
		for (let n = 1; n <= 200; n++) await subagentCycle(harness, root, parent, n);
		expect(sizes(harness)).toEqual(baseline);
		gate("parent").resolve();
		await harness.waitForTask(parent, context);
		await harness.close(context);
	});

	it("holds a live owner for work later created in a forgotten conversation, loading its chain again", async () => {
		const storage = await openNodeSqliteStorage(await sqlitePath());
		const reads = countReads(storage);
		const { harness, root } = await open(storage);
		// Live P -> ended B -> ended A -> conversation C, empty: forgotten.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, b, a, c: c.id };
		}, context);
		gate("a").resolve();
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const before = sizes(harness);
		const loaded = reads.tasks + reads.conversations;
		const c = (await harness.conversation(tree.c, context))!;
		const d = await c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		gate("p").resolve();
		await eventually(async () => (await status(harness, tree.p)).status === "completing");
		expect(reads.tasks + reads.conversations).toBeGreaterThan(loaded);
		gate("d").resolve();
		expect((await harness.waitForTask(d, context)).state.outcome.status).toBe("completed");
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		expect(sizes(harness).settled).toBeLessThanOrEqual(before.settled);
		await harness.close(context);
	});

	it("holds an owner for work its own terminal commit creates below a forgotten chain", async () => {
		const { harness, root } = await open();
		// Live P (a spawner) -> ended B -> ended A -> conversation C, empty: forgotten. P's terminal commit creates D in C.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Spawner, { name: "p", into: 0 }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, b, c: c.id };
		}, context);
		// Point the spawner at C, now that its ID is known.
		await root.commit(async (tx) => {
			const record = (await tx.task(tree.p))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...record,
				input: { name: "p", into: tree.c },
			});
		}, context);
		gate("a").resolve();
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		gate("p").resolve();
		await eventually(async () => (await status(harness, tree.p)).status !== "running");
		expect((await status(harness, tree.p)).status).toBe("completing");
		gate("inside.p").resolve();
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("withdraws an input queued in a forgotten conversation below an abort-marked owner", async () => {
		const { harness, root } = await open();
		// Live P -> ended B -> conversation C with no task; C gets a queued input while P is cancelling.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			// A live child keeps P holding its abort until the input is withdrawn and the child ends.
			const keep = await tx.createTask(Hold, { name: "keep" }, { ownership: { kind: "task", taskId: p } });
			return { p, b, c: c.id, keep };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const c = (await harness.conversation(tree.c, context))!;
		// Busy, so the input queues instead of starting a run.
		await c.commit(async (tx) => {
			(await tx.doc(LiveDoc, tree.c)).run = { taskId: tree.keep, inputs: [], turns: 0 };
		}, context);
		const queued = (await c.submit({ type: "input", content: "later" }, context)).id;
		await harness.abortTask(tree.p, context);
		await eventually(async () => {
			const settledState = await (await harness.submission(queued, context))!.status(context);
			return settledState.status === "unanswered";
		});
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({ reason: "aborted" });
		await harness.waitForTask(tree.p, context);
		await harness.close(context);
	});

	it("aborts work created in a forgotten conversation below an abort-marked owner before it runs", async () => {
		const { harness, root } = await open();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const keep = await tx.createTask(Hold, { name: "keep" }, { ownership: { kind: "task", taskId: p } });
			return { p, b, c: c.id, keep };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		// P cancels; its live child keeps it holding.
		await harness.commit(async (tx) => {
			const record = (await tx.task(tree.p))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested: true });
		}, context);
		await eventually(async () => (await harness.getTask(tree.keep, context))!.abortRequested);
		const c = (await harness.conversation(tree.c, context))!;
		const late = await c.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		expect(runs.get("late") ?? 0).toBe(0);
		await harness.close(context);
	});

	it("keeps a scope busy while the chain of new work below a forgotten conversation loads", async () => {
		const path = await sqlitePath();
		const storage = await openNodeSqliteStorage(path);
		const { harness, root } = await open(storage);
		const tree = await root.commit(async (tx) => {
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { b, c: c.id };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		// Hold the chain load's read of C: the second read once holding, after the creating commit's own.
		const read = storage.conversation.bind(storage);
		const held = deferred<void>();
		const reached = deferred<void>();
		let holding = false;
		let readsOfC = 0;
		storage.conversation = async (id, readContext) => {
			if (holding && id === tree.c && ++readsOfC === 2) {
				reached.resolve();
				await held.promise;
			}
			return read(id, readContext);
		};
		const c = (await harness.conversation(tree.c, context))!;
		holding = true;
		await c.commit((tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }), context);
		await reached.promise;
		expect(await settled(harness.waitForIdle(context))).toBe(false);
		held.resolve();
		gate("d").resolve();
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("keeps a chain when one commit ends its last task and creates new work below it", async () => {
		const { harness, root } = await open();
		// Live P -> ended B -> conversation C with background task `old`, which keeps the chain known without holding B.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const old = await tx.createTask(
				Hold,
				{ name: "old" },
				{ ownership: { kind: "conversation" }, conversationId: c.id, background: true },
			);
			return { p, b, c: c.id, old };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		// One commit: the old task ends, which leaves nothing live below B, and a replacement starts in C.
		const replacement = await harness.commit(async (tx) => {
			const old = (await tx.task(tree.old))!;
			const id = await tx.createTask(
				Hold,
				{ name: "new" },
				{ ownership: { kind: "conversation" }, conversationId: tree.c },
			);
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...old,
				state: { status: "terminal", outcome: { status: "completed", result: null } },
			});
			return id;
		}, context);
		// The chain stayed known through the publication, so P holds for the replacement.
		gate("p").resolve();
		await eventually(async () => (await status(harness, tree.p)).status === "completing");
		gate("new").resolve();
		await harness.waitForTask(replacement, context);
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("drops what a rejected commit's chain load read, without a later publication", async () => {
		const { harness, root } = await open();
		// Live P owns ended B, which owns conversation C: forgotten. P's terminal commit stages work in C, which loads C's
		// chain, and a child of P, which the Transaction rejects, as P is ending.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Rejected, { into: 0 }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { p, b, c: c.id };
		}, context);
		await root.commit(async (tx) => {
			const record = (await tx.task(tree.p))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, input: { into: tree.c } });
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const baseline = sizes(harness);
		gate("rejected").resolve();
		await eventually(() => rejections.length > 0);
		// The rejected commit published nothing; the sweep job still cleans up what its chain load read.
		await eventually(() => sizes(harness).dropQueue === 0);
		expect(sizes(harness)).toEqual(baseline);
		await harness.close(context);
	});

	it("drops what a read loaded after reopen, without a later publication", async () => {
		const path = await sqlitePath();
		let opened = await open(await openNodeSqliteStorage(path));
		// A live task D in conversation C, owned by ended B: after reopen D's chain is not loaded.
		const tree = await opened.root.commit(async (tx) => {
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const d = await tx.createTask(
				Hold,
				{ name: "d" },
				{ ownership: { kind: "conversation" }, conversationId: c.id },
			);
			return { b, d };
		}, context);
		gate("b").resolve();
		await eventually(async () => (await status(opened.harness, tree.b)).status === "completing");
		await opened.harness.close(context);
		gates.clear();
		opened = await open(await openNodeSqliteStorage(path));
		await opened.harness.inspect(context);
		// D is still live, so its chain stays; once D ends, everything below the root goes, published or not.
		expect(sizes(opened.harness).unloaded).toBe(0);
		gate("d").resolve();
		await opened.harness.waitForTask(tree.d, context);
		await opened.harness.waitForTask(tree.b, context);
		await eventually(() => sizes(opened.harness).dropQueue === 0);
		expect(sizes(opened.harness)).toMatchObject({ settled: 0, below: 0, unloaded: 0 });
		await opened.harness.close(context);
	});

	it("withdraws an input queued two ended levels below an owner whose intent appears later", async () => {
		const { harness, root } = await open();
		// Live P -> ended B -> ended A -> conversation C with no task, and a live child keeping P holding.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			const keep = await tx.createTask(Hold, { name: "keep" }, { ownership: { kind: "task", taskId: p } });
			return { p, b, c: c.id, keep };
		}, context);
		gate("a").resolve();
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const c = (await harness.conversation(tree.c, context))!;
		await c.commit(async (tx) => {
			(await tx.doc(LiveDoc, tree.c)).run = { taskId: tree.keep, inputs: [], turns: 0 };
		}, context);
		// Queued while nothing cancels: no withdrawal scan.
		const queued = (await c.submit({ type: "input", content: "later" }, context)).id;
		await eventually(() => sizes(harness).dropQueue === 0);
		// P fails while its child runs: it holds the failed outcome, which is cancellation intent.
		await harness.commit(async (tx) => {
			const record = (await tx.task(tree.p))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...record,
				state: { status: "completing", outcome: { status: "failed", error: { message: "x" } } },
			});
		}, context);
		await eventually(
			async () => (await (await harness.submission(queued, context))!.status(context)).status === "unanswered",
		);
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({ reason: "aborted" });
		await harness.close(context);
	});

	it("forgets a 20,000-deep chain of ended tasks without recursion", async () => {
		const { harness, root } = await open();
		const depth = 20_000;
		const baseline = sizes(harness);
		const { links, leaf } = await root.commit(async (tx) => {
			const links: TaskId[] = [];
			let owner = await tx.createTask(Hold, { name: "link0" }, { ownership: { kind: "conversation" } });
			links.push(owner);
			for (let n = 1; n < depth; n++) {
				owner = await tx.createTask(Hold, { name: `link${n}` }, { ownership: { kind: "task", taskId: owner } });
				links.push(owner);
			}
			const leaf = await tx.createTask(Hold, { name: "leaf" }, { ownership: { kind: "task", taskId: owner } });
			return { links, leaf };
		}, context);
		for (let n = 0; n < depth; n++) gate(`link${n}`).resolve();
		gate("leaf").resolve();
		await harness.waitForTask(leaf, context);
		await harness.waitForTask(links[0]!, context);
		await harness.waitForIdle(context);
		expect(sizes(harness)).toEqual(baseline);
		await harness.close(context);
	}, 60_000);

	it("keeps no more after all work ended than a fresh reopen", async () => {
		const path = await sqlitePath();
		let opened = await open(await openNodeSqliteStorage(path));
		const parent = await opened.root.commit(
			(tx) => tx.createTask(Hold, { name: "parent" }, { ownership: { kind: "conversation" } }),
			context,
		);
		for (let n = 0; n < 20; n++) await subagentCycle(opened.harness, opened.root, parent, n);
		gate("parent").resolve();
		await opened.harness.waitForTask(parent, context);
		await opened.harness.waitForIdle(context);
		const ended = sizes(opened.harness);
		await opened.harness.close(context);
		opened = await open(await openNodeSqliteStorage(path));
		await opened.harness.waitForIdle(context);
		expect(ended).toEqual(sizes(opened.harness));
		await opened.harness.close(context);
	});

	it("does not scan queued submissions for an input when nothing cancels", async () => {
		const storage = await openNodeSqliteStorage(await sqlitePath());
		let scans = 0;
		const scan = storage.scanSubmissions.bind(storage);
		storage.scanSubmissions = (query, limit, cursor, scanContext) => {
			if (query.status === "queued") scans++;
			return scan(query, limit, cursor, scanContext);
		};
		const { harness, root } = await open(storage);
		const busy = await root.commit(
			(tx) => tx.createTask(Hold, { name: "busy" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).run = { taskId: busy, inputs: [], turns: 0 };
		}, context);
		const before = scans;
		await root.submit({ type: "input", content: "queued" }, context);
		// Let any reconcile it would cause run.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(scans).toBe(before);
		gate("busy").resolve();
		await harness.close(context);
	});

	// A wait on an ended task closes no cycle (#10411), also when the ended task owns the waiter's conversation and the
	// scheduler forgot it: the wait resumes at once.
	it("lets a task wait on a forgotten ended owner", async () => {
		const opened = await openTasks(await openNodeSqliteStorage(await sqlitePath()), [Hold, Waiter]);
		const root = await opened.harness.root(context);
		opened.harness.resume();
		const tree = await root.commit(async (tx) => {
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { b, c: c.id };
		}, context);
		gate("b").resolve();
		await opened.harness.waitForTask(tree.b, context);
		const c = (await opened.harness.conversation(tree.c, context))!;
		const waiter = await c.commit(
			(tx) => tx.createTask(Waiter, { on: [tree.b] }, { ownership: { kind: "conversation" } }),
			context,
		);
		const outcome = (await opened.harness.waitForTask(waiter, context)).state.outcome;
		expect(outcome).toMatchObject({ status: "completed" });
		await opened.harness.close(context);
	});
});

/** Waits on the tasks in its input, then completes. */
const Waiter = defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "done" }, null>({
	name: "test.retention.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, ctx) =>
			runtime.commit(
				() => ({ status: "waiting", checkpoint: { phase: "done" }, on: task.input.on, policy: "allSettled" }),
				ctx,
			),
		done: async (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
