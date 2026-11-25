// Harness.deleteConversations(): abort, then remove a conversation and the conversations its tasks own (#11026).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchEnd } from "@earendil-works/chord/watch";
import {
	type ConversationId,
	defineTask,
	type Harness,
	LiveDoc,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { user } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, openTasks } from "./task-support.ts";

/** Holds until aborted; its abort handler ends it `aborted`. */
const Hold = defineTask<null, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: (_task, runtime) => aborted(runtime.signal) },
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

const storages: Record<string, () => Promise<Storage>> = {
	memory: async () => new MemoryStorage(),
	sqlite: async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-delete-"));
		directories.add(directory);
		return openNodeSqliteStorage(join(directory, "session.sqlite"));
	},
};

async function open(storage: Storage): Promise<Harness> {
	const { harness } = await openTasks(storage, [Hold]);
	harness.resume();
	return harness;
}

function ownerless(harness: Harness) {
	return harness.createConversation({ ownership: { kind: "ownerless" } }, context);
}

async function status(harness: Harness, id: TaskId): Promise<string | undefined> {
	return (await harness.getTask(id, context))?.state.status;
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
				const owner = await tx.createTask(Hold, null, { ownership: { kind: "conversation" } });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
				const background = await tx.createTask(Hold, null, {
					ownership: { kind: "conversation" },
					conversationId: child.id,
					background: true,
				});
				const entry = await tx.appendEntry(child.id, { kind: "message", model: [user("child secret")] });
				return { owner, child: child.id, background, entry: entry.id };
			}, context);
			const secret = await parent.commit(
				(tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("secret")] }),
				context,
			);
			const queued = await parent.commit(
				(tx) => tx.createSubmission({ conversationId: parent.id, type: "write", status: "queued" }),
				context,
			);
			const settled = (await harness.submission(queued.id, context))!.wait(context);
			const ends: WatchEnd[] = [];
			await harness.observeConversation(parent.id, { advance: () => {}, end: (end) => ends.push(end) }, context);

			await harness.deleteConversations([parent.id], context);

			expect(await settled).toMatchObject({ status: "unanswered", reason: "deleted" });
			expect(ends).toEqual([{ kind: "ended" }]);
			expect(await harness.conversation(parent.id, context)).toBeUndefined();
			expect(await harness.conversation(tree.child, context)).toBeUndefined();
			for (const id of [tree.owner, tree.background]) expect(await status(harness, id)).toBeUndefined();
			expect(await harness.snapshot(LiveDoc, parent.id, context)).toBeUndefined();
			expect(await harness.submission(queued.id, context)).toBeUndefined();
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

	it("refuses the root, a fork left behind, and a live owner outside, aborting nothing", async () => {
		const harness = await open(new MemoryStorage());
		await harness.root(context);
		await expect(harness.deleteConversations([ROOT_CONVERSATION_ID], context)).rejects.toThrow(
			"The root conversation cannot be deleted",
		);

		const parent = await ownerless(harness);
		const entry = await parent.commit(
			(tx) => tx.appendEntry(parent.id, { kind: "message", model: [user("shared")] }),
			context,
		);
		const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const live = await parent.commit(
			(tx) => tx.createTask(Hold, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await expect(harness.deleteConversations([parent.id], context)).rejects.toThrow(
			`Conversation ${parent.id} has fork ${fork.id}, which is not deleted with it`,
		);
		expect(await status(harness, live)).not.toBe("terminal");

		const owned = await parent.commit(
			(tx) => tx.createConversation({ ownership: { kind: "task", taskId: live } }),
			context,
		);
		await expect(harness.deleteConversations([owned.id], context)).rejects.toThrow(
			`Conversation ${owned.id} is owned by live task ${live}`,
		);
		expect(await status(harness, live)).not.toBe("terminal");

		// A fork deleted with its parent is no obstacle; the live task is aborted first.
		await harness.deleteConversations([parent.id, fork.id], context);
		expect(await harness.conversation(fork.id, context)).toBeUndefined();
		expect(await harness.conversation(owned.id, context)).toBeUndefined();
		await harness.close(context);
	});
});
