import type { AgentTool, Api, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";
import { allTools, type ToolName } from "./index.js";

export const DEFAULT_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"list_threads",
	"read_thread",
	"read_image",
	"todo",
	"handoff",
];

const GPT_DEFAULT_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"apply_patch",
	"write",
	"list_threads",
	"read_thread",
	"read_image",
	"todo",
	"handoff",
];

const GPT_STAR_TOOL_NAMES: ToolName[] = ["exec_command", "read_image", "handoff", "list_threads", "read_thread"];

export interface ToolSelection {
	toolNames: ToolName[];
	tools: Array<AgentTool<TSchema, unknown>>;
	replacedWithApplyPatch: boolean;
}

export function isGptModel(model: Model<Api> | null | undefined): boolean {
	if (!model) {
		return false;
	}
	const provider = model.provider.toLowerCase();
	const id = model.id.toLowerCase();
	const name = model.name ? model.name.toLowerCase() : "";
	if (provider === "openai" || provider === "openai-codex") {
		return true;
	}
	return id.includes("gpt") || name.includes("gpt");
}

function isGptStarModel(model: Model<Api> | null | undefined): boolean {
	if (!model) {
		return false;
	}
	const id = model.id.toLowerCase();
	const name = model.name ? model.name.toLowerCase() : "";

	return id.startsWith("gpt-") || id.includes("/gpt-") || id.includes(":gpt-") || name.includes("gpt-");
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
			: isGptStarModel(model)
				? GPT_STAR_TOOL_NAMES
				: isGptModel(model)
					? GPT_DEFAULT_TOOL_NAMES
					: DEFAULT_TOOL_NAMES;
	let replacedWithApplyPatch = false;
	const resolvedNames = dedupeToolNames(initialNames);

	// For GPT-ish models, we default to apply_patch instead of edit.
	replacedWithApplyPatch =
		isGptModel(model) && !resolvedNames.includes("edit") && resolvedNames.includes("apply_patch");

	const tools = resolvedNames.map((name) => allTools[name]) as unknown as Array<AgentTool<TSchema, unknown>>;

	return {
		toolNames: resolvedNames,
		tools,
		replacedWithApplyPatch,
	};
}
