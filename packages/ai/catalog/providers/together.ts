import type { OpenAICompletionsCompat, ThinkingLevelMap } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";

const BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = { ...BASE_COMPAT, thinkingFormat: "together" };
const REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
const TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};

const REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const TOGGLE_REASONING_EFFORT_MODELS = new Set(["deepseek-ai/DeepSeek-V4-Pro-0813"]);

const REASONING_EFFORT_LEVELS: ThinkingLevelMap = { off: null, minimal: null };
const DEEPSEEK_V4_LEVELS: ThinkingLevelMap = { minimal: null, low: null, medium: null, high: "high", xhigh: null };
const TOGGLE_REASONING_LEVELS: ThinkingLevelMap = { minimal: null, low: null, medium: null };

export default defineProvider({
	id: "together",
	models: (ctx) =>
		modelsDevModels(ctx, "togetherai", {
			api: "openai-completions",
			baseUrl: "https://api.together.ai/v1",
			skipDeprecated: true,
			map: (model) => {
				if (!model.reasoning) return { ...model, compat: BASE_COMPAT };
				if (REASONING_EFFORT_MODELS.has(model.id)) {
					return { ...model, compat: REASONING_EFFORT_COMPAT, thinkingLevelMap: { ...REASONING_EFFORT_LEVELS } };
				}
				if (TOGGLE_REASONING_EFFORT_MODELS.has(model.id)) {
					return { ...model, compat: TOGGLE_REASONING_EFFORT_COMPAT, thinkingLevelMap: { ...DEEPSEEK_V4_LEVELS } };
				}
				return { ...model, compat: TOGGLE_REASONING_COMPAT, thinkingLevelMap: { ...TOGGLE_REASONING_LEVELS } };
			},
		}),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsLongCacheRetention: false,
		},
	},
});
