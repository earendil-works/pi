import type { Context, JsonValue } from "@earendil-works/chord";
import { applyImmutableBatches, type Op } from "@earendil-works/chord/delta";
import { StorageRejected } from "../errors.ts";
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
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TaskStatus = StoredTask["state"]["status"];
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentRevision = DocumentContent & { readonly seq: Seq };
type StoredDocumentState = {
	record: DocumentRecord;
	revisions: DocumentRevision[];
};
type DocumentAction = {
	create?: DocumentCreate;
	content?: DocumentContent;
	retire: boolean;
};

function* documentDeltaBatches(
	id: DocumentId,
	version: number,
	revisions: readonly DocumentRevision[],
	start: number,
): Generator<readonly Op[]> {
	for (let index = start; index < revisions.length; index++) {
		const revision = revisions[index]!;
		if (revision.kind !== "delta" || revision.version !== version) {
			throw new Error(`Document ${id} crosses a stored version boundary without a base`);
		}
		yield revision.ops;
	}
}

type DocumentAddressIndex = {
	ids: DocumentId[];
	currentId?: DocumentId;
};

type State = {
	recordTypes: Map<Id<string>, TableName>;
	conversations: Map<ConversationId, ConversationRecord>;
	conversationIds: ConversationId[];
	conversationIdsByOwnerConversation: Map<ConversationId, ConversationId[]>;
	conversationIdsByOwnerTask: Map<TaskId, ConversationId[]>;
	entries: Map<EntryId, EntryRecord>;
	entryIds: Map<ConversationId, EntryId[]>;
	headEntryIds: Map<ConversationId, EntryId[]>;
	entryCommitSeqs: Map<EntryId, Seq>;
	tasks: Map<TaskId, StoredTask>;
	taskIds: TaskId[];
	taskIdsByStatus: Record<TaskStatus, TaskId[]>;
	submissions: Map<SubmissionId, SubmissionRecord>;
	submissionIdsByRequest: Map<ConversationId, Map<string, SubmissionId>>;
	documents: Map<DocumentId, StoredDocumentState>;
	documentAddresses: Map<string, DocumentAddressIndex>;
	documentIdsByScope: Map<string, DocumentId[]>;
};

const clone = <T>(value: T): T => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	const source = value as Record<string, unknown>;
	const nullPrototype = Object.getPrototypeOf(value) === null;
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const copied = clone(source[key]);
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			result[key] = copied;
		}
	}
	return result as T;
};

const freeze = <T>(value: T): T => {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
};

const cursorId = <I extends Id<string>>(cursor: Readonly<Record<string, JsonValue>> | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

const lowerBound = <I extends Id<string>>(ids: readonly I[], target: number): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const upperBound = <I extends Id<string>>(ids: readonly I[], target: number): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] <= target) low = middle + 1;
		else high = middle;
	}
	return low;
};

const insertSorted = <I extends Id<string>>(ids: I[], id: I): void => {
	if (ids.length === 0 || ids[ids.length - 1] < id) ids.push(id);
	else ids.splice(lowerBound(ids, id), 0, id);
};

const removeSorted = <I extends Id<string>>(ids: I[], id: I): void => {
	const index = lowerBound(ids, id);
	if (ids[index] === id) ids.splice(index, 1);
};

const insertMapId = <K, I extends Id<string>>(index: Map<K, I[]>, key: K, id: I): void => {
	let ids = index.get(key);
	if (ids === undefined) {
		ids = [];
		index.set(key, ids);
	}
	insertSorted(ids, id);
};

const scopeKey = (scope: DocumentRecord["scope"]): string => {
	switch (scope.kind) {
		case "session":
			return JSON.stringify(["session"]);
		case "conversation":
			return JSON.stringify(["conversation", scope.conversationId]);
		case "task":
			return JSON.stringify(["task", scope.taskId]);
	}
};

const addressKey = (address: DocumentAddress): string =>
	JSON.stringify([
		address.kind,
		scopeKey(address.scope),
		address.key === undefined ? ["singleton"] : ["family", address.key],
	]);

const recordAddressKey = (record: DocumentRecord | DocumentCreate): string =>
	addressKey({ kind: record.kind, scope: record.scope, key: record.key });

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const tableContaining = (state: State, id: Id<string>): TableName | undefined => state.recordTypes.get(id);

const page = <T extends { readonly id: Id<string> }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items: clone(items) };
	return { items: clone(items), next: { after: items.at(-1)!.id } };
};

/** A fully validated, detached state mutation whose application performs no fallible preparation. */
export interface PreparedMemoryCommit {
	readonly seq: Seq;
	/** Deeply frozen detached writes for persistence. */
	readonly writes: readonly StorageWrite[];
	apply(): Seq;
}

/**
 * Detached in-memory reference implementation of `Storage`.
 *
 * Reads and retained writes are cloned intentionally to match the ownership boundary
 * of serialization-backed stores. This is backend conformance, not validation.
 */
export class MemoryStorage implements Storage {
	private readonly state: State = {
		recordTypes: new Map(),
		conversations: new Map(),
		conversationIds: [],
		conversationIdsByOwnerConversation: new Map(),
		conversationIdsByOwnerTask: new Map(),
		entries: new Map(),
		entryIds: new Map(),
		headEntryIds: new Map(),
		entryCommitSeqs: new Map(),
		tasks: new Map(),
		taskIds: [],
		taskIdsByStatus: { pending: [], running: [], terminal: [] },
		submissions: new Map(),
		submissionIdsByRequest: new Map(),
		documents: new Map(),
		documentAddresses: new Map(),
		documentIdsByScope: new Map(),
	};
	private nextId = 2;
	private nextSeq = 1;
	private closed = false;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		return this.prepareCommit(writes).apply();
	}

	/** Validate and detach one commit without changing observable state. */
	prepareCommit(writes: readonly StorageWrite[], seq: Seq = seqFromNumber(this.nextSeq)): PreparedMemoryCommit {
		this.assertOpen();
		if (!Number.isSafeInteger(seq) || seq < this.nextSeq) {
			throw new Error(`Commit sequence ${seq} does not strictly increase`);
		}
		const detachedWrites = freeze(this.resolveDocumentCopies(writes.map((write) => clone(write))));
		this.checkGlobalIds(detachedWrites);
		const documentActions = this.prepareDocumentActions(detachedWrites);
		this.checkDocumentActions(documentActions);
		let applied = false;
		return {
			seq,
			writes: detachedWrites,
			apply: () => {
				if (!applied) {
					applied = true;
					this.applyPreparedCommit(detachedWrites, documentActions, seq);
				}
				return seq;
			},
		};
	}

	private resolveDocumentCopies(writes: StorageWrite[]): StorageWrite[] {
		if (!writes.some((write) => write.type === "document.copy")) return writes;
		const changedDocumentIds = new Set<DocumentId>();
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") {
				changedDocumentIds.add(write.record.id);
			} else if (write.type === "document.change" || write.type === "document.retire") {
				changedDocumentIds.add(write.id);
			}
		}
		return writes.map((write) => {
			if (write.type !== "document.copy") return write;
			try {
				if (changedDocumentIds.has(write.source.id)) {
					throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
				}
				const stored = this.materializeDocument(write.source.id, write.source.at);
				if (stored === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
				if (
					stored.record.scope.kind !== "conversation" ||
					write.record.scope.kind !== "conversation" ||
					stored.record.kind !== write.record.kind ||
					stored.record.key !== write.record.key ||
					stored.record.history !== write.record.history ||
					stored.record.fork !== write.record.fork
				) {
					throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
				}
				return {
					type: "document.create",
					record: write.record,
					content: { kind: "base", version: stored.version, value: stored.value },
				};
			} catch (error) {
				if (error instanceof StorageRejected) throw error;
				throw new StorageRejected(`Document copy ${write.record.id} was rejected`, { cause: error });
			}
		});
	}

	private applyPreparedCommit(
		prepared: readonly StorageWrite[],
		documentActions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Seq {
		for (const write of prepared) {
			switch (write.type) {
				case "conversation": {
					this.state.recordTypes.set(write.value.id, "conversation");
					this.state.conversations.set(write.value.id, write.value);
					insertSorted(this.state.conversationIds, write.value.id);
					const owner = write.value.owner;
					if (owner !== undefined) {
						insertMapId(this.state.conversationIdsByOwnerConversation, owner.conversationId, write.value.id);
						insertMapId(this.state.conversationIdsByOwnerTask, owner.taskId, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "entry": {
					this.state.recordTypes.set(write.value.id, "entry");
					this.state.entries.set(write.value.id, write.value);
					this.state.entryCommitSeqs.set(write.value.id, seq);
					let ids = this.state.entryIds.get(write.value.conversationId);
					if (ids === undefined) {
						ids = [];
						this.state.entryIds.set(write.value.conversationId, ids);
					}
					insertSorted(ids, write.value.id);
					if (write.value.head !== undefined) {
						let headIds = this.state.headEntryIds.get(write.value.conversationId);
						if (headIds === undefined) {
							headIds = [];
							this.state.headEntryIds.set(write.value.conversationId, headIds);
						}
						insertSorted(headIds, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "task": {
					this.state.recordTypes.set(write.value.id, "task");
					const previous = this.state.tasks.get(write.value.id);
					if (previous === undefined) {
						insertSorted(this.state.taskIds, write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					} else if (previous.state.status !== write.value.state.status) {
						removeSorted(this.state.taskIdsByStatus[previous.state.status], write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					}
					this.state.tasks.set(write.value.id, write.value);
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "submission": {
					this.state.recordTypes.set(write.value.id, "submission");
					const previous = this.state.submissions.get(write.value.id);
					if (previous?.requestId !== undefined) {
						const previousRequests = this.state.submissionIdsByRequest.get(previous.conversationId);
						if (previousRequests?.get(previous.requestId) === write.value.id) {
							previousRequests.delete(previous.requestId);
							if (previousRequests.size === 0) this.state.submissionIdsByRequest.delete(previous.conversationId);
						}
					}
					this.state.submissions.set(write.value.id, write.value);
					if (write.value.requestId !== undefined) {
						let requests = this.state.submissionIdsByRequest.get(write.value.conversationId);
						if (requests === undefined) {
							requests = new Map();
							this.state.submissionIdsByRequest.set(write.value.conversationId, requests);
						}
						requests.set(write.value.requestId, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				case "document.copy":
					throw new Error("Prepared document copy was not resolved");
				case "document.create":
				case "document.change":
				case "document.retire":
					break;
			}
		}

		this.applyDocumentActions(documentActions, seq);
		this.nextSeq = seq + 1;
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<I>(this.nextId++);
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const ids =
			query.ownerTaskId !== undefined
				? (this.state.conversationIdsByOwnerTask.get(query.ownerTaskId) ?? [])
				: query.ownerConversationId !== undefined
					? (this.state.conversationIdsByOwnerConversation.get(query.ownerConversationId) ?? [])
					: this.state.conversationIds;
		const after = cursorId(cursor);
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: ConversationRecord[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const value = this.state.conversations.get(ids[index]!)!;
			if (query.ownerConversationId !== undefined && value.owner?.conversationId !== query.ownerConversationId) {
				continue;
			}
			values.push(value);
		}
		return page(values, limit);
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		if (context === undefined) {
			const id = idFromNumber<EntryId>(idOrConversationId);
			const entry = this.state.entries.get(id);
			if (entry === undefined) return undefined;
			return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
		}
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		const conversationId = idFromNumber<ConversationId>(idOrConversationId);
		const id = idFromNumber<EntryId>(idOrContext);
		const entry = this.visibleEntries(conversationId, id, id).next().value;
		if (entry === undefined) return undefined;
		return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.assertOpen();
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
		while (true) {
			const ids = this.state.headEntryIds.get(currentId) ?? [];
			const index = upperBound(ids, upperEntryId) - 1;
			if (index >= 0) {
				const entry = this.state.entries.get(ids[index])!;
				return clone({ ...entry, head: entry.head! });
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) return undefined;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			currentId = conversation.parent.conversationId;
		}
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const maxEntryId =
			after === undefined ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
		const visible: EntryRecord[] = [];
		for (const entry of this.visibleEntries(query.conversationId, query.minEntryId, maxEntryId)) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		return page(visible, limit);
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const ids = query.status === undefined ? this.state.taskIds : this.state.taskIdsByStatus[query.status];
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: StoredTask[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const value = this.state.tasks.get(ids[index])!;
			if (query.conversationId !== undefined && value.conversationId !== query.conversationId) continue;
			if (query.kind !== undefined && value.kind !== query.kind) continue;
			if (query.abortRequested !== undefined && value.abortRequested !== query.abortRequested) continue;
			if (query.background !== undefined && value.background !== query.background) continue;
			values.push(value);
		}
		return page(values, limit);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const value = this.state.submissions.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const id = this.state.submissionIdsByRequest.get(conversationId)?.get(requestId);
		if (id === undefined) return undefined;
		return clone(this.state.submissions.get(id)!);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const index = this.state.documentAddresses.get(addressKey(address));
		if (at === "current") {
			return index?.currentId === undefined ? undefined : clone(this.state.documents.get(index.currentId)!.record);
		}
		for (const id of index?.ids ?? []) {
			const record = this.state.documents.get(id)!.record;
			if (isAliveAt(record, at)) return clone(record);
		}
		return undefined;
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		const stored = this.materializeDocument(id, at);
		return stored === undefined
			? undefined
			: { record: clone(stored.record), version: stored.version, value: clone(stored.value) };
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const ids = this.state.documentIdsByScope.get(scopeKey(query.scope)) ?? [];
		const after = cursorId(cursor);
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: DocumentRecord[] = [];
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const record = this.state.documents.get(ids[index]!)!.record;
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (isAliveAt(record, query.at)) values.push(record);
		}
		return page(values, limit);
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private materializeDocument(id: DocumentId, at: DocumentPoint): StoredDocument | undefined {
		const stored = this.state.documents.get(id);
		if (stored === undefined) return undefined;
		if (at !== "current" && isCurrentOnly(stored.record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(stored.record, at)) return undefined;
		const revisions = at === "current" ? stored.revisions : stored.revisions.filter((revision) => revision.seq <= at);
		let baseIndex = revisions.length - 1;
		while (baseIndex >= 0 && revisions[baseIndex]!.kind !== "base") baseIndex--;
		const base = revisions[baseIndex];
		if (base?.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		const value = applyImmutableBatches(
			base.value,
			documentDeltaBatches(id, base.version, revisions, baseIndex + 1),
		) as JsonObject;
		return { record: stored.record, version: base.version, value };
	}

	private *visibleEntries(
		conversationId: ConversationId,
		minEntryId: number = Number.NEGATIVE_INFINITY,
		maxEntryId: number = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		if (!this.state.conversations.has(conversationId)) {
			throw new Error(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		let upperEntryId = maxEntryId;
		while (true) {
			const ids = this.state.entryIds.get(currentId) ?? [];
			for (let index = upperBound(ids, upperEntryId) - 1; index >= 0; index--) {
				const id = ids[index];
				if (id < minEntryId) break;
				yield this.state.entries.get(id)!;
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
	}

	private checkGlobalIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
				continue;
			}
			const id = write.type === "document.create" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.change":
					if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
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

	private checkDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			const existing = this.state.documents.get(id);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			const previous = existing?.revisions.at(-1);
			if (action.content?.kind === "delta") {
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}

			const key = action.create === undefined ? recordAddressKey(existing!.record) : recordAddressKey(action.create);
			const currentId = this.state.documentAddresses.get(key)?.currentId;
			let live = liveCounts.get(key);
			if (live === undefined) live = currentId === undefined ? 0 : 1;
			if (action.retire && currentId === id) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}

		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error(`Document address already has a current incarnation`);
		}
	}

	private applyDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq): void {
		for (const [id, action] of actions) {
			let stored = this.state.documents.get(id);
			if (action.create !== undefined) {
				const record: DocumentRecord = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				stored = { record, revisions: [{ ...action.content!, seq }] };
				this.state.recordTypes.set(id, "document");
				this.state.documents.set(id, stored);

				const key = recordAddressKey(record);
				let address = this.state.documentAddresses.get(key);
				if (address === undefined) {
					address = { ids: [] };
					this.state.documentAddresses.set(key, address);
				}
				insertSorted(address.ids, id);

				let scopeIds = this.state.documentIdsByScope.get(scopeKey(record.scope));
				if (scopeIds === undefined) {
					scopeIds = [];
					this.state.documentIdsByScope.set(scopeKey(record.scope), scopeIds);
				}
				insertSorted(scopeIds, id);
				this.nextId = Math.max(this.nextId, id + 1);
			} else if (action.content !== undefined) {
				const revision = { ...action.content, seq } as DocumentRevision;
				if (revision.kind === "base" && isCurrentOnly(stored!.record)) stored!.revisions = [revision];
				else stored!.revisions.push(revision);
			}

			if (action.retire && action.create === undefined) stored!.record = { ...stored!.record, retiredAt: seq };
			if (action.retire && isCurrentOnly(stored!.record)) stored!.revisions = [];
			if (action.create !== undefined || action.retire) {
				const address = this.state.documentAddresses.get(recordAddressKey(stored!.record))!;
				if (action.retire && address.currentId === id) delete address.currentId;
				if (action.create !== undefined && !action.retire) address.currentId = id;
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
