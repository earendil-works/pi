import type { Model } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// models.dev still lists LongCat-2.0 and LongCat-2.5-Preview; the official API
// lists LongCat-2.5. Limits, image support, and current promotional USD prices:
// https://longcat.chat/platform/docs/zh/api/model-params
// https://longcat.chat/platform/docs/zh/image-video-understanding
// https://longcat.chat/platform/docs/zh/pricing/longcat-2.5
const MODELS: Model<"openai-completions">[] = [
	{
		id: "LongCat-2.5",
		name: "LongCat 2.5",
		api: "openai-completions",
		baseUrl: "https://api.longcat.chat/openai/v1",
		provider: "longcat",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
		input: ["text", "image"],
		inputLimits: { images: { maxPerRequest: 50 } },
		cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 262144,
	},
];

export default defineProvider({
	id: "longcat",
	models: () => structuredClone(MODELS),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		},
	},
});
