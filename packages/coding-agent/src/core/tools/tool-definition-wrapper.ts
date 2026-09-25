import type { AgentTool, AgentToolCall, AgentToolContext } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";

/** Loop services for a tool executed outside the agent loop: no sibling tools, nested calls fail. */
function createDetachedToolContext(toolCall: AgentToolCall): AgentToolContext {
	return {
		toolCall,
		tools: [],
		executeTool: async (name, args) => ({
			toolCall: { type: "toolCall", id: `${toolCall.id}/detached`, name, arguments: (args ?? {}) as never },
			result: {
				content: [{ type: "text", text: "Nested tool calls are only available inside the agent loop" }],
				details: {},
			},
			isError: true,
		}),
	};
}

/**
 * Combine the extension context with the agent-loop services. Property descriptors are copied so
 * the lazy getters of the extension context keep their stale-instance checks.
 */
function createToolExecutionContext(
	base: ExtensionContext | undefined,
	agentContext: AgentToolContext,
): ExtensionToolContext {
	const context = Object.defineProperties(
		{},
		base ? Object.getOwnPropertyDescriptors(base) : {},
	) as ExtensionToolContext;
	context.toolCall = agentContext.toolCall;
	context.tools = agentContext.tools;
	context.executeTool = agentContext.executeTool;
	return context;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		nestedOnly: definition.nestedOnly,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		// Without a factory, the incoming context may already be a full ExtensionToolContext, for
		// example when this AgentTool is itself registered as an extension tool; keep all of it.
		execute: (toolCallId, params, signal, onUpdate, agentContext) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				createToolExecutionContext(
					ctxFactory?.() ?? (agentContext as ExtensionContext | undefined),
					agentContext ??
						createDetachedToolContext({
							type: "toolCall",
							id: toolCallId,
							name: definition.name,
							arguments: params as AgentToolCall["arguments"],
						}),
				),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		nestedOnly: tool.nestedOnly,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, signal, onUpdate, ctx),
	};
}
