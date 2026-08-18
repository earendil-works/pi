import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { SimpleStreamOptions, StreamFunction } from "./types.ts";

const anthropicMessagesStreams = anthropicMessagesApi();
const azureOpenAIResponsesStreams = azureOpenAIResponsesApi();
const googleGenerativeAIStreams = googleGenerativeAIApi();
const googleVertexStreams = googleVertexApi();
const mistralConversationsStreams = mistralConversationsApi();
const openAICodexResponsesStreams = openAICodexResponsesApi();
const openAICompletionsStreams = openAICompletionsApi();
const openAIResponsesStreams = openAIResponsesApi();

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/anthropic-messages` or `anthropicMessagesApi().stream`. */
export const streamAnthropic = anthropicMessagesStreams.stream as StreamFunction<
	"anthropic-messages",
	AnthropicOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/anthropic-messages` or `anthropicMessagesApi().streamSimple`. */
export const streamSimpleAnthropic = anthropicMessagesStreams.streamSimple as StreamFunction<
	"anthropic-messages",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/azure-openai-responses` or `azureOpenAIResponsesApi().stream`. */
export const streamAzureOpenAIResponses = azureOpenAIResponsesStreams.stream as StreamFunction<
	"azure-openai-responses",
	AzureOpenAIResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/azure-openai-responses` or `azureOpenAIResponsesApi().streamSimple`. */
export const streamSimpleAzureOpenAIResponses = azureOpenAIResponsesStreams.streamSimple as StreamFunction<
	"azure-openai-responses",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/google-generative-ai` or `googleGenerativeAIApi().stream`. */
export const streamGoogle = googleGenerativeAIStreams.stream as StreamFunction<"google-generative-ai", GoogleOptions>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/google-generative-ai` or `googleGenerativeAIApi().streamSimple`. */
export const streamSimpleGoogle = googleGenerativeAIStreams.streamSimple as StreamFunction<
	"google-generative-ai",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/google-vertex` or `googleVertexApi().stream`. */
export const streamGoogleVertex = googleVertexStreams.stream as StreamFunction<"google-vertex", GoogleVertexOptions>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/google-vertex` or `googleVertexApi().streamSimple`. */
export const streamSimpleGoogleVertex = googleVertexStreams.streamSimple as StreamFunction<
	"google-vertex",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/mistral-conversations` or `mistralConversationsApi().stream`. */
export const streamMistral = mistralConversationsStreams.stream as StreamFunction<
	"mistral-conversations",
	MistralOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/mistral-conversations` or `mistralConversationsApi().streamSimple`. */
export const streamSimpleMistral = mistralConversationsStreams.streamSimple as StreamFunction<
	"mistral-conversations",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-codex-responses` or `openAICodexResponsesApi().stream`. */
export const streamOpenAICodexResponses = openAICodexResponsesStreams.stream as StreamFunction<
	"openai-codex-responses",
	OpenAICodexResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-codex-responses` or `openAICodexResponsesApi().streamSimple`. */
export const streamSimpleOpenAICodexResponses = openAICodexResponsesStreams.streamSimple as StreamFunction<
	"openai-codex-responses",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-completions` or `openAICompletionsApi().stream`. */
export const streamOpenAICompletions = openAICompletionsStreams.stream as StreamFunction<
	"openai-completions",
	OpenAICompletionsOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-completions` or `openAICompletionsApi().streamSimple`. */
export const streamSimpleOpenAICompletions = openAICompletionsStreams.streamSimple as StreamFunction<
	"openai-completions",
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-responses` or `openAIResponsesApi().stream`. */
export const streamOpenAIResponses = openAIResponsesStreams.stream as StreamFunction<
	"openai-responses",
	OpenAIResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-responses` or `openAIResponsesApi().streamSimple`. */
export const streamSimpleOpenAIResponses = openAIResponsesStreams.streamSimple as StreamFunction<
	"openai-responses",
	SimpleStreamOptions
>;
