# @earendil-works/pi-mcp

A small, standalone Model Context Protocol client. It does not depend on the official MCP SDK or other pi packages.

The package provides a transport-neutral client core, stdio and Streamable HTTP transports, a stdio transport over a pipe to a program started elsewhere, and an in-memory testing transport.

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

### Stdio servers started elsewhere

`PipeTransport` speaks MCP's stdio framing over a program that something else starts, for example on another machine. `open` starts the program, connects its stdout and stderr to the given handlers, and returns an `McpPipe` (`write`, `closeStdin`, `close` to kill, and an `exited` promise). `@earendil-works/pi-env`'s `openProcess()` returns one, without an adapter:

```typescript
import { openProcess } from "@earendil-works/pi-env";
import { PipeTransport } from "@earendil-works/pi-mcp";

const transport = new PipeTransport({
	open: (handlers) => openProcess(connection, { cwd, argv, ...handlers }),
});
await client.connect(transport);
```

Closing the transport closes the program's stdin and kills it if it has not exited after `closeTimeoutMs` (default 2000). The transport closes when the program ends.

### Tools for an LLM

`toLlmContent(result)` converts a `CallToolResult` to text and image content for a model, in the shape of `@earendil-works/pi-ai`'s `TextContent` and `ImageContent`. Text and images pass through, embedded text and image resources are unwrapped, and audio, resource links, and binary resources become short text placeholders. A result without content blocks but with `structuredContent` becomes its JSON.

Wrapping an MCP tool as a `pi-agent-core` `AgentTool`:

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toLlmContent } from "@earendil-works/pi-mcp";

const tools: AgentTool[] = (await client.listTools()).map((tool) => ({
	// Providers allow at most 64 characters of [A-Za-z0-9_-].
	name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	label: tool.title ?? tool.name,
	description: tool.description ?? tool.name,
	// Providers require an object schema, and some reject one without `properties`.
	parameters: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} },
	execute: async (_toolCallId, params, signal) => {
		const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
		// MCP reports tool failures in the result instead of as a protocol error.
		return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
	},
}));
```

For applications that name tools like pi's coding agent: `createMcpToolName(server, tool, isTaken)` builds `mcp__<server>__<tool>`, limited to the characters and the 64-character length providers accept, with a hash suffix for long names and for names `isTaken` reports as used by another tool. `mcpNamespace(server)` is the prefix of a server's tool names. `normalizeMcpInputSchema()` turns an input schema into an object schema with `properties`, and `limitMcpContent(content, saveOutput)` keeps model-facing text within `MCP_OUTPUT_MAX_BYTES` (20KB) by cutting its middle; `saveOutput`, when given, stores the full text and returns the path the model can read it from.

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

#### Sign-in in two halves

`startMcpSignIn()` and `completeMcpSignIn()` run the sign-in pi uses, split so the second half can run in another request with the same state store (an `McpOAuthServerStore`: a state store with a refresh lock). The caller picks the redirect URI: a loopback one, or an https callback route of its own. `startMcpSignIn()` first tries to refresh the stored tokens under the store's refresh lock, so never call it while holding that lock; its `redirect` result is plain data the application can persist until the response arrives. Pass `completeMcpSignIn()` the same options, including the redirect URI you chose (not `started.redirectUrl`, which may be a variant specific to the MCP server).

```typescript
import { completeMcpSignIn, responseFromRedirectUrl, startMcpSignIn } from "@earendil-works/pi-mcp/oauth";

const signIn = { serverUrl, store, settings: {}, redirectUrl: "https://app.example/mcp/callback", clientName: "My app" };
const started = await startMcpSignIn(signIn);
if (started.kind === "redirect") {
	// Send the browser to started.authorizationUrl; keep `started` until the response arrives.
	// Later, a callback route builds { code, state, iss } from its query; a pasted URL goes through:
	const response = responseFromRedirectUrl(pastedUrl, started);
	await completeMcpSignIn({ ...signIn, authorization: started, response });
}
```

For a browser on the same machine, `listenForLoopbackSignIn()` starts a loopback callback server and returns its redirect URI, and `waitForLoopbackSignIn()` waits for the response on it or for a pasted redirect URL. `clientMetadataDocuments` lets authorization servers that support Client ID Metadata Documents identify the application by a document it publishes instead of registering a client. `createMcpAuthProvider()` is the matching `AuthProvider` for connections: it refreshes the stored tokens and throws `McpOAuthAuthorizationRequiredError` when the user has to sign in.

The OAuth implementation is adapted from the MIT-licensed Model Context Protocol TypeScript SDK v1.29.0. Its license is included under `LICENSES/`.

### Configuration

`validateMcpServerConfig(name, entry, options)` validates one entry of the `mcpServers` shape that MCP clients share: stdio servers (`command`, `args`, `env`, `cwd`), Streamable HTTP servers (`url`, `headers`, `oauth`), and `enabled`, `description`, and `timeout`. It returns `{ kind: "stdio" | "http", config }` or `{ kind: "invalid", error }`. Fields it does not know stay in `config`, typed `unknown`, for the application to check afterwards, depending on `kind` where it matters. Resolving `${VAR}` references and relative paths is left to the application. `oauth.clientRegistration: "cimd"` is accepted only with `options.checkMetadataDocumentCallback`, which checks that the application's Client ID Metadata Documents list the callback.

```typescript
import { validateMcpServerConfig } from "@earendil-works/pi-mcp";

for (const [name, entry] of Object.entries(file.mcpServers)) {
	const result = validateMcpServerConfig(name, entry);
	if (result.kind === "invalid") errors.push(result.error);
	else if (result.config.shared !== undefined && typeof result.config.shared !== "boolean") {
		errors.push(`server "${name}": shared must be a boolean`);
	} else servers.set(name, result);
}
```

`isMcpServerOverride(entry)` is true for entries without `command`, `url`, or `type`, which applications treat as overriding a few fields of a server defined in another file.

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
- stdio over a caller-provided pipe (`PipeTransport`)
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, token refresh (one refresh shared by concurrent 401s), and step-up authorization for `insufficient_scope`

Batch JSON-RPC messages, legacy HTTP+SSE, servers, sampling, and tasks are outside the initial core.

## Testing

`@earendil-works/pi-mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.
