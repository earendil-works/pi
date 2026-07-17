import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { STEPFUN_STEP_PLAN_MODELS } from "./stepfun-step-plan.models.ts";

export function stepfunStepPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "stepfun-step-plan",
		name: "StepFun Step Plan (China)",
		baseUrl: "https://api.stepfun.com/step_plan/v1",
		auth: { apiKey: envApiKeyAuth("StepFun API key", ["STEPFUN_API_KEY"]) },
		models: Object.values(STEPFUN_STEP_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
