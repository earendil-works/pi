import type { AgentTool, FreeformAgentTool, JsonAgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	FreeformToolDefinition,
	JsonToolDefinition,
	ToolDefinition,
} from "../extensions/types.ts";

function isFreeformToolDefinition(definition: ToolDefinition): definition is FreeformToolDefinition<any, any> {
	return "type" in definition && definition.type === "freeform";
}

function isFreeformAgentTool(tool: AgentTool): tool is FreeformAgentTool {
	return "type" in tool && tool.type === "freeform";
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParams extends TSchema, TDetails = unknown>(
	definition: JsonToolDefinition<TParams, TDetails>,
	ctxFactory?: () => ExtensionContext,
): JsonAgentTool<TParams, TDetails>;
export function wrapToolDefinition<TDetails = unknown>(
	definition: FreeformToolDefinition<TDetails>,
	ctxFactory?: () => ExtensionContext,
): FreeformAgentTool<TDetails>;
export function wrapToolDefinition(definition: ToolDefinition, ctxFactory?: () => ExtensionContext): AgentTool;
export function wrapToolDefinition(definition: ToolDefinition, ctxFactory?: () => ExtensionContext): AgentTool {
	if (isFreeformToolDefinition(definition)) {
		return {
			type: "freeform",
			name: definition.name,
			label: definition.label,
			description: definition.description,
			format: definition.format,
			executionMode: definition.executionMode,
			execute: (
				toolCallId: string,
				input: string,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback | undefined,
			) => definition.execute(toolCallId, input, signal, onUpdate, ctxFactory?.() as ExtensionContext),
		};
	}

	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
		) => definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools. */
export function wrapToolDefinitions(definitions: ToolDefinition[], ctxFactory?: () => ExtensionContext): AgentTool[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when callers
 * provide plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool<TParams extends TSchema>(
	tool: JsonAgentTool<TParams>,
): JsonToolDefinition<TParams, unknown>;
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition;
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
	if (isFreeformAgentTool(tool)) {
		return {
			type: "freeform",
			name: tool.name,
			label: tool.label,
			description: tool.description,
			format: tool.format,
			executionMode: tool.executionMode,
			execute: async (
				toolCallId: string,
				input: string,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback | undefined,
			) => tool.execute(toolCallId, input, signal, onUpdate),
		};
	}

	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
		) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
