import type { Entry, EntryOrder } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";

export interface EntryRow {
	session_id: string;
	seq: number;
	id: string;
	parent_id: string | null;
	type: Entry["type"];
	timestamp: string;
	payload: string;
}

export interface NewEntryRow {
	seq: number;
	id: string;
	parentId: string | null;
	type: Entry["type"];
	timestamp: string;
	payload: string;
}

export function entryPayload(entry: Entry): Record<string, unknown> {
	const { type: _type, id: _id, seq: _seq, parentId: _parentId, timestamp: _timestamp, ...payload } = entry;
	return payload;
}

function orderedSql(order: EntryOrder | undefined): string {
	return order === "oldestFirst" ? "ASC" : "DESC";
}

export function insertEntryRow(db: SqliteDatabase, sessionId: string, entry: NewEntryRow) {
	db.prepare(
		"INSERT INTO entries (session_id, id, seq, parent_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(sessionId, entry.id, entry.seq, entry.parentId, entry.type, entry.timestamp, entry.payload);
}

export function readEntryRow(db: SqliteDatabase, sessionId: string, entryId: string) {
	return db
		.prepare(
			"SELECT session_id, seq, id, parent_id, type, timestamp, payload FROM entries WHERE session_id = ? AND id = ?",
		)
		.get<EntryRow>(sessionId, entryId);
}

export function readEntryRows(
	db: SqliteDatabase,
	sessionId: string,
	options: { afterSeq?: number; order?: EntryOrder } = {},
) {
	const predicates = ["session_id = ?"];
	const params: unknown[] = [sessionId];
	if (options.afterSeq !== undefined) {
		predicates.push("seq > ?");
		params.push(options.afterSeq);
	}
	return db
		.prepare(
			`SELECT session_id, seq, id, parent_id, type, timestamp, payload
			FROM entries
			WHERE ${predicates.join(" AND ")}
			ORDER BY seq ${orderedSql(options.order)}`,
		)
		.all<EntryRow>(...params);
}

export function idExistsInEntries(db: SqliteDatabase, sessionId: string, id: string) {
	return !!db
		.prepare("SELECT 1 AS found FROM entries WHERE session_id = ? AND id = ? LIMIT 1")
		.get<{ found: number }>(sessionId, id);
}

export function deleteEntryRows(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);
}
