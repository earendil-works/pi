import type { OpenAICompletionsCompat, ThinkingLevelMap } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";

const BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = { ...BASE_COMPAT, thinkingFormat: "together" };

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
				// Every reasoning model Together lists takes its thinking toggle. (The effort-controlled ones, gpt-oss and
				// DeepSeek V4 Pro 0813, are deprecated upstream and skipped.)
				return { ...model, compat: TOGGLE_REASONING_COMPAT, thinkingLevelMap: { ...TOGGLE_REASONING_LEVELS } };
			},
		}),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsLongCacheRetention: false,
		},
	},
});
