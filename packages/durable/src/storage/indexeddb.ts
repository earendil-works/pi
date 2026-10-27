/// <reference lib="dom" />

import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRequestError } from "../errors.ts";
import { idFromNumber, seqFromNumber } from "../ids.ts";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	ScanOrder,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../types.ts";
import { nextCursor, type ScanStart, scanStart } from "./scan.ts";

const DATABASE_VERSION = 1;
const MAX_KEY = Number.MAX_SAFE_INTEGER;
const META_KEY = "state";

const STORES = {
	meta: "meta",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;

const ALL_STORES = Object.values(STORES);

const INDEXES = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};
type MetaRow = { readonly key: typeof META_KEY; readonly nextId: number; readonly nextSeq: number };
type RecordIdRow = { readonly id: number; readonly recordType: TableName };
type ConversationRow = {
	readonly id: ConversationId;
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
	readonly record: ConversationRecord;
};
type EntryRow = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	readonly headConversationId?: ConversationId;
	readonly commitSeq: Seq;
	readonly record: EntryRecord;
};
type TaskRow = {
	readonly id: TaskId;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly status: StoredTask["state"]["status"];
	readonly abortRequested: 0 | 1;
	readonly background: 0 | 1;
	readonly record: StoredTask;
};
type SubmissionRow = {
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	readonly requestId?: string;
	readonly status: SubmissionRecord["status"];
	readonly record: SubmissionRecord;
};
type DocumentRow = {
	readonly id: DocumentId;
	readonly kind: string;
	readonly family: 0 | 1;
	readonly keyValue: string;
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
	readonly createdAt: Seq;
	readonly retiredAt?: Seq;
	readonly record: DocumentRecord;
};
type RevisionRow = {
	readonly documentId: DocumentId;
	readonly seq: Seq;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: JsonObject | readonly Op[];
};

type IndexedDbStorageOptions = {
	readonly indexedDB?: IDBFactory;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});

const transactionResult = (transaction: IDBTransaction): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new Error("IndexedDB transaction was aborted")),
			{ once: true },
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
			{ once: true },
		);
	});

const keyRanges = (): typeof IDBKeyRange => {
	if (typeof IDBKeyRange === "undefined") throw new Error("IndexedDB key ranges are not available");
	return IDBKeyRange;
};

const cursorValues = <T>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	limit: number,
	accept: (value: T) => boolean = () => true,
): Promise<T[]> =>
	new Promise<T[]>((resolve, reject) => {
		const values: T[] = [];
		const request = source.openCursor(range, direction);
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB cursor failed")), {
			once: true,
		});
		request.addEventListener("success", () => {
			const cursor = request.result;
			if (cursor === null) {
				resolve(values);
				return;
			}
			const value = cursor.value as T;
			if (accept(value)) values.push(value);
			if (values.length >= limit) {
				resolve(values);
				return;
			}
			cursor.continue();
		});
	});

const firstCursorValue = <T>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	accept: (value: T) => boolean = () => true,
): Promise<T | undefined> =>
	new Promise<T | undefined>((resolve, reject) => {
		const request = source.openCursor(range, direction);
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB cursor failed")), {
			once: true,
		});
		request.addEventListener("success", () => {
			const cursor = request.result;
			if (cursor === null) {
				resolve(undefined);
				return;
			}
			const value = cursor.value as T;
			if (accept(value)) {
				resolve(value);
				return;
			}
			cursor.continue();
		});
	});

const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) {
		throw new StorageRequestError("Invalid storage cursor");
	}
	return idFromNumber<I>(after);
};

const primaryRange = (start: ScanStart): IDBKeyRange | null => {
	if (start.after === undefined) return null;
	return start.order === "ascending"
		? keyRanges().lowerBound(start.after, true)
		: keyRanges().upperBound(start.after, true);
};

const compoundIdRange = (
	prefix: readonly IDBValidKey[],
	minimum: number,
	maximum: number,
	minimumOpen = false,
	maximumOpen = false,
): IDBKeyRange => keyRanges().bound([...prefix, minimum], [...prefix, maximum], minimumOpen, maximumOpen);

const scanCompoundRows = <T extends { readonly id: number }>(
	index: IDBIndex,
	prefix: readonly IDBValidKey[],
	start: ScanStart,
	limit: number,
	accept: (value: T) => boolean,
): Promise<T[]> => {
	const minimum = start.order === "ascending" && start.after !== undefined ? start.after : 0;
	const maximum = start.order === "descending" && start.after !== undefined ? start.after : MAX_KEY;
	return cursorValues<T>(
		index,
		compoundIdRange(
			prefix,
			minimum,
			maximum,
			start.order === "ascending" && start.after !== undefined,
			start.order === "descending" && start.after !== undefined,
		),
		start.order === "ascending" ? "next" : "prev",
		limit,
		accept,
	);
};

const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: address.kind,
		...scope,
		family: address.key === undefined ? (0 as const) : (1 as const),
		keyValue: address.key ?? "",
	};
};

const addressPrefix = (address: DocumentAddress | DocumentCreate | DocumentRecord): readonly IDBValidKey[] => {
	const parts = addressParts(address);
	return [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string =>
	JSON.stringify(addressPrefix(address));

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

function createSchema(database: IDBDatabase): void {
	const meta = database.createObjectStore(STORES.meta, { keyPath: "key" });
	meta.add({ key: META_KEY, nextId: 2, nextSeq: 1 } satisfies MetaRow);
	database.createObjectStore(STORES.recordIds, { keyPath: "id" });

	const conversations = database.createObjectStore(STORES.conversations, { keyPath: "id" });
	conversations.createIndex(INDEXES.conversationsByOwnerConversation, ["ownerConversationId", "id"]);
	conversations.createIndex(INDEXES.conversationsByOwnerTask, ["ownerTaskId", "id"]);

	const entries = database.createObjectStore(STORES.entries, { keyPath: "id" });
	entries.createIndex(INDEXES.entriesByConversation, ["conversationId", "id"]);
	entries.createIndex(INDEXES.entryHeadsByConversation, ["headConversationId", "id"]);

	const tasks = database.createObjectStore(STORES.tasks, { keyPath: "id" });
	tasks.createIndex(INDEXES.tasksByStatus, ["status", "id"]);
	tasks.createIndex(INDEXES.tasksByConversation, ["conversationId", "id"]);
	tasks.createIndex(INDEXES.tasksByKind, ["kind", "id"]);
	tasks.createIndex(INDEXES.tasksByAbortRequested, ["abortRequested", "id"]);
	tasks.createIndex(INDEXES.tasksByBackground, ["background", "id"]);

	const submissions = database.createObjectStore(STORES.submissions, { keyPath: "id" });
	submissions.createIndex(INDEXES.submissionsByRequest, ["conversationId", "requestId"]);
	submissions.createIndex(INDEXES.submissionsByConversation, ["conversationId", "id"]);
	submissions.createIndex(INDEXES.submissionsByStatus, ["status", "id"]);

	const documents = database.createObjectStore(STORES.documents, { keyPath: "id" });
	documents.createIndex(INDEXES.documentsByAddress, [
		"kind",
		"scopeKind",
		"ownerId",
		"family",
		"keyValue",
		"createdAt",
		"id",
	]);
	documents.createIndex(INDEXES.documentsByScope, ["scopeKind", "ownerId", "id"]);
	documents.createIndex(INDEXES.documentsByScopeKind, ["scopeKind", "ownerId", "kind", "id"]);

	const revisions = database.createObjectStore(STORES.documentRevisions, { keyPath: ["documentId", "seq"] });
	revisions.createIndex(INDEXES.documentRevisionsByKind, ["documentId", "kind", "seq"]);
}

/** Browser IndexedDB implementation of the durable storage contract. One owner must serialize access to each database. */
export class IndexedDbStorage implements Storage {
	private readonly database: IDBDatabase;
	private closed = false;
	private closing: Promise<void> | undefined;
	private activeOperations = 0;
	private operationsDrained: (() => void) | undefined;

	private constructor(database: IDBDatabase) {
		this.database = database;
	}

	/** Open or create a browser-only IndexedDB database. */
	static async open(name: string, options: IndexedDbStorageOptions = {}): Promise<IndexedDbStorage> {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (factory === undefined) throw new Error("IndexedDB is not available");
		const request = factory.open(name, DATABASE_VERSION);
		request.addEventListener("upgradeneeded", (event) => {
			if ((event as IDBVersionChangeEvent).oldVersion === 0) createSchema(request.result);
		});
		const database = await requestResult(request);
		try {
			const transaction = database.transaction(STORES.meta, "readonly");
			const done = transactionResult(transaction);
			const metadata = await requestResult(
				transaction.objectStore(STORES.meta).get(META_KEY) as IDBRequest<MetaRow>,
			);
			await done;
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			return new IndexedDbStorage(database);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	/** Delete a closed database. Open connections in this or another owner can block deletion. */
	static async delete(name: string, options: IndexedDbStorageOptions = {}): Promise<void> {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (factory === undefined) throw new Error("IndexedDB is not available");
		await requestResult(factory.deleteDatabase(name));
	}

	async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		const seq = await this.transaction(ALL_STORES, "readwrite", async (transaction) => {
			const metaStore = transaction.objectStore(STORES.meta);
			const metadata = await requestResult(metaStore.get(META_KEY) as IDBRequest<MetaRow>);
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			const seq = seqFromNumber(metadata.nextSeq);
			await this.checkGlobalIds(transaction, writes);
			await this.checkDocumentActions(transaction, documentActions);
			for (const write of writes) await this.applyTableWrite(transaction, write, seq);
			await this.applyDocumentActions(transaction, documentActions, seq);
			let nextId = metadata.nextId;
			for (const write of writes) {
				const id = writeId(write);
				if (id !== undefined) nextId = Math.max(nextId, id + 1);
			}
			await requestResult(metaStore.put({ key: META_KEY, nextId, nextSeq: seq + 1 } satisfies MetaRow));
			return seq;
		});
		// The transaction completed: the batch is durable.
		adopt(seq);
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		return this.transaction(STORES.meta, "readwrite", async (transaction) => {
			const store = transaction.objectStore(STORES.meta);
			const metadata = await requestResult(store.get(META_KEY) as IDBRequest<MetaRow>);
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			if (!Number.isSafeInteger(metadata.nextId)) throw new Error("ID space is exhausted");
			await requestResult(store.put({ ...metadata, nextId: metadata.nextId + 1 }));
			return idFromNumber<I>(metadata.nextId);
		});
	}

	conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		return this.transaction(
			STORES.conversations,
			"readonly",
			async (transaction) =>
				(
					await requestResult(
						transaction.objectStore(STORES.conversations).get(id) as IDBRequest<ConversationRow | undefined>,
					)
				)?.record,
		);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.conversations, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.conversations);
			const accept = (row: ConversationRow) =>
				query.ownerConversationId === undefined || row.ownerConversationId === query.ownerConversationId;
			let rows: ConversationRow[];
			if (query.ownerTaskId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.conversationsByOwnerTask),
					[query.ownerTaskId],
					start,
					limit + 1,
					accept,
				);
			} else if (query.ownerConversationId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.conversationsByOwnerConversation),
					[query.ownerConversationId],
					start,
					limit + 1,
					accept,
				);
			} else {
				rows = await cursorValues<ConversationRow>(
					store,
					primaryRange(start),
					start.order === "ascending" ? "next" : "prev",
					limit + 1,
					accept,
				);
			}
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			const id =
				context === undefined
					? idFromNumber<EntryId>(idOrConversationId)
					: typeof idOrContext === "number"
						? idFromNumber<EntryId>(idOrContext)
						: undefined;
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			let conversation: ConversationRecord | undefined;
			if (context !== undefined) {
				const conversationId = idFromNumber<ConversationId>(idOrConversationId);
				conversation = await this.readConversation(transaction, conversationId);
				if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			}
			const row = await requestResult(
				transaction.objectStore(STORES.entries).get(id) as IDBRequest<EntryRow | undefined>,
			);
			if (row === undefined) return undefined;
			if (conversation !== undefined) {
				let upperEntryId = MAX_KEY;
				while (conversation.id !== row.conversationId) {
					if (conversation.parent === undefined) return undefined;
					upperEntryId = Math.min(upperEntryId, conversation.parent.at);
					conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
				}
				if (row.id > upperEntryId) return undefined;
			}
			return { entry: row.record, commitSeq: row.commitSeq };
		});
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			let conversation = await this.readConversation(transaction, conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			let upper = atOrBeforeEntryId ?? MAX_KEY;
			const index = transaction.objectStore(STORES.entries).index(INDEXES.entryHeadsByConversation);
			while (true) {
				const row = await firstCursorValue<EntryRow>(index, compoundIdRange([conversation.id], 0, upper), "prev");
				if (row !== undefined) return row.record as EntryRecord & { readonly head: EntryId };
				if (conversation.parent === undefined) return undefined;
				upper = Math.min(upper, conversation.parent.at);
				conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
			}
		});
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "descending");
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			const values =
				start.order === "ascending"
					? await this.readEntriesAscending(transaction, query, limit, start.after)
					: await this.readEntriesDescending(transaction, query, limit, start.after);
			return page(values, limit, start.order);
		});
	}

	task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		return this.transaction(
			STORES.tasks,
			"readonly",
			async (transaction) =>
				(await requestResult(transaction.objectStore(STORES.tasks).get(id) as IDBRequest<TaskRow | undefined>))
					?.record,
		);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.tasks, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.tasks);
			const accept = (row: TaskRow) =>
				(query.conversationId === undefined || row.conversationId === query.conversationId) &&
				(query.kind === undefined || row.kind === query.kind) &&
				(query.status === undefined || row.status === query.status) &&
				(query.abortRequested === undefined || row.abortRequested === (query.abortRequested ? 1 : 0)) &&
				(query.background === undefined || row.background === (query.background ? 1 : 0));
			let source: IDBObjectStore | IDBIndex = store;
			let prefix: readonly IDBValidKey[] | undefined;
			if (query.status !== undefined) {
				source = store.index(INDEXES.tasksByStatus);
				prefix = [query.status];
			} else if (query.conversationId !== undefined) {
				source = store.index(INDEXES.tasksByConversation);
				prefix = [query.conversationId];
			} else if (query.kind !== undefined) {
				source = store.index(INDEXES.tasksByKind);
				prefix = [query.kind];
			} else if (query.abortRequested !== undefined) {
				source = store.index(INDEXES.tasksByAbortRequested);
				prefix = [query.abortRequested ? 1 : 0];
			} else if (query.background !== undefined) {
				source = store.index(INDEXES.tasksByBackground);
				prefix = [query.background ? 1 : 0];
			}
			const rows =
				prefix === undefined
					? await cursorValues<TaskRow>(
							source,
							primaryRange(start),
							start.order === "ascending" ? "next" : "prev",
							limit + 1,
							accept,
						)
					: await scanCompoundRows<TaskRow>(source as IDBIndex, prefix, start, limit + 1, accept);
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		return this.transaction(
			STORES.submissions,
			"readonly",
			async (transaction) =>
				(
					await requestResult(
						transaction.objectStore(STORES.submissions).get(id) as IDBRequest<SubmissionRow | undefined>,
					)
				)?.record,
		);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.submissions, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.submissions);
			const accept = (row: SubmissionRow) =>
				(query.conversationId === undefined || row.conversationId === query.conversationId) &&
				(query.status === undefined || row.status === query.status);
			let rows: SubmissionRow[];
			if (query.status !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.submissionsByStatus),
					[query.status],
					start,
					limit + 1,
					accept,
				);
			} else if (query.conversationId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.submissionsByConversation),
					[query.conversationId],
					start,
					limit + 1,
					accept,
				);
			} else {
				rows = await cursorValues<SubmissionRow>(
					store,
					primaryRange(start),
					start.order === "ascending" ? "next" : "prev",
					limit + 1,
					accept,
				);
			}
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.transaction(STORES.submissions, "readonly", async (transaction) => {
			const row = await requestResult(
				transaction
					.objectStore(STORES.submissions)
					.index(INDEXES.submissionsByRequest)
					.get([conversationId, requestId]) as IDBRequest<SubmissionRow | undefined>,
			);
			return row?.record;
		});
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		return this.transaction(STORES.documents, "readonly", async (transaction) => {
			const row = await firstCursorValue<DocumentRow>(
				transaction.objectStore(STORES.documents).index(INDEXES.documentsByAddress),
				keyRanges().bound([...addressPrefix(address), 0, 0], [...addressPrefix(address), MAX_KEY, MAX_KEY]),
				"prev",
				(value) => isAliveAt(value.record, at),
			);
			return row?.record;
		});
	}

	document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		return this.transaction([STORES.documents, STORES.documentRevisions], "readonly", (transaction) =>
			this.materializeDocument(transaction, id, at),
		);
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		const after = cursorId<DocumentId>(cursor);
		return this.transaction(STORES.documents, "readonly", async (transaction) => {
			const scope = scopeColumns(query.scope);
			const store = transaction.objectStore(STORES.documents);
			const index =
				query.kind === undefined
					? store.index(INDEXES.documentsByScope)
					: store.index(INDEXES.documentsByScopeKind);
			const prefix: readonly IDBValidKey[] =
				query.kind === undefined ? [scope.scopeKind, scope.ownerId] : [scope.scopeKind, scope.ownerId, query.kind];
			const rows = await cursorValues<DocumentRow>(
				index,
				compoundIdRange(prefix, after ?? 0, MAX_KEY, after !== undefined),
				"next",
				limit + 1,
				(row) => isAliveAt(row.record, query.at),
			);
			return page(
				rows.map((row) => row.record),
				limit,
			);
		});
	}

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	private async closeDatabase(): Promise<void> {
		if (this.activeOperations > 0) {
			await new Promise<void>((resolve) => {
				this.operationsDrained = resolve;
			});
		}
		this.database.close();
	}

	private async transaction<T>(
		stores: string | readonly string[],
		mode: IDBTransactionMode,
		operation: (transaction: IDBTransaction) => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		this.activeOperations++;
		try {
			const transaction = this.database.transaction(stores, mode);
			const done = transactionResult(transaction);
			try {
				const value = await operation(transaction);
				await done;
				return value;
			} catch (error) {
				try {
					transaction.abort();
				} catch {
					// It may already have aborted or committed.
				}
				try {
					await done;
				} catch {
					// Preserve the operation failure.
				}
				throw error;
			}
		} finally {
			if (--this.activeOperations === 0) this.operationsDrained?.();
		}
	}

	private async readConversation(
		transaction: IDBTransaction,
		id: ConversationId,
	): Promise<ConversationRecord | undefined> {
		return (
			await requestResult(
				transaction.objectStore(STORES.conversations).get(id) as IDBRequest<ConversationRow | undefined>,
			)
		)?.record;
	}

	private async readEntriesDescending(
		transaction: IDBTransaction,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<EntryRecord[]> {
		let conversation = await this.readConversation(transaction, query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper = query.maxEntryId ?? MAX_KEY;
		if (after !== undefined) upper = Math.min(upper, after - 1);
		const minimum = query.minEntryId ?? 0;
		const values: EntryRecord[] = [];
		const index = transaction.objectStore(STORES.entries).index(INDEXES.entriesByConversation);
		while (true) {
			if (upper >= minimum) {
				const rows = await cursorValues<EntryRow>(
					index,
					compoundIdRange([conversation.id], minimum, upper),
					"prev",
					limit + 1 - values.length,
				);
				values.push(...rows.map((row) => row.record));
			}
			if (values.length > limit || conversation.parent === undefined) break;
			upper = Math.min(upper, conversation.parent.at);
			if (upper < minimum) break;
			conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
		}
		return values;
	}

	private async readEntriesAscending(
		transaction: IDBTransaction,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<EntryRecord[]> {
		const segments: { readonly conversationId: ConversationId; readonly upper: number }[] = [];
		let conversation = await this.readConversation(transaction, query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper = query.maxEntryId ?? MAX_KEY;
		const requestedMinimum = query.minEntryId ?? 0;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = Math.min(upper, conversation.parent.at);
			if (upper < requestedMinimum) break;
			conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
		}
		const minimum = after === undefined ? requestedMinimum : Math.max(requestedMinimum, after + 1);
		const values: EntryRecord[] = [];
		const index = transaction.objectStore(STORES.entries).index(INDEXES.entriesByConversation);
		for (const segment of segments.reverse()) {
			if (segment.upper < minimum) continue;
			const rows = await cursorValues<EntryRow>(
				index,
				compoundIdRange([segment.conversationId], minimum, segment.upper),
				"next",
				limit + 1 - values.length,
			);
			values.push(...rows.map((row) => row.record));
			if (values.length > limit) break;
		}
		return values;
	}

	private async materializeDocument(
		transaction: IDBTransaction,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const record = (
			await requestResult(transaction.objectStore(STORES.documents).get(id) as IDBRequest<DocumentRow | undefined>)
		)?.record;
		if (record === undefined) return undefined;
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? MAX_KEY : at;
		const revisions = transaction.objectStore(STORES.documentRevisions);
		const base = await firstCursorValue<RevisionRow>(
			revisions.index(INDEXES.documentRevisionsByKind),
			keyRanges().bound([id, "base", 0], [id, "base", upper]),
			"prev",
		);
		if (base === undefined || base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		let value = base.content as JsonObject;
		const tail =
			base.seq >= upper
				? []
				: await cursorValues<RevisionRow>(
						revisions,
						keyRanges().bound([id, base.seq], [id, upper], true),
						"next",
						MAX_KEY,
					);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, revision.content as readonly Op[]) as JsonObject;
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	private async checkGlobalIds(transaction: IDBTransaction, writes: readonly StorageWrite[]): Promise<void> {
		const store = transaction.objectStore(STORES.recordIds);
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = (await requestResult(store.get(id) as IDBRequest<RecordIdRow | undefined>))?.recordType;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table)
					throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private async checkDocumentActions(
		transaction: IDBTransaction,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		const documents = transaction.objectStore(STORES.documents);
		const revisions = transaction.objectStore(STORES.documentRevisions);
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const existing = (await requestResult(documents.get(id) as IDBRequest<DocumentRow | undefined>))?.record;
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await firstCursorValue<RevisionRow>(revisions, compoundIdRange([id], 0, MAX_KEY), "prev");
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.currentDocumentId(transaction, record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	private async currentDocumentId(
		transaction: IDBTransaction,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const row = await firstCursorValue<DocumentRow>(
			transaction.objectStore(STORES.documents).index(INDEXES.documentsByAddress),
			keyRanges().bound([...addressPrefix(address), 0, 0], [...addressPrefix(address), MAX_KEY, MAX_KEY]),
			"prev",
			(value) => value.retiredAt === undefined,
		);
		return row?.id;
	}

	private async claimId(transaction: IDBTransaction, id: Id<string>, recordType: TableName): Promise<void> {
		await requestResult(transaction.objectStore(STORES.recordIds).put({ id, recordType } satisfies RecordIdRow));
	}

	private async applyTableWrite(transaction: IDBTransaction, write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			case "conversation":
				await this.claimId(transaction, write.value.id, "conversation");
				await requestResult(
					transaction.objectStore(STORES.conversations).add({
						id: write.value.id,
						...(write.value.owner === undefined
							? {}
							: {
									ownerConversationId: write.value.owner.conversationId,
									ownerTaskId: write.value.owner.taskId,
								}),
						record: write.value,
					} satisfies ConversationRow),
				);
				break;
			case "entry":
				await this.claimId(transaction, write.value.id, "entry");
				await requestResult(
					transaction.objectStore(STORES.entries).add({
						id: write.value.id,
						conversationId: write.value.conversationId,
						...(write.value.head === undefined ? {} : { headConversationId: write.value.conversationId }),
						commitSeq: seq,
						record: write.value,
					} satisfies EntryRow),
				);
				break;
			case "task":
				await this.claimId(transaction, write.value.id, "task");
				await requestResult(
					transaction.objectStore(STORES.tasks).put({
						id: write.value.id,
						conversationId: write.value.conversationId,
						kind: write.value.kind,
						status: write.value.state.status,
						abortRequested: write.value.abortRequested ? 1 : 0,
						background: write.value.background ? 1 : 0,
						record: write.value,
					} satisfies TaskRow),
				);
				break;
			case "submission":
				await this.claimId(transaction, write.value.id, "submission");
				await requestResult(
					transaction.objectStore(STORES.submissions).put({
						id: write.value.id,
						conversationId: write.value.conversationId,
						...(write.value.requestId === undefined ? {} : { requestId: write.value.requestId }),
						status: write.value.status,
						record: write.value,
					} satisfies SubmissionRow),
				);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	private async applyDocumentActions(
		transaction: IDBTransaction,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		const documents = transaction.objectStore(STORES.documents);
		const revisions = transaction.objectStore(STORES.documentRevisions);
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.materializeDocument(transaction, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				await this.claimId(transaction, id, "document");
				await requestResult(
					documents.add({
						id,
						...parts,
						createdAt: seq,
						...(action.retire ? { retiredAt: seq } : {}),
						record,
					} satisfies DocumentRow),
				);
			} else {
				record = (await requestResult(documents.get(id) as IDBRequest<DocumentRow>)).record;
			}

			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await requestResult(revisions.delete(compoundIdRange([id], 0, MAX_KEY)));
				}
				await requestResult(
					revisions.add({
						documentId: id,
						seq,
						kind: content.kind,
						version: content.version,
						content: content.kind === "base" ? content.value : content.ops,
					} satisfies RevisionRow),
				);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					const row = (await requestResult(documents.get(id) as IDBRequest<DocumentRow>))!;
					await requestResult(documents.put({ ...row, retiredAt: seq, record } satisfies DocumentRow));
				}
				if (isCurrentOnly(record)) {
					await requestResult(revisions.delete(compoundIdRange([id], 0, MAX_KEY)));
				}
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("IndexedDbStorage is closed");
	}
}

export type { IndexedDbStorageOptions };
