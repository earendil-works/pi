import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TENCENT_TOKENHUB_MODELS } from "./tencent-tokenhub.models.ts";

export function tencentTokenhubProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "tencent-tokenhub",
		name: "Tencent TokenHub",
		baseUrl: "https://tokenhub.tencentmaas.com/v1",
		auth: { apiKey: envApiKeyAuth("Tencent TokenHub API key", ["TENCENT_TOKENHUB_API_KEY"]) },
		models: Object.values(TENCENT_TOKENHUB_MODELS),
		api: openAICompletionsApi(),
	});
}
