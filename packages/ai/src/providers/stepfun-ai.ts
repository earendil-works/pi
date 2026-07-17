import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { STEPFUN_AI_MODELS } from "./stepfun-ai.models.ts";

export function stepfunAiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "stepfun-ai",
		name: "StepFun (Global)",
		baseUrl: "https://api.stepfun.ai/v1",
		auth: { apiKey: envApiKeyAuth("StepFun API key", ["STEPFUN_API_KEY"]) },
		models: Object.values(STEPFUN_AI_MODELS),
		api: openAICompletionsApi(),
	});
}
