import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import { MODEL_STUDIO_COMPAT, QWEN_COMPLETIONS_COMPAT } from "./qwen-token-plan.ts";

/**
 * Alibaba Cloud Model Studio (DashScope) pay-as-you-go. It serves the same
 * compatible-mode API as the Qwen Token Plan: thinking is toggled with
 * `enable_thinking`, and `reasoning_effort` is sent only where models.dev
 * lists effort levels.
 */
export function dashscopeModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		recordReasoning: false,
		map: (model, source): Model<"openai-completions"> => {
			const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
			return {
				...model,
				compat: thinkingLevelMap ? MODEL_STUDIO_COMPAT : { ...MODEL_STUDIO_COMPAT, supportsReasoningEffort: false },
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			};
		},
	});
}

export default defineProvider({
	id: "alibaba",
	models: (ctx) => dashscopeModels(ctx, "alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
	compat: { "openai-completions": QWEN_COMPLETIONS_COMPAT },
});
