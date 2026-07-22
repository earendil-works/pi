import type {
	LeafEntry,
	SessionEntryCursorOptions,
	SessionStorage,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";
import { getMaterializedBranchPathOrCompaction } from "./branch-entries.ts";
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
	sessionStatsFromMaterializedState,
} from "./session-materialized.ts";
import { advanceSequence, getNextSequence } from "./session-sequences.ts";
import { rowToMetadata, type SessionRow } from "./sessions.ts";
import { generateEntryId, invalidSession, leafIdAfterEntry } from "./shared.ts";

async function decodeEntryRows(entryRows: SessionEntryRow[]): Promise<{
	entries: SessionTreeEntry[];
	leafId: string | null;
}> {
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (const entryRow of entryRows) {
		try {
			const entry = decodeEntry(entryRow);
			entries.push(entry);
			leafId = leafIdAfterEntry(entry);
		} catch {
			// Keep JSONL-like permissive resume behavior: skip malformed entries.
		}
	}
	return { entries, leafId };
}

async function loadEntryRowsByIds(
	db: SqliteDatabase,
	sessionId: string,
	entryIds: string[],
): Promise<Map<string, SessionEntryRow>> {
	if (entryIds.length === 0) return new Map<string, SessionEntryRow>();
	const placeholders = entryIds.map(() => "?").join(", ");
	const rows = await db
		.prepare(
			`SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id IN (${placeholders})`,
		)
		.all<SessionEntryRow>(sessionId, ...entryIds);
	return new Map(rows.map((row) => [row.id, row]));
}

async function loadActiveBranchId(db: SqliteDatabase, sessionId: string): Promise<string | null> {
	// branch_entries includes leaf navigation entries for the active branch, so the
	// newest branch_entries row identifies the branch that was most recently made active.
	const row = await db
		.prepare(
			"SELECT branch_id FROM branch_entries WHERE session_id = ? ORDER BY entry_seq DESC, branch_id DESC LIMIT 1",
		)
		.get<{ branch_id: string }>(sessionId);
	return row?.branch_id ?? null;
}

async function hasExistingChild(db: SqliteDatabase, sessionId: string, parentId: string | null): Promise<boolean> {
	const row =
		parentId === null
			? await db
					.prepare("SELECT 1 AS found FROM session_entries WHERE session_id = ? AND parent_id IS NULL LIMIT 1")
					.get<{ found: number }>(sessionId)
			: await db
					.prepare("SELECT 1 AS found FROM session_entries WHERE session_id = ? AND parent_id = ? LIMIT 1")
					.get<{ found: number }>(sessionId, parentId);
	return row !== undefined;
}

async function loadSqliteStorage(
	db: SqliteDatabase,
	sessionId: string,
): Promise<{
	row: SessionRow;
	leafId: string | null;
	activeBranchId: string | null;
	materializedState: SessionMaterializedState;
}> {
	const row = await db
		.prepare("SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE id = ?")
		.get<SessionRow>(sessionId);
	if (!row) throw new SessionError("not_found", `Session not found: ${sessionId}`);

	const leafId = row.active_leaf_id;
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
		leafId,
		activeBranchId: await loadActiveBranchId(db, sessionId),
		materializedState: materializedStateFromRows(materializedRow, entryMaterializedRows),
	};
}

export class SqliteSessionStorage implements SessionStorage<SqliteSessionMetadata> {
	private readonly db: SqliteDatabase;
	private readonly metadata: SqliteSessionMetadata;
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;
	private activeBranchId: string | null;
	private materializedState: SessionMaterializedState;

	private async getPathToRootOrCompactionEntries(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = await this.getEntry(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = await this.getEntry(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	private async materializeBranch(leafId: string | null): Promise<void> {
		const branchId = uuidv7();
		// Rebuild the branch path only when branch membership changes: branch switch
		// (leaf navigation) or a new fork from a parent that already has a child.
		// Linear appends stay cheap and extend the active branch incrementally.
		const path = await this.getPathToRootOrCompactionEntries(leafId);
		const entryRowsById = await loadEntryRowsByIds(
			this.db,
			this.metadata.id,
			path.map((entry) => entry.id),
		);
		for (const entry of path) {
			const entryRow = entryRowsById.get(entry.id);
			if (!entryRow) throw invalidSession(`missing entry row for session ${this.metadata.id} entry ${entry.id}`);
			await this.db
				.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
				.run(this.metadata.id, branchId, entry.id, entryRow.entry_seq);
		}
		this.activeBranchId = branchId;
	}

	private async appendToActiveBranch(entryId: string, parentId: string | null): Promise<void> {
		if (!this.activeBranchId) {
			await this.materializeBranch(parentId);
		}
		// After a branch is materialized/resynced, subsequent linear appends only add the
		// new tip entry. We do not rebuild the full branch on every append.
		if (!this.activeBranchId) {
			throw invalidSession(`active branch missing for session ${this.metadata.id}`);
		}
		const entryRow = await this.db
			.prepare("SELECT entry_seq FROM session_entries WHERE session_id = ? AND id = ?")
			.get<{ entry_seq: number }>(this.metadata.id, entryId);
		if (!entryRow) throw invalidSession(`missing entry row for session ${this.metadata.id} entry ${entryId}`);
		await this.db
			.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
			.run(this.metadata.id, this.activeBranchId, entryId, entryRow.entry_seq);
	}

	private constructor(
		db: SqliteDatabase,
		metadata: SqliteSessionMetadata,
		entries: SessionTreeEntry[] | null,
		leafId: string | null,
		activeBranchId: string | null,
		materializedState: SessionMaterializedState,
	) {
		this.db = db;
		this.metadata = metadata;
		this.byId = new Map((entries ?? []).map((entry) => [entry.id, entry]));
		this.materializedState = materializedState;
		this.labelsById = materializedState.labelsById;
		this.currentLeafId = leafId;
		this.activeBranchId = activeBranchId;
	}

	static async open(db: SqliteDatabase, metadata: SqliteSessionMetadata): Promise<SqliteSessionStorage> {
		const loaded = await loadSqliteStorage(db, metadata.id);
		return new SqliteSessionStorage(
			db,
			rowToMetadata(loaded.row, metadata.path),
			null,
			loaded.leafId,
			loaded.activeBranchId,
			loaded.materializedState,
		);
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
	): Promise<SqliteSessionStorage> {
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
		return new SqliteSessionStorage(
			db,
			{
				id: options.sessionId,
				createdAt,
				cwd: options.cwd,
				path,
				parentSessionId: options.parentSessionId,
				metadata: options.metadata,
			},
			[],
			null,
			null,
			createEmptyMaterializedState(),
		);
	}

	async getMetadata(): Promise<SqliteSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !(await this.getEntry(leafId))) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: await this.createEntryId(),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		await this.appendEntry(entry);
	}

	async createEntryId(): Promise<string> {
		for (let i = 0; i < 100; i++) {
			const id = generateEntryId(this.byId);
			const existing = await this.db
				.prepare("SELECT 1 AS found FROM session_entries WHERE session_id = ? AND id = ? LIMIT 1")
				.get<{ found: number }>(this.metadata.id, id);
			if (!existing) return id;
		}
		return uuidv7();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		const encoded = encodeEntry(entry);
		const previousMaterializedState: SessionMaterializedState = {
			...this.materializedState,
			labelsById: new Map(this.materializedState.labelsById),
			modelThinkingConfigs: [...this.materializedState.modelThinkingConfigs],
			currentModel: this.materializedState.currentModel ? { ...this.materializedState.currentModel } : null,
		};
		const previousById = new Map(this.byId);
		const previousLeafId = this.currentLeafId;
		const previousActiveBranchId = this.activeBranchId;
		try {
			applyEntryToMaterializedState(this.materializedState, entry);
			await this.db.transaction(async () => {
				const parentHadExistingChild = await hasExistingChild(this.db, this.metadata.id, entry.parentId);
				const nextSeq = await getNextSequence(this.db, this.metadata.id);
				await this.db
					.prepare(
						"INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(this.metadata.id, entry.id, nextSeq, entry.parentId, entry.type, entry.timestamp, encoded.payload);
				await advanceSequence(this.db, this.metadata.id, nextSeq);
				await this.db
					.prepare("UPDATE session_materialized SET payload = ? WHERE session_id = ?")
					.run(serializeSummary(this.materializedState), this.metadata.id);
				for (const materializedEntry of entryMaterializedValues(entry)) {
					await this.db
						.prepare("INSERT INTO entry_materialized (session_id, entry_seq, type, payload) VALUES (?, ?, ?, ?)")
						.run(this.metadata.id, nextSeq, materializedEntry.type, materializedEntry.payload);
				}
				this.byId.set(entry.id, entry);
				this.currentLeafId = leafIdAfterEntry(entry);
				await this.db
					.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?")
					.run(this.currentLeafId, this.metadata.id);
				if (entry.type === "leaf") {
					this.activeBranchId = null;
					await this.materializeBranch(entry.targetId);
					await this.appendToActiveBranch(entry.id, entry.parentId);
				} else {
					if (parentHadExistingChild) {
						await this.materializeBranch(entry.parentId);
					}
					await this.appendToActiveBranch(entry.id, entry.parentId);
				}
			});
		} catch (error) {
			this.materializedState = previousMaterializedState;
			this.labelsById = previousMaterializedState.labelsById;
			this.byId = previousById;
			this.currentLeafId = previousLeafId;
			this.activeBranchId = previousActiveBranchId;
			if (error instanceof SessionError) throw error;
			throw new SessionError("storage", `Failed to append SQLite session entry ${entry.id}`);
		}
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
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
		} catch {
			return undefined;
		}
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		const rows = await this.db
			.prepare(
				"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND type = ? ORDER BY entry_seq",
			)
			.all<SessionEntryRow>(this.metadata.id, type);
		const entries: Array<Extract<SessionTreeEntry, { type: TType }>> = [];
		for (const row of rows) {
			try {
				const entry = decodeEntry(row) as Extract<SessionTreeEntry, { type: TType }>;
				this.byId.set(entry.id, entry);
				entries.push(entry);
			} catch {
				// Keep JSONL-like permissive resume behavior: skip malformed entries.
			}
		}
		return entries;
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	async getSessionName(): Promise<string | undefined> {
		return this.materializedState.name;
	}

	async getSessionStats() {
		return sessionStatsFromMaterializedState(this.materializedState);
	}

	async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		if (leafId === this.currentLeafId) {
			if (!this.activeBranchId) {
				throw invalidSession(`missing active branch for session ${this.metadata.id} leaf ${leafId}`);
			}
			return getMaterializedBranchPathOrCompaction(this.db, this.metadata.id, this.activeBranchId, this.byId);
		}
		return this.getPathToRootOrCompactionEntries(leafId);
	}

	async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		const limit = options?.limit;
		if (limit !== undefined) {
			const beforeOrAtEntrySeq =
				options?.afterEntrySeq ??
				(
					await this.db
						.prepare("SELECT entry_seq FROM session_entries WHERE session_id = ? ORDER BY entry_seq DESC LIMIT 1")
						.get<{ entry_seq: number }>(this.metadata.id)
				)?.entry_seq;
			if (beforeOrAtEntrySeq === undefined) {
				return [];
			}
			const rows = await this.db
				.prepare(
					"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND entry_seq <= ? ORDER BY entry_seq DESC LIMIT ?",
				)
				.all<SessionEntryRow>(this.metadata.id, beforeOrAtEntrySeq, limit);
			const entries = (await decodeEntryRows(rows)).entries;
			for (const entry of entries) {
				this.byId.set(entry.id, entry);
			}
			return entries.reverse();
		}
		const rows = await this.db
			.prepare(
				"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? ORDER BY entry_seq",
			)
			.all<SessionEntryRow>(this.metadata.id);
		const entries = (await decodeEntryRows(rows)).entries;
		for (const entry of entries) {
			this.byId.set(entry.id, entry);
		}
		return entries;
	}

	async cleanup(): Promise<void> {
		await this.db.close();
	}
}
