import { type ToolResultMessage, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolCall, AgentToolResult } from "../../types.ts";
import { type Context, withAbortSignal } from "../context.ts";
import type { JsonValue } from "../session/types.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation, AgentHarnessToolUpdateCallback } from "../types.ts";
import type { Gate } from "./effect-gate.ts";

/** A tool call whose tool exists and whose prepared arguments passed validation. */
export interface PreparedToolCall<TContext extends object | undefined> {
	toolCall: AgentToolCall;
	tool: AgentHarnessTool<TContext>;
	args: Record<string, JsonValue>;
}

/** Synthetic result produced without crossing the external tool-effect boundary. */
export interface ImmediateToolOutcome {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: true;
	terminate: boolean;
}

/** Aggregated decision from the before-tool hook pipeline. */
export interface BeforeToolDecision {
	args?: Record<string, JsonValue>;
	block?: { reason: string; terminate?: boolean };
}

/** A prepared call cleared for durable intent publication and execution. */
export interface ClearedToolCall<TContext extends object | undefined> {
	toolCall: AgentToolCall;
	tool: AgentHarnessTool<TContext>;
	args: Record<string, JsonValue>;
}

/** Raw phase-two tool output before after-tool patching. */
export interface ExecutedToolCall {
	result: AgentToolResult<unknown>;
	isError: boolean;
}

/** Aggregated patch from the after-tool hook pipeline. */
export interface AfterToolPatch {
	content?: AgentToolResult<unknown>["content"];
	details?: JsonValue;
	isError?: boolean;
	usage?: AgentToolResult<unknown>["usage"];
	terminate?: boolean;
}

/** Final tool output ready to become a durable tool-result message. */
export interface FinalizedToolCall {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
	terminate: boolean;
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
	};
}

function immediateError(toolCall: AgentToolCall, message: string, terminate = false): ImmediateToolOutcome {
	return {
		kind: "immediate",
		toolCall,
		result: createErrorToolResult(message),
		isError: true,
		terminate,
	};
}

/** Resolve a tool, apply its deterministic argument preparation, and validate the result. */
export function prepareToolCall<TContext extends object | undefined>(
	call: AgentToolCall,
	tools: AgentHarnessTool<TContext>[],
): PreparedToolCall<TContext> | ImmediateToolOutcome {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return immediateError(call, `Tool ${JSON.stringify(call.name)} is unavailable`);
	}

	try {
		const preparedArguments = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const preparedCall: AgentToolCall =
			preparedArguments === call.arguments
				? call
				: { ...call, arguments: preparedArguments as Record<string, JsonValue> };
		const args = validateToolArguments(tool, preparedCall) as Record<string, JsonValue>;
		return { toolCall: call, tool, args };
	} catch (error) {
		return immediateError(call, error instanceof Error ? error.message : String(error));
	}
}

/** Apply an explicit hook decision and revalidate replacement arguments. */
export function applyBeforeToolDecision<TContext extends object | undefined>(
	prepared: PreparedToolCall<TContext>,
	decision: BeforeToolDecision | undefined,
): ClearedToolCall<TContext> | ImmediateToolOutcome {
	if (decision?.block) {
		return immediateError(prepared.toolCall, decision.block.reason, decision.block.terminate === true);
	}

	if (!decision?.args) {
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: prepared.args };
	}

	try {
		const validatedArgs = validateToolArguments(prepared.tool, {
			...prepared.toolCall,
			arguments: decision.args,
		}) as Record<string, JsonValue>;
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: validatedArgs };
	} catch (error) {
		return immediateError(prepared.toolCall, error instanceof Error ? error.message : String(error));
	}
}

/** Execute one cleared external tool effect, converting expected tool throws to error output. */
export function executeToolCall<TContext extends object | undefined>(
	call: ClearedToolCall<TContext>,
	gate: Gate,
	onUpdate: AgentHarnessToolUpdateCallback<unknown>,
	toolContext: TContext,
	invocation: AgentHarnessToolInvocation,
	context: Context,
): Promise<ExecutedToolCall> {
	let acceptingUpdates = true;
	return gate.admit(async () => {
		const admittedContext = withAbortSignal(gate.signal, context);
		admittedContext.abortSignal?.throwIfAborted();
		try {
			const result = await call.tool.execute(
				call.toolCall.id,
				call.args,
				(partial, options) => {
					if (acceptingUpdates) onUpdate(partial, options);
				},
				toolContext,
				invocation,
				admittedContext,
			);
			return { result, isError: false };
		} catch (error) {
			return {
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		} finally {
			acceptingUpdates = false;
		}
	});
}

/** Apply an after-tool patch field by field. */
export function finalizeToolCall<TContext extends object | undefined>(
	call: ClearedToolCall<TContext>,
	executed: ExecutedToolCall,
	patch: AfterToolPatch | undefined,
): FinalizedToolCall {
	const result: AgentToolResult<unknown> = patch
		? {
				...executed.result,
				content: patch.content === undefined ? executed.result.content : patch.content,
				details: patch.details === undefined ? executed.result.details : patch.details,
				usage: patch.usage === undefined ? executed.result.usage : patch.usage,
				terminate: patch.terminate === undefined ? executed.result.terminate : patch.terminate,
			}
		: executed.result;
	return {
		toolCall: call.toolCall,
		result,
		isError: patch?.isError ?? executed.isError,
		terminate: result.terminate === true,
	};
}

/** Reconstruct the canonical tool result represented by a staged transcript message. */
export function toolResultFromMessage(
	message: ToolResultMessage<unknown>,
	terminate: boolean,
): AgentToolResult<unknown> {
	return {
		content: message.content,
		details: message.details,
		...(message.usage === undefined ? {} : { usage: message.usage }),
		...(message.addedToolNames === undefined ? {} : { addedToolNames: message.addedToolNames }),
		...(terminate ? { terminate: true } : {}),
	};
}

/** Convert finalized tool output to the provider-facing transcript message. */
export function createToolResultMessage(call: FinalizedToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.toolCall.id,
		toolName: call.toolCall.name,
		content: call.result.content ?? [],
		...(call.result.details === undefined ? {} : { details: call.result.details }),
		...(call.result.usage === undefined ? {} : { usage: call.result.usage }),
		...(call.result.addedToolNames?.length ? { addedToolNames: call.result.addedToolNames } : {}),
		isError: call.isError,
		timestamp: Date.now(),
	};
}
