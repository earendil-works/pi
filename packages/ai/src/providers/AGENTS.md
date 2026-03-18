# providers — LLM Provider Implementations

One file per provider. Each exports a `stream*()` function returning `AssistantMessageEventStream`.

## Providers
| File | Provider | API |
|------|----------|-----|
| `anthropic.ts` | Anthropic (Claude) | anthropic-messages |
| `openai-responses.ts` | OpenAI (GPT) | openai-responses |
| `openai-codex-responses.ts` | OpenAI Codex | openai-responses (WebSocket) |
| `openai-completions.ts` | OpenAI legacy | openai-chat-completions |
| `azure-openai-responses.ts` | Azure OpenAI | openai-responses |
| `google.ts` | Google AI (Gemini) | google-genai |
| `google-vertex.ts` | Vertex AI | vertex-genai |
| `google-gemini-cli.ts` | Gemini CLI OAuth | google-genai |
| `amazon-bedrock.ts` | AWS Bedrock | bedrock-converse-stream |
| `mistral.ts` | Mistral | mistral-chat |

## Shared Modules
- `transform-messages.ts` — Converts between internal Message format and provider-specific formats
- `openai-responses-shared.ts` — Shared logic for OpenAI responses API variants
- `google-shared.ts` — Shared logic for Google AI / Vertex
- `simple-options.ts` — `SimpleStreamOptions` → provider-specific options mapping
- `register-builtins.ts` — Registers built-in model definitions per provider

## Pattern
Every provider file follows:
1. Export `stream<Provider>(options)` → `AssistantMessageEventStream`
2. Convert messages to provider format
3. Make streaming HTTP/WS request
4. Parse SSE events → emit standardized events: `text`, `tool_call`, `thinking`, `usage`, `stop`

## Conventions
- Thinking level mapping is provider-specific (e.g., anthropic.ts maps `xhigh` → `max` for Opus 4.6)
- GitHub Copilot headers injected via `github-copilot-headers.ts` when provider is copilot
