import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import type {
	BranchBounds,
	Entry,
	EntryQuery,
	IdGenerator,
	LanePointer,
	LaneRecord,
	LogItem,
	LogOptions,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordBase,
	RecordQuery,
	SessionMetadata,
	SessionStats,
	SessionStorage,
	SessionTree,
} from "./types.ts";
import { SessionError } from "./types.ts";

type JsonValidationFrame = { value: unknown } | { exit: object };

function invalidPayload(reason: string): never {
	throw new SessionError("invalid_payload", `Durable payload ${reason}`);
}

function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

function assertValidCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

export function assertJsonSerializable(value: unknown): void {
	const active = new WeakSet<object>();
	const stack: JsonValidationFrame[] = [{ value }];
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if ("exit" in frame) {
			active.delete(frame.exit);
			continue;
		}
		const candidate = frame.value;
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
			continue;
		}
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) invalidPayload("contains a non-finite number");
			continue;
		}
		if (typeof candidate !== "object") invalidPayload(`contains ${typeof candidate}`);
		if (active.has(candidate)) invalidPayload("contains a cycle");
		active.add(candidate);
		stack.push({ exit: candidate });

		if (Array.isArray(candidate)) {
			if (Object.getPrototypeOf(candidate) !== Array.prototype) {
				invalidPayload("contains a non-standard array");
			}
			if (
				Object.getOwnPropertySymbols(candidate).length > 0 ||
				Object.getOwnPropertyNames(candidate).length !== candidate.length + 1
			) {
				invalidPayload("contains an array with unsupported properties");
			}
			for (let index = candidate.length - 1; index >= 0; index--) {
				if (!Object.hasOwn(candidate, index)) invalidPayload("contains a sparse array");
				const descriptor = Object.getOwnPropertyDescriptor(candidate, index)!;
				if (!("value" in descriptor)) invalidPayload("contains an array accessor");
				stack.push({ value: descriptor.value });
			}
			continue;
		}

		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) {
			invalidPayload("contains a non-plain object");
		}
		if (Object.getOwnPropertySymbols(candidate).length > 0) {
			invalidPayload("contains a symbol-keyed property");
		}
		const keys = Object.keys(candidate);
		if (Object.getOwnPropertyNames(candidate).length !== keys.length) {
			invalidPayload("contains a non-enumerable property");
		}
		for (let index = keys.length - 1; index >= 0; index--) {
			const descriptor = Object.getOwnPropertyDescriptor(candidate, keys[index]!)!;
			if (!("value" in descriptor)) invalidPayload("contains an accessor");
			stack.push({ value: descriptor.value });
		}
	}
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> implements SessionTree {
	private readonly storage: SessionStorage<TMetadata>;
	readonly idGenerator: IdGenerator;

	constructor(storage: SessionStorage<TMetadata>, options: { idGenerator?: IdGenerator } = {}) {
		this.storage = storage;
		this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };
	}

	async getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	view(lane: string): SessionTree {
		if (lane === "main") return this;
		return {
			getLeafId: () => this.getLeafIdForLane(lane),
			getEntry: (id) => this.getEntry(id),
			getStats: () => this.getStats(),
			getName: () => this.getName(),
			setName: (name) => this.setName(name),
			getLabel: (targetId) => this.getLabel(targetId),
			setLabel: (targetId, label) => this.setLabel(targetId, label),
			findEntries: (query) => this.queryEntries(query),
			findEntry: async (query = {}) => (await this.queryEntries(query, 1))[0],
			findEntriesOnBranch: (query) => this.queryBranchEntries(lane, query),
			findEntryOnBranch: async (query = {}) => (await this.queryBranchEntries(lane, query, 1))[0],
			appendMessage: (message) => this.appendMessageToLane(lane, message),
			appendCustomEntry: (customType, data) => this.appendCustomEntryToLane(lane, customType, data),
		};
	}

	async getLeafId(): Promise<string | null> {
		return this.getLeafIdForLane("main");
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return this.storage.getEntry(id);
	}

	async getStats(): Promise<SessionStats> {
		return this.storage.getStats();
	}

	async getName(): Promise<string | undefined> {
		return this.storage.getName();
	}

	async setName(name: string | undefined): Promise<void> {
		await this.storage.setName(name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.storage.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.storage.setLabel(targetId, label);
	}

	async findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.queryEntries(query);
	}

	async findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		return (await this.queryEntries(query, 1))[0];
	}

	async findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]> {
		return this.queryBranchEntries("main", query);
	}

	async findEntryOnBranch(query: EntryQuery & BranchBounds = {}): Promise<Entry | undefined> {
		return (await this.queryBranchEntries("main", query, 1))[0];
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendMessageToLane("main", message);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendCustomEntryToLane("main", customType, data);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.storage.getLanes();
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		await this.storage.createLane(lane, at);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		await this.storage.moveLane(lane, to);
	}

	async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.commitEntry(entry, lane);
	}

	async appendRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">>;
	async appendRecord(record: NewRecord): Promise<LaneRecord> {
		return this.commitRecord(record);
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]> {
		return this.queryRecords(query);
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		assertValidLimit(options?.limit);
		return this.storage.findOpenOperations(lane, options);
	}

	async getLog(options?: LogOptions): Promise<LogItem[]> {
		return this.queryLog(options);
	}

	/** Returns the lane's current leaf, or null when empty. Throws when the lane does not exist. */
	private async getLeafIdForLane(lane: string): Promise<string | null> {
		const pointer = (await this.getLanes()).find((candidate) => candidate.lane === lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return pointer.leafId;
	}

	private async queryEntries(query: EntryQuery = {}, resultLimit = query.limit): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		return this.storage.findEntries(resultLimit === query.limit ? query : { ...query, limit: resultLimit });
	}

	/**
	 * Queries from `query.start` toward the root, defaulting to the lane's current leaf.
	 * `resultLimit` lets single-entry queries cap results without changing the caller's query.
	 */
	private async queryBranchEntries(
		defaultLane: string,
		query: EntryQuery & BranchBounds = {},
		resultLimit = query.limit,
	): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const start = query.start ?? (await this.getLeafIdForLane(defaultLane));
		if (start === null) return [];
		const storageQuery = resultLimit === query.limit ? query : { ...query, limit: resultLimit };
		return this.storage.findEntriesOnBranch({ ...storageQuery, start });
	}

	private async queryRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.afterSeq);
		if (query.operationKind !== undefined && query.type !== "operation_started") {
			throw new SessionError("invalid_query", 'operationKind requires type "operation_started"');
		}
		return this.storage.findRecords(query);
	}

	private async queryLog(options: LogOptions = {}): Promise<LogItem[]> {
		assertValidLimit(options.limit);
		assertValidCursor(options.afterSeq);
		return this.storage.getLog(options);
	}

	private async appendMessageToLane(lane: string, message: AgentMessage): Promise<string> {
		const entry = await this.commitEntry({ type: "message", id: this.idGenerator.next(), message }, lane);
		return entry.id;
	}

	private async appendCustomEntryToLane(lane: string, customType: string, data?: unknown): Promise<string> {
		const entry = await this.commitEntry(
			data === undefined
				? { type: "custom", id: this.idGenerator.next(), customType }
				: { type: "custom", id: this.idGenerator.next(), customType, data },
			lane,
		);
		return entry.id;
	}

	private async commitEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		assertJsonSerializable(entry);
		return this.storage.appendEntry(entry, lane);
	}

	private async commitRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">> {
		assertJsonSerializable(record);
		return this.storage.appendRecord<LaneRecord>(record) as unknown as Promise<
			TNewRecord & Pick<RecordBase, "seq" | "timestamp">
		>;
	}
}
