// Moonshot Kimi models, shared by Moonshot, Kimi Coding, and gateways.

import type { ModelCost, OpenAICompletionsCompat } from "../../src/types.ts";

/**
 * Kimi K3 and its point releases (kimi-k3.1-pro, kimi-k3.1-pro-highspeed) share
 * K3's request format. https://api.moonshot.ai/v1/models reports effort levels
 * and dynamic tool loading for all of them.
 */
export function isKimiK3FamilyId(modelId: string): boolean {
	return /^kimi-k3(?:\.\d+)?(?:-|$)/.test(modelId);
}

export const KIMI_K3_MAX_TOKENS = 131072;
export const KIMI_K3_COST: ModelCost = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
};

// Kimi Chat Completions settings shared by Moonshot and Kimi Coding.
export const KIMI_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};

// Kimi K3-style models take reasoning_effort and need earlier reasoning sent back.
export const KIMI_K3_OPENAI_COMPAT: OpenAICompletionsCompat = {
	...KIMI_OPENAI_COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
	supportsReasoningEffort: true,
};
