import { SessionError } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";

export interface LaneRow {
	session_id: string;
	lane: string;
	leaf_id: string | null;
}

export interface LaneMoveRow {
	session_id: string;
	seq: number;
	lane: string;
	leaf_id: string | null;
}

export function createInitialLane(db: SqliteDatabase, sessionId: string, lane = "main", leafId: string | null = null) {
	db.prepare("INSERT INTO lanes (session_id, lane, leaf_id) VALUES (?, ?, ?)").run(sessionId, lane, leafId);
}

export function readLanes(db: SqliteDatabase, sessionId: string) {
	const rows = db
		.prepare(
			`SELECT
				l.session_id,
				l.lane,
				l.leaf_id,
				(l.leaf_id IS NULL OR EXISTS (
					SELECT 1 FROM entries AS e WHERE e.session_id = l.session_id AND e.id = l.leaf_id
				)) AS leaf_exists
			FROM lanes AS l
			WHERE l.session_id = ?
			ORDER BY l.lane`,
		)
		.all<LaneRow & { leaf_exists: number }>(sessionId);
	for (const row of rows) {
		if (row.leaf_exists === 0) {
			throw new SessionError("storage", `Lane ${row.lane} points at missing entry ${row.leaf_id}`);
		}
	}
	return rows.map(({ session_id, lane, leaf_id }) => ({ session_id, lane, leaf_id }));
}

export function readLane(db: SqliteDatabase, sessionId: string, lane: string) {
	return db
		.prepare("SELECT session_id, lane, leaf_id FROM lanes WHERE session_id = ? AND lane = ?")
		.get<LaneRow>(sessionId, lane);
}

export function readLaneHead(db: SqliteDatabase, sessionId: string, lane: string) {
	const row = db
		.prepare(
			`SELECT
				l.leaf_id,
				(l.leaf_id IS NULL OR EXISTS (
					SELECT 1 FROM entries AS e WHERE e.session_id = l.session_id AND e.id = l.leaf_id
				)) AS leaf_exists
			FROM lanes AS l
			WHERE l.session_id = ? AND l.lane = ?`,
		)
		.get<{ leaf_id: string | null; leaf_exists: number }>(sessionId, lane);
	if (!row) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
	if (row.leaf_exists === 0) throw new SessionError("storage", `Entry ${row.leaf_id} not found`);
	return { leafId: row.leaf_id };
}

export function createLane(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	db.prepare("INSERT INTO lanes (session_id, lane, leaf_id) VALUES (?, ?, ?)").run(sessionId, lane, leafId);
	appendLaneMove(db, sessionId, seq, lane, leafId);
}

export function moveLane(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	const result = db
		.prepare("UPDATE lanes SET leaf_id = ? WHERE session_id = ? AND lane = ?")
		.run(leafId, sessionId, lane);
	if (result.changes !== 1) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
	appendLaneMove(db, sessionId, seq, lane, leafId);
}

export function setLaneLeaf(db: SqliteDatabase, sessionId: string, lane: string, leafId: string | null) {
	const result = db
		.prepare("UPDATE lanes SET leaf_id = ? WHERE session_id = ? AND lane = ?")
		.run(leafId, sessionId, lane);
	if (result.changes !== 1) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
}

export function readLaneMoveRows(db: SqliteDatabase, sessionId: string, options: { afterSeq?: number } = {}) {
	const predicates = ["session_id = ?"];
	const params: unknown[] = [sessionId];
	if (options.afterSeq !== undefined) {
		predicates.push("seq > ?");
		params.push(options.afterSeq);
	}
	return db
		.prepare(
			`SELECT session_id, seq, lane, leaf_id
			FROM lane_moves
			WHERE ${predicates.join(" AND ")}
			ORDER BY seq`,
		)
		.all<LaneMoveRow>(...params);
}

export function deleteLaneRows(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM lane_moves WHERE session_id = ?").run(sessionId);
	db.prepare("DELETE FROM lanes WHERE session_id = ?").run(sessionId);
}

function appendLaneMove(db: SqliteDatabase, sessionId: string, seq: number, lane: string, leafId: string | null) {
	db.prepare("INSERT INTO lane_moves (session_id, seq, lane, leaf_id) VALUES (?, ?, ?, ?)").run(
		sessionId,
		seq,
		lane,
		leafId,
	);
}
