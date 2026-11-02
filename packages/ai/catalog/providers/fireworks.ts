import type { AnthropicMessagesCompat, Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, mergeCompat, mergeThinking, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Fireworks Anthropic-compatible API. Prompt caching uses automatic prefix
// matching and session affinity: x-session-affinity routes requests to the same
// replica for cache hits. cache_control on tools and eager_input_streaming are
// not supported.
// https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
const ANTHROPIC_COMPAT: AnthropicMessagesCompat = {
	allowEmptySignature: true,
	sendSessionAffinityHeaders: true,
	supportsEagerToolInputStreaming: false,
	supportsCacheControlOnTools: false,
	supportsLongCacheRetention: false,
};
const OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	sendSessionAffinityHeaders: true,
	supportsLongCacheRetention: false,
};
const KIMI_K3_COMPAT: OpenAICompletionsCompat = {
	...OPENAI_COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
};

// Verified against Fireworks Messages raw_output on 2026-09-10 (#9323).
// Fall back to verified support when models.dev omits effort metadata; this is
// not an allowlist. Any Fireworks Messages model advertising effort uses adaptive thinking.
const ADAPTIVE_THINKING_FALLBACK_MODELS = new Set([
	"accounts/fireworks/models/deepseek-v4-flash-0731",
	"accounts/fireworks/models/deepseek-v4-flash-vision-exp",
	"accounts/fireworks/models/deepseek-v4-pro-0813",
	"accounts/fireworks/models/qwen3p8-max",
	"accounts/fireworks/models/qwen3p8-2p4t-a95b",
]);

export default defineProvider({
	id: "fireworks",
	models: (ctx) =>
		modelsDevModels(ctx, "fireworks-ai", {
			api: "anthropic-messages",
			// SDK appends /v1/messages.
			baseUrl: "https://api.fireworks.ai/inference",
			map: (model, source) => {
				if (model.id.includes("glm-") || model.id.includes("kimi-k3")) {
					return {
						...model,
						api: "openai-completions",
						baseUrl: "https://api.fireworks.ai/inference/v1",
						compat: model.id.includes("kimi-k3") ? KIMI_K3_COMPAT : OPENAI_COMPAT,
					};
				}
				// Use adaptive thinking for cataloged effort controls, with verified
				// fallbacks where models.dev is incomplete. New models need no allowlist entry.
				const adaptive =
					source.reasoningOptions?.some((option) => option.type === "effort") ||
					ADAPTIVE_THINKING_FALLBACK_MODELS.has(model.id);
				return { ...model, compat: { ...ANTHROPIC_COMPAT, ...(adaptive ? { forceAdaptiveThinking: true } : {}) } };
			},
		}),
	compat: { "openai-completions": { supportsStrictMode: true } },
	finalize: (model, ctx) => {
		if (model.api === "anthropic-messages" && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking) {
			// Qwen Max currently advertises only a toggle. Prefer upstream effort
			// metadata once available instead of replacing it with this fallback.
			if (model.id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap) {
				model.thinkingLevelMap = getEffortThinkingLevelMap([
					{ type: "effort", values: ["low", "medium", "xhigh"] },
				]);
			}
			if (
				ctx.modelsDevSource(model)?.reasoningOptions?.some((option) => option.type === "toggle") ||
				// The 2.4T alias omits the verified toggle in models.dev.
				model.id === "accounts/fireworks/models/qwen3p8-2p4t-a95b"
			) {
				mergeThinking(model, { off: "none" });
			}
			if (model.id === "accounts/fireworks/models/deepseek-v4-pro-0813") mergeThinking(model, { low: "low" });
		}
		if (model.id.includes("glm-5p2")) {
			// GLM 5.2 and its fast router support off/high/max. Fireworks maps low
			// and medium to high, so do not expose those aliases as distinct levels.
			mergeThinking(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		}
		if (model.id.includes("kimi-k3")) {
			// Fireworks maps medium to high on both APIs; do not expose it as a distinct level.
			mergeThinking(model, { medium: null });
			// Kimi K3 accepts tool-bearing system messages; Fireworks passes them through.
			if (model.api === "openai-completions") {
				mergeCompat(model as Model<"openai-completions">, {
					supportsMidConvoSystemMessages: true,
					supportsMidConvoToolAdditions: true,
				});
			}
		}
	},
});
