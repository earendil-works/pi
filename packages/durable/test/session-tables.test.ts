import type { JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	type EntryId,
	ReadAfterWrite,
	type Task,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { context, createConversation, documentChanges, flush, openTestSession } from "./session-support.ts";

type Checkpoint = { phase: "start" } | { phase: "next"; step: number };
const WorkTask: Task<{ path: string }, Checkpoint, { ok: boolean }, object> = {
	definition: { name: "test.work", version: 1, initial: () => ({ phase: "start" }) },
};

type Progress = { lines: string[] };
const ProgressDoc = defineDoc<Progress>({
	kind: "test.progress",
	version: 1,
	scope: "task",
	initial: () => ({ lines: [] }),
});
const StepDoc = defineDocFamily<Progress, null>({
	kind: "test.step",
	version: 1,
	family: true,
	scope: "task",
	initial: () => ({ lines: [] }),
});

type Notes = { text: string };
const NotesDoc = defineDoc<Notes>({
	kind: "test.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

function terminal(task: AnyTask): AnyTask {
	return {
		id: task.id,
		conversationId: task.conversationId,
		kind: task.kind,
		version: task.version,
		input: task.input,
		after: task.after,
		background: task.background,
		abortRequested: task.abortRequested,
		state: { status: "terminal", outcome: { status: "completed", result: { ok: true } } },
	};
}

async function createTask(
	session: ReturnType<typeof openTestSession>["session"],
	conversationId: ConversationId,
	withDocument = false,
): Promise<TaskId<{ ok: boolean }>> {
	return session.commit(async (tx) => {
		const taskId = await tx.createTask(WorkTask, { path: "a" }, { conversationId });
		if (withDocument) (await tx.doc(ProgressDoc, taskId)).lines.push("started");
		return taskId;
	}, context);
}

describe("Session transaction tables", () => {
	it("allows table reads only before the first table write", async () => {
		const { session } = openTestSession();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			expect(await tx.conversation(conversationId)).toEqual({ id: conversationId });
			expect(await tx.scanConversations({}, 1)).toEqual({ items: [{ id: conversationId }] });
			expect(await tx.scanTasks({ conversationId }, 10)).toEqual({ items: [] });
			expect(await tx.scanEntries({ conversationId }, 10)).toEqual({ items: [] });
			await tx.appendEntry(conversationId, { kind: "note" });
			await expect(tx.conversation(conversationId)).rejects.toBeInstanceOf(ReadAfterWrite);
			await expect(tx.task(idFromNumber<TaskId>(1))).rejects.toThrow(
				"Tx.task() cannot read tables after the first table write",
			);
			await expect(tx.entry(idFromNumber<EntryId>(1))).rejects.toBeInstanceOf(ReadAfterWrite);
			await expect(tx.scanConversations({}, 10)).rejects.toBeInstanceOf(ReadAfterWrite);
			await expect(tx.scanEntries({ conversationId }, 10)).rejects.toBeInstanceOf(ReadAfterWrite);
			// Document access remains available after table writes.
			(await tx.doc(NotesDoc, conversationId)).text = "after write";
		}, context);
		expect(await session.snapshot(NotesDoc, conversationId, context)).toEqual({ text: "after write" });
	});

	it("passes caller-selected limits and cursors through table scans", async () => {
		const { session } = openTestSession();
		const ids = [
			await createConversation(session),
			await createConversation(session),
			await createConversation(session),
		];
		await session.commit(async (tx) => {
			const first = await tx.scanConversations({}, 2);
			expect(first.items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
			expect(first.next).toBeDefined();
			const second = await tx.scanConversations({}, 2, first.next);
			expect(second.items.map(({ id }) => id)).toEqual(ids.slice(2));
			expect(second.next).toBeUndefined();
		}, context);
	});

	it("treats synchronous setTask as the first table write", async () => {
		const { session } = openTestSession();
		const conversationId = await createConversation(session);
		const taskId = await createTask(session, conversationId);
		await session.commit(async (tx) => {
			const task = (await tx.task(taskId))!;
			tx.setTask(task);
			await expect(tx.task(taskId)).rejects.toBeInstanceOf(ReadAfterWrite);
		}, context);
	});

	it("creates conversations, entries, and tasks with minted IDs", async () => {
		const { session, storage, publications } = openTestSession();
		const created = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const first = await tx.appendEntry(conversation.id, { kind: "note", data: "one" });
			const headed = await tx.appendEntry(conversation.id, { kind: "summary", head: "self" });
			const task = await tx.createTask(
				WorkTask,
				{ path: "x" },
				{ conversationId: conversation.id, background: true },
			);
			return { conversation, first, headed, task };
		}, context);
		const ids = [created.conversation.id, created.first.id, created.headed.id, created.task];
		expect(new Set(ids).size).toBe(4);
		expect(created.headed.head).toBe(created.headed.id);
		expect(created.first).toEqual({
			id: created.first.id,
			conversationId: created.conversation.id,
			kind: "note",
			data: "one",
		});
		expect((await storage.entry(created.headed.id, context))!.entry).toEqual(created.headed);
		expect(await storage.task(created.task, context)).toEqual({
			id: created.task,
			conversationId: created.conversation.id,
			kind: "test.work",
			version: 1,
			input: { path: "x" },
			after: [],
			background: true,
			abortRequested: false,
			state: { status: "pending", checkpoint: { phase: "start" } },
		});
		await flush();
		const changes = publications.at(-1)!.changes;
		expect(changes).toHaveLength(4);
		const admitted = storage.admittedCommits.at(-1)!;
		for (const change of changes) expect(admitted.some((write) => write === change)).toBe(true);
		expect(changes.map((change) => change.type)).toEqual(
			expect.arrayContaining(["conversation", "entry", "entry", "task"]),
		);
		expect(changes.find((change) => change.type === "conversation")!.value).toBe(created.conversation);
		const entries = changes.filter((change) => change.type === "entry");
		expect(entries.map((change) => change.value)).toContain(created.first);
		expect(entries.map((change) => change.value)).toContain(created.headed);
		await expect(session.commit((tx) => tx.createTask(WorkTask, { path: "x" }), context)).rejects.toThrow(
			"requires options.conversationId",
		);
		await expect(
			session.commit((tx) => tx.appendEntry(idFromNumber<ConversationId>(12345), { kind: "note" }), context),
		).rejects.toThrow("Conversation 12345 does not exist");
	});

	it("creates a conversation with an explicitly staged task owner", async () => {
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		const created = await session.commit(async (tx) => {
			const supervisorId = await tx.createTask(
				WorkTask,
				{ path: "background" },
				{ conversationId: parentId, background: true },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });
			return { supervisorId, child };
		}, context);

		expect(created.child.owner).toEqual({ conversationId: parentId, taskId: created.supervisorId });
		expect(await storage.conversation(created.child.id, context)).toEqual(created.child);

		await expect(
			session.commit(async (tx) => {
				const supervisor = (await tx.task(created.supervisorId))!;
				tx.setTask({ ...supervisor, conversationId: created.child.id });
			}, context),
		).rejects.toThrow(`Task ${created.supervisorId} cannot change conversations`);
		expect((await storage.task(created.supervisorId, context))?.conversationId).toBe(parentId);
	});

	it("rejects missing, terminal, and abort-marked conversation owners atomically", async () => {
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let movedStagedTaskId: TaskId<{ ok: boolean }> | undefined;
		await expect(
			session.commit(async (tx) => {
				const taskId = await tx.createTask(WorkTask, { path: "move" }, { conversationId: parentId });
				movedStagedTaskId = taskId;
				tx.setTask({
					id: taskId,
					conversationId: idFromNumber<ConversationId>(998),
					kind: WorkTask.definition.name,
					version: WorkTask.definition.version,
					input: { path: "move" },
					after: [],
					background: false,
					abortRequested: false,
					state: { status: "pending", checkpoint: { phase: "start" } },
				});
			}, context),
		).rejects.toThrow("cannot change conversations");
		if (movedStagedTaskId === undefined) throw new Error("Expected a staged task ID");
		expect(await storage.task(movedStagedTaskId, context)).toBeUndefined();

		const missingTaskId = idFromNumber<TaskId>(999);
		await expect(
			session.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: missingTaskId } }), context),
		).rejects.toThrow("Conversation owner task 999 does not exist");

		let rejectedChildId: ConversationId | undefined;
		await expect(
			session.commit(async (tx) => {
				const supervisorId = await tx.createTask(WorkTask, { path: "aborting" }, { conversationId: parentId });
				rejectedChildId = (await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } })).id;
				tx.setTask({
					id: supervisorId,
					conversationId: parentId,
					kind: WorkTask.definition.name,
					version: WorkTask.definition.version,
					input: { path: "aborting" },
					after: [],
					background: false,
					abortRequested: true,
					state: { status: "pending", checkpoint: { phase: "start" } },
				});
			}, context),
		).rejects.toThrow("is abort-marked");
		expect(rejectedChildId).toBeDefined();
		if (rejectedChildId === undefined) throw new Error("Expected a rejected child ID");
		expect(await storage.conversation(rejectedChildId, context)).toBeUndefined();

		await expect(
			session.commit(async (tx) => {
				const supervisorId = await tx.createTask(WorkTask, { path: "terminal" }, { conversationId: parentId });
				await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });
				tx.setTask({
					id: supervisorId,
					conversationId: parentId,
					kind: WorkTask.definition.name,
					version: WorkTask.definition.version,
					input: { path: "terminal" },
					after: [],
					background: false,
					abortRequested: false,
					state: { status: "terminal", outcome: { status: "completed", result: { ok: true } } },
				});
			}, context),
		).rejects.toThrow("is terminal");

		const terminalOwnerId = await createTask(session, parentId);
		await session.commit(async (tx) => {
			tx.setTask(terminal((await tx.task(terminalOwnerId))!));
		}, context);
		await expect(
			session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "task", taskId: terminalOwnerId } }),
				context,
			),
		).rejects.toThrow("is terminal");
	});

	it("takes ownership of table JSON and rejects non-strict values", async () => {
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		const payload = { nested: { value: 1 } };
		const entry = await session.commit(async (tx) => {
			const created = await tx.appendEntry(conversationId, { kind: "data", data: payload });
			payload.nested.value = 2;
			return created;
		}, context);
		expect((await storage.entry(entry.id, context))!.entry.data).toEqual({ nested: { value: 1 } });
		const omitted = await session.commit(
			(tx) => tx.appendEntry(conversationId, { kind: "omitted", data: undefined }),
			context,
		);
		expect(Object.hasOwn(omitted, "data")).toBe(false);
		expect(Object.hasOwn((await storage.entry(omitted.id, context))!.entry, "data")).toBe(false);

		const commits = storage.commits.length;
		await expect(
			session.commit(
				(tx) => tx.appendEntry(conversationId, { kind: "invalid", data: Number.NaN }).then(() => undefined),
				context,
			),
		).rejects.toThrow("strict JSON");
		expect(storage.commits.length).toBe(commits);
	});

	it("replaces task records completely", async () => {
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		const taskId = await createTask(session, conversationId);
		await session.commit(async (tx) => {
			const task = (await tx.task(taskId))!;
			tx.setTask({
				id: task.id,
				conversationId: task.conversationId,
				kind: task.kind,
				version: task.version,
				input: task.input,
				after: task.after,
				background: task.background,
				abortRequested: task.abortRequested,
				state: { status: "running", checkpoint: { phase: "next", step: 2 } },
				memos: { choice: "b" },
			});
		}, context);
		expect(await storage.task(taskId, context)).toMatchObject({
			state: { status: "running", checkpoint: { phase: "next", step: 2 } },
			memos: { choice: "b" },
		});
	});

	it("creates a task and then its document in one transaction without ReadAfterWrite", async () => {
		const { session, publications } = openTestSession();
		const conversationId = await createConversation(session);
		const taskId = await session.commit(async (tx) => {
			const createdTaskId = await tx.createTask(WorkTask, { path: "a" }, { conversationId });
			// Validation uses the candidate task record, not a caller table read.
			(await tx.doc(ProgressDoc, createdTaskId)).lines.push("created");
			(await tx.doc(StepDoc, createdTaskId, "one", null)).lines.push("step");
			return createdTaskId;
		}, context);
		expect(await session.snapshot(ProgressDoc, taskId, context)).toEqual({ lines: ["created"] });
		await flush();
		const publication = publications.at(-1)!;
		const documents = documentChanges(publication);
		expect(publication.changes).toContainEqual(
			expect.objectContaining({ type: "task", value: expect.objectContaining({ id: taskId }) }),
		);
		expect(documents).toHaveLength(2);
		// Task documents derive their conversation from the task record.
		for (const document of documents) expect(document.conversationId).toBe(conversationId);

		await session.commit(async (tx) => {
			await tx.createConversation({ ownership: { kind: "ownerless" } });
			(await tx.doc(ProgressDoc, taskId)).lines.push("committed task");
		}, context);
		await flush();
		expect(documentChanges(publications.at(-1)!)[0]!.conversationId).toBe(conversationId);
	});

	it("rejects task documents after a terminal candidate", async () => {
		const { session } = openTestSession();
		const conversationId = await createConversation(session);
		const taskId = await createTask(session, conversationId, true);
		await session.commit(async (tx) => {
			const task = (await tx.task(taskId))!;
			const progress = await tx.doc(ProgressDoc, taskId);
			tx.setTask(terminal(task));
			await expect(tx.doc(ProgressDoc, taskId)).rejects.toThrow(`Task ${taskId} is terminal`);
			await expect(tx.doc(StepDoc, taskId, "late", null)).rejects.toThrow(`Task ${taskId} is terminal`);
			expect(() => tx.setTask(task)).toThrow("terminal candidate");
			progress.lines.push("final");
		}, context);
		await expect(session.commit((tx) => tx.doc(ProgressDoc, taskId).then(() => undefined), context)).rejects.toThrow(
			`Task ${taskId} is terminal`,
		);
	});

	it("retires task documents at terminal settlement, including documents created in the same transaction", async () => {
		const { session, storage, publications } = openTestSession();
		const conversationId = await createConversation(session);
		const taskId = await createTask(session, conversationId, true);
		await session.commit(async (tx) => {
			(await tx.doc(StepDoc, taskId, "committed", null)).lines.push("x");
		}, context);
		await flush();
		const published = publications.length;
		await session.commit(async (tx) => {
			const task = (await tx.task(taskId))!;
			(await tx.doc(StepDoc, taskId, "new", null)).lines.push("created then retired");
			tx.setTask(terminal(task));
		}, context);
		const writes = storage.commits.at(-1)!;
		expect(writes).toHaveLength(5);
		expect(writes.filter((write) => write.type === "task")).toHaveLength(1);
		const creations = writes.filter((write) => write.type === "document.create");
		const retirements = writes.filter((write) => write.type === "document.retire");
		expect(creations).toHaveLength(1);
		expect(retirements).toHaveLength(3);
		expect(retirements.map((write) => write.id)).toContain(creations[0]!.record.id);
		await flush();
		expect(publications.length).toBe(published + 1);
		const publication = publications.at(-1)!;
		const documents = documentChanges(publication);
		expect(publication.changes.filter((change) => change.type === "task")).toHaveLength(1);
		expect(documents.map((document) => document.value)).toEqual([null, null, null]);
		for (const document of documents) expect(document.ops).toEqual([]);
		for (const document of documents) expect(document.conversationId).toBe(conversationId);
		expect(await session.snapshot(ProgressDoc, taskId, context)).toBeUndefined();
		expect(await session.snapshot(StepDoc, taskId, "committed", context)).toBeUndefined();
		const alive = await storage.scanDocuments(
			{ scope: { kind: "task", taskId }, at: "current" },
			10,
			undefined,
			context,
		);
		expect(alive.items).toEqual([]);
		await expect(
			session.commit(async (tx) => {
				tx.setTask(terminal((await tx.task(taskId))!));
			}, context),
		).rejects.toThrow(`Task ${taskId} is already terminal`);
	});

	it("validates document owners", async () => {
		const { session } = openTestSession();
		await expect(
			session.commit((tx) => tx.doc(ProgressDoc, idFromNumber<TaskId>(4242)).then(() => undefined), context),
		).rejects.toThrow("Task 4242 does not exist");
		await expect(
			session.commit((tx) => tx.doc(NotesDoc, idFromNumber<ConversationId>(4242)).then(() => undefined), context),
		).rejects.toThrow("Conversation 4242 does not exist");
	});
});
