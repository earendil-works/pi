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

- MCP protocol versions `2025-06-18` and `2025-03-26`
- initialization and `notifications/initialized`
- ping
- paginated `tools/list`
- `tools/call`, including structured content
- progress notifications and timeout renewal
- request cancellation
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, and token refresh

Batch JSON-RPC messages, legacy HTTP+SSE, servers, sampling, and tasks are outside the initial core.

## Testing

`@earendil-works/pi-mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.
