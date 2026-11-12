import { NEON_AI_GATEWAY_BASE_URL } from "../../src/providers/neon-ai-gateway-stream.ts";
import type { Api, Model } from "../../src/types.ts";
import { type ChatModel, defineProvider, mergeCompat, modelsDevModels, type ProviderContext } from "../define.ts";
import { googleThinkingLevels } from "../families/google.ts";
import { enableOpenAiGrammarTools } from "../families/openai.ts";
import type { ModelsDevModel } from "../sources/models-dev.ts";

// Native protocols come before the unified Chat Completions endpoint, which every
// Neon chat model also lists.
const NEON_PROTOCOLS = ["messages", "responses", "generate-content", "chat-completions"] as const;

const NEON_APIS: Record<(typeof NEON_PROTOCOLS)[number], Api> = {
	messages: "anthropic-messages",
	responses: "openai-responses",
	"generate-content": "google-generative-ai",
	"chat-completions": "openai-completions",
};

/**
 * The API and branch-relative base URL for a model. models.dev writes the branch
 * host as `${NEON_AI_GATEWAY_BASE_URL}`; pi resolves `{NEON_AI_GATEWAY_BASE_URL}`
 * from provider env at request time.
 */
function neonApi(ctx: ProviderContext, source: ModelsDevModel): { api: Api; baseUrl: string } | undefined {
	for (const protocol of NEON_PROTOCOLS) {
		const entry = source.apis.find((candidate) => candidate.protocol === protocol);
		if (!entry) continue;
		const baseUrl = entry.baseUrl.replace(/^\$\{NEON_AI_GATEWAY_BASE_URL\}/, NEON_AI_GATEWAY_BASE_URL);
		// The Anthropic SDK appends /v1/messages itself.
		return { api: NEON_APIS[protocol], baseUrl: protocol === "messages" ? baseUrl.replace(/\/v1\/?$/, "") : baseUrl };
	}
	const message = `models.dev lists no supported API for ${ctx.providerId}/${source.id}`;
	if (ctx.strict) throw new Error(message);
	console.warn(`Skipping model: ${message}`);
	return undefined;
}

export default defineProvider({
	id: "neon-ai-gateway",
	models: (ctx) =>
		modelsDevModels(ctx, "neon", {
			api: "openai-completions",
			// Replaced by the base URL of the API models.dev lists for each model.
			baseUrl: "",
			map: (model, source): ChatModel | undefined => {
				const served = neonApi(ctx, source);
				if (!served) return undefined;
				const thinkingLevelMap =
					served.api === "google-generative-ai"
						? googleThinkingLevels(model.id, source.reasoningOptions)
						: undefined;
				return { ...model, ...served, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
			},
		}),
	compat: {
		"openai-completions": { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
	},
	finalize: (model) => {
		if (model.api === "openai-responses") {
			mergeCompat(model as Model<"openai-responses">, { supportsStrictMode: true });
		}
		enableOpenAiGrammarTools(model);
	},
});
