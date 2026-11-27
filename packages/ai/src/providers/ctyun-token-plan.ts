import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CTYUN_TOKEN_PLAN_MODELS } from "./ctyun-token-plan.models.ts";

export function ctyunTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ctyun-token-plan",
		name: "CTYUN Token Plan",
		baseUrl: "https://ai.ctaigw.cn/coding/v1",
		auth: {
			apiKey: envApiKeyAuth("CTYUN Token Plan API key", ["CTYUN_TOKEN_PLAN_API_KEY"]),
		},
		models: Object.values(CTYUN_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
