import type { AgentTool, Api, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";
import { allTools, type ToolName } from "./index.js";

export const DEFAULT_TOOL_NAMES: ToolName[] = [
	"Read",
	"Bash",
	"Edit",
	"Write",
	"ListThreads",
	"ReadThread",
	"ReadImage",
	"Todo",
	"Handoff",
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
	const provider = model.provider.toLowerCase();
	const id = model.id.toLowerCase();
	const name = model.name ? model.name.toLowerCase() : "";
	if (provider === "openai" || provider === "openai-codex") {
		return true;
	}
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
	const initialNames = baseToolNames && baseToolNames.length > 0 ? baseToolNames : DEFAULT_TOOL_NAMES;
	let replacedWithApplyPatch = false;
	let resolvedNames = dedupeToolNames(initialNames);

	if (isGptModel(model)) {
		const swapped: ToolName[] = [];
		for (const name of resolvedNames) {
			if (name === "Edit" || name === "Write") {
				replacedWithApplyPatch = true;
				if (!swapped.includes("ApplyPatch")) {
					swapped.push("ApplyPatch");
				}
				continue;
			}
			if (!swapped.includes(name)) {
				swapped.push(name);
			}
		}
		resolvedNames = swapped;
	}

	const tools = resolvedNames.map((name) => allTools[name]) as unknown as Array<AgentTool<TSchema, unknown>>;

	return {
		toolNames: resolvedNames,
		tools,
		replacedWithApplyPatch,
	};
}
