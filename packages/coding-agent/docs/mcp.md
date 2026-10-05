# MCP Servers

Pi connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP and makes their tools and resources available to the model.

## Quick setup

Add a local stdio server, check the connection, then start Pi:

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp list
pi
```

For a remote server:

```bash
pi mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
pi mcp list
```

These commands add user-level servers by default. Add `--local` or `-l` to write the project configuration instead:

```bash
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Use `/mcp` inside an interactive session to inspect connections, sign in, reconnect, change exposure, or enable and disable servers. Run `/reload` after adding, removing, or changing a server outside the session.

## Configure servers

Pi reads user-level servers from `~/.pi/agent/mcp.json` and project servers from `.pi/mcp.json`. Project configuration is read only after [project trust](security.md#understand-project-trust) is granted. A project entry replaces a user-level entry with the same name.

A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure` of the user-level server with the same name and keeps the rest, including `env`, `headers`, and `auth`. For example, this turns off a user-level server in one project:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

The format matches other MCP clients:

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
      "description": "Search and read the product documentation"
    }
  }
}
```

Stdio servers use `command`, `args`, `env`, and `cwd`. Relative `cwd` values resolve against the session directory. A leading `~/` in `command`, an argument, or `cwd` names the home directory.

HTTP servers use `url`, `headers`, and `oauth` (see [Authenticate with OAuth](#authenticate-with-oauth)). The legacy SSE transport is not supported.

Both server types support:

- `timeout`: per-request timeout in seconds (default 60). Progress notifications reset it.
- `enabled: false`: keep the entry without connecting to it.
- `exposure` and `toolExposure`: control how tools reach the model (see [Control tool exposure](#control-tool-exposure)).
- `description`: what the server offers, in a sentence. It lists the server in the system prompt (see [Control tool exposure](#control-tool-exposure)), tool search ranks the server's tools by it, and codemode's `describeNamespace()` returns it. Without it, the first line of the server instructions is used once the server connects.

Keep personal servers and servers with credentials in the user-level file. Use the project file only for servers the project requires, and only in trusted projects.

### Configuration rules

- Server names may contain only letters, digits, `_`, and `-`. Tools are named `mcp__<server>__<tool>`, with every character other than letters, digits, and `_` replaced by `_`; tools of a server whose names then collide all get a hash suffix. Server names that differ only in `-` and `_` count as the same server: a second one is rejected, and a `mcp.json` server overrides a registered one.
- `type` is optional. A `command` selects stdio and a `url` selects streamable HTTP. When present, `type` must be `stdio`, `http`, or `streamable-http`.
- `sse` is rejected. Servers that document an SSE endpoint often also provide streamable HTTP, commonly at `/mcp` instead of `/sse`.
- `command` is one executable and `args` contains its arguments. It is not a shell command string.
- `env` and `headers` values can use environment variables such as `${GITHUB_TOKEN}`. They can also run a command with `!command`, but the command must make up the whole value, for example `"Authorization": "!echo Bearer $(gh auth token)"`.
- Invalid entries are reported and skipped without preventing other servers from connecting.

`pi mcp add` and `pi mcp remove` cover common changes from a shell. See [MCP commands](cli.md#mcp-commands) for their options.

### Inspect or change a server

`/mcp` lists configured servers with their state, tool count, exposure, and configuration source. Servers that need attention appear first. Select a server to inspect its tools and connection details, reconnect, sign in or out, change exposure, or enable and disable it.

Exposure and enabled-state changes are saved to the file that defines the server without replacing unrelated content. In a trusted project, "Enable in this project" and "Disable in this project" add a project override for a user-level server; later changes to that server are saved to the override. Disabled servers remain listed. Outside the interactive TUI, `/mcp` prints server status; `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` perform those actions directly.

Shell commands work without a session: `pi mcp add`, `pi mcp remove`, `pi mcp list`, `pi mcp login`, and `pi mcp logout`. Shell commands do not load extensions.

### Diagnose connection problems

Run `pi mcp list` to connect to every enabled server and print its state, tools, and errors. It exits with status 1 when an entry is invalid or an enabled server is not connected. `/mcp` shows the full connection error and the tail of stderr from a failed stdio server.

Pi reports configuration errors, failed connections, and required sign-ins once after startup. Server logging notifications are appended to `~/.pi/agent/mcp.log` as `<time> [<server>] <level> <logger>: <message>`. The file moves to `mcp.log.1` after it grows past 5 MB.

Pi connects every enabled server in the background when a session starts. A server's tools appear once it connects; the `codemode` description does not list them, so it does not change when servers connect. The first prompt waits up to 10 seconds only for servers with `direct` tools, which must be declared in its request. Other servers are waited for when they are needed: a codemode script waits for the servers it names (`mcp__<server>`) and, when it calls `searchTools()` or reads `ALL_TOOLS`, for all of them; `tool_search` and the resource tools also wait for all of them. HTTP network errors and transient statuses (408, 429, and 5xx) are retried twice. A dropped connection is shown as disconnected and reconnects on the next call. When a server announces a changed tool list, new tools are added and withdrawn tools become unreachable.

Stopping a stdio server closes its stdin, sends SIGTERM, then sends SIGKILL to its process group. This also stops servers launched through wrappers such as `npx` or `uvx`.

## Migrate configuration from another client

Move the converted entry under `mcpServers` in `mcp.json`, then run `pi mcp list` to validate it.

| Client | Conversion |
|---|---|
| Claude Desktop, Claude Code, or Cursor | Copy the existing `mcpServers` entry. |
| VS Code | Move an entry from the top-level `servers` object and replace `${input:...}` prompts with `${NAME}` environment variables. |
| Codex | Convert `[mcp_servers.<name>]` TOML fields such as `command`, `args`, `env`, and `url` to JSON. |
| OpenCode | Convert `"type": "local"` to a stdio entry, split its `command` array into `command` and `args`, rename `environment` to `env`, and replace `{env:NAME}` with `${NAME}`. Convert `"type": "remote"` to a URL entry. |

## Authenticate with OAuth

Remote servers that use OAuth, such as Sentry, need no credentials in `mcp.json`:

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

When the server rejects an unauthenticated connection, `/mcp` shows that it needs sign-in. Select "Sign in", run `/mcp login sentry`, or run `pi mcp login sentry`. Pi opens the authorization page and waits for approval. If the browser runs on another machine, such as over SSH, paste its redirected URL into the sign-in screen. A running session uses the new credentials on its next turn.

Pi registers itself with the authorization server, stores tokens in `~/.pi/agent/mcp-auth.json`, and refreshes access tokens when they expire or the server rejects them. If a server later requests additional scope, Pi asks for sign-in again. Signing out deletes the stored credentials.

Credentials belong to a server name and URL. Servers with the same URL under different names, such as one per account, sign in separately; servers with the same name and URL in different `mcp.json` files share one sign-in.

OAuth applies to HTTP servers without an `Authorization` header. For a server that does not support dynamic client registration, configure a registered client:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

The redirect URI must match the registered URI. `callbackPort` uses `http://127.0.0.1:<port>/callback`. To use another URI, set `callbackUrl`; it must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Pi sends it exactly as written. When `callbackUrl` omits a port, Pi uses `callbackPort` or a free port and adds it to the URI, as allowed for loopback redirects by RFC 8252. `clientSecret` is optional and can use an environment variable or command.

Set `scope` to a space-separated list for servers that do not advertise their required scopes. Otherwise, Pi requests the advertised scopes. Later scope requests are added to the configured value.

Pi registers as `pi`. Some servers only accept registrations from known clients. Set `clientName` to send another name:

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp", "oauth": { "clientName": "Claude Code" } }
  }
}
```

The name is only sent when Pi registers a client. To register again under a new name, sign out first.

Some authorization servers allow clients by their Client ID Metadata Document URL instead of registering them. Set `clientRegistration` to `cimd` to identify as Pi's document on pi.dev instead of registering:

```json
{
  "mcpServers": {
    "example": { "url": "https://mcp.example.com/mcp", "oauth": { "clientRegistration": "cimd" } }
  }
}
```

The client ID is `https://pi.dev/oauth/client.json` with the redirect URI `http://127.0.0.1:<port>/callback`. If the authorization server does not send the `iss` parameter in authorization responses (RFC 9207), Pi uses a document and redirect path specific to the MCP server instead: `https://pi.dev/oauth/<id>/client.json` with `http://127.0.0.1:<port>/callback/<id>`. The authorization server must advertise Client ID Metadata Document support and public clients, or sign-in fails. `cimd` cannot be combined with `clientId` or `clientName`, and a `callbackUrl` must use `localhost` or `127.0.0.1` with the path `/callback`.

Pi finds the authorization server through the server's protected resource metadata (RFC 9728) and checks that the authorization server's metadata names the expected issuer (RFC 8414). Some servers advertise the wrong authorization server or none, so sign-in opens a page that does not exist. Set `authServerMetadataUrl` to the metadata document of the right authorization server:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Pi uses that document instead of discovery and trusts it as configured, so only point it at a document you trust. The URL must use HTTPS, except on `localhost`, `127.0.0.1`, or `[::1]`.

## Control tool exposure

Each server tool is registered as `mcp__<server>__<tool>`. The server's `exposure` determines how the model reaches it:

| Exposure | Behavior | Typical use |
|---|---|---|
| `codemode` (default) | Callable from [`codemode`](cli.md#tools) scripts, but neither declared to the model nor listed in the codemode description. Scripts find tools with `searchTools()`, `describeTool()`, or `ALL_TOOLS`. | General MCP servers, especially when scripts should combine or filter calls. |
| `deferred` | Not declared until [`tool_search`](cli.md#tools) loads a match for the next model call. | Large servers whose tools should be called directly after discovery. |
| `direct` | Declared to the model like a built-in tool and also callable from codemode. | Small, frequently used tool sets. |
| `hidden` | Registered but unreachable. | Servers or tools that should remain unavailable. |

`codemode-deferred` is accepted as an alias for `codemode`.

Servers with `codemode` or `deferred` tools are listed in the `mcp_servers` section of the system prompt, with how their tools are reached and one line from the configured `description` or, once connected, from the server instructions. Pi updates the section when a prompt starts, after waiting for servers with `direct` tools. When it changed, for example because a server connected and its summary became available, Pi appends the new section to the conversation instead of changing tool declarations, so earlier messages stay cached. `describeNamespace()` and the `namespace` option of `searchTools()` accept `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or `dev_radius`.

Pi activates `codemode` when a server with `codemode` exposure connects. It activates `tool_search` for a server with `deferred` exposure. To make the model see a tool without searching, give it `direct` exposure with `toolExposure`.

`toolExposure` overrides the server exposure for individual tools. Keys are exact server tool names or patterns where `*` matches any characters. Exact names win over patterns; among patterns, the first match wins. A server with `hidden` exposure can expose only selected tools:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

`pi mcp list` marks tools whose exposure differs from their server. The Tools view in `/mcp` also shows the effective exposure.

Tools with `codemode` or `deferred` exposure can be reached through either indirect mechanism: codemode scripts can call them, and `tool_search` can load them. Codemode calls do not depend on the active tool set, so they remain available after `/tree`, resume, and fork. Tools loaded by `tool_search` are recorded in the transcript and remain declared on that branch.

To keep `codemode` active without MCP servers, add `"defaultTools": ["+codemode"]` to [settings](settings.md#tools). To prevent automatic codemode activation, set `"autoEnableCodemode": false` beside `mcpServers`. A project value overrides the user-level value. Pi warns once when neither `codemode` nor `tool_search` is active and non-direct tools cannot be called.

Text results over 20 KB reach the model with their middle removed around a `…N chars truncated…` marker. The full text is saved to a temporary file named in the result. Codemode scripts receive the complete result and can reduce it before returning output to the model.

Codemode scripts receive the complete MCP `CallToolResult`, including `content`, `structuredContent`, and `isError`. A result with `isError` resolves inside scripts but is reported as an error for direct calls. `image(result.content[0])` forwards an image block. Server instructions are not part of any tool description; scripts read them with `describeNamespace("mcp__<server>")`, which also returns the server's tool names.

## Use resources

When a connected server offers [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), Pi adds the resource tools used by Codex and OpenCode:

- `list_mcp_resources` lists resources as JSON: `{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`. With `server`, it lists one page; `cursor` continues with the next page. Without `server`, it lists every resource from every server.
- `list_mcp_resource_templates` lists URI templates for resources the servers do not list directly.
- `read_mcp_resource` reads a resource by `server` and `uri`. Text reaches the model as text and images as images. Other binary resources are saved to temporary files, and the model receives the path. Scripts receive `{ server, uri, contents }`.

These tools reach every enabled, non-hidden server with resources. Their exposure is the widest exposure among those servers: `direct`, then `codemode` or `deferred`. Resource links in tool results identify `read_mcp_resource` and the server.

Resources for MCP Apps, identified by `ui://` URIs or `text/html;profile=mcp-app`, are omitted because Pi does not render them. Resource icons are also omitted.

Reading and listing resources is retried once after a transient HTTP error (408, 429, or 5xx). Tool calls are not retried because the server may already have performed them.

## Permissions

Every MCP call passes through Pi's tool pipeline. Extension `tool_call` and `tool_result` handlers, including permission gates, therefore apply to MCP tools. Calls made from codemode scripts carry the codemode call ID as `parentToolCallId`.

`pi.getAllTools()` reports the annotations declared by each server: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Permission extensions can use these hints to decide which calls require confirmation (see [Tool exposure](extensions.md#tool-exposure)). Resource tools are marked read-only.

## Extensions and SDK

### Add servers from extensions

Extensions can add servers for the current session with `pi.registerMcpServer(name, config)`, using the same shape as an `mcpServers` entry (see [MCP servers in extensions](extensions.md#mcp-servers)). Registered servers connect like configured servers and appear in `/mcp` with the extension as their source.

Changes to enabled state or exposure apply only to the current session. A file-configured server with the same name takes precedence, and `/mcp` lists the overridden registration. `pi mcp` shell commands do not load extensions and only see file-configured servers.

### Replace the built-in MCP support

An installed extension that registers `/mcp`, such as `pi-mcp-adapter`, replaces the built-in MCP support for sessions. Pi then does not read `mcp.json` or connect its servers in a session, and `/mcp` belongs to the extension. Remove the extension to restore the built-in behavior. To disable built-in MCP support without a replacement, disable `mcp` under Built-in in `pi config`, or set `"extensions": ["-builtin:mcp"]` in [settings](settings.md#resources).

An extension that registers `codemode` or `tool_search` similarly replaces the built-in tool with that name. Shell-level `pi mcp` commands always use the built-in implementation.

### Use MCP from the SDK

SDK sessions do not load built-in extensions. Add the MCP extension, the codemode extension for `codemode` servers, and the tool-search extension for `deferred` servers to the resource loader. See [Codemode and MCP](sdk.md#codemode-mcp).
