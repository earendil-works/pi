import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_INDIVIDUAL_CN_MODELS } from "./qwen-token-plan-individual-cn.models.ts";

export function qwenTokenPlanIndividualCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-individual-cn",
		name: "Qwen Token Plan Individual CN",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan Individual CN API key", ["QWEN_TOKEN_PLAN_CN_API_KEY"]) },
		models: Object.values(QWEN_TOKEN_PLAN_INDIVIDUAL_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
