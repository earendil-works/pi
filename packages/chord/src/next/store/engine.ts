// The documents engine (S13, slice 6a §8, slice 6b §1.5): one record per incarnation of an address, revisions made of
// bases and deltas, a history rule per record (R1); its writes inside the commit step, checked by the writes
// themselves (the partial unique index on the live address, the counted conditional `UPDATE` on the record's
// revision), and its reads, of the current state or at a point.

import { apply, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteExecutor } from "../../sqlite/index.ts";
import { TABLES } from "./schema.ts";
import type { StagedWrite, Step } from "./step.ts";

/**
 * A document's address: the owner name, the adapter's namespace (claimed with the owner: Chord's `chord`, `chord.jobs`,
 * `chord.job-states`; Durable's scopes), the kind and, for a keyed document, its key; a singleton has none. The column
 * keeps `""` for it, which a keyed document's empty key shares (its definition says which it is).
 */
export type DocumentAddress = {
	readonly owner: string;
	readonly namespace: string;
	readonly kind: string;
	readonly key?: string;
};

/**
 * What a record keeps (R1), applied at a new base and at retirement: `none` (Chord) drops older revisions at a new base
 * and the row and its revisions at retirement; `latest` drops older revisions at a new base and its revisions at
 * retirement, keeping the row; `rewindable` keeps everything.
 */
export type DocumentHistory = "none" | "latest" | "rewindable";

/** A stored record: one incarnation of an address, live from `createdAt` until `retiredAt` (half-open). */
export type DocumentRecord = DocumentAddress & {
	readonly id: number;
	readonly history: DocumentHistory;
	/** The seq that created it. */
	readonly createdAt: number;
	/** The seq that retired it, once retired. */
	readonly retiredAt?: number;
	/** The adapter's details (Durable: its fork policy and history). */
	readonly meta?: string;
	/** Counts its changes: a change names the revision it was prepared on. */
	readonly revision: number;
	/** The version and schema fingerprint of its current base. */
	readonly version: number;
	readonly fingerprint: string;
};

/** A base: a whole value at a version. */
export type DocumentBase = { readonly version: number; readonly fingerprint: string; readonly value: JsonValue };

/** A change's content: a new base, or a delta on the current base's version. */
export type DocumentContent =
	| ({ readonly kind: "base" } & DocumentBase)
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };

/** A stored revision's content: a base's value or a delta's ops, at a version (a revision keeps no fingerprint). */
export type RevisionContent =
	| { readonly kind: "base"; readonly version: number; readonly value: JsonValue }
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };

/** One stored revision as archives carry it: its document, its seq, its content. */
export type DocumentRevision = { readonly id: number; readonly seq: number; readonly content: RevisionContent };

/**
 * The engine's writes as the outbox and archives record them. A creation carries its base in a commit (stored at
 * `createdAt`); in an archive it has none and its `document.revision`s follow it.
 */
export type DocumentWrite =
	| { readonly kind: "document.create"; readonly record: DocumentRecord; readonly base?: DocumentBase }
	| {
			readonly kind: "document.change";
			readonly id: number;
			readonly revision: number;
			readonly content: DocumentContent;
	  }
	| { readonly kind: "document.retire"; readonly id: number; readonly revision: number }
	| ({ readonly kind: "document.revision" } & DocumentRevision);

/** A loaded document: its record and its value (a base plus deltas applied once) at a point. */
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly value: JsonValue;
	/** The version of the base the value was built from. */
	readonly version: number;
	/** The deltas applied after its base (what `checkpointWhen` sees). */
	readonly deltasSinceBase: number;
};

/** Where a read looks: the current state, or the state after a seq. */
export type DocumentPoint = number | "current";

/**
 * Stages the creation of a Chord document at `address` with `base`; its id is taken from the allocator when it
 * applies (a saturated allocator refuses the commit) and handed to `created` (its owner adopts it after `COMMIT`).
 * `text` is the base's value serialized before the queue (rule 8).
 */
export function createDocument(
	address: DocumentAddress,
	base: DocumentBase,
	text: string,
	created?: (id: number) => void,
): StagedWrite {
	return {
		order: "create",
		apply: async (step) => {
			const id = step.ids.mint();
			step.created.push(id);
			created?.(id);
			const { version, fingerprint } = base;
			const record: DocumentRecord = {
				id,
				...address,
				history: "none",
				createdAt: step.seq,
				revision: 1,
				version,
				fingerprint,
			};
			await insertDocument(step, record, text);
			return [{ kind: "document.create", record, base }];
		},
	};
}

/**
 * Inserts `record` as it is (id, seqs and revision kept: a creation, an import, a batch), with its base at `createdAt`
 * when `text` (the base's value serialized) is given; a record created retired (an empty lifetime) keeps what its
 * history keeps.
 */
export async function insertDocument(step: Step, record: DocumentRecord, text: string | undefined): Promise<void> {
	const { id, namespace, owner, kind, key, history, createdAt, retiredAt, meta, revision, version, fingerprint } =
		record;
	await step.run(
		`INSERT INTO ${TABLES.documents}
			(id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		owner,
		namespace,
		kind,
		key ?? "",
		history,
		createdAt,
		retiredAt ?? null,
		meta ?? null,
		revision,
		version,
		fingerprint,
	);
	if (text !== undefined) await insertRevision(step, id, createdAt, "base", version, text);
	if (retiredAt !== undefined) await dropRetired(step, id, history);
}

/**
 * Stages a change of Chord document `id` prepared on `revision`: a delta on the current base's version, or a new base.
 * `text` is the content serialized before the queue.
 */
export function changeDocument(id: number, revision: number, content: DocumentContent, text: string): StagedWrite {
	const write: DocumentWrite = { kind: "document.change", id, revision, content };
	return {
		order: "write",
		apply: async (step) => {
			await writeContent(step, id, "none", revision, content, text);
			return [write];
		},
	};
}

/**
 * Writes `content` to document `id` (of `history`) prepared on `revision`, in the step's seq: its revision, the
 * counted conditional `UPDATE` (a delta only on the base's version), and at a new base the older revisions a
 * `none` or `latest` record drops. A record that is not live at `revision` throws (memory and disk disagree).
 */
export async function writeContent(
	step: Step,
	id: number,
	history: DocumentHistory,
	revision: number,
	content: DocumentContent,
	text: string,
): Promise<void> {
	// As ids: a revision past the safe range would stop counting exactly.
	if (revision >= Number.MAX_SAFE_INTEGER) throw new Error(`document ${id}: no revision past the safe range`);
	await insertRevision(step, id, step.seq, content.kind, content.version, text);
	const changed =
		content.kind === "delta"
			? await step.runCounted(
					`UPDATE ${TABLES.documents} SET revision = revision + 1
						WHERE id = ? AND revision = ? AND version = ? AND retired_at IS NULL`,
					id,
					revision,
					content.version,
				)
			: await step.runCounted(
					`UPDATE ${TABLES.documents} SET revision = revision + 1, version = ?, fingerprint = ?
						WHERE id = ? AND revision = ? AND retired_at IS NULL`,
					content.version,
					content.fingerprint,
					id,
					revision,
				);
	if (changed !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
	if (content.kind === "base" && history !== "rewindable") {
		await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ? AND seq < ?`, id, step.seq);
	}
}

/** Stages the retirement of Chord document `id` (history `none`) at `revision`: its row and its revisions go. */
export function retireDocument(id: number, revision: number): StagedWrite {
	const write: DocumentWrite = { kind: "document.retire", id, revision };
	return {
		order: "retire",
		apply: async (step) => {
			// A Chord document keeps no history (`none`): its row goes with a conditional, counted DELETE (6a's).
			const deleted = await step.runCounted(
				`DELETE FROM ${TABLES.documents} WHERE id = ? AND revision = ? AND retired_at IS NULL`,
				id,
				revision,
			);
			if (deleted !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
			await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
			return [write];
		},
	};
}

/**
 * Retires live `record` in the step's seq by its history (R1): a `none` record's row and revisions go, a `latest` one
 * keeps its row with `retired_at` and drops its revisions, a `rewindable` one keeps everything.
 */
export async function retireRecord(step: Step, record: DocumentRecord): Promise<void> {
	const { id, history } = record;
	if (history !== "none") await step.run(`UPDATE ${TABLES.documents} SET retired_at = ? WHERE id = ?`, step.seq, id);
	await dropRetired(step, id, history);
}

/** What a retired record of `history` drops: a `none` row too, every revision unless `rewindable`. */
async function dropRetired(step: Step, id: number, history: DocumentHistory): Promise<void> {
	if (history === "rewindable") return;
	if (history === "none") await step.run(`DELETE FROM ${TABLES.documents} WHERE id = ?`, id);
	await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
}

/** Inserts one revision of document `id` at `seq`, `text` its serialized content. */
export function insertRevision(
	step: Step,
	id: number,
	seq: number,
	kind: "base" | "delta",
	version: number,
	text: string,
): Promise<void> {
	return step.run(
		`INSERT INTO ${TABLES.revisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
		id,
		seq,
		kind,
		version,
		text,
	);
}

type RecordRow = {
	readonly id: number;
	readonly owner: string;
	readonly namespace: string;
	readonly kind: string;
	readonly key: string;
	readonly history: DocumentHistory;
	readonly created_at: number;
	readonly retired_at: number | null;
	readonly meta: string | null;
	readonly revision: number;
	readonly version: number;
	readonly fingerprint: string;
};

const RECORD_COLUMNS =
	"id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint";

const READ = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id = ?`;

/** The record with `id`, live or retired, if there is one. */
export async function readDocument(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<DocumentRecord | undefined> {
	const row = await executor.get<RecordRow>(READ, id);
	return row === undefined ? undefined : recordOf(row);
}

const FIND_CURRENT = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND retired_at IS NULL`;

const FIND_AT = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
	ORDER BY created_at DESC LIMIT 1`;

/** The record at `address` live at `at` (the half-open lifetime `createdAt <= at < retiredAt`), if any. */
export async function findDocument(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint = "current",
): Promise<DocumentRecord | undefined> {
	const { owner, namespace, kind } = address;
	const key = address.key ?? "";
	const row =
		at === "current"
			? await executor.get<RecordRow>(FIND_CURRENT, owner, namespace, kind, key)
			: await executor.get<RecordRow>(FIND_AT, owner, namespace, kind, key, at, at);
	return row === undefined ? undefined : recordOf(row);
}

/**
 * A record as an adapter that keeps its own fields in `meta` reads it: the meta, and, where a read can find retired
 * records (at a point, by id), when it was retired. One or two columns: each column a read returns costs.
 */
export type DocumentEntry = { readonly meta: string | null; readonly retired_at?: number | null };

/** A document entry with what tells whose it is and what it keeps, as a read by id needs. */
export type OwnedDocumentEntry = DocumentEntry & {
	readonly owner: string;
	readonly namespace: string;
	readonly history: DocumentHistory;
};

const READ_ENTRY = `SELECT meta, retired_at, owner, namespace, history FROM ${TABLES.documents} WHERE id = ?`;

/** The entry of the record with `id`, live or retired, with its owner, namespace and history; `undefined` if none. */
export function readDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<OwnedDocumentEntry | undefined> {
	return executor.get<OwnedDocumentEntry>(READ_ENTRY, id);
}

const FIND_ENTRY_CURRENT = `SELECT meta FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND retired_at IS NULL`;

const FIND_ENTRY_AT = `SELECT meta, retired_at FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
	ORDER BY created_at DESC LIMIT 1`;

/** `findDocument` reading only what an adapter keeping its fields in `meta` needs (fewer columns, no record built). */
export function findDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint,
): Promise<DocumentEntry | undefined> {
	const { owner, namespace, kind } = address;
	const key = address.key ?? "";
	return at === "current"
		? executor.get<DocumentEntry>(FIND_ENTRY_CURRENT, owner, namespace, kind, key)
		: executor.get<DocumentEntry>(FIND_ENTRY_AT, owner, namespace, kind, key, at, at);
}

type RevisionRow = {
	readonly seq: number;
	readonly kind: "base" | "delta";
	readonly version: number;
	readonly content: string;
};

const LOAD = `SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq <= ? AND seq >= (
	SELECT max(seq) FROM ${TABLES.revisions} WHERE document_id = ? AND kind = 'base' AND seq <= ?) ORDER BY seq`;

/**
 * Loads `record` at `at`: its newest base at or below it and the deltas after that base up to it, applied once; the
 * version is the base's. A record without such a base (one that keeps no history from there) throws.
 */
export async function loadDocument(
	executor: Pick<SqliteExecutor, "all">,
	record: DocumentRecord,
	at: DocumentPoint = "current",
): Promise<StoredDocument> {
	return { record, ...(await loadContent(executor, record.id, at)) };
}

/** `loadDocument`'s content of document `id` at `at`, without its record (an adapter reads the fields it keeps). */
export async function loadContent(
	executor: Pick<SqliteExecutor, "all">,
	id: number,
	at: DocumentPoint,
): Promise<Omit<StoredDocument, "record">> {
	const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
	const revisions = await executor.all<RevisionRow>(LOAD, id, upper, id, upper);
	const [base, ...deltas] = revisions;
	if (base === undefined || base.kind !== "base") throw new Error(`document ${id}: no base`);
	let value = JSON.parse(base.content) as JsonValue;
	for (const delta of deltas) {
		if (delta.version !== base.version) throw new Error(`document ${id}: a delta crosses a version`);
		value = apply(value, JSON.parse(delta.content) as Op[]);
	}
	return { value, version: base.version, deltasSinceBase: deltas.length };
}

/** Up to `limit` keys of live documents of `kind` under `owner` after `after` (from the first), in code point order. */
export async function listDocumentKeys(
	executor: SqliteExecutor,
	address: Omit<DocumentAddress, "key">,
	after: string | undefined,
	limit: number,
): Promise<string[]> {
	// The first page has no lower bound: `""` is a key too.
	const from = after === undefined ? "" : " AND key > ?";
	const rows = await executor.all<{ readonly key: string }>(
		`SELECT key FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND kind = ?${from}
			AND retired_at IS NULL ORDER BY key LIMIT ?`,
		address.owner,
		address.namespace,
		address.kind,
		...(after === undefined ? [] : [after]),
		limit,
	);
	return rows.map(({ key }) => key);
}

/** What `listDocuments` scans: one owner's namespace, optionally one kind. */
export type DocumentScope = { readonly owner: string; readonly namespace: string; readonly kind?: string };

/** The statements of `listDocuments`, by its shape: with a kind or not, current or at a point. */
const LIST = (() => {
	const from = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND id > ?`;
	const current = " AND retired_at IS NULL ORDER BY id LIMIT ?";
	const at = " AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY id LIMIT ?";
	return {
		current: `${from}${current}`,
		at: `${from}${at}`,
		kindCurrent: `${from} AND kind = ?${current}`,
		kindAt: `${from} AND kind = ?${at}`,
	};
})();

/** Up to `limit` records of `scope` live at `at` with ids above `after`, by id. */
export async function listDocuments(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentRecord[]> {
	const { owner, namespace, kind } = scope;
	let rows: RecordRow[];
	if (kind === undefined) {
		rows =
			at === "current"
				? await executor.all<RecordRow>(LIST.current, owner, namespace, after, limit)
				: await executor.all<RecordRow>(LIST.at, owner, namespace, after, at, at, limit);
	} else {
		rows =
			at === "current"
				? await executor.all<RecordRow>(LIST.kindCurrent, owner, namespace, after, kind, limit)
				: await executor.all<RecordRow>(LIST.kindAt, owner, namespace, after, kind, at, at, limit);
	}
	return rows.map(recordOf);
}

/** The statements of `listDocumentEntries`, by shape, as `LIST`'s. */
const LIST_ENTRIES = (() => {
	const from = (columns: string) =>
		`SELECT ${columns} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND id > ?`;
	const current = " AND retired_at IS NULL ORDER BY id LIMIT ?";
	const at = " AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY id LIMIT ?";
	return {
		current: `${from("meta")}${current}`,
		at: `${from("meta, retired_at")}${at}`,
		kindCurrent: `${from("meta")} AND kind = ?${current}`,
		kindAt: `${from("meta, retired_at")} AND kind = ?${at}`,
	};
})();

/** `listDocuments` reading only what an adapter keeping its fields in `meta` needs. */
export function listDocumentEntries(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentEntry[]> {
	const { owner, namespace, kind } = scope;
	if (kind === undefined) {
		return at === "current"
			? executor.all<DocumentEntry>(LIST_ENTRIES.current, owner, namespace, after, limit)
			: executor.all<DocumentEntry>(LIST_ENTRIES.at, owner, namespace, after, at, at, limit);
	}
	return at === "current"
		? executor.all<DocumentEntry>(LIST_ENTRIES.kindCurrent, owner, namespace, after, kind, limit)
		: executor.all<DocumentEntry>(LIST_ENTRIES.kindAt, owner, namespace, after, kind, at, at, limit);
}

/** Up to `limit` stored records, live and retired, with ids above `after`, by id (an export's pages). */
export async function listRecords(executor: SqliteExecutor, after: number, limit: number): Promise<DocumentRecord[]> {
	const rows = await executor.all<RecordRow>(
		`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id > ? ORDER BY id LIMIT ?`,
		after,
		limit,
	);
	return rows.map(recordOf);
}

/** Up to `limit` stored revisions of document `id` after seq `after`, in seq order (an export's page). */
export async function listRevisions(
	executor: SqliteExecutor,
	id: number,
	after: number,
	limit: number,
): Promise<DocumentRevision[]> {
	const rows = await executor.all<RevisionRow>(
		`SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
		id,
		after,
		limit,
	);
	return rows.map(({ seq, kind, version, content }) => {
		// Written by `insertRevision`: a base's value or a delta's ops, as JSON.
		const parsed = JSON.parse(content) as unknown;
		return {
			id,
			seq,
			content:
				kind === "base"
					? { kind, version, value: parsed as JsonValue }
					: { kind, version, ops: parsed as readonly Op[] },
		};
	});
}

function recordOf(row: RecordRow): DocumentRecord {
	const { id, namespace, owner, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint } =
		row;
	return {
		id,
		owner,
		namespace,
		kind,
		...(key === "" ? {} : { key }),
		history,
		createdAt: created_at,
		...(retired_at === null ? {} : { retiredAt: retired_at }),
		...(meta === null ? {} : { meta }),
		revision,
		version,
		fingerprint,
	};
}
