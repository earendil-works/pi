import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GMI_MODELS } from "./gmi.models.ts";

export function gmiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "gmi",
		name: "GMI Cloud",
		baseUrl: "https://api.gmi-serving.com/v1",
		// Keep this list in sync with getApiKeyEnvVars("gmi") in ../env-api-keys.ts.
		auth: { apiKey: envApiKeyAuth("GMI Cloud API key", ["GMI_API_KEY", "GMICLOUD_API_KEY"]) },
		models: Object.values(GMI_MODELS),
		api: openAICompletionsApi(),
	});
}
