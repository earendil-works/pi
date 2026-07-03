import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GLM_MODELS } from "./glm.models.ts";

export function glmProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "glm",
		name: "GLM API",
		baseUrl: "https://api.z.ai/api/paas/v4",
		auth: { apiKey: envApiKeyAuth("GLM API key", ["ZAI_API_KEY"]) },
		models: Object.values(GLM_MODELS),
		api: openAICompletionsApi(),
	});
}
