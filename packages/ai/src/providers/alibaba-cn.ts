import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ALIBABA_CN_MODELS } from "./alibaba-cn.models.ts";

export function alibabaCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "alibaba-cn",
		name: "Alibaba Cloud Model Studio CN",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Alibaba Cloud Model Studio CN API key", ["DASHSCOPE_CN_API_KEY"]) },
		models: Object.values(ALIBABA_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
