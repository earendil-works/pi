import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MELIOUS_MODELS } from "./melious.models.ts";

export function meliousProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "melious",
		name: "Melious",
		baseUrl: "https://api.melious.ai/v1",
		auth: { apiKey: envApiKeyAuth("Melious API key", ["MELIOUS_API_KEY"]) },
		models: Object.values(MELIOUS_MODELS),
		api: openAICompletionsApi(),
	});
}
