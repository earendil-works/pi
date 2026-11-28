// Harness.deleteConversations(): close, abort, then remove a conversation and the ones its tasks own (#11026).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { WatchEnd } from "@earendil-works/chord/watch";
import {
	ConversationDeleting,
	type ConversationId,
	type DeletionRefusal,
	DeletionRefused,
	defineDoc,
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
import { ControlledStorage, context } from "./session-support.ts";
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

/** Waits on the tasks in its input, then, once its gate opens if it has one, completes with their outcomes' statuses. */
const Waiter = defineTask<{ on: TaskId[]; gate?: string }, { phase: "wait" } | { phase: "done" }, string[]>({
	name: "test.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, ctx) =>
			runtime.commit(
				() => ({ status: "waiting", checkpoint: { phase: "done" }, on: task.input.on, policy: "allSettled" }),
				ctx,
			),
		done: async (task, runtime, ctx) => {
			const gate = task.input.gate === undefined ? undefined : abortGates.get(task.input.gate);
			if (gate !== undefined) await gate.promise;
			const outcomes = await runtime.outcomes(task.input.on, ctx);
			const result = outcomes.map((outcome) =>
				outcome.status === "orphaned" ? `orphaned: ${outcome.reason}` : outcome.status,
			);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** A latest conversation document that writes a complete base at each change. */
const Notes = defineDoc<{ text: string }>({
	kind: "test.notes",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "" }),
	checkpointWhen: () => true,
});

/** The Harness `DeleteOwn` deletes through. */
let deleting: Harness | undefined;

/** Deletes its own conversation, as a retention job running inside it would; its abort mark ends its wait. */
const DeleteOwn = defineTask<null, { phase: "delete" }, null>({
	name: "test.delete-own",
	version: 1,
	initial: () => ({ phase: "delete" }),
	phases: { delete: (task, _runtime, ctx) => deleting!.deleteConversations([task.conversationId], ctx) },
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
	const { harness } = await openTasks(storage, [Hold, Waiter, DeleteOwn]);
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

	it("closes the conversations while their work ends: no new submission, task, or fork", async () => {
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
		expect((await harness.inspect(context)).deleting).toEqual([doomed.id]);

		await expect(doomed.submit({ type: "input", content: "more" }, context)).rejects.toBeInstanceOf(
			ConversationDeleting,
		);
		await expect(
			doomed.commit((tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }), context),
		).rejects.toBeInstanceOf(ConversationDeleting);
		await expect(doomed.fork(entry.id, { ownership: { kind: "ownerless" } }, context)).rejects.toBeInstanceOf(
			ConversationDeleting,
		);
		// A task elsewhere may still wait on one of its tasks; it reads the outcome of one deleted meanwhile as orphaned.
		abortGates.set("read", deferred());
		const waiter = await elsewhere.commit(
			(tx) => tx.createTask(Waiter, { on: [slow], gate: "read" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await status(harness, waiter)) === "waiting");

		abortGates.get("slow")!.resolve();
		await deleting;
		expect(await harness.conversation(doomed.id, context)).toBeUndefined();
		expect((await harness.inspect(context)).deleting).toEqual([]);
		abortGates.get("read")!.resolve();
		await eventually(async () => (await status(harness, waiter)) === "terminal");
		expect((await harness.getTask(waiter, context))?.state).toMatchObject({
			outcome: { status: "completed", result: ["orphaned: deleted"] },
		});
		await harness.close(context);
	});

	it("refuses new work admitted while the commit that closes the conversation is being stored", async () => {
		const storage = new ControlledStorage();
		const harness = await open(storage);
		const doomed = await ownerless(harness);
		const held = storage.holdCommits();
		const deleting = harness.deleteConversations([doomed.id], context);
		await held.entered;
		const creating = doomed.commit((tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }), context);
		expect(await settled(creating)).toBe(false);
		held.release();
		await expect(creating).rejects.toBeInstanceOf(ConversationDeleting);
		await deleting;
		expect(await harness.conversation(doomed.id, context)).toBeUndefined();
		await harness.close(context);
	});

	it("refuses the root and a live owner elsewhere, aborting nothing", async () => {
		const harness = await open(new MemoryStorage());
		await harness.root(context);
		expect(await refusal(harness.deleteConversations([ROOT_CONVERSATION_ID], context))).toEqual({ kind: "root" });

		const owner = await ownerless(harness);
		const live = await owner.commit(
			(tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		const owned = await owner.commit(
			(tx) => tx.createConversation({ ownership: { kind: "task", taskId: live } }),
			context,
		);
		expect(await refusal(harness.deleteConversations([owned.id], context))).toEqual({ kind: "owner", taskId: live });
		// Nothing was aborted, nor closed.
		expect(await status(harness, live)).toBe("running");
		expect((await harness.getTask(live, context))?.abortRequested).toBe(false);
		await (await harness.conversation(owned.id, context))!.submit(
			{ type: "write", entry: { kind: "note" } },
			context,
		);
		await harness.close(context);
	});

	it("deletes the forks with their parent, and theirs, with the conversations their tasks own", async () => {
		const harness = await open(new MemoryStorage());
		const parent = await ownerless(harness);
		const elsewhere = await ownerless(harness);
		const entry = await parent.commit(
			(tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("shared")] }),
			context,
		);
		const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const forkEntry = await fork.commit(
			(tx) => tx.appendEntry(fork.id, { kind: "message", model: [user("branch")] }),
			context,
		);
		const nested = await fork.fork(forkEntry.id, { ownership: { kind: "ownerless" } }, context);
		const live = await nested.commit(
			(tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		const owned = await nested.commit(
			(tx) => tx.createConversation({ ownership: { kind: "task", taskId: live } }),
			context,
		);

		await harness.deleteConversations([parent.id], context);
		for (const id of [parent.id, fork.id, nested.id, owned.id]) {
			expect(await harness.conversation(id, context)).toBeUndefined();
		}
		expect(await status(harness, live)).toBeUndefined();
		expect(await harness.conversation(elsewhere.id, context)).toBeDefined();
		await harness.close(context);
	});

	it("deletes the conversation of the task that asked for it: its abort mark ends its wait", async () => {
		const harness = await open(new MemoryStorage());
		deleting = harness;
		const conversation = await ownerless(harness);
		const task = await conversation.commit(
			(tx) => tx.createTask(DeleteOwn, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await harness.conversation(conversation.id, context)) === undefined);
		expect(await status(harness, task)).toBeUndefined();
		deleting = undefined;
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

	it("finishes the deletion when its caller stops waiting for it", async () => {
		const harness = await open(new MemoryStorage());
		const doomed = await ownerless(harness);
		abortGates.set("slow", deferred());
		const slow = await doomed.commit(
			(tx) => tx.createTask(Hold, { name: "slow" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const caller = new AbortController();
		const deleting = harness.deleteConversations([doomed.id], withAbortSignal(caller.signal, context));
		await eventually(async () => (await harness.getTask(slow, context))?.abortRequested === true);
		caller.abort();
		await expect(deleting).rejects.toThrow("aborted");
		abortGates.get("slow")!.resolve();
		await eventually(async () => (await harness.conversation(doomed.id, context)) === undefined);
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
		await expect(
			harness.commit(
				(tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" }, conversationId: doomed.id }),
				context,
			),
		).rejects.toBeInstanceOf(ConversationDeleting);
		expect(await harness.conversation(doomed.id, context)).toBeDefined();
		harness.resume();
		await eventually(async () => (await harness.conversation(doomed.id, context)) === undefined);
		expect(await status(harness, slow)).toBeUndefined();
		await harness.close(context);
	});

	it("erases what SQLite deleted from the database file and the WAL with secureDelete", async () => {
		const folder = await directory();
		const harness = await open(await openNodeSqliteStorage(join(folder, "session.sqlite"), { secureDelete: true }));
		const conversation = await ownerless(harness);
		const secret = (what: string) => `secret-${what}-of-the-deleted-conversation-`.repeat(200);
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "message", model: [user(secret("entry"))] });
			(await tx.doc(Notes, conversation.id)).text = secret("replaced");
		}, context);
		// Its base replaces the first: a page this commit frees, before the deletion.
		await conversation.commit(async (tx) => {
			(await tx.doc(Notes, conversation.id)).text = secret("retired");
		}, context);
		// The deletion's batch retires the document, which drops its revisions before the deletion's own statements.
		await harness.deleteConversations([conversation.id], context);
		for (const file of await readdir(folder)) {
			const bytes = await readFile(join(folder, file));
			for (const what of ["entry", "replaced", "retired"])
				expect(bytes.includes(secret(what).slice(0, 200))).toBe(false);
		}
		await harness.close(context);
	});
});
