import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { UPSTAGE_MODELS } from "./upstage.models.ts";

export function upstageProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "upstage",
		name: "Upstage",
		baseUrl: "https://api.upstage.ai/v1",
		auth: { apiKey: envApiKeyAuth("Upstage API key", ["UPSTAGE_API_KEY"]) },
		models: Object.values(UPSTAGE_MODELS),
		api: openAICompletionsApi(),
	});
}
