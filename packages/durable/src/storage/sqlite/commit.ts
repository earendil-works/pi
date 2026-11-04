// One `SqliteStorage.commit()` call in a few statements whatever its number of batches: the check state of all its
// batches read up front (`CommitState`), each batch checked in memory against what the batches before it left, and the
// accepted batches written per table (`PendingWrites`, through `statements.ts`). Over a remote SQLite every statement
// is a round trip while the write lock is held; a group of commits must not cost one round trip per write.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type {
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Id,
	Seq,
	StorageWrite,
} from "../../types.ts";
import {
	addressColumnsKey,
	addressKey,
	addressParts,
	type Cell,
	documentRow,
	encodeIndexedString,
	encodeJson,
	isCurrentOnly,
	parseJson,
} from "./rows.ts";
import type { SqliteSchema } from "./schema.ts";
import { insertRows, readRows, runForEach } from "./statements.ts";

/** The table a record ID belongs to, as `record_ids` stores it. */
export type TableName = "conversation" | "entry" | "task" | "submission" | "document";

/** What one batch does to one document: its creation or copy, its new content, its retirement. */
export type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};

type Tables = SqliteSchema["tables"];

/** The record ID a write claims and its table, if it claims one. */
export const claimOf = (write: StorageWrite): { readonly id: Id<string>; readonly table: TableName } | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return { id: write.value.id, table: write.type };
		case "document.create":
		case "document.copy":
			return { id: write.record.id, table: "document" };
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** One batch's writes per document; throws when a document gets two content commands or two retirements. */
export function prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
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

type RecordIdRow = { readonly id: number; readonly record_type: TableName };
type DocumentRow = { readonly record: string };
type VersionRow = { readonly document_id: number; readonly version: number | null };
type AddressRow = {
	readonly id: number;
	readonly kind: string;
	readonly scope_kind: string;
	readonly owner_id: number;
	readonly family: number;
	readonly key_value: string;
};

/**
 * What the checks of one call's batches read: the stored state of every ID, document and address the batches touch,
 * read in a few statements when the call starts, then advanced in memory by each accepted batch.
 */
export class CommitState {
	/** The table of each claimed ID; absent: unclaimed. */
	readonly #recordIds: Map<number, TableName>;
	/** Each touched document's record; absent: no such document. */
	readonly #documents: Map<number, DocumentRecord>;
	/** The version of each delta-changed document's latest revision; absent: no revision. */
	readonly #versions: Map<number, number>;
	/** The current incarnation of each created address (`addressKey`); `undefined`: none. */
	readonly #current: Map<string, DocumentId | undefined>;

	private constructor(
		recordIds: Map<number, TableName>,
		documents: Map<number, DocumentRecord>,
		versions: Map<number, number>,
		current: Map<string, DocumentId | undefined>,
	) {
		this.#recordIds = recordIds;
		this.#documents = documents;
		this.#versions = versions;
		this.#current = current;
	}

	/** Reads the stored state the checks of `batches` need: one statement per kind of state (split only by size). */
	static async read(
		executor: SqliteExecutor,
		tables: Tables,
		batches: readonly (readonly StorageWrite[])[],
	): Promise<CommitState> {
		const ids = new Set<number>();
		const documentIds = new Set<number>();
		const deltaIds = new Set<number>();
		const addresses = new Map<string, ReturnType<typeof addressParts>>();
		for (const writes of batches) {
			for (const write of writes) {
				const claim = claimOf(write);
				if (claim !== undefined) ids.add(claim.id);
				switch (write.type) {
					case "document.create":
					case "document.copy":
						documentIds.add(write.record.id);
						addresses.set(addressKey(write.record), addressParts(write.record));
						break;
					case "document.change":
						documentIds.add(write.id);
						if (write.content.kind === "delta") deltaIds.add(write.id);
						break;
					case "document.retire":
						documentIds.add(write.id);
						break;
					default:
						break;
				}
			}
		}
		const recordIds = new Map<number, TableName>();
		for (const row of await readRows<RecordIdRow>(
			executor,
			`SELECT id, record_type FROM ${tables.recordIds} WHERE id IN (SELECT value FROM json_each(?))`,
			[...ids],
		)) {
			recordIds.set(row.id, row.record_type);
		}
		const documents = new Map<number, DocumentRecord>();
		for (const row of await readRows<DocumentRow>(
			executor,
			`SELECT record FROM ${tables.documents} WHERE id IN (SELECT value FROM json_each(?))`,
			[...documentIds],
		)) {
			const record = parseJson<DocumentRecord>(row.record);
			documents.set(record.id, record);
		}
		const versions = new Map<number, number>();
		// Driven by the requested IDs: each latest revision is one descending probe of the primary key.
		for (const row of await readRows<VersionRow>(
			executor,
			`SELECT requested.value AS document_id, (
				SELECT version FROM ${tables.documentRevisions} WHERE document_id = requested.value ORDER BY seq DESC LIMIT 1
			) AS version FROM json_each(?) AS requested`,
			[...deltaIds],
		)) {
			if (row.version !== null) versions.set(row.document_id, row.version);
		}
		return new CommitState(recordIds, documents, versions, await readCurrent(executor, tables, addresses));
	}

	/** Durable's own checks of one batch that need no copy source: throws the refusal. */
	check(writes: readonly StorageWrite[], actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		this.#checkIds(writes);
		this.#checkDocuments(actions);
	}

	/** Advances the state past an accepted batch stored at `seq`, its copies resolved to their content. */
	apply(writes: readonly StorageWrite[], actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq): void {
		for (const write of writes) {
			// An accepted batch claims an ID only for its stored table, if it has one (`#checkIds`).
			const claim = claimOf(write);
			if (claim !== undefined) this.#recordIds.set(claim.id, claim.table);
		}
		for (const [id, action] of actions) {
			if (action.create !== undefined) {
				const record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) };
				this.#documents.set(id, record);
				if (!action.retire) this.#current.set(addressKey(record), id);
			} else if (action.retire) {
				const record = { ...this.#documents.get(id)!, retiredAt: seq };
				this.#documents.set(id, record);
				// The batch may have created the address's next incarnation already: only this one leaves.
				const key = addressKey(record);
				if (this.#current.get(key) === id) this.#current.set(key, undefined);
			}
			// A retired document's versions are never read again: every later action on it is refused first.
			if (action.content !== undefined) this.#versions.set(id, action.content.version);
		}
	}

	/** A document's record as the accepted batches left it. */
	document(id: DocumentId): DocumentRecord | undefined {
		return this.#documents.get(id);
	}

	#checkIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			const claim = claimOf(write);
			if (claim === undefined) continue;
			const { id, table } = claim;
			const existing = this.#recordIds.get(id);
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

	#checkDocuments(actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const existing = this.#documents.get(id);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = this.#versions.get(id);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous !== action.content.version)
					throw new Error(`Document ${id} version transition requires a base`);
			}
			// A plain change keeps its address's live count: only creations and retirements are counted.
			if (action.create === undefined && !action.retire) continue;
			const key = addressKey(action.create ?? existing!);
			let live = liveCounts.get(key);
			// Only created addresses were read: an address no batch creates only loses incarnations, never exceeds one.
			if (live === undefined) live = this.#current.get(key) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}
}

/** The current incarnation of each of `addresses`, `undefined` for one without. */
async function readCurrent(
	executor: SqliteExecutor,
	tables: Tables,
	addresses: ReadonlyMap<string, ReturnType<typeof addressParts>>,
): Promise<Map<string, DocumentId | undefined>> {
	const current = new Map<string, DocumentId | undefined>();
	for (const key of addresses.keys()) current.set(key, undefined);
	const rows = await readRows<AddressRow>(
		executor,
		`SELECT document.id, document.kind, document.scope_kind, document.owner_id, document.family, document.key_value
			FROM json_each(?) AS address JOIN ${tables.documents} AS document
			ON document.kind = json_extract(address.value, '$[0]') AND document.scope_kind = json_extract(address.value, '$[1]')
			AND document.owner_id = json_extract(address.value, '$[2]') AND document.family = json_extract(address.value, '$[3]')
			AND document.key_value = json_extract(address.value, '$[4]')
			WHERE document.retired_at IS NULL`,
		[...addresses.values()].map((part) => [part.kind, part.scopeKind, part.ownerId, part.family, part.keyValue]),
	);
	for (const row of rows) {
		current.set(
			addressColumnsKey(row.kind, row.scope_kind, row.owner_id, row.family, row.key_value),
			row.id as DocumentId,
		);
	}
	return current;
}

/**
 * The writes of the accepted batches not yet written, per table, as their net effect: a task or submission written
 * twice is written once, as last written; a current-only document's revisions before its latest base or retirement
 * are dropped (and its stored ones deleted).
 */
export class PendingWrites {
	readonly #recordIds = new Map<number, TableName>();
	readonly #conversations: Cell[][] = [];
	readonly #entries: Cell[][] = [];
	readonly #tasks = new Map<number, Cell[]>();
	readonly #submissions = new Map<number, Cell[]>();
	/** Each created or retired document's record. */
	readonly #documents = new Map<number, DocumentRecord>();
	/** The documents whose stored revisions go. */
	readonly #cleared = new Set<number>();
	/** Each document's new revisions, in seq order. */
	readonly #revisions = new Map<number, Cell[][]>();

	/** Adds a batch stored at `seq`, after `state` applied it. */
	add(
		writes: readonly StorageWrite[],
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
		state: CommitState,
	): void {
		for (const write of writes) this.#addWrite(write, seq);
		for (const [id, action] of actions) this.#addDocument(id, action, seq, state.document(id)!);
	}

	#addWrite(write: StorageWrite, seq: Seq): void {
		const claim = claimOf(write);
		if (claim !== undefined) this.#recordIds.set(claim.id, claim.table);
		switch (write.type) {
			case "conversation":
				this.#conversations.push([
					write.value.id,
					write.value.owner?.conversationId ?? null,
					write.value.owner?.taskId ?? null,
					encodeJson(write.value),
				]);
				break;
			case "entry":
				this.#entries.push([
					write.value.id,
					write.value.conversationId,
					write.value.head ?? null,
					seq,
					encodeJson(write.value),
				]);
				break;
			case "task":
				this.#tasks.set(write.value.id, [
					write.value.id,
					write.value.conversationId,
					encodeIndexedString(write.value.kind),
					write.value.state.status,
					write.value.abortRequested ? 1 : 0,
					write.value.background ? 1 : 0,
					encodeJson(write.value),
				]);
				break;
			case "submission":
				this.#submissions.set(write.value.id, [
					write.value.id,
					write.value.conversationId,
					write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
					write.value.status,
					encodeJson(write.value),
				]);
				break;
			default:
				break;
		}
	}

	#addDocument(id: DocumentId, action: DocumentAction, seq: Seq, record: DocumentRecord): void {
		if (action.create !== undefined || action.retire) this.#documents.set(id, record);
		const content = action.content;
		if (content !== undefined) {
			if (content.kind === "base" && isCurrentOnly(record)) this.#clear(id);
			const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
			let revisions = this.#revisions.get(id);
			if (revisions === undefined) {
				revisions = [];
				this.#revisions.set(id, revisions);
			}
			revisions.push([id, seq, content.kind, content.version, encoded]);
		}
		if (action.retire && isCurrentOnly(record)) this.#clear(id);
	}

	/** Drops a document's revisions: the pending ones, and the stored ones when written. */
	#clear(id: number): void {
		this.#cleared.add(id);
		this.#revisions.delete(id);
	}

	/** Writes everything pending, a few statements per table (`insertRows`), and forgets it. */
	async flush(executor: SqliteExecutor, tables: Tables): Promise<void> {
		await insertRows(
			executor,
			tables.recordIds,
			["id", "record_type"],
			[...this.#recordIds].map(([id, table]) => [id, table]),
			"ON CONFLICT(id) DO NOTHING",
		);
		await insertRows(
			executor,
			tables.conversations,
			["id", "owner_conversation_id", "owner_task_id", "record"],
			this.#conversations,
		);
		await insertRows(
			executor,
			tables.entries,
			["id", "conversation_id", "head", "commit_seq", "record"],
			this.#entries,
		);
		await insertRows(
			executor,
			tables.tasks,
			["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
			[...this.#tasks.values()],
			`ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
				status = excluded.status, abort_requested = excluded.abort_requested,
				background = excluded.background, record = excluded.record`,
		);
		await insertRows(
			executor,
			tables.submissions,
			["id", "conversation_id", "request_id", "status", "record"],
			[...this.#submissions.values()],
			`ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
				request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
		);
		// A created document is inserted, a stored one retired: one upsert writes both.
		await insertRows(
			executor,
			tables.documents,
			["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"],
			[...this.#documents.values()].map(documentRow),
			"ON CONFLICT(id) DO UPDATE SET retired_at = excluded.retired_at, record = excluded.record",
		);
		await runForEach(
			executor,
			`DELETE FROM ${tables.documentRevisions} WHERE document_id IN (SELECT value FROM json_each(?))`,
			[...this.#cleared],
		);
		await insertRows(
			executor,
			tables.documentRevisions,
			["document_id", "seq", "kind", "version", "content"],
			[...this.#revisions.values()].flat(),
		);
		this.#recordIds.clear();
		this.#conversations.length = 0;
		this.#entries.length = 0;
		this.#tasks.clear();
		this.#submissions.clear();
		this.#documents.clear();
		this.#cleared.clear();
		this.#revisions.clear();
	}
}
