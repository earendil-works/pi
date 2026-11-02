// DeepSeek V4 models on OpenAI-compatible hosts.

import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { type ChatModel, mergeCompat, mergeThinking } from "../define.ts";

export const DEEPSEEK_COMPAT: OpenAICompletionsCompat = {
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

export const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
export const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
// Azure Foundry rejects DeepSeek's own max effort.
const AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;

// Qwen Token Plan serves DeepSeek V4 through Qwen's own thinking format.
const QWEN_FORMAT_PROVIDERS = new Set(["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"]);
// These hosts accept native reasoning efforts instead of DeepSeek's thinking toggle.
const NATIVE_EFFORT_PROVIDERS = new Set(["openrouter", "opencode"]);

function isDeepSeekV4(model: ChatModel): model is Model<"openai-completions"> {
	return model.api === "openai-completions" && model.id.includes("deepseek-v4");
}

/** DeepSeek V4 needs its reasoning content replayed on every host. */
export function applyDeepSeekCompatRules(model: ChatModel): void {
	if (!isDeepSeekV4(model) || QWEN_FORMAT_PROVIDERS.has(model.provider)) return;
	mergeCompat(
		model,
		NATIVE_EFFORT_PROVIDERS.has(model.provider)
			? { requiresReasoningContentOnAssistantMessages: DEEPSEEK_COMPAT.requiresReasoningContentOnAssistantMessages }
			: DEEPSEEK_COMPAT,
	);
}

/** DeepSeek V4 effort levels when the host did not report its own. */
export function applyDeepSeekFamilyRules(model: ChatModel): void {
	if (!isDeepSeekV4(model) || model.thinkingLevelMap !== undefined) return;
	if (model.provider === "openrouter") {
		mergeThinking(model, { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null });
	} else if (model.provider === "azure") {
		mergeThinking(model, AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP);
	} else if (
		(model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
		model.id.includes("deepseek-v4-flash")
	) {
		mergeThinking(model, DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP);
	} else {
		mergeThinking(model, DEEPSEEK_V4_THINKING_LEVEL_MAP);
	}
}
