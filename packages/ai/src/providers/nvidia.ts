import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NVIDIA_MODELS } from "./nvidia.models.ts";

export function nvidiaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "nvidia",
		name: "NVIDIA",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		auth: { apiKey: envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"]) },
		models: Object.values(NVIDIA_MODELS),
		api: openAICompletionsApi(),
	});
}
