import { type Entry, SessionError } from "@earendil-works/pi-agent-core/experimental";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "../types.ts";

/** Derived root-to-tip paths. Canonical parent links remain authoritative. */
export interface CachedBranch {
	branchId: string;
	leafSeq: number;
}

export interface CachedBranchEntryRow {
	session_id: string;
	id: string;
	entry_seq: number;
	parent_id: string | null;
	type: Entry["type"];
	timestamp: string;
	payload: string;
}

export interface CachedBranchQuery {
	stopAtType?: Entry["type"];
	stopAtId?: string;
	order?: "newestFirst" | "oldestFirst";
}

export async function readCachedBranch(
	db: SqliteDatabase,
	sessionId: string,
	leafId: string,
): Promise<CachedBranch | undefined> {
	const membership = await db
		.prepare(
			"SELECT branch_id, entry_seq FROM branch_entries WHERE session_id = ? AND entry_id = ? ORDER BY branch_id LIMIT 1",
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, leafId);
	if (!membership) return undefined;
	return { branchId: membership.branch_id, leafSeq: membership.entry_seq };
}

export async function queryCachedBranchRows(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	query: CachedBranchQuery,
): Promise<CachedBranchEntryRow[]> {
	const oldestFirst = query.order === "oldestFirst";
	const boundaryParams: unknown[] = [sessionId, branch.branchId, branch.leafSeq];
	const stopPredicates: string[] = [];
	if (query.stopAtType !== undefined) {
		stopPredicates.push("stop_entry.type = ?");
		boundaryParams.push(query.stopAtType);
	}
	if (query.stopAtId !== undefined) {
		stopPredicates.push("stop.entry_id = ?");
		boundaryParams.push(query.stopAtId);
	}

	const boundary = stopPredicates.length
		? `WITH boundary AS (
			SELECT ${oldestFirst ? "MIN" : "MAX"}(stop.entry_seq) AS entry_seq
			FROM branch_entries AS stop
			JOIN entries AS stop_entry
				ON stop_entry.session_id = stop.session_id AND stop_entry.id = stop.entry_id
			WHERE stop.session_id = ? AND stop.branch_id = ? AND stop.entry_seq <= ?
				AND (${stopPredicates.join(" OR ")})
		)`
		: "";
	const range = stopPredicates.length
		? `AND b.entry_seq ${oldestFirst ? "<=" : ">="} COALESCE(
			(SELECT entry_seq FROM boundary), ${oldestFirst ? branch.leafSeq : 0}
		)`
		: "";
	const sql = `${boundary}
		SELECT e.session_id, e.id, e.seq AS entry_seq, e.parent_id, e.type, e.timestamp, e.payload
		FROM branch_entries AS b
		JOIN entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq <= ?
			${range}
		ORDER BY b.entry_seq ${oldestFirst ? "ASC" : "DESC"}`;

	const params = [...(stopPredicates.length === 0 ? [] : boundaryParams), sessionId, branch.branchId, branch.leafSeq];
	return db.prepare(sql).all<CachedBranchEntryRow>(...params);
}

export async function readBranchTipIds(db: SqliteDatabase, sessionId: string): Promise<string[]> {
	return (
		await db
			.prepare("SELECT tip_id FROM branch_tips WHERE session_id = ? ORDER BY tip_id")
			.all<{ tip_id: string }>(sessionId)
	).map((row) => row.tip_id);
}

export async function deleteBranchCache(db: SqliteDatabase, sessionId: string): Promise<void> {
	await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run(sessionId);
	await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(sessionId);
}

export async function rebuildBranchCache(db: SqliteDatabase, sessionId: string): Promise<void> {
	const tips = await db
		.prepare(
			`SELECT leaf.id
			FROM entries AS leaf
			WHERE leaf.session_id = ?
				AND NOT EXISTS (
					SELECT 1 FROM entries AS child WHERE child.session_id = leaf.session_id AND child.parent_id = leaf.id
				)
			ORDER BY leaf.seq`,
		)
		.all<{ id: string }>(sessionId);
	await deleteBranchCache(db, sessionId);
	for (const tip of tips) await buildCachedBranch(db, sessionId, tip.id);
}

export async function buildCachedBranch(db: SqliteDatabase, sessionId: string, leafId: string): Promise<void> {
	await db.exec("SAVEPOINT build_branch_cache");
	try {
		const branchId = uuidv7();
		await db
			.prepare(
				`WITH RECURSIVE path(id, entry_seq, parent_id, type, custom_type) AS (
					SELECT id, seq, parent_id, type,
						CASE WHEN type = 'custom' THEN json_extract(payload, '$.customType') ELSE NULL END
					FROM entries
					WHERE session_id = ? AND id = ?
					UNION ALL
					SELECT parent.id, parent.seq, parent.parent_id, parent.type,
						CASE WHEN parent.type = 'custom' THEN json_extract(parent.payload, '$.customType') ELSE NULL END
					FROM entries AS parent
					JOIN path AS child ON child.parent_id = parent.id
					WHERE parent.session_id = ?
				)
				INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
				SELECT ?, ?, id, entry_seq, type, custom_type FROM path`,
			)
			.run(sessionId, leafId, sessionId, sessionId, branchId);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, leafId, branchId);
		await db.exec("RELEASE SAVEPOINT build_branch_cache");
	} catch (error) {
		try {
			await db.exec("ROLLBACK TO SAVEPOINT build_branch_cache");
			await db.exec("RELEASE SAVEPOINT build_branch_cache");
		} catch {
			// Preserve the original build failure.
		}
		if (error instanceof SessionError) throw error;
		throw new SessionError(
			"storage",
			`Failed to build SQLite branch cache at entry ${leafId}`,
			error instanceof Error ? error : undefined,
		);
	}
}

async function insertBranchEntry(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO branch_entries
			(session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(sessionId, branchId, entryId, entrySeq, entryType, customType);
}

async function extendBranch(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	parentId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
): Promise<void> {
	await insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
	const result = await db
		.prepare("UPDATE branch_tips SET tip_id = ? WHERE session_id = ? AND branch_id = ? AND tip_id = ?")
		.run(entryId, sessionId, branchId, parentId);
	if (result.changes !== 1) {
		throw new SessionError("invalid_entry", `Branch tip ${parentId} changed during append`);
	}
}

export async function appendEntryToBranchCache(
	db: SqliteDatabase,
	sessionId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
	parentId: string | null,
): Promise<void> {
	if (parentId === null) {
		const branchId = uuidv7();
		await insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, entryId, branchId);
		return;
	}

	const tip = await db
		.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
		.get<{ branch_id: string }>(sessionId, parentId);
	if (tip) {
		await extendBranch(db, sessionId, tip.branch_id, parentId, entryId, entrySeq, entryType, customType);
		return;
	}

	const source = await db
		.prepare(
			`SELECT b.branch_id, b.entry_seq
			FROM branch_entries AS b
			WHERE b.session_id = ? AND b.entry_id = ?
			ORDER BY b.branch_id
			LIMIT 1`,
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, parentId);
	if (!source) {
		throw new SessionError("invalid_entry", `Branch cache has no branch containing parent entry ${parentId}`);
	}

	const branchId = uuidv7();
	await db
		.prepare(
			`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
			SELECT session_id, ?, entry_id, entry_seq, entry_type, custom_type
			FROM branch_entries
			WHERE session_id = ? AND branch_id = ? AND entry_seq <= ?`,
		)
		.run(branchId, sessionId, source.branch_id, source.entry_seq);
	await insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
	await db
		.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
		.run(sessionId, entryId, branchId);
}
