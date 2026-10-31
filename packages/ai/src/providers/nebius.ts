import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NEBIUS_MODELS } from "./nebius.models.ts";

export function nebiusProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "nebius",
		name: "Nebius Token Factory",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		auth: { apiKey: envApiKeyAuth("Nebius Token Factory API key", ["NEBIUS_API_KEY"]) },
		models: Object.values(NEBIUS_MODELS),
		api: openAICompletionsApi(),
	});
}
