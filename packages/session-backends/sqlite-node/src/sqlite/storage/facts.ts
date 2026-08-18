import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface FactRow {
	session_id: string;
	seq: number;
	kind: string;
	key: string | null;
	value: string | null;
}

export function appendFact(
	db: SqliteDatabase,
	sessionId: string,
	seq: number,
	kind: string,
	key: string | null,
	value: string | null,
) {
	sql`INSERT INTO facts (session_id, seq, kind, key, value) VALUES (${sessionId}, ${seq}, ${kind}, ${key}, ${value})`.run(
		db,
	);
}

export function readLatestFact(db: SqliteDatabase, sessionId: string, kind: string, key: string | null) {
	return sql`SELECT session_id, seq, kind, key, value
		FROM facts INDEXED BY idx_facts_session_kind_key_seq
		WHERE session_id = ${sessionId} AND kind = ${kind} AND key IS ${key}
		ORDER BY seq DESC
		LIMIT 1`.get<FactRow>(db);
}

export function readLatestLabelFacts(db: SqliteDatabase, sessionId: string) {
	return sql`SELECT f.key, f.value
		FROM facts AS f INDEXED BY idx_facts_session_kind_key_seq
		WHERE f.session_id = ${sessionId}
			AND f.kind = 'label'
			AND f.value IS NOT NULL
			AND f.seq = (
				SELECT MAX(candidate.seq)
				FROM facts AS candidate INDEXED BY idx_facts_session_kind_key_seq
				WHERE candidate.session_id = f.session_id
					AND candidate.kind = f.kind
					AND candidate.key IS f.key
			)
		ORDER BY f.key`.all<{ key: string; value: string }>(db);
}

export function readFactRows(
	db: SqliteDatabase,
	sessionId: string,
	options: { afterSeq?: number; limit?: number } = {},
) {
	const after = options.afterSeq === undefined ? sql`` : sql` AND seq > ${options.afterSeq}`;
	const limit = options.limit === undefined ? sql`` : sql` LIMIT ${options.limit}`;
	return sql`SELECT session_id, seq, kind, key, value
		FROM facts
		WHERE session_id = ${sessionId}${after}
		ORDER BY seq${limit}`.all<FactRow>(db);
}

export function deleteFactRows(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM facts WHERE session_id = ${sessionId}`.run(db);
}
