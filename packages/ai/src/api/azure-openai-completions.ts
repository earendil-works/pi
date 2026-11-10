import type { ProviderStreams, StreamOptions } from "../types.ts";
import { isAzureEntraIdAuth } from "./azure-openai-auth-constants.ts";
import { createAzureEntraIdFetch } from "./azure-openai-entra-auth.ts";
import { openAICompletionsApi } from "./openai-completions.lazy.ts";

const streams = openAICompletionsApi();

function withEntraIdFetch<T extends StreamOptions>(options: T | undefined): T | undefined {
	if (!options || !isAzureEntraIdAuth(options.apiKey)) return options;
	return { ...options, fetch: createAzureEntraIdFetch(options.fetch) } as T;
}

export const stream: ProviderStreams["stream"] = (model, context, options) =>
	streams.stream(model, context, withEntraIdFetch(options));

export const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
	streams.streamSimple(model, context, withEntraIdFetch(options));
