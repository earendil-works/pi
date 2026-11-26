// Harness.deleteConversations(): close, abort, then remove a conversation and the ones its tasks own (#11026).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchEnd } from "@earendil-works/chord/watch";
import {
	ConversationDeleting,
	type ConversationId,
	type DeletionRefusal,
	DeletionRefused,
	defineTask,
	type Harness,
	LiveDoc,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { user } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred, eventually, openTasks, settled } from "./task-support.ts";

/** Gates of the abort handlers named by a task's input, which wait for them when set. */
const abortGates = new Map<string, Deferred>();

/** Holds until aborted; its abort handler waits for its gate, if it has one, then ends it `aborted`. */
const Hold = defineTask<{ name?: string }, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: (_task, runtime) => aborted(runtime.signal) },
	abort: async (task, runtime, ctx) => {
		const gate = task.input.name === undefined ? undefined : abortGates.get(task.input.name);
		if (gate !== undefined) await gate.promise;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

/** Waits on the tasks in its input, then completes. */
const Waiter = defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "done" }, null>({
	name: "test.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, ctx) =>
			runtime.commit(
				() => ({ status: "waiting", checkpoint: { phase: "done" }, on: task.input.on, policy: "allSettled" }),
				ctx,
			),
		done: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const directories = new Set<string>();
afterEach(async () => {
	abortGates.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function directory(): Promise<string> {
	const created = await mkdtemp(join(tmpdir(), "pi-durable-delete-"));
	directories.add(created);
	return created;
}

const storages: Record<string, () => Promise<Storage>> = {
	memory: async () => new MemoryStorage(),
	sqlite: async () => openNodeSqliteStorage(join(await directory(), "session.sqlite")),
};

async function open(storage: Storage): Promise<Harness> {
	const { harness } = await openTasks(storage, [Hold, Waiter]);
	harness.resume();
	return harness;
}

function ownerless(harness: Harness) {
	return harness.createConversation({ ownership: { kind: "ownerless" } }, context);
}

async function status(harness: Harness, id: TaskId): Promise<string | undefined> {
	return (await harness.getTask(id, context))?.state.status;
}

/** The refusal `deleting` rejects with. */
async function refusal(deleting: Promise<void>): Promise<DeletionRefusal> {
	const error = await deleting.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(DeletionRefused);
	return (error as DeletionRefused).refusal;
}

describe("Harness.deleteConversations", () => {
	for (const [name, create] of Object.entries(storages)) {
		it(`aborts live work, then removes the conversation and what its tasks own (${name})`, async () => {
			const storage = await create();
			const harness = await open(storage);
			const parent = await ownerless(harness);
			const kept = await ownerless(harness);
			// A live task owning a subagent conversation, which runs background work of its own.
			const tree = await parent.commit(async (tx) => {
				const owner = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" } });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
				const background = await tx.createTask(
					Hold,
					{},
					{ ownership: { kind: "conversation" }, conversationId: child.id, background: true },
				);
				const entry = await tx.appendEntry(child.id, { kind: "message", model: [user("child secret")] });
				return { owner, child: child.id, background, entry: entry.id };
			}, context);
			const secret = await parent.commit(
				(tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("secret")] }),
				context,
			);
			// A raw queued submission, which no inbox holds.
			const raw = await parent.commit(
				(tx) => tx.createSubmission({ conversationId: parent.id, type: "write", status: "queued" }),
				context,
			);
			const rawSettled = (await harness.submission(raw.id, context))!.wait(context);
			const ends: WatchEnd[] = [];
			await harness.observeConversation(parent.id, { advance: () => {}, end: (end) => ends.push(end) }, context);

			await harness.deleteConversations([parent.id], context);

			expect(await rawSettled).toMatchObject({ status: "unanswered", reason: "deleted" });
			expect(ends).toEqual([{ kind: "ended" }]);
			expect(await harness.conversation(parent.id, context)).toBeUndefined();
			expect(await harness.conversation(tree.child, context)).toBeUndefined();
			for (const id of [tree.owner, tree.background]) expect(await status(harness, id)).toBeUndefined();
			expect(await harness.snapshot(LiveDoc, parent.id, context)).toBeUndefined();
			expect(await harness.submission(raw.id, context)).toBeUndefined();
			for (const id of [secret.id, tree.entry]) expect(await storage.entry(id, context)).toBeUndefined();
			// Nothing in memory lets a later commit write to it.
			await expect(
				harness.commit((tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("late")] }), context),
			).rejects.toThrow(`Conversation ${parent.id} does not exist`);
			await expect(harness.commit((tx) => tx.doc(LiveDoc, parent.id), context)).rejects.toThrow("does not exist");
			expect(await harness.conversation(kept.id, context)).toBeDefined();
			// Again, and for an ID that never was: nothing to do.
			await harness.deleteConversations([parent.id, 999 as ConversationId], context);
			await harness.close(context);
		});
	}

	it("closes the conversations while their work ends: no new submission, task, fork, or wait elsewhere", async () => {
		const harness = await open(new MemoryStorage());
		const doomed = await ownerless(harness);
		const elsewhere = await ownerless(harness);
		const entry = await doomed.commit(
			(tx) => tx.appendEntry(doomed.id, { kind: "message", model: [user("hello")] }),
			context,
		);
		abortGates.set("slow", deferred());
		const slow = await doomed.commit(
			(tx) => tx.createTask(Hold, { name: "slow" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const deleting = harness.deleteConversations([doomed.id], context);
		await eventually(async () => (await harness.getTask(slow, context))?.abortRequested === true);
		expect(await settled(deleting)).toBe(false);

		await expect(doomed.submit({ type: "input", content: "more" }, context)).rejects.toBeInstanceOf(
			ConversationDeleting,
		);
		await expect(
			doomed.commit((tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }), context),
		).rejects.toBeInstanceOf(ConversationDeleting);
		await expect(doomed.fork(entry.id, { ownership: { kind: "ownerless" } }, context)).rejects.toBeInstanceOf(
			ConversationDeleting,
		);
		// A task elsewhere cannot start waiting on one of its tasks: their records go with it.
		const waiter = await elsewhere.commit(
			(tx) => tx.createTask(Waiter, { on: [slow] }, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await status(harness, waiter)) === "terminal");
		expect((await harness.getTask(waiter, context))?.state).toMatchObject({ outcome: { status: "faulted" } });

		abortGates.get("slow")!.resolve();
		await deleting;
		expect(await harness.conversation(doomed.id, context)).toBeUndefined();
		await harness.close(context);
	});

	it("refuses the root, a live owner, a fork left behind, and a waiter elsewhere, aborting nothing", async () => {
		const harness = await open(new MemoryStorage());
		await harness.root(context);
		expect(await refusal(harness.deleteConversations([ROOT_CONVERSATION_ID], context))).toEqual({ kind: "root" });

		const parent = await ownerless(harness);
		const entry = await parent.commit(
			(tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("shared")] }),
			context,
		);
		const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const live = await parent.commit(
			(tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		expect(await refusal(harness.deleteConversations([parent.id], context))).toEqual({
			kind: "fork",
			forkId: fork.id,
		});
		const owned = await parent.commit(
			(tx) => tx.createConversation({ ownership: { kind: "task", taskId: live } }),
			context,
		);
		expect(await refusal(harness.deleteConversations([owned.id], context))).toEqual({ kind: "owner", taskId: live });

		const elsewhere = await ownerless(harness);
		const waiter = await elsewhere.commit(
			(tx) => tx.createTask(Waiter, { on: [live] }, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await status(harness, waiter)) === "waiting");
		expect(await refusal(harness.deleteConversations([parent.id, fork.id], context))).toEqual({
			kind: "waiter",
			taskId: live,
			waiterId: waiter,
		});
		// Nothing was aborted, nor closed.
		expect(await status(harness, live)).toBe("running");
		expect((await harness.getTask(live, context))?.abortRequested).toBe(false);
		await parent.submit({ type: "write", entry: { kind: "note" } }, context);

		// Deleting the waiter's conversation too lifts the refusal; the fork goes with its parent.
		await harness.deleteConversations([parent.id, fork.id, elsewhere.id], context);
		for (const id of [parent.id, fork.id, owned.id, elsewhere.id]) {
			expect(await harness.conversation(id, context)).toBeUndefined();
		}
		await harness.close(context);
	});

	it("refuses on a storage that cannot erase, before aborting anything", async () => {
		const harness = await open(await openNodeJsonlStorage(await directory(), context));
		const conversation = await ownerless(harness);
		const live = await conversation.commit(
			(tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		expect(await refusal(harness.deleteConversations([conversation.id], context))).toEqual({ kind: "unsupported" });
		expect((await harness.getTask(live, context))?.abortRequested).toBe(false);
		await harness.close(context);
	});

	it("finishes a deletion that a close interrupted once the reopened Harness schedules", async () => {
		const path = join(await directory(), "session.sqlite");
		let harness = await open(await openNodeSqliteStorage(path));
		const doomed = await ownerless(harness);
		abortGates.set("slow", deferred());
		const slow = await doomed.commit(
			(tx) => tx.createTask(Hold, { name: "slow" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const deleting = harness.deleteConversations([doomed.id], context);
		await eventually(async () => (await harness.getTask(slow, context))?.abortRequested === true);
		const closing = harness.close(context);
		abortGates.get("slow")!.resolve();
		await closing;
		await expect(deleting).rejects.toThrow();

		abortGates.clear();
		const { harness: reopened } = await openTasks(await openNodeSqliteStorage(path), [Hold, Waiter]);
		harness = reopened;
		// Closed, not yet deleted: it takes no new work, and scheduling finishes it.
		expect((await harness.commit((tx) => tx.conversation(doomed.id), context))?.deleting).toBe(true);
		harness.resume();
		await eventually(async () => (await harness.conversation(doomed.id, context)) === undefined);
		expect(await status(harness, slow)).toBeUndefined();
		await harness.close(context);
	});

	it("erases what SQLite deleted from the database file and the WAL", async () => {
		const folder = await directory();
		const harness = await open(await openNodeSqliteStorage(join(folder, "session.sqlite")));
		const conversation = await ownerless(harness);
		const secret = "secret-of-the-deleted-conversation-".repeat(200);
		await conversation.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: "message", model: [user(secret)] }),
			context,
		);
		await harness.deleteConversations([conversation.id], context);
		for (const file of await readdir(folder)) {
			expect((await readFile(join(folder, file))).includes(secret.slice(0, 200))).toBe(false);
		}
		await harness.close(context);
	});
});
