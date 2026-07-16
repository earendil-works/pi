import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TELNYX_MODELS } from "./telnyx.models.ts";

export function telnyxProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "telnyx",
		name: "Telnyx",
		baseUrl: "https://api.telnyx.com/v2/ai",
		auth: { apiKey: envApiKeyAuth("Telnyx API key", ["TELNYX_API_KEY"]) },
		models: Object.values(TELNYX_MODELS),
		api: openAICompletionsApi(),
	});
}
