import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CORALBRICKS_MODELS } from "./coralbricks.models.ts";

export function coralbricksProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "coralbricks",
		name: "CoralBricks",
		baseUrl: "https://inference.coralbricks.ai/v1",
		auth: { apiKey: envApiKeyAuth("CoralBricks API key", ["CORALBRICKS_API_KEY"]) },
		models: Object.values(CORALBRICKS_MODELS),
		api: openAICompletionsApi(),
	});
}
