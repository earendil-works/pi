import { SessionError } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, sql } from "../sql.ts";
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
	sql`INSERT INTO records
			(session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload)
			VALUES (${sessionId}, ${record.seq}, ${record.id}, ${record.lane}, ${record.runId ?? null}, ${record.type}, ${record.opKind ?? null}, ${record.timestamp}, ${record.payload})`.run(
		db,
	);
}

export function idExistsInRecords(db: SqliteDatabase, sessionId: string, id: string) {
	return !!sql`SELECT 1 AS found FROM records WHERE session_id = ${sessionId} AND id = ${id} LIMIT 1`.get<{
		found: number;
	}>(db);
}

export function deleteRecordRows(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM records WHERE session_id = ${sessionId}`.run(db);
}

export function readRecordRows(
	db: SqliteDatabase,
	sessionId: string,
	query: {
		lane?: string;
		type?: string;
		runId?: string;
		operationKind?: string;
		afterSeq?: number;
		order?: "newestFirst" | "oldestFirst";
		limit?: number;
	} = {},
) {
	const predicates = [sql`session_id = ${sessionId}`];
	if (query.lane !== undefined) predicates.push(sql`lane = ${query.lane}`);
	if (query.type !== undefined) predicates.push(sql`type = ${query.type}`);
	if (query.runId !== undefined) predicates.push(sql`run_id = ${query.runId}`);
	if (query.operationKind !== undefined) predicates.push(sql`op_kind = ${query.operationKind}`);
	if (query.afterSeq !== undefined) predicates.push(sql`seq > ${query.afterSeq}`);
	const direction = query.order === "oldestFirst" ? sql`ASC` : sql`DESC`;
	const limit = query.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;
	return sql`SELECT session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload
		FROM records
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY seq ${direction}${limit}`.all<RecordRow>(db);
}

export function readOpenOperationRows(
	db: SqliteDatabase,
	sessionId: string,
	lane: string,
	_options: { limit?: number } = {},
): RecordRow[] {
	const laneRow = sql`SELECT open_operation_id FROM lanes WHERE session_id = ${sessionId} AND lane = ${lane}`.get<{
		open_operation_id: string | null;
	}>(db);
	if (!laneRow?.open_operation_id) return [];

	const record = sql`SELECT session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload
		FROM records
		WHERE session_id = ${sessionId}
			AND id = ${laneRow.open_operation_id}`.get<RecordRow>(db);
	if (!record) {
		throw new SessionError("storage", `Lane ${lane} points at missing open operation ${laneRow.open_operation_id}`);
	}
	if (record.lane !== lane || record.type !== "operation_started") {
		throw new SessionError("storage", `Lane ${lane} points at invalid open operation ${laneRow.open_operation_id}`);
	}
	return [record];
}
