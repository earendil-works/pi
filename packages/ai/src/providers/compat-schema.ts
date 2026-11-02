import {
	type Annotations,
	arr,
	bool,
	nul,
	num,
	opt,
	type Properties,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { ModelCostSchema } from "./model-schema.ts";
import { openObject, stringLiteral, stringRecord } from "./schema-builders.ts";

function sessionAffinityFormat(options?: Annotations<"openai" | "openai-nosession" | "openrouter">) {
	return union([stringLiteral("openai"), stringLiteral("openai-nosession"), stringLiteral("openrouter")], options);
}

export const SessionAffinityFormatSchema = sessionAffinityFormat({
	description: "Session-affinity header format used to route related requests consistently.",
});

function thinkingTokenBudgetField(
	options?: Annotations<"thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens">,
) {
	return union(
		[
			stringLiteral("thinking_token_budget"),
			stringLiteral("thinking_budget"),
			stringLiteral("thinking_budget_tokens"),
		],
		options,
	);
}

export const ThinkingTokenBudgetFieldSchema = thinkingTokenBudgetField({
	description:
		'Top-level request field name used by OpenAI-compatible endpoints to cap reasoning tokens. "thinking_token_budget" is used by vLLM, "thinking_budget" by Qwen, DashScope, or SGLang, and "thinking_budget_tokens" by llama.cpp.',
});

export const ChatTemplateKwargValueSchema = union([
	str(),
	num(),
	bool(),
	nul(),
	openObject({
		$var: union([
			stringLiteral("thinking.enabled"),
			stringLiteral("thinking.effort"),
			stringLiteral("thinking.budget"),
		]),
		omitWhenOff: opt(bool()),
	}),
]);

function percentileCutoffs(metric: string) {
	return openObject({
		p50: opt(num({ description: `${metric} at the 50th percentile.` })),
		p75: opt(num({ description: `${metric} at the 75th percentile.` })),
		p90: opt(num({ description: `${metric} at the 90th percentile.` })),
		p99: opt(num({ description: `${metric} at the 99th percentile.` })),
	});
}

export const OpenRouterRoutingSchema = openObject(
	{
		allow_fallbacks: opt(
			bool({ description: "Whether to allow backup providers to serve requests.", default: true }),
		),
		require_parameters: opt(
			bool({
				description: "Whether to filter providers to only those that support all parameters in the request.",
				default: false,
			}),
		),
		data_collection: opt(
			union([stringLiteral("deny"), stringLiteral("allow")], {
				description:
					'Data collection setting. "allow": allow providers that may store or train on data. "deny": only use providers that do not collect user data.',
				default: "allow",
			}),
		),
		zdr: opt(bool({ description: "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints." })),
		enforce_distillable_text: opt(
			bool({ description: "Whether to restrict routing to only models that allow text distillation." }),
		),
		order: opt(
			arr(str(), {
				description:
					"An ordered list of provider names or slugs to try in sequence, falling back to the next if unavailable.",
			}),
		),
		only: opt(
			arr(str(), {
				description: "List of provider names or slugs to exclusively allow for this request.",
			}),
		),
		ignore: opt(arr(str(), { description: "List of provider names or slugs to skip for this request." })),
		quantizations: opt(
			arr(str(), {
				description:
					'A list of quantization levels to filter providers by, for example ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"].',
			}),
		),
		sort: opt(
			union(
				[
					str(),
					openObject({
						by: opt(str({ description: 'The sorting metric, such as "price", "throughput", or "latency".' })),
						partition: opt(
							union([str(), nul()], {
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
		max_price: opt(
			openObject(
				{
					prompt: opt(union([num(), str()], { description: "Price per million prompt tokens." })),
					completion: opt(union([num(), str()], { description: "Price per million completion tokens." })),
					image: opt(union([num(), str()], { description: "Price per image." })),
					audio: opt(union([num(), str()], { description: "Price per audio unit." })),
					request: opt(union([num(), str()], { description: "Price per request." })),
				},
				{ description: "Maximum price per million tokens in USD." },
			),
		),
		preferred_min_throughput: opt(
			union([num(), percentileCutoffs("Minimum tokens per second")], {
				description: "Preferred minimum throughput in tokens per second. A number applies to p50.",
			}),
		),
		preferred_max_latency: opt(
			union([num(), percentileCutoffs("Maximum latency in seconds")], {
				description: "Preferred maximum latency in seconds. A number applies to p50.",
			}),
		),
	},
	{
		description:
			"OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection.",
	},
);

export const VercelGatewayRoutingSchema = openObject(
	{
		only: opt(
			arr(str(), {
				description:
					'List of provider slugs to exclusively use for this request, for example ["bedrock", "anthropic"].',
			}),
		),
		order: opt(
			arr(str(), {
				description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
			}),
		),
	},
	{
		description:
			"Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.",
	},
);

export const AnthropicAllowedFallbackModelSchema = openObject(
	{
		provider: str({ minLength: 1 }),
		model: str({ minLength: 1 }),
		cost: ModelCostSchema,
	},
	{ description: "An Anthropic server-side refusal fallback model with local pricing metadata." },
);

function optionalCompatBoolean(options?: Annotations<boolean>) {
	return opt(bool(options));
}

function optionalSessionAffinityFormat(options?: Annotations<"openai" | "openai-nosession" | "openrouter">) {
	return opt(sessionAffinityFormat(options));
}

const OpenAICompletionsCompatProperties = {
	supportsStore: opt(
		bool({
			description: "Whether the provider supports the store field. Default: auto-detected from URL.",
		}),
	),
	supportsDeveloperRole: optionalCompatBoolean({
		description:
			"Whether the provider supports the developer role instead of system. Default: auto-detected from URL.",
	}),
	supportsReasoningEffort: opt(
		bool({
			description: "Whether the provider supports reasoning_effort. Default: auto-detected from URL.",
		}),
	),
	supportsUsageInStreaming: opt(
		bool({
			description:
				"Whether the provider supports stream_options.include_usage for token usage in streaming responses.",
			default: true,
		}),
	),
	supportsFinishReason: opt(
		bool({
			description:
				"Whether streamed responses include finish_reason. When false, pi infers stop or toolUse when the stream ends.",
			default: true,
		}),
	),
	maxTokensField: opt(
		union([stringLiteral("max_completion_tokens"), stringLiteral("max_tokens")], {
			description: "Which field to use for max tokens. Default: auto-detected from URL.",
		}),
	),
	requiresToolResultName: opt(
		bool({ description: "Whether tool results require the name field. Default: auto-detected from URL." }),
	),
	requiresAssistantAfterToolResult: opt(
		bool({
			description:
				"Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL.",
		}),
	),
	requiresThinkingAsText: opt(
		bool({
			description:
				"Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL.",
		}),
	),
	requiresReasoningContentOnAssistantMessages: opt(
		bool({
			description:
				"Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL.",
		}),
	),
	thinkingFormat: opt(
		union(
			[
				stringLiteral("openai"),
				stringLiteral("openrouter"),
				stringLiteral("deepseek"),
				stringLiteral("together"),
				stringLiteral("baseten"),
				stringLiteral("zai"),
				stringLiteral("qwen"),
				stringLiteral("chat-template"),
				stringLiteral("qwen-chat-template"),
				stringLiteral("string-thinking"),
				stringLiteral("ant-ling"),
			],
			{
				description:
					'Format for reasoning or thinking parameters. When omitted, Pi auto-detects the format from the provider URL. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null.',
			},
		),
	),
	chatTemplateKwargs: opt(
		stringRecord(ChatTemplateKwargValueSchema, {
			description:
				'Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
		}),
	),
	chatTemplateArgs: opt(
		stringRecord(ChatTemplateKwargValueSchema, {
			description:
				'Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values.',
		}),
	),
	openRouterRouting: opt(OpenRouterRoutingSchema),
	vercelGatewayRouting: opt(VercelGatewayRoutingSchema),
	zaiToolStream: opt(
		bool({
			description: "Whether z.ai supports top-level tool_stream for streaming tool call deltas.",
			default: false,
		}),
	),
	thinkingTokenBudgetField: opt(
		thinkingTokenBudgetField({
			description:
				'Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog.',
		}),
	),
	supportsThinkingTokenBudget: opt(
		bool({
			description:
				'Alias for thinkingTokenBudgetField: "thinking_token_budget" (vLLM). Prefer thinkingTokenBudgetField.',
			default: false,
		}),
	),
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
		default: false,
	}),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
		default: false,
	}),
	supportsMidConvoToolAdditions: opt(
		bool({
			description:
				"Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models.",
			default: false,
		}),
	),
	supportsStrictMode: optionalCompatBoolean({
		description:
			"Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly.",
		default: false,
	}),
	cacheControlFormat: opt(
		stringLiteral("anthropic", {
			description:
				"Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.",
		}),
	),
	sendSessionAffinityHeaders: optionalCompatBoolean({
		description:
			"Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise.",
	}),
	sessionAffinityFormat: optionalSessionAffinityFormat({
		description:
			"Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
	}),
	supportsLongCacheRetention: optionalCompatBoolean({
		description:
			'Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL.',
	}),
	vllmPriority: opt(
		num({
			description:
				"vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog.",
		}),
	),
};

export const OpenAICompletionsCompatSchema = openObject(OpenAICompletionsCompatProperties, {
	description:
		"Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.",
	additionalProperties: true,
});

const OpenAIResponsesCompatProperties = {
	supportsDeveloperRole: optionalCompatBoolean({
		description: "Whether the provider supports the developer role instead of system.",
		default: true,
	}),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts developer or system messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
		default: false,
	}),
	sessionAffinityFormat: optionalSessionAffinityFormat({
		description:
			"Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
	}),
	supportsLongCacheRetention: optionalCompatBoolean({
		description:
			'Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "30m" on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models.',
		default: true,
	}),
	supportsStrictMode: optionalCompatBoolean({
		description:
			"Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly.",
	}),
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		description:
			"Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
		default: false,
	}),
	supportsAdditionalTools: opt(
		bool({
			description: "Whether the model supports message-anchored additional_tools input items.",
			default: false,
		}),
	),
	supportsToolSearch: opt(
		bool({
			description: "Whether the model supports client-executed tool search for transcript-anchored additions.",
			default: false,
		}),
	),
	supportsExplicitPromptCacheMode: opt(
		bool({
			description: "Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter.",
			default: false,
		}),
	),
	supportsMidConvoEffort: opt(
		bool({
			description:
				"Whether thinking level changes are sent as configuration_update input items instead of changing reasoning.effort, so a change keeps the prompt cache. Only used by the openai-responses API, and ignored with Sign in with ChatGPT on the openai provider.",
			default: false,
		}),
	),
	supportsMaxOutputTokens: opt(
		bool({
			description: "Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it.",
			default: true,
		}),
	),
};

export const OpenAIResponsesCompatSchema = openObject(OpenAIResponsesCompatProperties, {
	description: "Compatibility settings for OpenAI Responses APIs.",
	additionalProperties: true,
});

const AnthropicMessagesCompatProperties = {
	supportsEagerToolInputStreaming: opt(
		bool({
			description:
				"Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests.",
			default: true,
		}),
	),
	supportsLongCacheRetention: optionalCompatBoolean({
		description: "Whether the provider supports Anthropic long cache retention through cache_control.ttl.",
		default: true,
	}),
	sendSessionAffinityHeaders: optionalCompatBoolean({
		description:
			"Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits. Default: true for OpenRouter endpoints, false otherwise.",
	}),
	sessionAffinityFormat: opt(
		stringLiteral("openrouter", {
			description: "Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity.",
		}),
	),
	supportsCacheControlOnTools: opt(
		bool({
			description:
				"Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it.",
			default: true,
		}),
	),
	supportsTemperature: opt(
		bool({
			description:
				"Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values.",
			default: true,
		}),
	),
	forceAdaptiveThinking: opt(
		bool({
			description:
				"Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models.",
			default: false,
		}),
	),
	allowEmptySignature: opt(
		bool({
			description: "Whether to replay empty thinking signatures instead of converting thinking to text.",
			default: false,
		}),
	),
	supportsStrictTools: opt(
		bool({
			description:
				"Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly.",
			default: false,
		}),
	),
	supportsMidConvoEffort: opt(
		bool({
			description:
				"Whether the exact model transport supports effort-only system messages and thinking binding controls.",
			default: false,
		}),
	),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt.",
		default: false,
	}),
	supportsMidConvoToolChanges: opt(
		bool({
			description:
				"Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages.",
			default: false,
		}),
	),
	allowedFallbackModels: opt(
		arr(AnthropicAllowedFallbackModelSchema, {
			maxItems: 3,
			description:
				"Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets.",
		}),
	),
};

export const AnthropicMessagesCompatSchema = openObject(AnthropicMessagesCompatProperties, {
	description: "Compatibility settings for Anthropic Messages-compatible APIs.",
	additionalProperties: true,
});

const BedrockCompatProperties = {
	supportsStrictMode: optionalCompatBoolean({
		description: "Whether the model supports Bedrock strict tool schemas.",
		default: false,
	}),
};

export const BedrockCompatSchema = openObject(BedrockCompatProperties, {
	description: "Compatibility settings for Amazon Bedrock models.",
	additionalProperties: true,
});

const MistralConversationsCompatProperties = {
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system messages after the conversation has started. When false, later system messages are folded into the leading system message.",
		default: false,
	}),
};

export const MistralConversationsCompatSchema = openObject(MistralConversationsCompatProperties, {
	description: "Compatibility settings for the Mistral chat API.",
	additionalProperties: true,
});

const SystemOneCompatProperties = {
	imageInput: opt(
		union([stringLiteral("assets"), stringLiteral("images"), stringLiteral("state-image-urls")], {
			description:
				'How the service takes classifier images. "assets" sends TypeSafe\'s assets map (PNG and JPEG) and references the images from the state, as TypeSafe and Jev on Workers AI expect. "images" sends Clef\'s images list of data URLs (PNG, JPEG, and WebP, at most four), as Clef on Workers AI expects. "state-image-urls" places image_url parts before the state, as OpenRouter expects; OpenRouter drops assets without an error. Auto-detected from the provider, baseUrl, and model ID. Classifier models read it from the provider-level compat; models and modelOverrides entries apply to chat models only.',
		}),
	),
	sendImageOptInHeader: optionalCompatBoolean({
		description:
			"Whether requests with images send the TypeSafe-Danger-Zone-Images: true header, which TypeSafe's own API requires for its experimental image input. Defaults to true for the typesafe-system-one API unless the model is detected as OpenRouter.",
	}),
};

export const SystemOneCompatSchema = openObject(SystemOneCompatProperties, {
	description: "Compatibility settings for System One classifier APIs.",
	additionalProperties: true,
});

const ProviderCompatPropertyOverrides = {
	supportsDeveloperRole: optionalCompatBoolean({
		description: "Whether the provider supports the developer role instead of system. Defaults are API-specific.",
	}),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message.",
		default: false,
	}),
	sessionAffinityFormat: optionalSessionAffinityFormat({
		description: "Session-affinity header format. Defaults are API-specific or auto-detected.",
	}),
	supportsMidConvoEffort: optionalCompatBoolean({
		description:
			"Whether thinking level changes are sent inside the conversation instead of changing the request's effort, so a change keeps the prompt cache. Used by the anthropic-messages and openai-responses APIs.",
		default: false,
	}),
	supportsLongCacheRetention: optionalCompatBoolean({
		description:
			"Whether the provider supports long prompt cache retention. Defaults are API-specific or auto-detected.",
	}),
	supportsStrictMode: optionalCompatBoolean({
		description: "Whether the provider supports strict tool schemas. Defaults are API-specific.",
	}),
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools.",
		default: false,
	}),
	sendSessionAffinityHeaders: optionalCompatBoolean({
		description: "Whether to send session-affinity data from options.sessionId. Defaults are API-specific.",
	}),
} satisfies Properties;

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection,
) => void
	? Intersection
	: never;

type MergedCompatProperties<PropertyGroups extends readonly Properties[], Overrides extends Properties> = Omit<
	UnionToIntersection<PropertyGroups[number]>,
	keyof Overrides
> &
	Overrides;

/**
 * Provider-level models.json compatibility is API-agnostic, so it needs one superset. Every
 * duplicate property requires explicit generic metadata, while API-specific schemas retain their
 * own defaults and descriptions.
 */
function mergeCompatProperties<const PropertyGroups extends readonly Properties[], const Overrides extends Properties>(
	propertyGroups: PropertyGroups,
	overrides: Overrides,
): MergedCompatProperties<PropertyGroups, Overrides> {
	const merged: Record<string, Properties[string]> = {};
	const duplicateNames = new Set<string>();

	for (const properties of propertyGroups) {
		for (const [name, schema] of Object.entries(properties)) {
			if (merged[name] !== undefined) {
				duplicateNames.add(name);
				if (!(name in overrides)) {
					throw new Error(`Duplicate compatibility schema property requires an override: ${name}`);
				}
			}
			merged[name] = schema;
		}
	}

	for (const name of Object.keys(overrides)) {
		if (!duplicateNames.has(name)) {
			throw new Error(`Compatibility schema override does not resolve a duplicate property: ${name}`);
		}
	}

	return { ...merged, ...overrides } as MergedCompatProperties<PropertyGroups, Overrides>;
}

/** Compatibility schema for each API whose models accept compat. Mirrors the compat type of Model. */
export const CompatSchemasByApi = {
	"openai-completions": OpenAICompletionsCompatSchema,
	"openai-responses": OpenAIResponsesCompatSchema,
	"azure-openai-responses": OpenAIResponsesCompatSchema,
	"openai-codex-responses": OpenAIResponsesCompatSchema,
	"anthropic-messages": AnthropicMessagesCompatSchema,
	"bedrock-converse-stream": BedrockCompatSchema,
	"mistral-conversations": MistralConversationsCompatSchema,
	"typesafe-system-one": SystemOneCompatSchema,
	"cloudflare-workers-ai-system-one": SystemOneCompatSchema,
} as const;

const ProviderCompatProperties = mergeCompatProperties(
	[
		OpenAICompletionsCompatProperties,
		OpenAIResponsesCompatProperties,
		AnthropicMessagesCompatProperties,
		BedrockCompatProperties,
		MistralConversationsCompatProperties,
		SystemOneCompatProperties,
	],
	ProviderCompatPropertyOverrides,
);

export const ProviderCompatSchema = openObject(ProviderCompatProperties, {
	description: "Provider and model compatibility overrides.",
	additionalProperties: true,
});

export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
/** Provider and model compatibility overrides in models.json: every API's compat fields. */
export type ProviderCompat = Static<typeof ProviderCompatSchema>;
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
/** Compatibility settings for System One classifier APIs. */
export interface SystemOneCompat extends Static<typeof SystemOneCompatSchema> {}
