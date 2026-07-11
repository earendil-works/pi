import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "./azure-openai-responses.models.ts";

export function azureOpenAIResponsesProvider(): Provider<"azure-openai-responses"> {
	return createProvider({
		id: "azure-openai-responses",
		name: "Azure OpenAI",
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		models: Object.values(AZURE_OPENAI_RESPONSES_MODELS),
		api: azureOpenAIResponsesApi(),
	});
}
