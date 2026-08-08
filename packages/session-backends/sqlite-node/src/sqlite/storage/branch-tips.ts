import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export function readBranchTipIds(db: SqliteDatabase, sessionId: string) {
	return sql`SELECT tip_id FROM branch_tips WHERE session_id = ${sessionId} ORDER BY tip_id`
		.all<{ tip_id: string }>(db)
		.map((row) => row.tip_id);
}

export function readBranchTipBranchId(db: SqliteDatabase, sessionId: string, tipId: string) {
	const tip = sql`SELECT branch_id FROM branch_tips WHERE session_id = ${sessionId} AND tip_id = ${tipId}`.get<{
		branch_id: string;
	}>(db);
	return tip?.branch_id;
}

export function insertBranchTip(db: SqliteDatabase, sessionId: string, tipId: string, branchId: string) {
	sql`INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (${sessionId}, ${tipId}, ${branchId})`.run(db);
}

export function updateBranchTip(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	oldTipId: string,
	newTipId: string,
) {
	const result = sql`UPDATE branch_tips SET tip_id = ${newTipId}
		WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND tip_id = ${oldTipId}`.run(db);
	return result.changes === 1;
}

export function deleteBranchTips(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM branch_tips WHERE session_id = ${sessionId}`.run(db);
}
