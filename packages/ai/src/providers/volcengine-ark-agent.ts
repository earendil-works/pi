import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VOLCENGINE_ARK_AGENT_MODELS } from "./volcengine-ark-agent.models.ts";

export function volcengineArkAgentProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "volcengine-ark-agent",
		name: "Volcengine Ark Agent Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
		auth: { apiKey: envApiKeyAuth("Volcengine Ark Agent Plan API key", ["VOLCENGINE_ARK_AGENT_API_KEY"]) },
		models: Object.values(VOLCENGINE_ARK_AGENT_MODELS),
		api: openAICompletionsApi(),
	});
}
