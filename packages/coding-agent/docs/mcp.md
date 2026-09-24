# MCP Servers

Pi connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP and makes their tools available to the model.

## Configure servers

Add servers to `~/.pi/agent/mcp.json`, or to `.pi/mcp.json` in a project. The format matches other MCP clients, so existing `mcpServers` entries can be copied over:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "exposure": "direct"
    }
  }
}
```

- stdio servers take `command`, `args`, `env`, and `cwd`. Relative `cwd` resolves against the session directory.
- HTTP servers take `url` and `headers`. The legacy SSE transport is not supported.
- `env` and `headers` values can reference environment variables (`${NAME}`) or commands (`!command`), like provider API keys.
- `timeout` sets the per-request timeout in seconds (default 60). Progress notifications from the server reset it.
- `enabled: false` keeps an entry without connecting to it.

Project entries replace global entries with the same name. A project `mcp.json` is only read after the project is trusted, because stdio servers run commands.

Pi connects when a session starts. The first prompt waits until startup connections finish. A server that drops its connection is reconnected on the next call. Run `/mcp` to see server status, tool counts, and errors.

## Exposure

Each server's tools are registered as `mcp__<server>__<tool>`. The `exposure` setting controls how the model reaches them:

- `codemode` (default): the tools are callable from [codemode](cli.md#tools) scripts but are not declared to the model. Large MCP tool lists stay out of the model's tool declarations, and scripts can call several MCP tools, in parallel if needed, while returning only the part of the result the model needs. Pi activates the codemode tool when such a server connects.
- `direct`: the tools are declared to the model like built-in tools, and are also callable from codemode.

MCP tools that declare an `outputSchema` return their `structuredContent` to codemode scripts. Other tools return their text output. Images are passed through as image content.

Every MCP call goes through pi's tool pipeline, so `tool_call` and `tool_result` extension handlers, including permission gates, apply to MCP tools. Calls made from codemode scripts carry the codemode call's id as `parentToolCallId`.

OAuth sign-in is not supported yet. Use header-based authentication for remote servers.
