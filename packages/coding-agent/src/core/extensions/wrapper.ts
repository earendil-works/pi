/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bashToolOptionsContext } from "../tools/bash-tool-options-context.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		runner.createToolContext(toolCallId, signal),
	);
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => {
			// One context per execution: it seeds the bash options store and is passed to the definition.
			const context = runner.createToolContext(toolCallId, signal);
			return bashToolOptionsContext.run(context.getBashToolOptions, () =>
				registeredTool.definition.execute(toolCallId, params, signal, onUpdate, context),
			);
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
