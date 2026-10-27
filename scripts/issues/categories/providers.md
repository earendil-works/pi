---
owner: davidbrai
---
# providers

How pi-ai talks to model APIs.

In:
- Request building and message conversion or replay: thinking blocks, signatures, tool call IDs, roles.
- Tool schema conversion (strict mode, anyOf).
- Streaming, SSE and WebSocket parsing.
- Provider error classification, retry, context overflow detection.
- Usage parsing from responses, prompt cache headers, cache warming.
- Provider auth: OAuth login flows, API keys, auth.json, token refresh.

Not here:
- Which models exist, prices, context sizes, model selection: models.
- MCP OAuth: mcp.
- What compaction sends: compaction.

Examples: #9444, #10390, #9134, #10543, #10258, #8928, #9508.

Usually not worth opening: requests to add a new provider (should be an extension), bugs in proxies or gateways such as LiteLLM, non-standard provider behavior, theoretical stream edge cases nobody hit.
