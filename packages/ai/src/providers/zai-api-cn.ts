import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_API_CN_MODELS } from "./zai-api-cn.models.ts";

export function zaiApiCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai-api-cn",
		name: "Z.AI API CN",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		auth: { apiKey: envApiKeyAuth("Z.AI API CN API key", ["ZAI_PAYG_CN_API_KEY"]) },
		models: Object.values(ZAI_API_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
