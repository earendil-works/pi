import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { STEPFUN_AI_STEP_PLAN_MODELS } from "./stepfun-ai-step-plan.models.ts";

export function stepfunAiStepPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "stepfun-ai-step-plan",
		name: "StepFun Step Plan (Global)",
		baseUrl: "https://api.stepfun.ai/step_plan/v1",
		auth: { apiKey: envApiKeyAuth("StepFun API key", ["STEPFUN_API_KEY"]) },
		models: Object.values(STEPFUN_AI_STEP_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
