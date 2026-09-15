# @earendil-works/pi-mcp

A small, standalone Model Context Protocol client. It does not depend on the official MCP SDK or other pi packages.

The package provides a transport-neutral client core, stdio and Streamable HTTP transports, and an in-memory testing transport.

## Usage

```typescript
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const transport = new StdioTransport({
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
});
const client = new McpClient({
	name: "my-client",
	version: "1.0.0",
	roots: [{ uri: "file:///workspace", name: "workspace" }],
});

await client.connect(transport);
const tools = await client.listTools();
const result = await client.callTool("search", { query: "MCP" });
await client.close();
```

For a remote server, use `new StreamableHttpTransport({ url, headers })`. Fetch can be injected for proxying or custom networking.

An MCP transport owns framing and I/O. It delivers individual JSON-RPC messages to `McpClient`; the client owns request correlation, initialization, timeouts, cancellation, server requests, and protocol-level helpers.

## Supported protocol surface

- MCP protocol versions `2025-06-18` and `2025-03-26`
- initialization and `notifications/initialized`
- ping
- paginated `tools/list`
- `tools/call`, including structured content
- progress notifications and timeout renewal
- request cancellation
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API

Batch JSON-RPC messages, legacy HTTP+SSE, servers, sampling, tasks, and OAuth are outside the initial core.

## Testing

`@earendil-works/pi-mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.
