import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SCALEWAY_MODELS } from "./scaleway.models.ts";

export function scalewayProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "scaleway",
		name: "Scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		auth: { apiKey: envApiKeyAuth("Scaleway API key", ["SCALEWAY_API_KEY"]) },
		models: Object.values(SCALEWAY_MODELS),
		api: openAICompletionsApi(),
	});
}
