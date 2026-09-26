import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRejected } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
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
} from "../../types.ts";
import type { SqliteDatabase, SqliteStatement, SqliteValue } from "./database.ts";
import { applySqliteMigrations } from "./migrations.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type RecordIdRow = { readonly record_type: TableName };
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
type IdRow = { readonly id: number };
type MetadataRow = { readonly next_id: string; readonly next_seq: number };
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

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// Some SQLite bindings replace lone UTF-16 surrogates. JSON encoding keeps indexed identities lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const getRow = <T extends object>(statement: SqliteStatement, ...params: SqliteValue[]): T | undefined =>
	statement.get<T>(...params);

const allRows = <T extends object>(statement: SqliteStatement, ...params: SqliteValue[]): T[] =>
	statement.all<T>(...params);

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

const page = <T extends { readonly id: Id<string> }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items.at(-1)!.id } };
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
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

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

class StatementCachingDatabase implements SqliteDatabase {
	private readonly database: SqliteDatabase;
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	transaction<T>(callback: () => T): T | Promise<T> {
		return this.database.transaction(callback);
	}

	close(): void | Promise<void> {
		this.statements.clear();
		return this.database.close();
	}
}

/** Portable SQLite implementation of the Pico storage contract. */
export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private nextId: number;
	private closed = false;

	private constructor(db: SqliteDatabase, nextId: number) {
		this.db = new StatementCachingDatabase(db);
		this.nextId = nextId;
	}

	/** Initialize storage over an owned SQLite database facade. */
	static async open(db: SqliteDatabase): Promise<SqliteStorage> {
		try {
			await applySqliteMigrations(db);
			const metadata = getRow<MetadataRow>(
				db.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1"),
			);
			if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
			return new SqliteStorage(db, Number(metadata.next_id));
		} catch (error) {
			try {
				await db.close();
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		const seq = await this.db.transaction(() => {
			const metadata = getRow<MetadataRow>(
				this.db.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1"),
			);
			if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
			const committedSeq = seqFromNumber(metadata.next_seq);
			this.checkGlobalIds(writes);
			this.checkDocumentActions(documentActions);
			for (const write of writes) this.applyTableWrite(write, committedSeq);
			this.applyDocumentActions(documentActions, committedSeq);
			this.db
				.prepare("UPDATE durable_metadata SET next_id = ?, next_seq = ? WHERE singleton = 1")
				.run(String(Math.max(Number(metadata.next_id), candidateNextId)), committedSeq + 1);
			return committedSeq;
		});
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<I>(this.nextId++);
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM conversations WHERE id = ?"), id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const clauses = ["id > ?"];
		const params: SqliteValue[] = [cursorId(cursor) ?? -1];
		if (query.ownerConversationId !== undefined) {
			clauses.push("owner_conversation_id = ?");
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push("owner_task_id = ?");
			params.push(query.ownerTaskId);
		}
		params.push(limit + 1);
		const rows = allRows<JsonRow>(
			this.db.prepare(`SELECT record FROM conversations WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`),
			...params,
		);
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.record)),
			limit,
		);
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
		const id =
			context === undefined
				? idFromNumber<EntryId>(idOrConversationId)
				: typeof idOrContext === "number"
					? idFromNumber<EntryId>(idOrContext)
					: undefined;
		if (id === undefined) throw new TypeError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idFromNumber<ConversationId>(idOrConversationId);
			conversation = this.readConversation(conversationId);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
		}
		const row = getRow<EntryJsonRow>(this.db.prepare("SELECT record, commit_seq FROM entries WHERE id = ?"), id);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = this.readConversation(conversation.parent.conversationId)!;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: seqFromNumber(row.commit_seq) };
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.assertOpen();
		let conversation = this.readConversation(conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const row =
				upper === undefined
					? getRow<JsonRow>(
							this.db.prepare(
								"SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1",
							),
							conversation.id,
						)
					: getRow<JsonRow>(
							this.db.prepare(
								"SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1",
							),
							conversation.id,
							upper,
						);
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = this.readConversation(conversation.parent.conversationId)!;
		}
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		let conversation = this.readConversation(query.conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
		const after = cursorId(cursor);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const clauses = ["conversation_id = ?"];
			const params: SqliteValue[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push("id >= ?");
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push("id <= ?");
				params.push(upper);
			}
			params.push(limit + 1 - values.length);
			const rows = allRows<JsonRow>(
				this.db.prepare(`SELECT record FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`),
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = this.readConversation(conversation.parent.conversationId)!;
		}
		return page(values, limit);
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM tasks WHERE id = ?"), id);
		return row === undefined ? undefined : parseJson<StoredTask>(row.record);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const clauses = ["id > ?"];
		const params: SqliteValue[] = [cursorId(cursor) ?? -1];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		if (query.abortRequested !== undefined) {
			clauses.push("abort_requested = ?");
			params.push(query.abortRequested ? 1 : 0);
		}
		if (query.background !== undefined) {
			clauses.push("background = ?");
			params.push(query.background ? 1 : 0);
		}
		params.push(limit + 1);
		const rows = allRows<JsonRow>(
			this.db.prepare(`SELECT record FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`),
			...params,
		);
		return page(
			rows.map((row) => parseJson<StoredTask>(row.record)),
			limit,
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM submissions WHERE id = ?"), id);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = getRow<JsonRow>(
			this.db.prepare("SELECT record FROM submissions WHERE conversation_id = ? AND request_id = ?"),
			conversationId,
			encodeIndexedString(requestId),
		);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const parts = addressParts(address);
		const statement =
			at === "current"
				? this.db.prepare(`SELECT record FROM documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`)
				: this.db.prepare(`SELECT record FROM documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`);
		const params: SqliteValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		if (at !== "current") params.push(at, at);
		const row = getRow<JsonRow>(statement, ...params);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		return this.materializeDocument(id, at);
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const scope = scopeColumns(query.scope);
		const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"];
		const params: SqliteValue[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		if (query.at === "current") {
			clauses.push("retired_at IS NULL");
		} else {
			clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)");
			params.push(query.at, query.at);
		}
		params.push(limit + 1);
		const rows = allRows<JsonRow>(
			this.db.prepare(`SELECT record FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`),
			...params,
		);
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.record)),
			limit,
		);
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.db.close();
	}

	private readConversation(id: ConversationId): ConversationRecord | undefined {
		const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM conversations WHERE id = ?"), id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	private materializeDocument(id: DocumentId, at: DocumentPoint): StoredDocument | undefined {
		const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM documents WHERE id = ?"), id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = getRow<RevisionRow>(
			this.db.prepare(`SELECT seq, kind, version, content FROM document_revisions
				WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`),
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		const tail = allRows<RevisionRow>(
			this.db.prepare(`SELECT seq, kind, version, content FROM document_revisions
				WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`),
			id,
			base.seq,
			upper,
		);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: base.version, value };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	private checkGlobalIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id<string>, TableName>();
		const lookup = this.db.prepare("SELECT record_type FROM record_ids WHERE id = ?");
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = getRow<RecordIdRow>(lookup, id)?.record_type;
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

	private checkDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM documents WHERE id = ?"), id);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = getRow<{ readonly version: number }>(
					this.db.prepare(
						"SELECT version FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1",
					),
					id,
				);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = this.currentDocumentId(record) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	private currentDocumentId(address: DocumentAddress | DocumentCreate | DocumentRecord): DocumentId | undefined {
		const parts = addressParts(address);
		const id = getRow<IdRow>(
			this.db.prepare(`SELECT id FROM documents
				WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`),
			parts.kind,
			parts.scopeKind,
			parts.ownerId,
			parts.family,
			parts.keyValue,
		)?.id;
		return id === undefined ? undefined : idFromNumber<DocumentId>(id);
	}

	private applyTableWrite(write: StorageWrite, seq: Seq): void {
		switch (write.type) {
			case "conversation":
				this.claimId(write.value.id, "conversation");
				this.db
					.prepare(
						"INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)",
					)
					.run(
						write.value.id,
						write.value.owner?.conversationId ?? null,
						write.value.owner?.taskId ?? null,
						encodeJson(write.value),
					);
				break;
			case "entry":
				this.claimId(write.value.id, "entry");
				this.db
					.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)")
					.run(write.value.id, write.value.conversationId, write.value.head ?? null, seq, encodeJson(write.value));
				break;
			case "task":
				this.claimId(write.value.id, "task");
				this.db
					.prepare(`INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`)
					.run(
						write.value.id,
						write.value.conversationId,
						encodeIndexedString(write.value.kind),
						write.value.state.status,
						write.value.abortRequested ? 1 : 0,
						write.value.background ? 1 : 0,
						encodeJson(write.value),
					);
				break;
			case "submission":
				this.claimId(write.value.id, "submission");
				this.db
					.prepare(`INSERT INTO submissions (id, conversation_id, request_id, record) VALUES (?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, record = excluded.record`)
					.run(
						write.value.id,
						write.value.conversationId,
						write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
						encodeJson(write.value),
					);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	private claimId(id: Id<string>, table: TableName): void {
		this.db.prepare("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, ?)").run(id, table);
	}

	private applyDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq): void {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = this.materializeDocument(action.copy.id, action.copy.at);
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
					if (error instanceof StorageRejected) throw error;
					throw new StorageRejected(`Document copy ${id} was rejected`, { cause: error });
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
				this.claimId(id, "document");
				this.db
					.prepare(`INSERT INTO documents
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						id,
						parts.kind,
						parts.family,
						parts.keyValue,
						parts.scopeKind,
						parts.ownerId,
						seq,
						action.retire ? seq : null,
						encodeJson(record),
					);
			} else {
				const row = getRow<JsonRow>(this.db.prepare("SELECT record FROM documents WHERE id = ?"), id)!;
				record = parseJson<DocumentRecord>(row.record);
			}

			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					this.db.prepare("DELETE FROM document_revisions WHERE document_id = ?").run(id);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				this.db
					.prepare(
						"INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)",
					)
					.run(id, seq, content.kind, content.version, encodedContent);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					this.db
						.prepare("UPDATE documents SET retired_at = ?, record = ? WHERE id = ?")
						.run(seq, encodeJson(record), id);
				}
				if (isCurrentOnly(record)) this.db.prepare("DELETE FROM document_revisions WHERE document_id = ?").run(id);
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteStorage is closed");
	}
}
