import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLINE_PASS_MODELS } from "./cline-pass.models.ts";

export function clinePassProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cline-pass",
		name: "ClinePass",
		baseUrl: "https://api.cline.bot/api/v1",
		auth: { apiKey: envApiKeyAuth("Cline API key", ["CLINE_API_KEY"]) },
		models: Object.values(CLINE_PASS_MODELS),
		api: openAICompletionsApi(),
	});
}
