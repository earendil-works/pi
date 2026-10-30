/// <reference lib="dom" />

import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { IDBKeyRange as FakeIDBKeyRange, IDBObjectStore as FakeIDBObjectStore, IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { IndexedDbStorage } from "../src/storage/indexeddb.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type {
	CommitResult,
	ConversationId,
	DocumentCreate,
	DocumentId,
	EntryId,
	Id,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	TaskId,
	TaskRecord,
} from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: FakeIDBKeyRange });

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

class ReopeningStorage implements Storage {
	private current: IndexedDbStorage;
	private readonly name: string;
	private readonly indexedDB: IDBFactory;
	private closed = false;

	constructor(current: IndexedDbStorage, name: string, indexedDB: IDBFactory) {
		this.current = current;
		this.name = name;
		this.indexedDB = indexedDB;
	}

	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		commitContext: Context,
	): Promise<CommitResult> {
		if (this.closed) return this.current.commit(batches, receive, commitContext);
		try {
			return await this.current.commit(batches, receive, commitContext);
		} finally {
			await this.current.close(context);
			this.current = await IndexedDbStorage.open(this.name, { indexedDB: this.indexedDB });
		}
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.current.mintId<I>();
	}
	conversation: Storage["conversation"] = (id, readContext) => this.current.conversation(id, readContext);
	scanConversations: Storage["scanConversations"] = (query, limit, cursor, readContext) =>
		this.current.scanConversations(query, limit, cursor, readContext);
	entry(id: EntryId, readContext: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, readContext: Context): ReturnType<Storage["entry"]>;
	entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, readContext?: Context) {
		if (readContext === undefined) {
			return this.current.entry(idFromNumber<EntryId>(idOrConversationId), idOrContext as Context);
		}
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		return this.current.entry(
			idFromNumber<ConversationId>(idOrConversationId),
			idFromNumber<EntryId>(idOrContext),
			readContext,
		);
	}
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (conversationId, at, readContext) =>
		this.current.findLatestHeadMarker(conversationId, at, readContext);
	scanEntries: Storage["scanEntries"] = (query, limit, cursor, readContext) =>
		this.current.scanEntries(query, limit, cursor, readContext);
	task: Storage["task"] = (id, readContext) => this.current.task(id, readContext);
	scanTasks: Storage["scanTasks"] = (query, limit, cursor, readContext) =>
		this.current.scanTasks(query, limit, cursor, readContext);
	submission: Storage["submission"] = (id, readContext) => this.current.submission(id, readContext);
	scanSubmissions: Storage["scanSubmissions"] = (query, limit, cursor, readContext) =>
		this.current.scanSubmissions(query, limit, cursor, readContext);
	submissionByRequest: Storage["submissionByRequest"] = (conversationId, requestId, readContext) =>
		this.current.submissionByRequest(conversationId, requestId, readContext);
	findDocument: Storage["findDocument"] = (address, at, readContext) =>
		this.current.findDocument(address, at, readContext);
	document: Storage["document"] = (id, at, readContext) => this.current.document(id, at, readContext);
	scanDocuments: Storage["scanDocuments"] = (query, limit, cursor, readContext) =>
		this.current.scanDocuments(query, limit, cursor, readContext);

	async close(closeContext: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.current.close(closeContext);
	}
}

async function withStorage(use: (storage: Storage) => Promise<void>): Promise<void> {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("conformance", { indexedDB });
	try {
		await use(storage);
	} finally {
		await storage.close(context);
	}
}

registerStorageConformance({ describe, expect, it }, "IndexedDbStorage", withStorage);

registerStorageConformance({ describe, expect, it }, "IndexedDbStorage across reopen", async (use) => {
	const indexedDB = new IDBFactory();
	const name = "reopening-conformance";
	const created = await IndexedDbStorage.open(name, { indexedDB });
	await created.close(context);
	const storage = new ReopeningStorage(await IndexedDbStorage.open(name, { indexedDB }), name, indexedDB);
	try {
		await use(storage);
	} finally {
		await storage.close(context);
	}
});

function pendingTask(id: TaskId<JsonValue>, conversationId = ROOT_CONVERSATION_ID): StoredTask {
	return {
		id,
		conversationId,
		kind: "test.task",
		version: 1,
		input: null,
		state: { status: "pending", checkpoint: { phase: "ready" } },
		background: false,
		abortRequested: false,
	};
}

async function createRoot(storage: Storage): Promise<void> {
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
}

it("persists minted IDs across reopen", async () => {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("mint-reopen", { indexedDB });
	expect(await storage.mintId<EntryId>()).toBe(2);
	await storage.close(context);
	const reopened = await IndexedDbStorage.open("mint-reopen", { indexedDB });
	try {
		expect(await reopened.mintId<EntryId>()).toBe(3);
	} finally {
		await reopened.close(context);
	}
});

it("rolls back table writes when a later document copy fails", async () => {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("atomic-copy", { indexedDB });
	try {
		await createRoot(storage);
		const sourceId = await storage.mintId<DocumentId>();
		const source = {
			id: sourceId,
			kind: "source",
			scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
			history: "rewindable",
			fork: "asOf",
		} satisfies DocumentCreate;
		await commitWrites(
			storage,
			[{ type: "document.create", record: source, content: { kind: "base", version: 1, value: { count: 1 } } }],
			context,
		);
		const taskId = await storage.mintId<TaskId<JsonValue>>();
		const copyId = await storage.mintId<DocumentId>();
		await expect(
			commitWrites(
				storage,
				[
					{ type: "task", value: pendingTask(taskId) },
					{
						type: "document.copy",
						record: { ...source, id: copyId, kind: "mismatch" },
						source: { id: sourceId, at: "current" },
					},
				],
				context,
			),
		).rejects.toThrow("was rejected");
		expect(await storage.task(taskId, context)).toBeUndefined();
		expect(await storage.document(copyId, "current", context)).toBeUndefined();
	} finally {
		await storage.close(context);
	}
});

it("scans entries and head markers through fork ancestry", async () => {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("fork-ancestry", { indexedDB });
	try {
		await createRoot(storage);
		const rootFirst = await storage.mintId<EntryId>();
		const rootMarker = await storage.mintId<EntryId>();
		await commitWrites(
			storage,
			[
				{ type: "entry", value: { id: rootFirst, conversationId: ROOT_CONVERSATION_ID, kind: "first" } },
				{
					type: "entry",
					value: {
						id: rootMarker,
						conversationId: ROOT_CONVERSATION_ID,
						kind: "marker",
						head: rootFirst,
					},
				},
			],
			context,
		);
		const childId = await storage.mintId<ConversationId>();
		await commitWrites(
			storage,
			[
				{
					type: "conversation",
					value: { id: childId, parent: { conversationId: ROOT_CONVERSATION_ID, at: rootMarker } },
				},
			],
			context,
		);
		const childEntry = await storage.mintId<EntryId>();
		await commitWrites(
			storage,
			[{ type: "entry", value: { id: childEntry, conversationId: childId, kind: "child" } }],
			context,
		);
		expect(
			(await storage.scanEntries({ conversationId: childId }, 10, undefined, context)).items.map(({ id }) => id),
		).toEqual([childEntry, rootMarker, rootFirst]);
		expect((await storage.findLatestHeadMarker(childId, undefined, context))?.id).toBe(rootMarker);
	} finally {
		await storage.close(context);
	}
});

it("keeps one readwrite transaction active through many mixed writes", async () => {
	const indexedDB = new IDBFactory();
	const storage = await IndexedDbStorage.open("large-commit", { indexedDB });
	try {
		await createRoot(storage);
		const writes: StorageWrite[] = [];
		let lastEntryId: EntryId | undefined;
		let lastTaskId: TaskId<JsonValue> | undefined;
		let lastSubmissionId: SubmissionId | undefined;
		let lastDocumentId: DocumentId | undefined;
		for (let index = 0; index < 40; index++) {
			lastEntryId = await storage.mintId<EntryId>();
			lastTaskId = await storage.mintId<TaskId<JsonValue>>();
			lastSubmissionId = await storage.mintId<SubmissionId>();
			lastDocumentId = await storage.mintId<DocumentId>();
			writes.push(
				{
					type: "entry",
					value: { id: lastEntryId, conversationId: ROOT_CONVERSATION_ID, kind: "bulk", data: { index } },
				},
				{ type: "task", value: pendingTask(lastTaskId) },
				{
					type: "submission",
					value: {
						id: lastSubmissionId,
						conversationId: ROOT_CONVERSATION_ID,
						requestId: `bulk-${index}`,
						type: "input",
						status: "queued",
					},
				},
				{
					type: "document.create",
					record: { id: lastDocumentId, kind: "bulk", key: String(index), scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { index } },
				},
			);
		}
		await commitWrites(storage, writes, context);
		expect((await storage.entry(lastEntryId!, context))?.entry.data).toEqual({ index: 39 });
		expect(await storage.task(lastTaskId!, context)).toEqual(pendingTask(lastTaskId!));
		expect((await storage.submission(lastSubmissionId!, context))?.requestId).toBe("bulk-39");
		expect((await storage.document(lastDocumentId!, "current", context))?.value).toEqual({ index: 39 });
	} finally {
		await storage.close(context);
	}
});

describe("commit", () => {
	/** An entry of the root conversation. */
	const entryWrite = (id: EntryId): StorageWrite => ({
		type: "entry",
		value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "batch" },
	});
	const sourceRecord = (id: DocumentId, conversationId: ConversationId = ROOT_CONVERSATION_ID): DocumentCreate => ({
		id,
		kind: "source",
		scope: { kind: "conversation", conversationId },
		history: "rewindable",
		fork: "asOf",
	});

	/** Opens a storage with its root conversation, runs `test` on it, closes it. */
	async function withStorage(name: string, test: (storage: IndexedDbStorage) => Promise<void>): Promise<void> {
		const storage = await IndexedDbStorage.open(name, { indexedDB: new IDBFactory() });
		try {
			await createRoot(storage);
			await test(storage);
		} finally {
			await storage.close(context);
		}
	}

	it("stores the batches before a refused one, and the storage goes on", () =>
		withStorage("batch-prefix", async (storage) => {
			const first = await storage.mintId<EntryId>();
			const after = await storage.mintId<EntryId>();
			const receipts: [number, Seq][] = [];
			const result = await storage.commit(
				[[entryWrite(first)], [entryWrite(first)], [entryWrite(after)]],
				(index, seq) => receipts.push([index, seq]),
				context,
			);
			expect(result.stored).toBe(1);
			expect(String(result.refused)).toBe(`Error: ID ${first} already belongs to entry`);
			expect(receipts.map(([index]) => index)).toEqual([0]);
			expect((await storage.entry(first, context))?.commitSeq).toBe(receipts[0]![1]);
			expect(await storage.entry(after, context)).toBeUndefined();
			// The prefix advanced the metadata: the next commit takes the next seq.
			const next = await commitWrites(storage, [entryWrite(after)], context);
			expect(next).toBe(receipts[0]![1] + 1);
		}));

	it("resolves a copy against the state an earlier batch of the call left", () =>
		withStorage("batch-copy", async (storage) => {
			const sourceId = await storage.mintId<DocumentId>();
			const childId = await storage.mintId<ConversationId>();
			const copyId = await storage.mintId<DocumentId>();
			const result = await storage.commit(
				[
					[
						{
							type: "document.create",
							record: sourceRecord(sourceId),
							content: { kind: "base", version: 1, value: { count: 1 } },
						},
					],
					[
						{
							type: "document.change",
							id: sourceId,
							content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
						},
					],
					[
						{ type: "conversation", value: { id: childId } },
						{
							type: "document.copy",
							record: sourceRecord(copyId, childId),
							source: { id: sourceId, at: "current" },
						},
					],
				],
				() => {},
				context,
			);
			expect(result).toEqual({ stored: 3 });
			expect((await storage.document(copyId, "current", context))?.value).toEqual({ count: 2 });
		}));

	it("refuses a batch whose copy fails before it writes anything, keeping the batches before it", () =>
		withStorage("batch-copy-refused", async (storage) => {
			const sourceId = await storage.mintId<DocumentId>();
			await commitWrites(
				storage,
				[
					{
						type: "document.create",
						record: sourceRecord(sourceId),
						content: { kind: "base", version: 1, value: { count: 1 } },
					},
				],
				context,
			);
			const first = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const copyId = await storage.mintId<DocumentId>();
			const result = await storage.commit(
				[
					[entryWrite(first)],
					// The task comes before the copy: the refusal must leave it unwritten.
					[
						{ type: "task", value: pendingTask(taskId) },
						{
							type: "document.copy",
							record: { ...sourceRecord(copyId), kind: "mismatch" },
							source: { id: sourceId, at: "current" },
						},
					],
				],
				() => {},
				context,
			);
			expect(result.stored).toBe(1);
			expect(String(result.refused)).toContain(`Document copy ${copyId} was rejected`);
			expect(await storage.entry(first, context)).toBeDefined();
			expect(await storage.task(taskId, context)).toBeUndefined();
			expect(await storage.document(copyId, "current", context)).toBeUndefined();
		}));

	it("rejects with nothing stored when IndexedDB fails during a batch's checks", () =>
		withStorage("batch-check-failure", async (storage) => {
			const first = await storage.mintId<EntryId>();
			const second = await storage.mintId<EntryId>();
			const get = FakeIDBObjectStore.prototype.get;
			const failure = new DOMException("disk gone", "UnknownError");
			const spy = vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementation(function (
				this: InstanceType<typeof FakeIDBObjectStore>,
				key: Parameters<typeof get>[0],
			) {
				if (this.name === "record_ids" && key === second) throw failure;
				return get.call(this, key);
			});
			const receipts: number[] = [];
			try {
				await expect(
					storage.commit([[entryWrite(first)], [entryWrite(second)]], (index) => receipts.push(index), context),
				).rejects.toBe(failure);
			} finally {
				spy.mockRestore();
			}
			expect(receipts).toEqual([]);
			expect(await storage.entry(first, context)).toBeUndefined();
			await commitWrites(storage, [entryWrite(first)], context);
			expect(await storage.entry(first, context)).toBeDefined();
		}));

	it("rejects with nothing stored when IndexedDB fails during a batch's writes", () =>
		withStorage("batch-write-failure", async (storage) => {
			const first = await storage.mintId<EntryId>();
			const second = await storage.mintId<EntryId>();
			// A function cannot be stored: the put throws IndexedDB's `DataCloneError`.
			const unstorable = {
				type: "entry",
				value: { id: second, conversationId: ROOT_CONVERSATION_ID, kind: "batch", data: { f: () => {} } },
			} as unknown as StorageWrite;
			const receipts: number[] = [];
			await expect(
				storage.commit([[entryWrite(first)], [unstorable]], (index) => receipts.push(index), context),
			).rejects.toMatchObject({ name: "DataCloneError" });
			expect(receipts).toEqual([]);
			expect(await storage.entry(first, context)).toBeUndefined();
			expect(await storage.entry(second, context)).toBeUndefined();
		}));
});
