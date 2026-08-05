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
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

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

function provisionRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>, seq: number): TRecord {
	// Object spread does not preserve the correlation between a discriminant and the rest of a union member.
	return { ...newRecord, seq, timestamp: Date.now() } as unknown as TRecord;
}

export class InMemorySessionStorage implements SessionStorage {
	private readonly metadata: SessionMetadata;
	private sequence = 0;
	private readonly usedIds = new Set<string>();
	private readonly entries: Entry[] = [];
	private readonly entriesById = new Map<string, Entry>();
	private readonly records: LaneRecord[] = [];
	private readonly lanes = new Map<string, string | null>([["main", null]]);
	private readonly log: LogItem[] = [];
	private readonly stats: SessionStats = {
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
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
			const selectedEntryId = options.entryId ?? this.lanes.get("main") ?? null;
			let targetId: string | null = null;
			if (selectedEntryId !== null) {
				const target = this.entriesById.get(selectedEntryId);
				if (!target || target.type !== "message") {
					throw new SessionError("invalid_fork_target", `Fork target is not a message entry: ${selectedEntryId}`);
				}
				const position = options.position ?? (options.entryId === undefined ? "at" : "before");
				targetId = position === "at" ? target.id : target.parentId;
			}
			copiedEntries = [...this.walkToRoot(targetId)].reverse();
			storage.lanes.set("main", targetId);
		}

		const copiedIds = new Set(copiedEntries.map((entry) => entry.id));
		for (const sourceEntry of copiedEntries) {
			const entry = structuredClone(sourceEntry);
			entry.seq = storage.nextSequence();
			storage.entries.push(entry);
			storage.entriesById.set(entry.id, entry);
			storage.usedIds.add(entry.id);
			storage.log.push({ kind: "entry", seq: entry.seq, entry });
			if (entry.type === "message") storage.stats.messageCount += 1;
		}
		for (const [lane, leafId] of options.scope === "tree" ? this.lanes : []) {
			storage.log.push({ kind: "lane", seq: storage.nextSequence(), lane, leafId });
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
		this.log.push({ kind: "lane", seq: this.nextSequence(), lane, leafId: at });
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		this.requireLane(lane);
		this.validateTarget(to);
		this.lanes.set(lane, to);
		this.log.push({ kind: "lane", seq: this.nextSequence(), lane, leafId: to });
	}

	async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		const parentId = this.requireLane(lane);
		this.validateUnusedId(newEntry.id);
		const clonedEntry = structuredClone(newEntry);
		const entry = provisionEntry(clonedEntry, parentId, this.nextSequence());
		this.usedIds.add(entry.id);
		this.entries.push(entry);
		this.entriesById.set(entry.id, entry);
		this.lanes.set(lane, entry.id);
		this.log.push({ kind: "entry", seq: entry.seq, entry });
		if (entry.type === "message") this.stats.messageCount += 1;
		return structuredClone(entry);
	}

	async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		this.requireLane(newRecord.lane);
		this.validateUnusedId(newRecord.id);
		const clonedRecord = structuredClone(newRecord);
		const record = provisionRecord(clonedRecord, this.nextSequence());
		this.usedIds.add(record.id);
		this.records.push(record);
		this.log.push({ kind: "record", seq: record.seq, record });
		if (record.type === "usage") {
			this.stats.cachedTokens += record.usage.cacheRead;
			this.stats.uncachedTokens += record.usage.input + record.usage.cacheWrite;
			this.stats.totalTokens += record.usage.totalTokens;
			this.stats.costTotal += record.usage.cost.total;
		}
		return structuredClone(record);
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.entriesById.get(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		const results: Entry[] = [];
		for (const entry of ordered(this.entries, query.order)) {
			if (!this.matchesEntryQuery(entry, query)) continue;
			results.push(entry);
			if (results.length === query.limit) break;
		}
		return structuredClone(results);
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
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

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		const results: LaneRecord[] = [];
		for (const record of ordered(this.records, query.order)) {
			if (!this.matchesRecordQuery(record, query)) continue;
			results.push(record);
			if (results.length === query.limit) break;
		}
		return structuredClone(results);
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
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
		return structuredClone(this.stats);
	}

	private nextSequence(): number {
		return ++this.sequence;
	}

	private requireLane(lane: string): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return leafId;
	}

	private validateTarget(targetId: string | null): void {
		if (targetId !== null && !this.entriesById.has(targetId)) {
			throw new SessionError("not_found", `Entry not found: ${targetId}`);
		}
	}

	private validateUnusedId(id: string): void {
		if (this.usedIds.has(id)) throw new SessionError("already_exists", `Session id already exists: ${id}`);
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

export class InMemorySessionRepo implements SessionRepo {
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
