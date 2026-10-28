import { defineProvider, modelsDevModels, withInputLimits } from "../define.ts";
import { googleThinkingLevels } from "../families/google.ts";
import { modelsDevChatModels, modelsDevCost } from "../sources/models-dev.ts";

// Rolling aliases take their metadata from the model they currently point to.
export const GOOGLE_ALIAS_TARGETS: Record<string, string> = {
	"gemini-flash-latest": "gemini-3.5-flash",
	"gemini-flash-lite-latest": "gemini-3.1-flash-lite",
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
					maxTokens: source.maxTokens || 4096,
				};
			},
		});
	},
	finalize: (model) => withInputLimits(model, { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }),
});
