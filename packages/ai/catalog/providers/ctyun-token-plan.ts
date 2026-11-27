import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// CTYUN Token Plan is a subscription gateway. The same /coding/v1 prefix serves
// OpenAI-compatible chat completions (/chat/completions) and Anthropic-compatible
// messages (/messages). models.dev has no entry for this gateway, so models are
// authored here; subscription plans expose no per-token cost.
export const CTYUN_BASE_URL = "https://ai.ctaigw.cn/coding/v1";

export const CTYUN_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
};

const MODELS: Model<"openai-completions">[] = [
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 524288,
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 262144,
	},
	{
		id: "glm-5.1",
		name: "GLM 5.1",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 131072,
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 131072,
	},
	{
		id: "deepseek-v4-flash-0731-new",
		name: "DeepSeek V4 Flash 0731 New",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	},
	{
		id: "deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro 0813",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	},
	{
		id: "ctyun-smart-router",
		name: "CTYUN Smart Router",
		api: "openai-completions",
		baseUrl: CTYUN_BASE_URL,
		provider: "ctyun-token-plan",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	},
];

export default defineProvider({
	id: "ctyun-token-plan",
	models: () => structuredClone(MODELS),
	compat: { "openai-completions": CTYUN_COMPLETIONS_COMPAT },
});
