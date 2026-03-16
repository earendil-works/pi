import { streamSimple } from "../stream.js";
import type { AssistantMessage, Context, Message, ToolCall, ToolResultMessage, UserMessage } from "../types.js";
import { EventStream } from "../utils/event-stream.js";
import { validateToolArguments } from "../utils/validation.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool, AgentToolResult } from "./types.js";

// Strip thinking blocks from assistant messages at agent_end.
// Within a turn, thinking is needed for <think> tags in prompts.
// After a run completes, thinking should not be sent back in future turns.
function stripThinkingFromMessages(messages: AgentContext["messages"]): AgentContext["messages"] {
	return messages.map((msg) => {
		if (msg.role !== "assistant") {
			return msg;
		}

		const filteredContent = msg.content.filter((block) => block.type !== "thinking");

		// If no thinking blocks, avoid allocating a new object
		if (filteredContent.length === msg.content.length) {
			return msg;
		}

		return {
			...msg,
			content: filteredContent,
		};
	});
}

// Main prompt function - returns a stream of events
export function agentLoop(
	prompt: UserMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: typeof streamSimple,
): EventStream<AgentEvent, AgentContext["messages"]> {
	const stream = new EventStream<AgentEvent, AgentContext["messages"]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);

	// Run the prompt async
	(async () => {
		// Track new messages generated during this prompt
		const newMessages: AgentContext["messages"] = [];
		// Create user message for the prompt
		const messages = [...context.messages, prompt];
		newMessages.push(prompt);

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		stream.push({ type: "message_start", message: prompt });
		stream.push({ type: "message_end", message: prompt });

		// Update context with new messages
		const currentContext: AgentContext = {
			...context,
			messages,
		};

		// Keep looping while we have tool calls
		let hasMoreToolCalls = true;
		let firstTurn = true;
		let pendingInjectedUserMessages: UserMessage[] = [];

		while (hasMoreToolCalls) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// If we have pending injected user messages from the previous tool-using turn,
			// emit them now as part of this new turn (before the next assistant response).
			if (pendingInjectedUserMessages.length > 0) {
				for (const injected of pendingInjectedUserMessages) {
					currentContext.messages.push(injected);
					newMessages.push(injected);
					stream.push({ type: "message_start", message: injected });
					stream.push({ type: "message_end", message: injected });
				}
				pendingInjectedUserMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
				// Stop the loop on error, abort, or context-length exceeded
				stream.push({ type: "turn_end", message, toolResults: [] });
				const cleanedMessages = stripThinkingFromMessages(newMessages);
				stream.push({ type: "agent_end", messages: cleanedMessages });
				stream.end(cleanedMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				// Execute tool calls
				toolResults.push(
					...(await executeToolCalls(currentContext.tools, message, signal, stream, config.toolResultTransformer)),
				);
				currentContext.messages.push(...toolResults);
				newMessages.push(...toolResults);
			}
			stream.push({ type: "turn_end", message, toolResults: toolResults });

			// Allow the host to inject steering user messages between toolResults and the continuation.
			// We only ever need this when the model is going to continue (i.e., hasMoreToolCalls).
			if (hasMoreToolCalls && config.interrupt) {
				try {
					const injected = await config.interrupt(
						{
							assistantMessage: message,
							toolResults,
							messages: currentContext.messages,
						},
						signal,
					);
					if (injected && injected.length > 0) {
						pendingInjectedUserMessages = injected;
					}
				} catch {
					// Steering should never crash the agent loop.
					pendingInjectedUserMessages = [];
				}
			}
		}
		const cleanedMessages = stripThinkingFromMessages(newMessages);
		stream.push({ type: "agent_end", messages: cleanedMessages });
		stream.end(cleanedMessages);
	})();

	return stream;
}

// Helper functions
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentContext["messages"]>,
	streamFn?: typeof streamSimple,
): Promise<AssistantMessage> {
	// Convert AgentContext to Context for streamSimple
	// Use a copy of messages to avoid mutating the original context
	const processedMessages = config.preprocessor
		? await config.preprocessor(context.messages, signal)
		: [...context.messages];
	const processedContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: [...processedMessages].map((m) => {
			if (m.role === "toolResult") {
				const { details, ...rest } = m;
				return rest;
			} else {
				return m;
			}
		}),
		tools: context.tools, // AgentTool extends Tool, so this works
	};

	// Use custom stream function if provided, otherwise use default streamSimple
	const streamFunction = streamFn || streamSimple;
	const response = await streamFunction(config.model, processedContext, { ...config, signal });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

// Internal types for tool execution with resource-based serialization
interface ToolCallWithMeta<T> {
	toolCall: ToolCall;
	originalIndex: number;
	tool: AgentTool<any, T> | undefined;
	resourceKey: string | null;
}

interface ExecutionResult<T> {
	originalIndex: number;
	toolCall: ToolCall;
	resultOrError: AgentToolResult<T> | string;
	isError: boolean;
}

async function executeToolCalls<T>(
	tools: AgentTool<any, T>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, Message[]>,
	toolResultTransformer?: (toolResult: ToolResultMessage<T>) => ToolResultMessage<T>,
): Promise<ToolResultMessage<T>[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");

	// 1. Emit all start events upfront (FIFO order preserved)
	for (const toolCall of toolCalls) {
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
	}

	// 2. Annotate tool calls with resource keys
	const toolCallsWithMeta: ToolCallWithMeta<T>[] = toolCalls.map((toolCall, index) => {
		const tool = tools?.find((t) => t.name === toolCall.name);
		const resourceKey = tool?.getResourceKey?.(toolCall.arguments) ?? null;
		return { toolCall, originalIndex: index, tool, resourceKey };
	});

	// 3. Group by resource key
	// null key = parallel group, same non-null key = serial group
	const parallelGroup: ToolCallWithMeta<T>[] = [];
	const serialGroups = new Map<string, ToolCallWithMeta<T>[]>();

	for (const item of toolCallsWithMeta) {
		if (item.resourceKey === null) {
			parallelGroup.push(item);
		} else {
			const group = serialGroups.get(item.resourceKey);
			if (group) {
				group.push(item);
			} else {
				serialGroups.set(item.resourceKey, [item]);
			}
		}
	}

	// 4. Execute a single tool call
	const executeSingle = async (item: ToolCallWithMeta<T>): Promise<ExecutionResult<T>> => {
		const { toolCall, originalIndex, tool } = item;

		const onProgress = (chunk: string) => {
			stream.push({
				type: "tool_execution_progress",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				output: chunk,
			});
		};

		let resultOrError: AgentToolResult<T> | string;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
			const validatedArgs = validateToolArguments(tool, toolCall);
			resultOrError = await tool.execute(toolCall.id, validatedArgs, signal, onProgress);
		} catch (e) {
			resultOrError = e instanceof Error ? e.message : String(e);
			isError = true;
		}

		return { originalIndex, toolCall, resultOrError, isError };
	};

	// 5. Execute serial group (FIFO order within group)
	const executeSerial = async (items: ToolCallWithMeta<T>[]): Promise<ExecutionResult<T>[]> => {
		const results: ExecutionResult<T>[] = [];
		for (const item of items) {
			results.push(await executeSingle(item));
		}
		return results;
	};

	// 6. Build execution promises for all groups
	const groupPromises: Promise<ExecutionResult<T>[]>[] = [];

	// Parallel group: execute all concurrently
	if (parallelGroup.length > 0) {
		groupPromises.push(Promise.all(parallelGroup.map(executeSingle)));
	}

	// Serial groups: execute each group sequentially, but groups run in parallel with each other
	for (const [, items] of serialGroups) {
		groupPromises.push(executeSerial(items));
	}

	// 7. Await all groups and flatten results
	const allResultsNested = await Promise.all(groupPromises);
	const allResults = allResultsNested.flat();

	// 8. Re-order to original FIFO order
	const resultMap = new Map(allResults.map((r) => [r.originalIndex, r]));
	const orderedResults: ExecutionResult<T>[] = [];
	for (let i = 0; i < toolCalls.length; i++) {
		const result = resultMap.get(i);
		if (result) {
			orderedResults.push(result);
		}
	}

	// 9. Emit end events and build result messages (FIFO order)
	const results: ToolResultMessage<T>[] = [];
	for (const { toolCall, resultOrError, isError } of orderedResults) {
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result: resultOrError,
			isError,
		});

		const content: ToolResultMessage<T>["content"] =
			typeof resultOrError === "string" ? [{ type: "text", text: resultOrError }] : resultOrError.content;

		let toolResultMessage: ToolResultMessage<T> = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content,
			details: typeof resultOrError === "string" ? ({} as T) : resultOrError.details,
			isError,
			timestamp: Date.now(),
		};

		// Apply transformer if provided (e.g., to inject context usage warnings)
		if (toolResultTransformer) {
			toolResultMessage = toolResultTransformer(toolResultMessage);
		}

		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	}

	return results;
}
