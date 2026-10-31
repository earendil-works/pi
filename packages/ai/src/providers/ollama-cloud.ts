import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OLLAMA_CLOUD_MODELS } from "./ollama-cloud.models.ts";

export function ollamaCloudProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ollama-cloud",
		name: "Ollama Cloud",
		baseUrl: "https://ollama.com/v1",
		auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", ["OLLAMA_API_KEY"]) },
		models: Object.values(OLLAMA_CLOUD_MODELS),
		api: openAICompletionsApi(),
	});
}
