import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_API_MODELS } from "./zai-api.models.ts";

export function zaiApiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai-api",
		name: "Z.AI API",
		baseUrl: "https://api.z.ai/api/paas/v4",
		auth: { apiKey: envApiKeyAuth("Z.AI API API key", ["ZAI_PAYG_API_KEY"]) },
		models: Object.values(ZAI_API_MODELS),
		api: openAICompletionsApi(),
	});
}
