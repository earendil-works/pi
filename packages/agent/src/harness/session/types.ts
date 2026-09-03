import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../../types.ts";
import type { BranchPreparation } from "../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings } from "../compaction/compaction.ts";
import type { Context } from "../context.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { ListElement, ListReadOptions, ListWrite, StoredValue, Value, ValueList, ValueWrite } from "./values.ts";

export type { JsonValue } from "@earendil-works/chord";

export type SettledAssistantMessage = AssistantMessage & {
	stopReason: Exclude<StopReason, "pending">;
};

export type EntryType = "message" | "compaction" | "branch_summary" | "custom";

export interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	terminate?: true;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string | null;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

/** Convert an application-defined custom entry into model context. */
export type EntryProjector = (
	entry: CustomEntry,
	context: Context,
) => AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>;

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

/** Entry supplied to a transaction before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry ? Omit<TEntry, "seq" | "timestamp"> : never;

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface OperationMeta {
	operationId: string;
	lane: string;
	sourceTipId: string | null;
	startedAt: number;
	intent:
		| { kind: "run"; promptEntryIds: string[] }
		| { kind: "compaction"; customInstructions?: string }
		| {
				kind: "navigation";
				targetId: string | null;
				summarize: boolean;
				label?: string;
				customInstructions?: string;
		  };
}

export type Control =
	| { status: "running" }
	| {
			status: "cancel_requested";
			requestedAt: number;
	  };

export interface OperationError {
	code: string;
	message: string;
	details?: JsonValue;
}

export type TerminalStatus = "completed" | "declined" | "aborted" | "failed";

/** Immutable lane-lived observation record written by one terminal transaction. */
export interface OperationResultRecord {
	operationId: string;
	kind: OperationMeta["intent"]["kind"];
	status: TerminalStatus;
	error?: OperationError;
	fromTipId: string | null;
	tipId: string | null;
	startedAt: number;
	endedAt: number;
}

export type Continuation =
	| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
	| { kind: "may_finish"; includeFinalAssistant: boolean };

/** Checkpoint payload; the flat leaf literal replaces the old nested phase tag. */
export interface CheckpointData {
	continuation: Continuation;
	triggerEntryId: string;
}

export type InboxItemKind = "steer" | "followUp" | "nextRun" | "write";

export interface InboxItem {
	entryId: string;
	kind: InboxItemKind;
}

export interface NormalizedRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
}

export interface GenerationContext {
	stepId: string;
	triggerEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	overflowRecoveryUsed: boolean;
}

interface ToolCallSource {
	/** Zero-based index in the assistant message's complete content array, not a filtered tool-call ordinal. */
	sourceIndex: number;
	resultEntryId: string;
}

export type ToolCall = ToolCallSource &
	(
		| { status: "planned" }
		| { status: "effect_pending"; replay: "never" | "safe" }
		| { status: "outcome_ready"; terminate: boolean }
		| { status: "completed"; terminate: boolean }
	);

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	calls: ToolCall[];
}

export interface SummaryContext {
	resultEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
}

/*
 * Durable operation state is one flat union with one family-neutral discriminator
 * per dispatcher leaf. ToolBatch/ToolCall remain the nested child collection state
 * machine, and cancellation stays orthogonal via Control.
 */

export interface Cancellable {
	control: Control;
}

export interface RunSettings {
	compaction: CompactionSettings;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: "sequential" | "parallel";
}

/** Uniform scope carried by every operation leaf. */
export interface OperationScope extends Cancellable {
	settings: RunSettings;
	latestAssistantEntryId: string | null;
}

/** Shared backoff data for every retry-wait leaf. */
export interface RetryWait {
	nextAttempt: number;
	notBefore: number;
	errorMessage: string;
}

export interface AssistantGenerationScope {
	generationContext: GenerationContext;
}

export type ResultBoundary =
	| { kind: "resume_checkpoint"; resumeAfter: CheckpointData }
	| { kind: "finish" }
	| { kind: "commit_navigation"; targetId: string; label?: string };

export interface SummaryTask {
	taskId: string;
	reason?: "manual" | "threshold" | "overflow";
	customInstructions?: string;
	boundary: ResultBoundary;
}

export interface SummaryGenerationScope {
	task: SummaryTask;
	summaryContext: SummaryContext;
}

export interface SummaryGenerationReady extends SummaryGenerationScope {
	nextAttempt: number;
}

export interface SummaryGenerationEffectPending extends SummaryGenerationScope {
	attempt: number;
	request?: { index: number; usageId: string };
	usageIds: string[];
}

export interface SummaryGenerationRetryWait extends SummaryGenerationScope, RetryWait {}

export interface DeferredScope extends OperationScope {
	stepId: string;
	sourceEntryId: string;
	poll: number;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
}

export interface StartingOperation extends OperationScope {
	at: "starting";
}

export interface CheckpointOperation extends OperationScope, CheckpointData {
	at: "checkpoint";
}

export interface AssistantReadyOperation extends OperationScope, AssistantGenerationScope {
	at: "assistant.ready";
	nextAttempt: number;
}

export interface AssistantEffectPendingOperation extends OperationScope, AssistantGenerationScope {
	at: "assistant.effect_pending";
	attempt: number;
	responseEntryId: string;
	usageId: string;
	intendedOutputLimit: number;
	contextWindow: number;
}

export interface AssistantRetryWaitOperation extends OperationScope, AssistantGenerationScope, RetryWait {
	at: "assistant.retry_wait";
}

export interface ToolsOperation extends OperationScope {
	at: "tools";
	batch: ToolBatch;
}

export interface DeferredSuspendedOperation extends DeferredScope {
	at: "deferred.suspended";
}

export interface DeferredEffectPendingOperation extends DeferredScope {
	at: "deferred.effect_pending";
	responseEntryId: string;
	usageId: string;
}

export interface SummaryDecidingOperation extends OperationScope {
	at: "summary.deciding";
	task: SummaryTask;
}

export interface SummaryReadyOperation extends OperationScope, SummaryGenerationReady {
	at: "summary.ready";
}

export interface SummaryEffectPendingOperation extends OperationScope, SummaryGenerationEffectPending {
	at: "summary.effect_pending";
}

export interface SummaryRetryWaitOperation extends OperationScope, SummaryGenerationRetryWait {
	at: "summary.retry_wait";
}

export interface NavigationReadyToCommitOperation extends OperationScope {
	at: "navigation.ready_to_commit";
	/** Unsummarized navigation may target the branch root (null). */
	targetId: string | null;
	label?: string;
}

/** Flat durable operation state: exactly 13 family-neutral dispatcher leaves. */
export type OperationState =
	| StartingOperation
	| CheckpointOperation
	| AssistantReadyOperation
	| AssistantEffectPendingOperation
	| AssistantRetryWaitOperation
	| ToolsOperation
	| DeferredSuspendedOperation
	| DeferredEffectPendingOperation
	| SummaryDecidingOperation
	| SummaryReadyOperation
	| SummaryEffectPendingOperation
	| SummaryRetryWaitOperation
	| NavigationReadyToCommitOperation;

export type OperationAt = OperationState["at"];

/** Copy only the uniform operation scope when constructing a successor leaf. */
export function operationScopeOf(state: OperationState): OperationScope {
	return {
		control: state.control,
		settings: state.settings,
		latestAssistantEntryId: state.latestAssistantEntryId,
	};
}

export type Operation = { meta: OperationMeta; state: OperationState };

export interface LaneState {
	currentOperationId: string | null;
	lastOperationId: string | null;
	inbox: InboxItem[];
}

export type PendingEntry =
	| { type: "message"; payload: AgentMessage }
	| { type: "custom"; customType: string; payload?: JsonValue };

export interface DurableFileOperations {
	read: string[];
	written: string[];
	edited: string[];
}

export type DurableStructuralPreparation =
	| {
			kind: "compaction";
			messagesToSummarize: CompactionPreparation["messagesToSummarize"];
			turnPrefixMessages: CompactionPreparation["turnPrefixMessages"];
			retainedTail: CompactionPreparation["retainedTail"];
			isSplitTurn: boolean;
			tokensBefore: number;
			previousSummary?: string;
			fileOps: DurableFileOperations;
			settings: CompactionSettings;
	  }
	| {
			kind: "branch_summary";
			messages: BranchPreparation["messages"];
			fileOps: DurableFileOperations;
			totalTokens: number;
	  };

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export interface EntryWrite {
	kind: "entry";
	entry: NewEntry;
}

export interface UsageWrite {
	kind: "usage";
	row: Omit<UsageRow, "seq">;
}

export type Write = EntryWrite | UsageWrite | ValueWrite | ListWrite;

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
	/** Session totals immediately after this commit was applied. */
	stats: SessionStats;
}

export interface EntryStructure {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface EntryCursor {
	seq: number;
}

export interface BranchScan {
	start?: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface UsageScan {
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface SessionStats {
	messageCount: number;
	usage: Usage;
}

export interface Storage {
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
	scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]>;
	scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
	scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]>;
	getStats(context: Context): Promise<SessionStats>;
	close(context: Context): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	cwd?: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface IdGenerator {
	next(timestampMs?: number): string;
}

export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: "asc" | "desc";
	limit?: number;
	cursor?: EntryCursor;
}

export interface SessionReader {
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getStats(context: Context): Promise<SessionStats>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	/** Scan a branch from an explicit entry while this reader capability remains valid. */
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

/** Exclusive keyless mutation barrier for one Session. */
export interface SessionMutation extends SessionReader {
	/** Exactly zero or one commit attempt. A second attempt rejects. */
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	/** Wait for any commit attempt, invalidate the capability, and release the barrier. */
	end(context: Context): Promise<void>;
}

/** Callback-scoped mutation capability without authority to release its Session barrier. */
export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<T> = (mutator: SessionMutator, context: Context) => T | Promise<T>;

export interface Branch {
	readonly name: string;
	getTipId(context: Context): Promise<string | null>;
	findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage, context: Context): Promise<string>;
	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
}

export interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionReader {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	getEntry(id: string, context: Context): Promise<Entry | undefined>;
	getStats(context: Context): Promise<SessionStats>;
	getName(context: Context): Promise<string | undefined>;
	getLabel(targetId: string, context: Context): Promise<string | undefined>;
	findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined>;
	branch(name: string, context: Context): Promise<Branch | undefined>;
	createBranch(name: string, at: string | null, context: Context): Promise<Branch>;
	beginMutation(context: Context): Promise<SessionMutation>;
	/**
	 * Trusted exclusive callback over the Session mutation line. Calling a public Session writer from
	 * this callback queues it behind the callback; awaiting that nested writer therefore deadlocks.
	 * Use the supplied mutator for the callback's sole commit.
	 */
	mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T>;
	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void>;
	deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void>;
	deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
	setName(name: string | undefined, context: Context): Promise<void>;
	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions =
	| {
			/**
			 * Copy one path from a complete configured source AgentLane under the same
			 * Branch name, with copied configuration and fresh idle lane state.
			 */
			scope: "branch";
			/** Source Branch to copy. */
			branch: string;
			/** Entry on the source Branch's current tip ancestry. Defaults to the current tip. */
			entryId?: string;
			/**
			 * Whether the fork includes the selected entry or stops at its parent.
			 * Defaults to including the selected entry.
			 */
			position?: "before" | "at";
			/** Optional destination session id. */
			id?: string;
	  }
	| {
			/**
			 * Copy the whole conversation tree and every Branch tip. Each configured
			 * AgentLane copies configuration plus fresh idle state; data-only Branches
			 * remain data-only. Operation/pending/result/usage state is excluded.
			 */
			scope: "tree";
			/** Optional destination session id. */
			id?: string;
	  };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions, context: Context): Promise<Session<TMetadata>>;
	open(metadata: TMetadata, context: Context): Promise<Session<TMetadata>>;
	list(options: TListOptions | undefined, context: Context): Promise<TMetadata[]>;
	delete(metadata: TMetadata, context: Context): Promise<void>;
	fork(source: TMetadata, options: ForkOptions, context: Context): Promise<Session<TMetadata>>;
}
