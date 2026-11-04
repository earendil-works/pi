import { defineProvider, modelsDevModels } from "../define.ts";
import { googleThinkingLevels } from "../families/google.ts";
import { modelsDevChatModels } from "../sources/models-dev.ts";
import { GOOGLE_ALIAS_TARGETS } from "./google.ts";

const BASE_URL = "https://{location}-aiplatform.googleapis.com";

export default defineProvider({
	id: "google-vertex",
	models: (ctx) => {
		const sources = new Map(
			modelsDevChatModels(ctx.sources.modelsDev, "google-vertex").map((model) => [model.id, model]),
		);
		const gemini = modelsDevModels(ctx, "google-vertex", {
			api: "google-vertex",
			baseUrl: BASE_URL,
			recordReasoning: false,
			// The models.dev catalog also includes Claude, OpenAI, and other MaaS models
			// that do not use the @google/genai Gemini streaming path. Claude is added
			// below; the other partner models are not supported yet.
			include: (source) => source.id.startsWith("gemini-") && source.id !== "gemini-3.1-flash-lite-preview",
			map: (model, aliasSource) => {
				const target = GOOGLE_ALIAS_TARGETS[model.id];
				const source = (target && sources.get(target)) || aliasSource;
				const thinkingLevelMap = googleThinkingLevels(model.id, source.reasoningOptions);
				return {
					...model,
					reasoning: source.reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: source.imageInput ? ["text", "image"] : ["text"],
					cost: {
						input: source.cost.input || 0,
						output: source.cost.output || 0,
						// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
						// do not match the official Gemini API standard pricing table. pi only accounts
						// cachedContentTokenCount as cacheRead.
						cacheRead: model.id === "gemini-2.5-flash" ? 0.03 : source.cost.cacheRead || 0,
						cacheWrite: 0,
					},
					contextWindow: source.contextWindow || 4096,
					maxTokens: source.maxTokens || 4096,
				};
			},
		});
		// Claude through Anthropic's Messages API on Vertex (`rawPredict` endpoints).
		const claude = modelsDevModels(ctx, "google-vertex", {
			api: "anthropic-messages",
			baseUrl: BASE_URL,
			skipDeprecated: true,
			protocol: "messages",
		});
		return [...gemini, ...claude];
	},
});
