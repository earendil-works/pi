import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FRIENDLI_MODELS } from "./friendli.models.ts";

export function friendliProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "friendli",
		name: "Friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		auth: { apiKey: envApiKeyAuth("Friendli API key", ["FRIENDLI_API_KEY"]) },
		models: Object.values(FRIENDLI_MODELS),
		api: openAICompletionsApi(),
	});
}
