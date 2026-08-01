import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLINE_MODELS } from "./cline.models.ts";

export function clineProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cline",
		name: "Cline",
		baseUrl: "https://api.cline.bot/api/v1",
		auth: { apiKey: envApiKeyAuth("Cline API key", ["CLINE_API_KEY"]) },
		models: Object.values(CLINE_MODELS),
		api: openAICompletionsApi(),
	});
}
