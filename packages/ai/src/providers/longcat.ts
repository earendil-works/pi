import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { LONGCAT_MODELS } from "./longcat.models.ts";

export function longcatProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "longcat",
		name: "LongCat",
		baseUrl: "https://api.longcat.chat/openai/v1",
		auth: { apiKey: envApiKeyAuth("LongCat API key", ["LONGCAT_API_KEY"]) },
		models: Object.values(LONGCAT_MODELS),
		api: openAICompletionsApi(),
	});
}
