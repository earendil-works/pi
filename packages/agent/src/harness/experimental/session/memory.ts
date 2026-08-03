import { uuidv7 } from "@earendil-works/pi-ai";
import { Session } from "./session.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryOrder,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type ProvisionedEntry,
	type RecordQuery,
	type SessionCreateOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepository,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

function* ordered<T>(items: readonly T[], order: EntryOrder | undefined): IterableIterator<T> {
	if (order === "oldestFirst") {
		yield* items;
		return;
	}
	for (let index = items.length - 1; index >= 0; index--) yield items[index]!;
}

function provisionEntry<TEntry extends Entry>(
	newEntry: ProvisionedEntry<TEntry>,
	parentId: string | null,
	seq: number,
): TEntry {
	// Object spread does not preserve the correlation between a discriminant and the rest of a union member.
	return { ...newEntry, parentId, seq, timestamp: Date.now() } as unknown as TEntry;
}

function provisionRecord(newRecord: NewRecord, seq: number): LaneRecord {
	// Object spread does not preserve the correlation between a discriminant and the rest of a union member.
	return { ...newRecord, seq, timestamp: Date.now() } as LaneRecord;
}

export class InMemorySessionStorage implements SessionStorage {
	private readonly metadata: SessionMetadata;
	private sequence = 0;
	private readonly usedIds = new Set<string>();
	private readonly entries: Entry[] = [];
	private readonly entriesById = new Map<string, Entry>();
	private readonly laneByEntryId = new Map<string, string>();
	private readonly records: LaneRecord[] = [];
	private readonly lanes = new Map<string, string | null>([["main", null]]);
	private readonly log: LogItem[] = [];
	private name: string | undefined;
	private readonly labels = new Map<string, string>();

	constructor(metadata: SessionMetadata) {
		this.metadata = structuredClone(metadata);
	}

	fork(metadata: SessionMetadata, options: ForkOptions & SessionCreateOptions): InMemorySessionStorage {
		const storage = new InMemorySessionStorage(metadata);
		let copiedEntries: Entry[];
		if (options.scope === "tree") {
			copiedEntries = this.entries;
			storage.lanes.clear();
			for (const [lane, leafId] of this.lanes) storage.lanes.set(lane, leafId);
		} else {
			let targetId: string | null;
			if (options.entryId === undefined) {
				targetId = this.lanes.get("main") ?? null;
			} else {
				const target = this.entriesById.get(options.entryId);
				if (!target || target.type !== "message") {
					throw new SessionError("invalid_fork_target", `Fork target is not a message entry: ${options.entryId}`);
				}
				targetId = (options.position ?? "before") === "at" ? target.id : target.parentId;
			}
			copiedEntries = [...this.walkToRoot(targetId)].reverse();
			storage.lanes.set("main", targetId);
		}

		const copiedIds = new Set(copiedEntries.map((entry) => entry.id));
		for (const sourceEntry of copiedEntries) {
			const entry = structuredClone(sourceEntry);
			entry.seq = storage.nextSequence();
			const lane = options.scope === "tree" ? this.requireEntryLane(sourceEntry.id) : "main";
			storage.entries.push(entry);
			storage.entriesById.set(entry.id, entry);
			storage.laneByEntryId.set(entry.id, lane);
			storage.usedIds.add(entry.id);
			storage.log.push({ kind: "entry", seq: entry.seq, lane, entry });
		}
		if (this.name !== undefined) {
			storage.name = this.name;
			storage.log.push({ kind: "fact", seq: storage.nextSequence(), fact: "name", name: this.name });
		}
		for (const [targetId, label] of this.labels) {
			if (!copiedIds.has(targetId)) continue;
			storage.labels.set(targetId, label);
			storage.log.push({ kind: "fact", seq: storage.nextSequence(), fact: "label", targetId, label });
		}
		return storage;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return [...this.lanes].map(([lane, leafId]) => ({ lane, leafId }));
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		if (this.lanes.has(lane)) throw new SessionError("already_exists", `Lane already exists: ${lane}`);
		this.validateTarget(at);
		this.lanes.set(lane, at);
		this.log.push({ kind: "lane", seq: this.nextSequence(), lane, action: "create", leafId: at });
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		this.requireLane(lane);
		this.validateTarget(to);
		this.lanes.set(lane, to);
		this.log.push({ kind: "lane", seq: this.nextSequence(), lane, action: "move", leafId: to });
	}

	async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		const parentId = this.requireLane(lane);
		this.validateUnusedId(newEntry.id);
		const clonedEntry = structuredClone(newEntry);
		const entry = provisionEntry(clonedEntry, parentId, this.nextSequence());
		this.usedIds.add(entry.id);
		this.entries.push(entry);
		this.entriesById.set(entry.id, entry);
		this.laneByEntryId.set(entry.id, lane);
		this.lanes.set(lane, entry.id);
		this.log.push({ kind: "entry", seq: entry.seq, lane, entry });
		return structuredClone(entry);
	}

	async appendRecord(newRecord: NewRecord): Promise<LaneRecord> {
		this.requireLane(newRecord.lane);
		this.validateUnusedId(newRecord.id);
		const clonedRecord = structuredClone(newRecord);
		const record = provisionRecord(clonedRecord, this.nextSequence());
		this.usedIds.add(record.id);
		this.records.push(record);
		this.log.push({ kind: "record", seq: record.seq, record });
		return structuredClone(record);
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.entriesById.get(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		assertValidLimit(query.limit);
		this.validateCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		for (const entry of ordered(this.entries, query.order)) {
			if (!this.matchesEntryQuery(entry, query)) continue;
			results.push(entry);
			if (results.length === query.limit) break;
		}
		return structuredClone(results);
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		assertValidLimit(query.limit);
		this.validateCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		if (query.order === "oldestFirst") {
			for (const entry of [...this.walkToRoot(query.start)].reverse()) {
				const reachedBound = entry.id === query.stopAtId || entry.type === query.stopAtType;
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (reachedBound || results.length === query.limit) break;
			}
		} else {
			for (const entry of this.walkToRoot(query.start, query)) {
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (results.length === query.limit) break;
			}
		}
		return structuredClone(results);
	}

	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		assertValidLimit(query.limit);
		if (query.afterSeq !== undefined) this.validateCursor(query.afterSeq);
		const results: LaneRecord[] = [];
		for (const record of ordered(this.records, query.order)) {
			if (!this.matchesRecordQuery(record, query)) continue;
			results.push(record);
			if (results.length === query.limit) break;
		}
		return structuredClone(results);
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		assertValidLimit(options.limit);
		if (options.afterSeq !== undefined) this.validateCursor(options.afterSeq);
		const results: LogItem[] = [];
		for (const item of this.log) {
			if (options.afterSeq !== undefined && item.seq <= options.afterSeq) continue;
			results.push(item);
			if (results.length === options.limit) break;
		}
		return structuredClone(results);
	}

	async getName(): Promise<string | undefined> {
		return this.name;
	}

	async setName(name: string): Promise<void> {
		this.name = name;
		this.log.push({ kind: "fact", seq: this.nextSequence(), fact: "name", name });
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labels.get(id);
	}

	async setLabel(id: string, label: string | undefined): Promise<void> {
		this.validateTarget(id);
		if (label === undefined) this.labels.delete(id);
		else this.labels.set(id, label);
		this.log.push({ kind: "fact", seq: this.nextSequence(), fact: "label", targetId: id, label });
	}

	async getStats(): Promise<SessionStats> {
		const stats: SessionStats = {
			messageCount: 0,
			cachedTokens: 0,
			uncachedTokens: 0,
			totalTokens: 0,
			costTotal: 0,
		};
		for (const entry of this.entries) {
			if (entry.type === "message") stats.messageCount += 1;
			const usage =
				entry.type === "message"
					? entry.message.role === "assistant"
						? entry.message.usage
						: undefined
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined;
			if (!usage) continue;
			stats.cachedTokens += usage.cacheRead;
			stats.uncachedTokens += usage.input + usage.cacheWrite;
			stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			stats.costTotal += usage.cost.total;
		}
		return stats;
	}

	private nextSequence(): number {
		return ++this.sequence;
	}

	private requireLane(lane: string): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return leafId;
	}

	private requireEntryLane(entryId: string): string {
		const lane = this.laneByEntryId.get(entryId);
		if (lane === undefined) {
			throw new SessionError("invalid_entry", `Entry has no originating lane: ${entryId}`);
		}
		return lane;
	}

	private validateTarget(targetId: string | null): void {
		if (targetId !== null && !this.entriesById.has(targetId)) {
			throw new SessionError("not_found", `Entry not found: ${targetId}`);
		}
	}

	private validateUnusedId(id: string): void {
		if (this.usedIds.has(id)) throw new SessionError("already_exists", `Session id already exists: ${id}`);
	}

	private validateCursor(afterSeq: number | undefined): void {
		if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
			throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
		}
	}

	private *walkToRoot(
		start: string | null,
		bounds?: Pick<BranchBounds, "stopAtId" | "stopAtType">,
	): IterableIterator<Entry> {
		if (start === null) return;
		const visited = new Set<string>();
		let current = this.entriesById.get(start);
		if (!current) throw new SessionError("not_found", `Entry not found: ${start}`);
		while (current) {
			if (visited.has(current.id)) {
				throw new SessionError("invalid_entry", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			yield current;
			if (current.id === bounds?.stopAtId || current.type === bounds?.stopAtType) break;
			if (current.parentId === null) break;
			const parentId: string = current.parentId;
			current = this.entriesById.get(parentId);
			if (!current) throw new SessionError("invalid_entry", `Entry not found: ${parentId}`);
		}
	}

	private matchesEntryQuery(entry: Entry, query: EntryQuery): boolean {
		return (
			(query.type === undefined || entry.type === query.type) &&
			(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)) &&
			(query.cursor === undefined ||
				(query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq))
		);
	}

	private matchesRecordQuery(record: LaneRecord, query: RecordQuery): boolean {
		return (
			(query.lane === undefined || record.lane === query.lane) &&
			(query.type === undefined || record.type === query.type) &&
			(query.runId === undefined ||
				(record.type === "operation_started"
					? record.id === query.runId
					: "runId" in record && record.runId === query.runId)) &&
			(query.afterSeq === undefined || record.seq > query.afterSeq)
		);
	}
}

export class InMemorySessionRepository implements SessionRepository {
	private readonly sessions = new Map<string, InMemorySessionStorage>();

	async create(options: SessionCreateOptions = {}): Promise<Session> {
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = new InMemorySessionStorage({
			id,
			createdAt: Date.now(),
			parentSessionId: options.parentSessionId,
		});
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	async open(metadata: SessionMetadata): Promise<Session> {
		return new Session(this.requireStorage(metadata.id));
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	async fork(source: SessionMetadata, options: ForkOptions & SessionCreateOptions = {}): Promise<Session> {
		const sourceStorage = this.requireStorage(source.id);
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = sourceStorage.fork(
			{ id, createdAt: Date.now(), parentSessionId: options.parentSessionId ?? source.id },
			options,
		);
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	private requireStorage(id: string): InMemorySessionStorage {
		const storage = this.sessions.get(id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${id}`);
		return storage;
	}
}
