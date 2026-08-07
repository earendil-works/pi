import {
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingBudgets,
	type ToolResultMessage,
	type Transport,
	validateToolArguments,
} from "@mupt-ai/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentProviderRequest,
	AgentState,
	AgentSteppableInput,
	AgentSteppableNextAction,
	AgentSteppableResult,
	AgentSteppableSnapshot,
	AgentSteppableToolExecutionResult,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	SerializedAgentError,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	private steppable: Omit<AgentSteppableSnapshot, "systemPrompt" | "model" | "thinkingLevel" | "messages"> = {
		schemaVersion: 1,
		phase: "waiting_for_user",
		newMessages: [],
		callSeq: 1,
		pendingToolCalls: [],
		completedToolResults: [],
		toolBatchTerminated: false,
	};
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		this._state = createMutableAgentState(runtimeOptions.initialState);
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.shouldStopAfterTurn = runtimeOptions.shouldStopAfterTurn;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	async advance(input: AgentSteppableInput): Promise<AgentSteppableResult> {
		const events: AgentEvent[] = [];
		const emit = async (event: AgentEvent) => {
			events.push(event);
			await this.processEvents(event);
		};

		try {
			if (input.type === "resume") {
				return this.runUntilBoundary(events, emit);
			}

			if (input.type === "user_message") {
				this.assertWaitingForUser();
				this.steppable.newMessages = [input.message];
				this.steppable.currentAssistantMessage = undefined;
				this.steppable.completedToolResults = [];
				this.steppable.toolBatchTerminated = false;
				await emit({ type: "agent_start" });
				await emit({ type: "turn_start" });
				await emit({ type: "message_start", message: input.message });
				await emit({ type: "message_end", message: input.message });
				return this.yieldLlm(events);
			}

			if (input.type === "llm_result" || input.type === "llm_error") {
				this.assertPending(input.callId, "call_llm");
				this.steppable.pendingAction = undefined;
				this.steppable.phase = "waiting_for_user";

				const message =
					input.type === "llm_result" ? input.message : this.createAssistantErrorMessage(input.error.message);
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				this.steppable.currentAssistantMessage = message;
				this.steppable.newMessages.push(message);

				if (message.stopReason === "error" || message.stopReason === "aborted" || input.type === "llm_error") {
					await emit({ type: "turn_end", message, toolResults: [] });
					await emit({ type: "agent_end", messages: this.steppable.newMessages });
					this.steppable.currentAssistantMessage = undefined;
					return this.result(events, { type: "wait_for_user" });
				}

				this.steppable.pendingToolCalls = message.content.filter((content) => content.type === "toolCall");
				this.steppable.completedToolResults = [];
				this.steppable.toolBatchTerminated = false;
				return this.runUntilBoundary(events, emit);
			}

			if (input.type === "tool_result" || input.type === "tool_error") {
				this.assertPending(input.callId, "call_tool");
				const pendingTool = this.steppable.pendingTool;
				const assistantMessage = this.steppable.currentAssistantMessage;
				if (!pendingTool || !assistantMessage) throw new Error("Missing pending tool state");
				this.steppable.pendingAction = undefined;
				this.steppable.pendingTool = undefined;
				const rawResult = input.type === "tool_result" ? input.result : createErrorToolResult(input.error.message);
				const rawIsError = input.type === "tool_result" ? (input.isError ?? false) : true;
				const finalized = await this.finalizeToolResult(assistantMessage, pendingTool, rawResult, rawIsError);
				await emit({
					type: "tool_execution_end",
					toolCallId: pendingTool.toolCallId,
					toolName: pendingTool.toolName,
					result: finalized.result,
					isError: finalized.isError,
				});
				const toolMessage = createToolResultMessage(pendingTool, finalized.result, finalized.isError);
				await emit({ type: "message_start", message: toolMessage });
				await emit({ type: "message_end", message: toolMessage });
				this.steppable.newMessages.push(toolMessage);
				const allPreviousTerminated =
					this.steppable.completedToolResults.length === 0 || this.steppable.toolBatchTerminated;
				this.steppable.completedToolResults.push(toolMessage);
				this.steppable.toolBatchTerminated = allPreviousTerminated && finalized.result.terminate === true;
				return this.runUntilBoundary(events, emit);
			}
		} catch (error) {
			const serialized = serializeError(error);
			this.steppable.phase = "error";
			this.steppable.error = serialized;
			return this.result(events, { type: "error", error: serialized });
		}
		const serialized = { message: `Unsupported steppable input ${(input as { type: string }).type}` };
		this.steppable.phase = "error";
		this.steppable.error = serialized;
		return this.result(events, { type: "error", error: serialized });
	}

	async executeTool(callId: string): Promise<AgentSteppableToolExecutionResult> {
		const action = this.steppable.pendingAction;
		const pendingTool = this.steppable.pendingTool;
		if (!action || action.type !== "call_tool" || action.callId !== callId || !pendingTool) {
			throw new Error(`No pending sandbox tool call for ${callId}`);
		}
		if (action.execution !== "sandbox") {
			throw new Error(`Cannot execute ${action.execution} tool in sandbox`);
		}
		const tool = this._state.tools.find((candidate) => candidate.name === pendingTool.toolName);
		if (!tool) {
			return { result: createErrorToolResult(`Tool ${pendingTool.toolName} not found`), isError: true };
		}
		try {
			const result = await tool.execute(
				pendingTool.toolCallId,
				pendingTool.args as never,
				undefined,
				(partialResult) => {
					void this.processEvents({
						type: "tool_execution_update",
						toolCallId: pendingTool.toolCallId,
						toolName: pendingTool.toolName,
						args: pendingTool.args,
						partialResult,
					});
				},
			);
			return { result, isError: false };
		} catch (error) {
			return {
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		}
	}

	snapshot(): AgentSteppableSnapshot {
		return {
			...this.steppable,
			schemaVersion: 1,
			systemPrompt: this._state.systemPrompt,
			model: this._state.model,
			thinkingLevel: this._state.thinkingLevel,
			messages: this._state.messages.slice(),
			newMessages: this.steppable.newMessages.slice(),
			pendingToolCalls: this.steppable.pendingToolCalls.slice(),
			completedToolResults: this.steppable.completedToolResults.slice(),
		};
	}

	restore(snapshot: AgentSteppableSnapshot): void {
		if (snapshot.schemaVersion !== 1)
			throw new Error(`Unsupported steppable snapshot version ${snapshot.schemaVersion}`);
		this._state.systemPrompt = snapshot.systemPrompt;
		this._state.model = snapshot.model;
		this._state.thinkingLevel = snapshot.thinkingLevel;
		this._state.messages = snapshot.messages;
		this.steppable = {
			schemaVersion: 1,
			phase: snapshot.phase,
			newMessages: snapshot.newMessages.slice(),
			callSeq: snapshot.callSeq,
			pendingAction: snapshot.pendingAction,
			pendingTool: snapshot.pendingTool,
			pendingToolCalls: snapshot.pendingToolCalls.slice(),
			completedToolResults: snapshot.completedToolResults.slice(),
			currentAssistantMessage: snapshot.currentAssistantMessage,
			toolBatchTerminated: snapshot.toolBatchTerminated,
			error: snapshot.error,
		};
	}

	private async runUntilBoundary(
		events: AgentEvent[],
		emit: (event: AgentEvent) => Promise<void>,
	): Promise<AgentSteppableResult> {
		if (this.steppable.pendingAction) return this.result(events, this.steppable.pendingAction);
		if (this.steppable.phase === "waiting_for_user" && !this.steppable.currentAssistantMessage) {
			return this.result(events, { type: "wait_for_user" });
		}
		if (this.steppable.phase === "awaiting_llm") return this.yieldLlm(events);
		if (this.steppable.phase === "awaiting_tool") return this.yieldNextTool(events, emit);
		if (this.steppable.pendingToolCalls.length > 0) return this.yieldNextTool(events, emit);

		const assistantMessage = this.steppable.currentAssistantMessage;
		if (assistantMessage) {
			await emit({ type: "turn_end", message: assistantMessage, toolResults: this.steppable.completedToolResults });
			if (!this.steppable.toolBatchTerminated && this.steppable.completedToolResults.length > 0) {
				await emit({ type: "turn_start" });
				return this.yieldLlm(events);
			}
		}

		this.steppable.phase = "waiting_for_user";
		this.steppable.currentAssistantMessage = undefined;
		await emit({ type: "agent_end", messages: this.steppable.newMessages });
		return this.result(events, { type: "wait_for_user" });
	}

	private async yieldLlm(events: AgentEvent[]): Promise<AgentSteppableResult> {
		const request = await this.createProviderRequest();
		const action: AgentSteppableNextAction = {
			type: "call_llm",
			callId: this.nextCallId("llm"),
			request,
		};
		this.steppable.pendingAction = action;
		this.steppable.phase = "awaiting_llm";
		return this.result(events, action);
	}

	private async yieldNextTool(
		events: AgentEvent[],
		emit: (event: AgentEvent) => Promise<void>,
	): Promise<AgentSteppableResult> {
		const assistantMessage = this.steppable.currentAssistantMessage;
		if (!assistantMessage) throw new Error("Missing assistant message for tool call");

		while (this.steppable.pendingToolCalls.length > 0) {
			const toolCall = this.steppable.pendingToolCalls.shift();
			if (!toolCall) break;
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			const prepared = await this.prepareSteppableToolCall(assistantMessage, toolCall);
			if ("type" in prepared) {
				await emit({
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					result: prepared.result,
					isError: prepared.isError,
				});
				const toolMessage = createToolResultMessage(
					{ toolCallId: toolCall.id, toolName: toolCall.name },
					prepared.result,
					prepared.isError,
				);
				await emit({ type: "message_start", message: toolMessage });
				await emit({ type: "message_end", message: toolMessage });
				this.steppable.newMessages.push(toolMessage);
				const allPreviousTerminated =
					this.steppable.completedToolResults.length === 0 || this.steppable.toolBatchTerminated;
				this.steppable.completedToolResults.push(toolMessage);
				this.steppable.toolBatchTerminated = allPreviousTerminated && prepared.result.terminate === true;
				continue;
			}

			const action: AgentSteppableNextAction = {
				type: "call_tool",
				callId: prepared.callId,
				toolCallId: prepared.toolCallId,
				tool: prepared.toolName,
				execution: prepared.execution,
				input: prepared.args,
			};
			this.steppable.pendingTool = prepared;
			this.steppable.pendingAction = action;
			this.steppable.phase = "awaiting_tool";
			return this.result(events, action);
		}

		this.steppable.phase = "waiting_for_user";
		return this.runUntilBoundary(events, emit);
	}

	private async prepareSteppableToolCall(
		assistantMessage: AssistantMessage,
		toolCall: AgentToolCall,
	): Promise<
		| { type: "immediate"; result: AgentToolResult<unknown>; isError: boolean }
		| NonNullable<AgentSteppableSnapshot["pendingTool"]>
	> {
		const tool = this._state.tools.find((candidate) => candidate.name === toolCall.name);
		if (!tool)
			return { type: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
		try {
			const preparedArguments = tool.prepareArguments
				? tool.prepareArguments(toolCall.arguments)
				: toolCall.arguments;
			const preparedToolCall = { ...toolCall, arguments: preparedArguments as Record<string, unknown> };
			const args = validateToolArguments(tool, preparedToolCall);
			if (this.beforeToolCall) {
				const beforeResult = await this.beforeToolCall({
					assistantMessage,
					toolCall,
					args,
					context: this.createContextSnapshot(),
				});
				if (beforeResult?.block) {
					return {
						type: "immediate",
						result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
						isError: true,
					};
				}
			}
			return {
				callId: this.nextCallId("tool"),
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				rawArguments: toolCall.arguments,
				args,
				execution: tool.execution ?? "sandbox",
			};
		} catch (error) {
			return {
				type: "immediate",
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		}
	}

	private async finalizeToolResult(
		assistantMessage: AssistantMessage,
		pendingTool: NonNullable<AgentSteppableSnapshot["pendingTool"]>,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<{ result: AgentToolResult<unknown>; isError: boolean }> {
		if (!this.afterToolCall) return { result, isError };
		try {
			const toolCall = {
				id: pendingTool.toolCallId,
				name: pendingTool.toolName,
				arguments: pendingTool.rawArguments,
				type: "toolCall",
			} as AgentToolCall;
			const afterResult = await this.afterToolCall({
				assistantMessage,
				toolCall,
				args: pendingTool.args,
				result,
				isError,
				context: this.createContextSnapshot(),
			});
			if (!afterResult) return { result, isError };
			return {
				result: {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				},
				isError: afterResult.isError ?? isError,
			};
		} catch (error) {
			return {
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		}
	}

	private async createProviderRequest(): Promise<AgentProviderRequest> {
		let messages = this._state.messages;
		if (this.transformContext) messages = await this.transformContext(messages);
		const llmMessages = await this.convertToLlm(messages);
		const context: Context = {
			systemPrompt: this._state.systemPrompt,
			messages: llmMessages,
			tools: this._state.tools,
		};
		return {
			model: this._state.model,
			context,
			options: {
				reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
				sessionId: this.sessionId,
				transport: this.transport,
				thinkingBudgets: this.thinkingBudgets,
				maxRetryDelayMs: this.maxRetryDelayMs,
			},
		};
	}

	private result(events: AgentEvent[], nextAction: AgentSteppableNextAction): AgentSteppableResult {
		return { state: this.snapshot(), events, nextAction };
	}

	private assertWaitingForUser(): void {
		if (this.steppable.pendingAction || this.steppable.phase !== "waiting_for_user") {
			throw new Error("Cannot accept user_message while session is not waiting for user");
		}
	}

	private assertPending(callId: string, type: "call_llm" | "call_tool"): void {
		const action = this.steppable.pendingAction;
		if (!action || action.type !== type || action.callId !== callId) {
			throw new Error(`Unexpected ${type} result for ${callId}`);
		}
	}

	private nextCallId(prefix: "llm" | "tool"): string {
		return `${prefix}_${this.steppable.callSeq++}`;
	}

	private createAssistantErrorMessage(message: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		};
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		const shouldStopAfterTurn = this.shouldStopAfterTurn;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: shouldStopAfterTurn
				? async (context) => await shouldStopAfterTurn(context, this.signal)
				: undefined,
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal ?? new AbortController().signal;
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}

function createToolResultMessage(
	pendingTool: Pick<NonNullable<AgentSteppableSnapshot["pendingTool"]>, "toolCallId" | "toolName">,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: pendingTool.toolCallId,
		toolName: pendingTool.toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function serializeError(error: unknown): SerializedAgentError {
	if (error instanceof Error) {
		return { message: error.message, name: error.name, stack: error.stack };
	}
	return { message: String(error) };
}
