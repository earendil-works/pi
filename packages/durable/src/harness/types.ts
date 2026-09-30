import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import type {
	AssistantMessage,
	CacheRetention,
	Message,
	Models,
	ModelThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "../env/index.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	DocumentObserver,
	DocumentReader,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Page,
	Session,
	SubmissionId,
	SubmissionRecord,
	Task,
	TaskId,
	TaskOptions,
	TaskRecord,
	TaskState,
	Tx,
	WatchHandle,
} from "../types.ts";
import type { UsageState } from "./usage.ts";
import type { ConversationView } from "./view.ts";

/** Provider and model ID resolved through pi-ai `Models`. */
export type ModelRef = {
	readonly provider: string;
	readonly modelId: string;
};

export type UserInput = UserMessage["content"];

/** Host submission: user input that may start a run, or a passive entry write. */
export type SubmissionDraft = {
	readonly requestId?: string;
} & (
	| {
			readonly type: "input";
			readonly content: UserInput;
			readonly whenBusy?: "steer" | "followUp" | "reject";
			readonly entry?: never;
	  }
	| {
			readonly type: "write";
			readonly entry: EntryDraft;
			readonly content?: never;
			readonly whenBusy?: never;
	  }
);

export type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

export type SettledSubmissionRecord = SubmissionRecord & {
	readonly status: "done" | "unanswered";
};

/** Awaitable host object for one durably admitted submission. */
export interface Submission {
	readonly id: SubmissionId;
	status(context: Context): Promise<SubmissionRecord>;
	wait(context: Context): Promise<SettledSubmissionRecord>;
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
	readonly state: Extract<TaskState<JsonValue, R>, { readonly status: "terminal" }>;
};

/** Erased executable task definition stored in the registry. */
export type AnyTask = {
	readonly definition: {
		readonly name: string;
		readonly version: number;
		readonly initial: unknown;
		readonly phases: Readonly<Record<string, unknown>>;
		readonly abort: unknown;
		readonly migrate?: unknown;
		readonly hooks?: object;
	};
};

/** Options of `Conversation.abort()`. */
export type ConversationAbortOptions = {
	/**
	 * Cross background boundaries: mark every live task reached ignoring the background flag when the abort is admitted,
	 * withdraw the queued inputs of every conversation reached, and wait until those tasks are terminal and the
	 * conversation is ordinarily idle. Background work created afterwards is neither marked nor awaited.
	 */
	readonly background?: boolean;
};

/** Hook handler map declared by a task definition. */
export type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H> ? H : never;

/**
 * Invocation-bound conversation operations for tasks and tools. Rejects after the invocation ends; passive entries are
 * written with ordinary transaction writes instead.
 */
export interface ConversationHandle {
	readonly id: ConversationId;
	submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
	/** `Conversation.abort()`: withdraw queued inputs, abort the ordinary ownership scope, and wait until it is idle. */
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/** Resolve when the conversation's ordinary ownership scope has no live non-background task. */
	waitForIdle(context: Context): Promise<void>;
}

/** Post-tools controls requested by a tool result. */
export type ToolControl = {
	readonly addTools?: readonly string[];
	readonly terminate?: true;
	readonly handoff?: string;
};

/** Remark about a call for the model and the UI, such as truncation or a spill path; never part of the tool's data. */
export type ToolDiagnostic = {
	readonly severity: "info" | "warn" | "error";
	readonly message: string;
	readonly code?: string;
};

export type ToolExecutionResult = {
	/** Omitted: the retained `output()` text becomes the content. */
	readonly content?: ToolResultMessage["content"];
	readonly isError?: boolean;
	/** Omitted: the last `details()` value becomes the details. */
	readonly details?: JsonValue;
	/** Added after those recorded through `api.diagnostic()`. */
	readonly diagnostics?: readonly ToolDiagnostic[];
	/** Spend of the execution itself, such as a model call; stored on the result and in `pi.usage.tools`. */
	readonly usage?: Usage;
	readonly control?: ToolControl;
};

/** Whether the tools of one round run at once or one after another in call order. */
export type ToolExecutionMode = "parallel" | "sequential";

/** How many queued items of one mode a boundary places: the first, or all of them. */
export type QueueMode = "all" | "one-at-a-time";

/**
 * Operations available to one tool invocation. A plain object, so a wrapper can pass `{ ...api, env }` to the tool it
 * wraps. Every operation rejects after the invocation ends.
 */
export interface ToolExecutionApi extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly callId: string;
	/** `HarnessOptions.env` unless a wrapper supplies another environment. */
	readonly env: ExecutionEnv | undefined;
	/** Append running output; it becomes the result content when the result omits `content`. */
	output(chunk: string | Uint8Array): void;
	/** Record a model-visible remark about this call. */
	diagnostic(diagnostic: ToolDiagnostic): void;
	/** Replace running details; the last value becomes the result details when the result omits `details`. */
	details(value: JsonValue, context: Context): Promise<void>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: Omit<TaskOptions, "conversationId">,
		context: Context,
	): Promise<TaskId<R>>;
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** Invocation-bound handle of an existing conversation, such as one this tool created in `commit()`. */
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
}

/** Executable tool registered in a registry. Only pi-ai `Tool` fields enter the transcript. */
export type ToolRegistration = Tool & {
	/** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */
	readonly replay?: "safe" | "unsafe";
	/** Default: the conversation's `toolExecution`. One sequential call makes its whole round sequential. */
	readonly executionMode?: ToolExecutionMode;
	/**
	 * Repair arguments models commonly get wrong before validation, such as a JSON string where an array belongs. Must be
	 * pure and must not mutate `args`: it runs again when a call is retried before its intent is recorded.
	 */
	prepareArguments?(args: JsonValue): JsonValue;
	readonly outputLimits?: {
		readonly maxBytes?: number;
		readonly maxLines?: number;
		readonly retain?: "head" | "tail";
	};
	execute(args: JsonValue, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult>;
};

/** Token for removing registrations. Work already running keeps using what it started with. */
export interface Registration {
	/** Idempotent; removes exactly the registrations this token covers. */
	dispose(): void;
}

/** Pure decorator; returns a new tool with the same name and never mutates its input. */
export type ToolWrapper<Tool extends ToolRegistration> = (tool: Tool) => Tool;

/** Conversation selection for a scoped hook registration. */
export type HookScope = {
	readonly conversationId: ConversationId;
	/** Also match conversations owned, transitively, by tasks of this conversation. */
	readonly subtree?: boolean;
};

/** Input to system prompt section rendering for one request preparation. */
export type PromptInput<Tool extends ToolRegistration> = {
	readonly conversationId: ConversationId;
	/** Active and registered tools in configured order, as offered in this request. */
	readonly tools: readonly Tool[];
	/** Sections already in effect after replaying the active transcript. */
	readonly shown: Readonly<Record<string, string>>;
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Committed document reads. */
	readonly read: DocumentReader;
};

/** One registered system prompt section; sections render in registry order before each request. */
export type PromptSection<Tool extends ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
	/** Default true: wrap the text as `<key>\n...\n</key>`. */
	readonly tag?: boolean;
};

/** Pure decorator; returns a new section with the same key and never mutates its input. */
export type PromptSectionWrapper<Tool extends ToolRegistration> = (section: PromptSection<Tool>) => PromptSection<Tool>;

/** One registered hook handler map for task `K`. */
export type HookRegistration<K extends AnyTask> = {
	readonly handlers: Partial<HooksOf<K>>;
	readonly scope?: HookScope;
};

/** Wrapper composition failure found while building a snapshot. */
export type RegistryFailure = {
	readonly kind: "tool" | "section";
	/** Tool name or section key. */
	readonly name: string;
	readonly error: unknown;
};

/** Immutable view of one published registry state. */
export interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
	/** Composed tools in registry order; a tool whose wrapper failed is absent. */
	tools(): readonly Tool[];
	tool(name: string): Tool | undefined;
	/** Base tool names in registry order, including tools whose wrappers fail. */
	toolNames(): readonly string[];
	task(name: string): AnyTask | undefined;
	/** Hooks registered for tasks with `task`'s name, in registry order. */
	hooks<K extends AnyTask>(task: K): readonly HookRegistration<K>[];
	/** Composed sections in registry order; a section whose wrapper failed is absent. */
	sections(): readonly PromptSection<Tool>[];
	/** Wrapper failures of this state. */
	failures(): readonly RegistryFailure[];
	/** Conversation setups in registry order, the built-in `pi` setup first. */
	conversationSetups(): readonly { readonly key: string; readonly setup: ConversationSetup }[];
}

/** Read side of a registry consumed by a Harness. */
export interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
	/** Immutable view of the whole current registry. */
	snapshot(): RegistrySnapshot<Tool>;
	/** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
	subscribe(listener: () => void): () => void;
}

/** Application-owned registry of tools, hooks, tasks, and the system prompt. */
export interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
	readonly tools: {
		add(tool: Tool): Registration;
		/** `key` identifies the wrapper: it orders wrappers of one tool and keeps its position on re-registration. */
		wrap(name: string, key: string, wrapper: ToolWrapper<Tool>): Registration;
		/** Composed tools of the current state. */
		list(): readonly Tool[];
	};
	readonly hooks: {
		add<K extends AnyTask>(
			task: K,
			handlers: Partial<HooksOf<K>>,
			options?: { readonly scope?: HookScope; readonly key?: string },
		): Registration;
	};
	readonly tasks: {
		add(task: AnyTask): Registration;
		list(): readonly AnyTask[];
	};
	readonly conversations: {
		/** `key` orders setups and keeps its position on re-registration. */
		setup(key: string, setup: ConversationSetup): Registration;
	};
	readonly systemPrompt: {
		section(key: string, render: PromptSection<Tool>["render"], options?: { readonly tag?: boolean }): Registration;
		wrap(key: string, wrapperKey: string, wrapper: PromptSectionWrapper<Tool>): Registration;
		/** Composed sections of the current state. */
		sections(): readonly PromptSection<Tool>[];
	};
	/** Stage registrations and disposals made synchronously by `register`, then publish them at once. Cannot nest. */
	batch(register: () => void): Registration;
}

/**
 * Stages the documents every new conversation gets. Runs inside every Harness commit that creates or forks a
 * conversation, including raw `Tx` creation, after fork copies and before host `init`. Table reads throw, since the
 * conversation write came first; a fork (`conversation.parent`) already holds its copied documents. A throw fails the
 * creating commit.
 */
export type ConversationSetup = (
	tx: Tx,
	conversation: ConversationRecord,
	registry: RegistrySnapshot,
) => void | Promise<void>;

/**
 * Runs inside the creating commit, after the conversation and its configuration exist. The conversation creation is
 * already a table write, so table reads here throw `ReadAfterWrite`; document access remains available.
 */
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	readonly init?: ConversationInit;
};

/** Curated pi-ai request options; absent fields use pi-ai defaults. */
export type ConversationStreamOptions = {
	transport?: Transport;
	timeoutMs?: number;
	/** Provider/SDK retries inside one request attempt. */
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: JsonObject;
	cacheRetention?: CacheRetention;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};

/** Durable generation attempt retries; the JSON shape of pi-ai `RetryPolicy`. */
export type ConversationRetryPolicy = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
};

/** Automatic compaction thresholds (spec §8.7); manual compaction ignores `enabled`. */
export type CompactionPolicy = {
	/** Threshold and overflow compaction. */
	enabled: boolean;
	/** Room kept free for the answer: generation blocks to compact above `contextWindow - reserveTokens`. */
	reserveTokens: number;
	/** Approximate size of the recent context a summary keeps verbatim. */
	keepRecentTokens: number;
	/** Background compaction starts `backgroundTokens` below the blocking threshold; `0` disables it. */
	backgroundTokens: number;
};

/** Why a compaction runs: `compact()`, a threshold in generation preparation, or a context overflow. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * `entryId` of a blocking compaction's summary, or the `submissionId` of a conversation-owned compaction's summary
 * write; both absent when nothing was compacted.
 */
export type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId };

export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
	/** pi-ai model access used by generation. */
	readonly models: Models;
	readonly registry: RegistryReader<Tool>;
	/** Default execution environment offered to tools as `api.env`. */
	readonly env?: ExecutionEnv;
	readonly now?: () => number;
	/** Receives extension failures that do not fail the calling operation. Must not throw. */
	readonly onReport?: (error: unknown) => void;
};

/** Live task and what the scheduler would do with it under the current registry. */
export type TaskInspection = {
	readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
	readonly state: /** An invocation is active. */
		| { readonly kind: "running" }
		/** The next scheduling pass reserves it; `migrates` when its definition is newer and has `migrate`. */
		| { readonly kind: "ready"; readonly migrates: boolean }
		/**
		 * Waits for these live tasks: the live part of its `on`, or, when abort-marked, its live ordinary owned work, which
		 * must end before its abort handler starts.
		 */
		| { readonly kind: "waiting"; readonly on: readonly TaskId[] }
		/** Outcome held until its ordinary owned work drains. */
		| { readonly kind: "completing" }
		/** No registered definition can take it; aborting it settles it as `orphaned`. */
		| {
				readonly kind: "blocked";
				readonly reason: "missing_task" | "task_too_old" | "migration_failed";
				readonly error?: unknown;
		  };
};

/** Point-in-time view of live work: unfinished tasks and submissions, read on the Session line. */
export type HarnessInspection = {
	readonly scheduling: "paused" | "running" | "closing";
	readonly tasks: readonly TaskInspection[];
	/** Queued and placed submissions, in ID order. */
	readonly submissions: readonly SubmissionRecord[];
	/** Wrapper failures of the current registry snapshot. */
	readonly registry: readonly RegistryFailure[];
};

/** Raw active transcript and derived model context. */
export type ContextView = {
	/** Newest applicable head marker, if any. */
	readonly head: EntryRecord | undefined;
	/** Raw active entries: the head marker followed by non-head entries from its head through the tail. */
	readonly entries: readonly EntryRecord[];
	/** Per entry of `entries`, its model messages after edits and excluded stop reasons, before tool result ordering. */
	readonly contributions: readonly (readonly Message[])[];
	/** Model context for the next provider request. */
	readonly messages: readonly Message[];
};

/** Stateless handle for one conversation, bound to the Harness that returned it. Compare handles by `id`. */
export interface Conversation {
	readonly id: ConversationId;

	getModel(context: Context): Promise<ModelRef | undefined>;
	setModel(model: ModelRef | undefined, context: Context): Promise<void>;
	getThinkingLevel(context: Context): Promise<ModelThinkingLevel>;
	setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void>;
	getActiveTools(context: Context): Promise<readonly string[]>;
	setActiveTools(names: readonly string[], context: Context): Promise<void>;
	/** `{}` when unset. */
	getStreamOptions(context: Context): Promise<ConversationStreamOptions>;
	setStreamOptions(options: ConversationStreamOptions, context: Context): Promise<void>;
	/** The default policy when unset. */
	getRetryPolicy(context: Context): Promise<ConversationRetryPolicy>;
	/** `undefined` removes the configured policy. */
	setRetryPolicy(policy: ConversationRetryPolicy | undefined, context: Context): Promise<void>;
	/** `parallel` when unset. */
	getToolExecution(context: Context): Promise<ToolExecutionMode>;
	/** `undefined` removes the configured mode. */
	setToolExecution(mode: ToolExecutionMode | undefined, context: Context): Promise<void>;
	/** `one-at-a-time` when unset. */
	getSteeringMode(context: Context): Promise<QueueMode>;
	/** `undefined` removes the configured mode. */
	setSteeringMode(mode: QueueMode | undefined, context: Context): Promise<void>;
	/** `one-at-a-time` when unset. */
	getFollowUpMode(context: Context): Promise<QueueMode>;
	/** `undefined` removes the configured mode. */
	setFollowUpMode(mode: QueueMode | undefined, context: Context): Promise<void>;
	/** `DEFAULT_COMPACTION_POLICY` when unset. */
	getCompaction(context: Context): Promise<CompactionPolicy>;
	/** `undefined` removes the configured policy. */
	setCompaction(policy: CompactionPolicy | undefined, context: Context): Promise<void>;

	/**
	 * Durably admit user input or a passive entry write. A busy conversation, or one with queued items, queues it in
	 * `pi.inbox`; `whenBusy: "reject"` rejects with `ConversationBusy` instead and writes nothing.
	 */
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	/**
	 * Admit a write of a `pi.reset` entry that starts a new context, carrying `handoff` as a user message when given.
	 * Resolves after admission; while busy, it is placed at the next boundary.
	 */
	reset(handoff: string | undefined, context: Context): Promise<void>;
	/**
	 * Admit a manual compaction task and return its ID. It summarizes while the conversation keeps working and places its
	 * summary through a write submission: at once when idle, otherwise at the next boundary (spec §8.7).
	 */
	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;

	/** Session commit whose `tx.createTask()` defaults to this conversation. */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	context(context: Context): Promise<ContextView>;
	/** Newest-first fork-aware history of this conversation. */
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	/**
	 * Withdraw queued inputs (queued writes stay), mark every live non-background task of the ordinary ownership scope,
	 * signal them, and resolve once the scope is idle. Background subtrees survive unless `background` is set.
	 */
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/**
	 * Resolve when the ordinary ownership scope has no live non-background task: this conversation and the conversations
	 * owned, transitively, by its non-background tasks.
	 */
	waitForIdle(context: Context): Promise<void>;
	/** The structural view (spec §9.3) as a disposable read-only Chord state. */
	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
	/** The structural view as a serialized exact-frame watch with bounded pending frames. */
	watch(context: Context): Promise<WatchHandle<ConversationView>>;
}

// TODO: decide how Harness exposes subscribeCommits() and subscribeClose(). Their listeners run on the Session line
// and must not throw or call Session APIs, and Harness close will also join task invocations.
/** Durable agent harness over one Session. */
export interface Harness extends Session {
	/**
	 * Enable task scheduling. Idempotent; throws after close. Calls that wait for progress (`Conversation.submit()`,
	 * `Submission.wait()`, `waitForTask()`, `waitForIdle()`) enable it too.
	 */
	resume(): void;

	/** Return the reserved root conversation, creating it with `init` in one commit when absent. */
	root(context: Context, options?: { readonly init?: ConversationInit }): Promise<Conversation>;
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	/** Live tasks, unsettled submissions, and registry failures. Writes nothing and runs no task code. */
	inspect(context: Context): Promise<HarnessInspection>;
	/** Reacquire a submission, for example after reopen. */
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
	/** `not_found` for an unknown submission or one of another conversation than `conversationId`. */
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
	/**
	 * Commit the abort mark, signal and join an active run invocation, and schedule the abort invocation. A task whose
	 * definition cannot take it settles as `orphaned` instead.
	 */
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
	/** Resolve with the terminal receipt; cancelling `context` cancels only this wait. */
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** Resolve when the ordinary ownership scope of every ownerless conversation has no live non-background task. */
	waitForIdle(context: Context): Promise<void>;
	/** Session total: every conversation's `pi.usage` summed. */
	usage(context: Context): Promise<UsageState>;
}

/** What a hook may use: committed reads and the asking task's memos, which hooks and the task share. */
export interface HookApi extends DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}

export type HookResult<T> = T | undefined | Promise<T | undefined>;

/** Hooks of the built-in generation task. */
export interface GenerationHooks {
	/** Before every request attempt, including recovery; the result is used for that request only. */
	beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: HookApi,
		context: Context,
	): HookResult<{ readonly messages: readonly Message[] }>;
	/** Every terminal provider message, before classification. */
	afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
	/** A final answer; the first `continue` appends a user message and continues the run. */
	onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
	/** After every tool of the round is terminal; `results` are the round's result entries in call order. */
	afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
}

/** Hooks of the built-in tool task. */
export interface ToolHooks {
	/** Before intent; the first `block` wins, otherwise `arguments` replace the call's arguments. A throw blocks. */
	beforeTool(
		call: ToolCall,
		api: HookApi,
		context: Context,
	): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
	/** After execution, before the result entry; replaces the result. */
	afterTool(
		call: ToolCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): HookResult<ToolExecutionResult>;
}

/** Hooks of the built-in compaction task. */
export interface CompactionHooks {
	/**
	 * After range selection, before summarizing; the first decision wins. `entries` are the active entries the summary
	 * replaces, the head marker first, and `messages` their model context, the summarizer's source; `firstKept` is the
	 * first entry kept verbatim.
	 */
	beforeCompact(
		compaction: {
			readonly reason: CompactionReason;
			readonly entries: readonly EntryRecord[];
			readonly messages: readonly Message[];
			readonly firstKept: EntryId;
			readonly instructions?: string;
		},
		api: HookApi,
		context: Context,
	): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}
