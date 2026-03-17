# packages/ai/src/utils

## Purpose
Shared utility modules for the pi-ai library: event streaming, JSON parsing, hashing, schema validation, context overflow detection, and TypeBox helpers.

## Technology
TypeScript, ESM modules.

## Contents
- `event-stream.ts` - `EventStream<TEvent, TResult>`: async iterable event stream with push/end/result pattern, used for all LLM streaming
- `json-parse.ts` - `parseStreamingJson(partial)`: parse incomplete JSON from streaming tool call arguments
- `hash.ts` - `shortHash(str)`: fast deterministic hash for shortening long strings (double 32-bit Murmur-style)
- `overflow.ts` - `detectContextOverflow(error)`: detects context window overflow from provider-specific error messages
- `typebox-helpers.ts` - TypeBox schema utilities for tool parameter generation
- `validation.ts` - `validateToolArguments(tool, toolCall)`: validates tool call arguments against TypeBox schemas
- `sanitize-unicode.ts` - Unicode sanitization for provider compatibility
- `oauth/` - OAuth flow implementations for various providers (Anthropic, GitHub Copilot, Google, OpenAI Codex)

## Key Functions
- `EventStream.push(event)`: Push event to stream
- `EventStream.end(result?)`: Signal stream completion
- `EventStream.result()`: Await final result (Promise)
- `parseStreamingJson(partialJson)`: Parse incomplete JSON, returns object or null
- `detectContextOverflow(error)`: Returns `{ isOverflow: boolean, tokenInfo?: { used, limit } }`
- `validateToolArguments(tool, toolCall)`: Validate and parse tool arguments
- `shortHash(str)`: Fast deterministic string hash, returns base-36 string

## Data Types
- `EventStream<TEvent, TResult>`: async iterable with `push()`, `end()`, `result()` methods
- `AssistantMessageEventStream`: `EventStream<AssistantMessageEvent, AssistantMessage>`

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new utility files as needed
- **Read**: Import individual utilities from this directory
- **Update**: Edit utility files
- **Delete**: Remove utility and update imports

## Style Guide
- One utility per file
- Generic type parameters for reusable abstractions
- Environment variable detection with browser-safe fallbacks
