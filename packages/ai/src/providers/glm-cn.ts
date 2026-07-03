import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GLM_CN_MODELS } from "./glm-cn.models.ts";

export function glmCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "glm-cn",
		name: "GLM API (China)",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		auth: { apiKey: envApiKeyAuth("GLM API key", ["ZAI_API_KEY"]) },
		models: Object.values(GLM_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
