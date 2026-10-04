# Choose a Model

For a built-in provider, start with `/login`, then choose a model with `/model`. Use custom model configuration only when Pi does not already include the provider or endpoint you need.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A supported subscription | Sign in through `/login` |
| A provider API key | Store it through `/login` or set its environment variable |
| A local GGUF model | Connect Pi to the llama.cpp router |
| An OpenAI-, Anthropic-, or Google-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

Browse the [model catalog](https://pi.dev/models) for current providers, model IDs, capabilities, context limits, and pricing. Pi starts with its bundled catalog and can overlay newer catalog data from pi.dev. Cached catalog data remains available offline; run `pi update --models` to force a refresh.

## Authenticate

Run `/login` and select a provider. Pi stores credentials in [`auth.json`](configuration.md#agent-directory). Run `/logout` to remove stored credentials for a provider.

You can instead provide an API key through the provider's environment variable. This is useful in CI and other environments where Pi should not write credentials. [Providers](providers.md) lists the variables and provider-specific setup.

When several credential sources are configured, Pi uses a runtime `--api-key` first, then a stored `auth.json` credential, an `apiKey` from `models.json`, and finally the provider's environment variables or ambient cloud credentials. Provider extensions can define their own authentication behavior.

Keep `auth.json` and any credential commands private. Project settings and extensions can execute inside the Pi process after you trust a project. Review [Security](security.md) before loading configuration from an untrusted directory.

## Select a model

Run `/model` to search available models. The picker shows models whose providers have usable authentication. Press `Ctrl+S` on a model to save it as the default for new sessions.

Run `/thinking` to select the thinking level for the current model. Press `Ctrl+S` there to save the startup level. Pi limits the choices to levels supported by the selected model.

`Ctrl+P` cycles through available models. Use `/scoped-models` to control that cycle and save the selection, or configure model patterns through [Settings](settings.md#model-cycling).

A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.

## Connect local models

Pi integrates directly with the llama.cpp router. The router discovers GGUF files and loads models on demand. Pi's `/llama` command manages the router, while `/model` selects one of its loaded models.

Follow [Local Models with llama.cpp](llama-cpp.md) for server startup, model layout, downloads, and connection troubleshooting.

For Ollama, LM Studio, vLLM, SGLang, and other compatible servers, [configure a compatible endpoint](#configure-a-compatible-endpoint) in `models.json`.

## Configure a compatible endpoint

Use [`models.json`](configuration.md#agent-directory) when an endpoint speaks an API Pi already supports. This includes most Ollama, LM Studio, vLLM, SGLang, and proxy deployments.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The dummy key makes the model available to Pi; Ollama ignores it. For an authenticated endpoint, `apiKey` and header values can use `$NAME` or `${NAME}` environment interpolation, a literal value, or a leading `!command`. Commands in `models.json` run at request time and are not cached by Pi.

Opening `/model` reloads the file. A `models` entry adds or replaces a model with the same ID on that provider. Use `modelOverrides` to change metadata for an existing built-in or extension-provided model without replacing the provider's model list. Unknown override IDs are ignored.

### Describe model input and caching

Use `inputLimits.images.resize` to control how Pi encodes new image attachments, `read` results, and tool-result images before storing them in conversation history:

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload. Omitted resize fields use conservative defaults of 2000 by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Images are encoded once; changing models does not rewrite historical images. The catalog can also describe hard request limits with `inputLimits.maxRequestBytes`, `images.maxPerMessage`, and `images.maxPerRequest`, but Pi does not yet rewrite or reject history based on them.

<a id="prompt-cache-lifetimes"></a>

Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or `long` retention tier:

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choose the conservative end of any published range. A model without a lifetime for the active tier is not eligible for cache warming. A `modelOverrides` entry can set `inputLimits` or `promptCache` for a built-in or extension model, including a model accessed through a validated proxy. See [`cacheWarming`](settings.md#model-and-thinking).

### Configure sampling by thinking level

OpenAI-compatible APIs support free-form `samplingParams` model defaults and `samplingParamsByThinkingLevel` overrides. The latter uses Pi thinking-level keys (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`), not provider values from `thinkingLevelMap`:

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Pi first clamps unsupported thinking levels, then merges model `samplingParams`, the effective level's override, and request-level `samplingParams` in that order. Later values win per key. Missing levels inherit the model defaults. `modelOverrides` merges per-level entries per key with the base model. These fields apply only to `openai-completions`, `openai-responses`, and `azure-openai-responses`; other APIs ignore them.

Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.

## Use classifier models

Classifier models do not chat. They answer typed questions about JSON state: pick one of several choices, answer yes or no, or give a score, each with probabilities. Pi includes TypeSafe's Jev model from these providers, and Cloudflare's Clef and Clef Flash models from Workers AI:

| Provider | Model IDs | Authentication |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `~typesafe/jev-latest` | `OPENROUTER_API_KEY` or `/login` |
| `cloudflare-workers-ai` | `typesafe/jev`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |

Chat models on a [llama.cpp router](llama-cpp.md#classification) are also listed as classifier models.

Classifier models do not appear in `/model`. The model reaches them through the [`codemode`](cli.md#enable-codemode) tool, which is off unless an MCP server turned it on. Enable it with `"defaultTools": ["+codemode"]` in [settings](settings.md#tools). Scripts then list classifier models with `models.getAvailableOfType("classifier")` and call `models.classify(model, { state, questions })`:

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

[Codemode](codemode.md#classify) describes the question and answer types.

When the service reports token counts, as all System One services do, `result.usage` carries them with their cost. Pi adds the usage of a script's classifier calls to the `codemode` tool result, so it counts toward the session cost in the footer and `/session`. The cost uses the model's catalog price; models without one, such as TypeSafe's direct `jev-latest`, report tokens at no cost.

Extensions call classifiers through `ctx.modelRegistry.classify()`, without codemode. [Virtual models](virtual-models.md#route-requests) can use them to route requests; see the `jev-router.ts` example.

## Use image models

Image models generate images from a prompt and optional input images. Pi lists OpenRouter's image models, such as `google/gemini-2.5-flash-image` and `black-forest-labs/flux.2-pro`, under the `openrouter` provider; they use the same `OPENROUTER_API_KEY` or `/login` credential as its chat models.

Like classifier models, image models do not appear in `/model`; the model reaches them through the [`codemode`](cli.md#enable-codemode) tool. Scripts list them with `models.getAvailableOfType("image")` and call `models.generateImages(model, { input })`. The result's `output` holds base64 image blocks, which `image()` attaches to the `codemode` result so the model sees them:

```js
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) if (block.type === "image") image(block);
```

`input` can also contain `{ type: "image", data, mimeType }` blocks to edit or use as references. Pi adds the usage of a script's image calls to the `codemode` tool result, like classifier calls. Generated images are not saved to disk. [Codemode](codemode.md#generate-images) describes the full API.

Extensions generate images through `ctx.modelRegistry.generateImages()`, without codemode.

## Add a custom provider

Use an extension when the provider needs custom streaming, model discovery, or authentication behavior. See [Custom Providers](custom-provider.md) for the extension workflow.

## Troubleshooting

### A model does not appear

Confirm that its provider has usable authentication. Custom models can load from `models.json` but remain unavailable in `/model` until Pi can resolve credentials. For llama.cpp, only models currently loaded by the router appear.

### Authentication works in one shell only

Check whether the key came from an environment variable rather than `auth.json`. Environment variables must be present in the process that starts Pi.

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true,
        "allowEmptySignature": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `supportsEagerToolInputStreaming` | Whether the provider accepts per-tool `eager_input_streaming`. Default: `true`. Set to `false` to omit that field and use the legacy fine-grained tool streaming beta header on tool-enabled requests. |
| `supportsLongCacheRetention` | Whether the provider accepts Anthropic long cache retention (`cache_control.ttl: "1h"`) when cache retention is `long`. Default: `true`. |
| `sendSessionAffinityHeaders` | Whether to send `x-session-affinity` from the session id when caching is enabled. Default: auto-detected for known providers. |
| `supportsCacheControlOnTools` | Whether the provider accepts Anthropic-style `cache_control` markers on tool definitions. Default: `true`. |
| `forceAdaptiveThinking` | Whether to send adaptive thinking (`thinking.type: "adaptive"` plus `output_config.effort`) for this model. Built-in adaptive models set this automatically. Default: `false`. |
| `supportsMidConvoEffort` | Whether the exact Claude model transport supports per-turn effort system messages and thinking binding controls. Pi persists native effort levels and always sends `drop_block` when enabled. Default: `false`. |
| `allowEmptySignature` | Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: `false`. |
| `supportsStrictTools` | Whether the provider accepts strict JSON-schema tool definitions. Default: `false`; built-in Anthropic models enable it in generated metadata. |

## OpenAI Compatibility

For providers with partial OpenAI compatibility, use the `compat` field.

- Provider-level `compat` applies defaults to all models under that provider.
- Model-level `compat` overrides provider-level values for that model.

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `supportsStore` | Provider supports `store` field |
| `supportsDeveloperRole` | Use `developer` vs `system` role |
| `systemPromptFormat` | For `openai-responses`, serialize the system prompt as an `input` developer/system message (default) or in the top-level `instructions` field. |
| `supportsReasoningEffort` | Support for `reasoning_effort` parameter |
| `supportsUsageInStreaming` | Supports `stream_options: { include_usage: true }` (default: `true`) |
| `supportsFinishReason` | Whether streamed responses include `finish_reason`. When `false`, pi infers `stop` or `toolUse` when the stream ends. Default: `true`. |
| `maxTokensField` | Use `max_completion_tokens` or `max_tokens` |
| `requiresToolResultName` | Include `name` on tool result messages |
| `requiresAssistantAfterToolResult` | Insert an assistant message before a user message after tool results |
| `requiresThinkingAsText` | Convert thinking blocks to plain text |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` on all replayed assistant messages when reasoning is enabled |
| `thinkingFormat` | Use `reasoning_effort`, `openrouter`, `deepseek`, `together`, `baseten`, `zai`, `qwen`, `chat-template`, or `qwen-chat-template` thinking parameters |
| `chatTemplateKwargs` | `chat_template_kwargs` values for `thinkingFormat: "chat-template"`; use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for pi-controlled thinking values |
| `chatTemplateArgs` | `chat_template_args` values for `thinkingFormat: "baseten"`; use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for pi-controlled thinking values |
| `thinkingTokenBudgetField` | Top-level request field used to cap reasoning tokens from `thinkingBudgets`, clamped so at least 1024 tokens remain for the answer. `"thinking_token_budget"` (vLLM), `"thinking_budget"` (Qwen/DashScope/SGLang), `"thinking_budget_tokens"` (llama.cpp). Off by default; not set on the generated catalog. |
| `supportsThinkingTokenBudget` | Alias for `thinkingTokenBudgetField: "thinking_token_budget"` (vLLM). Prefer `thinkingTokenBudgetField`. Default: `false`. |
| `cacheControlFormat` | Use Anthropic-style `cache_control` markers on the system prompt, last tool definition, and last user, assistant, or tool-result text content. Currently only `anthropic` is supported. |
| `sendSessionAffinityHeaders` | For `openai-completions`, send session-affinity headers from the session id when caching is enabled. Default: `false`. |
| `sessionAffinityFormat` | For `openai-completions` and `openai-responses`, the session-affinity header format: `openai` sends `session_id`/`x-client-request-id` (completions also `x-session-affinity`), `openai-nosession` omits the underscore-containing `session_id` header, `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param. Default: auto-detected. |
| `supportsStrictMode` | Whether the provider accepts strict JSON-schema function tool definitions. Defaults depend on the API; built-in OpenAI models carry explicit capability metadata. |
| `supportsOpenAIGrammarTools` | Whether OpenAI-compatible APIs emit custom Lark/regex grammar tools. When `false`, grammar-constrained tools fall back to normal function tools. Default: `false`; the built-in model catalog enables it for GPT-5+ models on OpenAI, OpenAI Codex, Azure OpenAI, GitHub Copilot, opencode, and Cloudflare AI Gateway. |
| `deferredToolsMode` | Use provider-specific deferred tool serialization. Currently only `"kimi"` is supported for Kimi's OpenAI-compatible Chat Completions format. |
| `supportsLongCacheRetention` | Whether the provider accepts long cache retention when cache retention is `long`: `prompt_cache_retention: "24h"` for OpenAI prompt caching, or `cache_control.ttl: "1h"` when `cacheControlFormat` is `anthropic`. Default: `true`. |
| `openRouterRouting` | OpenRouter provider routing preferences. This object is sent as-is in the `provider` field of the [OpenRouter API request](https://openrouter.ai/docs/guides/routing/provider-selection). |
| `vercelGatewayRouting` | Vercel AI Gateway routing config for provider selection (`only`, `order`) |

For an `openai-responses` proxy that expects the system prompt in the top-level `instructions` field:

```json
{
  "providers": {
    "responses-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$RESPONSES_PROXY_KEY",
      "api": "openai-responses",
      "compat": {
        "systemPromptFormat": "instructions"
      },
      "models": [{ "id": "gpt-5.4" }]
    }
  }
}
```

`systemPromptFormat` defaults to `input`. Setting it to `instructions` moves the dynamic system prompt instead of copying it, so the prompt is sent exactly once. Avoid also setting `samplingParams.instructions`: sampling parameters are merged last and will override the dynamic system prompt.

`openrouter` uses `reasoning: { effort }`. `together` uses `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` uses top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that require `chat_template_kwargs.enable_thinking` and `preserve_thinking`. Use `chat-template` for vLLM/Hugging Face chat templates that need configurable `chat_template_kwargs`, such as `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }` for DeepSeek V3.x templates. Use `thinkingFormat: "baseten"` with `chatTemplateArgs` for providers that expose toggle controls through `chat_template_args` and optionally support top-level `reasoning_effort`.

`thinkingTokenBudgetField` is independent of `thinkingFormat`. Do not enable it on the generated Qwen catalog: those models already send `reasoning_effort`, and DashScope rejects `thinking_budget` together with `reasoning_effort`.

`cacheControlFormat: "anthropic"` is for OpenAI-compatible providers that expose Anthropic-style prompt caching through `cache_control` markers on text content and tool definitions.

Example:
### Sign-in opens a browser on a remote machine

Complete the provider's headless authentication flow when available. Some providers let you paste the final redirect URL or authorization code back into Pi. See [Authenticate interactively](providers.md#authenticate-interactively).

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. The upstream server must support the corresponding request fields and behavior.
