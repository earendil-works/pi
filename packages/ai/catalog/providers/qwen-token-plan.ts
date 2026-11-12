import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Qwen Token Plan: QwenCloud (international) and Qianwen AI Platform (China). Each region has its
// own endpoint and API keys (sk-sp- prefix). models.dev lists them as "alibaba-token-plan[-cn]".
// The former token-plan.{ap-southeast-1,cn-beijing}.maas.aliyuncs.com hosts resolve to the same
// gateways and keep working for configurations that still name them.
// https://docs.qwencloud.com/developer-guides/getting-started/regions
// https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/other-tools
export const INTERNATIONAL_BASE_URL = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
export const CN_BASE_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";

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

export function qwenTokenPlanModels(ctx: ProviderContext, source: string, baseUrl: string, modelIds?: Set<string>) {
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		recordReasoning: false,
		// models.dev marks models dropped from the Token Plan lists deprecated, e.g. qwen3.8-max-preview,
		// deepseek-v3.2 and deepseek-v4-flash.
		skipDeprecated: true,
		include: (model) => !modelIds || modelIds.has(model.id),
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
