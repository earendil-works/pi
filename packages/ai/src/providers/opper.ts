import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPPER_MODELS } from "./opper.models.ts";

export function opperProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "opper",
		name: "Opper",
		baseUrl: "https://api.opper.ai/v3/compat",
		auth: { apiKey: envApiKeyAuth("Opper API key", ["OPPER_API_KEY"]) },
		models: Object.values(OPPER_MODELS),
		api: openAICompletionsApi(),
	});
}
