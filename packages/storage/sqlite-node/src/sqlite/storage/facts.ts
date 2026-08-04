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
	db.prepare("INSERT INTO facts (session_id, seq, kind, key, value) VALUES (?, ?, ?, ?, ?)").run(
		sessionId,
		seq,
		kind,
		key,
		value,
	);
}

export function readLatestFact(db: SqliteDatabase, sessionId: string, kind: string, key: string | null) {
	return db
		.prepare(
			`SELECT session_id, seq, kind, key, value
			FROM facts
			WHERE session_id = ? AND kind = ? AND key IS ?
			ORDER BY seq DESC
			LIMIT 1`,
		)
		.get<FactRow>(sessionId, kind, key);
}

export function readLatestLabelFacts(db: SqliteDatabase, sessionId: string) {
	return db
		.prepare(
			`SELECT key, value FROM (
				SELECT key, value, ROW_NUMBER() OVER (PARTITION BY key ORDER BY seq DESC) AS rank
				FROM facts
				WHERE session_id = ? AND kind = 'label'
			)
			WHERE rank = 1 AND value IS NOT NULL
			ORDER BY key`,
		)
		.all<{ key: string; value: string }>(sessionId);
}

export function readFactRows(db: SqliteDatabase, sessionId: string, options: { afterSeq?: number } = {}) {
	const predicates = ["session_id = ?"];
	const params: unknown[] = [sessionId];
	if (options.afterSeq !== undefined) {
		predicates.push("seq > ?");
		params.push(options.afterSeq);
	}
	return db
		.prepare(
			`SELECT session_id, seq, kind, key, value
			FROM facts
			WHERE ${predicates.join(" AND ")}
			ORDER BY seq`,
		)
		.all<FactRow>(...params);
}

export function deleteFactRows(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM facts WHERE session_id = ?").run(sessionId);
}
