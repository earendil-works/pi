import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

export type Api = KnownApi | (string & {});

export type KnownImagesApi = "openrouter-images";

export type ImagesApi = KnownImagesApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type KnownImagesProvider = "openrouter";

export type ImagesProviderId = KnownImagesProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			omitWhenOff?: boolean;
	  };

/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	env?: ProviderEnv;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe.
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports exactly `stream` and `streamSimple`, so the module
 * itself satisfies this interface. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and image
 * provider factories pass these around as values.
 */
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as endpoint placeholders and proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
	usage?: Usage;
	/**
	 * Names from `Context.tools` that became available after this result.
	 * Providers with native deferred tool loading use this as the load point;
	 * other providers ignore it and use `Context.tools` normally.
	 */
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

import type { TSchema } from "typebox";

/** OpenAI grammar variants for constrained sampling. */
export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * Optional provider-side constrained sampling configs for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs. Grammar variants let
 * callers provide provider-specific encodings of the same intended language.
 */
export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompletionsCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort when supported, "together" uses reasoning: { enabled } plus reasoning_effort when supported, "zai" uses thinking: { type }, "qwen" uses top-level enable_thinking: boolean, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking: string, and "ant-ling" uses reasoning: { effort } only when the mapped effort is non-null. Default: "openai". */
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	/** Kwargs to send as `chat_template_kwargs` when `thinkingFormat` is `chat-template`. Use `{ "$var": "thinking.enabled" }` or `{ "$var": "thinking.effort" }` for pi-controlled thinking values. */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** OpenRouter-compatible routing preferences sent as the `provider` request field. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
	zaiToolStream?: boolean;
	/** Whether the provider supports OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
	supportsOpenAIGrammarTools?: boolean;
	/** Whether the provider supports the `strict` field in tool definitions. Default: true. */
	supportsStrictMode?: boolean;
	/** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content. */
	cacheControlFormat?: "anthropic";
	/** Whether to send session-affinity data from `options.sessionId`. Default: false. */
	sendSessionAffinityHeaders?: boolean;
	/** Provider-specific deferred tool serialization mode. */
	deferredToolsMode?: "kimi";
	/** Session-affinity header format: `openai` sends `session_id`, `x-client-request-id`, and `x-session-affinity`; `openai-nosession` sends `x-client-request-id` and `x-session-affinity`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat {
	/** Whether the provider supports the `developer` role (vs `system`). Default: true. */
	supportsDeveloperRole?: boolean;
	/** Session-affinity header format: `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` sends `x-client-request-id`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
	supportsLongCacheRetention?: boolean;
	/** Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly. */
	supportsStrictMode?: boolean;
	/** Whether to emit OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
	supportsOpenAIGrammarTools?: boolean;
	/** Whether the model supports client-executed tool search for deferred tools. Default: false. */
	supportsToolSearch?: boolean;
	/** Whether the model accepts `prompt_cache_options` (OpenAI GPT-5.6+ explicit prompt caching). Older OpenAI models reject the parameter. Default: false. */
	supportsExplicitPromptCacheMode?: boolean;
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
	/**
	 * Whether the provider accepts per-tool `eager_input_streaming`.
	 * When false, the Anthropic provider omits `tools[].eager_input_streaming`
	 * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
	 * for tool-enabled requests.
	 * Default: true.
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether to send the `x-session-affinity` header from `options.sessionId`
	 * when caching is enabled. Required for providers like Fireworks that use
	 * session affinity for prompt cache routing (requests to the same replica
	 * maximize cache hits).
	 * Default: false.
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * Whether the provider supports Anthropic-style `cache_control` markers on
	 * tool definitions. When false, `cache_control` is omitted from tool params.
	 * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
	 * field on tools and may reject or ignore it.
	 * Default: true.
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * Whether the model accepts the Anthropic `temperature` request field.
	 * Claude Opus 4.7+ rejects non-default temperature values.
	 * Default: true.
	 */
	supportsTemperature?: boolean;
	/**
	 * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
	 * `output_config.effort`) regardless of the model id. Built-in models that
	 * require adaptive thinking set this in generated metadata. Custom
	 * Anthropic-compatible providers can set this to `true` for any model whose
	 * upstream requires the adaptive format. Set to `false` to
	 * opt out on overridden built-in models.
	 * Default: false.
	 */
	forceAdaptiveThinking?: boolean;
	/** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
	allowEmptySignature?: boolean;
	/** Whether the provider supports Anthropic strict tool schemas. Default: false; generated Anthropic models enable it explicitly. */
	supportsStrictTools?: boolean;
	/**
	 * Whether the provider supports deferred tools loaded by `tool_reference`
	 * blocks in tool results. Default: true for first-party Anthropic models
	 * except Haiku and models older than Claude 4.5; false for other providers.
	 */
	supportsToolReferences?: boolean;
}

/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat {
	/** Whether the model supports Bedrock strict tool schemas. Default: false. */
	supportsStrictMode?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * Sent as the `provider` field in the OpenRouter API request body.
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** Whether to allow backup providers to serve requests. Default: true. */
	allow_fallbacks?: boolean;
	/** Whether to filter providers to only those that support all parameters in the request. Default: false. */
	require_parameters?: boolean;
	/** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
	data_collection?: "deny" | "allow";
	/** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
	zdr?: boolean;
	/** Whether to restrict routing to only models that allow text distillation. */
	enforce_distillable_text?: boolean;
	/** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
	order?: string[];
	/** List of provider names/slugs to exclusively allow for this request. */
	only?: string[];
	/** List of provider names/slugs to skip for this request. */
	ignore?: string[];
	/** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
	quantizations?: string[];
	/** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
	sort?:
		| string
		| {
				/** The sorting metric: "price", "throughput", "latency". */
				by?: string;
				/** Partitioning strategy: "model" (default) or "none". */
				partition?: string | null;
		  };
	/** Maximum price per million tokens (USD). */
	max_price?: {
		/** Price per million prompt tokens. */
		prompt?: number | string;
		/** Price per million completion tokens. */
		completion?: number | string;
		/** Price per image. */
		image?: number | string;
		/** Price per audio unit. */
		audio?: number | string;
		/** Price per request. */
		request?: number | string;
	};
	/** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_min_throughput?:
		| number
		| {
				/** Minimum tokens/second at the 50th percentile. */
				p50?: number;
				/** Minimum tokens/second at the 75th percentile. */
				p75?: number;
				/** Minimum tokens/second at the 90th percentile. */
				p90?: number;
				/** Minimum tokens/second at the 99th percentile. */
				p99?: number;
		  };
	/** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_max_latency?:
		| number
		| {
				/** Maximum latency in seconds at the 50th percentile. */
				p50?: number;
				/** Maximum latency in seconds at the 75th percentile. */
				p75?: number;
				/** Maximum latency in seconds at the 90th percentile. */
				p90?: number;
				/** Maximum latency in seconds at the 99th percentile. */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

export interface ModelCostRates {
	input: number; // $/million tokens
	output: number; // $/million tokens
	cacheRead: number; // $/million tokens
	cacheWrite: number; // $/million tokens
}

export interface ModelCostTier extends ModelCostRates {
	/** Use this tier for requests whose total input usage exceeds this token count. */
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	/** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
	tiers?: ModelCostTier[];
}

// Model interface for the unified model system
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: never;
}

export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	output: ("text" | "image")[];
}
