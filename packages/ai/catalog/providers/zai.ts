import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import { modelsDevChatModels, modelsDevCost } from "../sources/models-dev.ts";

// Tool-call streaming (`tool_stream`) is rejected by the GLM-4.5 generation.
const TOOL_STREAM_UNSUPPORTED_MODEL_IDS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);

/**
 * Z.AI (international) and Zhipu (China) models, for both the coding plans and
 * the pay-as-you-go APIs. `priceSource` takes prices from another models.dev
 * provider: coding-plan entries carry plan prices, so they show API rates.
 */
export function zaiModels(ctx: ProviderContext, source: string, baseUrl: string, priceSource?: string) {
	const priceModels = new Map(
		priceSource ? modelsDevChatModels(ctx.sources.modelsDev, priceSource).map((model) => [model.id, model]) : [],
	);
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		map: (model, source): Model<"openai-completions"> => {
			const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
			if (thinkingLevelMap && (model.id === "glm-5.2" || model.id === "glm-5.2-highspeed")) {
				thinkingLevelMap.off = "none";
			}
			const priceModel = priceModels.get(model.id);
			return {
				...model,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				cost: modelsDevCost(priceModel?.source.cost ? priceModel.cost : source.cost),
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(thinkingLevelMap ? { supportsReasoningEffort: true } : {}),
					...(!TOOL_STREAM_UNSUPPORTED_MODEL_IDS.has(model.id) ? { zaiToolStream: true } : {}),
				},
			};
		},
	});
}

export const ZAI_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	thinkingFormat: "zai",
	supportsStrictMode: true,
} as const;

export default defineProvider({
	id: "zai",
	models: (ctx) => zaiModels(ctx, "zai-coding-plan", "https://api.z.ai/api/coding/paas/v4", "zai"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
