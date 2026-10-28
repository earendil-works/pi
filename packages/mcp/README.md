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

### Tools for an LLM

`toLlmContent(result)` converts a `CallToolResult` to text and image content for a model, in the shape of `@earendil-works/pi-ai`'s `TextContent` and `ImageContent`. Text and images pass through, embedded text and image resources are unwrapped, and audio, resource links, and binary resources become short text placeholders. A result without content blocks but with `structuredContent` becomes its JSON.

Wrapping an MCP tool as a `pi-agent-core` `AgentTool`:

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

const tools: AgentTool[] = (await client.listTools()).map((tool) => ({
	// Providers allow at most 64 characters of [A-Za-z0-9_-].
	name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	label: tool.title ?? tool.name,
	description: tool.description ?? tool.name,
	// Providers require an object schema, and some reject one without `properties`.
	parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
	execute: async (_toolCallId, params, signal) => {
		const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
		// MCP reports tool failures in the result instead of as a protocol error.
		return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
	},
}));
```

The [mcp-codemode example](https://github.com/earendil-works/pi/tree/main/packages/agent/examples/mcp-codemode) also forwards progress, passes `structuredContent` through, and lets `@earendil-works/pi-codemode` scripts call the tools.

### OAuth

`@earendil-works/pi-mcp/oauth` provides the MCP OAuth client subset without depending on the official SDK:

```typescript
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";

const serverUrl = "https://mcp.example.com/mcp";
const callback = await OAuthCallbackServer.listen();
let authorizationUrl: URL | undefined;
const oauth = new McpOAuthProvider({
	serverUrl,
	redirectUrl: callback.redirectUrl,
	clientMetadata: { client_name: "My MCP client" },
	onRedirect: (url) => {
		authorizationUrl = url;
	},
});

const connect = () => {
	const client = new McpClient({ name: "my-client", version: "1.0.0" });
	return {
		client,
		connected: client.connect(
			new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) }),
		),
	};
};

const first = connect();
try {
	await first.connected;
} catch (error) {
	if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
	const state = await oauth.state();
	const result = callback.waitForCallback(state);
	// Open authorizationUrl in the user's browser here.
	const { code } = await result;
	await authorizeMcp(oauth, { serverUrl, authorizationCode: code });
}

const { client, connected } = connect();
await connected;
```

Inject `McpOAuthStateStore` into `McpOAuthProvider` for durable credentials. The package does not open a browser or choose where credentials are stored.

The OAuth implementation is adapted from the MIT-licensed Model Context Protocol TypeScript SDK v1.29.0. Its license is included under `LICENSES/`.

An MCP transport owns framing and I/O. It delivers individual JSON-RPC messages to `McpClient`; the client owns request correlation, initialization, timeouts, cancellation, server requests, and protocol-level helpers.

## Supported protocol surface

- MCP protocol version `2025-11-25`, accepting servers that negotiate `2025-06-18`, `2025-03-26`, or `2024-11-05`
- initialization and `notifications/initialized`
- ping
- paginated `tools/list`
- `tools/call`, including structured content
- progress notifications and timeout renewal
- request cancellation
- Streamable HTTP sessions, the server-to-client GET stream with reconnection, and resumption of dropped response streams with `Last-Event-ID`
- stdio shutdown per the spec (close stdin, then SIGTERM, then SIGKILL), applied to the server's whole process group
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, token refresh (one refresh shared by concurrent 401s), and step-up authorization for `insufficient_scope`

Batch JSON-RPC messages, legacy HTTP+SSE, servers, sampling, and tasks are outside the initial core.

## Testing

`@earendil-works/pi-mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.
