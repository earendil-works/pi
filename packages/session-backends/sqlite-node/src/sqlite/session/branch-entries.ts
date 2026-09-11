import type { Entry, EntryStructure, StorageBranchScan } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import { decodeEntryRow, type EntryRow } from "./entries.ts";

interface BranchMembershipRow {
	branch_id: string;
	entry_seq: number;
}

interface BranchMetaRow {
	branch_id: string;
	tip_entry_id: string;
	tip_seq: number;
	base_branch_id: string | null;
	base_seq: number | null;
}

interface BranchSegment {
	branchId: string;
	lowerSeq: number;
	upperSeq: number;
}

interface StopSeqRow {
	stop_seq: number | null;
}

interface EntryStructureRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
}

interface BranchTipRow {
	branch_id: string;
}

interface CompactionBoundary {
	branchId: string;
	seq: number;
}

interface CompactionBoundaryRow {
	entry_seq: number | null;
}

function readBranchMembership(db: SqliteDatabase, sessionId: string, entryId: string): BranchMembershipRow {
	const row = sql`SELECT b.branch_id, b.entry_seq
		FROM branch_entries b
		JOIN branch_meta m ON m.session_id = b.session_id AND m.branch_id = b.branch_id
		WHERE b.session_id = ${sessionId}
			AND b.entry_id = ${entryId}
			AND ((m.base_seq IS NULL AND b.entry_seq > 0) OR (m.base_seq IS NOT NULL AND b.entry_seq > m.base_seq))
			AND b.entry_seq <= m.tip_seq
		ORDER BY m.tip_seq DESC, b.branch_id
		LIMIT 1`.get<BranchMembershipRow>(db);
	if (row === undefined) throw new Error(`Branch cache missing entry ${entryId}`);
	return row;
}

function readBranchMeta(db: SqliteDatabase, sessionId: string, branchId: string): BranchMetaRow {
	const row = sql`SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq
		FROM branch_meta
		WHERE session_id = ${sessionId} AND branch_id = ${branchId}`.get<BranchMetaRow>(db);
	if (row === undefined) throw new Error(`Branch metadata missing for branch ${branchId}`);
	return row;
}

function insertBranchEntry(db: SqliteDatabase, sessionId: string, branchId: string, entry: Entry): void {
	sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
		VALUES (${sessionId}, ${branchId}, ${entry.id}, ${entry.seq}, ${entry.type})`.run(db);
}

function readBranchTipForParent(db: SqliteDatabase, sessionId: string, parentId: string): BranchTipRow | undefined {
	return sql`SELECT branch_id
		FROM branch_meta
		WHERE session_id = ${sessionId} AND tip_entry_id = ${parentId}`.get<BranchTipRow>(db);
}

function createRootBranchForEntry(db: SqliteDatabase, sessionId: string, entry: Entry): void {
	sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
		VALUES (${sessionId}, ${entry.id}, ${entry.id}, ${entry.seq}, ${null}, ${null})`.run(db);
	insertBranchEntry(db, sessionId, entry.id, entry);
}

function appendEntryToExistingBranch(db: SqliteDatabase, sessionId: string, branchId: string, entry: Entry): void {
	insertBranchEntry(db, sessionId, branchId, entry);
	const result = sql`UPDATE branch_meta
		SET tip_entry_id = ${entry.id}, tip_seq = ${entry.seq}
		WHERE session_id = ${sessionId} AND branch_id = ${branchId}`.run(db);
	if (result.changes !== 1) throw new Error(`Expected to update branch ${branchId}, updated ${result.changes}`);
}

function readBranchSegmentsNewestFirst(db: SqliteDatabase, sessionId: string, start: string): BranchSegment[] {
	let { branch_id: branchId, entry_seq: upperSeq } = readBranchMembership(db, sessionId, start);
	const segments: BranchSegment[] = [];
	while (true) {
		const meta = readBranchMeta(db, sessionId, branchId);
		const lowerSeq = meta.base_seq ?? 0;
		segments.push({ branchId, lowerSeq, upperSeq });
		if (meta.base_branch_id === null) break;
		if (meta.base_seq === null) throw new Error(`Branch ${branchId} has base branch without base_seq`);
		branchId = meta.base_branch_id;
		upperSeq = meta.base_seq;
	}
	return segments;
}

function readNewestCompactionBoundary(
	db: SqliteDatabase,
	sessionId: string,
	segmentsNewestFirst: readonly BranchSegment[],
): CompactionBoundary | undefined {
	for (const segment of segmentsNewestFirst) {
		const row = sql`SELECT MAX(entry_seq) AS entry_seq
			FROM branch_entries
			WHERE session_id = ${sessionId}
				AND branch_id = ${segment.branchId}
				AND entry_seq > ${segment.lowerSeq}
				AND entry_seq <= ${segment.upperSeq}
				AND entry_type = ${"compaction"}`.get<CompactionBoundaryRow>(db);
		if (row?.entry_seq !== null && row?.entry_seq !== undefined)
			return { branchId: segment.branchId, seq: row.entry_seq };
	}
	return undefined;
}

function copyBranchEntriesAfterSeqThroughParent(
	db: SqliteDatabase,
	sessionId: string,
	targetBranchId: string,
	segmentsNewestFirst: readonly BranchSegment[],
	afterSeq: number,
): void {
	for (const segment of [...segmentsNewestFirst].reverse()) {
		const lowerSeq = Math.max(segment.lowerSeq, afterSeq);
		if (segment.upperSeq <= lowerSeq) continue;
		sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
			SELECT ${sessionId}, ${targetBranchId}, entry_id, entry_seq, entry_type
			FROM branch_entries
			WHERE session_id = ${sessionId}
				AND branch_id = ${segment.branchId}
				AND entry_seq > ${lowerSeq}
				AND entry_seq <= ${segment.upperSeq}`.run(db);
	}
}

function createDivergentBranchForEntry(db: SqliteDatabase, sessionId: string, entry: Entry): void {
	if (entry.parentId === null) throw new Error("Root entries do not create divergent branches");
	const segmentsNewestFirst = readBranchSegmentsNewestFirst(db, sessionId, entry.parentId);
	const compaction = readNewestCompactionBoundary(db, sessionId, segmentsNewestFirst);
	const branchId = entry.id;
	// A null base means this segment stores its own root-through-parent prefix.
	sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
		VALUES (${sessionId}, ${branchId}, ${entry.id}, ${entry.seq}, ${compaction?.branchId ?? null}, ${compaction?.seq ?? null})`.run(
		db,
	);
	copyBranchEntriesAfterSeqThroughParent(db, sessionId, branchId, segmentsNewestFirst, compaction?.seq ?? 0);
	insertBranchEntry(db, sessionId, branchId, entry);
}

export function appendEntryToBranchIndex(db: SqliteDatabase, sessionId: string, entry: Entry): void {
	if (entry.parentId === null) {
		createRootBranchForEntry(db, sessionId, entry);
		return;
	}

	const branch = readBranchTipForParent(db, sessionId, entry.parentId);
	if (branch === undefined) {
		createDivergentBranchForEntry(db, sessionId, entry);
		return;
	}
	appendEntryToExistingBranch(db, sessionId, branch.branch_id, entry);
}

function stopPredicates(query: StorageBranchScan): SqlQuery[] {
	const predicates: SqlQuery[] = [];
	if (query.stopAtType !== undefined) predicates.push(sql`b.entry_type = ${query.stopAtType}`);
	if (query.stopAtId !== undefined) predicates.push(sql`b.entry_id = ${query.stopAtId}`);
	return predicates;
}

function readStopSeq(
	db: SqliteDatabase,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
): number | undefined {
	const stop = stopPredicates(query);
	if (stop.length === 0) return undefined;
	const aggregate = oldestFirst ? sql`MIN(b.entry_seq)` : sql`MAX(b.entry_seq)`;
	const row = sql`SELECT ${aggregate} AS stop_seq
		FROM branch_entries b
		WHERE b.session_id = ${sessionId}
			AND b.branch_id = ${segment.branchId}
			AND b.entry_seq > ${segment.lowerSeq}
			AND b.entry_seq <= ${segment.upperSeq}
			AND (${joinSqlFragments(stop, " OR ")})`.get<StopSeqRow>(db);
	return row?.stop_seq ?? undefined;
}

function branchScanPredicates(
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
): SqlQuery[] {
	const predicates: SqlQuery[] = [
		sql`b.session_id = ${sessionId}`,
		sql`b.branch_id = ${segment.branchId}`,
		sql`b.entry_seq > ${segment.lowerSeq}`,
		sql`b.entry_seq <= ${segment.upperSeq}`,
		sql`e.session_id = b.session_id`,
	];
	if (stopSeq !== undefined)
		predicates.push(oldestFirst ? sql`b.entry_seq <= ${stopSeq}` : sql`b.entry_seq >= ${stopSeq}`);
	if (query.type !== undefined) predicates.push(sql`b.entry_type = ${query.type}`);
	if (query.customType !== undefined) predicates.push(sql`e.custom_type = ${query.customType}`);
	if (query.cursor !== undefined) {
		predicates.push(oldestFirst ? sql`b.entry_seq > ${query.cursor.seq}` : sql`b.entry_seq < ${query.cursor.seq}`);
	}
	return predicates;
}

function limitSql(limit: number | undefined): SqlQuery {
	return limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, limit)}`;
}

function scanEntrySegmentRows(
	db: SqliteDatabase,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
): EntryRow[] {
	const predicates = branchScanPredicates(sessionId, segment, query, oldestFirst, stopSeq);
	const order = oldestFirst ? sql`ASC` : sql`DESC`;
	return sql`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload
		FROM branch_entries b
		CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY b.entry_seq ${order} ${limitSql(limit)}`.all<EntryRow>(db);
}

function decodeEntryStructureRow(row: EntryStructureRow): EntryStructure {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	};
}

function scanStructureSegmentRows(
	db: SqliteDatabase,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
): EntryStructure[] {
	const predicates = branchScanPredicates(sessionId, segment, query, oldestFirst, stopSeq);
	const order = oldestFirst ? sql`ASC` : sql`DESC`;
	const rows = sql`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp
		FROM branch_entries b
		CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY b.entry_seq ${order} ${limitSql(limit)}`.all<EntryStructureRow>(db);
	return rows.map(decodeEntryStructureRow);
}

function scanBranchSegments<T>(
	db: SqliteDatabase,
	sessionId: string,
	query: StorageBranchScan,
	readSegment: (
		db: SqliteDatabase,
		sessionId: string,
		segment: BranchSegment,
		query: StorageBranchScan,
		oldestFirst: boolean,
		stopSeq: number | undefined,
		limit: number | undefined,
	) => T[],
): T[] {
	const oldestFirst = query.order === "oldestFirst";
	const segmentsNewestFirst = readBranchSegmentsNewestFirst(db, sessionId, query.start);
	const segments = oldestFirst ? [...segmentsNewestFirst].reverse() : segmentsNewestFirst;
	const limit = query.limit === undefined ? undefined : Math.max(0, query.limit);
	if (limit === 0) return [];

	const rows: T[] = [];
	for (const segment of segments) {
		const remaining = limit === undefined ? undefined : limit - rows.length;
		if (remaining !== undefined && remaining <= 0) break;
		const stopSeq = readStopSeq(db, sessionId, segment, query, oldestFirst);
		rows.push(...readSegment(db, sessionId, segment, query, oldestFirst, stopSeq, remaining));
		if (stopSeq !== undefined) break;
	}
	return rows;
}

export function scanBranchEntries(db: SqliteDatabase, sessionId: string, query: StorageBranchScan): Entry[] {
	return scanBranchSegments(db, sessionId, query, scanEntrySegmentRows).map(decodeEntryRow);
}

export function scanBranchEntryStructures(
	db: SqliteDatabase,
	sessionId: string,
	query: StorageBranchScan,
): EntryStructure[] {
	return scanBranchSegments(db, sessionId, query, scanStructureSegmentRows);
}
