import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface SessionRow {
	id: string;
	created_at: number;
	parent_session_id: string | null;
	storage_version: number;
	metadata: string | null;
	message_count: number;
	usage_payload: string;
	next_seq: number;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	/** SQLite container/shard path containing this session. */
	path: string;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function readSessionRow(db: SqliteDatabase, sessionId: string): SessionRow {
	const row = sql`SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions
		WHERE id = ${sessionId}`.get<SessionRow>(db);
	if (row === undefined) throw new Error(`Unknown SQLite session: ${sessionId}`);
	return row;
}

export function readAllSessionRows(db: SqliteDatabase): SessionRow[] {
	return sql`SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions`.all<SessionRow>(db);
}

export function hasSessionRow(db: SqliteDatabase, sessionId: string): boolean {
	return sql`SELECT id FROM sessions WHERE id = ${sessionId}`.get<{ id: string }>(db) !== undefined;
}

export function metadataFromSessionRow(
	path: string,
	row: SessionRow,
	currentStorageVersion: number,
): SqliteSessionMetadata {
	if (row.storage_version > currentStorageVersion) {
		throw new Error(`SQLite session storage version ${row.storage_version} is newer than ${currentStorageVersion}`);
	}
	if (row.storage_version < currentStorageVersion) {
		throw new Error(`SQLite session storage version ${row.storage_version} requires migrations`);
	}
	return {
		id: row.id,
		createdAt: row.created_at,
		storageVersion: row.storage_version,
		...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
		path,
	};
}

export function insertSessionRow(
	db: SqliteDatabase,
	metadata: SqliteSessionMetadata,
	storageVersion: number,
	nextSeq: number,
): void {
	sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
		VALUES (
			${metadata.id},
			${metadata.createdAt},
			${metadata.parentSessionId ?? null},
			${storageVersion},
			${null},
			${0},
			${JSON.stringify(zeroUsage())},
			${nextSeq}
		)`.run(db);
}

export function deleteSessionRows(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM entries WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM scalar_values WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM list_values WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM usage_ledger WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM branch_entries WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM branch_meta WHERE session_id = ${sessionId}`.run(db);
	const result = sql`DELETE FROM sessions WHERE id = ${sessionId}`.run(db);
	if (result.changes !== 1)
		throw new Error(`Expected to delete one SQLite session ${sessionId}, deleted ${result.changes}`);
}
