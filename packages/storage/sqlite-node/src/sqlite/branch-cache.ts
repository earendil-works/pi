import { SessionError } from "@earendil-works/pi-agent-core/experimental";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	copyBranchEntriesThroughSeq,
	deleteBranchEntries,
	insertBranchEntriesForPath,
	insertBranchEntry,
	readBranchContainingEntry,
} from "./storage/branch-entries.ts";

import { deleteBranchTips, insertBranchTip, readBranchTipBranchId, updateBranchTip } from "./storage/branch-tips.ts";
import type { SqliteDatabase } from "./types.ts";

export async function deleteBranchCache(db: SqliteDatabase, sessionId: string): Promise<void> {
	await deleteBranchTips(db, sessionId);
	await deleteBranchEntries(db, sessionId);
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
		await insertBranchEntriesForPath(db, sessionId, branchId, leafId);
		await insertBranchTip(db, sessionId, leafId, branchId);
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
	if (!(await updateBranchTip(db, sessionId, branchId, parentId, entryId))) {
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
		await insertBranchTip(db, sessionId, entryId, branchId);
		return;
	}

	const tipBranchId = await readBranchTipBranchId(db, sessionId, parentId);
	if (tipBranchId !== undefined) {
		await extendBranch(db, sessionId, tipBranchId, parentId, entryId, entrySeq, entryType, customType);
		return;
	}

	const source = await readBranchContainingEntry(db, sessionId, parentId);
	if (!source) {
		throw new SessionError("invalid_entry", `Branch cache has no branch containing parent entry ${parentId}`);
	}

	const branchId = uuidv7();
	await copyBranchEntriesThroughSeq(db, sessionId, branchId, source.branchId, source.entrySeq);
	await insertBranchEntry(db, sessionId, branchId, entryId, entrySeq, entryType, customType);
	await insertBranchTip(db, sessionId, entryId, branchId);
}
