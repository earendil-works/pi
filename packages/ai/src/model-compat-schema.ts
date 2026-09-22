import { type Static, Type } from "typebox";

export const SessionAffinityFormatSchema = Type.Union([
	Type.Literal("openai"),
	Type.Literal("openai-nosession"),
	Type.Literal("openrouter"),
]);

export const ThinkingTokenBudgetFieldSchema = Type.Union([
	Type.Literal("thinking_token_budget"),
	Type.Literal("thinking_budget"),
	Type.Literal("thinking_budget_tokens"),
]);

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
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

export const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

export const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

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

export const AnthropicAllowedFallbackModelSchema = Type.Object({
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	cost: ModelCostSchema,
});

export const OpenAICompletionsCompatSchema = Type.Object(
	{
		supportsStore: Type.Optional(Type.Boolean()),
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		supportsReasoningEffort: Type.Optional(Type.Boolean()),
		supportsUsageInStreaming: Type.Optional(Type.Boolean()),
		supportsFinishReason: Type.Optional(Type.Boolean()),
		maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
		requiresToolResultName: Type.Optional(Type.Boolean()),
		requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
		requiresThinkingAsText: Type.Optional(Type.Boolean()),
		requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
		thinkingFormat: Type.Optional(
			Type.Union([
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
			]),
		),
		chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargValueSchema)),
		chatTemplateArgs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargValueSchema)),
		openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
		vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
		zaiToolStream: Type.Optional(Type.Boolean()),
		thinkingTokenBudgetField: Type.Optional(ThinkingTokenBudgetFieldSchema),
		supportsThinkingTokenBudget: Type.Optional(Type.Boolean()),
		supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
		supportsMidConvoSystemMessages: Type.Optional(Type.Boolean()),
		supportsMidConvoToolAdditions: Type.Optional(Type.Boolean()),
		supportsStrictMode: Type.Optional(Type.Boolean()),
		cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
		sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
		sessionAffinityFormat: Type.Optional(SessionAffinityFormatSchema),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
		vllmPriority: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);

export const OpenAIResponsesCompatSchema = Type.Object(
	{
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		supportsMidConvoSystemMessages: Type.Optional(Type.Boolean()),
		sessionAffinityFormat: Type.Optional(SessionAffinityFormatSchema),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
		supportsStrictMode: Type.Optional(Type.Boolean()),
		supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
		supportsAdditionalTools: Type.Optional(Type.Boolean()),
		supportsToolSearch: Type.Optional(Type.Boolean()),
		supportsExplicitPromptCacheMode: Type.Optional(Type.Boolean()),
		supportsMaxOutputTokens: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

export const AnthropicMessagesCompatSchema = Type.Object(
	{
		supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
		sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
		sessionAffinityFormat: Type.Optional(Type.Literal("openrouter")),
		supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
		supportsTemperature: Type.Optional(Type.Boolean()),
		forceAdaptiveThinking: Type.Optional(Type.Boolean()),
		allowEmptySignature: Type.Optional(Type.Boolean()),
		supportsStrictTools: Type.Optional(Type.Boolean()),
		supportsMidConvoEffort: Type.Optional(Type.Boolean()),
		supportsMidConvoSystemMessages: Type.Optional(Type.Boolean()),
		supportsMidConvoToolChanges: Type.Optional(Type.Boolean()),
		allowedFallbackModels: Type.Optional(Type.Array(AnthropicAllowedFallbackModelSchema, { maxItems: 3 })),
	},
	{ additionalProperties: true },
);

export const BedrockCompatSchema = Type.Object(
	{
		supportsStrictMode: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

export const MistralConversationsCompatSchema = Type.Object(
	{
		supportsMidConvoSystemMessages: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

export const ModelCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
	BedrockCompatSchema,
	MistralConversationsCompatSchema,
]);

export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
export type OpenRouterRouting = Static<typeof OpenRouterRoutingSchema>;
export type VercelGatewayRouting = Static<typeof VercelGatewayRoutingSchema>;
export type AnthropicAllowedFallbackModel = Static<typeof AnthropicAllowedFallbackModelSchema>;

/** Compatibility settings for OpenAI-compatible completions APIs. */
export type OpenAICompletionsCompat = Static<typeof OpenAICompletionsCompatSchema>;
/** Compatibility settings for OpenAI Responses APIs. */
export type OpenAIResponsesCompat = Static<typeof OpenAIResponsesCompatSchema>;
/** Compatibility settings for Anthropic Messages-compatible APIs. */
export type AnthropicMessagesCompat = Static<typeof AnthropicMessagesCompatSchema>;
/** Compatibility settings for Amazon Bedrock models. */
export type BedrockCompat = Static<typeof BedrockCompatSchema>;
/** Compatibility settings for the Mistral chat API. */
export type MistralConversationsCompat = Static<typeof MistralConversationsCompatSchema>;
