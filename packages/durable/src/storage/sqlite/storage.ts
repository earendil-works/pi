import type { Context } from "@earendil-works/chord/context";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
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
} from "../../types.ts";
import { nextCursor, type ScanStart, scanStart } from "../scan.ts";
import { CommitState, claimOf, type DocumentAction, PendingWrites, prepareDocumentActions } from "./commit.ts";
import { applySqliteMigrationsForSchema } from "./migrations.ts";
import { addressParts, encodeIndexedString, isCurrentOnly, parseJson, scopeColumns } from "./rows.ts";
import { createSqliteSchema, type SqliteSchema } from "./schema.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
type MetadataRow = { readonly next_id: string; readonly next_seq: number };

export type SqliteStorageOptions = {
	/**
	 * Prefix for every table and index in the durable schema. It must be a SQLite identifier and must not use
	 * SQLite's reserved `sqlite_` prefix. Existing data is not migrated when this changes.
	 */
	readonly prefix?: string;
};

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: ScanStart): { readonly clause: string; readonly param: number; readonly direction: string } =>
	start.order === "ascending"
		? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

/** Whether a database call of the checks failed, whatever it threw or rejected with. */
type CheckCalls = { failed: boolean };

/**
 * `executor`, setting `calls.failed` when one of its calls throws, synchronously (a synchronous driver) or by
 * rejecting, with any value: then a failing check is the database's, not one of Durable's own.
 */
function watchCalls(executor: SqliteExecutor, calls: CheckCalls): SqliteExecutor {
	const watched = async <T>(call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			calls.failed = true;
			throw error;
		}
	};
	return {
		exec: (sql) => watched(() => executor.exec(sql)),
		run: (sql, ...params) => watched(() => executor.run(sql, ...params)),
		runCounted: (sql, ...params) => watched(() => executor.runCounted(sql, ...params)),
		get: (sql, ...params) => watched(() => executor.get(sql, ...params)),
		all: (sql, ...params) => watched(() => executor.all(sql, ...params)),
	};
}

/** Portable SQLite implementation of the Pico storage contract. */
export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private readonly schema: SqliteSchema;
	private nextId: number;
	private closed = false;
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

	private constructor(db: SqliteDatabase, schema: SqliteSchema, nextId: number) {
		this.db = db;
		this.schema = schema;
		this.nextId = nextId;
	}

	/** Initialize storage over an owned SQLite database facade. */
	static async open(db: SqliteDatabase, options: SqliteStorageOptions = {}): Promise<SqliteStorage> {
		try {
			const schema = createSqliteSchema(options.prefix);
			await applySqliteMigrationsForSchema(db, schema);
			const metadata = await db.get<MetadataRow>(
				`SELECT next_id, next_seq FROM ${schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
			return new SqliteStorage(db, schema, Number(metadata.next_id));
		} catch (error) {
			try {
				await db.close();
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	/**
	 * Commit `batches` in one SQL transaction, each with its own seq. Each batch is checked before it writes anything,
	 * against the state the earlier ones left, and the first one refused ends the batch: the transaction commits the ones
	 * before it. No savepoints, which Durable Objects do not allow: the checks run before the writes instead. The checks
	 * read the stored state of all batches up front and run in memory, and the accepted batches are written per table in
	 * multi-row statements (`commit.ts`), so a call costs a few statements whatever its number of batches. A batch with a
	 * copy reads the copy's source from the database: the batches before it are written first, so a call of many fork
	 * batches costs a few statements per fork.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		_context: Context,
	): Promise<CommitResult> {
		this.assertOpen();
		const seqs: Seq[] = [];
		let refused: { readonly error: unknown } | undefined;
		let candidateNextId = this.nextId;
		await this.db.transaction(async (transaction) => {
			const metadata = await this.readMetadata(transaction);
			let next = metadata.next_seq;
			// A failure of the database rejects the call and rolls back the batches before it with the transaction.
			const state = await CommitState.read(transaction, this.schema.tables, batches);
			const pending = new PendingWrites();
			for (const writes of batches) {
				const checked = await this.checkBatch(transaction, state, pending, writes);
				if ("refused" in checked) {
					refused = { error: checked.refused };
					break;
				}
				const seq = seqFromNumber(next++);
				state.apply(writes, checked.actions, seq);
				pending.add(writes, checked.actions, seq, state);
				seqs.push(seq);
				candidateNextId = Math.max(candidateNextId, this.candidateNextId(writes));
			}
			await pending.flush(transaction, this.schema.tables);
			if (seqs.length > 0) {
				await this.writeMetadata(transaction, Math.max(Number(metadata.next_id), candidateNextId), next);
			}
		});
		this.nextId = Math.max(this.nextId, candidateNextId);
		// `COMMIT` returned: the stored batches are durable.
		for (const [index, seq] of seqs.entries()) receive(index, seq);
		return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
	}

	private async readMetadata(executor: SqliteExecutor): Promise<MetadataRow> {
		const metadata = await executor.get<MetadataRow>(
			`SELECT next_id, next_seq FROM ${this.schema.tables.durableMetadata} WHERE singleton = 1`,
		);
		if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
		return metadata;
	}

	private async writeMetadata(executor: SqliteExecutor, nextId: number, nextSeq: number): Promise<void> {
		await executor.run(
			`UPDATE ${this.schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
			String(nextId),
			nextSeq,
		);
	}

	/**
	 * Durable's own checks of one batch, against what the batches before it left: its document actions, or its refusal.
	 * Only these checks refuse; a failure of a database call rejects. A copy reads its source from the database, so the
	 * batches before it are written first.
	 */
	private async checkBatch(
		transaction: SqliteExecutor,
		state: CommitState,
		pending: PendingWrites,
		writes: readonly StorageWrite[],
	): Promise<{ readonly actions: Map<DocumentId, DocumentAction> } | { readonly refused: unknown }> {
		let actions: Map<DocumentId, DocumentAction>;
		try {
			actions = prepareDocumentActions(writes);
			state.check(writes, actions);
		} catch (error) {
			return { refused: error };
		}
		if (![...actions.values()].some((action) => action.copy !== undefined)) return { actions };
		await pending.flush(transaction, this.schema.tables);
		const calls: CheckCalls = { failed: false };
		try {
			await this.resolveCopies(watchCalls(transaction, calls), actions);
		} catch (error) {
			if (calls.failed) throw error;
			return { refused: error };
		}
		return { actions };
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<I>(this.nextId++);
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
		if (query.ownerConversationId !== undefined) {
			clauses.push("owner_conversation_id = ?");
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push("owner_task_id = ?");
			params.push(query.ownerTaskId);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.record)),
			limit,
			start.order,
		);
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
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
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
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		const row = await this.db.get<EntryJsonRow>(
			`SELECT record, commit_seq FROM ${this.schema.tables.entries} WHERE id = ?`,
			id,
		);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = (await this.readConversation(conversation.parent.conversationId))!;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: seqFromNumber(row.commit_seq) };
	}

	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const row =
				upper === undefined
					? await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
							conversation.id,
						)
					: await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`,
							conversation.id,
							upper,
						);
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
	}

	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
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
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	private async readEntriesAscending(
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ["conversation_id = ?"];
			const params: SqliteValue[] = [segment.conversationId];
			if (lower !== undefined) {
				clauses.push("id >= ?");
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push("id <= ?");
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit) break;
		}
		return page(values, limit, "ascending");
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.tasks} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<StoredTask>(row.record);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
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
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<StoredTask>(row.record)),
			limit,
			start.order,
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.submissions} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<SubmissionRecord>(row.record)),
			limit,
			start.order,
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE conversation_id = ? AND request_id = ?`,
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
		const sql =
			at === "current"
				? `SELECT record FROM ${this.schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
				: `SELECT record FROM ${this.schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`;
		const params: SqliteValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		if (at !== "current") params.push(at, at);
		const row = await this.db.get<JsonRow>(sql, ...params);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		return this.db.transaction((transaction) => this.materializeDocument(transaction, id, at));
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
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.record)),
			limit,
		);
	}

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	private async closeDatabase(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		await this.db.close();
	}

	/**
	 * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
	 * closed database. Single-query reads and transactions are already ordered before close by the database.
	 */
	private async admitRead<T>(read: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admittedReads++;
		try {
			return await read();
		} finally {
			if (--this.admittedReads === 0) this.readsDrained?.();
		}
	}

	private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	private async materializeDocument(
		executor: SqliteExecutor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const row = await executor.get<JsonRow>(`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`, id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await executor.get<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		const tail = await executor.all<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
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
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = claimOf(write)?.id;
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	/** Resolve each copy to a base of its source's state before this batch, which may not change the source. */
	private async resolveCopies(executor: SqliteExecutor, actions: Map<DocumentId, DocumentAction>): Promise<void> {
		for (const [id, action] of actions) {
			if (action.copy === undefined) continue;
			try {
				const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
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
				action.content = { kind: "base", version: stored.version, value: stored.value };
			} catch (error) {
				throw new Error(`Document copy ${id} was rejected`, { cause: error });
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteStorage is closed");
	}
}
