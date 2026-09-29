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

- stdio servers take `command`, `args`, `env`, and `cwd`. Relative `cwd` resolves against the session directory. A leading `~/` in `command`, an argument, or `cwd` names the home directory.
- HTTP servers take `url`, `headers`, and `oauth` (see [Sign in with OAuth](#sign-in-with-oauth)). The legacy SSE transport is not supported.
- `env` and `headers` values can reference environment variables (`${NAME}`) or commands (`!command`), like provider API keys.
- `timeout` sets the per-request timeout in seconds (default 60). Progress notifications from the server reset it.
- `enabled: false` keeps an entry without connecting to it.

Project entries replace global entries with the same name. A project `mcp.json` is only read after the project is trusted, because stdio servers run commands.

`pi mcp add` and `pi mcp remove` edit the file from a shell (see [MCP commands](cli.md#mcp-commands)):

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN --exposure direct
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
pi mcp remove docs
```

Rules that are easy to get wrong:

- Server names may only contain letters, digits, `_`, and `-`. Tools are named `mcp__<server>__<tool>`.
- `type` is optional: a `command` makes a stdio server and a `url` a streamable HTTP server. When present, it must be `stdio`, `http`, or `streamable-http`. `sse` is rejected; most servers that document an SSE endpoint also serve streamable HTTP, often at `/mcp` instead of `/sse`.
- `command` is a single executable and `args` its arguments, not one shell string.
- Keep secrets out of the file: use `${NAME}` for environment variables, as in `"Authorization": "Bearer ${GITHUB_TOKEN}"`, or `!command` to run a command. A command must make up the whole value, so it has to print the header value itself: `"Authorization": "!echo Bearer $(gh auth token)"`.
- Invalid entries are skipped and reported; the other servers still connect.

## Set up servers

When asked to add an MCP server, the agent should:

1. Add simple servers with `pi mcp add` (add `-l` for the project file), or edit `mcp.json` directly for settings the command does not cover. Put personal servers and servers with credentials in `~/.pi/agent/mcp.json`. Use the project `.pi/mcp.json` only for servers the project itself needs, and only in trusted projects.
2. Convert entries written for other clients:
   - Claude Desktop, Claude Code, and Cursor use the same `mcpServers` shape; copy the entry.
   - VS Code uses a top-level `servers` object and `inputs` prompts; move the entry under `mcpServers` and replace `${input:...}` with `${NAME}` environment variables.
   - Codex uses TOML (`[mcp_servers.<name>]` with `command`, `args`, `env`, or `url`); write the same fields as JSON.
   - opencode uses `"type": "local"` with `command` as an array (split it into `command` and `args`), `"type": "remote"` for URLs, `environment` for `env`, and `{env:NAME}` for `${NAME}`.
3. Run `pi mcp list` to check the entry. It connects to every enabled server and prints the state, the tools, and errors such as the stderr of a stdio server that failed to start. It exits with 1 while anything is wrong.
4. For a server that needs a sign-in, run `pi mcp login <server>`. It opens the authorization page in the user's browser and waits until the user approves access; tell the user to approve it. A running session uses the new credentials on its next turn.
5. Tell the user to run `/reload` (or start a new session) so the running session connects to added or changed servers.

Pi connects when a session starts. The first prompt waits up to 10 seconds for startup connections; the tools of servers that take longer become available once they connect. HTTP connections that fail with a network error or a transient status (408, 429, 5xx) are retried twice. A server that drops its connection shows as disconnected and is reconnected on the next call. When a server announces that its tool list changed, new tools are added and withdrawn tools become unreachable until the server offers them again.

Config errors, servers that failed to connect, and servers that need a sign-in are reported once after startup.

Log messages servers send with MCP logging notifications are appended to `~/.pi/agent/mcp.log` as `<time> [<server>] <level> <logger>: <message>`. The file is moved to `mcp.log.1` when it grows past 5 MB.

## Manage servers

`/mcp` opens the server manager. It lists every configured server with its state, tool count, exposure, and whether it comes from the global or the project `mcp.json`; servers that need attention come first. Select a server to:

- sign in, for OAuth servers that need it (see [Sign in with OAuth](#sign-in-with-oauth))
- see its tools, its command or URL, and the full connection error, including the tail of a stdio server's stderr
- reconnect
- sign out, which deletes the stored OAuth credentials
- change its exposure (see [Exposure](#exposure))
- disable or enable it

Exposure changes and enabling or disabling are saved to the `mcp.json` that defines the server; other content of the file is kept. Disabled servers stay listed so they can be enabled again.

Outside the interactive TUI, `/mcp` prints the server status. `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` run those actions directly.

From a shell, `pi mcp add`, `pi mcp remove`, `pi mcp list`, `pi mcp login <server>`, and `pi mcp logout <server>` manage servers without a session (see [MCP commands](cli.md#mcp-commands)).

Stopping a stdio server closes its stdin, then sends SIGTERM and finally SIGKILL to its whole process group, so servers started through wrappers such as `npx` or `uvx` do not linger.

## Sign in with OAuth

Remote servers that use OAuth, such as Sentry, need no credentials in `mcp.json`:

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

When such a server rejects the connection, `/mcp` shows it as needing sign-in. Select it and choose "Sign in" (or run `/mcp login sentry`, or `pi mcp login sentry` in a shell) to open the authorization page in your browser. After you approve access, the browser redirects to a temporary server on `127.0.0.1` and pi connects. If the browser runs on another machine, for example over SSH, paste the URL it was redirected to into the sign-in screen instead.

Pi registers itself with the authorization server (dynamic client registration), stores tokens in `~/.pi/agent/mcp-auth.json`, and refreshes access tokens automatically when they expire or the server rejects them. If the server later asks for more scope than was granted, it shows as needing sign-in again, and signing in requests the new scope. "Sign out" in `/mcp` (or `/mcp logout sentry`) deletes the stored credentials.

OAuth applies to HTTP servers without an `Authorization` header. For authorization servers that do not support dynamic client registration, configure a pre-registered client:

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

The redirect URI must match the one registered for the client. `callbackPort` fixes it to `http://127.0.0.1:<port>/callback`. For another redirect URI, set `callbackUrl`, for example `"callbackUrl": "http://localhost:8080/oauth/callback"`. It must be an `http` URI on `localhost`, `127.0.0.1`, or `[::1]`, and is sent exactly as written. Without a port in `callbackUrl`, pi listens on `callbackPort`, or on a free port, and adds it to the URI; authorization servers accept any port for loopback redirects (RFC 8252). `clientSecret` is optional and can reference environment variables or commands.

`scope` sets the scopes to request, separated by spaces, for servers that do not advertise the ones they need. Without it, pi requests the scopes the server advertises. When a server later asks for more scope, pi requests those on top of `scope`.

## Exposure

Each server's tools are registered as `mcp__<server>__<tool>`. The `exposure` setting controls how the model reaches them:

- `codemode` (default): the tools are callable from [`codemode`](cli.md#tools) scripts and listed in the `codemode` tool's description, but are not declared to the model. Large MCP tool lists stay out of the model's tool declarations, and scripts can call several MCP tools, in parallel if needed, while returning only the part of the result the model needs. Pi activates the `codemode` tool when such a server connects. Large servers do not fill the description: declarations share a token budget, and scripts find the remaining tools with `searchTools()` (see [`codemode`](cli.md#tools)).
- `codemode-deferred`: like `codemode`, but the tools are not listed in the `codemode` tool's description either; it only names the server and its tool count. Scripts call them by name and find them with `searchTools()` or in `ALL_TOOLS`. Use it for large servers that codemode scripts use rarely.
- `deferred`: the tools are not declared to the model until the [`tool_search`](cli.md#tools) tool loads them. The model searches, and the matches are declared from its next call on and called directly, without codemode. Pi activates the `tool_search` tool when such a server connects. Use it for large servers without codemode.
- `direct`: the tools are declared to the model like built-in tools, and are also callable from codemode.
- `hidden`: the tools are registered but cannot be called.

`toolExposure` sets the exposure of single tools and overrides `exposure` for them. Keys are tool names as the server offers them, or patterns where `*` matches any characters. An exact name wins over patterns; among patterns, the first match in the object wins. With `hidden` as the server's exposure, only the listed tools are reachable:

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

`pi mcp list` marks tools whose exposure differs from the server's, and the Tools view in `/mcp` shows it too.

Tools that are not declared (`codemode`, `codemode-deferred`, and `deferred` exposure) are reachable through either tool: codemode scripts can call all of them, and `tool_search` can load any of them. For example, with `codemode` active, scripts can call the tools of a `deferred` server, and with `tool_search` active, the model can load the tools of a `codemode` server.

Tools called from codemode scripts do not depend on the active tool set, so they stay callable after `/tree`, resume, and fork. Tools loaded by `tool_search` are recorded in the transcript like any other tool change and stay declared on that branch. To keep pi from activating the `codemode` tool, set `"autoEnableCodemode": false` at the top level of `mcp.json`, next to `mcpServers`. A project `mcp.json` value overrides the global one. Pi warns once when neither `codemode` nor `tool_search` is active, since the tools then cannot be called.

Text results over 20KB reach the model with the middle cut out, in the format Codex uses: the start and end of the text around a `…N chars truncated…` marker. The full text is saved to a temp file whose path the result names. Codemode scripts always receive the whole result, so a script can filter a large result down to what the model needs.

Codemode scripts receive an MCP tool's whole `CallToolResult` (`content` blocks as sent by the server, `structuredContent`, and `isError`), and the `codemode` description declares it as `CallToolResult<T>`. A result with `isError` resolves in scripts and is reported to the model as an error for direct calls. `image(result.content[0])` forwards an image block to the model. The server's `instructions` describe its tools in the `codemode` description.

## Resources

When a connected server offers [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), pi adds the resource tools Codex and opencode use:

- `list_mcp_resources` lists resources as JSON: `{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`. With `server`, it lists one page of that server, and `cursor` continues with the next one. Without, it lists every resource of every server.
- `list_mcp_resource_templates` lists URI templates for resources the servers do not list, in the same way.
- `read_mcp_resource` reads a resource given `server` and `uri`. Text resources reach the model as text and images as images; other binary resources are saved to temp files, and the model sees the file path. Scripts receive `{ server, uri, contents }`.

The tools reach every enabled server with resources whose exposure is not `hidden`, and take the widest exposure among them: `direct` if one of the servers is direct, else `codemode`, else `codemode-deferred`, else `deferred`. Resource links in tool results name `read_mcp_resource` and the server.

Resources for MCP Apps (`ui://` URIs or `text/html;profile=mcp-app`) are left out of the listings, since pi does not render them, and so are resource icons.

Reading and listing resources is retried once after a transient HTTP error (408, 429, 5xx). Tool calls are not retried, since the server may have run them.

## Permissions

Every MCP call goes through pi's tool pipeline, so `tool_call` and `tool_result` extension handlers, including permission gates, apply to MCP tools. Calls made from codemode scripts carry the `codemode` call's id as `parentToolCallId`. `pi.getAllTools()` reports the tool annotations servers declare (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a permission extension can confirm only calls that change something (see [Extensions](extensions.md#tool-exposure)). The resource tools are marked read-only.

## Servers from extensions

Extensions can add servers for the current session with `pi.registerMcpServer(name, config)`, using the same config shape as `mcp.json` (see [Extensions](extensions.md#mcp-servers)). They connect like configured servers and appear in `/mcp` with the extension as their source. Enabling, disabling, and exposure changes for them apply to the current session only. A server in `mcp.json` with the same name takes precedence; `/mcp` lists the overridden registration. `pi mcp` shell commands do not load extensions and only see `mcp.json` servers.

## Other MCP extensions

An installed extension that registers the `/mcp` command, such as `pi-mcp-adapter`, replaces the built-in MCP support: pi then neither reads `mcp.json` in sessions nor connects servers, and `/mcp` belongs to that extension. Remove the extension to use the built-in support. To turn off the built-in support without installing another extension, disable `mcp` under Built-in in `pi config`, or set `"extensions": ["-builtin:mcp"]` in [settings](settings.md#resources); `pi mcp` shell commands still work. Likewise, an extension that registers a tool named `codemode` or `tool_search` replaces the built-in tool of that name. `pi mcp` shell commands always use the built-in support.

## SDK

SDK sessions do not load the built-in extensions. Add the MCP extension, the codemode extension for `codemode` and `codemode-deferred` servers, and the tool search extension for `deferred` servers to the resource loader. See [SDK](sdk.md#codemode-mcp).
