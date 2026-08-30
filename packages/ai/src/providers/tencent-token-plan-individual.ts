import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TENCENT_TOKEN_PLAN_INDIVIDUAL_MODELS } from "./tencent-token-plan-individual.models.ts";

export function tencentTokenPlanIndividualProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "tencent-token-plan-individual",
		name: "Tencent Token Plan Individual",
		baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
		auth: { apiKey: envApiKeyAuth("Tencent Token Plan Individual API key", ["TENCENT_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(TENCENT_TOKEN_PLAN_INDIVIDUAL_MODELS),
		api: openAICompletionsApi(),
	});
}
