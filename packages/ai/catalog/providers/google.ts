import { defineProvider, modelsDevModels, withInputLimits } from "../define.ts";
import { googleThinkingLevels } from "../families/google.ts";
import { modelsDevChatModels, modelsDevCost } from "../sources/models-dev.ts";

// Rolling aliases take their metadata from the model they currently point to.
export const GOOGLE_ALIAS_TARGETS: Record<string, string> = {
	"gemini-flash-latest": "gemini-3.5-flash",
	"gemini-flash-lite-latest": "gemini-3.1-flash-lite",
};

// models.dev copies AI Studio's outputTokenLimit (32768) for these, but one request decodes up to
// 65536 output tokens (live, 2026-11-13: MAX_TOKENS at 65536, CONTINUATION above it).
const MEASURED_MAX_TOKENS: Record<string, number> = {
	"gemini-4-argon": 65536,
	"gemini-4-carbon": 65536,
};

export default defineProvider({
	id: "google",
	models: (ctx) => {
		const sources = new Map(modelsDevChatModels(ctx.sources.modelsDev, "google").map((model) => [model.id, model]));
		return modelsDevModels(ctx, "google", {
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			recordReasoning: false,
			map: (model, aliasSource) => {
				const target = GOOGLE_ALIAS_TARGETS[model.id];
				const source = (target && sources.get(target)) || aliasSource;
				const thinkingLevelMap = googleThinkingLevels(model.id, source.reasoningOptions);
				return {
					...model,
					reasoning: source.reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: source.imageInput ? ["text", "image"] : ["text"],
					cost: modelsDevCost(source.cost),
					contextWindow: source.contextWindow || 4096,
					maxTokens: MEASURED_MAX_TOKENS[model.id] ?? (source.maxTokens || 4096),
				};
			},
		});
	},
	finalize: (model) => withInputLimits(model, { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }),
});
