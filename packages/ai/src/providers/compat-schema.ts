import { type Static, Type } from "typebox";

export const SessionAffinityFormatSchema = Type.Union([
	Type.Literal("openai"),
	Type.Literal("openai-nosession"),
	Type.Literal("openrouter"),
]);

export const ThinkingTokenBudgetFieldSchema = Type.Union(
	[Type.Literal("thinking_token_budget"), Type.Literal("thinking_budget"), Type.Literal("thinking_budget_tokens")],
	{ description: "Top-level request field used to cap reasoning tokens on OpenAI-compatible servers." },
);

export const ChatTemplateKwargValueSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object({
		$var: Type.Union([
			Type.Literal("thinking.enabled"),
			Type.Literal("thinking.effort"),
			Type.Literal("thinking.budget"),
		]),
		omitWhenOff: Type.Optional(Type.Boolean()),
	}),
]);

const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number({ description: "Cutoff at the 50th percentile." })),
	p75: Type.Optional(Type.Number({ description: "Cutoff at the 75th percentile." })),
	p90: Type.Optional(Type.Number({ description: "Cutoff at the 90th percentile." })),
	p99: Type.Optional(Type.Number({ description: "Cutoff at the 99th percentile." })),
});

export const OpenRouterRoutingSchema = Type.Object(
	{
		allow_fallbacks: Type.Optional(
			Type.Boolean({ description: "Whether to allow backup providers to serve requests.", default: true }),
		),
		require_parameters: Type.Optional(
			Type.Boolean({
				description: "Whether to filter providers to only those that support all parameters in the request.",
				default: false,
			}),
		),
		data_collection: Type.Optional(
			Type.Union([Type.Literal("deny"), Type.Literal("allow")], {
				description:
					'Data collection setting. "allow": allow providers that may store or train on data. "deny": only use providers that do not collect user data.',
				default: "allow",
			}),
		),
		zdr: Type.Optional(
			Type.Boolean({ description: "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints." }),
		),
		enforce_distillable_text: Type.Optional(
			Type.Boolean({ description: "Whether to restrict routing to only models that allow text distillation." }),
		),
		order: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"An ordered list of provider names or slugs to try in sequence, falling back to the next if unavailable.",
			}),
		),
		only: Type.Optional(
			Type.Array(Type.String(), {
				description: "List of provider names or slugs to exclusively allow for this request.",
			}),
		),
		ignore: Type.Optional(
			Type.Array(Type.String(), { description: "List of provider names or slugs to skip for this request." }),
		),
		quantizations: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'A list of quantization levels to filter providers by, for example ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"].',
			}),
		),
		sort: Type.Optional(
			Type.Union(
				[
					Type.String(),
					Type.Object({
						by: Type.Optional(
							Type.String({ description: 'The sorting metric, such as "price", "throughput", or "latency".' }),
						),
						partition: Type.Optional(
							Type.Union([Type.String(), Type.Null()], {
								description: 'Partitioning strategy: "model" or "none".',
								default: "model",
							}),
						),
					}),
				],
				{
					description:
						'Sorting strategy. Can be a string such as "price", "throughput", or "latency", or an object.',
				},
			),
		),
		max_price: Type.Optional(
			Type.Object(
				{
					prompt: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per million prompt tokens." }),
					),
					completion: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per million completion tokens." }),
					),
					image: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Price per image." })),
					audio: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per audio unit." }),
					),
					request: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per request." }),
					),
				},
				{ description: "Maximum price per million tokens in USD." },
			),
		),
		preferred_min_throughput: Type.Optional(
			Type.Union([Type.Number(), PercentileCutoffsSchema], {
				description: "Preferred minimum throughput in tokens per second. A number applies to p50.",
			}),
		),
		preferred_max_latency: Type.Optional(
			Type.Union([Type.Number(), PercentileCutoffsSchema], {
				description: "Preferred maximum latency in seconds. A number applies to p50.",
			}),
		),
	},
	{
		description:
			"OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection.",
	},
);

export const VercelGatewayRoutingSchema = Type.Object(
	{
		only: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'List of provider slugs to exclusively use for this request, for example ["bedrock", "anthropic"].',
			}),
		),
		order: Type.Optional(
			Type.Array(Type.String(), {
				description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
			}),
		),
	},
	{
		description:
			"Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.",
	},
);

const ModelCostRatesSchema = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};

const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	...ModelCostRatesSchema,
});

const ModelCostSchema = Type.Object({
	...ModelCostRatesSchema,
	tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

export const AnthropicAllowedFallbackModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		cost: ModelCostSchema,
	},
	{ description: "An Anthropic server-side refusal fallback model with local pricing metadata." },
);

export const OpenAICompletionsCompatSchema = Type.Object(
	{
		supportsStore: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports the store field. Default: auto-detected from URL.",
			}),
		),
		supportsDeveloperRole: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports the developer role instead of system. Default: auto-detected from URL.",
			}),
		),
		supportsReasoningEffort: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports reasoning_effort. Default: auto-detected from URL.",
			}),
		),
		supportsUsageInStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports stream_options.include_usage for token usage in streaming responses.",
				default: true,
			}),
		),
		supportsFinishReason: Type.Optional(
			Type.Boolean({
				description:
					"Whether streamed responses include finish_reason. When false, pi infers stop or toolUse when the stream ends.",
				default: true,
			}),
		),
		maxTokensField: Type.Optional(
			Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")], {
				description: "Which field to use for max tokens. Default: auto-detected from URL.",
			}),
		),
		requiresToolResultName: Type.Optional(
			Type.Boolean({ description: "Whether tool results require the name field. Default: auto-detected from URL." }),
		),
		requiresAssistantAfterToolResult: Type.Optional(
			Type.Boolean({
				description:
					"Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL.",
			}),
		),
		requiresThinkingAsText: Type.Optional(
			Type.Boolean({
				description:
					"Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL.",
			}),
		),
		requiresReasoningContentOnAssistantMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL.",
			}),
		),
		thinkingFormat: Type.Optional(
			Type.Union(
				[
					Type.Literal("openai"),
					Type.Literal("openrouter"),
					Type.Literal("deepseek"),
					Type.Literal("together"),
					Type.Literal("baseten"),
					Type.Literal("zai"),
					Type.Literal("qwen"),
					Type.Literal("chat-template"),
					Type.Literal("qwen-chat-template"),
					Type.Literal("string-thinking"),
					Type.Literal("ant-ling"),
				],
				{
					description:
						'Format for reasoning or thinking parameters. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null.',
					default: "openai",
				},
			),
		),
		chatTemplateKwargs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
			}),
		),
		chatTemplateArgs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
			}),
		),
		openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
		vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
		zaiToolStream: Type.Optional(
			Type.Boolean({
				description: "Whether z.ai supports top-level tool_stream for streaming tool call deltas.",
				default: false,
			}),
		),
		thinkingTokenBudgetField: Type.Optional(
			Type.Union(
				[
					Type.Literal("thinking_token_budget"),
					Type.Literal("thinking_budget"),
					Type.Literal("thinking_budget_tokens"),
				],
				{
					description:
						'Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog.',
				},
			),
		),
		supportsThinkingTokenBudget: Type.Optional(
			Type.Boolean({
				description:
					'Alias for thinkingTokenBudgetField: "thinking_token_budget" (vLLM). Prefer thinkingTokenBudgetField.',
				default: false,
			}),
		),
		supportsOpenAIGrammarTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
				default: false,
			}),
		),
		supportsMidConvoSystemMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
				default: false,
			}),
		),
		supportsMidConvoToolAdditions: Type.Optional(
			Type.Boolean({
				description:
					"Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models.",
				default: false,
			}),
		),
		supportsStrictMode: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly.",
				default: false,
			}),
		),
		cacheControlFormat: Type.Optional(
			Type.Literal("anthropic", {
				description:
					"Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.",
			}),
		),
		sendSessionAffinityHeaders: Type.Optional(
			Type.Boolean({
				description:
					"Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise.",
			}),
		),
		sessionAffinityFormat: Type.Optional(
			Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")], {
				description:
					"Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
			}),
		),
		supportsLongCacheRetention: Type.Optional(
			Type.Boolean({
				description:
					'Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format).',
				default: true,
			}),
		),
		vllmPriority: Type.Optional(
			Type.Number({
				description:
					"vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog.",
			}),
		),
	},
	{
		description:
			"Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.",
		additionalProperties: true,
	},
);

export const OpenAIResponsesCompatSchema = Type.Object(
	{
		supportsDeveloperRole: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports the developer role instead of system.",
				default: true,
			}),
		),
		supportsMidConvoSystemMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts developer or system messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
				default: false,
			}),
		),
		sessionAffinityFormat: Type.Optional(
			Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")], {
				description:
					"Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
			}),
		),
		supportsLongCacheRetention: Type.Optional(
			Type.Boolean({
				description:
					'Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "30m" on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models.',
				default: true,
			}),
		),
		supportsStrictMode: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly.",
			}),
		),
		supportsOpenAIGrammarTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
				default: false,
			}),
		),
		supportsAdditionalTools: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports message-anchored additional_tools input items.",
				default: false,
			}),
		),
		supportsToolSearch: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports client-executed tool search for transcript-anchored additions.",
				default: false,
			}),
		),
		supportsExplicitPromptCacheMode: Type.Optional(
			Type.Boolean({
				description: "Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter.",
				default: false,
			}),
		),
		supportsMaxOutputTokens: Type.Optional(
			Type.Boolean({
				description: "Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it.",
				default: true,
			}),
		),
	},
	{ description: "Compatibility settings for OpenAI Responses APIs.", additionalProperties: true },
);

export const AnthropicMessagesCompatSchema = Type.Object(
	{
		supportsEagerToolInputStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests.",
				default: true,
			}),
		),
		supportsLongCacheRetention: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports Anthropic long cache retention through cache_control.ttl.",
				default: true,
			}),
		),
		sendSessionAffinityHeaders: Type.Optional(
			Type.Boolean({
				description:
					"Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits.",
				default: false,
			}),
		),
		sessionAffinityFormat: Type.Optional(
			Type.Literal("openrouter", {
				description:
					"Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity.",
			}),
		),
		supportsCacheControlOnTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it.",
				default: true,
			}),
		),
		supportsTemperature: Type.Optional(
			Type.Boolean({
				description:
					"Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values.",
				default: true,
			}),
		),
		forceAdaptiveThinking: Type.Optional(
			Type.Boolean({
				description:
					"Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models.",
				default: false,
			}),
		),
		allowEmptySignature: Type.Optional(
			Type.Boolean({
				description: "Whether to replay empty thinking signatures instead of converting thinking to text.",
				default: false,
			}),
		),
		supportsStrictTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly.",
				default: false,
			}),
		),
		supportsMidConvoEffort: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model transport supports effort-only system messages and thinking binding controls.",
				default: false,
			}),
		),
		supportsMidConvoSystemMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt.",
				default: false,
			}),
		),
		supportsMidConvoToolChanges: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages.",
				default: false,
			}),
		),
		allowedFallbackModels: Type.Optional(
			Type.Array(AnthropicAllowedFallbackModelSchema, {
				maxItems: 3,
				description:
					"Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets.",
			}),
		),
	},
	{ description: "Compatibility settings for Anthropic Messages-compatible APIs.", additionalProperties: true },
);

export const BedrockCompatSchema = Type.Object(
	{
		supportsStrictMode: Type.Optional(
			Type.Boolean({ description: "Whether the model supports Bedrock strict tool schemas.", default: false }),
		),
	},
	{ description: "Compatibility settings for Amazon Bedrock models.", additionalProperties: true },
);

export const MistralConversationsCompatSchema = Type.Object(
	{
		supportsMidConvoSystemMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts system messages after the conversation has started. When false, later system messages are folded into the leading system message.",
				default: false,
			}),
		),
	},
	{ description: "Compatibility settings for the Mistral chat API.", additionalProperties: true },
);

export const ProviderCompatSchema = Type.Object(
	{
		...OpenAICompletionsCompatSchema.properties,
		...OpenAIResponsesCompatSchema.properties,
		...AnthropicMessagesCompatSchema.properties,
		...BedrockCompatSchema.properties,
		...MistralConversationsCompatSchema.properties,
		supportsDeveloperRole: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports the developer role instead of system. Defaults are API-specific.",
			}),
		),
		supportsMidConvoSystemMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message.",
				default: false,
			}),
		),
		sessionAffinityFormat: Type.Optional(
			Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")], {
				description: "Session-affinity header format. Defaults are API-specific or auto-detected.",
			}),
		),
		supportsLongCacheRetention: Type.Optional(
			Type.Boolean({ description: "Whether the provider supports long prompt cache retention.", default: true }),
		),
		supportsStrictMode: Type.Optional(
			Type.Boolean({ description: "Whether the provider supports strict tool schemas. Defaults are API-specific." }),
		),
		supportsOpenAIGrammarTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools.",
				default: false,
			}),
		),
		sendSessionAffinityHeaders: Type.Optional(
			Type.Boolean({
				description: "Whether to send session-affinity data from options.sessionId. Defaults are API-specific.",
			}),
		),
	},
	{ description: "Provider and model compatibility overrides.", additionalProperties: true },
);

export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
/** OpenRouter provider routing preferences. */
export interface OpenRouterRouting extends Static<typeof OpenRouterRoutingSchema> {}
/** Vercel AI Gateway routing preferences. */
export interface VercelGatewayRouting extends Static<typeof VercelGatewayRoutingSchema> {}
/** An Anthropic server-side refusal fallback model with local pricing metadata. */
export interface AnthropicAllowedFallbackModel extends Static<typeof AnthropicAllowedFallbackModelSchema> {}

/** Compatibility settings for OpenAI-compatible completions APIs. */
export interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
/** Compatibility settings for the Mistral chat API. */
export interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}
