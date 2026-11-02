import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";

/**
 * Xiaomi MiMo. The `xiaomi` provider targets the API billing endpoint; the
 * `xiaomi-token-plan-*` providers cover prepaid Token Plan endpoints per region.
 * MiMo Chat Completions only documents thinking.type enabled/disabled and
 * rejects some reasoning_effort values (e.g. "minimal"). Xiaomi documents all
 * effort levels as identical, so expose only off and high.
 */
export function xiaomiModels(ctx: ProviderContext, baseUrl: string) {
	return modelsDevModels(ctx, ctx.providerId, {
		api: "openai-completions",
		baseUrl,
		skipDeprecated: true,
		recordReasoning: false,
		compat: {
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
		map: (model): Model<"openai-completions"> =>
			model.reasoning
				? {
						...model,
						thinkingLevelMap: {
							off: "off",
							minimal: null,
							low: null,
							medium: null,
							high: "high",
							xhigh: null,
							max: null,
						},
					}
				: model,
	});
}

export const XIAOMI_COMPLETIONS_COMPAT = { supportsStrictMode: true } as const;

export default defineProvider({
	id: "xiaomi",
	models: (ctx) => xiaomiModels(ctx, "https://api.xiaomimimo.com/v1"),
	compat: { "openai-completions": XIAOMI_COMPLETIONS_COMPAT },
});
