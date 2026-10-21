import type { OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";

// Tencent Hunyuan (Hy). TokenHub is the pay-as-you-go endpoint, Token Plan the
// prepaid plan one; models.dev lists them as "tencent-tokenhub" and
// "tencent-token-plan". Both speak Chat Completions and document an
// Anthropic-compatible path alongside it.
export const TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com/v1";

export const TENCENT_HY_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsStore: false,
	maxTokensField: "max_tokens",
};

// Hy reports its effort values in models.dev, so the shared rules derive the
// thinking levels: off/high for hy3 and hy4-preview, low/medium/high for
// hy3-preview.
export function tencentHyModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, { api: "openai-completions", baseUrl });
}

export default defineProvider({
	id: "tencent-tokenhub",
	models: (ctx) => tencentHyModels(ctx, "tencent-tokenhub", TOKENHUB_BASE_URL),
	compat: { "openai-completions": TENCENT_HY_COMPLETIONS_COMPAT },
});
