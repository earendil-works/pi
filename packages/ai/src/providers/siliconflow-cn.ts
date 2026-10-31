import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SILICONFLOW_CN_MODELS } from "./siliconflow-cn.models.ts";

export function siliconflowCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "siliconflow-cn",
		name: "SiliconFlow CN",
		baseUrl: "https://api.siliconflow.cn/v1",
		auth: { apiKey: envApiKeyAuth("SiliconFlow CN API key", ["SILICONFLOW_CN_API_KEY"]) },
		models: Object.values(SILICONFLOW_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
