import { SessionError } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { sql } from "./sql.ts";
import {
	copyBranchEntriesThroughSeq,
	deleteBranchEntries,
	insertBranchEntriesForPath,
	insertBranchEntry,
	readBranchContainingEntry,
} from "./storage/branch-entries.ts";
import { deleteBranchTips, insertBranchTip, readBranchTipBranchId, updateBranchTip } from "./storage/branch-tips.ts";
import type { SqliteDatabase } from "./types.ts";

export function deleteBranchCache(db: SqliteDatabase, sessionId: string) {
	deleteBranchTips(db, sessionId);
	deleteBranchEntries(db, sessionId);
}

export function rebuildBranchCache(db: SqliteDatabase, sessionId: string) {
	const tips = sql`SELECT leaf.id
		FROM entries AS leaf
		WHERE leaf.session_id = ${sessionId}
			AND NOT EXISTS (
				SELECT 1 FROM entries AS child WHERE child.session_id = leaf.session_id AND child.parent_id = leaf.id
			)
		ORDER BY leaf.seq`.all<{ id: string }>(db);
	deleteBranchCache(db, sessionId);
	for (const tip of tips) buildCachedBranch(db, sessionId, tip.id);
}

export function buildCachedBranch(db: SqliteDatabase, sessionId: string, leafId: string) {
	sql`SAVEPOINT build_branch_cache`.exec(db);
	try {
		const branchId = uuidv7();
		insertBranchEntriesForPath(db, sessionId, branchId, leafId);
		insertBranchTip(db, sessionId, leafId, branchId);
		sql`RELEASE SAVEPOINT build_branch_cache`.exec(db);
	} catch (error) {
		try {
			sql`ROLLBACK TO SAVEPOINT build_branch_cache`.exec(db);
			sql`RELEASE SAVEPOINT build_branch_cache`.exec(db);
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

function extendBranch(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	parentId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
) {
	insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
	if (!updateBranchTip(db, sessionId, branchId, parentId, entryId)) {
		throw new SessionError("invalid_entry", `Branch tip ${parentId} changed during append`);
	}
}

export function appendEntryToBranchCache(
	db: SqliteDatabase,
	sessionId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
	parentId: string | null,
) {
	if (parentId === null) {
		const branchId = uuidv7();
		insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
		insertBranchTip(db, sessionId, entryId, branchId);
		return;
	}

	const tipBranchId = readBranchTipBranchId(db, sessionId, parentId);
	if (tipBranchId !== undefined) {
		extendBranch(db, sessionId, tipBranchId, parentId, entryId, entrySeq, entryType, customType);
		return;
	}

	const source = readBranchContainingEntry(db, sessionId, parentId);
	if (!source) {
		throw new SessionError("invalid_entry", `Branch cache has no branch containing parent entry ${parentId}`);
	}

	const branchId = uuidv7();
	copyBranchEntriesThroughSeq(db, sessionId, branchId, source.branchId, source.entrySeq);
	insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
	insertBranchTip(db, sessionId, entryId, branchId);
}
