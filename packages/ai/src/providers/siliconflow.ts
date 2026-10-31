import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SILICONFLOW_MODELS } from "./siliconflow.models.ts";

export function siliconflowProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "siliconflow",
		name: "SiliconFlow",
		baseUrl: "https://api.siliconflow.com/v1",
		auth: { apiKey: envApiKeyAuth("SiliconFlow API key", ["SILICONFLOW_API_KEY"]) },
		models: Object.values(SILICONFLOW_MODELS),
		api: openAICompletionsApi(),
	});
}
