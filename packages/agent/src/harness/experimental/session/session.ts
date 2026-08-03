import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../../types.ts";
import type {
	BranchBounds,
	Entry,
	EntryQuery,
	IdGenerator,
	LaneMove,
	LanePointer,
	LogItem,
	LogOptions,
	NewRecord,
	ProvisionedEntry,
	RecordQuery,
	SessionMetadata,
	SessionRecord,
	SessionStats,
	SessionStorage,
	SessionTree,
} from "./types.ts";
import { SessionError } from "./types.ts";

class LaneSessionTree implements SessionTree {
	private readonly storage: SessionStorage;
	private readonly lane: string;
	private readonly idGenerator: IdGenerator;

	constructor(storage: SessionStorage, lane: string, idGenerator: IdGenerator) {
		this.storage = storage;
		this.lane = lane;
		this.idGenerator = idGenerator;
	}

	async getLeafId(): Promise<string | null> {
		const pointer = (await this.storage.getLanes()).find(({ lane }) => lane === this.lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${this.lane}`);
		return pointer.leafId;
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

	async setName(name: string): Promise<void> {
		await this.storage.setName(name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.storage.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.storage.setLabel(targetId, label);
	}

	async findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.storage.findEntries(query);
	}

	async findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return (await this.findEntries({ ...query, limit: 1 }))[0];
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds = {}): Promise<Entry[]> {
		const start = query.start ?? (await this.getLeafId());
		if (start === null) return [];
		return this.storage.findEntriesOnBranch({
			...query,
			start,
		});
	}

	async findEntryOnBranch(query: EntryQuery & BranchBounds = {}): Promise<Entry | undefined> {
		return (await this.findEntriesOnBranch({ ...query, limit: 1 }))[0];
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		const entry = await this.storage.appendEntry(
			{ type: "message", id: this.idGenerator.next(), message },
			this.lane,
		);
		return entry.id;
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		const entry = await this.storage.appendEntry(
			{ type: "custom", id: this.idGenerator.next(), customType, data },
			this.lane,
		);
		return entry.id;
	}
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> implements SessionTree {
	private readonly storage: SessionStorage<TMetadata>;
	private readonly main: LaneSessionTree;
	readonly idGenerator: IdGenerator;

	constructor(storage: SessionStorage<TMetadata>, options: { idGenerator?: IdGenerator } = {}) {
		this.storage = storage;
		this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };
		this.main = new LaneSessionTree(storage, "main", this.idGenerator);
	}

	async getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	view(lane: string): SessionTree {
		return lane === "main" ? this.main : new LaneSessionTree(this.storage, lane, this.idGenerator);
	}

	async getLeafId(): Promise<string | null> {
		return this.main.getLeafId();
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return this.main.getEntry(id);
	}

	async getStats(): Promise<SessionStats> {
		return this.main.getStats();
	}

	async getName(): Promise<string | undefined> {
		return this.main.getName();
	}

	async setName(name: string): Promise<void> {
		await this.main.setName(name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.main.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.main.setLabel(targetId, label);
	}

	async findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.main.findEntries(query);
	}

	async findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.main.findEntry(query);
	}

	async findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]> {
		return this.main.findEntriesOnBranch(query);
	}

	async findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined> {
		return this.main.findEntryOnBranch(query);
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.main.appendMessage(message);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.main.appendCustomEntry(customType, data);
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
		return this.storage.appendEntry(entry, lane);
	}

	async appendRecord(record: NewRecord, options?: { moveLane?: LaneMove }): Promise<SessionRecord> {
		return this.storage.appendRecord(record, options);
	}

	async findRecords(query?: RecordQuery): Promise<SessionRecord[]> {
		return this.storage.findRecords(query);
	}

	async getLog(options?: LogOptions): Promise<LogItem[]> {
		return this.storage.getLog(options);
	}
}
