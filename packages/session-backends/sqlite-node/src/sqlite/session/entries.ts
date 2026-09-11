import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	Entry,
	EntryScan,
	EntryStructure,
	MessageEntry,
} from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase, SqliteStatement } from "../types.ts";

export interface EntryRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
	payload: string;
}

type StoredEntryPayload<TEntry extends Entry> = Omit<
	TEntry,
	"id" | "parentId" | "seq" | "timestamp" | "type" | "customType"
>;

function entryPayload(entry: Entry): StoredEntryPayload<Entry> {
	switch (entry.type) {
		case "message": {
			const payload: StoredEntryPayload<MessageEntry> = {
				message: entry.message,
				...(entry.terminate === undefined ? {} : { terminate: entry.terminate }),
			};
			return payload;
		}
		case "compaction": {
			const payload: StoredEntryPayload<CompactionEntry> = {
				summary: entry.summary,
				retainedTail: entry.retainedTail,
				tokensBefore: entry.tokensBefore,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "branch_summary": {
			const payload: StoredEntryPayload<BranchSummaryEntry> = {
				fromId: entry.fromId,
				summary: entry.summary,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "custom": {
			const payload: StoredEntryPayload<CustomEntry> = entry.data === undefined ? {} : { data: entry.data };
			return payload;
		}
	}
}

function parsePayload<TEntry extends Entry>(row: EntryRow): StoredEntryPayload<TEntry> {
	return JSON.parse(row.payload) as StoredEntryPayload<TEntry>;
}

const INSERT_ENTRY_SQL = `INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function entryRowParams(sessionId: string, entry: Entry): unknown[] {
	return [
		sessionId,
		entry.id,
		entry.parentId,
		entry.seq,
		entry.type,
		entry.type === "custom" ? entry.customType : null,
		entry.timestamp,
		JSON.stringify(entryPayload(entry)),
	];
}

export class EntryRowWriter {
	private readonly insertStatement: SqliteStatement;
	private readonly sessionId: string;

	constructor(db: SqliteDatabase, sessionId: string) {
		this.insertStatement = db.prepare(INSERT_ENTRY_SQL);
		this.sessionId = sessionId;
	}

	insert(entry: Entry): void {
		this.insertStatement.run(...entryRowParams(this.sessionId, entry));
	}
}

export function insertEntryRow(db: SqliteDatabase, sessionId: string, entry: Entry): void {
	db.prepare(INSERT_ENTRY_SQL).run(...entryRowParams(sessionId, entry));
}

export function decodeEntryRow(row: EntryRow): Entry {
	const base = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
	};
	switch (row.type) {
		case "message":
			return { ...base, type: "message", ...parsePayload<MessageEntry>(row) };
		case "compaction":
			return { ...base, type: "compaction", ...parsePayload<CompactionEntry>(row) };
		case "branch_summary":
			return { ...base, type: "branch_summary", ...parsePayload<BranchSummaryEntry>(row) };
		case "custom":
			if (row.custom_type === null) throw new Error(`Custom entry ${row.id} is missing custom_type`);
			return { ...base, type: "custom", customType: row.custom_type, ...parsePayload<CustomEntry>(row) };
	}
}

export function entryStructureFromRow(row: EntryRow): EntryStructure {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	};
}

export function readEntryRows(db: SqliteDatabase, sessionId: string, ids: readonly string[]): EntryRow[] {
	if (ids.length === 0) return [];
	const placeholders = joinSqlFragments(
		ids.map((id) => sql`${id}`),
		", ",
	);
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId} AND id IN (${placeholders})`.all<EntryRow>(db);
}

export function readAllEntryRows(db: SqliteDatabase, sessionId: string): EntryRow[] {
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`.all<EntryRow>(db);
}

export function scanEntryRows(db: SqliteDatabase, sessionId: string, query: EntryScan): EntryRow[] {
	const filters: SqlQuery[] = [sql`session_id = ${sessionId}`];
	if (query.type !== undefined) filters.push(sql`type = ${query.type}`);
	if (query.customType !== undefined) filters.push(sql`custom_type = ${query.customType}`);
	if (query.fromSeq !== undefined) filters.push(sql`seq >= ${query.fromSeq}`);
	if (query.toSeq !== undefined) filters.push(sql`seq <= ${query.toSeq}`);

	const order = query.order === "desc" ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`;
	const limit = query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`;
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE ${joinSqlFragments(filters, " AND ")} ${order} ${limit}`.all<EntryRow>(db);
}
