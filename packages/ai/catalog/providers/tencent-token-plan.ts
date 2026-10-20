import type { OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";

// Tencent Hunyuan (Hy) on the prepaid Token Plan endpoint; models.dev lists it
// as "tencent-token-plan". It speaks Chat Completions and documents an
// Anthropic-compatible path alongside it.
export const TOKEN_PLAN_BASE_URL = "https://api.lkeap.cloud.tencent.com/plan/v3";

export const TENCENT_HY_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsStore: false,
	maxTokensField: "max_tokens",
};

// Hy reports its effort values in models.dev, so the shared rules derive the
// thinking levels: off/high for hy3 and hy4-preview.
export function tencentHyModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, { api: "openai-completions", baseUrl });
}

export default defineProvider({
	id: "tencent-token-plan",
	models: (ctx) => tencentHyModels(ctx, "tencent-token-plan", TOKEN_PLAN_BASE_URL),
	compat: { "openai-completions": TENCENT_HY_COMPLETIONS_COMPAT },
});
