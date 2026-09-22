# Custom Providers

A provider extension connects Pi to a model service that needs custom authentication, model discovery, request handling, or streaming. If the service already speaks a supported API, configure it in `models.json` instead.

Provider extensions run inside Pi and can inspect credentials, prompts, tool definitions, model responses, and usage. Treat them as trusted code and avoid logging secrets or provider payloads.

## Choose the smallest integration

| Requirement | Use |
|---|---|
| Add models behind a supported API | [`models.json`](models.md#configure-a-compatible-endpoint) |
| Change an existing provider endpoint or headers | `models.json` or a small provider extension |
| Discover models dynamically | A provider with `refreshModels` |
| Add a `/login` flow | A provider with native or legacy OAuth configuration |
| Implement an unsupported wire protocol | A provider with `stream` or `streamSimple` |

A provider extension is an [extension](extensions.md), so it follows the same loading, trust, reload, and error behavior.

## Register a provider

Call `pi.registerProvider()` from the extension factory. Pi waits for asynchronous factories before startup continues, so providers registered there are available to startup model selection and `pi --list-models`.

There are two registration forms:

- Register a complete `Provider` from `@earendil-works/pi-ai` for native authentication, filtering, discovery, refresh, and streaming behavior.
- Register a provider name with `ProviderConfig` for the legacy configuration form used by existing extensions.

Prefer a complete provider for new integrations that own more than static endpoint and model metadata. Pi composes `models.json` overrides above a registered native provider.

Registering only `baseUrl` or `headers` for an existing provider preserves its built-in models. Supplying `models` in the legacy form replaces the models supplied by that registration.

Calls made after initial extension loading take effect immediately. Use `pi.unregisterProvider()` to remove the dynamic provider and restore built-in behavior that it replaced.

See the checked [GitLab Duo provider](../examples/extensions/custom-provider-gitlab-duo/) for a complete registration that delegates streaming to built-in API implementations.

## Provide authentication

Static providers can resolve an API key from a literal, environment interpolation, or a command. These values use the same syntax as `models.json`:

- `$NAME` and `${NAME}` read environment variables.
- A leading `!command` uses command output.
- `$$` emits a literal `$`.
- `$!` emits a literal leading `!`.

Use native provider authentication when the integration needs stored credentials, custom resolution, provider-scoped environment, or multiple login methods.

An OAuth provider supplies a display name, login flow, token refresh, and access-token resolution. After registration it appears in `/login`, and Pi stores returned credentials in `~/.pi/agent/auth.json`.

OAuth callbacks are UI-neutral. They can open an authorization URL, show a device code, report progress, request input, or ask the user to choose a login method. Honor cancellation and the supplied abort signal during network requests.

Never write access tokens, refresh tokens, authorization headers, or complete provider responses to ordinary logs.

## Supply and refresh models

Every model needs an ID, display name, input capabilities, context window, output limit, reasoning support, and cost metadata. Choose the API implementation at the provider level unless one model requires an override.

Set `promptCache.short` or `promptCache.long` to the provider's best-effort cache lifetime in seconds when Pi should keep an idle prompt cache warm. Leave them unset to disable cache warming for that retention tier.

Compatibility flags describe verified differences in an otherwise supported API. Do not enable them based only on an endpoint claiming compatibility.

Confirm the request fields and response behavior against the actual server.

Use `refreshModels` when the available catalog comes from a live service. Pass `context.signal` to blocking I/O so callers can cancel refreshes.

The two registration forms have different refresh contracts:

- A complete `Provider` returns nothing. It calls `context.publish({ update })` to install provider-owned model state, after which its synchronous `getModels()` exposes the latest list.
- Legacy `ProviderConfig.refreshModels` returns model definitions. Pi replaces that registration’s live models with the returned list and applies any requested persistence.

Publish persisted catalog data only when it should survive across runs. A live service such as llama.cpp can update its in-memory list without persisting it; a remote catalog can retain a snapshot for offline startup.

## Reuse a supported streaming API

Use one of Pi AI’s API implementations whenever the provider protocol matches it.

Supported implementations cover Anthropic Messages, OpenAI Chat Completions and Responses, Google Generative AI and Vertex, Azure OpenAI Responses, Mistral Conversations, and Bedrock Converse.

The provider can still customize authentication, base URLs, headers, model filtering, and discovery while delegating request conversion and streaming to an existing API implementation.

This is safer than copying a stream implementation because it preserves Pi’s message conversion, tool handling, usage accounting, cancellation, and compatibility behavior.

## Implement custom streaming

Implement `streamSimple` only when no existing API implementation can represent the service. Study the implementations under [`packages/ai/src/api`](https://github.com/earendil-works/pi/tree/main/packages/ai/src/api) first.

The stream receives a normalized `TranscriptContext`. System prompts and tool declarations live in transcript system messages, so read them with `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)` rather than expecting `context.systemPrompt` or `context.tools`. A model that supports mid-conversation system messages can receive them in place; otherwise call `collapseSystemMessages(context)` to fold later system messages into the leading one.

A custom stream must:

1. Create an assistant message with provider, model, timestamp, pending stop reason, content, and zeroed usage.
2. After request setup succeeds, emit one `start` event before content events.
3. Update the message while emitting balanced text, thinking, and tool-call events.
4. Finalize usage, cost, content, and stop reason.
5. Emit exactly one terminal `done` or `error` event and close the stream.
6. Convert cancellation into an aborted result.

Request setup can fail before `start`; in that case the stream can terminate directly with `error`. Missing request authentication may also throw synchronously before a stream is returned.

Content indexes refer to blocks in the assistant message. Update each block before emitting the event whose `partial` field exposes that state. Tool-call arguments must contain valid parsed input by `toolcall_end`.

The stream must also honor request instrumentation supplied through `SimpleStreamOptions`:

- Call `options.onPayload` before sending the provider request and use any replacement payload it returns.
- Call `options.onResponse` after receiving the response but before consuming its body.
- Pass through the abort signal and provider-scoped environment.

These hooks power extension request inspection and response-header events. Omitting them makes the provider behave differently from Pi’s built-in providers.

## Report failures and usage

Set a concrete terminal stop reason. Error and aborted messages need an `errorMessage`; successful messages need accurate input, output, cache, total-token, and cost values.

Pi can compact and retry after recognized context-overflow errors. If the service uses an unknown message, normalize only that provider’s overflow response to `context_length_exceeded` in a guarded `message_end` handler.

Do not rewrite rate limits or transient provider failures as context overflow. Those failures use Pi’s normal retry behavior instead.

## Test the integration

Test at least:

- ordinary and empty text responses
- tool calls and tool results
- image input and image tool results when supported
- usage and cost accounting
- abort behavior
- context overflow
- malformed or partial streams
- Unicode boundaries
- cross-provider session handoff
- authentication refresh and cancellation

The provider tests under [`packages/ai/test`](https://github.com/earendil-works/pi/tree/main/packages/ai/test) define the behavior expected from built-in providers. Adapt the relevant suites rather than relying only on manual prompts.

Run the extension directly while developing, then move it to a discovered extension location or distribute it through a [Pi package](packages.md). Use `/reload` after changing a discovered provider extension in an active session.
