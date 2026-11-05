# MCP for Durable and p2: work plan

This file is the brief for agents implementing MCP (Model Context Protocol) support for p2, the Durable-based app in
`apps/p2`. Every work package (WP) below is self-contained: it says where the work happens, what to build, how to test
it, and when it is done. Read sections 1 to 4 before any work package, then only the package you are given.

The human-readable plan with background lives at https://radius.earendil.com/artifact/01m6em2r8gercbx2rn2y8mwwpq
(revision 4). Where it and this file differ, this file wins.

---

## 1. Repository and rules

Everything is in `earendil-works/pi` (local checkout `~/Development/pi-mono`, branch `main`): the packages under
`packages/` (`env`, `mcp`, `durable`, `coding-agent`, `chord`, ...) and p2 at `apps/p2`. Until p2 moved there (commit
`05dc8d239`), it lived in the private repository `earendil-works/pi-private`, which is no longer used.

Rules (the repository's `AGENTS.md` overrides anything here):

- **Packages and p2 change together.** A fix to `packages/env` or `packages/mcp` found during p2 work is part of the
  same tree; it still gets its own commit and changelog entry.
- Several agents may work in the same checkout. Stage explicit paths only; never `git add -A`, `git stash`,
  `git reset --hard` or `git checkout .`.
- After code changes: `npm run check` from the repository root (formatting, lint, types), and after p2 changes also
  `cd apps/p2 && npm run check` (p2 is outside the root check). It must be clean except for
  errors you can show are unrelated and pre-existing. If it fails on missing modules or stale generated model data, run
  `npm install --ignore-scripts` and `npm run hydrate:model-data` first (this does not change tracked files).
- Tests: run the package's own tests, never the whole suite. From the package directory:
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts`.
  p2's tests use `node --test` (see `apps/p2/package.json`).
- The pi-env daemon is Rust: `cd packages/env/daemon && cargo fmt --check && cargo clippy --locked --all-targets -- -D
  warnings && cargo test --locked`. Also lint for Windows: `cargo clippy --locked --all-targets --target
  x86_64-pc-windows-msvc -- -D warnings`. Rebuild the debug daemon (`npm run build:daemon` in `packages/env`) before
  running pi-env's TypeScript tests.
- Public packages get a `CHANGELOG.md` entry under `## [Unreleased]` (`### Added`, `### Changed`, `### Fixed`).
- Commit only when asked, one commit per work package, message `feat(<scope>): ...` / `fix(<scope>): ...`.
- No `any`, no inline imports, erasable TypeScript only, no runtime checks of values TypeScript already guarantees;
  validate only at trust boundaries (wire input, configuration files, data from another process).

---

## 2. What we are building

p2 gets MCP servers. The design, in short:

- **One manager on the p2 server owns every MCP connection and process.** Session workers never spawn an MCP server or
  hold a credential. They talk to the manager through one Chord object per worker principal.
- **Placement.** A stdio server runs on the p2 host or on an execution environment from p2's `envs.json` (an SSH
  machine with the pi-env daemon). On an environment, the manager starts it through the daemon's `process` operation
  (WP1, done).
- **Instances.** Stdio servers run once per session and location by default; `"shared": true` in the owner's
  configuration makes one process for everybody. Streamable HTTP servers are shared by default.
- **Configuration.** The owner's `<P2_DATA_DIR>/mcp.json` (trusted) plus a project's `<cwd>/.pi/mcp.json`, which the
  worker reads at its location and sends to the manager (untrusted, restricted, see WP7).
- **Tools.** Workers turn the servers' tools into Durable tools named `mcp__<server>__<tool>`, deferred (found through
  `tool_search`) or callable only from code mode.
- **OAuth.** Only HTTP servers use MCP OAuth. Sign-in links point at p2 (`/mcp/sign-in/<id>`); when one is opened, p2
  picks the redirect from the request's principal: loopback (`http://127.0.0.1:<port>/callback`) for a browser on the
  p2 host, p2's `/mcp/callback` on the Radius or public origin otherwise, and pasting the final redirect URL always works.

```text
  worker host (session s1)                      server host
 ┌──────────────────────────────────┐          ┌──────────────────────────────────────────────────────┐
 │ MCP worker object                │  hold as │ p2.mcp: remote view, one per principal               │
 │  · reads .pi/mcp.json per        ├─────────►│  worker variant ──┐                                  │
 │    location via its ExecutionEnv │  worker  │                   ▼                                  │
 │  · contributes Durable tools     │  {s1}    │ p2.mcp.manager: local, host lifetime                 │
 └──────────────────────────────────┘          │  instances, leases, OAuth, pi-env connections        │
                                               │  owner variant ◄── web panel, TUI                     │
                                               └───────┬──────────────────┬──────────────────┬────────┘
                                         stdio on the p2 host   stdio on env "gpu"   Streamable HTTP
```

---

## 3. Status and order

| WP | Where | What | State | Depends on |
| --- | --- | --- | --- | --- |
| 1 | `packages/env` | daemon `process` operation, `openProcess()` | **done**: `9c9ce8547`, fix `032656b6c` | none |
| 2 | `packages/mcp` | transport over a byte pipe | **done**: `c158fa2ee` | none |
| 3 | `packages/mcp`, `packages/coding-agent` | OAuth sign-in split into start/complete, moved out of coding-agent | **done**: `bb266bf35`, fix `797e122cb` | none |
| 4 | `packages/mcp`, `packages/coding-agent` | shared naming and config helpers (optional) | **done**: `76c040a2a` | 3 |
| 5 | p2 | **gate:** p2's Chord v2 port has landed; WP1-3 present | **done**: p2 imported at `05dc8d239`, deps in "feat(p2): MCP servers on the host, on environments and from projects" | 1-3, the port |
| 6 | `apps/p2/plugins/mcp` | manager, view, worker object; owner config; host stdio and HTTP | **done**: "feat(p2): MCP servers on the host, on environments and from projects" | 2, 5 |
| 7 | `apps/p2/plugins/mcp` | environment placement; project `mcp.json` | **done**: "feat(p2): MCP servers on the host, on environments and from projects" | 1, 6 |
| 8 | `apps/p2/plugins/mcp` | OAuth: flows, routes, loopback, pasting; web and TUI | **done**: see section 4.7 | 3, 6 |
| 9 | `apps/p2/plugins/mcp`, `plugins/codemode` | code mode namespaces, progress, first-turn admission | open | 6 |

Section 4.5 lists where the built APIs of WP2-4 differ from sections 5-7, section 4.6 where WP6-7 differ from sections
9-10, section 4.7 where WP8 differs from section 11.

---

## 4. Facts every package relies on

### 4.1 WP1 (done): the daemon's `process` operation

In `packages/env` (commit `9c9ce8547`):

- Daemon: `packages/env/daemon/src/process.rs`; protocol in `packages/env/docs/protocol.md` (section on `process`).
- Client: `packages/env/src/process.ts`, exported from `@earendil-works/pi-env`:

```ts
export function openProcess(connection: Connection, options: ProcessOptions): Promise<RemoteProcess>;
export interface ProcessOptions {
	cwd: string;
	argv: readonly string[];           // run directly, no shell
	env?: Record<string, string>;      // added to the daemon's environment
	inheritEnv?: boolean;              // false: env is the whole environment
	onStdout: (bytes: Uint8Array) => void;
	onStderr?: (bytes: Uint8Array) => void;
}
export class RemoteProcess {
	readonly pid: number;
	readonly exited: Promise<number>;  // exit code; rejects (code "aborted") after close(), or on a lost connection
	write(data: Uint8Array | string): void;   // stdin, in order; dropped once stdin is closed or the program ended
	closeStdin(): void;                // after the input written before it
	close(): void;                     // kills the process group
}
```

- A daemon released before WP1 fails `openProcess` with `RemoteError` code `not_supported`
  (`hello.features` lacks `"process"`).
- A lost connection kills the program (the daemon kills everything it started).
- When the program exits on its own, the daemon kills what it left running in its process group (Unix) or its job
  object (Windows) before reporting the exit (`7367bc823`). Known gap on Windows: a child started before the daemon
  assigns the program to its job can escape (documented in `packages/env/docs/protocol.md`).
- **Windows:** like `exec` argv commands, batch files (`npx.cmd`, `uvx.cmd`) are refused; callers must start them
  through `cmd.exe` (WP7).

### 4.2 Durable pieces (public, `packages/durable`)

- `ToolRegistration` (`packages/durable/src/harness/types.ts`): `name`, `description`, `parameters` (JSON Schema object),
  `deferred?: true`, `callers?: ("model" | "tools")[]`, `replay?: "safe" | "unsafe"` (default unsafe),
  `structuredOutputSchema?`, `outputLimits?`, `execute(args, api, context)` returning `ToolExecutionResult`
  (`output`, `structuredOutput`, `isError`, `details`). `api.conversationId` and `api.env` identify the calling
  conversation and its execution environment.
- `createToolSearchExtension()` from `@earendil-works/pi-durable/tool-search`
  (`packages/durable/src/tool-search/tool-search.ts`): the `tool_search` tool that loads deferred tools.
- `createCodemodeExtension({ sandbox, namespaces })` from `@earendil-works/pi-durable/codemode`; `namespaces` are
  `{ name, description?, instructions?, prefix }` (`packages/durable/src/codemode/describe.ts`).
- A tool call whose tool is not registered right now waits until it is (`packages/durable/src/harness/agent.ts`,
  `addTools`), so a reconnecting MCP server does not fail a replayed call.

### 4.3 pi-mcp today (public, `packages/mcp`)

- `McpClient` (`src/client.ts`), transports in `src/transports/` (`stdio.ts`, `streamable-http.ts`, `in-memory.ts`,
  the `McpTransport` interface and `TransportEvents` in `transport.ts`), `toLlmContent()` (`src/protocol/content.ts`).
- OAuth in `src/oauth/`: `McpOAuthProvider` and `McpOAuthStateStore` (`provider.ts`; the state persists
  `codeVerifier` and `oauthState`, so a sign-in can complete in another request with the same store),
  `authorizeMcp` (`flow.ts`), `OAuthCallbackServer` (`callback.ts`), discovery and errors.
- No dependency on other pi packages, and only `cross-spawn` at runtime. Keep it that way.

### 4.4 p2 today and after the port

- p2 runs on Chord v2; Chord v1 is deleted.
- Chord v2 design: `packages/chord/docs/design.md`. The parts MCP uses: `local` objects with empty params (host
  lifetime, §5, §6), shared store with per-principal `remote` views (§6 "Pattern"), natives `self.open` (§13), routines
  `self.on`/`self.onLive` (§14), changing registry contributions with `self.writable` (§17; the design's own example is
  MCP tools), flows kept by their owner (§20), `ctx.incarnation` (§4), Chord calls from Durable code (§24).
- p2 code style for Chord v2 code: `AGENTS.md`, section "Chord v2 Code Style". Use the names the port introduces
  (harness extension registry, host addresses, principals, HTTP routing, login flow); do not invent parallel ones.
- Existing p2 precedents to copy: `apps/p2/plugins/ports` (a local store plus a remote view with owner and worker
  variants), `apps/p2/plugins/locations/server.ts` (worker-only methods fenced by the worker's generation),
  `apps/p2/plugins/terminals/main.ts` (the server opening its own pi-env connections per environment),
  `apps/p2/plugins/envs` (environment configuration, SSH options, host keys), `apps/p2/plugins/login` (provider OAuth
  with `remote: principal.access !== "local"`), `apps/p2/plugins/radius/relay-access.ts` (requests relayed through
  Radius), `apps/p2/plugins/powershell/worker.ts` (a deferred tool offered per conversation), `apps/p2/src/runtime/principals.ts`
  (`OwnerPrincipal.access` is `"local" | "relay" | "device"`). After the port these files move or change; find their
  v2 equivalents.

### 4.5 As built (WP2-4): differences from sections 5-7

- **WP2:** `PipeTransport`, `McpPipe`, `McpPipeHandlers`, `PipeTransportOptions` from `@earendil-works/pi-mcp`;
  pi-env's `RemoteProcess` is an `McpPipe` without an adapter. Shared framing in `src/transports/lines.ts`.
- **WP3:** `@earendil-works/pi-mcp/oauth` exports `startMcpSignIn`, `completeMcpSignIn`, `listenForLoopbackSignIn`,
  `waitForLoopbackSignIn`, `responseFromRedirectUrl`, `createMcpAuthProvider`, `McpSignInCancelledError`; files
  `sign-in.ts`, `loopback.ts`, `auth-provider.ts`, `client-settings.ts`. Differences:
  - `store` is an `McpOAuthServerStore` (with `withRefreshLock`); start and the auth provider take the lock, never
    call them while holding it.
  - `startMcpSignIn` returns `{ kind: "authorized" }` or a plain-data `McpSignInRedirect` (`authorizationUrl`,
    `redirectUrl`, `state`, `scope?`, all strings): store it with the flow.
  - `completeMcpSignIn({ ...sameOptionsAsStart, authorization, response })`: pass start's `redirectUrl` (not
    `authorization.redirectUrl`), the kept start result, and a response with `state` (checked). A sign-in replaced by
    a newer one is refused.
  - `clientMetadataDocuments: { baseUrl, listsRedirectUrl(url) }`; without it, dynamic registration only (p2 remote).
  - Start refreshes with the stored client first, whatever the redirect URI; `authorizeMcp` has `refreshOnly`, so a
    failed refresh never disturbs a pending sign-in (`3ffb210d9`: the refresh uses the app's `redirectUrl` when the
    documents list it; pass `redirectUrl` to `createMcpAuthProvider` too).
  - The store's `withRefreshLock` throws `McpRefreshLockBusyError` when the lock stays held (start then goes to the
    browser step); other lock errors fail the sign-in. Aborting ends the wait for the lock.
- **WP4:** from `@earendil-works/pi-mcp`: `createMcpToolName`, `mcpNamespace`, `normalizeMcpInputSchema`,
  `limitMcpContent(content, saveOutput?)`, `MCP_OUTPUT_MAX_BYTES`, `validateMcpServerConfig(name, raw, options?)`
  returning `{ kind: "stdio" | "http", config }` (unknown fields kept as `unknown`) or `{ kind: "invalid", error }`,
  `isMcpServerOverride`. Apps validate their own fields (p2: `shared`, `runOn`, project rules) on the result.
  `"cimd"` is refused unless `checkMetadataDocumentCallback` is passed (p2 should not pass it).

### 4.6 As built (WP6-7): differences from sections 9-10

- **Leases, not load/unload:** the worker variant has `setLocations({ locations, projects? })` (every location the
  session's conversations work at; leases elsewhere end) and `call({ location, server, tool, args })`; the manager has
  `setLocations` and `releaseLeases` with the caller's session, generation and incarnation. Worker state: `servers`
  and `errors` (the session's leases' project refusals).
- **Project files as text:** the worker sends `<cwd>/.pi/mcp.json` as read (`{ location, text }`, at most 256 KiB, or
  `{ location, error }` when unreadable; absent: none); the manager parses and checks it (`project.ts`) at each
  placement. A project override may also turn on an owner server that is `"enabled": false`.
- **Where sessions work:** a lease gets servers only on an environment its session works on as the server records it
  (the catalog's session, the subagent store's own locations). This fences stale or confused workers to their machines,
  not a compromised worker (see `McpManager`'s doc comment).
- **Environments:** connections through the envs plugin's SSH manager (`EnvManager.connection`), one per environment
  and revision; an instance on an environment that is its location's machine gets the location's cwd as its base and
  root, otherwise the remote home. Windows: the `cmd.exe` command line goes in `P2_MCP_COMMAND` (the daemon quotes argv
  itself and has no verbatim mode).
- **Not watched:** a changed project `mcp.json` is read again at the worker's next `setLocations` (a commit, a move,
  the view re-activating), not when the file changes.

### 4.7 As built (WP8): differences from section 11

- **Which servers sign in:** as in pi, an owner HTTP server without an `Authorization` header (`oauthServerOf` in
  `placement.ts`); its instances list `auth: "oauth"`. Only those wait for a sign-in on a 401 (`McpAuthRequiredError` or
  `McpOAuthAuthorizationRequiredError`), also when a call's tokens are refused for good; a server refusing its
  configured headers fails and retries instead.
- **Credentials:** `credentials.ts`, `<P2_DATA_DIR>/mcp-auth.json` through p2's `LockedFile` (0600), keyed like pi's
  (`mcpNamespace(name)|url`). The refresh lock is a promise chain per server in the process, not `proper-lockfile`: one
  p2 server owns a data directory (process lock), and nothing else reads this file.
- **Flows:** `sign-in.ts` (`SignIns`, a native of the manager), in memory, one per server (a new one replaces it),
  10 minutes each; listed (`signIns`: id, server, `via: "loopback" | "route"`, `waiting | failed`, error) in the
  manager's `Listed` document. Not a Chord flow object: the manager's methods are `beginSignIn`, `completeSignIn`
  (callback route), `pasteSignIn`, `cancelSignIn`, `signOut`, `probe`. A done flow disappears; the instances of its
  server restart (`Instances.reconnect`). A pre-registered client (`oauth.clientId`) always uses loopback.
- **Links by server, not flow:** `GET /mcp/sign-in/<server>` begins (or replaces) the server's flow, so the link is
  stable (the `mcp_servers` section and call errors name it). The owner view has no `signIn` returning a link: its
  `signIn({ server })` begins a loopback flow and returns the authorization URL (the TUI opens it); the web opens the
  route.
- **Where the browser runs (owner addition):** the device owner (`access: "local"` on loopback) always returns to
  loopback. Any other owner (Radius relay, an allowed public host) first gets a probe page (`pages.ts`): it fetches
  `http://127.0.0.1:<port>/<nonce>` from a listener on the p2 host (`probe.ts`), which answers 204 with CORS only for the
  page's origin and a nonce only this p2 issued. Answered: the browser runs on the p2 host, so `?via=loopback`; refused
  or blocked: `?via=callback`, the route on the origin p2 is reached through. While the answer takes more than 1.5 s
  (a browser asking for local network access), the page offers both. A wrong guess only means pasting.
- **Callback route:** `GET /mcp/callback` completes the route flow whose `state` matches, for owners only; a browser
  without p2's sign-in there (a cookie not sent) gets a page saying to paste its address.
- **Model:** the `mcp_servers` section marks servers waiting for a sign-in; a call of one says to sign in from the MCP
  panel or at `/mcp/sign-in/<server>`. Plain text: p2's Markdown renders relative links as text.
- **UI:** web `plugins/mcp/web.tsx` (sidebar footer "MCP": instances, restart, sign in, sign out, paste, cancel); TUI
  `/mcp` (Ctrl+R restart, Ctrl+S sign in through the launcher's `openUrl`, Ctrl+O sign out) and `/mcp paste <url>`.
- **Not verified by hand:** whether Radius sends its cookie on the redirect back to the cortex origin (section 14).

---

## 5. WP2: pi-mcp transport over a byte pipe

**Where:** `packages/mcp`.

**Why:** p2 runs stdio MCP servers on remote machines through `openProcess()` (WP1). pi-mcp must not depend on pi-env,
so it gets a transport over an abstract pipe that `RemoteProcess` satisfies without an adapter class.

**Build:**

1. `src/transports/lines.ts` (new): the newline-delimited JSON-RPC framing now inside `StdioTransport.handleStdout`
   (`src/transports/stdio.ts`): accumulate bytes, split at `\n`, strip a trailing `\r`, skip blank lines, enforce
   `maxMessageBytes` (default `DEFAULT_MAX_MESSAGE_BYTES`), parse with `parseJsonRpcMessage`, report errors. Plus the
   bounded stderr tail (`maxStderrBytes`, default 64 KiB). One class, used by both transports.
2. `src/transports/stdio.ts`: use `lines.ts`. Behavior must not change; `test/stdio.test.ts` must pass unmodified.
3. `src/transports/pipe.ts` (new), exported from `src/index.ts`:

   ```ts
   /** A running program's stdio, as `@earendil-works/pi-env`'s `RemoteProcess` provides it. */
   export interface McpPipe {
   	write(data: Uint8Array | string): void;
   	closeStdin(): void;
   	/** Kill the program (and what it started). */
   	close(): void;
   	/** Settles when the program has ended, whatever the reason. */
   	readonly exited: Promise<unknown>;
   }
   export interface PipeTransportOptions {
   	/** Start the program; `onStdout`/`onStderr` receive its output from then on. */
   	open(handlers: { onStdout(bytes: Uint8Array): void; onStderr(bytes: Uint8Array): void }): Promise<McpPipe>;
   	maxMessageBytes?: number;
   	maxStderrBytes?: number;
   	onStderr?: (chunk: string) => void;
   	/** After closing stdin, how long the program may take to exit before `close()` kills it. Default 2000. */
   	closeTimeoutMs?: number;
   }
   export class PipeTransport extends TransportEvents implements McpTransport { ... }
   ```

   - `start()` calls `open`; a rejection rejects `start()`. Once `exited` settles, an incomplete trailing message is an
     error (as in `StdioTransport`), then `emitClose()`.
   - `send()` writes `JSON.stringify(message) + "\n"`; after `close()` or the program's end it throws
     `McpConnectionClosedError`.
   - `close()`: MCP's stdio shutdown: `closeStdin()`, wait for `exited` up to `closeTimeoutMs`, then `close()`.
   - `stderr` getter with the tail, like `StdioTransport`.
4. README (`packages/mcp/README.md`): a short section with the pi-env example:

   ```ts
   const transport = new PipeTransport({
   	open: (handlers) => openProcess(connection, { cwd, argv, ...handlers }),
   });
   ```

5. `CHANGELOG.md`: `### Added` entry.

**Tests:** `test/pipe.test.ts` (new):

- with an in-memory fake `McpPipe`: framing (split chunks, several messages in one chunk, `\r\n`, blank lines), the size
  limit, an incomplete message at exit, `send` after close, the shutdown order (stdin closed first; `close()` only after
  the timeout; not at all when the program exits in time), `start` rejecting when `open` rejects;
- end to end: a `McpClient` over `PipeTransport` whose `open` spawns `test/fixtures/stdio-server.mjs` with
  `node:child_process` (a 20-line adapter in the test) completes `initialize`, `tools/list` and `tools/call`.

**Done when:** tests pass, `test/stdio.test.ts` unchanged and green, `npm run check` clean, README and changelog
updated. pi-mcp still has no dependency on pi-env.

---

## 6. WP3: OAuth sign-in split into start and complete, moved into pi-mcp

**Where:** `packages/mcp/src/oauth` (new code) and
`packages/coding-agent/src/extensions/mcp` (callers).

**Why:** p2 must run the same sign-in as `pi mcp login`, but the authorization code reaches p2 later and in another
request (its `/mcp/callback` route, a pasted URL, or a loopback server it runs). Today
`signInMcpServer` in `packages/coding-agent/src/extensions/mcp/oauth.ts` opens its own loopback server and waits.

**Read first:** `packages/coding-agent/src/extensions/mcp/oauth.ts` in full, `packages/coding-agent/src/core/mcp-servers.ts`
(`McpOAuthConfig`, `isLoopbackRedirectUri`, `isClientMetadataDocumentCallback`), its callers
`packages/coding-agent/src/extensions/mcp/index.ts` (`signIn`, around `runtime.signInMcpServer`) and `runtime.ts`, and
`packages/mcp/src/oauth/*`.

**Move into `packages/mcp/src/oauth/sign-in.ts`** (new; export from `src/oauth/index.ts`):

| Today in coding-agent `oauth.ts` | In pi-mcp | Change |
| --- | --- | --- |
| `McpOAuthSettings`, `callbackSettings`, `mergeScopes`, `timedFetch` | same names | none |
| `offersClientMetadataDocument`, `clientMetadataDocument`, `callbackId` | same | the document base URL (today `https://pi.dev/oauth`) and the application name (today `APP_NAME`) become options |
| `responseFromRedirectUrl` | exported | none |
| `createMcpAuthProvider` | exported | `McpOAuthServerStore.withRefreshLock` stays an interface; pi-mcp gets no lockfile dependency |
| `signInMcpServer` | split | see below |

The split:

```ts
/** First half: refresh if possible, else prepare the browser step. */
export async function startMcpSignIn(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	redirectUrl: string;                       // chosen by the caller: loopback, or an https callback route
	clientMetadataDocuments?: { baseUrl: string };   // omitted: dynamic registration only
	clientName: string;
	challenge?: OAuthChallenge;
	signal?: AbortSignal;
}): Promise<{ kind: "authorized" } | { kind: "redirect"; authorizationUrl: URL; redirectUrl: URL; state: string }>;

/** Second half: exchange the code. `response` from a callback server, a route, or `responseFromRedirectUrl`. */
export async function completeMcpSignIn(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	redirectUrl: string;                       // the one passed to start (the flow may have made it server-specific)
	response: { code: string; iss?: string };
	clientMetadataDocuments?: { baseUrl: string };
	clientName: string;
	signal?: AbortSignal;
}): Promise<void>;
```

- Keep every rule of today's function: a fresh `state` per sign-in; keep or drop the registered client depending on its
  redirect URI and `clientRegistration`; step-up scope (`stepUpScope`, `mergeScopes`); the server-specific redirect
  path for Client ID Metadata Documents (`/callback/<callbackId>`); timeouts through `timedFetch`; cancellation via
  `signal` reported as `McpSignInCancelledError` (move that class too).
- `OAuthCallbackServer` stays in pi-mcp; the loopback-listening part of today's function (`listenForCallback`,
  `waitForAuthorizationResponse`) becomes a small helper in pi-mcp, `waitForLoopbackSignIn(...)`, or stays in
  coding-agent if only it uses it. Decide by whether p2 needs it: p2 does (loopback for local browsers), so move it.
- coding-agent keeps: `McpOAuthCredentialStore` (`mcp-auth.json`, `proper-lockfile`, `AuthStorageBackend`, legacy
  keys), the callback page HTML, `pi mcp login`/`/mcp` UI. `signInMcpServer` in coding-agent becomes a thin wrapper:
  start, show the URL, wait for loopback or pasted URL, complete.

**Tests:**

- pi-mcp: `test/sign-in.test.ts` (new) with an authorization server built on `test/helpers.ts` (`listen`, `readBody`,
  `closeServers`) the way `test/oauth.test.ts` builds its servers, or on coding-agent's
  `packages/coding-agent/test/suite/mcp-oauth-server.ts` moved into pi-mcp's tests: start then complete in two calls with one store; complete with a
  pasted URL; refresh path returns `authorized`; metadata document chosen only when the server supports it and the
  redirect is one the documents list; a mismatched `state` or redirect path is rejected; cancellation.
- coding-agent: unchanged and green: `test/mcp-oauth-refresh.test.ts`, `test/suite/agent-session-mcp-oauth.test.ts`,
  `test/mcp-command.test.ts`, `test/mcp-extension.test.ts`.

**Done when:** pi-mcp exports the functions above; coding-agent's behavior is unchanged (its tests pass without
edits beyond imports); both changelogs updated (`packages/mcp/CHANGELOG.md` Added, `packages/coding-agent/CHANGELOG.md`
nothing user-visible, so no entry unless behavior changed).

---

## 7. WP4 (optional): shared naming and config helpers

**Where:** `packages/mcp` (new `src/naming.ts`, `src/config.ts`), callers in
`packages/coding-agent/src/core/mcp-servers.ts` and `src/extensions/mcp/tools.ts`.

**Why:** p2 must name tools exactly like pi, so `tool_search` ranking and code mode namespaces behave the same.

**Build:**

- `createMcpToolName(server, tool, isTaken)` and `mcpNamespace(server)` (today in coding-agent `extensions/mcp/tools.ts`
  and `core/mcp-servers.ts`), the input-schema normalization (object type, `properties` present) and the result size
  limit (`MCP_OUTPUT_MAX_BYTES`, `limitMcpContent`) without pi-tui rendering.
- Parsing and validation of the standard `mcpServers` shape: stdio (`command`, `args`, `env`, `cwd`), HTTP (`url`,
  `headers`), `oauth`, `enabled`. pi-only fields (`exposure`, `toolExposure`, `auth.provider`, `autoEnableCodemode`) stay
  in coding-agent, which extends the shared parser.

**Done when:** coding-agent imports these from pi-mcp with no behavior change (its MCP tests pass); pi-mcp tests cover
the moved functions.

If skipped, WP6 copies `createMcpToolName` and `mcpNamespace` into p2 and notes the duplication.

---

## 8. WP5 (gate): p2 on Chord v2, packages present

Not MCP work, done. Before WP6:

1. p2 imports Chord v2 (`rg -l "@earendil-works/chord/old" apps/p2` finds nothing).
2. WP1-3 (and 4) are in the tree p2 builds against.
3. Add `"@earendil-works/pi-mcp": "<current version>"` and `"@earendil-works/pi-env"` (if p2 does not have it yet) to
   `apps/p2/package.json`; refresh the lockfile with `npm install --package-lock-only --ignore-scripts`; commit lockfile
   changes with `PI_ALLOW_LOCKFILE_CHANGE=1`.

---

## 9. WP6: manager, view and worker object (host stdio and HTTP)

**Where:** `apps/p2/plugins/mcp/` (new plugin; register it where the port registers built-in
plugins). Tests in `apps/p2/test/p2/mcp*.test.ts`.

**Files** (one concept per file, per "Chord v2 Code Style"):

| File | Content |
| --- | --- |
| `contract.ts` | the `p2.mcp.manager` local contract, the `p2.mcp` remote contract, schemas (`Location`, `Instance`, `Tool`, `ProjectConfig`, `CallResult`, `SignInFlow`) |
| `config.ts` | reading and validating `<P2_DATA_DIR>/mcp.json` (trust boundary), following changes |
| `instances.ts` | the supervisor native: instances keyed per section 9.2, leases, connect, reconnect with backoff, tool-list changes |
| `server.ts` | the facet: serves the manager and the view |
| `worker.ts` | the worker object: holds the view, loads locations, contributes the Durable extension |
| `tools.ts` | MCP tool → Durable `ToolRegistration` |

### 9.1 Contracts

```ts
const Location = obj({ env: union([str(), nul()]), cwd: str() });   // p2's location; env null: the p2 host
const Instance = obj({
	id: str(),
	server: str(),
	source: oneOf("owner", "project"),
	location: union([Location, nul()]),          // null: shared, or HTTP
	runsOn: union([literal("host"), obj({ env: str() })]),
	status: oneOf("starting", "connected", "sign-in", "failed"),
	error: opt(str()),
	tools: arr(Tool),                             // name, title, description, inputSchema, annotations
});

export const McpManager = local("p2.mcp.manager", {
	version: 1,
	params: {},
	members: {
		instances: arr(Instance),
		load: method(obj({ session: str(), location: Location, project: union([ProjectConfig, nul()]) }), Loaded),
		unload: method(obj({ session: str(), location: Location })),
		release: method(obj({ session: str() })),
		call: method(obj({ session: str(), instance: str(), tool: str(), args: JsonObject }), CallResult),
		restart: method(obj({ instance: str() })),
		// sign-in members: WP8
	},
});

export const Mcp = remote("p2.mcp", {
	version: 1,
	hostAddress: /* the server, as the port addresses it */,
	params: {},
	variants: {
		worker: {
			state: { servers: arr(Instance) },
			methods: { load, unload, call },        // session filled in by the view from the principal
		},
		owner: {
			state: { instances: arr(Instance) },
			methods: { restart },
		},
	},
});
```

- The view's factory returns the worker variant for a worker principal, the owner variant for an owner. Guests and
  other principals get no access: authority checks live in the view's methods (design §7).
- Worker calls carry the caller's incarnation (`ctx.incarnation`); the manager records the incarnation that loaded each
  lease and refuses calls from an older one.
- `servers` is a derive over the manager's `instances` filtered to the principal's session plus the shared instances
  the session uses.

### 9.2 Instances

| Kind | Default | Key | Notes |
| --- | --- | --- | --- |
| stdio, `shared` unset | per session | `(session, location, server, config hash)` | roots: the location's cwd |
| stdio, `"shared": true` | opt-in, owner config only | `(server, runsOn, config hash)` | configured roots; state shared by all sessions |
| Streamable HTTP | shared | `(server, config hash)` | `"shared": false`: one per session, still in the server |

- The configuration hash covers command, args, env, cwd and URL.
- **Leases:** each view holds leases on the instances it loaded. `unload` releases one location; when the view ends
  (its worker's reference went with the link, after `linger`), a native of the view releases all of them through
  `release`. Unshared instances close with their last lease; shared instances stay while any lease or owner entry needs
  them.
- **Reconnect:** a lost connection reconnects with exponential backoff (1 s doubling to 60 s); tools stay listed while
  reconnecting (status `starting`), calls fail with a clear error. A tool-list-changed notification refreshes `tools`.
- **Shutdown:** closing an instance closes its client; stdio follows MCP's shutdown (stdin closed, then kill), which
  `StdioTransport` and `PipeTransport` implement.

### 9.3 Host stdio and HTTP in this package

- Host stdio: `StdioTransport` from pi-mcp (`runOn: "host"`, and `"location"` for local sessions).
- HTTP: `StreamableHttpTransport` with headers from the owner config (`${VAR}` from the p2 host's environment, owner
  config only). OAuth arrives in WP8; until then an HTTP server that answers 401 shows status `sign-in`.
- `McpClient` options: `name: "p2"`, version from p2's package, `roots` from the instance's location cwd for unshared
  instances (`file://` URL), none for shared ones.

### 9.4 Worker side

- A local, host-lifetime object in the worker holds `Mcp` (the server sees it as `worker{session}`).
- At start and after every relocation of the session, and for every subagent with its own location: read
  `<cwd>/.pi/mcp.json` through that location's `ExecutionEnv` (`readTextFile`; absent file: `project: null`), call
  `load`. Call `unload` for locations nothing works at any more.
- Contribute one Durable `Extension` through the harness extension registry as a `self.writable`; `self.on(view.servers,
  ...)` rebuilds it. Tools:
  - name via `createMcpToolName` (WP4, else copied), description from the MCP tool, `parameters` normalized to an object
    schema;
  - exposed as pi's default (`"exposure": "codemode"`): `deferred: true` and `callers: ["tools"]`, so only code mode
    scripts call them (`searchTools()` finds them; neither the `codemode` section nor `tool_search` lists them). While
    code mode is off or its plugin is not loaded (its `ExtensionSwitches` entry is not `true`), pi's fallback:
    `deferred: true` alone, loaded through `tool_search`;
  - the `mcp_servers` section, as pi's: each server's namespace and how its tools are reached (no summaries yet: p2
    has no `description` field and does not pass on the servers' `instructions`);
  - `execute`: locate the calling conversation (`api.conversationId`, through the harness's environments), pick the
    instance for that location, call `view.call` from Durable code (design §24's helper), convert the result with
    `toLlmContent()`, pass `structuredContent` through as `structuredOutput` only if the tool declares an output schema,
    `isError` from the MCP result; replay stays `unsafe`.
- Install `createToolSearchExtension()` only while it reaches the MCP tools (code mode off, servers present), as pi
  activates `tool_search` only for `deferred` servers. Per-server `exposure` and `toolExposure` are not read yet.

### 9.5 Owner configuration (`<P2_DATA_DIR>/mcp.json`)

```json
{
	"mcpServers": {
		"filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
		"browser": { "command": "npx", "args": ["-y", "@playwright/mcp"], "shared": true, "runOn": "host" },
		"tools-on-gpu": { "command": "/opt/tools/mcp", "runOn": { "env": "gpu" } },
		"docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
	}
}
```

`runOn`: `"location"` (default for unshared stdio: where the conversation works), `"host"` (default for shared), or
`{ "env": "<name in envs.json>" }`. Until WP7, `"location"` on a remote session and `{ env }` show status `failed` with
"environments arrive in WP7".

**Tests** (`apps/p2/test/p2/mcp.test.ts`, `node --test`), with `test/fixtures/stdio-server.mjs`-style fixture servers
copied or referenced from pi-mcp:

- owner config loads; invalid entries are reported and skipped;
- a session loads; its worker gets the tools; a call returns the result; `tool_search` finds the tool;
- two sessions get two processes for an unshared server and one for a shared server;
- unload and view end close unshared instances; shared ones survive;
- an older worker incarnation's call is refused;
- a crashed server reconnects with backoff and its tools come back;
- a guest gets nothing.

**Done when:** the tests pass, `npm run check` clean, and a manual run (throwaway session under `/tmp`, separate data
dir and port, per "No hand tests on real sessions" in `apps/p2/docs/handoff.md`) shows an MCP tool used by the agent.

---

## 10. WP7: environment placement and project configuration

**Where:** `apps/p2/plugins/mcp/` (`instances.ts`, new `placement.ts`, `config.ts`).

### 10.1 Placement on environments

- For `runOn: "location"` on a remote session and for `{ env }`, the manager opens one pi-env `Connection` per
  environment, built from the envs plugin's configuration, SSH options and known hosts, as
  `apps/p2/plugins/terminals/main.ts` does with `sshConnection(...)`. One connection per environment, shared by all
  instances there; closed when no instance uses it.
- Start the server with `openProcess(connection, { cwd, argv, env, onStdout, onStderr })` behind pi-mcp's
  `PipeTransport` (WP2).
- `openProcess` failing with `not_supported`: status `failed`, error "the pi-env daemon on <env> is too old; update it"
  (pi-env deploys its packaged daemon by hash, so a p2 update usually fixes it).
- **Windows environments** (`nodePlatform(await connection.info()).platform === "win32"`): resolve the program; if it is
  not an `.exe`/`.com` (for example `npx`, which is `npx.cmd`), run it as `["cmd.exe", "/d", "/s", "/c", <quoted command
  line>]`. Quote like `cross-spawn` does for cmd (escape `^&|<>()%!"` meta characters). Unit-test the quoting.
- `runOn: "location"` on a local session uses the host path (WP6).

### 10.2 Project configuration

The worker sends `<cwd>/.pi/mcp.json` with `load`; the manager validates it at that boundary. Project entries are
untrusted (a repository wrote them, and the agent can edit them). Rules:

| Rule | Why |
| --- | --- |
| stdio runs at its location only; `runOn` and `shared` are refused | the agent can already run commands there; anywhere else a repository would gain code execution on the p2 host or another machine |
| no `${VAR}` from the p2 host's environment | a project could otherwise put the host's secrets in a header or argument; variables in `env` resolve at the location |
| no `auth.provider`, no reuse of another server's OAuth client | as in pi: a repository does not choose where a credential goes |
| an entry without `command`/`url`/`type` only overrides `enabled` of the owner entry with the same name | as in pi (`packages/coding-agent/src/extensions/mcp/config.ts`) |
| HTTP entries: **refused** in this WP | open decision (section 14); the p2 host would make the requests, so a project could reach addresses only the host can see |

**Tests:** placement on a local "environment" through the local daemon (`localDaemon()`, as pi-env's tests do) so no
SSH is needed: a server on an environment starts, its tools appear, calls work, the connection is shared by two
instances, closing the last instance closes the connection; project rules each refuse what they should; Windows
quoting unit tests.

---

## 11. WP8: OAuth flows, routes, loopback, pasting; web and TUI

**Where:** `apps/p2/plugins/mcp/` (new `sign-in.ts`, routes in `server.ts`, `web.tsx`,
`tui.ts`). The web UI is p2 code again (`apps/p2/plugins/*/web.tsx`, `apps/p2/src/web`), ported with p2.

**Credential store:** `<P2_DATA_DIR>/mcp-auth.json`, private (0600), keyed by server name and URL, with a refresh lock
(`proper-lockfile`, already a p2 dependency) implementing pi-mcp's `withRefreshLock`. Tokens never leave the server.

**Flow** (a Chord flow kept by the manager, design §20: `start` → id; state with the current step; `answer`; `cancel`):

1. An HTTP instance gets `McpOAuthAuthorizationRequiredError` → status `sign-in`. The tool error tells the model to ask
   the user to sign in and gives the link from the worker's `signIn`.
2. `signIn({ instance })` (worker and owner variants) starts a flow and returns `{ id, link: "/mcp/sign-in/<id>" }`. The
   link is relative, so it opens on the origin the viewer uses.
3. Route `GET /mcp/sign-in/<id>` (owners only): read the request's principal and choose the redirect:

   | Principal | Redirect URI | Code arrives through | Registration |
   | --- | --- | --- | --- |
   | `owner`, `access: "local"` | `http://127.0.0.1:<port>/callback` (pi-mcp `OAuthCallbackServer` on the p2 host) | the loopback server | pi.dev Client ID Metadata Documents when supported, else dynamic registration |
   | `owner`, `access: "relay"` | `https://<cortex origin>/mcp/callback` (from `radius/relay-access.ts`) | route `GET /mcp/callback` | dynamic registration |
   | `owner`, `access: "device"` on an allowed public host | `https://<P2_PUBLIC_URL host>/mcp/callback` | route `GET /mcp/callback` | dynamic registration |

   Then `startMcpSignIn` (WP3) and answer 302 to the authorization URL. `authorized` (a refresh worked): redirect back
   to p2 with a success page.
4. `GET /mcp/callback?code&state&iss` (owners only): find the flow by `state`, `completeMcpSignIn`, reconnect the
   instance, show a success page. The flow is done; its state shows it.
5. Pasting: the owner variant's `answer({ id, step, redirectUrl })` uses `responseFromRedirectUrl` then completes. The UI
   always offers it (an `ssh -L` port forward looks `local` but the browser is elsewhere).

**UI:**

- Web (`plugins/mcp/web.tsx`): an MCP panel next to Providers: servers with status and errors, tools count, restart,
  sign in (opens the link), sign out, paste the redirect URL while a flow waits.
- TUI (`plugins/mcp/tui.ts`): the same as a command/overlay; opening the link uses the launcher's open-URL grant.
- Sign-in links in the transcript are ordinary relative links.

**Tests:** a fake authorization server and MCP HTTP server (the one WP3's tests use): a 401 makes status `sign-in`;
the sign-in route as a local principal starts a loopback flow; as a relay/device principal it uses `/mcp/callback`;
the callback completes and the tools appear; a wrong `state` is refused; pasting completes; guests are refused on both
routes; tokens refresh without a browser. Verify by hand once through Radius that the cortex origin's cookie is sent on
the redirect back (section 14).

---

## 12. WP9: code mode namespaces, progress, first-turn admission

**Where:** `apps/p2/plugins/codemode/` (namespaces), `apps/p2/plugins/mcp/`.

- **Namespaces:** one `CodemodeNamespace` per server (`name` = server, `prefix` = `mcpNamespace(server) + "__"`,
  `description` from the server's `instructions` in `initialize`, if any) fed into `createCodemodeExtension` from the
  `servers` state, through a registry the MCP plugin contributes to or a getter read at use (as codemode already does for
  its sandbox).
- **Progress:** Chord calls return one result. Default: no MCP progress in the first version. If wanted: the manager
  writes progress per call into a state document the worker follows and forwards through Durable's `api.output()` or
  `details()`.
- **First turn:** decide whether p2's admission check waits for MCP servers still `starting` (default: wait up to 10 s
  for instances of the session's location, then go on; deferred tools appear later through `tool_search`).

---

## 13. Things that are easy to get wrong

- A fix to `packages/env` or `packages/mcp` found during p2 work is its own commit, with its package's changelog entry.
- Do not run MCP processes in session workers. Everything that spawns, connects or holds a token is in the manager.
- Do not trust project `mcp.json`: validate at the manager, apply section 10.2.
- Tool names must match pi's (`createMcpToolName`), including the hash suffix for long names.
- Windows: `npx`/`uvx` are batch files; host stdio uses `cross-spawn` through `StdioTransport` (fine), environments need
  the `cmd.exe` wrapping (WP7).
- The daemon kills a remote server when its connection drops; reconnect logic must expect that and restart it.
- Never print tokens, cookies or sign-in URLs with codes in logs.

---

## 14. Open decisions (defaults to use until decided)

| Decision | Default in this plan |
| --- | --- |
| Per session or per agent | per session and location; one-shot agents share their session's instance |
| Project HTTP servers | refused |
| Remote client registration | dynamic registration; per-brain metadata documents from Radius only if needed later |
| Host stdio transport | `StdioTransport` (cross-spawn); the local daemon only if a reason appears |
| MCP progress | not in the first version |
| First-turn admission | wait up to 10 s for the session's starting instances |
| Radius cookie on the redirect back | verify by hand in WP8; if it is not sent, relayed browsers fall back to pasting |
