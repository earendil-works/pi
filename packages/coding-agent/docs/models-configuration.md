# Models Configuration

<!-- This file is generated from TypeScript source. Do not edit it manually; run npm run generate:references. -->

This reference lists the fields of `models.json`. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint) for examples and [Configuration](configuration.md#agent-directory) for the file location.

Add `"$schema": "https://pi.dev/schemas/models.schema.json"` to `models.json` for editor validation and completion.

## Providers

Each key under `providers` is a provider ID. A built-in provider ID changes that provider. Any other ID adds a provider, which needs `baseUrl` and an `api` at provider or model level.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string |  | Display name. |
| `baseUrl` | string |  | API base URL. Also applies to the provider's built-in models. |
| `apiKey` | string |  | Literal key, "$NAME" environment interpolation, or "!command" output. |
| `api` | string |  | API for the provider's models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai". |
| `oauth` | `"radius"` |  | OAuth login flow. Requires baseUrl. |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |
| `authHeader` | boolean | `false` | Whether to send the resolved API key as Authorization: Bearer. |
| `models` | [`object[]`](#models) |  |  |
| `modelOverrides` | [object](#model-overrides) |  |  |

## Models

Each `models` entry adds a model to the provider. An entry whose `id` matches an existing model replaces it.

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string |  | Required. Model ID sent to the API. |
| `name` | string |  | Display name, also matched by --model patterns. |
| `api` | string |  | Overrides the provider api. |
| `baseUrl` | string |  | Overrides the provider baseUrl. |
| `reasoning` | boolean | `false` | Whether the model supports thinking. |
| `thinkingLevelMap` | object |  | Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported. |
| `input` | `("text" \| "image")[]` | `["text"]` |  |
| `inputLimits` | [object](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `promptCache` | object |  | Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Pi warms only tiers with a known lifetime. |
| `contextWindow` | number | `128000` | Context window in tokens. |
| `maxTokens` | number | `16384` | Maximum output tokens. |
| `samplingParams` | object |  | Fields merged into every request body. Applies only to OpenAI-compatible APIs. |
| `samplingParamsByThinkingLevel` | object |  | samplingParams per thinking level, merged over samplingParams. |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |

## Model overrides

Each `modelOverrides` key is the ID of a built-in or extension model. Unknown IDs are ignored. Object fields, such as `cost`, merge with the model's value field by field; other fields replace it.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string |  | Display name, also matched by --model patterns. |
| `reasoning` | boolean |  | Whether the model supports thinking. |
| `thinkingLevelMap` | object |  | Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported. |
| `input` | `("text" \| "image")[]` |  |  |
| `inputLimits` | [object](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | Input cost in USD per million tokens. |
| `cost.output` | number |  | Output cost in USD per million tokens. |
| `cost.cacheRead` | number |  | Cache-read cost in USD per million tokens. |
| `cost.cacheWrite` | number |  | Cache-write cost in USD per million tokens. |
| `cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `promptCache` | object |  | Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Pi warms only tiers with a known lifetime. |
| `contextWindow` | number |  | Context window in tokens. |
| `maxTokens` | number |  | Maximum output tokens. |
| `samplingParams` | object |  | Fields merged into every request body. Applies only to OpenAI-compatible APIs. |
| `samplingParamsByThinkingLevel` | object |  | samplingParams per thinking level, merged over samplingParams. |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |

## Input limits

See [Describe model input and caching](models.md#describe-model-input-and-caching).

| Field | Type | Default | Description |
|---|---|---|---|
| `maxRequestBytes` | integer |  | Maximum serialized provider request size in bytes. |
| `images` | object |  |  |
| `images.resize` | object |  | Cache-safe resize profile applied before a new image enters conversation history. |
| `images.resize.maxWidth` | integer |  |  |
| `images.resize.maxHeight` | integer |  |  |
| `images.resize.maxBytes` | integer |  | Maximum base64-encoded payload size in bytes. |
| `images.resize.jpegQuality` | integer |  |  |
| `images.maxPerMessage` | integer |  | Maximum images accepted in one provider message. |
| `images.maxPerRequest` | integer |  | Maximum images accepted across one provider request. |

## Compatibility

`compat` describes verified differences from an API's standard request and response behavior. Model values override provider values per field. The fields that apply depend on the model's `api`.

### `openai-completions`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsStore` | boolean |  | Whether the provider supports the store field. Default: auto-detected from URL. |
| `supportsDeveloperRole` | boolean |  | Whether the provider supports the developer role instead of system. Default: auto-detected from URL. |
| `supportsReasoningEffort` | boolean |  | Whether the provider supports reasoning_effort. Default: auto-detected from URL. |
| `supportsUsageInStreaming` | boolean | `true` | Whether the provider supports stream_options.include_usage for token usage in streaming responses. |
| `supportsFinishReason` | boolean | `true` | Whether streamed responses include finish_reason. When false, pi infers stop or toolUse when the stream ends. |
| `maxTokensField` | `"max_completion_tokens" \| "max_tokens"` |  | Which field to use for max tokens. Default: auto-detected from URL. |
| `requiresToolResultName` | boolean |  | Whether tool results require the name field. Default: auto-detected from URL. |
| `requiresAssistantAfterToolResult` | boolean |  | Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. |
| `requiresThinkingAsText` | boolean |  | Whether thinking blocks must be converted to text blocks with &lt;thinking> delimiters. Default: auto-detected from URL. |
| `requiresReasoningContentOnAssistantMessages` | boolean |  | Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. |
| `thinkingFormat` | `"openai" \| "openrouter" \| "deepseek" \| "together" \| "baseten" \| "zai" \| "qwen" \| "chat-template" \| "qwen-chat-template" \| "string-thinking" \| "ant-ling"` |  | Format for reasoning or thinking parameters. When omitted, Pi auto-detects the format from the provider URL. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null. |
| `chatTemplateKwargs` | object |  | Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values. |
| `chatTemplateArgs` | object |  | Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for pi-controlled values. |
| `openRouterRouting` | object |  | OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection. |
| `vercelGatewayRouting` | object |  | Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options. |
| `zaiToolStream` | boolean | `false` | Whether z.ai supports top-level tool_stream for streaming tool call deltas. |
| `thinkingTokenBudgetField` | `"thinking_token_budget" \| "thinking_budget" \| "thinking_budget_tokens"` |  | Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog. |
| `supportsThinkingTokenBudget` | boolean | `false` | Alias for thinkingTokenBudgetField: "thinking_token_budget" (vLLM). Prefer thinkingTokenBudgetField. |
| `supportsOpenAIGrammarTools` | boolean | `false` | Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models. |
| `supportsMidConvoToolAdditions` | boolean | `false` | Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models. |
| `supportsStrictMode` | boolean | `false` | Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly. |
| `cacheControlFormat` | `"anthropic"` |  | Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content. |
| `sendSessionAffinityHeaders` | boolean |  | Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise. |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected. |
| `supportsLongCacheRetention` | boolean |  | Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL. |
| `vllmPriority` | number |  | vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog. |

### `openai-responses`

Also applies to `azure-openai-responses` and `openai-codex-responses`.

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsDeveloperRole` | boolean | `true` | Whether the provider supports the developer role instead of system. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts developer or system messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models. |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected. |
| `supportsLongCacheRetention` | boolean | `true` | Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "30m" on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models. |
| `supportsStrictMode` | boolean |  | Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly. |
| `supportsOpenAIGrammarTools` | boolean | `false` | Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models. |
| `supportsAdditionalTools` | boolean | `false` | Whether the model supports message-anchored additional_tools input items. |
| `supportsToolSearch` | boolean | `false` | Whether the model supports client-executed tool search for transcript-anchored additions. |
| `supportsExplicitPromptCacheMode` | boolean | `false` | Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter. |
| `supportsMidConvoEffort` | boolean | `false` | Whether thinking level changes are sent as configuration_update input items instead of changing reasoning.effort, so a change keeps the prompt cache. Only used by the openai-responses API, and ignored with Sign in with ChatGPT on the openai provider. |
| `supportsMaxOutputTokens` | boolean | `true` | Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it. |

### `anthropic-messages`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsEagerToolInputStreaming` | boolean | `true` | Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests. |
| `supportsLongCacheRetention` | boolean | `true` | Whether the provider supports Anthropic long cache retention through cache_control.ttl. |
| `sendSessionAffinityHeaders` | boolean |  | Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits. Default: true for OpenRouter endpoints, false otherwise. |
| `sessionAffinityFormat` | `"openrouter"` |  | Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity. |
| `supportsCacheControlOnTools` | boolean | `true` | Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it. |
| `supportsTemperature` | boolean | `true` | Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values. |
| `forceAdaptiveThinking` | boolean | `false` | Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models. |
| `allowEmptySignature` | boolean | `false` | Whether to replay empty thinking signatures instead of converting thinking to text. |
| `supportsStrictTools` | boolean | `false` | Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly. |
| `supportsMidConvoEffort` | boolean | `false` | Whether the exact model transport supports effort-only system messages and thinking binding controls. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt. |
| `supportsMidConvoToolChanges` | boolean | `false` | Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages. |
| `allowedFallbackModels` | `object[]` |  | Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets. |

### `bedrock-converse-stream`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsStrictMode` | boolean | `false` | Whether the model supports Bedrock strict tool schemas. |

### `mistral-conversations`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system messages after the conversation has started. When false, later system messages are folded into the leading system message. |

### `typesafe-system-one`

Also applies to `cloudflare-workers-ai-system-one`.

| Field | Type | Default | Description |
|---|---|---|---|
| `imageInput` | `"assets" \| "images" \| "state-image-urls"` |  | How the service takes classifier images. "assets" sends TypeSafe's assets map (PNG and JPEG) and references the images from the state, as TypeSafe and Jev on Workers AI expect. "images" sends Clef's images list of data URLs (PNG, JPEG, and WebP, at most four), as Clef on Workers AI expects. "state-image-urls" places image_url parts before the state, as OpenRouter expects; OpenRouter drops assets without an error. Auto-detected from the provider, baseUrl, and model ID. Classifier models read it from the provider-level compat; models and modelOverrides entries apply to chat models only. |
| `sendImageOptInHeader` | boolean |  | Whether requests with images send the TypeSafe-Danger-Zone-Images: true header, which TypeSafe's own API requires for its experimental image input. Defaults to true for the typesafe-system-one API unless the model is detected as OpenRouter. |
