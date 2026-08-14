import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_CODING_PLAN_MODELS } from "./ark-coding-plan.models.ts";

export function arkCodingPlanProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "ark-coding-plan",
		name: "BytePlus Ark Coding Plan",
		baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
		auth: { apiKey: envApiKeyAuth("BytePlus Ark Coding Plan API key", ["ARK_CODING_PLAN_API_KEY"]) },
		models: Object.values(ARK_CODING_PLAN_MODELS),
		api: openAIResponsesApi(),
	});
}
