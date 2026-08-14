import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_CN_MODELS } from "./ark-cn.models.ts";

export function arkCnProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "ark-cn",
		name: "Volcengine Ark",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		auth: { apiKey: envApiKeyAuth("Volcengine Ark API key", ["ARK_CN_API_KEY"]) },
		models: Object.values(ARK_CN_MODELS),
		api: openAIResponsesApi(),
	});
}
