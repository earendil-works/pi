import type { FileError, FileSystem, Result } from "@earendil-works/pi-agent-core";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type ProvisionedEntry,
	type RecordQuery,
	Session,
	type SessionCreateOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo as SessionRepository,
	type SessionStats,
	type SessionStorage,
} from "@earendil-works/pi-agent-core/experimental";
import { type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { appendEntryToBranchCache, buildCachedBranch, deleteBranchCache, rebuildBranchCache } from "./branch-cache.ts";
import { applyMigrations } from "./migrations.ts";
import { type CachedBranchEntryRow, queryCachedBranchRows, readCachedBranch } from "./storage/branch-entries.ts";
import { readBranchTipIds } from "./storage/branch-tips.ts";
import {
	countMessageEntries,
	deleteEntryRows,
	type EntryRow,
	entryPayload,
	idExistsInEntries,
	insertEntryRow,
	readEntryRow,
	readEntryRows,
} from "./storage/entries.ts";
import { appendFact, deleteFactRows, readFactRows, readLatestFact, readLatestLabelFacts } from "./storage/facts.ts";
import {
	createInitialLane,
	deleteLaneRows,
	createLane as insertLane,
	readLane,
	readLaneHead,
	readLaneMoveRows,
	readLanes,
	setLaneLeaf,
	moveLane as updateLane,
} from "./storage/lanes.ts";
import { deleteLease } from "./storage/leases.ts";
import { appendRecordRow, deleteRecordRows, idExistsInRecords, readRecordRows } from "./storage/records.ts";
import {
	advanceSequence,
	createSequence,
	deleteSequence,
	getNextSequence,
	setNextSequence,
} from "./storage/session-sequences.ts";
import {
	deleteSessionRow,
	insertSessionRow,
	readSessionRow,
	readSessionRows,
	rowToMetadata,
	type SessionRow,
	sessionExists,
} from "./storage/sessions.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "./types.ts";

export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionListOptions {
	cwd?: string;
}

export type SqliteSessionRepositoryEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;

export interface SqliteSessionRepositoryOptions {
	env: SqliteSessionRepositoryEnv;
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
}

class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async drain(): Promise<void> {
		await this.tail;
	}
}

function resultOrThrow<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

async function configureSqliteDatabase(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=FULL");
	await db.exec("PRAGMA busy_timeout=5000");
}

function timestampToText(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function timestampFromText(timestamp: string): number {
	return Date.parse(timestamp);
}

function entryRowFromCached(row: CachedBranchEntryRow): EntryRow {
	return { ...row, seq: row.entry_seq, type: row.type as Entry["type"] };
}

function readObjectPayload(row: EntryRow): Record<string, unknown> {
	const payload = JSON.parse(row.payload) as unknown;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Payload is not an object");
	}
	return payload as Record<string, unknown>;
}

function decodeEntry(row: EntryRow): Entry {
	try {
		const payload = readObjectPayload(row);
		const timestamp = timestampFromText(row.timestamp);
		if (!Number.isFinite(timestamp)) throw new Error(`Invalid timestamp ${row.timestamp}`);
		const base = { id: row.id, seq: row.seq, parentId: row.parent_id, timestamp };
		switch (row.type) {
			case "message":
				if (typeof payload.message !== "object" || payload.message === null) throw new Error("Missing message");
				return {
					...base,
					type: "message",
					message: payload.message as Extract<Entry, { type: "message" }>["message"],
					...(payload.terminate === true ? { terminate: true as const } : {}),
				};
			case "model_change":
				if (typeof payload.provider !== "string" || typeof payload.modelId !== "string") {
					throw new Error("Invalid model_change payload");
				}
				return { ...base, type: "model_change", provider: payload.provider, modelId: payload.modelId };
			case "thinking_level_change":
				if (typeof payload.thinkingLevel !== "string") throw new Error("Invalid thinking_level_change payload");
				return { ...base, type: "thinking_level_change", thinkingLevel: payload.thinkingLevel };
			case "active_tools_change":
				if (!Array.isArray(payload.activeToolNames)) throw new Error("Invalid active_tools_change payload");
				if (payload.activeToolNames.some((value) => typeof value !== "string")) {
					throw new Error("Invalid active_tools_change payload");
				}
				return { ...base, type: "active_tools_change", activeToolNames: payload.activeToolNames };
			case "compaction":
				if (
					typeof payload.summary !== "string" ||
					!Array.isArray(payload.retainedTail) ||
					typeof payload.tokensBefore !== "number"
				) {
					throw new Error("Invalid compaction payload");
				}
				return {
					...base,
					type: "compaction",
					summary: payload.summary,
					retainedTail: payload.retainedTail as Extract<Entry, { type: "compaction" }>["retainedTail"],
					tokensBefore: payload.tokensBefore,
					...(Object.hasOwn(payload, "details") ? { details: payload.details } : {}),
					...(Object.hasOwn(payload, "usage")
						? { usage: payload.usage as Extract<Entry, { type: "compaction" }>["usage"] }
						: {}),
				};
			case "branch_summary":
				if (typeof payload.fromId !== "string" || typeof payload.summary !== "string") {
					throw new Error("Invalid branch_summary payload");
				}
				return {
					...base,
					type: "branch_summary",
					fromId: payload.fromId,
					summary: payload.summary,
					...(Object.hasOwn(payload, "details") ? { details: payload.details } : {}),
					...(Object.hasOwn(payload, "usage")
						? { usage: payload.usage as Extract<Entry, { type: "branch_summary" }>["usage"] }
						: {}),
				};
			case "custom":
				if (typeof payload.customType !== "string") throw new Error("Invalid custom payload");
				return {
					...base,
					type: "custom",
					customType: payload.customType,
					...(Object.hasOwn(payload, "data") ? { data: payload.data } : {}),
				};
		}
	} catch (error) {
		throw new SessionError(
			"invalid_entry",
			`Invalid SQLite session entry ${row.id}: failed to decode entry ${row.id}`,
			error instanceof Error ? error : undefined,
		);
	}
}

function recordRunId(record: NewRecord): string | undefined {
	return record.type === "operation_started" ? record.id : "runId" in record ? record.runId : undefined;
}

function recordOpKind(record: NewRecord): string | undefined {
	return record.type === "operation_started" ? record.intent.kind : undefined;
}

function decodeRecord(row: { seq: number; timestamp: string; payload: string }): LaneRecord {
	try {
		const timestamp = timestampFromText(row.timestamp);
		if (!Number.isFinite(timestamp)) throw new Error(`Invalid timestamp ${row.timestamp}`);
		return {
			...(JSON.parse(row.payload) as object),
			seq: row.seq,
			timestamp,
		} as LaneRecord;
	} catch (error) {
		throw new SessionError(
			"storage",
			`Invalid SQLite session record at sequence ${row.seq}: failed to decode payload`,
			error instanceof Error ? error : undefined,
		);
	}
}

function validateCachedBranchRows(rows: readonly CachedBranchEntryRow[], query: BranchBounds): void {
	if (rows.length === 0) return;
	const path = [...rows].sort((left, right) => left.entry_seq - right.entry_seq);
	if (query.stopAtId === undefined && query.stopAtType === undefined && path[0]?.parent_id !== null) {
		throw new SessionError("invalid_entry", `Entry ${path[0]?.parent_id} not found`);
	}
	for (let index = 1; index < path.length; index++) {
		const previous = path[index - 1]!;
		const current = path[index]!;
		if (current.parent_id !== previous.id) {
			throw new SessionError("invalid_entry", `Entry ${current.parent_id} not found`);
		}
	}
}

function matchesEntryQuery(entry: Entry, query: EntryQuery): boolean {
	return (
		(query.type === undefined || entry.type === query.type) &&
		(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)) &&
		(query.cursor === undefined ||
			(query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq))
	);
}

function addUsage(stats: SessionStats, usage: Usage): void {
	stats.cachedTokens += usage.cacheRead;
	stats.uncachedTokens += usage.input + usage.cacheWrite;
	stats.totalTokens += usage.totalTokens;
	stats.costTotal += usage.cost.total;
}

function emptyStats(): SessionStats {
	return { messageCount: 0, cachedTokens: 0, uncachedTokens: 0, totalTokens: 0, costTotal: 0 };
}

async function assertUnusedId(db: SqliteDatabase, sessionId: string, id: string): Promise<void> {
	if ((await idExistsInEntries(db, sessionId, id)) || (await idExistsInRecords(db, sessionId, id))) {
		throw new SessionError("already_exists", `ID already exists: ${id}`);
	}
}

async function requireSessionRow(db: SqliteDatabase, sessionId: string): Promise<SessionRow> {
	const row = await readSessionRow(db, sessionId);
	if (!row) throw new SessionError("not_found", `Session not found: ${sessionId}`);
	return row;
}

class SqliteSessionStorage implements SessionStorage<SqliteSessionMetadata> {
	private readonly db: SqliteDatabase;
	private readonly metadata: SqliteSessionMetadata;
	private readonly operations = new SerialOperationQueue();

	constructor(db: SqliteDatabase, metadata: SqliteSessionMetadata) {
		this.db = db;
		this.metadata = metadata;
	}

	async getMetadata(): Promise<SqliteSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
		return (await readLanes(this.db, this.metadata.id)).map((row) => ({ lane: row.lane, leafId: row.leaf_id }));
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		return this.operations.enqueue(async () => {
			if (await readLane(this.db, this.metadata.id, lane)) {
				throw new SessionError("already_exists", `Lane already exists: ${lane}`);
			}
			if (at !== null && !(await this.getEntry(at))) throw new SessionError("not_found", `Entry not found: ${at}`);
			await this.db.transaction(async () => {
				const seq = await getNextSequence(this.db, this.metadata.id);
				await insertLane(this.db, this.metadata.id, seq, lane, at);
				await advanceSequence(this.db, this.metadata.id, seq);
			});
		});
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		return this.operations.enqueue(async () => {
			if (!(await readLane(this.db, this.metadata.id, lane)))
				throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
			if (to !== null && !(await this.getEntry(to))) throw new SessionError("not_found", `Entry not found: ${to}`);
			await this.db.transaction(async () => {
				const seq = await getNextSequence(this.db, this.metadata.id);
				await updateLane(this.db, this.metadata.id, seq, lane, to);
				await advanceSequence(this.db, this.metadata.id, seq);
			});
		});
	}

	async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.operations.enqueue(async () => {
			let committed: Entry | undefined;
			await this.db.transaction(async () => {
				const parentId = (await readLaneHead(this.db, this.metadata.id, lane)).leafId;
				await assertUnusedId(this.db, this.metadata.id, entry.id);
				const seq = await getNextSequence(this.db, this.metadata.id);
				committed = { ...entry, parentId, seq, timestamp: Date.now() } as Entry;
				await insertEntryRow(this.db, this.metadata.id, {
					seq,
					id: committed.id,
					parentId: committed.parentId,
					type: committed.type,
					timestamp: timestampToText(committed.timestamp),
					payload: JSON.stringify(entryPayload(committed)),
				});
				await setLaneLeaf(this.db, this.metadata.id, lane, committed.id);
				await appendEntryToBranchCache(
					this.db,
					this.metadata.id,
					committed.id,
					seq,
					committed.type,
					committed.type === "custom" ? committed.customType : null,
					committed.parentId,
				);
				await advanceSequence(this.db, this.metadata.id, seq);
			});
			return structuredClone(committed as TEntry);
		});
	}

	async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
	async appendRecord(record: NewRecord): Promise<LaneRecord> {
		return this.operations.enqueue(async () => {
			let committed: LaneRecord | undefined;
			await this.db.transaction(async () => {
				if (!(await readLane(this.db, this.metadata.id, record.lane))) {
					throw new SessionError("invalid_lane", `Lane not found: ${record.lane}`);
				}
				await assertUnusedId(this.db, this.metadata.id, record.id);
				const seq = await getNextSequence(this.db, this.metadata.id);
				committed = { ...record, seq, timestamp: Date.now() };
				await appendRecordRow(this.db, this.metadata.id, {
					seq,
					id: record.id,
					lane: record.lane,
					runId: recordRunId(record),
					type: record.type,
					opKind: recordOpKind(record),
					timestamp: timestampToText(committed.timestamp),
					payload: JSON.stringify(record),
				});
				await advanceSequence(this.db, this.metadata.id, seq);
			});
			if (!committed) throw new SessionError("storage", "SQLite record append did not commit");
			return structuredClone(committed);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const row = await readEntryRow(this.db, this.metadata.id, id);
		return row ? decodeEntry(row) : undefined;
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		const rows = await readEntryRows(this.db, this.metadata.id, { order: query.order });
		const entries = rows.map(decodeEntry).filter((entry) => matchesEntryQuery(entry, query));
		return structuredClone(query.limit === undefined ? entries : entries.slice(0, query.limit));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		const cached = await readCachedBranch(this.db, this.metadata.id, query.start);
		if (!cached) {
			if (!(await this.getEntry(query.start)))
				throw new SessionError("not_found", `Entry not found: ${query.start}`);
			throw new SessionError("invalid_entry", `Branch cache missing entry ${query.start}`);
		}
		const rows = await queryCachedBranchRows(this.db, this.metadata.id, cached, query);
		validateCachedBranchRows(rows, query);
		const entries = rows
			.map(entryRowFromCached)
			.map(decodeEntry)
			.filter((entry) => matchesEntryQuery(entry, query));
		return structuredClone(query.limit === undefined ? entries : entries.slice(0, query.limit));
	}

	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		const rows = await readRecordRows(this.db, this.metadata.id, query);
		return structuredClone(rows.map(decodeRecord));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		const afterSeq = options.afterSeq ?? 0;
		const entryRows = await readEntryRows(this.db, this.metadata.id, { afterSeq, order: "oldestFirst" });
		const recordRows = await readRecordRows(this.db, this.metadata.id, { afterSeq });
		const laneRows = await readLaneMoveRows(this.db, this.metadata.id, { afterSeq });
		const factRows = await readFactRows(this.db, this.metadata.id, { afterSeq });

		const log: LogItem[] = [
			...entryRows.map((row) => ({ kind: "entry" as const, seq: row.seq, entry: decodeEntry(row) })),
			...recordRows.map((row) => ({ kind: "record" as const, seq: row.seq, record: decodeRecord(row) })),
			...laneRows.map((row) => ({ kind: "lane" as const, seq: row.seq, lane: row.lane, leafId: row.leaf_id })),
			...factRows.map((row) => {
				if (row.kind === "name")
					return {
						kind: "fact" as const,
						seq: row.seq,
						fact: "name" as const,
						name: JSON.parse(row.value ?? "null") as string,
					};
				return {
					kind: "fact" as const,
					seq: row.seq,
					fact: "label" as const,
					targetId: row.key ?? "",
					label: row.value === null ? undefined : (JSON.parse(row.value) as string),
				};
			}),
		].sort((left, right) => left.seq - right.seq);
		return structuredClone(options.limit === undefined ? log : log.slice(0, options.limit));
	}

	async getName(): Promise<string | undefined> {
		const row = await readLatestFact(this.db, this.metadata.id, "name", null);
		return row?.value === undefined || row.value === null ? undefined : (JSON.parse(row.value) as string);
	}

	async setName(name: string): Promise<void> {
		return this.operations.enqueue(async () => {
			await this.db.transaction(async () => {
				const seq = await getNextSequence(this.db, this.metadata.id);
				await appendFact(this.db, this.metadata.id, seq, "name", null, JSON.stringify(name));
				await advanceSequence(this.db, this.metadata.id, seq);
			});
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		const row = await readLatestFact(this.db, this.metadata.id, "label", id);
		return row?.value === undefined || row.value === null ? undefined : (JSON.parse(row.value) as string);
	}

	async setLabel(id: string, label: string | undefined): Promise<void> {
		return this.operations.enqueue(async () => {
			if (!(await this.getEntry(id))) throw new SessionError("not_found", `Entry not found: ${id}`);
			await this.db.transaction(async () => {
				const seq = await getNextSequence(this.db, this.metadata.id);
				await appendFact(
					this.db,
					this.metadata.id,
					seq,
					"label",
					id,
					label === undefined ? null : JSON.stringify(label),
				);
				await advanceSequence(this.db, this.metadata.id, seq);
			});
		});
	}

	async getStats(): Promise<SessionStats> {
		const stats = emptyStats();
		stats.messageCount = await countMessageEntries(this.db, this.metadata.id);
		for (const record of await this.findRecords({ type: "usage", order: "oldestFirst" })) {
			if (record.type === "usage") addUsage(stats, record.usage);
		}
		return stats;
	}
}

async function loadStorage(db: SqliteDatabase, metadata: SqliteSessionMetadata): Promise<SqliteSessionStorage> {
	const row = await requireSessionRow(db, metadata.id);
	await readLanes(db, metadata.id);
	return new SqliteSessionStorage(db, metadataFromRow(row, metadata.path));
}

function metadataFromRow(row: SessionRow, path: string): SqliteSessionMetadata {
	const base = rowToMetadata(row, path);
	return { ...base, createdAt: Date.parse(base.createdAt) };
}

export class SqliteSessionRepository
	implements SessionRepository<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
{
	private databasePath: string | undefined;
	private database: SqliteDatabase | undefined;
	private databasePromise: Promise<SqliteDatabase> | undefined;
	private readonly operations = new SerialOperationQueue();

	private readonly options: SqliteSessionRepositoryOptions;

	constructor(options: SqliteSessionRepositoryOptions) {
		this.options = options;
	}

	async create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const path = await this.getDatabasePath();
			const id = options.id ?? uuidv7();
			if (await sessionExists(db, id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
			const createdAt = Date.now();
			await db.transaction(async () => {
				await insertSessionRow(db, {
					id,
					createdAt: timestampToText(createdAt),
					cwd: options.cwd,
					parentSessionId: options.parentSessionId,
					metadata: options.metadata,
				});
				await createSequence(db, id);
				await createInitialLane(db, id);
			});
			return new Session(
				await loadStorage(db, {
					id,
					createdAt,
					cwd: options.cwd,
					path,
					parentSessionId: options.parentSessionId,
					metadata: options.metadata,
				}),
			);
		});
	}

	async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		return new Session(await this.operations.enqueue(async () => loadStorage(await this.getDatabase(), metadata)));
	}

	/** Rebuilds this session's private branch-read cache from canonical entry parent links. */
	async repairBranchCache(metadata: SqliteSessionMetadata): Promise<void> {
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			await requireSessionRow(db, metadata.id);
			await db.transaction(async () => {
				await rebuildBranchCache(db, metadata.id);
			});
		});
	}

	async list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		return this.operations.enqueue(async () => {
			const path = await this.getDatabasePath();
			if (!resultOrThrow(await this.options.env.exists(path), `Failed to check database ${path}`)) return [];
			const db = await this.getDatabase();
			const rows = await readSessionRows(db, options);
			return rows.map((row) => metadataFromRow(row, path));
		});
	}

	async delete(metadata: SqliteSessionMetadata): Promise<void> {
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			await db.transaction(async () => {
				await deleteBranchCache(db, metadata.id);
				await deleteFactRows(db, metadata.id);
				await deleteLaneRows(db, metadata.id);
				await deleteRecordRows(db, metadata.id);
				await deleteEntryRows(db, metadata.id);
				await deleteLease(db, metadata.id);
				await deleteSequence(db, metadata.id);
				await deleteSessionRow(db, metadata.id);
			});
		});
	}

	async fork(
		source: SqliteSessionMetadata,
		options: ForkOptions & SqliteSessionCreateOptions,
	): Promise<Session<SqliteSessionMetadata>> {
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const path = await this.getDatabasePath();
			const sourceMetadata = metadataFromRow(await requireSessionRow(db, source.id), path);
			const id = options.id ?? uuidv7();
			if (await sessionExists(db, id)) throw new SessionError("already_exists", `Session already exists: ${id}`);

			const entries: EntryRow[] = [];
			const lanes: { lane: string; leafId: string | null }[] = [];
			const branchTips: string[] = [];
			let branchForkTargetId: string | null = null;

			if (options.scope === "tree") {
				entries.push(...(await readEntryRows(db, source.id, { order: "oldestFirst" })));
				lanes.push(...(await readLanes(db, source.id)).map((row) => ({ lane: row.lane, leafId: row.leaf_id })));
				branchTips.push(...(await readBranchTipIds(db, source.id)));
			} else {
				const main = await readLane(db, source.id, "main");
				if (!main) throw new SessionError("invalid_lane", "Lane not found: main");
				const selectedEntryId = options.entryId ?? main.leaf_id;
				if (selectedEntryId !== null) {
					const target = await readEntryRow(db, source.id, selectedEntryId);
					if (!target || target.type !== "message") {
						throw new SessionError(
							"invalid_fork_target",
							`Fork target is not a message entry: ${selectedEntryId}`,
						);
					}
					const position = options.position ?? (options.entryId === undefined ? "at" : "before");
					branchForkTargetId = position === "at" ? target.id : target.parent_id;
				}
				lanes.push({ lane: "main", leafId: branchForkTargetId });
				if (branchForkTargetId !== null) {
					const cached = await readCachedBranch(db, source.id, branchForkTargetId);
					if (!cached) {
						throw new SessionError(
							"invalid_fork_target",
							`Fork target is not on a cached branch: ${branchForkTargetId}`,
						);
					}
					const rows = await queryCachedBranchRows(db, source.id, cached, { order: "oldestFirst" });
					entries.push(...rows.map(entryRowFromCached));
					branchTips.push(branchForkTargetId);
				}
			}

			const copiedIds = new Set(entries.map((entry) => entry.id));
			const latestName = await readLatestFact(db, source.id, "name", null);
			const latestLabels = await readLatestLabelFacts(db, source.id);
			const labelsToCopy = latestLabels.filter(
				(row) => options.scope === "tree" || (row.key !== null && copiedIds.has(row.key)),
			);
			const createdAt = Date.now();
			const metadata = options.metadata ?? sourceMetadata.metadata;

			try {
				await db.transaction(async () => {
					await insertSessionRow(db, {
						id,
						createdAt: timestampToText(createdAt),
						cwd: options.cwd,
						parentSessionId: options.parentSessionId ?? source.id,
						metadata,
					});
					await createSequence(db, id);

					let nextSeq = 1;
					const allocateSeq = () => nextSeq++;
					for (const entry of entries) {
						await insertEntryRow(db, id, {
							seq: allocateSeq(),
							id: entry.id,
							parentId: entry.parent_id,
							type: entry.type,
							timestamp: entry.timestamp,
							payload: entry.payload,
						});
					}

					if (options.scope === "tree") {
						for (const lane of lanes) await insertLane(db, id, allocateSeq(), lane.lane, lane.leafId);
					} else {
						await createInitialLane(db, id, "main", branchForkTargetId);
					}

					if (latestName?.value !== undefined && latestName.value !== null) {
						await appendFact(db, id, allocateSeq(), "name", null, latestName.value);
					}
					for (const label of labelsToCopy)
						await appendFact(db, id, allocateSeq(), "label", label.key, label.value);

					await setNextSequence(db, id, nextSeq);
					for (const tip of branchTips) await buildCachedBranch(db, id, tip);
				});
			} catch (error) {
				if (error instanceof SessionError) throw error;
				throw new SessionError(
					"storage",
					`Failed to fork SQLite session ${id}`,
					error instanceof Error ? error : undefined,
				);
			}

			return new Session(
				await loadStorage(db, {
					id,
					createdAt,
					cwd: options.cwd,
					path,
					parentSessionId: options.parentSessionId ?? source.id,
					metadata,
				}),
			);
		});
	}

	async close(): Promise<void> {
		await this.operations.drain();
		if (this.database) await this.database.close();
		this.database = undefined;
		this.databasePromise = undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	private async getDatabasePath(): Promise<string> {
		this.databasePath ??= resultOrThrow(
			await this.options.env.absolutePath(this.options.databasePath),
			`Failed to resolve SQLite sessions database ${this.options.databasePath}`,
		);
		return this.databasePath;
	}

	private async getDatabase(): Promise<SqliteDatabase> {
		if (!this.databasePromise) this.databasePromise = this.openDatabase();
		this.database = await this.databasePromise;
		return this.database;
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		resultOrThrow(
			await this.options.env.createDir(getParentPath(path), { recursive: true }),
			`Failed to create SQLite sessions directory ${path}`,
		);
		const db = await this.options.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			await applyMigrations(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}
}
