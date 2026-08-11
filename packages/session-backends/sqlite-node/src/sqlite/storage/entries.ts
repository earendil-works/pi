import type { Entry, EntryOrder } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface EntryRow {
	session_id: string;
	seq: number;
	id: string;
	parent_id: string | null;
	type: Entry["type"];
	timestamp: number;
	payload: string;
}

export interface NewEntryRow {
	seq: number;
	id: string;
	parentId: string | null;
	type: Entry["type"];
	timestamp: number;
	payload: string;
}

export function entryPayload(entry: Entry): Record<string, unknown> {
	const { type: _type, id: _id, seq: _seq, parentId: _parentId, timestamp: _timestamp, ...payload } = entry;
	return payload;
}

export function insertEntryRow(db: SqliteDatabase, sessionId: string, entry: NewEntryRow) {
	sql`INSERT INTO entries (session_id, id, seq, parent_id, type, timestamp, payload)
		VALUES (${sessionId}, ${entry.id}, ${entry.seq}, ${entry.parentId}, ${entry.type}, ${entry.timestamp}, ${entry.payload})`.run(
		db,
	);
}

export function readEntryRow(db: SqliteDatabase, sessionId: string, entryId: string) {
	return sql`SELECT session_id, seq, id, parent_id, type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId} AND id = ${entryId}`.get<EntryRow>(db);
}

export function readEntryRows(
	db: SqliteDatabase,
	sessionId: string,
	options: {
		afterSeq?: number;
		cursor?: { afterSeq: number };
		type?: Entry["type"];
		order?: EntryOrder;
		limit?: number;
	} = {},
) {
	const oldestFirst = options.order === "oldestFirst";
	const after = options.afterSeq === undefined ? sql`` : sql` AND seq > ${options.afterSeq}`;
	const cursor =
		options.cursor === undefined
			? sql``
			: oldestFirst
				? sql` AND seq > ${options.cursor.afterSeq}`
				: sql` AND seq < ${options.cursor.afterSeq}`;
	const type = options.type === undefined ? sql`` : sql` AND type = ${options.type}`;
	const direction = oldestFirst ? sql`ASC` : sql`DESC`;
	const limit = options.limit === undefined ? sql`` : sql` LIMIT ${options.limit}`;
	return sql`SELECT session_id, seq, id, parent_id, type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId}${after}${cursor}${type}
		ORDER BY seq ${direction}${limit}`.all<EntryRow>(db);
}

export function idExistsInEntries(db: SqliteDatabase, sessionId: string, id: string) {
	return !!sql`SELECT 1 AS found FROM entries WHERE session_id = ${sessionId} AND id = ${id} LIMIT 1`.get<{
		found: number;
	}>(db);
}

export function deleteEntryRows(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM entries WHERE session_id = ${sessionId}`.run(db);
}
