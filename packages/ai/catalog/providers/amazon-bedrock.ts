import type { Model } from "../../src/types.ts";
import { addMissing, type ChatModel, defineProvider, modelsDevModels, withInputLimits } from "../define.ts";
import type { ModelsDevModel } from "../sources/models-dev.ts";

// Opus 5 is only callable through cross-region inference profiles.
const INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);

function bedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

/**
 * Models Bedrock serves only on Mantle, its OpenAI-compatible endpoint, are
 * rejected by Converse as invalid model identifiers. They use the Responses API
 * at the Mantle URL models.dev lists, with `{region}` filled in per request.
 */
function mantleModel(model: ChatModel, source: ModelsDevModel): Model<"openai-responses"> | undefined {
	const responses = source.apis.find((api) => api.protocol === "responses");
	if (!responses) return undefined;
	return {
		...model,
		api: "openai-responses",
		// models.dev writes the region as a `${AWS_REGION}` template.
		baseUrl: responses.baseUrl.replace(/\$\{AWS_REGION\}/, "{region}"),
		compat: {
			// Mantle does not document OpenAI's extended prompt cache retention.
			supportsLongCacheRetention: false,
			...(source.structuredOutput ? { supportsStrictMode: true } : {}),
		},
	};
}

/**
 * Mantle-only models on AWS's model cards that models.dev does not list yet.
 * Prices and limits come from the model cards:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
 */
const MANTLE_MODELS_MISSING_UPSTREAM: Model<"openai-responses">[] = [
	{
		id: "openai.gpt-5.6-cyber",
		name: "Daybreak Red: GPT-5.6 Cyber",
		cost: { input: 13.75, output: 82.5, cacheRead: 1.375, cacheWrite: 17.1875 },
		contextWindow: 272_000,
	},
	{
		id: "openai.gpt-daybreak-blue-5.6-sol",
		name: "Daybreak Blue: GPT-5.6 Sol",
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.875 },
		contextWindow: 1_000_000,
	},
].map((model) => ({
	...model,
	api: "openai-responses",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text", "image"],
	maxTokens: 128_000,
	compat: { supportsLongCacheRetention: false, supportsStrictMode: true },
}));

export default defineProvider({
	id: "amazon-bedrock",
	models: (ctx) => {
		const models = modelsDevModels(ctx, "amazon-bedrock", {
			api: "bedrock-converse-stream",
			baseUrl: "",
			include: (source) =>
				!INFERENCE_PROFILE_ONLY_MODEL_IDS.has(source.id) &&
				// Jamba does not support tool use in streaming mode.
				!source.id.startsWith("ai21.jamba") &&
				// Mistral 7B Instruct does not support system messages.
				!source.id.startsWith("mistral.mistral-7b-instruct-v0"),
			// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models (#10326).
			map: (model, source) => {
				if (!source.apis.some((api) => api.protocol === "converse")) return mantleModel(model, source);
				return {
					...model,
					baseUrl: bedrockBaseUrl(model.id),
					...(source.structuredOutput ? { compat: { supportsStrictMode: true } } : {}),
				};
			},
		});
		return addMissing(models, MANTLE_MODELS_MISSING_UPSTREAM);
	},
	finalize: (model) => withInputLimits(model, { images: { maxPerMessage: 20 } }),
});
