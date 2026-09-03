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
import { Agent } from "../agent.ts";
import type { ToolPolicy } from "../policy.ts";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import { type CompactionSettings, compact as compactSession, prepareCompaction } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import { Result, type Result as ResultValue, TaggedError } from "./result.ts";
import { buildSessionContext } from "./session/context.ts";
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
	toolPolicy?: ToolPolicy;
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

type ActiveOperation = { runId: string; agent: Agent };
class Registry implements Hooks, Events {
	private readonly hooks = new Map<HookName, Set<(event: unknown) => unknown | Promise<unknown>>>();
	private readonly listeners = new Map<string, Set<(event: unknown) => void | Promise<void>>>();
	private readonly watchers = new Set<(event: unknown) => void>();
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>): () => void {
		const handlers = this.hooks.get(name) ?? new Set();
		handlers.add(handler);
		this.hooks.set(name, handlers);
		return () => handlers.delete(handler);
	}
	onEvent(type: string, listener: (event: unknown) => void | Promise<void>): () => void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
		return () => listeners.delete(listener);
	}
	emit(type: string, event: unknown): void {
		for (const listener of [...(this.listeners.get(type) ?? []), ...(this.listeners.get("*") ?? [])])
			void listener(event);
		for (const watcher of this.watchers) watcher(event);
	}
	watch(listener: (event: unknown) => void): () => void {
		this.watchers.add(listener);
		return () => this.watchers.delete(listener);
	}
	async runHooks(name: HookName, event: unknown): Promise<void> {
		for (const handler of this.hooks.get(name) ?? []) await handler(event);
	}
}

export class AgentHarness implements AgentLane {
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly options: AgentHarnessOptions;
	private readonly registry = new Registry();
	private readonly laneName: string;
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
	private readonly steeringQueue: QueuedItem[] = [];
	private readonly followUpQueue: QueuedItem[] = [];
	private readonly nextRunQueue: QueuedItem[] = [];
	private suspendedOperations: SuspendedOperation[];
	private activeOperation?: ActiveOperation;
	private activeKind?: "run" | "compaction" | "navigation";
	private idleCallbacks: Array<() => void | Promise<void>> = [];
	private closed = false;

	private constructor(
		options: AgentHarnessOptions,
		laneName = "main",
		suspendedOperations: SuspendedOperation[] = [],
	) {
		this.options = options;
		this.durableSession = options.session;
		this.laneName = laneName;
		this.session = laneName === "main" ? options.session : options.session.view(laneName);
		this.hooks = this.registry;
		this.events = { on: (type, listener) => this.registry.onEvent(type, listener) };
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
		this.compactionSettings = options.compaction ?? { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.suspendedOperations = suspendedOperations;
	}
	get name(): string {
		return this.laneName;
	}
	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const suspended = (await options.session.findOpenOperations("main", { limit: 2 })).map((record) =>
			AgentHarness.toSuspended(record),
		);
		return { harness: new AgentHarness(options, "main", suspended), suspended };
	}
	private static toSuspended(record: OperationStartedRecord): SuspendedOperation {
		return {
			lane: record.lane,
			kind: record.intent.kind,
			id: record.id,
			startedAt: record.timestamp,
			reason: "crash",
			prompt: record.intent.kind === "run" ? record.intent.originalPrompt : undefined,
			missing: { tools: [], models: [] },
		};
	}
	private async entries(): Promise<Entry[]> {
		return this.session.findEntriesOnBranch({ order: "oldestFirst" });
	}
	private async contextMessages(): Promise<AgentMessage[]> {
		return buildSessionContext(await this.entries()).messages;
	}
	private normalizeInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
		if (Array.isArray(input)) return input;
		if (typeof input !== "string") return [input];
		return [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }];
	}
	private async ready(): Promise<RunRejected | undefined> {
		if (this.closed) return new Closed({ message: "AgentHarness is closed" });
		if (this.activeOperation || this.activeKind)
			return new LaneBusy({
				lane: this.name,
				operationId: this.activeOperation?.runId ?? "active",
				operationKind: this.activeKind ?? "run",
				message: "Lane already has an active operation",
			});
		const suspended = this.suspendedOperations[0];
		return suspended
			? new LaneBusy({
					lane: this.name,
					operationId: suspended.id,
					operationKind: suspended.kind,
					message: "Lane has a suspended operation; call resume() first",
				})
			: undefined;
	}
	private activeTools(): HarnessTool[] {
		const active = new Set(this.activeToolNames);
		return this.tools.filter((tool) => active.has(tool.name));
	}

	private async createAgent(
		messages: AgentMessage[],
	): Promise<{ agent: Agent; getLastEntryId: () => string | undefined }> {
		const systemPrompt =
			typeof this.options.systemPrompt === "function"
				? await this.options.systemPrompt()
				: (this.options.systemPrompt ?? "");
		let lastEntryId: string | undefined;
		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				tools: this.activeTools(),
				messages,
			},
			convertToLlm: this.options.toProviderMessages ?? convertToLlm,
			streamFn: this.options.models.streamSimple.bind(this.options.models),
			streamOptions: this.streamOptions,
			toolPolicy: this.options.toolPolicy,
			beforeToolCall: async (context) => {
				await this.registry.runHooks("before_tool", context);
				return undefined;
			},
			afterToolCall: async (context) => {
				await this.registry.runHooks("after_tool", context);
				return undefined;
			},
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			toolExecution: this.options.toolExecution,
		});
		agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "message_end") {
				const entry = await this.durableSession.appendEntry(
					{ type: "message", id: this.durableSession.idGenerator.next(), message: event.message },
					this.name,
				);
				lastEntryId = entry.id;
			}
		});
		return { agent, getLastEntryId: () => lastEntryId };
	}

	private async executeRun(runId: string, messages: AgentMessage[], resumed = false): Promise<RunResult> {
		const runtime = await this.createAgent(messages);
		this.activeOperation = { runId, agent: runtime.agent };
		this.activeKind = "run";
		this.registry.emit("run_start", { type: "run_start", lane: this.name, runId });
		try {
			await this.registry.runHooks(resumed ? "before_resume" : "before_run", { lane: this.name, runId, messages });
			await runtime.agent.continue();
			const finalMessage = [...runtime.agent.state.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const finalEntryId = runtime.getLastEntryId();
			const leafId = (await this.getLeafId()) ?? "";
			if (!finalMessage || !finalEntryId) {
				const value = {
					runId,
					kind: "failed" as const,
					leafId,
					error: { code: "missing_result", message: "Agent produced no assistant result" },
				};
				await this.finish(runId, "failed", value);
				return Result.ok(value);
			}
			const kind =
				finalMessage.stopReason === "aborted"
					? "aborted"
					: finalMessage.stopReason === "error"
						? "failed"
						: "completed";
			const value: RunOutcome =
				kind === "failed"
					? {
							kind,
							leafId,
							error: { code: "agent_error", message: finalMessage.errorMessage ?? "Agent run failed" },
							finalEntryId,
							finalMessage,
						}
					: { kind, leafId, finalEntryId, finalMessage };
			await this.finish(runId, kind, value);
			return Result.ok({ runId, ...value });
		} catch (error) {
			const leafId = (await this.getLeafId()) ?? "";
			const operationError = {
				code: "runtime_error",
				message: error instanceof Error ? error.message : String(error),
			};
			await this.finish(runId, "failed", { kind: "failed", leafId, error: operationError });
			return Result.ok({ runId, kind: "failed", leafId, error: operationError });
		} finally {
			this.activeOperation = undefined;
			this.activeKind = undefined;
			this.steeringQueue.length = 0;
			this.followUpQueue.length = 0;
			for (const callback of this.idleCallbacks.splice(0)) await callback();
		}
	}
	private async finish(runId: string, outcome: "completed" | "aborted" | "failed", value: RunOutcome): Promise<void> {
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			runId,
			outcome,
		});
		await this.registry.runHooks("before_run_end", value);
		this.registry.emit("run_end", { type: "run_end", lane: this.name, runId, outcome });
	}

	async getLeafId(): Promise<string | null> {
		return this.session.getLeafId();
	}
	async prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	async prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		const rejected = await this.ready();
		if (rejected) return Result.err(rejected);
		const messages = this.normalizeInput(input, images);
		if (messages.length === 0)
			return Result.err(
				new InvalidMessage({
					lane: this.name,
					reason: "empty",
					message: "Prompt must contain at least one message",
				}),
			);
		const initialMessages = messages.map((message) => ({
			type: "message" as const,
			id: this.durableSession.idGenerator.next(),
			message,
		}));
		const runId = this.durableSession.idGenerator.next();
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId: await this.getLeafId(),
			intent: { kind: "run", originalPrompt: messages, initialMessages },
		});
		for (const entry of initialMessages) await this.durableSession.appendEntry(entry, this.name);
		return this.executeRun(runId, await this.contextMessages());
	}
	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		const skill = this.resources.skills?.find((candidate) => candidate.name === name);
		if (!skill) return Result.err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
		return this.prompt(
			`<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>${additionalInstructions ? `\n\n${additionalInstructions}` : ""}`,
		);
	}
	async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (!template) return Result.err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
		const content = template.content
			.replace(/\$ARGUMENTS|\$@/g, args.join(" "))
			.replace(/\$(\d+)/g, (_, index: string) => args[Number(index) - 1] ?? "");
		return this.prompt(content);
	}
	async compact(options: { customInstructions?: string } = {}): Promise<CompactionResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.activeOperation || this.activeKind)
			return Result.err(
				new LaneBusy({
					lane: this.name,
					operationId: this.activeOperation?.runId ?? "active",
					operationKind: this.activeKind ?? "run",
					message: "Lane already has an active operation",
				}),
			);
		const preparation = prepareCompaction(await this.entries(), this.compactionSettings);
		if (!preparation.ok)
			return Result.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "failed",
				leafId: (await this.getLeafId()) ?? "",
				error: { code: preparation.error.code, message: preparation.error.message },
			});
		if (!preparation.value)
			return Result.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "declined",
				leafId: (await this.getLeafId()) ?? "",
			});
		const runId = this.durableSession.idGenerator.next();
		const resultEntryId = this.durableSession.idGenerator.next();
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId: await this.getLeafId(),
			intent: {
				kind: "compaction",
				...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
				resultEntryId,
			},
		});
		this.activeKind = "compaction";
		try {
			const result = await compactSession(
				preparation.value,
				this.options.models,
				this.model,
				options.customInstructions,
				undefined,
				this.thinkingLevel,
				this.retryPolicy,
			);
			if (!result.ok) {
				const outcome: CompactionOutcome =
					result.error.code === "aborted"
						? { kind: "aborted", leafId: (await this.getLeafId()) ?? "" }
						: {
								kind: "failed",
								leafId: (await this.getLeafId()) ?? "",
								error: { code: result.error.code, message: result.error.message },
							};
				await this.durableSession.appendRecord({
					type: "operation_finished",
					id: this.durableSession.idGenerator.next(),
					lane: this.name,
					runId,
					outcome: outcome.kind,
				});
				return Result.ok({ runId, ...outcome });
			}
			const entry = await this.durableSession.appendEntry<CompactionEntry>(
				{
					type: "compaction",
					id: resultEntryId,
					summary: result.value.summary,
					retainedTail: result.value.retainedTail,
					tokensBefore: result.value.tokensBefore,
					details: result.value.details,
					usage: result.value.usage,
				},
				this.name,
			);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "completed",
			});
			return Result.ok({ runId, kind: "completed", leafId: (await this.getLeafId()) ?? "", entry });
		} finally {
			this.activeKind = undefined;
		}
	}
	async navigateTree(targetId: string | null, options: NavigateOptions = {}): Promise<NavigationResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.activeOperation || this.activeKind)
			return Result.err(
				new LaneBusy({
					lane: this.name,
					operationId: this.activeOperation?.runId ?? "active",
					operationKind: this.activeKind ?? "run",
					message: "Lane already has an active operation",
				}),
			);
		if (targetId !== null && !(await this.durableSession.getEntry(targetId)))
			return Result.err(new UnknownTarget({ targetId, message: `Unknown navigation target: ${targetId}` }));
		const runId = this.durableSession.idGenerator.next();
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId: await this.getLeafId(),
			intent: {
				kind: "navigation",
				targetId,
				summarize: options.summarize === true,
				...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
				...(options.label ? { label: options.label } : {}),
			},
		});
		this.activeKind = "navigation";
		try {
			await this.durableSession.moveLane(this.name, targetId);
			if (targetId && options.label) await this.durableSession.setLabel(targetId, options.label);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "completed",
			});
			return Result.ok({ runId, kind: "completed", newLeafId: targetId });
		} finally {
			this.activeKind = undefined;
		}
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.activeOperation || this.activeKind)
			return Result.err(
				new LaneBusy({
					lane: this.name,
					operationId: this.activeOperation?.runId ?? "active",
					operationKind: this.activeKind ?? "run",
					message: "Lane is busy",
				}),
			);
		const operation = this.suspendedOperations.shift();
		if (!operation) return Result.err(new NothingToResume({ lane: this.name, message: "No suspended operation" }));
		if (operation.kind !== "run")
			return Result.ok({
				operation: operation.kind,
				runId: operation.id,
				kind: "declined",
				leafId: await this.getLeafId(),
			} as ResumeOutcome);
		const result = await this.executeRun(operation.id, await this.contextMessages(), true);
		return result.ok
			? Result.ok({ operation: "run", ...result.value })
			: Result.err(new NothingToResume({ lane: this.name, message: "Unable to resume operation" }));
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!this.activeOperation)
			return Result.err(new NoActiveOperation({ lane: this.name, message: "No active operation" }));
		this.activeOperation.agent.abort();
		return Result.ok({ runId: this.activeOperation.runId, steer: [], followUp: [] });
	}
	async steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async steer(message: AgentMessage): Promise<QueueResult>;
	async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!this.activeOperation) return Result.err(new NoActiveRun({ lane: this.name, message: "No active run" }));
		const message = this.normalizeInput(input, images)[0]!;
		const entryId = this.durableSession.idGenerator.next();
		this.steeringQueue.push({ entryId, message });
		this.activeOperation.agent.steer(message);
		return Result.ok({ entryId });
	}
	async followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async followUp(message: AgentMessage): Promise<QueueResult>;
	async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!this.activeOperation) return Result.err(new NoActiveRun({ lane: this.name, message: "No active run" }));
		const message = this.normalizeInput(input, images)[0]!;
		const entryId = this.durableSession.idGenerator.next();
		this.followUpQueue.push({ entryId, message });
		this.activeOperation.agent.followUp(message);
		return Result.ok({ entryId });
	}
	async nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(message: AgentMessage): Promise<QueueResult>;
	async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const message = this.normalizeInput(input, images)[0]!;
		const entryId = this.durableSession.idGenerator.next();
		this.nextRunQueue.push({ entryId, message });
		await this.durableSession.appendRecord({
			type: "queue_enqueued",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			queue: "nextRun",
			target: { type: "message", id: entryId, message },
		});
		return Result.ok({ entryId });
	}
	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		for (const queue of [this.steeringQueue, this.followUpQueue, this.nextRunQueue]) {
			const index = queue.findIndex((item) => item.entryId === entryId);
			if (index >= 0) {
				queue.splice(index, 1);
				return Result.ok({ outcome: "cancelled" });
			}
		}
		return Result.err(new UnknownQueueItem({ lane: this.name, entryId, message: `Unknown queue item: ${entryId}` }));
	}
	async recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const record = {
			type: "usage",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			usage,
			cause: "adjustment",
			...(this.activeOperation ? { runId: this.activeOperation.runId } : {}),
			...(options?.entryId ? { entryId: options.entryId } : {}),
			...(options?.details !== undefined ? { details: options.details } : {}),
		} as const;
		await this.durableSession.appendRecord(record);
		return Result.ok(undefined);
	}
	async waitForIdle(): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.activeOperation?.agent.waitForIdle();
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		if (this.activeOperation) this.idleCallbacks.push(callback);
		else await callback();
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.nextRunQueue[0]
			? { kind: "commit_follow_up" }
			: this.activeOperation
				? { kind: "stream_assistant", step: "assistant", attempt: 1 }
				: undefined;
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		const item = this.nextRunQueue.shift();
		if (!item) return undefined;
		await this.prompt(item.message);
		return { kind: "commit_follow_up" };
	}
	async runToCompletion(): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		while (this.nextRunQueue.length > 0) {
			const result = await this.prompt(this.nextRunQueue.shift()!.message);
			if (!result.ok) throw result.error;
		}
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
	private async snapshot(): Promise<LaneSnapshot> {
		const suspended = this.suspendedOperations[0];
		return {
			lane: this.name,
			transcript: await this.entries(),
			leafId: await this.getLeafId(),
			operation: this.activeOperation
				? { id: this.activeOperation.runId, kind: "run", status: "running" }
				: this.activeKind
					? { id: "active", kind: this.activeKind, status: "running" }
					: suspended
						? { id: suspended.id, kind: suspended.kind, status: "suspended" }
						: null,
			queues: { steer: [...this.steeringQueue], followUp: [...this.followUpQueue], nextRun: [...this.nextRunQueue] },
			pendingWrites: [],
			faulted: false,
		};
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		let unsubscribe = () => {};
		return {
			snapshot: await this.snapshot(),
			start: (listener) => {
				unsubscribe = this.registry.watch(listener);
			},
			unsubscribe: () => unsubscribe(),
		};
	}
	async lane(name: string): Promise<AgentLane | undefined> {
		if (this.closed) throw new HarnessClosed();
		const exists = (await this.durableSession.getLanes()).some((lane) => lane.lane === name);
		return exists ? (name === this.name ? this : new AgentHarness(this.options, name)) : undefined;
	}
	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		try {
			await this.durableSession.createLane(name, at);
			return Result.ok(new AgentHarness(this.options, name));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Result.err(
				message.includes("already")
					? new LaneExists({ lane: name, message })
					: new InvalidLane({ lane: name, reason: message, message: "Unable to create lane" }),
			);
		}
	}
	async lanes(): Promise<LaneInfo[]> {
		return Promise.all(
			(await this.durableSession.getLanes()).map(async (pointer) => {
				const operation = (await this.durableSession.findOpenOperations(pointer.lane, { limit: 1 }))[0];
				return {
					name: pointer.lane,
					leafId: pointer.leafId,
					operation: operation
						? { id: operation.id, kind: operation.intent.kind, status: "suspended" as const }
						: null,
				};
			}),
		);
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
		if (this.activeOperation) this.activeOperation.agent.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
		if (this.activeOperation) this.activeOperation.agent.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const lanes = await this.lanes();
		const suspended = this.suspendedOperations[0];
		const snapshot: SessionSnapshot = {
			lanes: lanes.map((lane) => (lane.name === this.name && suspended ? { ...lane, suspended } : lane)),
			faulted: false,
		};
		let unsubscribe = () => {};
		return {
			snapshot,
			start: (listener) => {
				unsubscribe = this.registry.watch(listener);
			},
			unsubscribe: () => unsubscribe(),
		};
	}
	async close(): Promise<void> {
		this.closed = true;
		this.activeOperation?.agent.abort();
	}
}
