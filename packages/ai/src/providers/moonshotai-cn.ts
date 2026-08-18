import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_CN_MODELS } from "./moonshotai-cn.models.ts";

export function moonshotaiCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshotai-cn",
		name: "Moonshot AI CN",
		baseUrl: "https://api.moonshot.cn/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOTAI_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
