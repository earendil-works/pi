import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TENCENT_TOKEN_PLAN_MODELS } from "./tencent-token-plan.models.ts";

export function tencentTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "tencent-token-plan",
		name: "Tencent Token Plan",
		baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
		auth: { apiKey: envApiKeyAuth("Tencent Token Plan API key", ["TENCENT_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(TENCENT_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
