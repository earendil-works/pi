import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from "./qwen-token-plan-individual.models.ts";

export function qwenTokenPlanIndividualProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-individual",
		name: "Qwen Token Plan Individual",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan Individual API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS),
		api: openAICompletionsApi(),
	});
}
