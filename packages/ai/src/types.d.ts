import type { AnthropicOptions } from "./providers/anthropic.js";
import type { GoogleOptions } from "./providers/google.js";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli.js";
import type { OpenAICompletionsOptions } from "./providers/openai-completions.js";
import type { OpenAIResponsesOptions } from "./providers/openai-responses.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";
export type {
	AnthropicOptions,
	GoogleOptions,
	GoogleGeminiCliOptions,
	OpenAICompletionsOptions,
	OpenAIResponsesOptions,
};
export type { AssistantMessageEventStream } from "./utils/event-stream.js";
export type Api =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "zai-completions";
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"zai-completions": ZAICompletionsOptions;
}
export interface ZAICompletionsOptions extends StreamOptions {
	webSearch?: boolean;
	webSearchEngine?: "search_pro_jina";
	webSearchCount?: number;
	webSearchDomainFilter?: string;
	webSearchRecencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
	webSearchContentSize?: "medium" | "high";
	webSearchResultSequence?: "before" | "after";
	webSearchReturnResults?: boolean;
	webSearchRequireSearch?: boolean;
	webSearchPrompt?: string;
	knowledgeBaseId?: string;
	knowledgeBasePromptTemplate?: string;
}
export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: ReasoningEffort;
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/** Session ID for prompt caching */
	sessionId?: string;
	/** OpenAI Responses setting to request parallel tool calls */
	parallelToolCalls?: boolean;
	/** Codex-specific retry tuning (request vs stream retries). */
	codexRetry?: CodexRetryOptions;
}
export type OptionsForApi<TApi extends Api> = ApiOptionsMap[TApi];
export type KnownProvider =
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "moonshot"
	| "openai"
	| "openai-codex"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "zai"
	| "mistral"
	| "synthetic";
export type Provider = KnownProvider | string;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type RetryClass = "429" | "5xx" | "transport";
export interface RetryOptions {
	/** Maximum number of retry attempts. Default varies by provider. */
	maxRetries?: number;
	/** Initial delay in milliseconds for exponential backoff. Default varies by provider. */
	baseDelay?: number;
	/** Maximum delay in milliseconds between retries. Default varies by provider. */
	maxDelay?: number;
}
export interface CodexRetryOptions {
	/** Max attempts for initial request failures (429/5xx/transport). */
	requestMaxRetries?: number;
	/** Max attempts for retrying a dropped stream before failing. */
	streamMaxRetries?: number;
	/** Initial delay in milliseconds for exponential backoff. */
	baseDelay?: number;
	/** Maximum delay in milliseconds between retries. */
	maxDelay?: number;
	/** Which error classes are retryable. Defaults to all classes. */
	retryOn?: RetryClass[];
}
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	fastMode?: boolean;
	retry?: RetryOptions;
}
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ReasoningEffort;
}
export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
}
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
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
	timestamp: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;
	timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
import type { TSchema } from "@sinclair/typebox";
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
export type AssistantMessageEvent =
	| {
			type: "start";
			partial: AssistantMessage;
	  }
	| {
			type: "text_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
			partial: AssistantMessage;
	  }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
/** OpenAI-completions compatibility overrides for non-standard endpoints */
export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Format for reasoning_effort param: 'string' for OpenAI (low/medium/high), 'boolean' for Fireworks (true/false). Default: 'string'. */
	reasoningEffortFormat?: "string" | "boolean";
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Whether the provider supports `stream_options`. Default: auto-detected from URL. */
	supportsStreamOptions?: boolean;
	/** Whether this is Z.ai API (requires special message handling). Default: auto-detected from URL. */
	isZAI?: boolean;
}
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	reasoningFormat?: "think_tags" | "reasoning_content";
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	extraBody?: Record<string, unknown>;
	compat?: TApi extends "openai-completions" ? OpenAICompat : never;
}
//# sourceMappingURL=types.d.ts.map
