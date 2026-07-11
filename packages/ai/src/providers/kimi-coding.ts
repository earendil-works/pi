import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { KIMI_CODING_MODELS } from "./kimi-coding.models.ts";

export function kimiCodingProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		auth: { apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]) },
		models: Object.values(KIMI_CODING_MODELS),
		api: anthropicMessagesApi(),
	});
}
