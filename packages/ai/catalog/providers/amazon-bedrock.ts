import { defineProvider, modelsDevModels, withInputLimits } from "../define.ts";

// Opus 5 is only callable through cross-region inference profiles.
const INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);

function bedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

export default defineProvider({
	id: "amazon-bedrock",
	models: (ctx) =>
		modelsDevModels(ctx, "amazon-bedrock", {
			api: "bedrock-converse-stream",
			baseUrl: "",
			include: (source) =>
				!INFERENCE_PROFILE_ONLY_MODEL_IDS.has(source.id) &&
				// Jamba does not support tool use in streaming mode.
				!source.id.startsWith("ai21.jamba") &&
				// Mistral 7B Instruct does not support system messages.
				!source.id.startsWith("mistral.mistral-7b-instruct-v0"),
			// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models (#10326).
			map: (model, source) => ({
				...model,
				baseUrl: bedrockBaseUrl(model.id),
				...(source.structuredOutput ? { compat: { supportsStrictMode: true } } : {}),
			}),
		}),
	finalize: (model) => withInputLimits(model, { images: { maxPerMessage: 20 } }),
});
