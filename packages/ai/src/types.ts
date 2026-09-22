import type { TelemetryContext } from "@earendil-works/pi-telemetry";
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
import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "./providers/compat-schema.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type {
	AnthropicAllowedFallbackModel,
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	SessionAffinityFormat,
	ThinkingTokenBudgetField,
	VercelGatewayRouting,
} from "./providers/compat-schema.ts";
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
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type KnownImagesProvider = "openrouter";

export type ImagesProviderId = KnownImagesProvider | string;

export type ToolChoice = "auto" | "none";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * Best-effort prompt cache lifetime in seconds for each retention tier a request can ask for.
 * A missing tier means the lifetime is unknown; pi does not warm such caches.
 */
export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** Explicit parent context for telemetry produced by this logical request. */
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 */
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
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
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * Arbitrary sampling parameters merged into the request body as-is, after the named request
	 * fields, so keys here override them. Lets custom OpenAI-compatible servers (llama.cpp, vLLM,
	 * SGLang, ...) receive parameters pi does not model, e.g. `top_p`, `top_k`, `min_p`,
	 * `repetition_penalty`. Merged over `Model.samplingParams` per key. Only applied by
	 * OpenAI-compatible adapters (completions, responses, Azure responses); other APIs ignore it.
	 */
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
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
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Maximum provider long-poll duration in milliseconds.
	 * Defaults to 0, which performs one status check.
	 */
	wait?: number;
}

/** Request options for best-effort deferred-response cancellation. */
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

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
 * under `src/api/` exports `stream` and `streamSimple`; capable modules may also
 * export deferred-response methods. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
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

export interface ImagesOptions extends ProviderRequestOptions<ImagesModel<ImagesApi>> {
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	/** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	/** Ask a capable provider to return a durable handle and continue the request asynchronously. */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Receives a normalized transcript: the system prompt and tools live in the
//   leading system message, never on the context itself.
// - Must return an AssistantMessageEventStream.
// - Direct streamSimple() calls may throw synchronously when request auth is
//   missing. Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
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
	thinkingSignature?: string; // Provider-specific opaque or serialized reasoning replay data
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
	arguments: JsonObject;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	/** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
	namespace?: string;
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

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

/** The JSON representation of a typed in-memory value. Optional object properties remain optional. */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	/** Provider token, such as a response id or batch id plus row id. */
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	/** Provider conversion data required to reconstruct the final assistant message. */
	data?: JsonValue;
}

/**
 * System instructions and tool declarations at one point in the transcript.
 *
 * The leading system message is the system prompt. Later system messages change it:
 * `content` adds instructions from that point on, `sections` replace or remove named
 * prompt sections, and `toolsAdded`/`toolsRemoved` change the tool set. Replaying
 * every system message in order yields the current prompt and tools. Providers that
 * accept system messages mid-conversation send each one in place; other providers
 * rebuild the leading system message from the replayed state.
 */
export interface SystemMessage {
	role: "system";
	/** Instruction text. On the leading message this is the base prompt; later, additional instructions. */
	content: string | TextContent[];
	/**
	 * Named, ordered prompt sections rendered verbatim after `content`. The leading message
	 * declares them; later messages replace sections by name, and `null` removes one. Keep
	 * each section self-delimiting (a tag, a heading) so the model can relate an update to
	 * the original. Avoid integer-like names; JSON objects reorder those.
	 */
	sections?: Record<string, string | null>;
	/** Complete definitions of tools that become available at this point. */
	toolsAdded?: Tool[];
	/** Tools that stop being available at this point. */
	toolsRemoved?: ToolReference[];
	timestamp: number; // Unix timestamp in milliseconds
}

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
	responseModel?: string; // Concrete model reported by the provider when different from the requested `model`
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/** Exact provider-native effort level used for this response. Absent for legacy or unmanaged responses. */
	providerThinkingLevel?: string;
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	/**
	 * Provider indication of whether the model explicitly ended its turn.
	 * Preserved for debugging and does not currently affect agent control flow.
	 */
	endTurn?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[]; // Supports text and images
			details?: JsonRepresentation<TDetails>;
			/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
			usage?: Usage;
			isError: boolean;
			timestamp: number; // Unix timestamp in milliseconds
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

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

export interface ToolReference {
	name: string;
}

/**
 * Request input accepted by the public stream entry points (`Models.stream()`,
 * `streamSimple()`, ...). `systemPrompt` and `tools` are shorthand for a leading
 * system message; `normalizeContext()` folds them into one before the request
 * reaches a provider.
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;

/**
 * Normalized request context passed to providers and API implementations. The
 * prompt and tool declarations are carried by the transcript's system messages.
 * Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 * provider code by accident.
 */
export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Successful streams emit `start` before partial updates and terminate with
 * `done`. A stream may terminate directly with `error` when request setup fails
 * before generation starts; after `start`, failures also terminate with `error`.
 * Direct `streamSimple()` calls throw synchronously when request auth is missing.
 * Updates and `done` must never appear before `start`.
 *
 * `partial` is the shared live response-so-far helper, not an event-time
 * snapshot. Text and thinking blocks are empty when their `*_start` event is
 * emitted and grow only through their corresponding `*_delta` events until the
 * authoritative `*_end`. Redacted thinking may be complete at start and emit no
 * deltas. Tool-call arguments at `toolcall_start` are provider-specific;
 * `toolcall_delta` carries subsequent JSON updates.
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
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

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

export interface ModelImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** Maximum base64-encoded payload size in bytes. */
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ModelImageInputLimits {
	/** Cache-safe resize profile applied before a new image enters conversation history. */
	resize?: ModelImageResizeOptions;
	/** Maximum images accepted in one provider message. */
	maxPerMessage?: number;
	/** Maximum images accepted across one provider request. */
	maxPerRequest?: number;
}

export interface ModelInputLimits {
	/** Maximum serialized provider request size in bytes. */
	maxRequestBytes?: number;
	images?: ModelImageInputLimits;
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
	/** Provider input limits and cache-safe preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	/** Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown. */
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	/** Default sampling parameters for this model. See {@link StreamOptions.samplingParams}; per-request keys override these. */
	samplingParams?: Record<string, unknown>;
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
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: never;
}

export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	output: ("text" | "image")[];
}
