import type { SqliteDatabase } from "../types.ts";

export function readBranchTipIds(db: SqliteDatabase, sessionId: string) {
	return db
		.prepare("SELECT tip_id FROM branch_tips WHERE session_id = ? ORDER BY tip_id")
		.all<{ tip_id: string }>(sessionId)
		.map((row) => row.tip_id);
}

export function readBranchTipBranchId(db: SqliteDatabase, sessionId: string, tipId: string) {
	const tip = db
		.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
		.get<{ branch_id: string }>(sessionId, tipId);
	return tip?.branch_id;
}

export function insertBranchTip(db: SqliteDatabase, sessionId: string, tipId: string, branchId: string) {
	db.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)").run(
		sessionId,
		tipId,
		branchId,
	);
}

export function updateBranchTip(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	oldTipId: string,
	newTipId: string,
) {
	const result = db
		.prepare("UPDATE branch_tips SET tip_id = ? WHERE session_id = ? AND branch_id = ? AND tip_id = ?")
		.run(newTipId, sessionId, branchId, oldTipId);
	return result.changes === 1;
}

export function deleteBranchTips(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run(sessionId);
}
