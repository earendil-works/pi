import { uuidv7 } from "@earendil-works/pi-ai";
import type { FileError, FileSystem, Result } from "../types.ts";
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
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	type SessionCreateOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

export type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

export interface JsonlSessionRepoOptions {
	fs: JsonlSessionRepoFileSystem;
	sessionsRoot: string;
	cwd?: string;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd?: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	path: string;
	cwd: string;
}

interface HeaderLine {
	kind: "header";
	version: 4;
	id: string;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
}

type DecodedMutation =
	| { kind: "entry"; lane: string; entry: Entry }
	| { kind: "record"; record: LaneRecord }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

const ENTRY_TYPES = new Set<Entry["type"]>([
	"message",
	"model_change",
	"thinking_level_change",
	"active_tools_change",
	"compaction",
	"branch_summary",
	"custom",
]);
const RECORD_TYPES = new Set<LaneRecord["type"]>([
	"operation_started",
	"abort_requested",
	"operation_finished",
	"step_attempt",
	"tool_started",
	"queue_enqueued",
	"queue_cancelled",
	"write_deferred",
	"usage",
]);

function fileResult<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		throw new SessionError(
			result.error.code === "not_found" ? "not_found" : "storage",
			`${message}: ${result.error.message}`,
			result.error,
		);
	}
	return result.value;
}

function invalidFile(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL v4 session ${path}: line ${line} ${message}`, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string, path: string, lineNumber: number): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidFile(path, lineNumber, "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw invalidFile(path, lineNumber, "is not a JSON object");
	return value;
}

function requireString(value: unknown, path: string, line: number, field: string): string {
	if (typeof value !== "string") throw invalidFile(path, line, `has invalid ${field}`);
	return value;
}

function requireSequence(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalidFile(path, line, "has invalid seq");
	return value as number;
}

function requireTimestamp(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidFile(path, line, "has invalid timestamp");
	return value as number;
}

function requireNullableId(value: unknown, path: string, line: number, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw invalidFile(path, line, `has invalid ${field}`);
	}
	return value as string | null;
}

function parseHeader(line: string, path: string): HeaderLine {
	const value = parseObject(line, path, 1);
	if (value.kind !== "header") throw invalidFile(path, 1, "is not a header");
	if (value.version !== 4) throw invalidFile(path, 1, "has unsupported session version");
	const parentSessionId = value.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string") {
		throw invalidFile(path, 1, "has invalid parentSessionId");
	}
	return {
		kind: "header",
		version: 4,
		id: requireString(value.id, path, 1, "id"),
		createdAt: requireTimestamp(value.createdAt, path, 1),
		cwd: requireString(value.cwd, path, 1, "cwd"),
		parentSessionId,
	};
}

function parseMutation(line: string, path: string, lineNumber: number): DecodedMutation {
	const value = parseObject(line, path, lineNumber);
	const seq = requireSequence(value.seq, path, lineNumber);
	switch (value.kind) {
		case "entry": {
			const lane = requireString(value.lane, path, lineNumber, "lane");
			const id = requireString(value.id, path, lineNumber, "id");
			const type = requireString(value.type, path, lineNumber, "entry type");
			if (!ENTRY_TYPES.has(type as Entry["type"]))
				throw invalidFile(path, lineNumber, `has unknown entry type ${type}`);
			const parentId = requireNullableId(value.parentId, path, lineNumber, "parentId");
			const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
			const { kind: _kind, lane: _lane, ...entryFields } = value;
			return {
				kind: "entry",
				lane,
				entry: { ...entryFields, id, type, parentId, seq, timestamp } as unknown as Entry,
			};
		}
		case "record": {
			const id = requireString(value.id, path, lineNumber, "id");
			const lane = requireString(value.lane, path, lineNumber, "lane");
			const type = requireString(value.type, path, lineNumber, "record type");
			if (!RECORD_TYPES.has(type as LaneRecord["type"]))
				throw invalidFile(path, lineNumber, `has unknown record type ${type}`);
			const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
			const { kind: _kind, ...recordFields } = value;
			return {
				kind: "record",
				record: { ...recordFields, id, lane, type, seq, timestamp } as unknown as LaneRecord,
			};
		}
		case "lane":
			return {
				kind: "lane",
				seq,
				lane: requireString(value.lane, path, lineNumber, "lane"),
				leafId: requireNullableId(value.leafId, path, lineNumber, "leafId"),
			};
		case "fact":
			if (value.fact === "name") {
				return { kind: "fact", seq, fact: "name", name: requireString(value.name, path, lineNumber, "name") };
			}
			if (value.fact === "label") {
				if (value.label !== undefined && typeof value.label !== "string") {
					throw invalidFile(path, lineNumber, "has invalid label");
				}
				return {
					kind: "fact",
					seq,
					fact: "label",
					targetId: requireString(value.targetId, path, lineNumber, "targetId"),
					label: value.label,
				};
			}
			throw invalidFile(path, lineNumber, "has unknown fact type");
		default:
			throw invalidFile(path, lineNumber, "has unknown mutation kind");
	}
}

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

function encodeMutation(mutation: DecodedMutation): string {
	switch (mutation.kind) {
		case "entry":
			return `${JSON.stringify({ kind: "entry", lane: mutation.lane, ...mutation.entry })}\n`;
		case "record":
			return `${JSON.stringify({ kind: "record", ...mutation.record })}\n`;
		case "lane":
			return `${JSON.stringify(mutation)}\n`;
		case "fact":
			return `${JSON.stringify(mutation)}\n`;
	}
}

class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private sequence = 0;
	private readonly usedIds = new Set<string>();
	private readonly entries: Entry[] = [];
	private readonly entriesById = new Map<string, Entry>();
	private readonly entryLanes = new Map<string, string>();
	private readonly records: LaneRecord[] = [];
	private readonly openOperationsByLane = new Map<string, Map<string, OperationStartedRecord>>();
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
	private tail: Promise<void> = Promise.resolve();

	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
	}

	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) throw invalidFile(path, 1, "is missing a header");
		const header = parseHeader(physicalLines[0], path);
		const storage = new JsonlSessionStorage(fs, {
			id: header.id,
			createdAt: header.createdAt,
			parentSessionId: header.parentSessionId,
			path,
			cwd: header.cwd,
		});
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			let mutation: DecodedMutation;
			try {
				mutation = parseMutation(line, path, index + 1);
			} catch (error) {
				if (index !== physicalLines.length - 1 || !(error instanceof SessionError) || error.cause === undefined)
					throw error;
				const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
				fileResult(await fs.writeFile(path, validPrefix), `Failed to truncate torn session tail ${path}`);
				return storage;
			}
			storage.applyMutation(mutation, path, index + 1, false);
		}
		if (!content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
		}
		return storage;
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return [...this.lanes].map(([lane, leafId]) => ({ lane, leafId }));
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			if (this.lanes.has(lane)) throw new SessionError("already_exists", `Lane already exists: ${lane}`);
			this.validateTarget(at);
			const mutation: DecodedMutation = { kind: "lane", seq: this.sequence + 1, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.requireLane(lane);
			this.validateTarget(to);
			const mutation: DecodedMutation = { kind: "lane", seq: this.sequence + 1, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.requireLane(lane);
			this.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.sequence + 1,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: DecodedMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendCopiedEntry<TEntry extends Entry>(source: TEntry, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			this.validateUnusedId(source.id);
			this.validateTarget(source.parentId);
			const entry = { ...structuredClone(source), seq: this.sequence + 1 };
			const mutation: DecodedMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation, this.metadata.path, this.sequence + 2, false);
			return structuredClone(entry);
		});
	}

	appendForkLane(lane: string, leafId: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.validateTarget(leafId);
			const mutation: DecodedMutation = { kind: "lane", seq: this.sequence + 1, lane, leafId };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.requireLane(newRecord.lane);
			this.validateUnusedId(newRecord.id);
			const record = {
				...structuredClone(newRecord),
				seq: this.sequence + 1,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: DecodedMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.entriesById.get(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	getEntryLane(id: string): string | undefined {
		return this.entryLanes.get(id);
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

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
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

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		assertValidLimit(options?.limit);
		const openOperationsById = this.openOperationsByLane.get(lane);
		const openOperations = openOperationsById ? [...openOperationsById.values()].reverse() : [];
		return structuredClone(options?.limit === undefined ? openOperations : openOperations.slice(0, options.limit));
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

	setName(name: string): Promise<void> {
		return this.enqueue(async () => {
			const mutation: DecodedMutation = { kind: "fact", seq: this.sequence + 1, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labels.get(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.validateTarget(id);
			const mutation: DecodedMutation = { kind: "fact", seq: this.sequence + 1, fact: "label", targetId: id, label };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.stats);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation(mutation: DecodedMutation): Promise<void> {
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeMutation(mutation)),
			`Failed to append session ${this.metadata.path}`,
		);
	}

	private applyMutation(
		mutation: DecodedMutation,
		path = this.metadata.path,
		line = this.sequence + 2,
		validateEntryChain = true,
	): void {
		const seq =
			mutation.kind === "entry"
				? mutation.entry.seq
				: mutation.kind === "record"
					? mutation.record.seq
					: mutation.seq;
		if (seq !== this.sequence + 1) throw invalidFile(path, line, `has non-consecutive seq ${seq}`);
		switch (mutation.kind) {
			case "entry": {
				this.validateUnusedIdForReplay(mutation.entry.id, path, line);
				if (validateEntryChain) {
					const leafId = this.requireLaneForReplay(mutation.lane, path, line);
					if (mutation.entry.parentId !== leafId) throw invalidFile(path, line, "does not chain to the lane leaf");
				}
				if (mutation.entry.parentId !== null && !this.entriesById.has(mutation.entry.parentId)) {
					throw invalidFile(path, line, `references missing parent ${mutation.entry.parentId}`);
				}
				this.sequence = seq;
				this.usedIds.add(mutation.entry.id);
				this.entries.push(mutation.entry);
				this.entriesById.set(mutation.entry.id, mutation.entry);
				this.entryLanes.set(mutation.entry.id, mutation.lane);
				this.lanes.set(mutation.lane, mutation.entry.id);
				this.log.push({ kind: "entry", seq, entry: mutation.entry });
				if (mutation.entry.type === "message") this.stats.messageCount += 1;
				break;
			}
			case "record": {
				this.requireLaneForReplay(mutation.record.lane, path, line);
				this.validateUnusedIdForReplay(mutation.record.id, path, line);
				this.sequence = seq;
				this.usedIds.add(mutation.record.id);
				this.records.push(mutation.record);
				if (mutation.record.type === "operation_started") {
					let openOperations = this.openOperationsByLane.get(mutation.record.lane);
					if (!openOperations) {
						openOperations = new Map();
						this.openOperationsByLane.set(mutation.record.lane, openOperations);
					}
					openOperations.set(mutation.record.id, mutation.record);
				} else if (mutation.record.type === "operation_finished") {
					this.openOperationsByLane.get(mutation.record.lane)?.delete(mutation.record.runId);
				}
				this.log.push({ kind: "record", seq, record: mutation.record });
				if (mutation.record.type === "usage") {
					this.stats.cachedTokens += mutation.record.usage.cacheRead;
					this.stats.uncachedTokens += mutation.record.usage.input + mutation.record.usage.cacheWrite;
					this.stats.totalTokens += mutation.record.usage.totalTokens;
					this.stats.costTotal += mutation.record.usage.cost.total;
				}
				break;
			}
			case "lane": {
				if (mutation.leafId !== null && !this.entriesById.has(mutation.leafId)) {
					throw invalidFile(path, line, `references missing lane target ${mutation.leafId}`);
				}
				this.sequence = seq;
				this.lanes.set(mutation.lane, mutation.leafId);
				this.log.push({ kind: "lane", seq, lane: mutation.lane, leafId: mutation.leafId });
				break;
			}
			case "fact":
				this.sequence = seq;
				if (mutation.fact === "name") {
					this.name = mutation.name;
					this.log.push({ kind: "fact", seq, fact: "name", name: mutation.name });
				} else {
					if (!this.entriesById.has(mutation.targetId))
						throw invalidFile(path, line, `references missing label target ${mutation.targetId}`);
					if (mutation.label === undefined) this.labels.delete(mutation.targetId);
					else this.labels.set(mutation.targetId, mutation.label);
					this.log.push({ kind: "fact", seq, fact: "label", targetId: mutation.targetId, label: mutation.label });
				}
				break;
		}
	}

	private requireLane(lane: string): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return leafId;
	}

	private requireLaneForReplay(lane: string, path: string, line: number): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw invalidFile(path, line, `references missing lane ${lane}`);
		return leafId;
	}

	private validateTarget(targetId: string | null): void {
		if (targetId !== null && !this.entriesById.has(targetId))
			throw new SessionError("not_found", `Entry not found: ${targetId}`);
	}

	private validateUnusedId(id: string): void {
		if (this.usedIds.has(id)) throw new SessionError("already_exists", `Session id already exists: ${id}`);
	}

	private validateUnusedIdForReplay(id: string, path: string, line: number): void {
		if (this.usedIds.has(id)) throw invalidFile(path, line, `contains duplicate id ${id}`);
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
			if (visited.has(current.id))
				throw new SessionError("invalid_entry", `Session branch contains a cycle at ${current.id}`);
			visited.add(current.id);
			yield current;
			if (current.id === bounds?.stopAtId || current.type === bounds?.stopAtType || current.parentId === null) break;
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
			(query.operationKind === undefined ||
				(record.type === "operation_started" && record.intent.kind === query.operationKind)) &&
			(query.afterSeq === undefined || record.seq > query.afterSeq)
		);
	}
}

export class JsonlSessionRepo implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions>, AsyncDisposable {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly cwd: string;
	private readonly storages = new Map<string, JsonlSessionStorage>();
	private rootPromise: Promise<string> | undefined;
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.cwd = options.cwd ?? options.fs.cwd;
	}

	create(options: JsonlSessionCreateOptions = {}): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const id = options.id ?? uuidv7();
			const path = await this.pathForId(id);
			if (fileResult(await this.fs.exists(path), `Failed to check session ${path}`)) {
				throw new SessionError("already_exists", `Session already exists: ${id}`);
			}
			const cwd = options.cwd ?? this.cwd;
			const header: HeaderLine = {
				kind: "header",
				version: 4,
				id,
				createdAt: Date.now(),
				cwd,
				parentSessionId: options.parentSessionId,
			};
			fileResult(
				await this.fs.createDir(await this.root(), { recursive: true }),
				`Failed to create sessions directory`,
			);
			fileResult(await this.fs.writeFile(path, `${JSON.stringify(header)}\n`), `Failed to create session ${path}`);
			const storage = new JsonlSessionStorage(this.fs, {
				id,
				createdAt: header.createdAt,
				parentSessionId: header.parentSessionId,
				path,
				cwd,
			});
			this.storages.set(path, storage);
			return new Session(storage);
		});
	}

	open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const existing = this.storages.get(metadata.path);
			if (existing) return new Session(existing);
			if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
				throw new SessionError("not_found", `Session not found: ${metadata.id}`);
			}
			const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
			const loadedMetadata = await storage.getMetadata();
			if (loadedMetadata.id !== metadata.id)
				throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
			this.storages.set(metadata.path, storage);
			return new Session(storage);
		});
	}

	list(): Promise<JsonlSessionMetadata[]> {
		return this.enqueue(async () => {
			const root = await this.root();
			if (!fileResult(await this.fs.exists(root), `Failed to check sessions directory ${root}`)) return [];
			const files = fileResult(await this.fs.listDir(root), `Failed to list sessions directory ${root}`).filter(
				(entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"),
			);
			const metadata: JsonlSessionMetadata[] = [];
			for (const file of files) {
				const content = fileResult(
					await this.fs.readTextFile(file.path),
					`Failed to read session header ${file.path}`,
				);
				const firstLine = content.split("\n", 1)[0];
				if (!firstLine) throw invalidFile(file.path, 1, "is missing a header");
				const header = parseHeader(firstLine, file.path);
				metadata.push({
					id: header.id,
					createdAt: header.createdAt,
					parentSessionId: header.parentSessionId,
					path: file.path,
					cwd: header.cwd,
				});
			}
			return metadata.sort((left, right) => right.createdAt - left.createdAt);
		});
	}

	delete(metadata: JsonlSessionMetadata): Promise<void> {
		return this.enqueue(async () => {
			const storage = this.storages.get(metadata.path);
			if (storage) await storage.drain();
			fileResult(await this.fs.remove(metadata.path, { force: true }), `Failed to delete session ${metadata.path}`);
			this.storages.delete(metadata.path);
		});
	}

	fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions = {},
	): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const sourceSession = await this.openDirect(source);
			let copiedEntries: Entry[];
			let sourceLanes: LanePointer[] | undefined;
			let laneByEntryId: Map<string, string> | undefined;
			if (options.scope === "tree") {
				copiedEntries = await sourceSession.findEntries({ order: "oldestFirst" });
				sourceLanes = await sourceSession.getLanes();
				const sourceStorage = this.storages.get(source.path)!;
				laneByEntryId = new Map(
					copiedEntries.map((entry) => {
						const lane = sourceStorage.getEntryLane(entry.id);
						if (lane === undefined) {
							throw new SessionError("invalid_entry", `Entry has no source lane: ${entry.id}`);
						}
						return [entry.id, lane] as const;
					}),
				);
			} else {
				const selectedEntryId = options.entryId ?? (await sourceSession.getLeafId());
				let targetId: string | null = null;
				if (selectedEntryId !== null) {
					const entry = await sourceSession.getEntry(selectedEntryId);
					if (!entry || entry.type !== "message") {
						throw new SessionError(
							"invalid_fork_target",
							`Fork target is not a message entry: ${selectedEntryId}`,
						);
					}
					const position = options.position ?? (options.entryId === undefined ? "at" : "before");
					targetId = position === "at" ? entry.id : entry.parentId;
				}
				copiedEntries =
					targetId === null
						? []
						: await sourceSession.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
			}

			const target = await this.createDirect({
				...options,
				parentSessionId: options.parentSessionId ?? source.id,
			});
			const targetStorage = this.storages.get((await target.getMetadata()).path)!;
			for (const entry of copiedEntries) {
				await targetStorage.appendCopiedEntry(entry, laneByEntryId?.get(entry.id) ?? "main");
			}
			for (const pointer of sourceLanes ?? []) {
				await targetStorage.appendForkLane(pointer.lane, pointer.leafId);
			}
			const name = await sourceSession.getName();
			if (name !== undefined) await target.setName(name);
			for (const entry of copiedEntries) {
				const label = await sourceSession.getLabel(entry.id);
				if (label !== undefined) await target.setLabel(entry.id, label);
			}
			return target;
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.tail;
		await Promise.all([...this.storages.values()].map((storage) => storage.drain()));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new SessionError("storage", "JSONL session repository is disposed"));
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async openDirect(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		const existing = this.storages.get(metadata.path);
		if (existing) return new Session(existing);
		if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
		this.storages.set(metadata.path, storage);
		return new Session(storage);
	}

	private async createDirect(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? uuidv7();
		const path = await this.pathForId(id);
		if (fileResult(await this.fs.exists(path), `Failed to check session ${path}`)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}
		const cwd = options.cwd ?? this.cwd;
		const header: HeaderLine = {
			kind: "header",
			version: 4,
			id,
			createdAt: Date.now(),
			cwd,
			parentSessionId: options.parentSessionId,
		};
		fileResult(
			await this.fs.createDir(await this.root(), { recursive: true }),
			`Failed to create sessions directory`,
		);
		fileResult(await this.fs.writeFile(path, `${JSON.stringify(header)}\n`), `Failed to create session ${path}`);
		const storage = new JsonlSessionStorage(this.fs, {
			id,
			createdAt: header.createdAt,
			parentSessionId: header.parentSessionId,
			path,
			cwd,
		});
		this.storages.set(path, storage);
		return new Session(storage);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}

	private async pathForId(id: string): Promise<string> {
		let encoded: string;
		try {
			encoded = encodeURIComponent(id);
		} catch (error) {
			throw new SessionError(
				"invalid_payload",
				`Invalid session id ${JSON.stringify(id)}`,
				error instanceof Error ? error : undefined,
			);
		}
		return fileResult(
			await this.fs.joinPath([await this.root(), `session-${encoded}.jsonl`]),
			`Failed to resolve path for session ${id}`,
		);
	}
}
