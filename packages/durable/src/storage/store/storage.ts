// Durable's `Storage` on Chord's store (slice 6b D1, D2, §2): opening under an owner name (claims, tables, the
// allocator), commits as one composite write of the store's commit step, and the reads, each one guarded read of the
// store (several queries at one state in a read transaction), its request errors in a tagged result told after it.

import type { Context, JsonValue } from "@earendil-works/chord";
import {
	type ChordStore,
	type Claimant,
	findDocumentEntry,
	listDocumentEntries,
	type Store,
	StoreOwnerTables,
} from "@earendil-works/chord/next";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCopySource,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
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
import { type CommitTables, DurableCommit } from "./commit.ts";
import { addressOf, type DocumentRead, namespaceOf, readAt, recordOfEntry, SCOPE_NAMESPACES } from "./documents.ts";
import { type Condition, type StorageQueries, storageQueries, type TableQueries } from "./queries.ts";
import { Conversations, Entries, EntryHeads, encodeIndexed, RecordIds, Submissions, Tasks } from "./tables.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

/**
 * A guarded read's result: its data, or its request error, which is thrown after the guarded read (slice 6b §1.4),
 * never inside it.
 */
type Read<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "refused"; readonly message: string };

/** The id condition of a table scan from `start`. */
function scanFrom(start: ScanStart): Condition {
	return start.order === "ascending"
		? ["id", "gt", start.after ?? -1]
		: ["id", "lt", start.after ?? Number.MAX_SAFE_INTEGER];
}

function page<T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder,
): Page<T, Cursor> {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
}

function cursorId(cursor: Cursor | undefined): number | undefined {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return after;
}

/**
 * Durable's `Storage` on Chord's store (slice 6b D1, D2, §2): its records as declared tables under an owner name, its
 * documents in the store's documents engine, its ids from the store's one allocator, its commits as one composite
 * write of the store's commit step, adopted in the host's batch. Several may share a store under distinct owner names
 * (claims); the app owns the store, and `close` leaves it open.
 */
export class StoreStorage implements Storage {
	readonly #store: ChordStore;
	readonly #owner: string;
	readonly #claimant: Claimant;
	readonly #tables: CommitTables;
	readonly #queries: StorageQueries;
	#closed = false;
	#closing: Promise<void> | undefined;
	/** Calls underway, which `close` waits for before it releases the claims (`#drained` once they reach 0). */
	#underway = 0;
	#drained: (() => void) | undefined;

	private constructor(store: ChordStore, owner: string, claimant: Claimant, tables: CommitTables) {
		this.#store = store;
		this.#owner = owner;
		this.#claimant = claimant;
		this.#tables = tables;
		this.#queries = storageQueries(tables);
	}

	/**
	 * Opens Durable's storage in `store` under `owner` (a lowercase `[a-z0-9@/._~-]` name): claims its tables and its
	 * document namespaces (a second claim is refused `invalid/args`), creates or migrates its tables, and raises the
	 * store's allocator above every id it holds (one index read). A failure releases what it claimed.
	 */
	static async open(store: Store, owner: string, context: Context): Promise<StoreStorage> {
		// Chord's own: `openStore` or `importStore` made it.
		const chord = store as ChordStore;
		const claimant: Claimant = { label: `StoreStorage(${owner})` };
		try {
			const declared = new StoreOwnerTables(chord, owner, claimant);
			const tables: CommitTables = {
				recordIds: declared.declare(RecordIds),
				conversations: declared.declare(Conversations),
				entries: declared.declare(Entries),
				entryHeads: declared.declare(EntryHeads),
				tasks: declared.declare(Tasks),
				submissions: declared.declare(Submissions),
			};
			for (const namespace of SCOPE_NAMESPACES) chord.claims.documents(owner, namespace, claimant);
			await declared.prepare(context);
			const highest = await chord.read(
				(executor) =>
					executor.get<{ readonly id: number | null }>(
						`SELECT max("id") AS id FROM "${tables.recordIds.sql.table}"`,
					),
				context,
			);
			if (highest?.id != null) chord.ids.raise(highest.id);
			return new StoreStorage(chord, owner, claimant, tables);
		} catch (error) {
			chord.claims.release(claimant);
			throw error;
		}
	}

	commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq> {
		return this.#call(async () => {
			const store = this.#store;
			const commit = new DurableCommit(writes, this.#owner, this.#tables, (id) => store.ids.raise(id), context);
			await commit.resolveCopies((source) => this.#copySource(source, context));
			// An empty commit stages nothing: it takes no seq, adopted at `lastSeq`.
			const staged = writes.length === 0 ? [] : [commit];
			return seqFromNumber(await store.commitInBatch(staged, (seq) => adopt(seqFromNumber(seq)), context));
		});
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.#call(async () => idFromNumber<I>(this.#store.mintId()));
	}

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#read((executor) => this.#conversation(executor, id, context), context);
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#reading(() => {
			const start = scanStart(query.order, cursor, "ascending");
			const conditions: Condition[] = [scanFrom(start)];
			if (query.ownerConversationId !== undefined) {
				conditions.push(["owner_conversation_id", "eq", query.ownerConversationId]);
			}
			if (query.ownerTaskId !== undefined) conditions.push(["owner_task_id", "eq", query.ownerTaskId]);
			return this.#scan<ConversationRecord>(this.#queries.conversations, conditions, start, limit, context);
		});
	}

	entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		maybeContext?: Context,
	): Promise<StoredEntry | undefined> {
		if (maybeContext === undefined) {
			const context = idOrContext as Context;
			return this.#read((executor) => this.#entry(executor, idOrConversationId as EntryId, context), context);
		}
		const context = maybeContext;
		const id = typeof idOrContext === "number" ? idFromNumber<EntryId>(idOrContext) : undefined;
		return this.#reading(() => {
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			const conversationId = idOrConversationId as ConversationId;
			return this.#store
				.read((executor) => this.#visibleEntry(executor, conversationId, id, context), context)
				.then(told);
		});
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#reading(() =>
			this.#store
				.read((executor) => this.#latestHeadMarker(executor, conversationId, atOrBeforeEntryId, context), context)
				.then(told),
		);
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#reading(() => {
			const { order, after } = scanStart(query.order, cursor, "descending");
			const read =
				order === "ascending"
					? (executor: SqliteExecutor) => this.#entriesAscending(executor, query, limit, after, context)
					: (executor: SqliteExecutor) => this.#entriesDescending(executor, query, limit, after, context);
			return this.#store.read(read, context).then(told);
		});
	}

	task(id: TaskId, context: Context): Promise<StoredTask | undefined> {
		const tasks = this.#queries.tasks;
		return this.#read(async (executor) => {
			const row = await tasks.byId(executor, id);
			return row === undefined ? undefined : tasks.record<StoredTask>(row, context);
		}, context);
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		return this.#reading(() => {
			const start = scanStart(query.order, cursor, "ascending");
			const conditions: Condition[] = [scanFrom(start)];
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.kind !== undefined) conditions.push(["kind", "eq", encodeIndexed(query.kind)]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			if (query.abortRequested !== undefined)
				conditions.push(["abort_requested", "eq", query.abortRequested ? 1 : 0]);
			if (query.background !== undefined) conditions.push(["background", "eq", query.background ? 1 : 0]);
			return this.#scan<StoredTask>(this.#queries.tasks, conditions, start, limit, context);
		});
	}

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		const submissions = this.#queries.submissions;
		return this.#read(async (executor) => {
			const row = await submissions.byId(executor, id);
			return row === undefined ? undefined : submissions.record<SubmissionRecord>(row, context);
		}, context);
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#reading(() => {
			const start = scanStart(query.order, cursor, "ascending");
			const conditions: Condition[] = [scanFrom(start)];
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			return this.#scan<SubmissionRecord>(this.#queries.submissions, conditions, start, limit, context);
		});
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		const submissions = this.#queries.submissions;
		const conditions: Condition[] = [
			["conversation_id", "eq", conversationId],
			["request_id", "eq", encodeIndexed(requestId)],
		];
		return this.#read(async (executor) => {
			const row = await submissions.first(executor, conditions, "ascending");
			return row === undefined ? undefined : submissions.record<SubmissionRecord>(row, context);
		}, context);
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#read(async (executor) => {
			const entry = await findDocumentEntry(executor, addressOf(address, this.#owner), at);
			return entry === undefined ? undefined : recordOfEntry(entry);
		}, context);
	}

	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		// The record and its revisions must come from one committed state (S4).
		return this.#reading(() =>
			this.#store.readTransaction((executor) => readAt(executor, id, at, this.#owner), context).then(documentOf),
		);
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#reading(() => {
			const after = cursorId(cursor) ?? -1;
			const scope = {
				owner: this.#owner,
				namespace: namespaceOf(query.scope),
				...(query.kind === undefined ? {} : { kind: encodeIndexed(query.kind) }),
			};
			return this.#store
				.read((executor) => listDocumentEntries(executor, scope, query.at, after, limit + 1), context)
				.then((found) => page(found.map(recordOfEntry), limit, "ascending"));
		});
	}

	/**
	 * Refuses new calls, waits for its commits underway, then releases its claims; the store stays open (the app's),
	 * and finishes the reads underway, which change nothing.
	 */
	close(_context: Context): Promise<void> {
		if (this.#closing === undefined) {
			this.#closed = true;
			this.#closing = (async () => {
				if (this.#underway > 0) {
					await new Promise<void>((resolve) => {
						this.#drained = resolve;
					});
				}
				this.#store.claims.release(this.#claimant);
			})();
		}
		return this.#closing;
	}

	/** Runs one commit or mint of this storage: refused once it closed, counted until it settles (`close` waits). */
	async #call<T>(run: () => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("StoreStorage is closed");
		this.#underway++;
		try {
			return await run();
		} finally {
			if (--this.#underway === 0) this.#drained?.();
		}
	}

	/**
	 * A call that is one guarded read of the store: refused once closed; not waited for by `close` (a read changes
	 * nothing, and the store, which stays open, finishes it).
	 */
	#read<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		return this.#reading(() => this.#store.read(read, context));
	}

	/**
	 * A read call: `read` prepares its guarded read (a request error thrown then, before it) and returns it. Refused
	 * once closed; one promise per call besides the guard's (no async wrapper).
	 */
	#reading<T>(read: () => Promise<T>): Promise<T> {
		try {
			if (this.#closed) throw new Error("StoreStorage is closed");
			return read();
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #conversation(
		executor: SqliteExecutor,
		id: ConversationId,
		context: Context,
	): Promise<ConversationRecord | undefined> {
		const conversations = this.#queries.conversations;
		const row = await conversations.byId(executor, id);
		return row === undefined ? undefined : conversations.record<ConversationRecord>(row, context);
	}

	#entry(executor: SqliteExecutor, id: EntryId, context: Context): Promise<StoredEntry | undefined> {
		const entries = this.#queries.entries;
		return entries.byId(executor, id).then((row) => {
			if (row === undefined) return undefined;
			return { entry: entries.record<EntryRecord>(row, context), commitSeq: seqFromNumber(row.commit_seq!) };
		});
	}

	/** Entry `id` when visible through `conversationId`'s fork chain (`SqliteStorage.readEntry`). */
	async #visibleEntry(
		executor: SqliteExecutor,
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<Read<StoredEntry | undefined>> {
		let conversation = await this.#conversation(executor, conversationId, context);
		if (conversation === undefined) return unknownConversation(conversationId);
		const stored = await this.#entry(executor, id, context);
		if (stored === undefined) return NOTHING_FOUND;
		let upper = Number.POSITIVE_INFINITY;
		while (conversation.id !== stored.entry.conversationId) {
			if (conversation.parent === undefined) return NOTHING_FOUND;
			upper = Math.min(upper, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		return stored.entry.id > upper ? NOTHING_FOUND : { kind: "found", value: stored };
	}

	async #latestHeadMarker(
		executor: SqliteExecutor,
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<Read<(EntryRecord & { readonly head: EntryId }) | undefined>> {
		let conversation = await this.#conversation(executor, conversationId, context);
		if (conversation === undefined) return unknownConversation(conversationId);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const { latestHead } = this.#queries;
			const head =
				upper === undefined
					? await executor.get<{ readonly id: number }>(latestHead.any, conversation.id)
					: await executor.get<{ readonly id: number }>(latestHead.atOrBefore, conversation.id, upper);
			if (head !== undefined) {
				// Written with its entry, in the same commit.
				const row = (await this.#queries.entries.byId(executor, head.id))!;
				const value = this.#queries.entries.record<EntryRecord & { readonly head: EntryId }>(row, context);
				return { kind: "found", value };
			}
			if (conversation.parent === undefined) return NOTHING_FOUND;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
	}

	/** Newest first: each conversation of the fork chain up to its fork point (`SqliteStorage.readEntries`). */
	async #entriesDescending(
		executor: SqliteExecutor,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
		context: Context,
	): Promise<Read<Page<EntryRecord, Cursor>>> {
		let conversation = await this.#conversation(executor, query.conversationId, context);
		if (conversation === undefined) return unknownConversation(query.conversationId);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const range = this.#range(conversation.id, query.minEntryId, upper);
			const rows = await this.#queries.entries.select(executor, range, "descending", limit + 1 - values.length);
			this.#queries.entries.records(rows, values, context);
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		return { kind: "found", value: page(values, limit, "descending") };
	}

	/** Oldest first: the fork chain's segments from the root forward, each up to its fork point. */
	async #entriesAscending(
		executor: SqliteExecutor,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
		context: Context,
	): Promise<Read<Page<EntryRecord, Cursor>>> {
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let conversation = await this.#conversation(executor, query.conversationId, context);
		if (conversation === undefined) return unknownConversation(query.conversationId);
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const range = this.#range(segment.conversationId, lower, segment.upper);
			const rows = await this.#queries.entries.select(executor, range, "ascending", limit + 1 - values.length);
			this.#queries.entries.records(rows, values, context);
			if (values.length > limit) break;
		}
		return { kind: "found", value: page(values, limit, "ascending") };
	}

	/** One conversation's entries with ids from `lower` to `upper` (inclusive, each optional). */
	#range(conversationId: ConversationId, lower: number | undefined, upper: number | undefined): Condition[] {
		const conditions: Condition[] = [["conversation_id", "eq", conversationId]];
		if (lower !== undefined) conditions.push(["id", "gte", lower]);
		if (upper !== undefined) conditions.push(["id", "lte", upper]);
		return conditions;
	}

	/** A page of a table scan: up to `limit` records of `queries`' table whose `conditions` hold, from `start`. */
	#scan<T extends { readonly id: Id<string> }>(
		queries: TableQueries,
		conditions: readonly Condition[],
		start: ScanStart,
		limit: number,
		context: Context,
	): Promise<Page<T, Cursor>> {
		return this.#store
			.read((executor) => queries.select(executor, conditions, start.order, limit + 1), context)
			.then((rows) => {
				const values: T[] = [];
				queries.records(rows, values, context);
				return page(values, limit, start.order);
			});
	}

	/** A copy's source read at its point, before the step (S11); a request error is thrown here, outside the read. */
	async #copySource(source: DocumentCopySource, context: Context) {
		const read = await this.#store.readTransaction(
			(executor) => readAt(executor, source.id, source.at, this.#owner),
			context,
		);
		return documentOf(read);
	}
}

/** A read that found nothing. */
const NOTHING_FOUND: Read<undefined> = { kind: "found", value: undefined };

function unknownConversation(id: ConversationId): Read<never> {
	return { kind: "refused", message: `Unknown conversation: ${id}` };
}

/** A read's data, its request error thrown now that the guarded read returned (slice 6b §1.4). */
function told<T>(read: Read<T>): T {
	if (read.kind === "refused") throw new StorageRequestError(read.message);
	return read.value;
}

/** A document read's result, a record that keeps no history at the point thrown as Durable's request error. */
function documentOf(read: DocumentRead): StoredDocument | undefined {
	if (read.kind === "current_only")
		throw new StorageRequestError(`Document ${read.id} does not retain historical content`);
	return read.document;
}
