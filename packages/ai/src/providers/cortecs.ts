import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CORTECS_MODELS } from "./cortecs.models.ts";

export function cortecsProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "cortecs",
		name: "Cortecs",
		baseUrl: "https://api.cortecs.ai/v1",
		auth: { apiKey: envApiKeyAuth("Cortecs API key", ["CORTECS_API_KEY"]) },
		models: Object.values(CORTECS_MODELS),
		api: openAIResponsesApi(),
	});
}
