import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPINFRA_MODELS } from "./deepinfra.models.ts";

export function deepinfraProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "deepinfra",
		name: "DeepInfra",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		auth: { apiKey: envApiKeyAuth("DeepInfra API key", ["DEEPINFRA_API_KEY"]) },
		models: Object.values(DEEPINFRA_MODELS),
		api: openAICompletionsApi(),
	});
}
