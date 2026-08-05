import type { SqliteDatabase } from "../types.ts";

export interface RecordRow {
	session_id: string;
	seq: number;
	id: string;
	lane: string;
	run_id: string | null;
	type: string;
	op_kind: string | null;
	timestamp: string;
	payload: string;
}

export interface NewRecordRow {
	seq: number;
	id: string;
	lane: string;
	runId?: string;
	type: string;
	opKind?: string;
	timestamp: string;
	payload: string;
}

export function appendRecordRow(db: SqliteDatabase, sessionId: string, record: NewRecordRow) {
	db.prepare(
		`INSERT INTO records
			(session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sessionId,
		record.seq,
		record.id,
		record.lane,
		record.runId ?? null,
		record.type,
		record.opKind ?? null,
		record.timestamp,
		record.payload,
	);
}

export function idExistsInRecords(db: SqliteDatabase, sessionId: string, id: string) {
	return !!db
		.prepare("SELECT 1 AS found FROM records WHERE session_id = ? AND id = ? LIMIT 1")
		.get<{ found: number }>(sessionId, id);
}

export function deleteRecordRows(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM records WHERE session_id = ?").run(sessionId);
}

export function readRecordRows(
	db: SqliteDatabase,
	sessionId: string,
	query: {
		lane?: string;
		type?: string;
		runId?: string;
		afterSeq?: number;
		order?: "newestFirst" | "oldestFirst";
		limit?: number;
	} = {},
) {
	const predicates = ["session_id = ?"];
	const params: unknown[] = [sessionId];
	if (query.lane !== undefined) {
		predicates.push("lane = ?");
		params.push(query.lane);
	}
	if (query.type !== undefined) {
		predicates.push("type = ?");
		params.push(query.type);
	}
	if (query.runId !== undefined) {
		predicates.push("run_id = ?");
		params.push(query.runId);
	}
	if (query.afterSeq !== undefined) {
		predicates.push("seq > ?");
		params.push(query.afterSeq);
	}
	const limit = query.limit === undefined ? "" : " LIMIT ?";
	if (query.limit !== undefined) params.push(query.limit);
	const direction = query.order === "oldestFirst" ? "ASC" : "DESC";
	return db
		.prepare(
			`SELECT session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload
			FROM records
			WHERE ${predicates.join(" AND ")}
			ORDER BY seq ${direction}${limit}`,
		)
		.all<RecordRow>(...params);
}
