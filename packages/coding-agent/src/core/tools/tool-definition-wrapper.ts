import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	buildInstrumentation,
	finalizeDetailsWithInstrumentation,
	InstrumentedToolError,
	stashInstrumentationForError,
} from "../tool-instrumentation.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
	fallbackCwd?: string,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const startMs = Date.now();
			const cwd = fallbackCwd ?? process.cwd();
			try {
				const result = await definition.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					ctxFactory?.() as ExtensionContext,
				);
				const endMs = Date.now();
				const finalizedDetails = finalizeDetailsWithInstrumentation(result.details, startMs, endMs, cwd);
				return {
					...result,
					details: (finalizedDetails ?? result.details) as TDetails,
				};
			} catch (error) {
				if (error instanceof InstrumentedToolError) {
					const instrumentation = buildInstrumentation(startMs, Date.now(), error.probe, cwd);
					stashInstrumentationForError(toolCallId, instrumentation);
				}
				throw error;
			}
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
	fallbackCwd?: string,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory, fallbackCwd));
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
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
