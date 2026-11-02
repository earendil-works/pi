import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Alibaba Cloud Model Studio Token Plan. International and China use separate
// endpoints and API keys (sk-sp- prefix). models.dev lists them as
// "alibaba-token-plan[-cn]".
export const INTERNATIONAL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const COMPAT: OpenAICompletionsCompat = {
	thinkingFormat: "qwen",
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: true,
};
const FALLBACK_THINKING_LEVELS = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
const REASONING_EFFORT_FALLBACK_MODEL_IDS = new Set(["glm-5", "glm-5.1"]);
// Retired preview id — models.dev may still list it after GA ships.
const EXCLUDED_MODEL_IDS = new Set(["qwen3.8-max-preview"]);

export function qwenTokenPlanModels(ctx: ProviderContext, source: string, baseUrl: string, modelIds?: Set<string>) {
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		recordReasoning: false,
		include: (model) => !EXCLUDED_MODEL_IDS.has(model.id) && (!modelIds || modelIds.has(model.id)),
		map: (model, source): Model<"openai-completions"> => {
			const thinkingLevelMap =
				getEffortThinkingLevelMap(source.reasoningOptions ?? []) ??
				(REASONING_EFFORT_FALLBACK_MODEL_IDS.has(model.id) ? FALLBACK_THINKING_LEVELS : undefined);
			return {
				...model,
				compat: thinkingLevelMap ? COMPAT : { ...COMPAT, supportsReasoningEffort: false },
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			};
		},
	});
}

export const QWEN_COMPLETIONS_COMPAT = { supportsStrictMode: true } as const;

export default defineProvider({
	id: "qwen-token-plan",
	models: (ctx) => qwenTokenPlanModels(ctx, "alibaba-token-plan", INTERNATIONAL_BASE_URL),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
