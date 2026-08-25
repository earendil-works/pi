/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	SpeculativeToolExecutionConfig,
	SpeculativeToolTelemetry,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type SpeculativeRawOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	executionArgs: unknown;
};

type SpeculativeToolCandidate = {
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	executionArgs: unknown;
	fingerprint: string;
	startedAt: number;
	finishedAt?: number;
	dispatchReachedAt?: number;
	state: "running" | "completed" | "committed" | "discarded";
	controller: AbortController;
	promise: Promise<SpeculativeRawOutcome>;
	reported: boolean;
};

type SpeculativeCandidateRegistry = Map<string, SpeculativeToolCandidate>;

const speculativeCandidateRegistries = new WeakMap<AssistantMessage, SpeculativeCandidateRegistry>();

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not JSON values");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("Circular values are not JSON values");
		ancestors.add(value);
		try {
			return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
		} finally {
			ancestors.delete(value);
		}
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Non-JSON value");
	}
	const objectValue = value as Record<string, unknown>;
	if (ancestors.has(objectValue)) throw new Error("Circular values are not JSON values");
	ancestors.add(objectValue);
	try {
		return `{${Object.keys(objectValue)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key], ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(objectValue);
	}
}

function createExecutionFingerprint(toolCall: AgentToolCall, executionArgs: unknown): string {
	return canonicalJson({ name: toolCall.name, args: executionArgs });
}

function emitSpeculationTelemetry(config: SpeculativeToolExecutionConfig, telemetry: SpeculativeToolTelemetry): void {
	try {
		config.onTelemetry?.(telemetry);
	} catch {
		// Observability must not affect agent execution.
	}
	console.debug("speculative-tool-execution", {
		toolCallId: telemetry.toolCallId,
		toolName: telemetry.toolName,
		outcome: telemetry.outcome,
		reason: telemetry.reason,
		executionDurationMs: telemetry.executionDurationMs,
		overlapMs: telemetry.overlapMs,
	});
}

function reportCandidate(
	config: SpeculativeToolExecutionConfig,
	candidate: SpeculativeToolCandidate,
	outcome: Exclude<SpeculativeToolTelemetry["outcome"], "ineligible">,
	reason?: string,
): void {
	if (candidate.reported) return;
	candidate.reported = true;
	const executionDurationMs =
		candidate.finishedAt === undefined ? undefined : candidate.finishedAt - candidate.startedAt;
	const overlapMs =
		outcome === "committed" && executionDurationMs !== undefined && candidate.dispatchReachedAt !== undefined
			? Math.min(executionDurationMs, Math.max(0, candidate.dispatchReachedAt - candidate.startedAt))
			: undefined;
	emitSpeculationTelemetry(config, {
		toolName: candidate.tool.name,
		toolCallId: candidate.toolCall.id,
		candidateStartedAt: candidate.startedAt,
		candidateFinishedAt: candidate.finishedAt,
		dispatchReachedAt: candidate.dispatchReachedAt,
		outcome,
		reason,
		executionDurationMs,
		overlapMs,
	});
}

function reportIneligibleCandidate(
	config: SpeculativeToolExecutionConfig,
	toolCall: AgentToolCall,
	reason: string,
): void {
	emitSpeculationTelemetry(config, {
		toolName: toolCall.name,
		toolCallId: toolCall.id,
		outcome: "ineligible",
		reason,
	});
}

function createCandidateSignal(
	runSignal: AbortSignal | undefined,
	controller: AbortController,
): { signal: AbortSignal; dispose: () => void } {
	const abort = () => controller.abort();
	if (runSignal?.aborted) {
		abort();
		return { signal: controller.signal, dispose: () => {} };
	}
	runSignal?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => runSignal?.removeEventListener("abort", abort),
	};
}

function discardCandidate(
	config: SpeculativeToolExecutionConfig,
	candidate: SpeculativeToolCandidate,
	outcome: "discarded" | "fingerprint_mismatch" | "aborted",
	reason: string,
): void {
	if (candidate.reported || candidate.state === "committed") return;
	candidate.state = "discarded";
	candidate.controller.abort();
	reportCandidate(config, candidate, outcome, reason);
}

function discardAllCandidates(
	config: SpeculativeToolExecutionConfig,
	registry: SpeculativeCandidateRegistry | undefined,
	reason: string,
	outcome: "discarded" | "aborted" = "discarded",
): void {
	if (!registry) return;
	for (const candidate of registry.values()) {
		discardCandidate(config, candidate, outcome, reason);
	}
	registry.clear();
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	const speculationConfig =
		config.speculativeToolExecution?.enabled === true ? config.speculativeToolExecution : undefined;
	const candidates = speculationConfig ? new Map<string, SpeculativeToolCandidate>() : undefined;
	let speculationBarrier = false;
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	let completed = false;

	try {
		let finalMessage: AssistantMessage | undefined;
		for await (const event of response) {
			if (event.type === "done" || event.type === "error") {
				finalMessage = await response.result();
				break;
			}

			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					if (speculationConfig && candidates) {
						if (speculationBarrier) {
							reportIneligibleCandidate(speculationConfig, event.toolCall, "preceding speculation barrier");
						} else {
							const eligible = await maybeStartSpeculativeCandidate(
								context,
								event.toolCall,
								config,
								signal,
								candidates,
							);
							if (!eligible) speculationBarrier = true;
						}
					}
					break;
			}
		}

		const settledMessage = finalMessage ?? (await response.result());
		if (addedPartial) {
			context.messages[context.messages.length - 1] = settledMessage;
		} else {
			context.messages.push(settledMessage);
			await emit({ type: "message_start", message: { ...settledMessage } });
		}

		if (speculationConfig && candidates) {
			if (
				signal?.aborted ||
				settledMessage.stopReason === "error" ||
				settledMessage.stopReason === "aborted" ||
				settledMessage.stopReason === "length"
			) {
				discardAllCandidates(
					speculationConfig,
					candidates,
					signal?.aborted ? "run aborted" : `final message stop reason: ${settledMessage.stopReason}`,
					signal?.aborted ? "aborted" : "discarded",
				);
			} else {
				reconcileSpeculativeCandidates(settledMessage, candidates, speculationConfig, context);
				if (candidates.size > 0) {
					speculativeCandidateRegistries.set(settledMessage, candidates);
				}
			}
		}

		await emit({ type: "message_end", message: settledMessage });
		completed = true;
		return settledMessage;
	} finally {
		if (!completed && speculationConfig) {
			discardAllCandidates(
				speculationConfig,
				candidates,
				signal?.aborted ? "run aborted" : "stream did not produce a runnable message",
				signal?.aborted ? "aborted" : "discarded",
			);
		}
	}
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const candidates = speculativeCandidateRegistries.get(assistantMessage);
	speculativeCandidateRegistries.delete(assistantMessage);
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, candidates);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, candidates);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	candidates: SpeculativeCandidateRegistry | undefined,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit, candidates, config);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	candidates: SpeculativeCandidateRegistry | undefined,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit, candidates, config);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

function prepareToolCallWithoutHook(
	currentContext: AgentContext,
	toolCall: AgentToolCall,
): PreparedToolCall | ImmediateToolCallOutcome {
	const tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validateToolArguments(tool, preparedToolCall),
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const preparation = prepareToolCallWithoutHook(currentContext, toolCall);
	if (preparation.kind === "immediate") return preparation;

	if (config.beforeToolCall) {
		const beforeResult = await config.beforeToolCall(
			{
				assistantMessage,
				toolCall,
				args: preparation.args,
				context: currentContext,
			},
			signal,
		);
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		if (beforeResult?.block) {
			const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
			if (beforeResult.terminate === true) {
				result.terminate = true;
			}
			return {
				kind: "immediate",
				result,
				isError: true,
			};
		}
	}
	if (signal?.aborted) {
		return {
			kind: "immediate",
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		};
	}
	return preparation;
}

async function executePreparedToolRaw(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: (partialResult: AgentToolResult<any>) => void,
): Promise<SpeculativeRawOutcome> {
	try {
		const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, onUpdate);
		return { result, isError: false, executionArgs: prepared.args };
	} catch (error) {
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
			executionArgs: prepared.args,
		};
	}
}

async function maybeStartSpeculativeCandidate(
	currentContext: AgentContext,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	registry: SpeculativeCandidateRegistry,
): Promise<boolean> {
	const speculationConfig = config.speculativeToolExecution as SpeculativeToolExecutionConfig;
	if (signal?.aborted) {
		reportIneligibleCandidate(speculationConfig, toolCall, "run aborted");
		return false;
	}
	if (config.toolExecution === "sequential") {
		reportIneligibleCandidate(speculationConfig, toolCall, "sequential tool execution");
		return false;
	}
	const maxInFlight =
		typeof speculationConfig.maxInFlight === "number" && Number.isFinite(speculationConfig.maxInFlight)
			? Math.max(1, Math.floor(speculationConfig.maxInFlight))
			: 2;
	if (registry.size >= maxInFlight) {
		reportIneligibleCandidate(speculationConfig, toolCall, "speculation capacity exhausted");
		return false;
	}
	const tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		reportIneligibleCandidate(speculationConfig, toolCall, "tool not directly advertised");
		return false;
	}
	if (tool.executionMode === "sequential") {
		reportIneligibleCandidate(speculationConfig, toolCall, "sequential tool");
		return false;
	}
	if (!tool.speculation || tool.speculation.safe !== true) {
		reportIneligibleCandidate(speculationConfig, toolCall, "tool is not speculation-safe");
		return false;
	}
	if (config.beforeToolCall) {
		reportIneligibleCandidate(speculationConfig, toolCall, "beforeToolCall is configured");
		return false;
	}
	const preparation = prepareToolCallWithoutHook(currentContext, toolCall);
	if (preparation.kind === "immediate") {
		reportIneligibleCandidate(speculationConfig, toolCall, "tool arguments could not be prepared");
		return false;
	}
	if (typeof preparation.args !== "object" || preparation.args === null || Array.isArray(preparation.args)) {
		reportIneligibleCandidate(speculationConfig, toolCall, "validated arguments are not an object");
		return false;
	}
	let fingerprint: string;
	try {
		fingerprint = createExecutionFingerprint(toolCall, preparation.args);
	} catch {
		reportIneligibleCandidate(speculationConfig, toolCall, "execution arguments are not canonical JSON");
		return false;
	}
	try {
		if (
			tool.speculation.canExecute &&
			!(await tool.speculation.canExecute({
				toolCall,
				args: preparation.args as Record<string, unknown>,
			}))
		) {
			reportIneligibleCandidate(speculationConfig, toolCall, "tool speculation policy vetoed execution");
			return false;
		}
		if (speculationConfig.canExecute && !(await speculationConfig.canExecute(tool, toolCall))) {
			reportIneligibleCandidate(speculationConfig, toolCall, "host speculation policy vetoed execution");
			return false;
		}
	} catch {
		reportIneligibleCandidate(speculationConfig, toolCall, "speculation policy failed");
		return false;
	}

	const controller = new AbortController();
	const candidateSignal = createCandidateSignal(signal, controller);
	const startedAt = Date.now();
	let candidate: SpeculativeToolCandidate;
	const promise = executePreparedToolRaw(preparation, candidateSignal.signal, () => {}).then((outcome) => {
		candidateSignal.dispose();
		candidate.finishedAt = Date.now();
		if (candidate.state === "running") candidate.state = "completed";
		return outcome;
	});
	candidate = {
		toolCall,
		tool,
		executionArgs: preparation.args,
		fingerprint,
		startedAt,
		state: "running",
		controller,
		promise,
		reported: false,
	};
	registry.set(toolCall.id, candidate);
	return true;
}

function takeMatchingCandidate(
	prepared: PreparedToolCall,
	registry: SpeculativeCandidateRegistry | undefined,
	speculationConfig: SpeculativeToolExecutionConfig | undefined,
): SpeculativeToolCandidate | undefined {
	const candidate = registry?.get(prepared.toolCall.id);
	if (!candidate || !speculationConfig) return undefined;
	registry?.delete(prepared.toolCall.id);
	candidate.dispatchReachedAt = Date.now();
	let fingerprint: string;
	try {
		fingerprint = createExecutionFingerprint(prepared.toolCall, prepared.args);
	} catch {
		discardCandidate(
			speculationConfig,
			candidate,
			"fingerprint_mismatch",
			"final execution arguments are not canonical JSON",
		);
		return undefined;
	}
	if (candidate.fingerprint !== fingerprint) {
		discardCandidate(speculationConfig, candidate, "fingerprint_mismatch", "final execution arguments changed");
		return undefined;
	}
	if (candidate.state === "discarded") return undefined;
	candidate.state = "committed";
	return candidate;
}

function reconcileSpeculativeCandidates(
	assistantMessage: AssistantMessage,
	registry: SpeculativeCandidateRegistry,
	config: SpeculativeToolExecutionConfig,
	context: AgentContext,
): void {
	for (const [toolCallId, candidate] of registry) {
		const finalToolCall = assistantMessage.content.find(
			(content): content is AgentToolCall => content.type === "toolCall" && content.id === toolCallId,
		);
		if (!finalToolCall) {
			registry.delete(toolCallId);
			discardCandidate(config, candidate, "discarded", "final message removed tool call");
			continue;
		}
		const preparation = prepareToolCallWithoutHook(context, finalToolCall);
		if (preparation.kind === "immediate") {
			registry.delete(toolCallId);
			discardCandidate(config, candidate, "fingerprint_mismatch", "final tool call could not be prepared");
			continue;
		}
		try {
			if (candidate.fingerprint === createExecutionFingerprint(finalToolCall, preparation.args)) continue;
		} catch {
			// The mismatch path below aborts the candidate and preserves ordinary dispatch.
		}
		registry.delete(toolCallId);
		discardCandidate(config, candidate, "fingerprint_mismatch", "final execution arguments changed");
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	candidates: SpeculativeCandidateRegistry | undefined,
	config: AgentLoopConfig,
): Promise<ExecutedToolCallOutcome> {
	const candidate = takeMatchingCandidate(prepared, candidates, config.speculativeToolExecution);
	if (candidate) {
		const outcome = await candidate.promise;
		reportCandidate(
			config.speculativeToolExecution as SpeculativeToolExecutionConfig,
			candidate,
			signal?.aborted ? "aborted" : "committed",
			signal?.aborted ? "run aborted before candidate commit" : undefined,
		);
		return outcome;
	}

	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	const outcome = await executePreparedToolRaw(prepared, signal, (partialResult) => {
		if (!acceptingUpdates) return;
		updateEvents.push(
			Promise.resolve(
				emit({
					type: "tool_execution_update",
					toolCallId: prepared.toolCall.id,
					toolName: prepared.toolCall.name,
					args: prepared.toolCall.arguments,
					partialResult,
				}),
			),
		);
	});
	acceptingUpdates = false;
	try {
		await Promise.all(updateEvents);
		return outcome;
	} catch (error) {
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
