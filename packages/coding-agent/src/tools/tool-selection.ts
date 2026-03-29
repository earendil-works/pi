import type { AgentTool, Api, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";
import { allTools, type ToolName } from "./index.js";

// Default toolset for most models.
export const DEFAULT_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"list_threads",
	"read_thread",
	"read_image",
	"spawn_agent",
	"wait_agent",
	"compact",
	"todo_write",
];

export const GPT_DEFAULT_TOOL_NAMES: ToolName[] = [
	"bash",
	"apply_patch",
	"list_threads",
	"read_thread",
	"read_image",
	"spawn_agent",
	"wait_agent",
	"compact",
	"todo_write",
];

export interface ToolSelection {
	toolNames: ToolName[];
	tools: Array<AgentTool<TSchema, unknown>>;
	replacedWithApplyPatch: boolean;
}

export function isGptModel(model: Model<Api> | null | undefined): boolean {
	if (!model) {
		return false;
	}
	const id = model.id.toLowerCase();
	const name = model.name ? model.name.toLowerCase() : "";
	return id.includes("gpt") || name.includes("gpt");
}

function dedupeToolNames(toolNames: ToolName[]): ToolName[] {
	const seen = new Set<ToolName>();
	const result: ToolName[] = [];
	for (const name of toolNames) {
		if (!seen.has(name)) {
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}

export function resolveToolSelection(
	baseToolNames: ToolName[] | undefined,
	model: Model<Api> | null | undefined,
): ToolSelection {
	const initialNames =
		baseToolNames && baseToolNames.length > 0
			? baseToolNames
			: isGptModel(model)
				? GPT_DEFAULT_TOOL_NAMES
				: DEFAULT_TOOL_NAMES;
	const resolvedNames = dedupeToolNames(initialNames);

	const replacedWithApplyPatch = !resolvedNames.includes("edit") && resolvedNames.includes("apply_patch");

	const tools = resolvedNames.map((name) => allTools[name]) as unknown as Array<AgentTool<TSchema, unknown>>;

	return {
		toolNames: resolvedNames,
		tools,
		replacedWithApplyPatch,
	};
}
