import type { Model } from "../../src/types.ts";
import { defineProvider, mergeCompat } from "../define.ts";
import { DEEPSEEK_COMPAT, DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP } from "../families/deepseek.ts";

// models.dev's DeepSeek entries lag the API; pricing from
// https://api-docs.deepseek.com/quick_start/pricing. DeepSeek also offers
// time-based off-peak rates, which the cost schema cannot represent yet.
const MODELS: Model<"openai-completions">[] = [
	{
		id: "deepseek-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		provider: "deepseek",
		reasoning: true,
		thinkingLevelMap: DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: DEEPSEEK_COMPAT,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		provider: "deepseek",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: DEEPSEEK_COMPAT,
	},
];

export default defineProvider({
	id: "deepseek",
	models: () => structuredClone(MODELS),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			supportsStrictMode: true,
		},
	},
	finalize: (model) => {
		// DeepSeek V4 Pro accepts plain system text in place mid-conversation.
		if (model.id === "deepseek-v4-pro") {
			mergeCompat(model as Model<"openai-completions">, { supportsMidConvoSystemMessages: true });
		}
	},
});
