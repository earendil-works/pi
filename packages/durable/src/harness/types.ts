import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import type {
	AssistantMessage,
	CacheRetention,
	Message,
	Models,
	ModelThinkingLevel,
	Static,
	ThinkingBudgets,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	TSchema,
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
import type { TaskGraph, TaskGraphWatch } from "./task-graph.ts";
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

export type ToolExecutionResult<TDetails extends JsonValue = JsonValue> = {
	/** Omitted: the retained `output()` text becomes the content. */
	readonly content?: ToolResultMessage["content"];
	readonly isError?: boolean;
	/** Omitted: the last `details()` value becomes the details. */
	readonly details?: TDetails;
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
 * Operations available to one tool invocation. A plain object, so a wrapper can spread it. Every operation rejects after
 * the invocation ends.
 */
export interface ToolExecutionApi<TDetails extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly callId: string;
	/** The tool task's phase snapshot. */
	readonly registry: RegistrySnapshot;
	/** The calling conversation's agent, as the tool task's phase resolved it. */
	agent(context: Context): Promise<Agent>;
	/** Built by `HarnessOptions.env` for this call; `undefined` without an environment. */
	readonly env: ExecutionEnv | undefined;
	/** Append running output; it becomes the result content when the result omits `content`. */
	output(chunk: string | Uint8Array): void;
	/** Record a model-visible remark about this call. */
	diagnostic(diagnostic: ToolDiagnostic): void;
	/** Replace running details; the last value becomes the result details when the result omits `details`. */
	details(value: TDetails, context: Context): Promise<void>;
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

/**
 * Executable tool registered in a registry. Only pi-ai `Tool` fields enter the transcript. `args` are typed by
 * `parameters`, which the Harness validates them against before `execute()`; `defineTool()` infers both generics.
 */
export type ToolRegistration<
	TParameters extends TSchema = TSchema,
	TDetails extends JsonValue = JsonValue,
> = Tool<TParameters> & {
	/** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */
	readonly replay?: "safe" | "unsafe";
	/** Default: the settings' `toolExecution`. One sequential call makes its whole round sequential. */
	readonly executionMode?: ToolExecutionMode;
	/**
	 * Repair arguments models commonly get wrong before validation, such as a JSON string where an array belongs. Must be
	 * pure and must not mutate `args`: it runs again when a call is retried before its intent is recorded. Its result is
	 * still validated against `parameters`.
	 */
	prepareArguments?(args: unknown): Static<TParameters>;
	readonly outputLimits?: {
		readonly maxBytes?: number;
		readonly maxLines?: number;
		readonly retain?: "head" | "tail";
	};
	execute(
		args: Static<TParameters>,
		api: ToolExecutionApi<TDetails>,
		context: Context,
	): Promise<ToolExecutionResult<TDetails>>;
};

/** Input to system prompt section rendering for one request preparation. */
export type PromptInput<Tool extends ToolRegistration = ToolRegistration> = {
	readonly conversationId: ConversationId;
	/** The request's resolution; `agent.tools` are the tools offered in this request. */
	readonly agent: Agent<Tool>;
	/** Built by `HarnessOptions.env` for this preparation; `undefined` without an environment. */
	readonly env: ExecutionEnv | undefined;
	/** Sections already in effect after replaying the active transcript. */
	readonly shown: Readonly<Record<string, string>>;
	/** Committed document reads. */
	readonly read: DocumentReader;
};

/** One system prompt section; the agent's sections render in order before each request. */
export type PromptSection<Tool extends ToolRegistration = ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
	/** Default true: wrap the text as `<key>\n...\n</key>`. */
	readonly tag?: boolean;
};

/** Built by `hook()`; matches tasks by name. */
export type HookRegistration = { readonly task: string; readonly handlers: object };

/** Built by `wrapTool()` and `wrapSection()`; targets a tool name or a section key. Wrappers are pure. */
export type Wrap<Tool extends ToolRegistration = ToolRegistration> =
	| { readonly tool: string; wrap(tool: Tool): Tool }
	| { readonly section: string; wrap(section: PromptSection<Tool>): PromptSection<Tool> };

/** Named bundle of code; installed in a registry and selected by conversations by name. */
export interface Extension<Tool extends ToolRegistration = ToolRegistration> {
	readonly name: string;
	readonly tools?: readonly Tool[];
	readonly sections?: readonly PromptSection<Tool>[];
	readonly hooks?: readonly HookRegistration[];
	/** Apply where this extension is selected, in order. */
	readonly wraps?: readonly Wrap<Tool>[];
	/** Resolved by name for every task, whichever conversations select this extension. */
	readonly tasks?: readonly AnyTask[];
}

/** Immutable view of one published registry state. */
export interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
	installed(): readonly Extension<Tool>[];
	extension(name: string): Extension<Tool> | undefined;
	/** Every installed tool with its extension, in install order. Names may repeat across extensions. */
	tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[];
	sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[];
	/** Built-in and installed task definitions. */
	tasks(): readonly AnyTask[];
	task(name: string): AnyTask | undefined;
}

/** Read side of a registry consumed by a Harness. */
export interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
	/** Immutable view of the whole current registry. */
	snapshot(): RegistrySnapshot<Tool>;
	/** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
	subscribe(listener: () => void): () => void;
}

/** Application-owned registry of extensions. */
export interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
	/** Install `extension`, or replace the installed extension with its name in place. Publishes at once. */
	install(extension: Extension<Tool>): void;
	/** Remove the installed extension with `extension.name`, whichever object it is. A later install appends. */
	uninstall(extension: Extension): void;
}

/** Stored choices of one conversation; names, not objects. Unset fields follow the host. */
export type AgentState = {
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
	/** An array selects exactly these extensions, in order. An object edits the host default selection. */
	extensions?: string[] | { add?: string[]; remove?: string[] };
	/** Filters the selected extensions' tools. An array offers exactly these, in order. */
	tools?: string[] | { remove: string[] };
	/** Rendered after every extension section, as the section `instructions`. */
	instructions?: string;
	/** Directory within the environment's file system, passed to `HarnessOptions.env`. */
	cwd?: string;
};

/** A change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
export type AgentChange = {
	readonly model?: ModelRef | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
	readonly extensions?:
		| readonly Extension[]
		| { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
		| null;
	readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
	readonly instructions?: string | null;
	readonly cwd?: string | null;
};

/** A conversation's agent resolved against a registry snapshot and the settings. */
export type Agent<Tool extends ToolRegistration = ToolRegistration> = {
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly extensions: readonly Extension<Tool>[];
	/** The tools a request offers, in order. */
	readonly tools: readonly Tool[];
	/** Extension sections, then `instructions` when set. */
	readonly sections: readonly PromptSection<Tool>[];
	readonly instructions?: string;
	readonly cwd?: string;
};

/**
 * Runs inside the creating commit, after the creation hook and the `agent` change. The conversation creation is already
 * a table write, so table reads here throw `ReadAfterWrite`; document access remains available.
 */
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	/** Applied in the creating commit after the creation hook's copy, before `init`. */
	readonly agent?: AgentChange;
	readonly init?: ConversationInit;
};

/** Curated pi-ai request options; absent fields use pi-ai defaults. */
export type ConversationStreamOptions = {
	transport?: Transport;
	timeoutMs?: number;
	/** WebSocket connection/open handshake timeout; stream idleness uses `timeoutMs`. */
	websocketConnectTimeoutMs?: number;
	/** Provider session identifier for caching and request routing. */
	sessionId?: string;
	/** Custom token budgets for thinking levels on token-based providers. */
	thinkingBudgets?: ThinkingBudgets;
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

/** Harness-wide run policy. Read at every resolution and never copied; getters are fine. Synchronous: some readers run on the Session line. */
export type HarnessSettings = {
	/** Default extension selection; absent: every installed extension, in install order. */
	readonly extensions?: readonly Extension[];
	readonly stream?: ConversationStreamOptions;
	readonly retry?: Partial<ConversationRetryPolicy>;
	readonly compaction?: Partial<CompactionPolicy>;
	readonly toolExecution?: ToolExecutionMode;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
};

/** Resolved settings: every field over its built-in default, object fields merged. */
export type Settings = {
	/** Absent: every installed extension, in install order. */
	readonly extensions?: readonly Extension[];
	readonly stream: ConversationStreamOptions;
	readonly retry: ConversationRetryPolicy;
	readonly compaction: CompactionPolicy;
	readonly toolExecution: ToolExecutionMode;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
};

/** What `HarnessOptions.env` builds an environment for. */
export type EnvTarget = {
	readonly conversationId: ConversationId;
	/** The conversation's agent `cwd`. */
	readonly cwd?: string;
	readonly read: DocumentReader;
};

export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
	/** pi-ai model access used by generation. */
	readonly models: Models;
	readonly registry: RegistryReader<Tool>;
	readonly settings?: HarnessSettings;
	/** Builds a conversation's environment at each use. Never called on the Session line; may be async. */
	readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	/**
	 * Runs in every commit that creates or forks a conversation, raw `tx.createConversation()` included, after the
	 * built-in `pi.*` documents and before the conveniences apply `agent` and run `init`. A fork already has its copies.
	 * Table reads throw `ReadAfterWrite`, as in `init`; a throw fails the creating commit.
	 */
	readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
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

	/** Resolved with the current registry snapshot and settings. */
	agent(context: Context): Promise<Agent>;
	/** `configure()` in its own commit. */
	configure(change: AgentChange, context: Context): Promise<void>;

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
	watch(context: Context): Promise<ConversationWatch>;
}

export type ConversationWatch = WatchHandle<ConversationView>;

/** Durable agent harness over one Session. */
export interface Harness extends Session {
	/**
	 * Enable task scheduling. Idempotent; throws after close. Calls that ask for progress enable it too:
	 * `Conversation.submit()`, `Conversation.compact()`, `Conversation.abort()`, `Submission.wait()`, `waitForTask()`,
	 * `Harness.waitForIdle()`, and `Conversation.waitForIdle()`. Read-only viewers never do.
	 */
	resume(): void;

	/** Return the reserved root conversation, creating it with `agent` and `init` in one commit when absent. */
	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation>;
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	/** Live tasks and unsettled submissions. Writes nothing and runs no task code. */
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
	/** Every live task with its owner edge, status, and owned conversations (spec §9.5), as a disposable Chord state. */
	taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
	/** The task graph as a serialized exact-frame watch with bounded pending frames. */
	watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
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
