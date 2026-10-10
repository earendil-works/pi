import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadLlmGatewayDevpassOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { LLMGATEWAY_DEVPASS_MODELS } from "./llmgateway-devpass.models.ts";

/**
 * LLM Gateway's DevPass coding subscription. Same endpoint and request shape as
 * the pay-as-you-go `llmgateway` provider; the difference is the account behind
 * the key. Keys minted for DevPass bill the flat-rate subscription instead of
 * credits, and the gateway rejects models a coding plan does not cover with a
 * 403, so the catalog is narrowed to those models.
 */
export function llmgatewayDevpassProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "llmgateway-devpass",
		name: "LLM Gateway DevPass",
		baseUrl: "https://api.llmgateway.io/v1",
		auth: {
			apiKey: envApiKeyAuth("LLM Gateway DevPass API key", ["LLMGATEWAY_DEVPASS_API_KEY"]),
			oauth: lazyOAuth({
				name: "LLMGateway DevPass OAuth",
				loginLabel: "Sign in with LLM Gateway DevPass",
				load: loadLlmGatewayDevpassOAuth,
			}),
		},
		models: Object.values(LLMGATEWAY_DEVPASS_MODELS),
		api: openAICompletionsApi(),
	});
}
