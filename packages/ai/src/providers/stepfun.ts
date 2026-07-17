import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { STEPFUN_MODELS } from "./stepfun.models.ts";

export function stepfunProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "stepfun",
		name: "StepFun (China)",
		baseUrl: "https://api.stepfun.com/v1",
		auth: { apiKey: envApiKeyAuth("StepFun API key", ["STEPFUN_API_KEY"]) },
		models: Object.values(STEPFUN_MODELS),
		api: openAICompletionsApi(),
	});
}
