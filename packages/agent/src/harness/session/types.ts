import type { StopReason, Usage } from "@earendil-works/pi-ai";
import "../messages.ts";
import type { AgentMessage } from "../../types.ts";
import type { Session } from "./session.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SessionStopReason = Exclude<StopReason, "pending"> | "deferred";

export interface IdGenerator {
	next(): string;
}

export interface EntryBase {
	type: string;
	id: string;
	seq: number; // shared sequence; read-side, storage-assigned
	parentId: string | null; // storage-assigned: the appending lane's leaf
	timestamp: number; // Unix ms, storage-assigned
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

export interface ThinkingLevelEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ActiveToolsEntry extends EntryBase {
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
	| ThinkingLevelEntry
	| ActiveToolsEntry
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
				/** Normalized caller input before before_run; kept for suspended operations and before_resume. */
				originalPrompt: AgentMessage[];
				/** Captured nextRun items, then the prompt, then before_run injections. */
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
}

export interface OperationFinishedRecord extends RecordBase {
	type: "operation_finished";
	runId: string;
	outcome: "completed" | "aborted" | "failed" | "declined";
	error?: { code: string; message: string };
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export type StepAttemptRecord = RecordBase &
	(
		| {
				type: "step_attempt";
				runId: string;
				step: "assistant" | "branch_summary";
				attempt: number;
				resultEntryId: string;
				compactionReason?: never;
		  }
		| {
				type: "step_attempt";
				runId: string;
				step: "compaction";
				attempt: number;
				resultEntryId: string;
				/** Persists why compaction summary generation started so recovery resumes the same work. */
				compactionReason: CompactionReason;
		  }
	);

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

export interface QueueCancelledRecord extends RecordBase {
	type: "queue_cancelled";
	runId?: string;
	entryId: string;
}

export interface WriteDeferredRecord extends RecordBase {
	type: "write_deferred";
	runId: string;
	target: ProvisionedEntry;
}

export type UsageRecord = RecordBase & { type: "usage"; usage: Usage } & (
		| {
				cause: "assistant" | "compaction" | "branch_summary" | "deferred_fetch";
				runId: string;
				entryId: string;
				attempt: number;
				stopReason: SessionStopReason;
		  }
		| { cause: "tool"; runId: string; entryId: string; toolCallId: string }
		| { cause: "hook"; runId: string; entryId: string }
		| { cause: "adjustment"; runId?: string; entryId?: string; details?: JsonValue }
	);

export type LaneRecord =
	| OperationStartedRecord
	| AbortRequestedRecord
	| OperationFinishedRecord
	| StepAttemptRecord
	| ToolStartedRecord
	| QueueEnqueuedRecord
	| QueueCancelledRecord
	| WriteDeferredRecord
	| UsageRecord;
export type NewRecord<TRecord extends LaneRecord = LaneRecord> = TRecord extends LaneRecord
	? Omit<TRecord, "seq" | "timestamp">
	: never;

export type EntryOrder = "newestFirst" | "oldestFirst";

export interface EntryCursor {
	afterSeq: number;
}

export interface EntryQuery {
	type?: Entry["type"];
	customType?: string; // for type "custom"
	order?: EntryOrder; // default newestFirst
	limit?: number;
	cursor?: EntryCursor;
}

/** Bounds of a branch scan. Default: the whole path, leaf to root. */
export interface BranchBounds {
	start?: string; // default: the view's lane leaf
	stopAtType?: Entry["type"]; // scan ends after the first match, inclusive
	stopAtId?: string;
}

export interface RecordQuery {
	/** Exact lane match. Omit to query every lane. */
	lane?: string;
	/** Exact record discriminant match. Omit to query every record type. */
	type?: LaneRecord["type"];
	/**
	 * Operation identity. Matches OperationStartedRecord.id and the runId
	 * property of operation-owned records. Records without an operation
	 * identity do not match.
	 */
	runId?: string;
	/** Exact operation intent kind. Valid only with type "operation_started". */
	operationKind?: OperationStartedRecord["intent"]["kind"];
	/** Exclusive chronological lower bound: seq > afterSeq, regardless of order. */
	afterSeq?: number;
	/** Sequence order. Default: "newestFirst". */
	order?: EntryOrder;
	/** Positive maximum number of matching records. */
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

export type LogItem =
	| { kind: "entry"; seq: number; entry: Entry }
	| { kind: "record"; seq: number; record: LaneRecord }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string | undefined }
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
	moveLane(lane: string, to: string | null): Promise<void>;

	// Entries and Records
	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry>;
	appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;

	// Reads
	getEntry(id: string): Promise<Entry | undefined>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	/** start is mandatory here (as opposed to SessionTree's findEntriesOnBranch); defaulting to a lane's leaf is view sugar. */
	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]>;
	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	/**
	 * Returns unfinished operation starts newest first. Recovery uses `limit: 2`:
	 * zero results mean the lane is idle, one means it is suspended, and two
	 * mean at least two operations are open, which is corruption. Further
	 * results provide no additional recovery state.
	 */
	findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]>;
	getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;

	// Global facts
	getName(): Promise<string | undefined>;
	setName(name: string | undefined): Promise<void>;
	getLabel(id: string): Promise<string | undefined>;
	setLabel(id: string, label: string | undefined): Promise<void>;
	getStats(): Promise<SessionStats>;
}

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<Entry | undefined>;
	getStats(): Promise<SessionStats>;

	// Global facts. Latest wins; not branch-scoped. "set", not "append":
	// append vocabulary is reserved for tree writes.
	getName(): Promise<string | undefined>;
	setName(name: string | undefined): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;

	/** Session-wide, all branches, sequence order. */
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;

	/** Branch-scoped: the path from start toward root. */
	findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
	findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;

	// Writes. Resolve on durable acceptance; the returned id is the entry's
	// id (provisioned when the write defers).
	appendMessage(message: AgentMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions = { scope?: "branch"; entryId?: string; position?: "before" | "at" } | { scope: "tree" };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	/** Opens the session for writing and acquires any backend writer claim. */
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	/** Lists session metadata without opening sessions or acquiring writer claims. */
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

export type SessionErrorCode =
	| "not_found"
	| "already_exists"
	| "invalid_entry"
	| "invalid_payload"
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
