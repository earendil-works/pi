import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import {
	type EffectiveLaneConfiguration,
	type LaneReductionInput,
	type LaneReductionResult,
	RecordLogCorruption,
	reduceLaneState,
} from "./reducer.ts";
import { type Result as ResultValue, TaggedError } from "./result.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	OperationStartedRecord,
	ProvisionedEntry,
	Session,
	SessionTree,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class UnavailableRegistry implements Hooks, Events {
	private readonly operation: string;
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

/**
 * Reads entries appended by an operation whose starting leaf remains an
 * ancestor of the lane's current leaf. The branch query walks newest-first
 * from `leafId` to the inclusive `sourceLeafId` boundary; this helper removes
 * that pre-operation anchor and returns only operation-owned entries in
 * oldest-first reducer order. A null source denotes an operation accepted at
 * the root. Post-move navigation does not satisfy the ancestry requirement;
 * its provisioned summary must be restored by point lookup instead.
 */
async function readOwnEntries(
	session: Session,
	leafId: string | null,
	sourceLeafId: string | null,
	operationStartedSeq: number,
): Promise<Entry[]> {
	// A root-positioned lane has no entries, while an unchanged source leaf means
	// the operation has not appended any entries.
	if (leafId === null) {
     if (sourceLeafId !== null) {
       throw new RecordLogCorruption(
         "inconsistent_step",
         `Operation source leaf ${sourceLeafId} cannot restore with root current leaf`,
       );
     }
     return [];
   }

   if (leafId === sourceLeafId) return [];

	const newestFirst = await session.findEntriesOnBranch({
		start: leafId,
		...(sourceLeafId === null ? {} : { stopAtId: sourceLeafId }),
		order: "newestFirst",
	});
	if (sourceLeafId !== null) {
		// stopAtId is inclusive, so remove the pre-operation source anchor.
		const sourceEntry = newestFirst.pop();
		if (sourceEntry?.id !== sourceLeafId) {
			throw new RecordLogCorruption(
				"inconsistent_step",
				`Operation source leaf ${sourceLeafId} is not an ancestor of current leaf ${leafId}`,
			);
		}
	}
	const ownEntries = newestFirst.reverse();
	if (ownEntries.some((entry) => entry.seq <= operationStartedSeq)) {
		throw new RecordLogCorruption(
			"inconsistent_step",
			`Operation at sequence ${operationStartedSeq} includes a pre-operation entry on its current branch`,
		);
	}
	return ownEntries;
}

/**
 * Navigation moves away from its source before appending its only possible own
 * tree entry. The lane move and optional label are not entries, so this returns
 * no entries before the summary append and exactly the summary afterward.
 *
 * The point lookup distinguishes the three durable states: source (before
 * move), target (after move), and summary (after append). A null leaf is the
 * tree root and can therefore be either the source or target; source and target
 * must differ, so those states remain distinguishable.
 */
function restoreNavigationOwnEntries(
	started: OperationStartedRecord,
	leafId: string | null,
	recoveryTargetEntries: readonly Entry[],
): Entry[] {
	if (started.intent.kind !== "navigation") throw new Error("Expected a navigation operation");
	const intent = started.intent;
	const hasSummaryId = intent.summaryEntryId !== undefined;
	if (intent.targetId === started.sourceLeafId || intent.summarize !== hasSummaryId) {
		throw new RecordLogCorruption(
			"inconsistent_step",
			`Navigation ${started.id} has an inconsistent source, target, or summary intent`,
		);
	}

	const summary = intent.summaryEntryId
		? recoveryTargetEntries.find((entry) => entry.id === intent.summaryEntryId)
		: undefined;
	if (!summary) {
		const laneIsBeforeOrAfterMove = leafId === started.sourceLeafId || leafId === intent.targetId;
		if (!laneIsBeforeOrAfterMove) {
			throw new RecordLogCorruption(
				"inconsistent_step",
				`Navigation ${started.id} has leaf ${leafId} before its summary was appended`,
			);
		}
		return [];
	}

	// A committed summary must be the first post-start entry on the target
	// branch, describe the abandoned source branch, and remain the lane leaf.
	const isPostStartEntry = summary.seq > started.seq;
	const isOnTargetBranch = summary.parentId === intent.targetId;
	const describesSourceBranch = summary.type === "branch_summary" && summary.fromId === started.sourceLeafId;
	const isLaneLeaf = leafId === summary.id;
	const isValidSummary = isPostStartEntry && isOnTargetBranch && describesSourceBranch && isLaneLeaf;
	if (!isValidSummary) {
		throw new RecordLogCorruption(
			"inconsistent_step",
			`Navigation ${started.id} has a summary that is not the post-move lane leaf`,
		);
	}
	return [summary];
}

/**
 * Point-looks up entries named by recovery records. These lookups both close
 * provisioned intents and detect an id whose entry exists outside this lane's
 * current branch with content different from its durable intent.
 */
async function readRecoveryTargetEntries(session: Session, records: LaneReductionInput["records"]): Promise<Entry[]> {
	const targetIds = new Set<string>();
	for (const record of records) {
		switch (record.type) {
			case "operation_started":
				switch (record.intent.kind) {
					case "run":
						for (const target of record.intent.initialMessages) targetIds.add(target.id);
						break;
					case "compaction":
						targetIds.add(record.intent.resultEntryId);
						break;
					case "navigation":
						if (record.intent.summaryEntryId) targetIds.add(record.intent.summaryEntryId);
						break;
				}
				break;
			case "step_attempt":
				targetIds.add(record.resultEntryId);
				break;
			case "tool_started":
				targetIds.add(record.assistantEntryId);
				targetIds.add(record.resultEntryId);
				break;
			case "queue_enqueued":
				targetIds.add(record.target.id);
				break;
			case "write_deferred":
				targetIds.add(record.target.id);
				break;
		}
	}
	// TODO: Add a batched lookup or bounded concurrency before remote storage backends use restore;
	// one request per recovery target currently has no backpressure.
	const entries = await Promise.all([...targetIds].map((id) => session.getEntry(id)));
	return entries.filter((entry): entry is Entry => entry !== undefined);
}

/**
 * Reads the bounded queue slice relevant to an idle lane. The latest run start
 * is the cutoff because that run captured every older next-run item; only
 * subsequent next-run enqueues and cancellations can still be pending.
 */
async function readIdleQueueRecords(session: Session, lane: string): Promise<LaneReductionInput["records"]> {
	const [latestRun] = await session.findRecords({
		lane,
		type: "operation_started",
		operationKind: "run",
		order: "newestFirst",
		limit: 1,
	});
	const afterLatestRun = latestRun === undefined ? {} : { afterSeq: latestRun.seq };
	const [enqueued, cancelled] = await Promise.all([
		session.findRecords({
			lane,
			type: "queue_enqueued",
			...afterLatestRun,
			order: "oldestFirst",
		}),
		session.findRecords({
			lane,
			type: "queue_cancelled",
			...afterLatestRun,
			order: "oldestFirst",
		}),
	]);

	// A run captures every older next-run item at acceptance. Only uncaptured
	// next-run records after that boundary remain relevant while the lane is idle.
	return [
		...enqueued.filter((record) => record.queue === "nextRun"),
		...cancelled.filter((record) => record.runId === undefined),
	].sort((left, right) => left.seq - right.seq);
}

/** Reads the latest explicit persisted value for each lane configuration dimension. */
async function readConfigurationEntries(session: Session, leafId: string | null): Promise<Entry[]> {
	// A root-positioned lane has no ancestor entries from which to derive configuration.
	if (leafId === null) return [];

	// Read each independent persisted configuration dimension concurrently.
	// Operation-owned assistant entries are supplied separately through ownEntries.
	// TODO(H4): Also restore model state from the newest assistant message or model_change,
	// whichever is newer. This requires a bounded branch query that can filter by message role.
	// TODO: Push entry filters and limits into SQLite's branch query before treating these as
	// bounded lookups; it currently filters and slices after decoding the complete branch.
	const entries = await Promise.all([
		session.findEntryOnBranch({ start: leafId, type: "model_change" }),
		session.findEntryOnBranch({ start: leafId, type: "thinking_level_change" }),
		session.findEntryOnBranch({ start: leafId, type: "active_tools_change" }),
	]);

	// Drop configuration dimensions with no persisted value, then order the
	// remaining entries chronologically so the reducer applies the newest last.
	return entries.filter((entry): entry is Entry => entry !== undefined).sort((left, right) => left.seq - right.seq);
}

interface RestoredLane {
	reduction: LaneReductionResult;
	started?: OperationStartedRecord;
}

/**
 * Restores one lane from its current durable pointer and recovery records.
 * `leafId === null` means the lane currently points at the tree root; it does
 * not imply that the lane is idle or has no records. A root-positioned lane
 * may still have an open operation or pending next-run input.
 */
async function restoreLane(
	options: AgentHarnessOptions,
	lane: string,
	leafId: string | null,
	defaultConfiguration: EffectiveLaneConfiguration,
): Promise<RestoredLane> {
	const openOperations = await options.session.findOpenOperations(lane, { limit: 2 });
	if (openOperations.length > 1) {
		throw new RecordLogCorruption("multiple_open_operations", `Lane ${lane} has multiple open operations`);
	}

	// One open start means the lane is suspended; reconstruct its operation
	// records, operation-owned entries, and configuration at the start anchor.
	const started = openOperations[0];
	if (started) {
		const ownEntriesPromise =
			started.intent.kind === "navigation"
				? Promise.resolve<Entry[]>([])
				: readOwnEntries(options.session, leafId, started.sourceLeafId, started.seq);
		const [laterRecords, branchOwnEntries, configurationEntries] = await Promise.all([
			options.session.findRecords({ lane, afterSeq: started.seq, order: "oldestFirst" }),
			ownEntriesPromise,
			readConfigurationEntries(options.session, started.sourceLeafId),
		]);

		const recoveryTargetEntries = await readRecoveryTargetEntries(options.session, [started, ...laterRecords]);
		const ownEntries =
			started.intent.kind === "navigation"
				? restoreNavigationOwnEntries(started, leafId, recoveryTargetEntries)
				: branchOwnEntries;
		// Deduplicate targets already present in the operation-owned entries.
		const entries = [
			...new Map([...ownEntries, ...recoveryTargetEntries].map((entry) => [entry.id, entry])).values(),
		];
		const laneReductionInput: LaneReductionInput = {
			lane,
			leafId,
			openOperations,
			records: [started, ...laterRecords],
			entries,
			ownEntries,
			configurationEntries,
			defaults: defaultConfiguration,
		};
		return { reduction: reduceLaneState(laneReductionInput), started };
	}

	// An idle lane has no operation-owned entries; restore only pending next-run
	// input and the effective configuration at its current leaf.
	const [records, configurationEntries] = await Promise.all([
		readIdleQueueRecords(options.session, lane),
		readConfigurationEntries(options.session, leafId),
	]);
	const entries = await readRecoveryTargetEntries(options.session, records);
	return {
		reduction: reduceLaneState({
			lane,
			leafId,
			openOperations,
			records,
			entries,
			ownEntries: [],
			configurationEntries,
			defaults: defaultConfiguration,
		}),
	};
}

function findMissingIdentities(
	options: AgentHarnessOptions,
	reduction: LaneReductionResult,
): SuspendedOperation["missing"] {
	const operation = reduction.laneState.operation;
	if (!operation || operation.aborting) return { tools: [], models: [] };

	const availableTools = new Set((options.tools ?? []).map((tool) => tool.name));
	const requiredTools = new Set(operation.kind === "run" ? reduction.effectiveConfiguration.activeToolNames : []);
	const toolBatch = operation.toolBatch;
	// Truncated batches and replay-never calls synthesize unresolved results
	// without executing the referenced tools.
	if (toolBatch && !toolBatch.truncated) {
		for (const call of toolBatch.calls) {
			if (!call.resultExists && call.started?.replay !== "never") {
				requiredTools.add(call.started?.toolName ?? call.toolCall.name);
			}
		}
	}

	const requiredModels = new Map<string, { provider: string; modelId: string }>();
	const needsEffectiveModel =
		operation.kind === "run" ||
		(operation.kind === "compaction" && operation.targets.result !== true) ||
		(operation.kind === "navigation" &&
			operation.intent.kind === "navigation" &&
			operation.intent.summarize &&
			operation.targets.summary !== true);
	if (needsEffectiveModel) {
		const effectiveModel = reduction.effectiveConfiguration.model;
		requiredModels.set(`${effectiveModel.provider}/${effectiveModel.modelId}`, effectiveModel);
	}
	const deferred = operation.deferred;
	if (deferred) {
		requiredModels.set(`${deferred.provider}/${deferred.modelId}`, {
			provider: deferred.provider,
			modelId: deferred.modelId,
		});
	}

	return {
		tools: [...requiredTools].filter((name) => !availableTools.has(name)),
		models: [...requiredModels].flatMap(([identity, model]) =>
			options.models.getModel(model.provider, model.modelId) ? [] : [identity],
		),
	};
}

/**
 * Projects reducer-owned restored state into the public suspended inventory.
 * This performs runtime identity checks only; it neither mutates durable state
 * nor starts recovery work.
 */
function buildSuspendedOperation(options: AgentHarnessOptions, restored: RestoredLane): SuspendedOperation | undefined {
	const operation = restored.reduction.laneState.operation;
	if (!operation) return undefined;
	if (!restored.started || restored.started.id !== operation.id) {
		throw new Error(`Restored lane ${restored.reduction.laneState.lane} is missing its operation start`);
	}

	const deferred = operation.deferred ? structuredClone(operation.deferred) : undefined;
	let abortingQueues: { steer: AgentMessage[]; followUp: AgentMessage[] } | undefined;
	if (operation.aborting) {
		if (operation.abortingQueues === null) {
			throw new Error(`Restored aborting lane ${restored.reduction.laneState.lane} is missing its cleared queues`);
		}
		abortingQueues = operation.abortingQueues;
	}
	return {
		lane: restored.reduction.laneState.lane,
		kind: operation.kind,
		id: operation.id,
		startedAt: restored.started.timestamp,
		reason: deferred ? "deferred" : "crash",
		...(operation.intent.kind === "run" ? { prompt: structuredClone(operation.intent.originalPrompt) } : {}),
		...(deferred ? { deferred } : {}),
		...(abortingQueues ? { aborting: structuredClone(abortingQueues) } : {}),
		missing: findMissingIdentities(options, restored.reduction),
	};
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly restoredLanes: Map<string, LaneReductionResult>;
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private closed = false;

	private constructor(options: AgentHarnessOptions, restoredLanes: ReadonlyMap<string, LaneReductionResult>) {
		this.restoredLanes = new Map(restoredLanes);
		this.session = options.session;
		this.hooks = new UnavailableRegistry("hooks.on", () => this.closed);
		this.events = new UnavailableRegistry("events.on", () => this.closed);
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
	}

	/**
	 * Opens the durable session and reconstructs every lane without starting work.
	 * For each lane, restore performs bounded recovery queries, validates the
	 * durable prefix (the committed operation sequence up to the crash boundary),
	 * reduces it into process-local lane state and effective configuration,
	 * and retains that state in the returned harness. Corrupt session state rejects
	 * creation. Missing tools or models are reported on the corresponding suspended
	 * operation instead of rejecting creation.
	 *
	 * The returned suspended inventory describes every open operation so the
	 * caller can decide whether to resume or abort it. Creation itself performs
	 * no durable writes, provider requests, tool calls, hooks, or automatic
	 * resumes.
	 */
	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		// Use the spread operator here to snapshot the option so
		// caller mutations during async restore cannot change lane defaults.
		const activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		const defaultConfiguration: EffectiveLaneConfiguration = {
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: options.thinkingLevel ?? "off",
			activeToolNames,
		};
		const restoredLanes = new Map<string, LaneReductionResult>();
		const suspended: SuspendedOperation[] = [];
		for (const { lane, leafId } of await options.session.getLanes()) {
			const restored = await restoreLane(options, lane, leafId, defaultConfiguration);
			restoredLanes.set(lane, restored.reduction);
			const suspendedOperation = buildSuspendedOperation(options, restored);
			if (suspendedOperation) suspended.push(suspendedOperation);
		}

		return { harness: new AgentHarness(options, restoredLanes), suspended };
	}

	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		if (!this.restoredLanes.has("main")) throw new Error("Restored session does not contain the main lane");
		return this.session.getLeafId();
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(_input: string | AgentMessage | AgentMessage[], _images?: ImageContent[]): Promise<RunResult> {
		return this.unavailable("prompt");
	}
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unavailable("skill");
	}
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unavailable("promptFromTemplate");
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.unavailable("compact");
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}
	async resume(): Promise<ResumeResult> {
		return this.unavailable("resume");
	}
	async abort(): Promise<AbortResult> {
		return this.unavailable("abort");
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("steer");
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("followUp");
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("nextRun");
	}
	async cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		return this.unavailable("cancelQueued");
	}
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.unavailable("recordUsage");
	}
	async waitForIdle(): Promise<void> {
		return this.unavailable("waitForIdle");
	}
	async runWhenIdle(_callback: () => void | Promise<void>): Promise<void> {
		return this.unavailable("runWhenIdle");
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("peekAction");
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("executeAction");
	}
	async runToCompletion(): Promise<void> {
		return this.unavailable("runToCompletion");
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.unavailable("watch");
	}

	async lane(_name: string): Promise<AgentLane | undefined> {
		return this.unavailable("lane");
	}
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	async lanes(): Promise<LaneInfo[]> {
		return this.unavailable("lanes");
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		return this.unavailable("watchSession");
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}
