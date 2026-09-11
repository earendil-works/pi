import type { JsonRepresentation } from "@earendil-works/chord";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageFrame,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, AgentToolResult, QueueMode, ThinkingLevel } from "../types.ts";
import type { BranchPreparation, BranchSummaryResult } from "./compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings, CompactResult } from "./compaction/compaction.ts";
import type { Context } from "./context.ts";
import type {
	Closed,
	InvalidMessage,
	InvalidNavigation,
	LaneBusy,
	NoActiveOperation,
	NothingToCompact,
	NothingToResume,
	OperationMismatch,
	Result,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
} from "./result.ts";

export {
	Closed,
	HarnessClosed,
	HarnessFault,
	InvalidLane,
	InvalidMessage,
	InvalidNavigation,
	LaneBusy,
	NoActiveOperation,
	NoActiveRun,
	NothingToCompact,
	NothingToResume,
	OperationMismatch,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
} from "./result.ts";
export { SliceNotImplemented } from "./runtime/types.ts";

import { createAgentHarness } from "./runtime/harness.ts";
import type {
	BranchScan,
	Entry,
	EntryProjector,
	JsonValue,
	LaneConfiguration,
	OperationError,
	OperationResultRecord,
	Session,
	SessionStats,
	SettledAssistantMessage,
	UsageRow,
} from "./session/types.ts";
import type {
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessTool,
	PromptTemplate,
	Skill,
} from "./types.ts";

/** Convenience-only suspended run observation, constructed when M8 exposes public drive. */
export interface SuspendedRun {
	operationId: string;
	status: "suspended";
	deferred: DeferredHandle;
}

export type RunResult = Result<
	OperationResultRecord | SuspendedRun,
	LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed
>;
export type CompactionResult = Result<
	{ compaction: OperationResultRecord; run?: OperationResultRecord | SuspendedRun },
	LaneBusy | NothingToCompact | Closed
>;
export type NavigationResult = Result<
	{ navigation: OperationResultRecord; run?: OperationResultRecord | SuspendedRun },
	LaneBusy | InvalidNavigation | UnknownTarget | Closed
>;
export type ResumeResult = Result<OperationResultRecord | SuspendedRun, NothingToResume | Closed>;
export type QueueResult = Result<{ entryId: string }, InvalidMessage | Closed>;
export type CancelQueuedResult = Result<{ kind: "cancelled" | "already_consumed" | "not_found" }, Closed>;
export type AbortResult = Result<
	{ operationId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	NoActiveOperation | Closed
>;
export type RecordUsageResult = Result<{ usageId: string }, Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	label?: string;
	customInstructions?: string;
}

export type OperationRequest =
	| { kind: "prompt"; operationId?: string; prompt: string; images?: ImageContent[] }
	| { kind: "prompt"; operationId?: string; prompt: AgentMessage | AgentMessage[]; images?: never }
	| { kind: "skill"; operationId?: string; name: string; additionalInstructions?: string }
	| { kind: "prompt_template"; operationId?: string; name: string; args?: string[] }
	| { kind: "compaction"; operationId?: string; customInstructions?: string }
	| { kind: "navigation"; operationId?: string; targetId: string | null; options?: NavigateOptions };

export interface OperationAdmission {
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
}

export type OperationAdmissionError =
	| LaneBusy
	| InvalidMessage
	| UnknownSkill
	| UnknownTemplate
	| NothingToCompact
	| InvalidNavigation
	| UnknownTarget
	| Closed;
export type OperationAdmissionResult = Result<OperationAdmission, OperationAdmissionError>;

export interface DriveOptions {
	operationId: string;
	waitForRetry?: boolean;
	pollDeferred?: boolean;
}

export interface ModelIdentity {
	provider: string;
	modelId: string;
}

export type OperationStatus = "running" | "open" | "aborting";

export interface CurrentOperationInfo {
	id: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
	status: OperationStatus;
	capturedModel?: ModelIdentity;
}

export interface LaneExecutionInfo {
	lane: string;
	tipId: string | null;
	configuredModel: ModelIdentity;
	current: CurrentOperationInfo | null;
	lastOperationId: string | null;
}

export type DriveOutcome =
	| { kind: "settled"; outcome: OperationResultRecord }
	| { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
	| { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle };
export type DriveResult = Result<DriveOutcome, OperationMismatch | Closed>;

export type AbortRequestResult = Result<
	{
		operationId: string;
		newlyRequested: boolean;
		steer: AgentMessage[];
		followUp: AgentMessage[];
	},
	OperationMismatch | Closed
>;

export interface WatchHandle<T> {
	snapshot: T;
	start(listener: EventListener): void;
	resnapshot(context: Context): Promise<T>;
	unsubscribe(): void;
}

export interface LaneInfo {
	name: string;
	tipId: string | null;
	operation: CurrentOperationInfo | null;
}

export type LaneSnapshotTool =
	| {
			status: "running";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: AgentToolResult<unknown>;
	  }
	| {
			status: "settled";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result: AgentToolResult<unknown>;
			isError: boolean;
	  };

export interface OpenOperation {
	lane: string;
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
	aborting?: true;
}

export type LaneQueuedItem =
	| {
			entryId: string;
			kind: "steer" | "followUp" | "nextRun" | "write";
			type: "message";
			message: AgentMessage;
	  }
	| { entryId: string; kind: "write"; type: "custom"; customType: string; data?: JsonValue };

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	tipId: string | null;
	lastResult?: OperationResultRecord;
	configuration: LaneConfiguration;
	stats: SessionStats;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		startedAt: number;
		fromTipId: string | null;
		status: OperationStatus;
		retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
		deferred?: { handle: DeferredHandle; poll: number };
		streamingMessage?: AssistantMessage;
		runningTools: LaneSnapshotTool[];
	};
	queues: LaneQueuedItem[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: LaneInfo[];
	faulted: boolean;
}

export type HarnessEventPayload =
	| { type: "run_start"; runId: string; startedAt: number }
	| { type: "run_resume"; runId: string }
	| { type: "run_suspend"; runId: string; reason: "deferred"; deferred: DeferredHandle; poll: number }
	| { type: "operation_abort"; operationId: string; steer: AgentMessage[]; followUp: AgentMessage[] }
	| ({ type: "run_end"; runId: string; fromTipId: string | null; tipId: string | null; endedAt: number } & (
			| { status: "completed" | "aborted"; error?: never }
			| { status: "failed"; error: OperationError }
	  ))
	| { type: "fault"; code: string; message: string }
	| ({ type: "handler_error"; error: string; stack?: string } & (
			| { kind: "hook"; hook: string }
			| { kind: "event"; event: string }
	  ))
	| { type: "turn_start"; runId: string; turnId: string }
	| {
			type: "turn_end";
			runId: string;
			turnId: string;
			message: AssistantMessage;
			toolResults: ToolResultMessage[];
	  }
	| {
			type: "retry_scheduled";
			runId: string;
			step: string;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			notBefore: number;
			errorMessage: string;
	  }
	| { type: "retry_start"; runId: string; step: string; attempt: number }
	| {
			type: "retry_end";
			runId: string;
			step: string;
			attempt: number;
			success: boolean;
			finalError?: string;
	  }
	| { type: "message_start"; runId?: string; message: AgentMessage }
	| {
			type: "message_update";
			runId: string;
			message: AgentMessage;
			event: AssistantMessageEvent;
			frame?: AssistantMessageFrame;
	  }
	| { type: "message_end"; runId?: string; message: AgentMessage; entryId?: string }
	| {
			type: "tool_start";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_update";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_end";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			terminate: boolean;
	  }
	| { type: "entry_added"; entry: Entry }
	| { type: "queue_update"; queues: LaneQueuedItem[] }
	| ({ type: "value_update" } & (
			| { value: "session_name"; name: string | undefined }
			| { value: "entry_label"; targetId: string; label: string | undefined }
	  ))
	| ({ type: "config_update" } & (
			| {
					property: "model";
					value: { provider: string; modelId: string };
					previous: unknown;
			  }
			| { property: "thinkingLevel"; value: ThinkingLevel; previous: ThinkingLevel }
			| { property: "activeTools"; value: string[]; previous: string[] }
			| { property: "tools" | "resources" }
			| {
					property: "streamOptions";
					value: AgentHarnessStreamOptions;
					previous: AgentHarnessStreamOptions;
			  }
			| { property: "retryPolicy"; value: RetryPolicy; previous: RetryPolicy }
			| { property: "compactionSettings"; value: CompactionSettings; previous: CompactionSettings }
			| { property: "steeringMode"; value: QueueMode; previous: QueueMode }
			| { property: "followUpMode"; value: QueueMode; previous: QueueMode }
	  ))
	| {
			type: "compaction_start";
			runId: string;
			reason: "manual" | "threshold" | "overflow";
			startedAt: number;
	  }
	| ({ type: "compaction_end"; runId: string; reason: "manual" | "threshold" | "overflow"; endedAt: number } & (
			| { status: "completed"; entryId: string; error?: never }
			| { status: "declined" | "aborted"; entryId?: never; error?: never }
			| { status: "failed"; entryId?: never; error: OperationError }
	  ))
	| { type: "navigation_start"; runId: string; targetId: string | null; startedAt: number }
	| ({ type: "navigation_end"; runId: string; fromTipId: string | null; tipId: string | null; endedAt: number } & (
			| { status: "completed" | "declined" | "aborted"; error?: never }
			| { status: "failed"; error: OperationError }
	  ))
	| { type: "lane_created"; at: string | null }
	| { type: "usage"; lane: string; row: UsageRow; totals: Usage };

export type SpecialEventPayload = Extract<
	HarnessEventPayload,
	{ type: "fault" | "value_update" | "usage" | "config_update" | "handler_error" }
>;
export type LaneEventPayload = Exclude<HarnessEventPayload, SpecialEventPayload>;
export type ConfigEventPayload = Extract<HarnessEventPayload, { type: "config_update" }>;
export type LaneConfigEventPayload = Extract<
	ConfigEventPayload,
	{ property: "model" | "thinkingLevel" | "activeTools" }
>;
export type GlobalConfigEventPayload = Exclude<ConfigEventPayload, LaneConfigEventPayload>;
export type HandlerErrorPayload = Extract<HarnessEventPayload, { type: "handler_error" }>;

export type HarnessEvent =
	| (LaneEventPayload & { lane: string; recovery?: true })
	| (LaneConfigEventPayload & { lane: string; recovery?: true })
	| (Extract<HarnessEventPayload, { type: "fault" | "value_update" }> & {
			lane?: never;
			recovery?: never;
	  })
	| (Extract<HarnessEventPayload, { type: "usage" }> & { recovery?: never })
	| (GlobalConfigEventPayload & { lane?: never; recovery?: never })
	| (HandlerErrorPayload & ({ lane: string; recovery?: true } | { lane?: never; recovery?: never }));

type LaneWatchSourceEvent =
	| Exclude<
			HarnessEvent,
			| { type: "handler_error" | "turn_start" | "turn_end" | "value_update" | "lane_created" | "message_update" }
			| ({ type: "config_update" } & { property: string })
	  >
	| Extract<HarnessEvent, { type: "config_update"; property: "model" | "thinkingLevel" | "activeTools" }>
	| Omit<Extract<HarnessEvent, { type: "message_update" }>, "event">;

/** Strict-JSON snapshot representation published to remote transcript consumers. */
export type LaneTranscriptSnapshot = JsonRepresentation<LaneSnapshot>;
/** Reducer-relevant strict-JSON Harness events published to remote transcript consumers. */
export type LaneWatchEvent = JsonRepresentation<LaneWatchSourceEvent>;

export type HarnessEventType = HarnessEvent["type"];
export type EventListener<TEvent extends HarnessEvent = HarnessEvent> = (
	event: TEvent,
	context: Context,
) => void | Promise<void>;

export interface Events {
	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void;
}

export type Resources = AgentHarnessResources<Skill, PromptTemplate>;

type VoidHookResult = ReturnType<() => void>;

export interface HookMap {
	before_run: {
		event: { prompt: AgentMessage[]; resources: Resources };
		result: { messages?: AgentMessage[] } | undefined;
	};
	before_drive: {
		event: { operation: "run" | "compaction" | "navigation" };
		result: VoidHookResult;
	};
	before_run_end: {
		event: { runId: string; messages: AgentMessage[] };
		result: { followUp?: string } | undefined;
	};
	transform_context: {
		event: { messages: AgentMessage[]; systemPrompt: string };
		result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
	};
	before_request: {
		event: {
			model: Model<Api>;
			step: "assistant" | "deferred" | "compaction" | "branch_summary";
			attempt: number;
			streamOptions: AgentHarnessStreamOptions;
		};
		result: { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined;
	};
	before_payload: {
		event: { model: Model<Api>; payload: unknown };
		result: { payload: unknown } | undefined;
	};
	after_response: {
		event: { status?: number; headers?: Record<string, string>; message: SettledAssistantMessage };
		result: { message?: SettledAssistantMessage } | undefined;
	};
	before_tool: {
		event: { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
		result: { args?: Record<string, JsonValue>; block?: { reason: string; terminate?: boolean } } | undefined;
	};
	after_tool: {
		event: {
			toolCallId: string;
			toolName: string;
			args: Record<string, JsonValue>;
			content: AgentToolResult<unknown>["content"];
			details?: JsonValue;
			isError: boolean;
			usage?: Usage;
		};
		result:
			| {
					content?: AgentToolResult<unknown>["content"];
					details?: JsonValue;
					isError?: boolean;
					usage?: Usage;
					terminate?: boolean;
			  }
			| undefined;
	};
	before_compaction: {
		event: {
			reason: "manual" | "threshold" | "overflow";
			preparation: CompactionPreparation;
			customInstructions?: string;
		};
		result: { decline?: boolean; compaction?: CompactResult } | undefined;
	};
	before_navigation: {
		event: { targetId: string; preparation: BranchPreparation; customInstructions?: string };
		result: { decline?: boolean; summary?: BranchSummaryResult } | undefined;
	};
}

export type HookName = keyof HookMap;
export type HookInvocation<TName extends HookName> = HookMap[TName]["event"] & {
	lane: string;
	runId: string;
};
export type HookHandler<TName extends HookName> = (
	event: HookInvocation<TName>,
	context: Context,
) => Promise<HookMap[TName]["result"]> | HookMap[TName]["result"];

export interface Hooks {
	on<TName extends HookName>(name: TName, handler: HookHandler<TName>, options?: { id?: string }): () => void;
}

export type { EntryProjector } from "./session/types.ts";

export interface AgentHarnessOptions<TContext extends object | undefined = object | undefined> {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: AgentHarnessTool<TContext>[];
	toolContext?: TContext | ((context: Context) => TContext | Promise<TContext>);
	systemPrompt?: string | ((toolContext: TContext, context: Context) => string | Promise<string>);
	resources?: Resources;
	streamOptions?: AgentHarnessStreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	toProviderMessages?: (messages: AgentMessage[], context: Context) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
}

export interface AgentLane {
	readonly name: string;
	getTipId(context: Context): Promise<string | null>;
	findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage, context: Context): Promise<string>;
	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
	getResult(operationId: string, context: Context): Promise<OperationResultRecord | undefined>;
	accept(request: OperationRequest, context: Context): Promise<OperationAdmissionResult>;
	drive(options: DriveOptions, context: Context): Promise<DriveResult>;
	requestAbort(operationId: string, context: Context): Promise<AbortRequestResult>;
	inspectExecution(context: Context): Promise<LaneExecutionInfo>;
	prompt(text: string, images: ImageContent[] | undefined, context: Context): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[], context: Context): Promise<RunResult>;
	skill(name: string, additionalInstructions: string | undefined, context: Context): Promise<RunResult>;
	promptFromTemplate(name: string, args: string[] | undefined, context: Context): Promise<RunResult>;
	compact(options: { customInstructions?: string } | undefined, context: Context): Promise<CompactionResult>;
	navigateTree(
		targetId: string | null,
		options: NavigateOptions | undefined,
		context: Context,
	): Promise<NavigationResult>;
	resume(context: Context): Promise<ResumeResult>;
	abort(context: Context): Promise<AbortResult>;
	steer(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult>;
	followUp(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult>;
	nextRun(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult>;
	cancelQueued(entryId: string, context: Context): Promise<CancelQueuedResult>;
	recordUsage(
		usage: Usage,
		options: { entryId?: string; details?: JsonValue } | undefined,
		context: Context,
	): Promise<RecordUsageResult>;
	waitForIdle(context: Context): Promise<void>;
	runWhenIdle(callback: (context: Context) => void | Promise<void>, context: Context): Promise<void>;
	getModel(context: Context): Promise<Model<Api> | undefined>;
	setModel(model: ModelIdentity, context: Context): Promise<void>;
	getThinkingLevel(context: Context): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel, context: Context): Promise<void>;
	getActiveTools(context: Context): Promise<string[]>;
	setActiveTools(names: string[], context: Context): Promise<void>;
	watch(context: Context): Promise<WatchHandle<LaneSnapshot>>;
}

export interface AcquireLaneOptions {
	createAt?: string | null;
}

export interface AgentHarness<TContext extends object | undefined = object | undefined> {
	lane(name: string, context: Context): Promise<AgentLane>;
	lane(name: string, options: AcquireLaneOptions, context: Context): Promise<AgentLane>;
	lanes(context: Context): Promise<LaneInfo[]>;
	getName(context: Context): Promise<string | undefined>;
	setName(name: string | undefined, context: Context): Promise<void>;
	getLabel(targetId: string, context: Context): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
	getTools(context: Context): Promise<AgentHarnessTool<TContext>[]>;
	setTools(tools: AgentHarnessTool<TContext>[], context: Context): Promise<void>;
	getResources(context: Context): Promise<Resources>;
	setResources(resources: Resources, context: Context): Promise<void>;
	getStreamOptions(context: Context): Promise<AgentHarnessStreamOptions>;
	setStreamOptions(options: AgentHarnessStreamOptions, context: Context): Promise<void>;
	getRetryPolicy(context: Context): Promise<RetryPolicy>;
	setRetryPolicy(policy: RetryPolicy, context: Context): Promise<void>;
	getCompactionSettings(context: Context): Promise<CompactionSettings>;
	setCompactionSettings(settings: CompactionSettings, context: Context): Promise<void>;
	getSteeringMode(context: Context): Promise<QueueMode>;
	setSteeringMode(mode: QueueMode, context: Context): Promise<void>;
	getFollowUpMode(context: Context): Promise<QueueMode>;
	setFollowUpMode(mode: QueueMode, context: Context): Promise<void>;
	watchSession(context: Context): Promise<WatchHandle<SessionSnapshot>>;
	readonly hooks: Hooks;
	readonly events: Events;
	close(context: Context): Promise<void>;
}

export interface AgentHarnessConstructor {
	create<TContext extends object | undefined = object | undefined>(
		options: AgentHarnessOptions<TContext>,
		context: Context,
	): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }>;
}

/** Runtime constructor for attaching the durable harness to one open session. */
export const AgentHarness = { create: createAgentHarness } satisfies AgentHarnessConstructor;
