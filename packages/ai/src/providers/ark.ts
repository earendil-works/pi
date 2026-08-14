import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_MODELS } from "./ark.models.ts";

export function arkProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "ark",
		name: "BytePlus Ark",
		baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
		auth: { apiKey: envApiKeyAuth("BytePlus Ark API key", ["ARK_API_KEY"]) },
		models: Object.values(ARK_MODELS),
		api: openAIResponsesApi(),
	});
}
