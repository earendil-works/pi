import type { AgentTool, ToolResultMessage } from "@kennyfrc/mu-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ExtensionRunner } from "./runner.js";

export function wrapToolWithExtensions<TParams extends TSchema, TDetails>(
	tool: AgentTool<TParams, TDetails>,
	runner: ExtensionRunner,
): AgentTool<TParams, TDetails> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Static<TParams>,
			signal?: AbortSignal,
			onProgress?: (chunk: string) => void,
		) => {
			const decision = await runner.applyBeforeToolCall({
				toolCallId,
				toolName: tool.name,
				args: params,
			});

			if (decision.blocked) {
				const suffix = decision.reason ? `: ${decision.reason}` : "";
				throw new Error(`Tool call blocked by extension${suffix}`);
			}

			return tool.execute(toolCallId, decision.args as Static<TParams>, signal, onProgress);
		},
	};
}

export function composeToolResultTransformer(
	runner: ExtensionRunner,
	base?: (toolResult: ToolResultMessage<unknown>) => ToolResultMessage<unknown>,
): (toolResult: ToolResultMessage<unknown>) => ToolResultMessage<unknown> {
	return (toolResult: ToolResultMessage<unknown>) => {
		const after = runner.applyAfterToolResult(toolResult);
		return base ? base(after) : after;
	};
}
