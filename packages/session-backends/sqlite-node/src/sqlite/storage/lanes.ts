import { SessionError } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface LaneRow {
	session_id: string;
	lane: string;
	leaf_id: string | null;
	open_operation_id: string | null;
}

export interface LaneMoveRow {
	session_id: string;
	seq: number;
	lane: string;
	leaf_id: string | null;
}

export function createInitialLane(db: SqliteDatabase, sessionId: string, lane = "main", leafId: string | null = null) {
	sql`INSERT INTO lanes (session_id, lane, leaf_id, open_operation_id)
		VALUES (${sessionId}, ${lane}, ${leafId}, NULL)`.run(db);
}

export function readLanes(db: SqliteDatabase, sessionId: string) {
	const rows = sql`SELECT
			l.session_id,
			l.lane,
			l.leaf_id,
			l.open_operation_id,
			(l.leaf_id IS NULL OR EXISTS (
				SELECT 1 FROM entries AS e WHERE e.session_id = l.session_id AND e.id = l.leaf_id
			)) AS leaf_exists
		FROM lanes AS l
		WHERE l.session_id = ${sessionId}
		ORDER BY l.lane`.all<LaneRow & { leaf_exists: number }>(db);
	for (const row of rows) {
		if (row.leaf_exists === 0) {
			throw new SessionError("storage", `Lane ${row.lane} points at missing entry ${row.leaf_id}`);
		}
	}
	return rows.map(({ session_id, lane, leaf_id, open_operation_id }) => ({
		session_id,
		lane,
		leaf_id,
		open_operation_id,
	}));
}

export function readLane(db: SqliteDatabase, sessionId: string, lane: string) {
	return sql`SELECT session_id, lane, leaf_id, open_operation_id
		FROM lanes
		WHERE session_id = ${sessionId} AND lane = ${lane}`.get<LaneRow>(db);
}

export function readLaneHead(db: SqliteDatabase, sessionId: string, lane: string) {
	const row = sql`SELECT
			l.leaf_id,
			(l.leaf_id IS NULL OR EXISTS (
				SELECT 1 FROM entries AS e WHERE e.session_id = l.session_id AND e.id = l.leaf_id
			)) AS leaf_exists
		FROM lanes AS l
		WHERE l.session_id = ${sessionId} AND l.lane = ${lane}`.get<{
		leaf_id: string | null;
		leaf_exists: number;
	}>(db);
	if (!row) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
	if (row.leaf_exists === 0) throw new SessionError("storage", `Entry ${row.leaf_id} not found`);
	return { leafId: row.leaf_id };
}

export function createLane(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	sql`INSERT INTO lanes (session_id, lane, leaf_id, open_operation_id)
		VALUES (${sessionId}, ${lane}, ${leafId}, NULL)`.run(db);
	appendLaneMove(db, sessionId, seq, lane, leafId);
}

export function moveLane(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	const result = sql`UPDATE lanes SET leaf_id = ${leafId} WHERE session_id = ${sessionId} AND lane = ${lane}`.run(db);
	if (result.changes !== 1) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
	appendLaneMove(db, sessionId, seq, lane, leafId);
}

export function setLaneLeaf(db: SqliteDatabase, sessionId: string, lane: string, leafId: string | null) {
	const result = sql`UPDATE lanes SET leaf_id = ${leafId} WHERE session_id = ${sessionId} AND lane = ${lane}`.run(db);
	if (result.changes !== 1) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
}

export function startLaneOperation(db: SqliteDatabase, sessionId: string, lane: string, runId: string) {
	const result = sql`UPDATE lanes SET open_operation_id = ${runId}
		WHERE session_id = ${sessionId} AND lane = ${lane} AND open_operation_id IS NULL`.run(db);
	if (result.changes === 1) return;
	const current = readLane(db, sessionId, lane);
	if (!current) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
	throw new SessionError("storage", `Lane ${lane} already has an open operation ${current.open_operation_id}`);
}

export function finishLaneOperation(db: SqliteDatabase, sessionId: string, lane: string, runId: string) {
	sql`UPDATE lanes SET open_operation_id = NULL
		WHERE session_id = ${sessionId} AND lane = ${lane} AND open_operation_id = ${runId}`.run(db);
}

export function readLaneMoveRows(
	db: SqliteDatabase,
	sessionId: string,
	options: { afterSeq?: number; limit?: number } = {},
) {
	const after = options.afterSeq === undefined ? sql`` : sql` AND seq > ${options.afterSeq}`;
	const limit = options.limit === undefined ? sql`` : sql` LIMIT ${options.limit}`;
	return sql`SELECT session_id, seq, lane, leaf_id
		FROM lane_moves
		WHERE session_id = ${sessionId}${after}
		ORDER BY seq${limit}`.all<LaneMoveRow>(db);
}

export function deleteLaneRows(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM lane_moves WHERE session_id = ${sessionId}`.run(db);
	sql`DELETE FROM lanes WHERE session_id = ${sessionId}`.run(db);
}

function appendLaneMove(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	sql`INSERT INTO lane_moves (session_id, seq, lane, leaf_id) VALUES (${sessionId}, ${seq}, ${lane}, ${leafId})`.run(
		db,
	);
}
