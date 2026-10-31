import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ALIBABA_MODELS } from "./alibaba.models.ts";

export function alibabaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "alibaba",
		name: "Alibaba Cloud Model Studio",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Alibaba Cloud Model Studio API key", ["DASHSCOPE_API_KEY"]) },
		models: Object.values(ALIBABA_MODELS),
		api: openAICompletionsApi(),
	});
}
