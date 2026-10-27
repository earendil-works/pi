/// <reference lib="dom" />

import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { IndexedDbStorage } from "../src/storage/indexeddb.ts";
import type {
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

/** Storage-level commits here have no in-memory owner to adopt them. */
const adopt = (): void => {};

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

	async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, commitContext: Context): Promise<Seq> {
		if (this.closed) return this.current.commit(writes, adopt, commitContext);
		try {
			return await this.current.commit(writes, adopt, commitContext);
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
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], adopt, context);
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
		await storage.commit(
			[{ type: "document.create", record: source, content: { kind: "base", version: 1, value: { count: 1 } } }],
			adopt,
			context,
		);
		const taskId = await storage.mintId<TaskId<JsonValue>>();
		const copyId = await storage.mintId<DocumentId>();
		await expect(
			storage.commit(
				[
					{ type: "task", value: pendingTask(taskId) },
					{
						type: "document.copy",
						record: { ...source, id: copyId, kind: "mismatch" },
						source: { id: sourceId, at: "current" },
					},
				],
				adopt,
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
		await storage.commit(
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
			adopt,
			context,
		);
		const childId = await storage.mintId<ConversationId>();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: childId, parent: { conversationId: ROOT_CONVERSATION_ID, at: rootMarker } },
				},
			],
			adopt,
			context,
		);
		const childEntry = await storage.mintId<EntryId>();
		await storage.commit(
			[{ type: "entry", value: { id: childEntry, conversationId: childId, kind: "child" } }],
			adopt,
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
		await storage.commit(writes, adopt, context);
		expect((await storage.entry(lastEntryId!, context))?.entry.data).toEqual({ index: 39 });
		expect(await storage.task(lastTaskId!, context)).toEqual(pendingTask(lastTaskId!));
		expect((await storage.submission(lastSubmissionId!, context))?.requestId).toBe("bulk-39");
		expect((await storage.document(lastDocumentId!, "current", context))?.value).toEqual({ index: 39 });
	} finally {
		await storage.close(context);
	}
});
