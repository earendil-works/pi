import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	configure,
	createSession,
	defineDoc,
	defineTask,
	defineTool,
	type EntryId,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	StorageRejected,
	type Submission,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred, openTasks, settled } from "./task-support.ts";

/** Outcome a held task commits once its gate opens. */
type Ending = "completed" | "failed";
const gates = new Map<string, Deferred<Ending>>();

function gate(name: string): Deferred<Ending> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<Ending>();
		gates.set(name, found);
	}
	return found;
}

/** How often each named task started its run phase. */
const runs = new Map<string, number>();

/**
 * A task that holds until its named gate opens or it is aborted. With `slowAbort`, its abort handler first waits for
 * the gate `abort.<name>`.
 */
const Hold = defineTask<{ name: string; slowAbort?: boolean }, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			runs.set(task.input.name, (runs.get(task.input.name) ?? 0) + 1);
			const ending = await Promise.race([gate(task.input.name).promise, aborted(runtime.signal)]);
			await runtime.commit(
				() =>
					ending === "completed"
						? { status: "terminal", outcome: { status: "completed", result: null } }
						: { status: "terminal", outcome: { status: "failed", error: { message: "gate failed" } } },
				ctx,
			);
		},
	},
	abort: async (task, runtime, ctx) => {
		if (task.input.slowAbort === true) await gate(`abort.${task.input.name}`).promise;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

/** Waits on the tasks in its input, then completes; its abort handler ends it `aborted`. */
const Waiter = defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "done" }, null>({
	name: "test.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, ctx) => {
			const checkpoint = { phase: "done" } as const;
			await runtime.commit(() => ({ status: "waiting", checkpoint, on: task.input.on, policy: "allSettled" }), ctx);
		},
		done: async (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Never registered: aborting it can only orphan it. */
const Unregistered = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.unregistered",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: async () => {} },
	abort: async () => {},
});

function open(name: string, ending: Ending): void {
	gate(name).resolve(ending);
}

const directories = new Set<string>();
afterEach(async () => {
	gates.clear();
	runs.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

type Tree = { owner: TaskId; child: ConversationId; inner: TaskId };

/** In `parent`, stage task `owner` and a conversation it owns holding task `inner`, in one commit. */
async function ownedChild(
	parent: Conversation,
	name: string,
	options: { background?: boolean; slowInner?: boolean; slowOwner?: boolean } = {},
): Promise<Tree> {
	return parent.commit(async (tx) => {
		const owner = await tx.createTask(
			Hold,
			{ name, ...(options.slowOwner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, background: options.background ?? false },
		);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
		const inner = await tx.createTask(
			Hold,
			{ name: `${name}.inner`, ...(options.slowInner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, conversationId: child.id },
		);
		return { owner, child: child.id, inner };
	}, context);
}

/** A faux response held until `release` or cancellation; `reached` resolves when the request is sent. */
function gated(message: AssistantMessage) {
	const reached = deferred();
	const gate = deferred();
	const step = async (_request: unknown, options?: { signal?: AbortSignal }) => {
		reached.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
	return { step, reached: reached.promise, release: () => gate.resolve() };
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500 && !(await check()); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!(await check())) throw new Error("Condition was not reached");
}

/** Mark a conversation busy with `task` standing in for its run, so submissions queue. */
async function busy(conversation: Conversation, task: TaskId): Promise<void> {
	await conversation.commit(async (tx) => {
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: task, inputs: [] };
	}, context);
}

async function status(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

async function openHarness(storage: Storage = new MemoryStorage()) {
	const opened = await openTasks(storage, [Hold, Waiter]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

describe("ownership", () => {
	it("keeps a conversation busy while its owned foreground subtree has live work, holding the completed owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		open("owner", "completed");
		await waitUntil(async () => (await status(harness, tree.owner)).status === "completing");
		const idle = root.waitForIdle(context);
		expect(await settled(idle)).toBe(false);
		expect(await settled(harness.waitForIdle(context))).toBe(false);
		open("owner.inner", "completed");
		await idle;
		await harness.waitForIdle(context);
		expect((await status(harness, tree.owner)).outcome?.status).toBe("completed");
		await harness.close(context);
	});

	it("stops idle traversal at a background owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await root.waitForIdle(context);
		await harness.waitForIdle(context);
		// The background child is its own scope.
		const child = (await harness.conversation(tree.child, context))!;
		expect(await settled(child.waitForIdle(context))).toBe(false);
		await child.abort(context);
		await harness.close(context);
	});

	it("cascades an abort mark to the owned foreground subtree and withdraws its queued inputs", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const nested = await harness.conversation(tree.child, context);
		const deeper = await ownedChild(nested!, "deeper");
		const shielded = await ownedChild(nested!, "shielded", { background: true });
		// Busy conversations queue submissions; the inner task stands in for the child's run.
		await busy(nested!, tree.inner);
		const queued = (await nested!.submit({ type: "input", content: "later" }, context)).id;
		expect(await harness.abortTask(tree.owner, context)).toBe("marked");
		for (const id of [tree.owner, tree.inner, deeper.owner, deeper.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		// A nested background owner is a boundary.
		expect((await status(harness, shielded.owner)).status).not.toBe("terminal");
		expect((await status(harness, shielded.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		await harness.abortTask(shielded.owner, context);
		await harness.close(context);
	});

	it("cascades a failed owner but not a completed one", async () => {
		const { harness, root } = await openHarness();
		const failed = await ownedChild(root, "failed");
		const completedTree = await ownedChild(root, "done");
		open("failed", "failed");
		open("done", "completed");
		expect((await harness.waitForTask(failed.inner, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(failed.owner, context)).state.outcome.status).toBe("failed");
		await waitUntil(async () => (await status(harness, completedTree.owner)).status === "completing");
		expect((await status(harness, completedTree.inner)).status).not.toBe("terminal");
		open("done.inner", "completed");
		expect((await harness.waitForTask(completedTree.owner, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("aborts a background task directly with its ordinary subtree", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await harness.abortTask(tree.owner, context);
		expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("aborts a conversation: queued inputs withdrawn, writes kept, foreground work aborted, background kept", async () => {
		const { harness, root } = await openHarness();
		const foreground = await ownedChild(root, "foreground");
		const background = await ownedChild(root, "background", { background: true });
		await busy(root, foreground.owner);
		const input = (await root.submit({ type: "input", content: "later" }, context)).id;
		const write = (await root.submit({ type: "write", entry: { kind: "note" } }, context)).id;
		await root.abort(context);
		for (const id of [foreground.owner, foreground.inner]) {
			expect((await status(harness, id)).status).toBe("terminal");
		}
		expect((await status(harness, background.owner)).status).not.toBe("terminal");
		expect((await status(harness, background.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(input, context))!.status(context)).toMatchObject({ reason: "aborted" });
		expect((await (await harness.submission(write, context))!.status(context)).status).toBe("queued");
		await harness.abortTask(background.owner, context);
		await harness.close(context);
	});

	it("aborts work created below a held failed owner, but not below a terminal one", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		expect((await status(harness, tree.owner)).status).toBe("completing");
		const child = (await harness.conversation(tree.child, context))!;
		const create = (name: string) =>
			child.commit((tx) => tx.createTask(Hold, { name }, { ownership: { kind: "conversation" } }), context);
		const during = await create("during");
		expect((await harness.waitForTask(during, context)).state.outcome.status).toBe("aborted");
		open("abort.owner.inner", "completed");
		expect((await harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("failed");
		// A terminal owner never cascades: interrogating its conversation runs normally.
		const after = await create("after");
		open("after", "completed");
		expect((await harness.waitForTask(after, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("withdraws queued inputs below the aborted task but keeps its own conversation's queue and queued writes", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const child = (await harness.conversation(tree.child, context))!;
		await busy(root, tree.owner);
		await busy(child, tree.inner);
		const own = (await root.submit({ type: "input", content: "own" }, context)).id;
		const below = (await child.submit({ type: "input", content: "below" }, context)).id;
		const write = (await child.submit({ type: "write", entry: { kind: "note" } }, context)).id;
		await harness.abortTask(tree.owner, context);
		await harness.waitForTask(tree.inner, context);
		const statusOf = async (id: typeof own) =>
			(await (await harness.submission(id, context))!.status(context)).status;
		expect(await statusOf(own)).toBe("queued");
		expect(await statusOf(below)).toBe("unanswered");
		expect(await statusOf(write)).toBe("queued");
		await harness.close(context);
	});

	it("keeps a nested background owner's subtree when its cancelled background owner is aborted", async () => {
		const { harness, root } = await openHarness();
		const outer = await ownedChild(root, "outer", { background: true });
		const inner = await ownedChild((await harness.conversation(outer.child, context))!, "inner", {
			background: true,
		});
		await harness.abortTask(outer.owner, context);
		expect((await harness.waitForTask(outer.inner, context)).state.outcome.status).toBe("aborted");
		expect((await status(harness, inner.owner)).status).not.toBe("terminal");
		expect((await status(harness, inner.inner)).status).not.toBe("terminal");
		await harness.abortTask(inner.owner, context);
		await harness.close(context);
	});

	it("decides idle after reopen from owner edges it has to load first", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const foreground = await ownedChild(opened.root, "fg");
		const deeper = await ownedChild((await opened.harness.conversation(foreground.child, context))!, "fg2");
		const background = await ownedChild(opened.root, "bg", { background: true });
		open("fg", "completed");
		open("fg2", "completed");
		// Both owners hold their outcomes while the work below them runs.
		await waitUntil(async () => (await status(opened.harness, foreground.owner)).status === "completing");
		await waitUntil(async () => (await status(opened.harness, deeper.owner)).status === "completing");
		await opened.harness.close(context);

		opened = await openHarness(await openNodeSqliteStorage(path));
		// Two levels below completed foreground owners, the inner tasks keep the root busy.
		expect(await settled(opened.root.waitForIdle(context))).toBe(false);
		expect(await settled(opened.harness.waitForIdle(context))).toBe(false);
		open("fg.inner", "completed");
		open("fg2.inner", "completed");
		// The background subtree does not count.
		await opened.root.waitForIdle(context);
		await opened.harness.waitForIdle(context);
		expect((await status(opened.harness, foreground.owner)).status).toBe("terminal");
		expect((await status(opened.harness, background.inner)).status).not.toBe("terminal");
		await opened.harness.abortTask(background.owner, context);
		await opened.harness.close(context);
	});

	for (const [label, abortRequested, state] of [
		[
			"a held failed owner",
			false,
			{ status: "completing", outcome: { status: "failed", error: { message: "crash" } } },
		],
		["an abort-marked owner", true, { status: "pending", checkpoint: { phase: "hold" } }],
	] as const) {
		it(`derives marks a crash left unapplied below ${label} at open`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
			directories.add(directory);
			const path = join(directory, "session.sqlite");
			// Without a Harness, nothing derives marks: a cancelled owner with a live task below it.
			const session = createSession(await openNodeSqliteStorage(path));
			const tree = await session.commit(async (tx) => {
				const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const owner = await tx.createTask(
					Hold,
					{ name: "gone" },
					{ ownership: { kind: "conversation" }, conversationId: root.id },
				);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
				return {
					owner,
					inner: await tx.createTask(
						Hold,
						{ name: "orphan" },
						{ ownership: { kind: "conversation" }, conversationId: child.id },
					),
				};
			}, context);
			await session.commit(async (tx) => {
				const record = (await tx.task(tree.owner))!;
				(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested, state });
			}, context);
			await session.close(context);

			const { harness } = await openHarness(await openNodeSqliteStorage(path));
			expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
			// The owner finishes only after the work below it.
			const outcome = (await harness.waitForTask(tree.owner, context)).state.outcome.status;
			expect(outcome).toBe(abortRequested ? "aborted" : "failed");
			await harness.close(context);
		});
	}

	it("withdraws an input queued below a held failed owner after its cascade", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		const child = (await harness.conversation(tree.child, context))!;
		// The inner task stands in for the child's run, which stays busy after the cascade.
		await busy(child, tree.inner);
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		const late = await child.submit({ type: "input", content: "late" }, context);
		expect(await late.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		open("abort.owner.inner", "completed");
		await harness.waitForTask(tree.owner, context);
		await harness.close(context);
	});

	it("marks work admitted after reopen below a cancelled owner whose edge was not loaded", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		// The owner stays live and cancelled in its slow abort handler.
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		// The child is empty at open, so nothing loads its edge until new work arrives.
		opened = await openHarness(await openNodeSqliteStorage(path));
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		open("abort.owner", "completed");
		expect((await opened.harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("aborted");
		await opened.harness.close(context);
	});

	it("cascades from an owner the scheduler orphans", async () => {
		const { harness, root } = await openHarness();
		const { owner, inner } = await root.commit(async (tx) => {
			const owner = await tx.createTask(
				Unregistered,
				{ name: "unregistered" },
				{ ownership: { kind: "conversation" } },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			return {
				owner,
				inner: await tx.createTask(
					Hold,
					{ name: "below" },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				),
			};
		}, context);
		expect(await harness.abortTask(owner, context)).toBe("marked");
		expect((await harness.waitForTask(owner, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "missing_task",
		});
		expect((await harness.waitForTask(inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("cancels only the caller's wait, never the shared work", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const waiting = new AbortController();
		const idle = root.waitForIdle({ ...context, abortSignal: waiting.signal });
		waiting.abort(new Error("stop waiting"));
		await expect(idle).rejects.toThrow("stop waiting");
		expect((await status(harness, tree.inner)).status).not.toBe("terminal");

		// Cancelling an abort after its commit leaves the marks in place.
		const slow = await ownedChild(root, "slow");
		await root.commit(async (tx) => {
			const record = (await tx.task(slow.owner))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...record,
				input: { name: "slow", slowAbort: true },
			});
		}, context);
		const aborting = new AbortController();
		const abort = root.abort({ ...context, abortSignal: aborting.signal });
		await waitUntil(async () => (await harness.getTask(slow.owner, context))!.abortRequested);
		aborting.abort(new Error("stop aborting"));
		await expect(abort).rejects.toThrow("stop aborting");
		open("abort.slow", "completed");
		for (const id of [tree.owner, tree.inner, slow.owner, slow.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		await harness.close(context);
	});

	it("aborts a waiting child whose awaited task completes in the commit that marks its owner", async () => {
		const { harness, root } = await openHarness();
		const { owner, dependency, blocked } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const dependency = await tx.createTask(Hold, { name: "dependency" }, { ownership: { kind: "conversation" } });
			const blocked = await tx.createTask(
				Waiter,
				{ on: [dependency] },
				{ ownership: { kind: "conversation" }, conversationId: child.id },
			);
			return { owner, dependency, blocked };
		}, context);
		await waitUntil(async () => runs.get("dependency") === 1 && runs.get("owner") === 1);
		await waitUntil(async () => (await status(harness, blocked)).status === "waiting");
		// One commit completes the dependency and marks the owner.
		await root.commit(async (tx) => {
			const setTask = (value: unknown) => (tx as unknown as { setTask(value: unknown): void }).setTask(value);
			const completedDependency = (await tx.task(dependency))!;
			const marked = (await tx.task(owner))!;
			setTask({
				...completedDependency,
				state: { status: "terminal", outcome: { status: "completed", result: null } },
			});
			setTask({ ...marked, abortRequested: true });
		}, context);
		expect((await harness.waitForTask(blocked, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("retries marks found through an edge loaded after reopen when their commit is rejected", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		const storage = await openNodeSqliteStorage(path);
		let rejectMark: TaskId | undefined;
		const commit = storage.commit.bind(storage);
		storage.commit = async (writes, ctx) => {
			if (
				writes.some((write) => write.type === "task" && write.value.id === rejectMark && write.value.abortRequested)
			) {
				rejectMark = undefined;
				throw new StorageRejected("rejected once");
			}
			return commit(writes, ctx);
		};
		opened = await openHarness(storage);
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(async (tx) => {
			const id = await tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } });
			rejectMark = id;
			return id;
		}, context);
		await waitUntil(async () => rejectMark === undefined);
		// Any later commit, here the reservation of the new task, retries the cascade.
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		open("abort.owner", "completed");
		await opened.harness.close(context);
	});

	it("retries a cascade whose commit the Storage rejected", async () => {
		let rejectMark: TaskId | undefined;
		class Rejecting extends MemoryStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				ctx: Parameters<MemoryStorage["commit"]>[1],
			) {
				const marks = writes.some(
					(write) => write.type === "task" && write.value.id === rejectMark && write.value.abortRequested,
				);
				if (marks) {
					rejectMark = undefined;
					throw new StorageRejected("rejected once");
				}
				return super.commit(writes, ctx);
			}
		}
		const { harness, root, reports } = await openHarness(new Rejecting());
		const tree = await ownedChild(root, "owner");
		rejectMark = tree.inner;
		open("owner", "failed");
		await waitUntil(async () => reports.some((error) => error instanceof StorageRejected));
		expect((await status(harness, tree.owner)).status).toBe("completing");
		expect((await status(harness, tree.inner)).status).not.toBe("terminal");
		// The next commit retries the cascade.
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("failed");
		await harness.close(context);
	});
});

describe("owned conversations from tools and supervisors", () => {
	it("gives a tool an invocation-bound handle whose submissions stay durable after the call ends", async () => {
		const setup = chatSetup();
		let handle: ConversationHandle | undefined;
		let missing: ConversationHandle | undefined = {} as ConversationHandle;
		let submission: Submission | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					missing = await api.conversation(99_999 as ConversationId, callContext);
					handle = (await api.conversation(child, callContext))!;
					submission = await handle.submit(
						{ type: "input", content: "child task", requestId: "child" },
						callContext,
					);
					const settled = await submission.wait(callContext);
					return { content: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(missing).toBeUndefined();
		// The call ended: the handle and its submission reject, while the submission record remains.
		await expect(handle!.submit({ type: "input", content: "again" }, context)).rejects.toThrow(
			"invocation has ended",
		);
		await expect(handle!.waitForIdle(context)).rejects.toThrow("invocation has ended");
		await expect(handle!.abort(context)).rejects.toThrow("invocation has ended");
		await expect(submission!.wait(context)).rejects.toThrow("invocation has ended");
		// Nothing was admitted or marked after the call ended.
		const childConversation = (await harness.conversation(handle!.id, context))!;
		const childEntries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(childEntries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const childTasks = (await harness.inspect(context)).tasks.filter(
			(task) => task.record.conversationId === handle!.id,
		);
		expect(childTasks).toEqual([]);
		expect((await (await harness.submission(submission!.id, context))!.status(context)).status).toBe("done");
		await harness.close(context);
	});

	it("rejects a handle operation queued on the line when the invocation ends before it runs", async () => {
		const setup = chatSetup();
		const ready = deferred<{ child: ConversationId; taskId: TaskId }>();
		const go = deferred();
		const queued = deferred<{ submitting: Promise<unknown> }>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates late",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					ready.resolve({ child, taskId: api.taskId });
					await go.promise;
					// Called while the invocation is alive, with a context that is not the call's: the handle binds it to the
					// invocation. It reaches the line only after the abort mark.
					const submitting = handle.submit({ type: "input", content: "late" }, context);
					submitting.catch(() => {});
					queued.resolve({ submitting });
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "go" }, context);
		const { child, taskId } = await ready.promise;
		// Hold the Session line, queue the abort mark behind it, then let the tool queue its submit.
		const release = deferred();
		const holding = root.commit(async () => {
			await release.promise;
		}, context);
		const aborting = harness.abortTask(taskId, context);
		go.resolve();
		const { submitting } = await queued.promise;
		release.resolve();
		await holding;
		await aborting;
		await expect(submitting).rejects.toThrow();
		const childConversation = (await harness.conversation(child, context))!;
		expect((await childConversation.entries({}, 10, undefined, context)).items).toEqual([]);
		expect((await harness.inspect(context)).submissions.filter((record) => record.conversationId === child)).toEqual(
			[],
		);
		await harness.close(context);
	});

	it("aborts a subagent run with its parent's conversation, rejecting the waiting tool", async () => {
		const setup = chatSetup();
		let child: ConversationId | undefined;
		const toolWait = deferred<string>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const submission = await (await api.conversation(child, callContext))!.submit(
						{ type: "input", content: "child task" },
						callContext,
					);
					try {
						return { content: [{ type: "text", text: (await submission.wait(callContext)).status }] };
					} catch (error) {
						toolWait.resolve((error as Error).message);
						throw error;
					}
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "go" }, context);
		await childRun.reached;
		await root.abort(context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await toolWait.promise).toBeTruthy();
		const childConversation = (await harness.conversation(child!, context))!;
		await childConversation.waitForIdle(context);
		const childLive = await harness.snapshot(LiveDoc, child!, context);
		expect(childLive).toEqual({});
		const childInputs = (await harness.inspect(context)).submissions.filter((s) => s.conversationId === child);
		expect(childInputs).toEqual([]);
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("lets a running tool abort its owned child and continue", async () => {
		const setup = chatSetup();
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates and cancels",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					const submission = await handle.submit({ type: "input", content: "child task" }, callContext);
					await childRun.reached;
					await handle.abort(callContext);
					const settledChild = await submission.wait(callContext);
					return { content: [{ type: "text", text: `child ${settledChild.status}` }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		await harness.close(context);
	});

	it("aborts the children of a tool call that throws or is interrupted, while the run continues", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-children-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: TaskId[] = [];
		const toolRunning = deferred();
		const setup = chatSetup();
		addTask(setup.registry, Hold);
		addTool(
			setup.registry,
			defineTool({
				name: "spawn",
				description: "Starts owned work, then throws or hangs",
				parameters: Type.Object({ mode: Type.String() }),
				execute: async (args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return tx.createTask(
							Hold,
							{ name: `child.${api.callId}` },
							{ ownership: { kind: "conversation" }, conversationId: created.id },
						);
					}, callContext);
					children.push(child);
					if (args.mode === "throw") throw new Error("spawn failed");
					toolRunning.resolve();
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		const call = (mode: string, id: string) =>
			fauxAssistantMessage([fauxToolCall("spawn", { mode }, { id })], { stopReason: "toolUse" });
		setup.faux.setResponses([
			call("throw", "c1"),
			fauxAssistantMessage([fauxText("after throw")]),
			call("hang", "c2"),
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.root.submit({ type: "input", content: "one" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect((await opened.harness.waitForTask(children[0]!, context)).state.outcome.status).toBe("aborted");

		// The second call hangs until the process stops; on reopen it is interrupted.
		const second = (await opened.root.submit({ type: "input", content: "two" }, context)).id;
		await toolRunning.promise;
		await opened.harness.close(context);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("after interrupt")])]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		expect((await opened.harness.waitForTask(children[1]!, context)).state.outcome.status).toBe("aborted");
		expect((await (await opened.harness.submission(second, context))!.wait(context)).status).toBe("done");
		const tools = (await opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), context)).items;
		expect(tools.map((task) => task.state.status === "terminal" && task.state.outcome.status)).toEqual([
			"failed",
			"failed",
		]);
		await opened.harness.close(context);
	});

	it("reruns a replay-safe subagent tool after a restart with the same child and submission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-safe-subagent-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: ConversationId[] = [];
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "subagent",
				description: "Delegates",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					children.push(child);
					const request = { type: "input", content: "child task", requestId: `subagent:${api.taskId}` } as const;
					const submission = await (await api.conversation(child, callContext))!.submit(request, callContext);
					const settled = await submission.wait(callContext);
					return { content: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const input = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await childRun.reached;
		await opened.harness.close(context);

		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.harness.submission(input, context))!.wait(context)).status).toBe("done");
		expect(children).toHaveLength(2);
		expect(children[1]).toBe(children[0]);
		const child = (await opened.harness.conversation(children[0]!, context))!;
		const entries = (await child.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const results = (await opened.root.context(context)).messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.isError)).toEqual([false]);
		await opened.harness.close(context);
	});

	it("lets a background supervisor resubmit after a restart without submitting twice", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-supervisor-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const Children = defineDoc<{ child?: ConversationId }>({
			kind: "test.children",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({}),
		});
		const Supervisor = defineTask<{ parent: ConversationId }, { phase: "run" }, { answer: EntryId }>({
			name: "test.supervisor",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					const id = (await runtime.snapshot(Children, task.input.parent, ctx))!.child!;
					const child = (await runtime.conversation(id, ctx))!;
					const submission = await child.submit({ type: "input", content: "work", requestId: "stable" }, ctx);
					const settled = await submission.wait(ctx);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(settled.status);
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: { answer: settled.answer } } }),
						ctx,
					);
				},
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const setup = chatSetup();
		addTask(setup.registry, Supervisor);
		const first = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([first.step, fauxAssistantMessage([fauxText("answer")])]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const root = opened.root;
		const { supervisor, child } = await root.commit(async (tx) => {
			const supervisor = await tx.createTask(
				Supervisor,
				{ parent: root.id },
				{ ownership: { kind: "conversation" }, background: true },
			);
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
			await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
			(await tx.doc(Children, root.id)).child = created.id;
			return { supervisor, child: created.id };
		}, context);
		opened.harness.resume();
		// The submission is admitted and its generation requested; then the process stops.
		await first.reached;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const done = await opened.harness.waitForTask(supervisor, context);
		expect(done.state.outcome.status).toBe("completed");
		const childConversation = (await opened.harness.conversation(child, context))!;
		const entries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		// The root never waited for the background supervisor.
		await opened.root.waitForIdle(context);
		await opened.harness.close(context);
	});
});
