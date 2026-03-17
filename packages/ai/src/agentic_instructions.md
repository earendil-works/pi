# packages/ai/src

## Purpose
Unified LLM API library providing streaming and completion functions across multiple AI providers (Anthropic, OpenAI, Google, Bedrock, Mistral, etc.) with automatic model discovery, cost calculation, and provider configuration.

## Technology
TypeScript, ESM modules. Dependencies: `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`, `@sinclair/typebox` (schema validation), `partial-json`.

## Contents
- `index.ts` - Barrel export of all public APIs
- `types.ts` - Core type definitions: `Model`, `Message`, `Context`, `Tool`, `Usage`, `AssistantMessageEvent`, content types, provider/API type unions, compatibility interfaces
- `stream.ts` - Main entry points: `stream()`, `complete()`, `streamSimple()`, `completeSimple()` -- resolve API provider from registry and delegate
- `api-registry.ts` - `registerApiProvider()`, `getApiProvider()`, `getApiProviders()` -- plugin registry for API backends
- `models.ts` - `getModel()`, `getModels()`, `getProviders()`, `calculateCost()`, `supportsXhigh()`, `modelsAreEqual()` -- model registry from generated data
- `models.generated.ts` - Auto-generated model catalog (from `scripts/generate-models.ts`)
- `env-api-keys.ts` - `getEnvApiKey(provider)` -- detects API keys from environment variables for each provider
- `cli.ts` - CLI entry point (`pi-ai` binary)
- `bedrock-provider.ts` - Re-exports Bedrock streaming functions for direct import without pulling full AWS SDK
- `oauth.ts` - Re-exports all OAuth utilities from `utils/oauth/index.js`
- `providers/` - LLM provider implementations (Anthropic, OpenAI, Google, Bedrock, Mistral, etc.) with lazy-loading
- `utils/` - Shared utilities: event streaming, JSON parsing, hashing, schema validation, OAuth flows

## Key Functions
- `streamSimple(model, context, options?)`: Stream LLM with unified reasoning/thinking. Returns `AssistantMessageEventStream`
- `completeSimple(model, context, options?)`: Non-streaming completion. Returns `Promise<AssistantMessage>`
- `stream(model, context, options?)`: Provider-specific stream with typed options
- `complete(model, context, options?)`: Provider-specific completion
- `registerApiProvider(provider, sourceId?)`: Register a new API provider implementation
- `getModel(provider, modelId)`: Get typed model from registry
- `getProviders()`: List all known providers
- `calculateCost(model, usage)`: Compute cost from token usage
- `getEnvApiKey(provider)`: Detect API key from environment variables

## Data Types
- `Model<TApi>`: `{ id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens, headers?, compat? }`
- `Message`: `UserMessage | AssistantMessage | ToolResultMessage`
- `UserMessage`: `{ role: "user", content: string | (TextContent | ImageContent)[], timestamp }`
- `AssistantMessage`: `{ role: "assistant", content: (TextContent | ThinkingContent | ToolCall)[], api, provider, model, usage, stopReason, errorMessage?, responseId?, timestamp }`
- `ToolResultMessage<T>`: `{ role: "toolResult", toolCallId, toolName, content, details?, isError, timestamp }`
- `Context`: `{ systemPrompt?, messages, tools? }`
- `Tool<T>`: `{ name, description, parameters: TSchema }`
- `Usage`: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`
- `AssistantMessageEvent`: discriminated union (start, text_start/delta/end, thinking_start/delta/end, toolcall_start/delta/end, done, error)
- `KnownProvider`: union of 20+ provider strings (anthropic, openai, google, amazon-bedrock, etc.)
- `KnownApi`: union of API protocol strings (openai-completions, anthropic-messages, etc.)
- `SimpleStreamOptions`: `{ reasoning?, thinkingBudgets? }` extends `StreamOptions`
- `StreamOptions`: `{ temperature?, maxTokens?, signal?, apiKey?, transport?, cacheRetention?, sessionId?, headers?, maxRetryDelayMs?, metadata? }`

## Logging
No direct logging. Errors surfaced via `AssistantMessageEvent` of type `error`.

## CRUD Entry Points
- **Create**: `registerApiProvider()` to add new LLM providers
- **Read**: `getModel()`, `getProviders()`, `getModels()`, `getEnvApiKey()` to query registry
- **Update**: Re-register providers with same API key, set environment variables
- **Delete**: `unregisterApiProviders(sourceId)`, `clearApiProviders()`

## Style Guide
- camelCase for functions/variables, PascalCase for types/interfaces
- Tab indentation, 120-char line width (biome)
- Barrel exports via `index.ts`
- Provider implementations in `providers/` subdirectory
- Generated code in `*.generated.ts` files (excluded from linting)
- Environment variable detection uses lazy loading for browser compatibility

```typescript
import { getModel, streamSimple } from "@mariozechner/pi-ai";

const model = getModel("anthropic", "claude-sonnet-4-20250514");
const stream = streamSimple(model, {
	systemPrompt: "You are helpful.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
const result = await stream.result();
```
