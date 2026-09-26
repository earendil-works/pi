import { resolveAzureBaseUrl } from "../api/azure-openai-config.ts";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../types.ts";
import { AZURE_MODELS } from "./azure.models.ts";

function resolveAzureModel(model: Model<Api>, options: StreamOptions | undefined): Model<Api> {
	return { ...model, baseUrl: resolveAzureBaseUrl(model, options) };
}

/**
 * Resolve the Azure endpoint onto the model before dispatch, inside `lazyStream` so an
 * unconfigured endpoint errors on the stream instead of throwing out of `stream()`.
 */
function azureStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () => streams.stream(resolveAzureModel(model, options), context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => streams.streamSimple(resolveAzureModel(model, options), context, options)),
	};
}

export function azureProvider(): Provider<"azure-openai-responses" | "openai-completions"> {
	return createProvider({
		id: "azure",
		name: "Azure",
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		models: Object.values(AZURE_MODELS),
		api: {
			"azure-openai-responses": azureOpenAIResponsesApi(),
			"openai-completions": azureStreams(openAICompletionsApi()),
		},
	});
}
