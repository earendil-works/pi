import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_AGENT_PLAN_CN_MODELS } from "./ark-agent-plan-cn.models.ts";

export function arkAgentPlanCnProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "ark-agent-plan-cn",
		name: "Volcengine Ark Agent Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
		auth: { apiKey: envApiKeyAuth("Volcengine Ark Agent Plan API key", ["ARK_AGENT_PLAN_CN_API_KEY"]) },
		models: Object.values(ARK_AGENT_PLAN_CN_MODELS),
		api: openAIResponsesApi(),
	});
}
