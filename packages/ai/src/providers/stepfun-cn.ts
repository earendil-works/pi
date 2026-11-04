import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { STEPFUN_CN_MODELS } from "./stepfun-cn.models.ts";

export function stepfunCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "stepfun-cn",
		name: "StepFun CN",
		baseUrl: "https://api.stepfun.com/v1",
		auth: { apiKey: envApiKeyAuth("StepFun CN API key", ["STEPFUN_CN_API_KEY"]) },
		models: Object.values(STEPFUN_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
