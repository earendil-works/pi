import { type Entry, SessionError } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

/** Derived root-to-tip branch cache membership. Canonical parent links remain in entries. */
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
	timestamp: number;
	payload: string;
}

export interface CachedBranchQuery {
	type?: Entry["type"];
	customType?: string;
	stopAtType?: Entry["type"];
	stopAtId?: string;
	cursor?: { afterSeq: number };
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
}

interface BranchPathEntryRow {
	id: string;
	seq: number;
	parent_id: string | null;
	type: Entry["type"];
	payload: string;
}

export function readCachedBranch(db: SqliteDatabase, sessionId: string, leafId: string) {
	const membership = sql`SELECT branch_id, entry_seq
		FROM branch_entries
		WHERE session_id = ${sessionId} AND entry_id = ${leafId}
		ORDER BY branch_id
		LIMIT 1`.get<{ branch_id: string; entry_seq: number }>(db);
	if (!membership) return undefined;
	return { branchId: membership.branch_id, leafSeq: membership.entry_seq };
}

export function queryCachedBranchRows(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	query: CachedBranchQuery,
) {
	const oldestFirst = query.order === "oldestFirst";
	const stopPredicates: ReturnType<typeof sql>[] = [];
	if (query.stopAtType !== undefined) stopPredicates.push(sql`stop.entry_type = ${query.stopAtType}`);
	if (query.stopAtId !== undefined) stopPredicates.push(sql`stop.entry_id = ${query.stopAtId}`);

	const aggregate = oldestFirst ? sql`MIN` : sql`MAX`;
	const boundaryComparison = oldestFirst ? sql`<=` : sql`>=`;
	const cursorComparison = oldestFirst ? sql`>` : sql`<`;
	const direction = oldestFirst ? sql`ASC` : sql`DESC`;
	const boundary =
		stopPredicates.length === 0
			? sql``
			: sql`SELECT ${aggregate}(stop.entry_seq)
				FROM branch_entries AS stop
				WHERE stop.session_id = ${sessionId}
					AND stop.branch_id = ${branch.branchId}
					AND stop.entry_seq <= ${branch.leafSeq}
					AND (${joinSqlFragments(stopPredicates, " OR ")})`;

	const predicates = [
		sql`b.session_id = ${sessionId}`,
		sql`b.branch_id = ${branch.branchId}`,
		sql`b.entry_seq <= ${branch.leafSeq}`,
	];
	if (stopPredicates.length > 0) {
		predicates.push(
			sql`b.entry_seq ${boundaryComparison} COALESCE((${boundary}), ${oldestFirst ? branch.leafSeq : 0})`,
		);
	}
	if (query.cursor !== undefined) predicates.push(sql`b.entry_seq ${cursorComparison} ${query.cursor.afterSeq}`);
	if (query.type !== undefined) predicates.push(sql`b.entry_type = ${query.type}`);
	if (query.customType !== undefined) predicates.push(sql`b.custom_type = ${query.customType}`);
	const limit = query.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;

	return sql`SELECT e.session_id, e.id, e.seq AS entry_seq, e.parent_id, e.type, e.timestamp, e.payload
		FROM branch_entries AS b
		JOIN entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY b.entry_seq ${direction}${limit}`.all<CachedBranchEntryRow>(db);
}

export function deleteBranchEntries(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM branch_entries WHERE session_id = ${sessionId}`.run(db);
}

export function insertBranchEntry(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	entryId: string,
	entrySeq: number,
	entryType: string,
	customType: string | null,
) {
	sql`INSERT INTO branch_entries
			(session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
			VALUES (${sessionId}, ${branchId}, ${entryId}, ${entrySeq}, ${entryType}, ${customType})`.run(db);
}

function customTypeFromPayload(row: BranchPathEntryRow): string | null {
	if (row.type !== "custom") return null;
	try {
		const payload = JSON.parse(row.payload) as unknown;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			throw new Error("Payload is not an object");
		}
		const customType = (payload as { customType?: unknown }).customType;
		if (typeof customType !== "string") throw new Error("Invalid custom payload");
		return customType;
	} catch (error) {
		throw new SessionError(
			"invalid_entry",
			`Invalid SQLite session entry ${row.id}: failed to decode entry ${row.id}`,
			error instanceof Error ? error : undefined,
		);
	}
}

export function insertBranchEntriesForPath(db: SqliteDatabase, sessionId: string, branchId: string, leafId: string) {
	const path: BranchPathEntryRow[] = [];
	const seen = new Set<string>();
	let entryId: string | null = leafId;

	while (entryId !== null) {
		if (seen.has(entryId)) throw new SessionError("invalid_entry", `Entry parent cycle at ${entryId}`);
		seen.add(entryId);
		const row: BranchPathEntryRow | undefined = sql`SELECT id, seq, parent_id, type, payload
			FROM entries
			WHERE session_id = ${sessionId} AND id = ${entryId}`.get<BranchPathEntryRow>(db);
		if (!row) throw new SessionError("invalid_entry", `Entry ${entryId} not found`);
		path.push(row);
		entryId = row.parent_id;
	}

	for (const row of path.reverse()) {
		insertBranchEntry(db, sessionId, branchId, row.id, row.seq, row.type, customTypeFromPayload(row));
	}
}

export function readBranchContainingEntry(db: SqliteDatabase, sessionId: string, entryId: string) {
	const row = sql`SELECT b.branch_id, b.entry_seq
		FROM branch_entries AS b
		WHERE b.session_id = ${sessionId} AND b.entry_id = ${entryId}
		ORDER BY b.branch_id
		LIMIT 1`.get<{ branch_id: string; entry_seq: number }>(db);
	return row === undefined ? undefined : { branchId: row.branch_id, entrySeq: row.entry_seq };
}

export function copyBranchEntriesThroughSeq(
	db: SqliteDatabase,
	sessionId: string,
	targetBranchId: string,
	sourceBranchId: string,
	throughSeq: number,
) {
	sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
		SELECT session_id, ${targetBranchId}, entry_id, entry_seq, entry_type, custom_type
		FROM branch_entries
		WHERE session_id = ${sessionId} AND branch_id = ${sourceBranchId} AND entry_seq <= ${throughSeq}`.run(db);
}
