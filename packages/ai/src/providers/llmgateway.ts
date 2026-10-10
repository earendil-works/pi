import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadLlmGatewayOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { LLMGATEWAY_MODELS } from "./llmgateway.models.ts";

export function llmgatewayProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "llmgateway",
		name: "LLM Gateway",
		baseUrl: "https://api.llmgateway.io/v1",
		auth: {
			apiKey: envApiKeyAuth("LLM Gateway API key", ["LLMGATEWAY_API_KEY"]),
			oauth: lazyOAuth({
				name: "LLMGateway OAuth",
				loginLabel: "Sign in with LLM Gateway",
				load: loadLlmGatewayOAuth,
			}),
		},
		models: Object.values(LLMGATEWAY_MODELS),
		api: openAICompletionsApi(),
	});
}
