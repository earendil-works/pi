import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../../types.ts";
import type { Session } from "./session.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IdGenerator {
	next(): string;
}

export interface EntryBase {
	type: string;
	id: string;
	seq: number;
	parentId: string | null;
	timestamp: number;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	terminate?: true;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ActiveToolsChangeEntry extends EntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: unknown;
	usage?: Usage;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: unknown;
	usage?: Usage;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export type Entry =
	| MessageEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry;

export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, "parentId" | "seq" | "timestamp">
	: never;

export interface RecordBase {
	id: string;
	seq: number;
	lane: string;
	timestamp: number;
}

export interface OperationStartedRecord extends RecordBase {
	type: "operation_started";
	sourceLeafId: string | null;
	intent:
		| {
				kind: "run";
				initialMessages: ProvisionedEntry[];
				systemPromptOverride?: string;
				resumeData?: { [extensionId: string]: JsonValue };
		  }
		| {
				kind: "compaction";
				customInstructions?: string;
				resultEntryId: string;
		  }
		| {
				kind: "navigation";
				targetId: string | null;
				summarize: boolean;
				customInstructions?: string;
				label?: string;
				summaryEntryId?: string;
		  };
}

export interface AbortRequestedRecord extends RecordBase {
	type: "abort_requested";
	runId: string;
	reason: "user" | "shutdown";
}

export interface OperationFinishedRecord extends RecordBase {
	type: "operation_finished";
	runId: string;
	outcome: "completed" | "aborted" | "failed" | "declined";
	error?: { code: string; message: string };
}

export interface TaskAttemptRecord extends RecordBase {
	type: "task_attempt";
	runId: string;
	task: "step" | "compaction" | "branch_summary";
	attempt: number;
}

export interface ToolStartedRecord extends RecordBase {
	type: "tool_started";
	runId: string;
	assistantEntryId: string;
	toolIndex: number;
	toolCallId: string;
	toolName: string;
	effectiveArgs: { [key: string]: unknown };
	resultEntryId: string;
	replay: "never" | "safe";
}

export type QueueEnqueuedRecord = RecordBase &
	(
		| {
				type: "queue_enqueued";
				queue: "steer" | "followUp";
				runId: string;
				target: ProvisionedEntry;
		  }
		| {
				type: "queue_enqueued";
				queue: "nextRun";
				runId?: never;
				target: ProvisionedEntry;
		  }
	);

export interface WriteDeferredRecord extends RecordBase {
	type: "write_deferred";
	runId: string;
	target: ProvisionedEntry;
}

export type SessionRecord =
	| OperationStartedRecord
	| AbortRequestedRecord
	| OperationFinishedRecord
	| TaskAttemptRecord
	| ToolStartedRecord
	| QueueEnqueuedRecord
	| WriteDeferredRecord;
export type Record = SessionRecord;
export type NewRecord = SessionRecord extends infer TRecord
	? TRecord extends SessionRecord
		? Omit<TRecord, "seq" | "timestamp">
		: never
	: never;

export type EntryOrder = "newestFirst" | "oldestFirst";

export interface EntryCursor {
	afterSeq: number;
}

export interface EntryQuery {
	type?: Entry["type"];
	customType?: string;
	order?: EntryOrder;
	limit?: number;
	cursor?: EntryCursor;
}

export interface BranchBounds {
	start?: string;
	stopAtType?: Entry["type"];
	stopAtId?: string;
}

export interface RecordQuery {
	lane?: string;
	type?: SessionRecord["type"];
	runId?: string;
	afterSeq?: number;
	order?: EntryOrder;
	limit?: number;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	parentSessionId?: string;
}

export interface SessionStats {
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
}

export interface LanePointer {
	lane: string;
	leafId: string | null;
}

export interface LaneMove {
	lane: string;
	to: string | null;
}

export type LogItem =
	| { kind: "entry"; seq: number; lane: string; entry: Entry }
	| { kind: "record"; seq: number; record: SessionRecord; moveLane?: LaneMove }
	| { kind: "lane"; seq: number; lane: string; action: "create" | "move" | "delete"; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

export interface LogOptions {
	afterSeq?: number;
	limit?: number;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;

	// Lanes
	getLanes(): Promise<{ lane: string; leafId: string | null }[]>;
	createLane(lane: string, at: string | null): Promise<void>;
	deleteLane(lane: string): Promise<void>;
	moveLane(lane: string, to: string | null): Promise<void>;

	// Entries and Records
	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry>;
	appendRecord(record: NewRecord, options?: { moveLane?: LaneMove }): Promise<Record>;

	// Reads
	getEntry(id: string): Promise<Entry | undefined>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	/** start is mandatory here; defaulting to a lane's leaf is view sugar. */
	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]>;
	findRecords(query?: RecordQuery): Promise<Record[]>;
	getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;

	// Global facts
	getName(): Promise<string | undefined>;
	setName(name: string): Promise<void>;
	getLabel(id: string): Promise<string | undefined>;
	setLabel(id: string, label: string | undefined): Promise<void>;
	getStats(): Promise<SessionStats>;
}

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<Entry | undefined>;
	getStats(): Promise<SessionStats>;
	getName(): Promise<string | undefined>;
	setName(name: string): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;
	findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
	findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions = { scope?: "branch"; entryId?: string; position?: "before" | "at" } | { scope: "tree" };

export interface SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

export type SessionErrorCode =
	| "not_found"
	| "already_exists"
	| "invalid_entry"
	| "invalid_lane"
	| "invalid_query"
	| "invalid_fork_target"
	| "storage";

export class SessionError extends Error {
	readonly code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}
