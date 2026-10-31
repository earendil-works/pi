import type { Model } from "../../src/types.ts";
import { defineProvider, modelsDevModels, type ProviderContext } from "../define.ts";
import { OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Models StepFun has taken offline. Skip them even if models.dev still lists them.
const OFFLINE_MODEL_IDS = new Set(["step-1-32k", "step-2-16k"]);

/**
 * StepFun's Global (stepfun.ai) and China (stepfun.com) platforms. Reasoning
 * uses DeepSeek's shape: a `thinking` toggle, top-level `reasoning_effort` with
 * per-model values, and `reasoning_content` that must be sent back.
 */
export function stepfunModels(ctx: ProviderContext, source: string, baseUrl: string) {
	return modelsDevModels(ctx, source, {
		api: "openai-completions",
		baseUrl,
		recordReasoning: false,
		include: (model) => !OFFLINE_MODEL_IDS.has(model.id),
		map: (model, source): Model<"openai-completions"> => {
			const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
			return {
				...model,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
			};
		},
	});
}

export const STEPFUN_COMPLETIONS_COMPAT = {
	...OPENAI_COMPATIBLE_HOST_COMPAT,
	thinkingFormat: "deepseek",
	requiresReasoningContentOnAssistantMessages: true,
} as const;

export default defineProvider({
	id: "stepfun",
	models: (ctx) => stepfunModels(ctx, "stepfun-ai", "https://api.stepfun.ai/v1"),
	compat: { "openai-completions": STEPFUN_COMPLETIONS_COMPAT },
});
