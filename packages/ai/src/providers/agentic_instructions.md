# packages/ai/src/providers

## Purpose
LLM provider implementations that convert between the unified pi-ai API and provider-specific protocols (Anthropic Messages, OpenAI Completions/Responses, Google Generative AI, Amazon Bedrock, etc.).

## Technology
TypeScript. Each provider implements the `ApiProvider` interface and registers via `registerApiProvider()`.

## Contents
- `register-builtins.ts` - Lazy-loads and registers all built-in providers on import via `createLazyStream()` / `createLazySimpleStream()` wrappers (provider modules loaded on first use for faster startup)
- `anthropic.ts` - Anthropic Messages API provider (Claude models, extended thinking, citations)
- `openai-completions.ts` - OpenAI-compatible Completions API (OpenAI, Groq, Cerebras, xAI, OpenRouter, Mistral, etc.)
- `openai-responses.ts` - OpenAI Responses API provider (GPT-4, GPT-5, reasoning models)
- `openai-responses-shared.ts` - Shared utilities for OpenAI Responses API variants
- `openai-codex-responses.ts` - OpenAI Codex Responses API (WebSocket transport, prompt caching)
- `azure-openai-responses.ts` - Azure OpenAI Responses API provider
- `google.ts` - Google Generative AI (Gemini) provider
- `google-vertex.ts` - Google Vertex AI provider (ADC authentication)
- `google-gemini-cli.ts` - Google Gemini CLI provider (OAuth-based)
- `google-shared.ts` - Shared Google utilities (content conversion, tool mapping)
- `amazon-bedrock.ts` - Amazon Bedrock Converse Stream API provider
- `transform-messages.ts` - Message transformation utilities (thinking-as-text, tool ID normalization, assistant injection)
- `simple-options.ts` - Maps `SimpleStreamOptions` to provider-specific options (reasoning levels, thinking budgets)
- `mistral.ts` - Mistral AI native provider (Mistral SDK-based streaming)
- `github-copilot-headers.ts` - GitHub Copilot-specific HTTP headers

## Key Functions
- `streamAnthropic(model, context, options?)`: Stream via Anthropic Messages API
- `streamOpenAICompletions(model, context, options?)`: Stream via OpenAI Completions
- `streamOpenAIResponses(model, context, options?)`: Stream via OpenAI Responses
- `streamGoogle(model, context, options?)`: Stream via Google Generative AI
- `streamBedrock(model, context, options?)`: Stream via AWS Bedrock
- `streamMistral(model, context, options?)`: Stream via Mistral AI SDK
- `mapOptionsForApi(api, model, options)`: Convert `SimpleStreamOptions` to provider-specific options

## Data Types
- `LazyProviderModule<TApi, TOptions, TSimpleOptions>`: interface for lazy-loaded provider modules with `stream` and `streamSimple` functions
- `OpenAICompletionsCompat`: compatibility flags for OpenAI-compatible APIs (supportsStore, supportsDeveloperRole, requiresThinkingAsText, etc.)
- Provider-specific options extending `StreamOptions`

## Logging
No direct logging. Errors wrapped in `AssistantMessageEvent` error events.

## CRUD Entry Points
- **Create**: Add a new provider file, implement `ApiProvider`, add a `load*ProviderModule()` function and lazy stream exports in `register-builtins.ts`, then call `registerApiProvider()` in `registerBuiltInApiProviders()`
- **Read**: Providers are accessed via `getApiProvider(api)` in `api-registry.ts`
- **Update**: Modify provider files to change API behavior
- **Delete**: Remove from `register-builtins.ts` and delete provider file

## Style Guide
- One file per provider or shared utility
- Provider functions named `stream<Provider>(model, context, options?)`
- Auto-detection of compatibility flags from `model.baseUrl`
- SSE parsing for HTTP streaming providers
- SDK-based providers (Anthropic, Google, Bedrock) use official SDKs

```typescript
// Lazy-loaded provider pattern (modules loaded on first stream call)
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);

registerApiProvider({
	api: "anthropic-messages",
	stream: streamAnthropic,
	streamSimple: streamSimpleAnthropic,
});
```
