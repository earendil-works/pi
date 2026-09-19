import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/memory-storage.ts";
import {
	type EntryRecord,
	type Id,
	type Input,
	ROOT_CONVERSATION_ID,
	type StorageWrite,
	type TaskRecord,
} from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

async function createRoot(storage: MemoryStorage): Promise<Id> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return ROOT_CONVERSATION_ID;
}

function pendingTask(id: Id, conversationId: Id, phase = "ready") {
	return {
		id,
		conversationId,
		kind: "test.task",
		version: 1,
		input: { value: id },
		state: { status: "pending", checkpoint: { phase } },
		after: [],
		background: false,
		abortRequested: false,
	} satisfies StoredTask;
}

function entry(id: Id, conversationId: Id, kind = "message", extra: Partial<EntryRecord> = {}): EntryRecord {
	return { id, conversationId, kind, ...extra };
}

describe("Pico MemoryStorage", () => {
	it("reserves ID 1 for the immutable root conversation", async () => {
		const storage = new MemoryStorage();
		expect(storage.mintId()).toBe(2);
		await expect(createRoot(storage)).resolves.toBe(ROOT_CONVERSATION_ID);
		expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		await expect(
			storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
		).rejects.toThrow(`ID ${ROOT_CONVERSATION_ID} already belongs to conversation`);
	});

	it("commits mixed table writes atomically and rolls all of them back on failure", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const entryId = storage.mintId();
		const taskId = storage.mintId();
		const inputId = storage.mintId();
		const task = pendingTask(taskId, rootId);
		const input: Input = {
			id: inputId,
			conversationId: rootId,
			requestId: "request-1",
			status: "placed",
			entry: entryId,
		};
		const initialSeq = await storage.commit(
			[
				{ type: "entry", value: entry(entryId, rootId, "user", { data: { text: "hello" } }) },
				{ type: "task", value: task },
				{ type: "input", value: input },
			],
			context,
		);

		expect(await storage.entry(entryId, context)).toEqual({
			entry: entry(entryId, rootId, "user", { data: { text: "hello" } }),
			commitSeq: initialSeq,
		});
		expect(await storage.task(taskId, context)).toEqual(task);
		expect(await storage.input(inputId, context)).toEqual(input);

		const transientEntryId = storage.mintId();
		const runningTask: StoredTask = {
			...task,
			state: { status: "running", checkpoint: { phase: "effect" } },
		};
		const doneInput: Input = { ...input, status: "done", answer: transientEntryId };
		await expect(
			storage.commit(
				[
					{ type: "task", value: runningTask },
					{ type: "input", value: doneInput },
					{ type: "entry", value: entry(transientEntryId, rootId, "assistant") },
					{ type: "conversation", value: { id: rootId } },
				],
				context,
			),
		).rejects.toThrow(`ID ${rootId} already belongs to conversation`);

		expect(await storage.task(taskId, context)).toEqual(task);
		expect(await storage.input(inputId, context)).toEqual(input);
		expect(await storage.entry(transientEntryId, context)).toBeUndefined();
		expect(
			await storage.commit([{ type: "entry", value: entry(storage.mintId(), rootId, "after-rollback") }], context),
		).toBe(initialSeq + 1);
	});

	it("detaches retained writes and every returned record", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const entryId = storage.mintId();
		const taskId = storage.mintId();
		const inputId = storage.mintId();
		const entryData = { nested: [1, 2] };
		const checkpoint = { phase: "ready", nested: { count: 1 } };
		const detail = { codes: ["initial"] };
		const storedEntry = entry(entryId, rootId, "note", { data: entryData });
		const storedTask: StoredTask = {
			...pendingTask(taskId, rootId),
			state: { status: "pending", checkpoint },
		};
		const storedInput: Input = {
			id: inputId,
			conversationId: rootId,
			status: "unanswered",
			reason: "failed",
			detail,
		};
		await storage.commit(
			[
				{ type: "entry", value: storedEntry },
				{ type: "task", value: storedTask },
				{ type: "input", value: storedInput },
			],
			context,
		);

		entryData.nested.push(3);
		checkpoint.nested.count = 2;
		detail.codes.push("mutated");
		expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
		expect((await storage.task(taskId, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "ready", nested: { count: 1 } },
		});
		expect((await storage.input(inputId, context))?.detail).toEqual({ codes: ["initial"] });

		const readEntry = (await storage.entry(entryId, context))!.entry;
		(readEntry.data as { nested: number[] }).nested.push(9);
		const readTask = (await storage.task(taskId, context))!;
		if (readTask.state.status !== "terminal") {
			(readTask.state.checkpoint as { phase: string; nested: { count: number } }).nested.count = 9;
		}
		const readInput = (await storage.input(inputId, context))!;
		(readInput.detail as { codes: string[] }).codes.push("read mutation");

		expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
		expect((await storage.task(taskId, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "ready", nested: { count: 1 } },
		});
		expect((await storage.input(inputId, context))?.detail).toEqual({ codes: ["initial"] });
	});

	it("detaches prototype-like JSON keys without changing object prototypes", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const entryId = storage.mintId();
		const data = JSON.parse(
			'{"__proto__":{"polluted":false},"constructor":{"label":"stored"},"toString":"value"}',
		) as Record<string, JsonValue>;
		await storage.commit([{ type: "entry", value: entry(entryId, rootId, "note", { data }) }], context);

		(Reflect.get(data, "__proto__") as Record<string, JsonValue>).polluted = true;
		(Reflect.get(data, "constructor") as Record<string, JsonValue>).label = "mutated";
		const firstRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
		expect(Object.getPrototypeOf(firstRead)).toBe(Object.prototype);
		expect(Object.hasOwn(firstRead, "__proto__")).toBe(true);
		expect(Reflect.get(firstRead, "__proto__")).toEqual({ polluted: false });
		expect(Reflect.get(firstRead, "constructor")).toEqual({ label: "stored" });
		expect(Reflect.get(firstRead, "toString")).toBe("value");
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

		(Reflect.get(firstRead, "__proto__") as Record<string, JsonValue>).polluted = true;
		const secondRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
		expect(Reflect.get(secondRead, "__proto__")).toEqual({ polluted: false });
		expect(Reflect.get(secondRead, "constructor")).toEqual({ label: "stored" });
		expect(Reflect.get(secondRead, "toString")).toBe("value");
	});

	it("indexes entries committed out of ID order", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		await storage.commit(
			[
				{ type: "entry", value: entry(30, rootId) },
				{ type: "entry", value: entry(10, rootId) },
				{ type: "entry", value: entry(20, rootId, "marker", { head: 10 }) },
			],
			context,
		);

		expect(
			(await storage.scanEntries({ conversationId: rootId }, undefined, 10, context)).items.map(({ id }) => id),
		).toEqual([30, 20, 10]);
		expect((await storage.findLatestHeadMarker(rootId, undefined, context))?.id).toBe(20);
	});

	it("continues an entry cursor below its last item after a newer commit", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const oldestId = storage.mintId();
		const middleId = storage.mintId();
		const newestId = storage.mintId();
		await storage.commit(
			[
				{ type: "entry", value: entry(oldestId, rootId) },
				{ type: "entry", value: entry(middleId, rootId) },
				{ type: "entry", value: entry(newestId, rootId) },
			],
			context,
		);

		const first = await storage.scanEntries({ conversationId: rootId }, undefined, 2, context);
		expect(first.items.map(({ id }) => id)).toEqual([newestId, middleId]);
		const appendedId = storage.mintId();
		await storage.commit([{ type: "entry", value: entry(appendedId, rootId) }], context);
		const second = await storage.scanEntries({ conversationId: rootId }, first.next, 2, context);
		expect(second.items.map(({ id }) => id)).toEqual([oldestId]);
		expect(second.next).toBeUndefined();
	});

	it("paginates conversations by opaque cursor in ascending ID order", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const secondId = storage.mintId();
		const thirdId = storage.mintId();
		await storage.commit(
			[
				{ type: "conversation", value: { id: thirdId } },
				{ type: "conversation", value: { id: secondId } },
			],
			context,
		);

		const first = await storage.scanConversations(undefined, 2, context);
		expect(first.items.map(({ id }) => id)).toEqual([rootId, secondId]);
		expect(first.next).toEqual({ after: secondId });
		const second = await storage.scanConversations(first.next, 2, context);
		expect(second.items.map(({ id }) => id)).toEqual([thirdId]);
		expect(second.next).toBeUndefined();
	});

	it("scans deep fork history newest-first through every ancestor cap", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const rootFirst = storage.mintId();
		const rootForkPoint = storage.mintId();
		const rootExcludedSameCommit = storage.mintId();
		const rootEntriesSeq = await storage.commit(
			[
				{ type: "entry", value: entry(rootFirst, rootId) },
				{
					type: "entry",
					value: entry(rootForkPoint, rootId, "marker", { head: rootFirst }),
				},
				{ type: "entry", value: entry(rootExcludedSameCommit, rootId) },
			],
			context,
		);
		const childId = storage.mintId();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: childId, parent: { conversationId: rootId, at: rootForkPoint } },
				},
			],
			context,
		);
		const childForkPoint = storage.mintId();
		const childExcluded = storage.mintId();
		await storage.commit(
			[
				{ type: "entry", value: entry(childForkPoint, childId, "note") },
				{ type: "entry", value: entry(childExcluded, childId) },
			],
			context,
		);
		const rootExcludedLater = storage.mintId();
		await storage.commit([{ type: "entry", value: entry(rootExcludedLater, rootId) }], context);
		const grandchildId = storage.mintId();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: grandchildId, parent: { conversationId: childId, at: childForkPoint } },
				},
			],
			context,
		);
		const grandchildHead = storage.mintId();
		const grandchildTail = storage.mintId();
		const grandchildEntriesSeq = await storage.commit(
			[
				{
					type: "entry",
					value: entry(grandchildHead, grandchildId, "marker", { head: grandchildHead }),
				},
				{ type: "entry", value: entry(grandchildTail, grandchildId) },
			],
			context,
		);
		const childExcludedLater = storage.mintId();
		await storage.commit([{ type: "entry", value: entry(childExcludedLater, childId) }], context);

		const first = await storage.scanEntries({ conversationId: grandchildId }, undefined, 2, context);
		expect(first.items.map(({ id }) => id)).toEqual([grandchildTail, grandchildHead]);
		const second = await storage.scanEntries({ conversationId: grandchildId }, first.next, 2, context);
		expect(second.items.map(({ id }) => id)).toEqual([childForkPoint, rootForkPoint]);
		const third = await storage.scanEntries({ conversationId: grandchildId }, second.next, 2, context);
		expect(third.items.map(({ id }) => id)).toEqual([rootFirst]);
		expect(third.next).toBeUndefined();

		const currentMarker = await storage.findLatestHeadMarker(grandchildId, undefined, context);
		expect(currentMarker?.id).toBe(grandchildHead);
		expect(currentMarker?.head).toBe(grandchildHead);
		const historicalMarker = await storage.findLatestHeadMarker(grandchildId, childForkPoint, context);
		expect(historicalMarker?.id).toBe(rootForkPoint);
		expect(historicalMarker?.head).toBe(rootFirst);
		expect(await storage.findLatestHeadMarker(grandchildId, rootFirst, context)).toBeUndefined();

		const activeFirst = await storage.scanEntries(
			{ conversationId: grandchildId, minEntryId: currentMarker?.head },
			undefined,
			1,
			context,
		);
		expect(activeFirst.items.map(({ id }) => id)).toEqual([grandchildTail]);
		expect(activeFirst.next).toBeDefined();
		const activeSecond = await storage.scanEntries(
			{ conversationId: grandchildId, minEntryId: currentMarker?.head },
			activeFirst.next,
			1,
			context,
		);
		expect(activeSecond.items.map(({ id }) => id)).toEqual([grandchildHead]);
		expect(activeSecond.next).toBeUndefined();

		expect(
			(
				await storage.scanEntries(
					{
						conversationId: grandchildId,
						minEntryId: historicalMarker?.head,
						maxEntryId: childForkPoint,
					},
					undefined,
					10,
					context,
				)
			).items.map(({ id }) => id),
		).toEqual([childForkPoint, rootForkPoint, rootFirst]);

		expect(await storage.entry(rootFirst, context)).toEqual({
			entry: entry(rootFirst, rootId),
			commitSeq: rootEntriesSeq,
		});
		expect((await storage.entry(rootForkPoint, context))?.commitSeq).toBe(rootEntriesSeq);
		expect((await storage.entry(grandchildHead, context))?.commitSeq).toBe(grandchildEntriesSeq);
		expect((await storage.entry(grandchildTail, context))?.commitSeq).toBe(grandchildEntriesSeq);
		expect(await storage.entry(999_999, context)).toBeUndefined();
		await expect(storage.scanEntries({ conversationId: 999_999 }, undefined, 10, context)).rejects.toThrow(
			"Unknown conversation",
		);
	});

	it("replaces complete task records and pages filtered task scans", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const firstId = storage.mintId();
		const secondId = storage.mintId();
		const thirdId = storage.mintId();
		const first = { ...pendingTask(firstId, rootId), memos: { winner: "first" } } satisfies StoredTask;
		const second = { ...pendingTask(secondId, rootId), background: true } satisfies StoredTask;
		const third = { ...pendingTask(thirdId, rootId), abortRequested: true } satisfies StoredTask;
		await storage.commit(
			[
				{ type: "task", value: first },
				{ type: "task", value: second },
				{ type: "task", value: third },
			],
			context,
		);

		const running: StoredTask = {
			...first,
			state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } },
			abortRequested: true,
		};
		await storage.commit([{ type: "task", value: running }], context);
		expect(await storage.task(firstId, context)).toEqual(running);
		const terminal: StoredTask = {
			id: firstId,
			conversationId: rootId,
			kind: first.kind,
			version: first.version,
			input: first.input,
			state: { status: "terminal", outcome: { status: "completed", result: { entryId: 99 } } },
			after: [],
			background: false,
			abortRequested: true,
		};
		await storage.commit([{ type: "task", value: terminal }], context);
		expect(await storage.task(firstId, context)).toEqual(terminal);

		const pendingPage = await storage.scanTasks({ status: "pending" }, undefined, 1, context);
		expect(pendingPage.items.map(({ id }) => id)).toEqual([secondId]);
		expect(pendingPage.next).toBeDefined();
		expect(
			(await storage.scanTasks({ status: "pending" }, pendingPage.next, 1, context)).items.map(({ id }) => id),
		).toEqual([thirdId]);
		expect(
			(await storage.scanTasks({ status: "terminal", abortRequested: true }, undefined, 10, context)).items,
		).toEqual([terminal]);
		expect((await storage.scanTasks({ background: true }, undefined, 10, context)).items.map(({ id }) => id)).toEqual(
			[secondId],
		);
	});

	it("indexes request IDs per conversation and replaces complete input records", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const secondConversationId = storage.mintId();
		await storage.commit([{ type: "conversation", value: { id: secondConversationId } }], context);
		const firstId = storage.mintId();
		const secondId = storage.mintId();
		const otherConversationId = storage.mintId();
		const first: Input = {
			id: firstId,
			conversationId: rootId,
			requestId: "same",
			status: "queued",
		};
		const second: Input = {
			id: secondId,
			conversationId: rootId,
			requestId: "other",
			status: "queued",
		};
		const otherConversation: Input = {
			id: otherConversationId,
			conversationId: secondConversationId,
			requestId: "same",
			status: "queued",
		};
		await storage.commit(
			[
				{ type: "input", value: first },
				{ type: "input", value: second },
				{ type: "input", value: otherConversation },
			],
			context,
		);
		expect(await storage.inputByRequest(rootId, "same", context)).toEqual(first);
		expect(await storage.inputByRequest(secondConversationId, "same", context)).toEqual(otherConversation);

		const placedSecond: Input = { ...second, status: "placed", entry: storage.mintId() };
		await storage.commit([{ type: "input", value: placedSecond }], context);
		expect(await storage.input(secondId, context)).toEqual(placedSecond);
		expect(await storage.inputByRequest(rootId, "other", context)).toEqual(placedSecond);
	});

	it("keeps one global record ID namespace and rejects exhausted ID minting", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const explicitEntryId = 100;
		await storage.commit([{ type: "entry", value: entry(explicitEntryId, rootId) }], context);
		expect(storage.mintId()).toBe(101);
		await expect(
			storage.commit([{ type: "task", value: pendingTask(explicitEntryId, rootId) }], context),
		).rejects.toThrow(`ID ${explicitEntryId} already belongs to entry`);

		await storage.commit([{ type: "entry", value: entry(Number.MAX_SAFE_INTEGER, rootId, "last-id") }], context);
		expect(() => storage.mintId()).toThrow("ID space is exhausted");
		expect(() => storage.mintId()).toThrow("ID space is exhausted");
	});

	it("rejects every operation after close", async () => {
		const storage = new MemoryStorage();
		await createRoot(storage);
		await storage.close(context);
		await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.commit([] satisfies StorageWrite[], context)).rejects.toThrow("closed");
		expect(() => storage.mintId()).toThrow("closed");
	});
});
