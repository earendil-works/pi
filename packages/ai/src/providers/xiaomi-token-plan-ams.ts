import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from "./xiaomi-token-plan-ams.models.ts";

export function xiaomiTokenPlanAmsProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xiaomi-token-plan-ams",
		name: "Xiaomi Token Plan AMS",
		baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		auth: { apiKey: envApiKeyAuth("Xiaomi Token Plan AMS API key", ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]) },
		models: Object.values(XIAOMI_TOKEN_PLAN_AMS_MODELS),
		api: openAICompletionsApi(),
	});
}
