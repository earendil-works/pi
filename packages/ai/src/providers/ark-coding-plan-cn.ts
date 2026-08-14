import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_CODING_PLAN_CN_MODELS } from "./ark-coding-plan-cn.models.ts";

export function arkCodingPlanCnProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "ark-coding-plan-cn",
		name: "Volcengine Ark Coding Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		auth: { apiKey: envApiKeyAuth("Volcengine Ark Coding Plan API key", ["ARK_CODING_PLAN_CN_API_KEY"]) },
		models: Object.values(ARK_CODING_PLAN_CN_MODELS),
		api: openAIResponsesApi(),
	});
}
