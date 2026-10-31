import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { catalogedEffortCompat, OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";

/**
 * SiliconFlow. Reasoning models with a thinking toggle take a top-level
 * `enable_thinking` flag (Qwen's thinking format); other reasoning models keep
 * the server default unless models.dev lists effort levels.
 */
export function siliconflowModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		map: (model, source): Model<"openai-completions"> => ({
			...model,
			compat: {
				...catalogedEffortCompat(source),
				...(source.reasoningOptions?.some((option) => option.type === "toggle") ? { thinkingFormat: "qwen" } : {}),
			},
		}),
	});
}

export default defineProvider({
	id: "siliconflow",
	models: (ctx) => siliconflowModels(ctx, "siliconflow", "https://api.siliconflow.com/v1"),
	compat: { "openai-completions": OPENAI_COMPATIBLE_HOST_COMPAT },
});
