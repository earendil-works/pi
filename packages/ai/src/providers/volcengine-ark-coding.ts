import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VOLCENGINE_ARK_CODING_MODELS } from "./volcengine-ark-coding.models.ts";

export function volcengineArkCodingProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "volcengine-ark-coding",
		name: "Volcengine Ark Coding Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		auth: { apiKey: envApiKeyAuth("Volcengine Ark Coding Plan API key", ["VOLCENGINE_ARK_CODING_API_KEY"]) },
		models: Object.values(VOLCENGINE_ARK_CODING_MODELS),
		api: openAICompletionsApi(),
	});
}
