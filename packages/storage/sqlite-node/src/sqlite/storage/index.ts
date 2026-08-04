import type {
	SessionBranchQuery,
	SessionEntryCursorOptions,
	SessionStats,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { SessionError, toError } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";
import {
	appendEntryToBranchCache,
	type CachedBranch,
	isCachedBranchValid,
	queryCachedBranchRows,
	readCachedBranch,
	readCachedBranchRows,
	readCachedEntryRowsByType,
	readCachedEntrySeq,
	readNewestCachedStopSeq,
	rebuildCachedBranch,
} from "./branch-cache.ts";
import { decodeEntry, encodeEntry, type SessionEntryRow } from "./session-entries.ts";
import {
	applyEntryToMaterializedState,
	createEmptyMaterializedState,
	type EntryMaterializedRow,
	entryMaterializedValues,
	materializedStateFromRows,
	materializedStateValues,
	type SessionMaterializedRow,
	type SessionMaterializedState,
	serializeSummary,
} from "./session-materialized.ts";
import { advanceSequence, getNextSequence } from "./session-sequences.ts";
import { rowToMetadata, type SessionRow } from "./sessions.ts";
import { invalidEntry, invalidSession, leafIdAfterEntry } from "./shared.ts";

function decodeEntryRows(entryRows: SessionEntryRow[]): SessionTreeEntry[] {
	const entries: SessionTreeEntry[] = [];
	for (const entryRow of entryRows) {
		try {
			const entry = decodeEntry(entryRow);
			entries.push(entry);
		} catch (error) {
			throw invalidEntry(`failed to decode entry ${entryRow.id}`, toError(error));
		}
	}
	return entries;
}

async function loadSqliteSession(
	db: SqliteDatabase,
	sessionId: string,
): Promise<{
	row: SessionRow;
	materializedState: SessionMaterializedState;
}> {
	const row = await db
		.prepare("SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE id = ?")
		.get<SessionRow>(sessionId);
	if (!row) throw new SessionError("not_found", `Session not found: ${sessionId}`);

	const materializedRow = await db
		.prepare("SELECT session_id, payload FROM session_materialized WHERE session_id = ?")
		.get<SessionMaterializedRow>(sessionId);
	if (!materializedRow) throw invalidSession(`missing materialized row for session ${sessionId}`);
	const entryMaterializedRows = await db
		.prepare(
			"SELECT session_id, entry_seq, type, payload FROM entry_materialized WHERE session_id = ? ORDER BY entry_seq, type",
		)
		.all<EntryMaterializedRow>(sessionId);
	return {
		row,
		materializedState: materializedStateFromRows(materializedRow, entryMaterializedRows),
	};
}

export class SqliteSessionConnection {
	private readonly db: SqliteDatabase;
	readonly metadata: SqliteSessionMetadata;
	private byId: Map<string, SessionTreeEntry>;
	private materializedState: SessionMaterializedState;

	async findEntriesOnBranch(query: SessionBranchQuery & { start: string | null }): Promise<SessionTreeEntry[]> {
		if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
			throw new RangeError("Session branch query limit must be a positive integer");
		}
		if (query.start === null) return [];
		const startId = query.start;
		let cached = await readCachedBranch(this.db, this.metadata.id, startId);
		const validationStartSeq =
			cached && query.order !== "oldestFirst"
				? await readNewestCachedStopSeq(this.db, this.metadata.id, cached, query.stopAtType, query.stopAtId)
				: undefined;
		if (!cached || !(await isCachedBranchValid(this.db, this.metadata.id, cached, startId, validationStartSeq))) {
			if (query.order !== "oldestFirst" && (query.stopAtId !== undefined || query.stopAtType !== undefined)) {
				return this.findEntriesOnCanonicalBranch({ ...query, start: startId });
			}
			cached = await this.repairBranchCacheForQuery(startId, cached?.branchId);
		}
		const decoded = decodeEntryRows(await queryCachedBranchRows(this.db, this.metadata.id, cached, query));
		const filtered = decoded.filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)),
		);
		const entries = query.limit === undefined ? filtered : filtered.slice(0, query.limit);
		for (const entry of entries) this.byId.set(entry.id, entry);
		return entries;
	}

	private async findEntriesOnCanonicalBranch(
		query: SessionBranchQuery & { start: string },
	): Promise<SessionTreeEntry[]> {
		const rows: SessionEntryRow[] = [];
		const visited = new Set<string>();
		let currentId: string | null = query.start;
		while (currentId !== null) {
			if (visited.has(currentId)) throw invalidSession(`cycle in parent chain at entry ${currentId}`);
			visited.add(currentId);
			const row: SessionEntryRow | undefined = await this.db
				.prepare(
					"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id = ?",
				)
				.get<SessionEntryRow>(this.metadata.id, currentId);
			if (!row) {
				if (currentId === query.start) throw new SessionError("not_found", `Entry ${query.start} not found`);
				throw invalidSession(`Entry ${currentId} not found`);
			}
			rows.push(row);
			if (row.id === query.stopAtId || row.type === query.stopAtType) break;
			currentId = row.parent_id;
		}
		const entries = decodeEntryRows(rows).filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)),
		);
		const limited = query.limit === undefined ? entries : entries.slice(0, query.limit);
		for (const entry of limited) this.byId.set(entry.id, entry);
		return limited;
	}

	private async repairBranchCacheForQuery(leafId: string, branchIdToReplace?: string): Promise<CachedBranch> {
		const visited = new Set<string>();
		let currentId: string | null = leafId;
		while (currentId !== null) {
			if (visited.has(currentId)) throw invalidSession(`cycle in parent chain at entry ${currentId}`);
			visited.add(currentId);
			const row: { parent_id: string | null } | undefined = await this.db
				.prepare("SELECT parent_id FROM session_entries WHERE session_id = ? AND id = ?")
				.get<{ parent_id: string | null }>(this.metadata.id, currentId);
			if (!row) {
				if (currentId === leafId) throw new SessionError("not_found", `Entry ${leafId} not found`);
				throw invalidSession(`Entry ${currentId} not found`);
			}
			currentId = row.parent_id;
		}
		try {
			await rebuildCachedBranch(this.db, this.metadata.id, leafId, branchIdToReplace);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			throw new SessionError("storage", `Failed to rebuild SQLite branch cache at entry ${leafId}`, toError(error));
		}
		const cached = await readCachedBranch(this.db, this.metadata.id, leafId);
		if (!cached || !(await isCachedBranchValid(this.db, this.metadata.id, cached, leafId))) {
			throw invalidSession(`branch cache repair did not produce a valid path to entry ${leafId}`);
		}
		return cached;
	}

	async readPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const cached = await readCachedBranch(this.db, this.metadata.id, leafId);
		if (cached) {
			const compactionRows = await readCachedEntryRowsByType(this.db, this.metadata.id, cached, "compaction");
			let startSeq = 0;
			let expectedStartId: string | null = null;
			let pendingStop: { id: string; seq: number } | undefined;
			for (const compactionRow of compactionRows) {
				if (pendingStop && pendingStop.seq >= compactionRow.entry_seq) {
					startSeq = pendingStop.seq;
					expectedStartId = pendingStop.id;
					break;
				}
				const compaction = decodeEntryRows([compactionRow])[0]!;
				if (compaction.type !== "compaction") throw invalidSession(`entry ${compaction.id} is not a compaction`);
				if (compaction.retainedTail) {
					startSeq = compactionRow.entry_seq;
					expectedStartId = compaction.id;
					pendingStop = undefined;
					break;
				} else if (compaction.firstKeptEntryId !== undefined) {
					const firstKeptSeq = await readCachedEntrySeq(
						this.db,
						this.metadata.id,
						cached.branchId,
						compaction.firstKeptEntryId,
					);
					pendingStop =
						firstKeptSeq !== undefined && firstKeptSeq < compactionRow.entry_seq
							? { id: compaction.firstKeptEntryId, seq: firstKeptSeq }
							: undefined;
				} else {
					pendingStop = undefined;
				}
			}
			if (startSeq === 0 && pendingStop) {
				startSeq = pendingStop.seq;
				expectedStartId = pendingStop.id;
			}
			const entries = decodeEntryRows(await readCachedBranchRows(this.db, this.metadata.id, cached, startSeq));
			if (this.isValidCachedPath(entries, leafId, expectedStartId)) {
				for (const entry of entries) this.byId.set(entry.id, entry);
				return entries;
			}
		}

		const entries = await this.repairBranchCache(leafId, cached?.branchId);
		return this.trimPathToRootOrCompaction(entries);
	}

	private async repairBranchCache(leafId: string, branchIdToReplace?: string): Promise<SessionTreeEntry[]> {
		const entries = await this.readCanonicalPathToRoot(leafId);
		try {
			await rebuildCachedBranch(this.db, this.metadata.id, leafId, branchIdToReplace);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			throw new SessionError("storage", `Failed to rebuild SQLite branch cache at entry ${leafId}`, toError(error));
		}
		return entries;
	}

	private async readCanonicalPathToRoot(leafId: string): Promise<SessionTreeEntry[]> {
		const path: SessionTreeEntry[] = [];
		let current = await this.readEntry(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		const visited = new Set<string>();
		while (current) {
			if (visited.has(current.id)) throw invalidSession(`cycle in parent chain at entry ${current.id}`);
			visited.add(current.id);
			path.push(current);
			if (!current.parentId) break;
			const parent = await this.readEntry(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path.reverse();
	}

	private isValidCachedPath(
		entries: readonly SessionTreeEntry[],
		leafId: string,
		expectedStartId: string | null,
	): boolean {
		if (entries.length === 0 || entries.at(-1)!.id !== leafId) return false;
		if (expectedStartId === null ? entries[0]!.parentId !== null : entries[0]!.id !== expectedStartId) return false;
		for (let index = 1; index < entries.length; index++) {
			if (entries[index]!.parentId !== entries[index - 1]!.id) return false;
		}
		return true;
	}

	private trimPathToRootOrCompaction(entries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			path.push(entry);
			if (stopAtEntryId !== null && entry.id === stopAtEntryId) break;
			if (entry.type === "compaction") {
				if (entry.retainedTail) break;
				stopAtEntryId = entry.firstKeptEntryId ?? null;
			}
		}
		return path.reverse();
	}

	private constructor(
		db: SqliteDatabase,
		metadata: SqliteSessionMetadata,
		materializedState: SessionMaterializedState,
	) {
		this.db = db;
		this.metadata = metadata;
		this.byId = new Map<string, SessionTreeEntry>();
		this.materializedState = materializedState;
	}

	static async open(db: SqliteDatabase, metadata: SqliteSessionMetadata): Promise<SqliteSessionConnection> {
		const loaded = await loadSqliteSession(db, metadata.id);
		return new SqliteSessionConnection(db, rowToMetadata(loaded.row, metadata.path), loaded.materializedState);
	}

	static async create(
		db: SqliteDatabase,
		path: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionId?: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<SqliteSessionConnection> {
		const createdAt = new Date().toISOString();
		await db
			.prepare(
				"INSERT INTO sessions (id, created_at, metadata, cwd, parent_session_id, active_leaf_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				options.sessionId,
				createdAt,
				options.metadata === undefined ? null : JSON.stringify(options.metadata),
				options.cwd,
				options.parentSessionId ?? null,
				null,
			);
		await db.prepare("INSERT INTO session_sequences (session_id, next_seq) VALUES (?, ?)").run(options.sessionId, 1);
		await db
			.prepare("INSERT INTO session_materialized (session_id, payload) VALUES (?, ?)")
			.run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));
		return new SqliteSessionConnection(
			db,
			{
				id: options.sessionId,
				createdAt,
				cwd: options.cwd,
				path,
				parentSessionId: options.parentSessionId,
				metadata: options.metadata,
			},
			createEmptyMaterializedState(),
		);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.materializedState.labelsById.get(id);
	}

	async getName(): Promise<string | undefined> {
		return this.materializedState.name;
	}

	async getStats(): Promise<SessionStats> {
		const { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal } = this.materializedState;
		return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
	}

	async readHead(): Promise<{ leafId: string | null }> {
		const row = await this.db
			.prepare(
				`SELECT
					s.active_leaf_id,
					(s.active_leaf_id IS NULL OR EXISTS (
						SELECT 1 FROM session_entries AS e WHERE e.session_id = s.id AND e.id = s.active_leaf_id
					)) AS active_leaf_exists
				FROM sessions AS s
				WHERE s.id = ?`,
			)
			.get<{ active_leaf_id: string | null; active_leaf_exists: number }>(this.metadata.id);
		if (!row) throw new SessionError("not_found", `Session not found: ${this.metadata.id}`);
		if (row.active_leaf_exists === 0) {
			throw new SessionError("invalid_session", `Entry ${row.active_leaf_id} not found`);
		}
		return { leafId: row.active_leaf_id };
	}

	async appendEntry(entry: SessionTreeEntry, options: { transaction?: boolean } = {}): Promise<void> {
		if (entry.type === "leaf" && entry.targetId !== null && !(await this.readEntry(entry.targetId))) {
			throw new SessionError("not_found", `Entry ${entry.targetId} not found`);
		}
		const encoded = encodeEntry(entry);
		const nextMaterializedState: SessionMaterializedState = {
			...this.materializedState,
			labelsById: new Map(this.materializedState.labelsById),
			modelThinkingConfigs: [...this.materializedState.modelThinkingConfigs],
			currentModel: this.materializedState.currentModel ? { ...this.materializedState.currentModel } : null,
		};
		const nextLeafId = leafIdAfterEntry(entry);
		try {
			applyEntryToMaterializedState(nextMaterializedState, entry);
			const write = async () => {
				const nextSeq = await getNextSequence(this.db, this.metadata.id);
				await this.db
					.prepare(
						"INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(this.metadata.id, entry.id, nextSeq, entry.parentId, entry.type, entry.timestamp, encoded.payload);
				await advanceSequence(this.db, this.metadata.id, nextSeq);
				await this.db
					.prepare("UPDATE session_materialized SET payload = ? WHERE session_id = ?")
					.run(serializeSummary(nextMaterializedState), this.metadata.id);
				for (const materializedEntry of entryMaterializedValues(entry)) {
					await this.db
						.prepare("INSERT INTO entry_materialized (session_id, entry_seq, type, payload) VALUES (?, ?, ?, ?)")
						.run(this.metadata.id, nextSeq, materializedEntry.type, materializedEntry.payload);
				}
				await this.db
					.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?")
					.run(nextLeafId, this.metadata.id);
				await appendEntryToBranchCache(
					this.db,
					this.metadata.id,
					entry.id,
					nextSeq,
					entry.parentId,
					async (parentId) => {
						await this.repairBranchCache(parentId);
					},
				);
			};
			if (options.transaction === false) await write();
			else await this.db.transaction(write);
			this.materializedState = nextMaterializedState;
			this.byId.set(entry.id, entry);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			throw new SessionError("storage", `Failed to append SQLite session entry ${entry.id}`, toError(error));
		}
	}

	async readEntry(id: string): Promise<SessionTreeEntry | undefined> {
		const cached = this.byId.get(id);
		if (cached) return cached;
		const row = await this.db
			.prepare(
				"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id = ?",
			)
			.get<SessionEntryRow>(this.metadata.id, id);
		if (!row) return undefined;
		try {
			const entry = decodeEntry(row);
			this.byId.set(entry.id, entry);
			return entry;
		} catch (error) {
			throw invalidEntry(`failed to decode entry ${row.id}`, toError(error));
		}
	}

	async readEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		const afterEntrySeq = options?.afterEntrySeq ?? 0;
		const rows =
			options?.limit === undefined
				? await this.db
						.prepare(
							"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND entry_seq > ? ORDER BY entry_seq",
						)
						.all<SessionEntryRow>(this.metadata.id, afterEntrySeq)
				: await this.db
						.prepare(
							"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND entry_seq > ? ORDER BY entry_seq LIMIT ?",
						)
						.all<SessionEntryRow>(this.metadata.id, afterEntrySeq, options.limit);
		const entries = decodeEntryRows(rows);
		for (const entry of entries) {
			this.byId.set(entry.id, entry);
		}
		return entries;
	}
}
