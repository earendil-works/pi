import type { AgentTool, Api, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";

import type { ExtensionManager } from "../extensions/manager.js";
import type { ToolName } from "../tools/index.js";
import { resolveToolSelection } from "../tools/tool-selection.js";

const ALWAYS_ON_FORBIDDEN_TOOL_NAMES = new Set<string>(["ask_user"]);

export interface AlwaysOnToolSelection {
	toolNames: string[];
	tools: Array<AgentTool<TSchema, unknown>>;
	replacedWithApplyPatch: boolean;
}

export function resolveAlwaysOnToolSelection(options: {
	model: Model<Api>;
	extensionManager: ExtensionManager;
	baseToolNames?: ToolName[];
}): AlwaysOnToolSelection {
	const baseSelection = resolveToolSelection(options.baseToolNames, options.model);
	const tools = options.extensionManager
		.getToolsForSelection(baseSelection.toolNames)
		.filter((tool) => !ALWAYS_ON_FORBIDDEN_TOOL_NAMES.has(tool.name));

	return {
		toolNames: tools.map((tool) => tool.name),
		tools,
		replacedWithApplyPatch: baseSelection.replacedWithApplyPatch,
	};
}
