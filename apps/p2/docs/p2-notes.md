# p2 notes

Current reference for p2: running, configuration, decisions and plugin notes. Runtime: Chord v2 (p2 runs on Chord v2
only), its [design](../../../packages/chord/docs/design.md) and [tutorial](../../../packages/chord/docs/tutorial/);
how p2 uses it: **Chord v2** below.

## TODO

- **TypeScript 5.9.3 pin:** p2 pins `typescript` 5.9.3 (nested in `apps/p2/node_modules`, a devDependency used only by
  `npm run check`; nothing imports it at runtime) only because the repo's TypeScript 7 has no Android ARM64 build, so
  `npm run check` could not type-check on Termux. Move p2 to the repo's
  TypeScript (drop the pin and the nested copy) once a portable TS 7 exists or checks run off-device; same for
  apps/mobile.
- **TUI plugins:** the TUI still loads its facets with p2's own bundle and a `host.load` in the sandbox, not through
  Chord's plugins component (C2: Chord's child-process sandbox for the launcher).
- **Guest TUI isolation:** the owner superseded the earlier QuickJS/secure-eval-worker plan with a plain locked-down
  Node worker, Node >=26.5.1 (verified on 26.11.1). Permission drops run in the trusted bootstrap before any data-URL
  bundle import. The launcher retains terminal, transport and credentials. Denial of service is explicitly accepted;
  V8 limits and an RSS/ArrayBuffer watchdog mitigate it without an OS sandbox. See **TUI** and README threat model.

## Running

```sh
cd apps/p2
P2_FAKE=1 npm start          # http://127.0.0.1:8788, data in ~/.pi/p2
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `P2_DATA_DIR` | `~/.pi/p2` | data directory: `server/` and `sessions/<id>/` (see **Host stores and files**), `settings.json`, `models.json`, `envs.json`, `projects.json`, `mcp.json`, `mcp-auth.json`, `auth.json`, `radius.json`, `forwards.json` |
| `PORT` | `8788` | listen port (loopback only), so p2 never collides with pi-mobile on 8787 |
| `P2_FAKE` | unset | `1`: the faux provider (`faux/faux-1`, echoes the prompt; `slow …` streams long; `rename-session <title>` calls the tool; `subagent`, `subagent-bad`, `subagent-answer`, `subagent-configure`, `subagent-send`, `subagent-archive`, `subagent-status` exercise subagents, `subagent <json>` calls the tool with those arguments, as do `team <json>`, `history_search|read|handoff <json>`, `location_envs|dirs|move <json>`, `tool_search <json>`, `terminal <json>` and `mcp__<server>__<tool> <json>`; `codemode` runs a script calling bash and read, `codemode-restart` one whose slow middle call a restart interrupts, `codemode <script>` runs that script; `artifact` runs a script writing the html artifact `demo` and showing it; `view_<name> <json>` and `artifact_<name> <json>` call those tools directly (refused: they are code mode only); `steps` makes a turn of thinking, calls and words, `inline-steps` one with an inline artifact between two calls; `json <text>` answers exactly `<text>`; a one-shot agent whose task is not `json …`/`slow…` answers a small value matching its schema) |
| `P2_IDLE_MS` | `300000` | idle time before a session worker stops |
| `P2_PROVIDER`, `P2_MODEL` | unset | default model for new sessions after settings.json's `defaultModel` (both or neither; Pi Mobile's `PI_MOBILE_PROVIDER`/`PI_MOBILE_MODEL` work too) |
| `P2_RADIUS` | unset | `0`: disable the outbound Radius brain connection even when signed in |
| `PI_RADIUS_GATEWAY` | production Radius | gateway selected by `npm run radius:login` |
| `P2_TERMINAL_DAEMON` | unset | optional local pi-env daemon binary; otherwise use packages/env release/development builds |

- **Web UI** (Chord's web surface, slice 11; `src/hosts/server.ts`, `src/hosts/web.ts`): `webSurface` with
  `routes: false` builds the pages' base bundle from `src/hosts/web/entry.ts` (`main.tsx`: Chord's `startPage` with
  p2's API modules, core facet, React root, connection state and error reports; `themes: false`, p2 styles itself)
  right after the listen, resolving workspace packages through p2's tsconfig `paths` as the server's source resolver
  does (`src/hosts/web/base.ts`, Chord's `tsconfig`): their sources, never a `dist/` (pi-ai's `./utils/*` exports
  only `dist/`, which the phone never builds; `web-sources.test.ts` fails on any `dist/` input); the
  plugins' web facets are Chord plugin builds of kind `web` (host packages `src/hosts/web/packages.ts`: the API's
  kind-neutral and web modules, React, react-dom, pi-schema), served as scripts that register themselves, the current
  set as one combined file. `web.ts` serves them with p2's access rules: the page (p2's template with `pageScripts`,
  `data-web-version` the base hash), `/_chord/web/…` files (named by content, `immutable`; guests too: it is the
  app's code), and `/_chord/web/base` (public, `no-store`). A failed base build is an owner notice and pages answer
  503. A plugin reload rolls web facets out with the server's and workers' (the surface's step last): an open page
  fetches the changed scripts and applies them in place (`host.reload` in the page; each plugin's stylesheet swapped
  with its code), so the transcript's scroll and the other panes stay; only base code (the entry, `src/web`,
  `src/runtime`, the API, Chord, React) needs a restart, and pages reload onto the new base: before reconnecting a
  page asks `/_chord/web/base`, another one reloads it. No polling. A page's link names its base
  (`/chord?web=<base>`); every other client names itself (`?client=tui`, `cloud`, `script` for scripts and tests;
  `src/runtime/stale-page.ts`). The server refuses a link naming another base, or neither a base nor a known client (a
  page from before 2026-11-12, which would re-hold types removed since), at once (close code 4001; the page reloads)
  and the owner gets a notice (source `stale-pages`) naming who it was: the owner's access or device, or the guest,
  the browser and its address. A TUI launcher from before the marker is refused too (it retries until updated). The last four plugin sets' files stay served. Web facets must not share module state with
  another plugin's files (each plugin's script holds its own copy of a file it imports from another plugin):
  `plugin-practices.md`. The TUI launcher still polls `/__p2_tui` (p2's own TUI bundle). There is no Vite,
  source-module server or `index.html`.
- **Radius Cloud Brain** (`scripts/cloud-bundle.ts`, `.github/workflows/p2-cloud-bundle.yml` after CI passes on main;
  the R2 bucket `pi-ui` under the commit's full SHA, served by Radius under `/pi/ui/`): a static page built with
  Chord's builders as a p2 page is (`buildBase`, the plugins' web scripts registered with `registeredSource`,
  `pageBootstrap`), written as one script (the bootstrap, the plugins, the base bundle) and one stylesheet, assets
  under `/pi/ui/<sha>/assets/`. `main.tsx` sees Radius's `data-pi-bootstrap` on `#root`: it connects to its Chord URL
  (adding `client=cloud`; the brain forwards the relayed path with its query) and starts static (`startPage({ follow: false })`: no updates, never outdated). Test: `ui-cloud-bundle.test.ts`.
- `npm run dev` also watches plugins and supervises runtime restarts; see **Dev mode** below. Under `npm start`,
  code changes (web included) take effect only after a restart.
- **Data report** (`scripts/data-report.ts`, read-only, beside a live server): per session its title, location,
  conversations with their entry counts and newest entry IDs, subagents, share modes, artifacts, uploads and
  downloads, plus environment and forward names; never secrets. `--compare before.json` lists differences (exit 1).
  `scripts/verify-sessions.ts [url]` checks a running p2 against it as the local owner (signed in with the data
  directory's owner key: `--data`, P2_DATA_DIR or ~/.pi/p2): the session list, and the
  newest entry of every conversation through `Chat` for the 10 newest sessions and all with subagents or shares
  (stopping workers it started). `test/fixtures/v1-data` is a data directory p2 wrote on Chord v1 (generated at
  aee97d3a9; the generator went with v1); `v1-data.test.ts` opens a copy and checks both tools and the contracts.
- One server per data directory (process lock). To try p2 next to a real setup without touching it, set
  `P2_DATA_DIR` to a temporary directory.
- Loopback alone is nobody: the local owner holds a local session cookie, from a sign-in link opened on the host or
  a local sign-in with the data directory's owner key (TUI, owner-link, scripts; **Loopback owner** under Devices).
  Through an HTTPS tunnel host listed in `P2_ALLOWED_HOSTS` (comma-separated),
  the Devices plugin's owner cookie admits an associated remote owner; a share cookie admits only that session's
  guest. Open `/owner` to sign in with a one-time token (see README). Other Host/Origin headers and forwarded
  localhost requests get 403. Radius independently authenticates its owner; proxies never do. Associated cookies
  are remote owners (`access: "device"` with a device ID). See README for owner links, logout and cookie migration.
- Tests: `node --import ./src/source.ts --test test/p2/<file>.test.ts` (fake provider, temporary data dirs, port 0).
  Wait for state changes with `until(readable, predicate)` (it subscribes). Never poll `ref.member.value`: an
  unsubscribed reference member keeps its last value.
- Headless Chromium on Termux: `chromium-browser --headless=new --no-sandbox --no-zygote --single-process
  --remote-debugging-port=<port> --user-data-dir=<tmp>`; without `--no-zygote --single-process` every navigation
  fails with `net::ERR_ABORTED`. Drive it over CDP (`Page.navigate`, `Runtime.evaluate`).
- Browser tests (`test/p2/ui-parity.test.ts`) find Chromium through `CHROMIUM_BIN`. On a Linux server without a
  system Chromium or root, a wrapper can run the Playwright image's Chromium with host networking, as the calling
  user, with `/tmp` shared for profiles (as on slayer: `CHROMIUM_BIN=~/.local/bin/chromium-docker`):
  `docker run --rm -i --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v /tmp:/tmp
  mcr.microsoft.com/playwright:v1.55.0-noble /ms-playwright/chromium-1187/chrome-linux/chrome "$@"`.
  Browser tests use `--disable-dev-shm-usage` because Docker's default shared-memory limit can otherwise make module
  reloads fail with `net::ERR_INSUFFICIENT_RESOURCES`; readiness waits for the new document, not stale DOM.
- `proxy-marker` replaces `proxy-auth`: `X-P2-Proxy-Secret` is a constant downgrade marker, not a credential.
  Every proxied request must preserve its public Host and overwrite that header, including WebSocket upgrades.
  Marked/forwarded localhost Hosts are rejected; allowed public Hosts are remote and require owner/guest cookies.
  A forged marker cannot grant owner/device access. Neither HTTP basic auth nor `P2_PROXY_SECRET` is used.

## Dev mode

```sh
cd /home/badlogic/pi-private/apps/p2
export PATH=/home/badlogic/node-v24.4.1-linux-x64/bin:$PATH
# The proxy sets X-P2-Proxy-Secret: 1 on every request (never an owner grant).
P2_ALLOWED_HOSTS=p2.mariozechner.at P2_PUBLIC_URL=https://p2.mariozechner.at \
  P2_DATA_DIR="$HOME/.pi/p2" PORT=8788 npm run dev
```

Do not launch this beside another server using the same data directory or port. Moving a standalone server into
supervised mode requires stopping that server and waiting for its exit first. To preserve its currently running
sessions, seed `P2_DEV_RESUME` with their JSON ID array. A fresh supervisor otherwise starts no session workers.
Use a temporary `P2_DATA_DIR` and a different `PORT` for experiments.

- **Code changes:** saves never apply automatically. Adding or removing a plugin or facet, or changing a loaded
  plugin input, marks that plugin dirty; Reload atomically commits its backend changes and rebuilt bundles, then
  visible pages switch when their next five-second poll detects the new manifest. Loaded non-plugin runtime or bundle inputs mark **Server code changed**; Restart applies them, although a
  later successful plugin Reload also rebuilds bundle-only inputs. Plugin discovery does not parse source; facet load
  hooks and the bundles' captured input lists track the files in use. Configuration files retain their existing
  live-reload behavior.
- **Owner controls:** **N plugins changed: Reload** lists the dirty names; **Server code changed: Restart**
  requests a graceful supervised restart. The owner-only, same-origin button API is `POST /__p2_dev`; state is
  `GET /__p2_dev`. All triggers publish a shared owner notice, such as **Reloaded chat, sessions** or
  **Reload refused: …**. **Show logs** opens the Logs plugin when loaded; otherwise the message stands alone.
- **Plugin reloads:** an explicit reload builds exactly the named (or dirty) plugins (Chord's `plugins.build`), then
  rolls them out to the server, every running worker and the pages (`plugins.rollout([server step, workers step, web
  surface step])`) and rebuilds the TUI bundle. A plugin whose build fails keeps its old code (an added one stays out) and the reload is
  refused; a plugin that is not loaded cannot be reloaded. Compatible changes keep objects, streams and references
  (Chord swaps them in place); added plugins' objects activate; a removed plugin's objects end (their holders see
  them end). Dirty marks come from Chord's plugin watcher
  (`plugins.state`); saves during a reload stay dirty. State and contract changes still need Chord versions.
- **Explicit restarts:** the supervisor sends SIGTERM and waits for exit, with SIGKILL only after ten seconds as
  fallback. IPC tracks/fixes the pre-shutdown running set. The replacement restores non-archived workers, including
  ones with no viewer, without resubmitting inputs; Durable resumes committed work and browsers reconnect.
  Detached terminals remain running. A crash or startup error is not retried automatically: fix the source,
  inspect Logs, then request another restart. The CLI waits for replacement readiness and reports startup failure.
- **Supervisor controls:** `kill -USR2 "$P2_DEV_SUPERVISOR_PID"` is still an explicit graceful restart, with an
  owner notice. Stop the supervisor with SIGTERM/SIGINT. The running set is in memory and is lost if the supervisor
  dies. Supervisor/package/dependency/environment changes require relaunching `npm run dev`; a supervisor already
  running the older automatic-watch script must be relaunched once to adopt these explicit-only triggers.
  `npm start` has no dev controls unless explicitly given `P2_DEV=1`; standalone dev mode cannot restart itself.

### Agents: apply edits explicitly

Run from `apps/p2`, with `P2_DATA_DIR` matching the running server (default `~/.pi/p2`):

```sh
npm run reload                       # all dirty plugins, including additions/removals
npm run reload -- chat sessions       # exactly these plugins
npm run reload -- --restart           # runtime code; wait for the replacement server
```

The CLI uses `<data>/dev.sock`, mode 0600, protected by a separate process lock and kept alive by the supervisor
across server restarts. It is a Unix-only channel, not an HTTP route on the proxy-facing listener; no credential
is printed or needed in a URL. It prints the committed plugin selection or refusal reason and exits non-zero
on failure. This is a local filesystem capability for the account, not guest filesystem isolation.

The `dev-tools` plugin provides **reload_plugins** (`{}` for dirty plugins and every plugin of the user root, or
`{"plugins":["chat","sessions"]}`), in every server mode, through the server object `PluginReload` (worker principals
only; the server's `ServerParts.plugins.reload`). It is an ordinary tool: no requirements, so subagents (an agent
writing plugins in `local:<data>/plugins`) can be given it, and the session's tool selection and lock govern it as
they govern bash. It reports per plugin: applied, removed, failed (the build's esbuild errors as
`file:line:column: message`, or a host's load error), refused (unknown, or discovery: an invalid package, a name a
built-in has); and the server's and workers' errors logged meanwhile. A failed build rolls out nothing. In dev mode it
updates the dev status like the Reload button. Its prompt section on p2 development shows only to sessions working on
the p2 checkout (docs/agent-plugins.md). Tool upgrades are not automatically replayed after
a crash. For runtime edits, use the explicit CLI `--restart` command instead. Do not invoke the owner server's
controls from tests: use disposable data dirs and independent supervisors.

`test/p2/dev.test.ts` uses a disposable checkout, fake provider and port 0: dirty-only saves, explicit button and
CLI reloads/refusals, hot additions/removals during streaming, private channel isolation, web edits (dirty, then a
new content-named bundle on Reload; non-plugin bundle inputs ask for a restart), manual runtime restarts,
unseen-worker restoration and no duplicate inputs. `dev-tools.test.ts` covers owner attribution, denial and tool
failure results.

## TUI

```sh
npm run tui                         # local owner on http://127.0.0.1:$PORT, default 8788
npm run tui -- https://pi.example    # prompts for an owner link unless its saved cookie is valid
npm run owner-link -- https://pi.example   # on the server machine, print a private fragment link
# Paste that link at the TUI prompt, or supply --owner-link '<link>' / P2_TUI_OWNER_LINK.
```

On direct HTTP loopback the launcher first tries a valid saved owner cookie, then signs in as the local owner with
the owner key of `P2_DATA_DIR` (default `~/.pi/p2`; `src/runtime/local-owner.ts`) and saves nothing. Without a
readable key, against a server with another data directory, or behind a proxy marker, it prints why and prompts for a
link. When every owner is signed out while it runs, a local sign-in signs in again with the new key. The default is always `http://127.0.0.1:$PORT` (8788 unset), not `P2_PUBLIC_URL`.
Remote URLs require HTTPS. `--owner-link <link>` (or `P2_TUI_OWNER_LINK`) redeems only a same-origin `/owner#<token>`
link through POST and saves the returned cookie. Without a valid saved cookie, the TUI prompts for that link. A share link works too: `--join <https://host/join/token>` (or pasting it at
the prompt) asks for a display name and redeems it with `POST /join`; the guest cookie is saved per origin beside any
owner cookie and reused after a `HEAD /__p2_tui` check. If the server stops admitting it (link reset, guest removed,
session archived) the TUI exits with a notice and forgets it. Loopback stays the local owner unless `--join` is given.
Basic-auth options/environment/passwords are removed. Prefer the prompt to command-line credentials, which can
appear in shell history/process listings. Only the cookie is saved per origin in `~/.pi/p2-tui/config.json`
(0600, directory 0700); the consumed invitation is never saved. Local configuration stores only cookies;
`P2_TUI_CONFIG_DIR` isolates tests. No provider credentials are read by the launcher. Keybindings, theme and display
settings are the visitor's (p2-tui-port.md 4.3): the launcher reads pi's `keybindings.json`, `settings.json` and
`themes/*.json` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`, never written) and `prefs.json` beside `config.json`, keeps a
validated whitelist and posts it as data; it watches them, so custom themes and bindings hot-reload. `--theme` and
`--no-themes` work as in pi. The launcher also queries the terminal's colors (OSC 10/11/4, mode 2031) and posts
them with its color depth and platform. `<P2_DATA_DIR>/tui.json` (`TuiPreferences`) only holds server defaults, e.g.
`{"keybindings":{"app.model.select":"ctrl+k"},"theme":"light","settings":{"hideThinkingBlock":true}}`; privileged
(launcher-owned) bindings are dropped. `hideThinkingBlock` (unset = hidden, unlike pi) sets the thinking view whenever
its effective value changes; `app.thinking.toggle` overrides it until then, and a reload snapshot keeps the toggle. Themes are per-runtime instances (`src/tui/theme/`); keys and commands go
through the `TuiCommands` registry (pi ids, contexts, `/hotkeys`, F1 palette, `/` completion).

The unrestricted launcher (`src/hosts/tui.ts`, `tui-client.ts`) owns terminal input/resize, the same `/chord`
WebSocket as the browser and its cookie. It downloads only a same-origin `/__p2_tui` manifest and bounded,
SHA-256-verified bundle; redirects and server-chosen origins/paths are refused. Owners and currently admitted
share guests may fetch this code, strangers cannot. `buildTuiBundle` in `src/hosts/bundles.ts` bundles pi-tui,
Chord, the runtime and every loaded plugin's `tui.ts` into one self-contained ESM. Listing and esbuild run on the
server, not the visitor. The captured bundle inputs participate in dirty/reload decisions.
Backend reload prepares a new bundle before commit and publishes it only after success; failed builds retain the
previous backend/bundle. First fetch builds lazily. `/__p2_tui/<hash>.mjs` serves only the current version.

`tui-sandbox.ts` starts a plain Worker with exactly `execArgv: ["--permission"]`, empty environment, captured and
discarded stdout/stderr, and V8 limits (96 MiB old heap, 16 MiB young heap, 64 MiB code range, 4 MiB stack).
`tui-bootstrap.mjs` drops all fs/read/write, worker, network, child, addon, WASI and inspector permissions and verifies
those drops before importing the bundle from a data URL. Without the drop, Node implicitly grants module reads:
the ordering is essential and explicitly tested. Cheap additional taming removes parentPort/workerData,
environment-data/BroadcastChannel access, V8 snapshots/queryObjects, process signaling/reports and OS priority changes.
All fs/fs-promises functions are also disabled before evaluation: inherited numeric descriptors can bypass path
permission checks, so raw fd reads/writes must not reach stdin or the real terminal. Built-in aliases share the
closed facade; drops independently protect native JSON/require/file module loading.
The bootstrap gives the runtime only copied messages and a send function, not a port or Worker handle. Native
pi-tui clipboard/platform helpers are disabled at bundle time. Inside, `tui-worker-runtime.ts` implements pi-tui's
Terminal interface through the bridge and loads the TUI facets plus `tuiCoreFacet` (which serves the TUI's
registries) on a Chord client host whose parent link is relayed as binary messages; it has no Node socket or local
module loader.

The launcher recognizes output, opaque chord-link frames, `linkClosed` (the worker's link closed on its own, e.g. Chord's
heartbeat found the socket silent: the launcher terminates the socket and reconnects), reload and exit requests, plus (p2-tui-port.md 3.6a)
`navigation`/`keyContext` reports, sanitized and rate-limited `title`/`progress`/`programStatus`, and `request`s for
registered launcher actions, which run only under a grant: the visitor's own privileged key or a confirmation in the
launcher-drawn consent screen (worker IO suspended meanwhile). Unknown requests are denied. Worker-set terminal modes
(autowrap, mouse only by the visitor's `prefs.json` `mouse` policy) are tracked and undone on exit, crash and swap. WebSocket frames are relayed unchanged with 4 MiB
frame/queue limits. Every output write passes `tui-filter.ts` (64 KiB UTF-8/frame): text, CR/LF/tab, SGR, cursor
movement/position, erase, cursor visibility, autowrap, synchronized output, bracketed paste, pi-tui alternate screen
and scroll region. OSC 52/title/hyperlinks, DCS, APC/PM/SOS, kitty graphics, C1 controls, unknown CSI/private modes and malformed
or incomplete escapes are stripped. No partial escape can cross a frame boundary. Raw worker streams never reach the
terminal. A crash (an uncaught exception or a throwing message handler) is printed by the launcher after it restored
the terminal: the stack (frames name `p2-tui-bundle.mjs`), controls removed, at most 8 KiB (the bundle keeps function
and class names for this); a heap overrun says so instead. Rendering is copied from coding-agent's interactive mode and DurableTui (p2-tui-port.md P0c/P2;
p2 imports neither coding-agent nor mobile): a fullscreen layout (transcript `ScrollView` over a dock of status lines,
pending area, pi's editor with the working indicator in its border, and pi's footer), incremental transcript
components keyed by the shared display items (`src/tui/components/`), pi's tool card (`src/tui/components/
tool-execution.ts`, pi's generic card for a tool without renderers, the shared shell card in `src/tui/tools/shell.ts`),
and plugin contributions through `TuiToolRenderers` (the tools' own cards, from the plugins that own them: bash, read,
write, edit (the result's diff), grep/find/ls in `coding-tools`, `powershell`, code mode in `codemode`),
`TuiToolRendererResolvers`, `TuiEntryRenderers` and `TuiMarkdownTransformers` (`src/runtime/tui-renderers.ts`). Drafts, pending send IDs and reading positions are kept per viewed
(session, conversation); the reading position stays put while output grows or older history is prepended.

pi's defaults (rebindable in pi's `keybindings.json` or p2 prefs; `/hotkeys` lists all with conflicts):

| Key | Action |
| --- | --- |
| Ctrl+R (chat), `/sessions`, `/resume`, `/new` | Session picker / create a session with a working directory |
| Ctrl+L, `/model` | Model picker, then thinking level (with no session, sets the default; owner) |
| Enter / Alt+Enter | Send (steer if busy) / queue a follow-up |
| Escape / Alt+Up | Stop / restore the last queued input to the editor |
| Ctrl+C / Ctrl+D | Clear the editor (twice: exit) / exit when the editor is empty (`/quit`) |
| Ctrl+T / Ctrl+O | Show thinking / expand tool output |
| PageUp / PageDown / Ctrl+Home / Ctrl+End | Scroll the transcript (pi-tui's alt-screen keys; Ctrl+End follows again) |
| F1 / `/hotkeys` / `/reload` | Command palette / shortcuts / fetch the server TUI bundle into a fresh worker |
| F2 / `/close-panel` | Move the focus into the side panel and back (Escape also returns) / close it |

**Side panel.** `ctx.panel.open(id, content, title)` shows one component to the right of the screen's body (about 40%
of the width, behind a bar; the dock stays full width), in a `ScrollView` the runtime owns. Plugins open it (Enter in
`/artifacts` shows an artifact there when the terminal fits it; it follows new versions through `Artifacts`). The editor keeps
the focus; F2 (`p2.panel.focus`) moves it into the panel, where the runtime sets pi-tui's `capturesViewportInput` and
scrolls the panel with the viewport and select keys, keeps other keys from the editor and returns the focus on Escape.
Search stays on the transcript (the primary scroll view). Hidden below 100 columns; closed on navigation to another
conversation and whenever the command registry changes (a facet reload), like overlays.

The launcher polls the bundle version every second. A changed hash prepares a new worker while the old one remains
active; once ready, it copies bounded UI state (selection, drafts, send retry IDs, display toggles, reading position),
swaps the fixed-origin connection and terminates the old worker. Failed preparation retains the old worker.
`/reload` also creates a fresh worker, even for an unchanged hash. There is no local watcher or local facet reload.
Network drops reconnect with bounded exponential backoff; Chord rebinds the held references. A connection that died
without a close (a laptop that slept while Radius dropped it) is found by the worker's Chord heartbeat within 30 s:
`linkClosed` makes the launcher drop that socket (`tui-launcher.test.ts`, silent link).
Image attachments/results remain text placeholders; no attachment uploader, browser sheets, terminal panel or
provider-login screen is provided.

**Threat model:** a server and all of its TUI code are untrusted relative to the visitor's machine. Their authority
is the server-owned Chord connection plus rendered output/user input. No machine reads/writes, inherited env,
network/process creation, inspector/native bindings, ambient clipboard or terminal side effects are granted.
The owner explicitly accepts denial of service to that server's TUI process. The watchdog samples process RSS
(all threads) and ArrayBuffers (main-thread accounting) every 100 ms, killing the worker over 512 MiB RSS or
128 MiB main-thread ArrayBuffers with a clear message. This is not an OS quota: V8 limits exclude native buffers,
rapid/native allocation can outrun sampling, and host memory exhaustion or Node vulnerabilities remain residual
risks. No OS sandbox or secure-eval-worker dependency is used. Keep Node patched.

`test/p2/tui.test.ts` retains bare-host rendering and cookie authentication coverage. `tui-isolation.test.ts` runs
escape attempts on Node 26 (permission drop before evaluation, fs/JSON/require/file import, net/fetch/WebSocket,
child/worker/bindings, env, inspector, snapshots, environment data/BroadcastChannel, signaling/report/priority,
loader registration, inherited descriptors, raw streams, huge
heap/ArrayBuffer allocations), plus deterministic adversarial/fuzz output filtering. `tui-launcher.test.ts` covers
web-equivalent admission, a real server/bundled-worker/pi-tui session with fake replies, server defaults under local preferences,
queues/stop, resized rendering, replacement/state preservation, failed build rollback, reconnect, denied capability
requests/cookie secrecy and concurrent shutdown during worker preparation. `tui-commands.test.ts` covers the
command registry (when grammar, privileged/transcript/plugin/slash collisions, pi `keybindings.json` overrides, registry
reload, overlay precedence, palette, `/hotkeys`); `tui-theme.test.ts` per-runtime themes, terminal colors, the launcher's
preference loader and hot reload, and the data-only `preferences`/`capabilities`/`terminalColors` messages. Run these
with Node 26.11.1; Node 24 remains valid for the server but cannot execute the sandbox tests.

## Testing

From `apps/p2`: `npm run check`; `npm test` runs the full suite (browser tests need `CHROMIUM_BIN`). For a focused
file, use `node --import ./src/source.ts --test test/p2/<file>.test.ts`; the TUI files (`test/p2/tui*.test.ts`) need
Node 26 (`~/.local/bin/node26`).

- **Unit:** `testHost` in `test/p2/helpers.ts` loads facets into a bare host: the server by default, or
  `{ address: Session({ id }), kind: "worker" }`. It serves the base registries of its kind (and, for a server, the
  `ServerNatives`, with no workers unless `server` gives some). Stubs are `[Contract, membersOrFactory]`; a factory
  returns a flat shape (`{ variant, ...members }`), gets `self.state(initial)` for an in-memory state member (a
  `Cell` with `replace`/`change` the test drives) and may return nothing from a method (`null` is sent). Natives a
  facet reads (`harnessOf`, `workerOf`, a plugin's single-native registry) come from `workerFacet({ harness, worker,
  host })` and `nativeFacet(R, value)`. `root(fn)` runs as `principal`; `client(principal)` is a memory-linked client
  the host stamps with that principal, `clientWith(principal, facets)` one that loaded facets (TUI facets);
  `reload(facets)` replaces the loaded facets; `beforeLoad(host)` declares routes (a session host behind the server's
  route: `test/p2/tui-fixture.ts`).
- **Integration:** `startFixture({ plugins })` runs exactly the named plugins (default: all built-ins) with the fake
  provider, temporary data and workspace, port 0 and no web bundle unless `web: true`. Name every plugin the test
  needs (chat needs conversations, drafts, envs, files, models, search, sessions, status and subagents).
  `fixture.browser(facets?)` is a client over `/chord` as the page connects (with web facets loaded, for composer
  expanders); `fixture.client(headers)` one whose socket sends headers (tunnel, guest cookie, relay);
  `fixture.as(principal)` a memory-linked client the server accepts as `principal` (a relay owner, a worker).
  `startServer({ facets })` loads probe facets with the core (routes and types a test needs on the server).
- **Plugins:** there is no manifest. `listPlugins` (`src/hosts/plugins.ts`) lists `plugins/*` directories with facet
  files; each is a package (`package.json`). Chord's plugins component builds and loads the selected ones
  (`createP2Plugins`); a test selection is a temporary copy of `plugins/` with only the named plugins' facets.
  Generated test plugins need a `package.json` and may not use top-level await (a facet declares synchronously).
- **Chord in tests:** tests import Chord only through `test/p2/helpers.ts` and the plugin API (`@p2/app/v1`).
  References are held (`host.hold(T, params, TEST)`; `TEST` is the background context) and awaited with
  `whenLive(ref)`; `holdIn(host, T, params, variant)` returns one live in `variant`; `failureOf(ref)` waits for a
  failure or end (a type nobody serves leaves a hold waiting). Every method call takes a context.
- **Live state:** `until(watchable, predicate)` follows a state member, derive or registry value until the predicate
  holds; `settled(watchable)` returns a defined value after 25 ms without changes. `expectChord(promise, code)`
  asserts a ChordError code.

Examples: `drafts.test.ts` (a bare worker facet), `test-host.test.ts` (status with a `Hosts` stub, a workspace with
`workerFacet`), `durable-registry.test.ts` (reloads of a bare worker host), `harness-cwd.test.ts` and
`relocate-worker.test.ts` (the worker's core facet over a real Durable store), `plugins.test.ts` (listing, selection,
subsets and reload).

```ts
const fixture = await testHost({ address: Session({ id: "sample" }), kind: "worker", facets: [draftsWorker] });
t.after(() => fixture.close());
await fixture.root(async (ctx) => {
    const store = await ctx.get(DraftStore, {});
    await store.add({ conversation: 1, items: [] }, ctx);
});
```

## Chord v2

p2 runs on Chord v2 (`packages/chord`, `docs/design.md` there); the port's notes are in `/home/badlogic/p2-port`.

- **Placement:** two host kinds (`src/runtime/chord.ts`): `Server` and `Session({ id })`. A remote contract names
  where it lives with `hostAddress` (`serverHost`, `sessionHost`); a worker serves only its own session, so factories
  no longer compare `host.name`. The session workers are Chord's `createWorkers` (`src/hosts/session-workers.ts`:
  generations, logs and notices, relocation and pauses on `stop`/`retry`).
- **Host stores and files** (per-host stores; laid out as the app kit lays out its hosts, `src/runtime/host-dirs.ts`):
  every host has its own Chord store and files directory, private (directories 0700, stores 0600). The server:
  `<data>/server/store.sqlite` (outbox off: local-only data, credentials included, never goes to a sync) and
  `<data>/server/files/`; each session: `<data>/sessions/<id>/store.sqlite` (outbox off until p2 syncs: it records
  nothing while not connected to a sync; turning it on starts at the current commit, and a first sync uploads an
  archive) and `<data>/sessions/<id>/files/`.
  Projects will be another host kind of the same shape. Both hosts load the app kit's `Files` (`chord.app.files`,
  `filesFacet` from `@earendil-works/chord/app/files`); a session's Durable runs on its store through `StoreStorage`
  under the owner name `p2.durable` (`src/runtime/session-store.ts`), beside `Files`' tables. Plugins reach `Files`
  with `self.get(Files, {})` / `ctx.get(Files, {})` (`@p2/app/v1/node`), never a path; a session's spaces are
  `uploads` and `downloads` (`src/runtime/session-files.ts`; artifacts written before 2026-11-12 stay in a space
  `artifacts`, unused: the artifacts plugin keeps them on the server now, docs/artifacts.md).
  The session catalog (`Catalog`) is the server store's table `p2.catalog:sessions`, one row per session keyed by its
  address (`host(Session)`, decision "Documents and table rows can belong to a host"): everything about a session needed
  while its worker is off (place, title, model and level, pin, archive, `/tree` branches), so a session's export,
  import and delete carry it. Share links and grants, each session's subagents and its artifacts are likewise rows
  or documents keyed by the session (guests are
  per person, keyed by their own ID). A data directory with a `catalog.sqlite`, `shares.sqlite` or `subagents.sqlite`
  from before is refused at start: `npm run
  migrate-data` moves it (below). Clone copies the whole session directory
  while its worker is stopped (blobs hard-linked); fork copies only the source's files, through its worker
  (`SessionTransfer.copyFiles`, the kit's `copyFiles`), and seeds its history into a fresh store; a failed copy's
  directory is removed; plugins copy what they keep on the server through `SessionCopied` (projects, artifacts). The
  server's mirror of the spaces' summaries (`FileSummaries`) is gone: nothing used it. A data directory in the older
  layout (`server.sqlite`, `sessions/<id>.sqlite`,
  `artifacts/`, `downloads/`) is refused at start: `npm run migrate-data` moves it (below).
- **Migration** (`npm run migrate-data -- [--dry-run] [--data <dir>]`, `scripts/migrate-data.ts`): offline (refused
  while a server holds the data directory's lock, which it takes). The server's store is copied to `server/store.sqlite`
  and verified (equal exports); `catalog.sqlite` (schema 1 to 4) is written into that store's catalog table in one
  transaction, read back from the store reopened and compared, then moved to `pre-catalog-backup/`; `shares.sqlite`
  (schema 1 and 2) and `subagents.sqlite` go the same way into `Shares`' and `ChildStore`'s tables, then to
  `pre-server-data-backup/` (`scripts/migrate-server-data.ts`; an own-cwd child is placed on its session's environment)
  (`scripts/migrate-catalog.ts`; a table that holds rows already is not written again); each session is built in `sessions/.<id>.migrating/` from a copy of its old store:
  Durable's records replayed into `StoreStorage` in seq order (`scripts/migrate-durable.ts`: seqs renumbered in order,
  ids kept, the allocator past the old next id) and its artifacts (same version numbers), uploads and downloads (same
  ids, as keys; each file's time from the old file's modification time, through `Files`' `created` for imports) written
  into its `Files` (`scripts/migrate-files.ts`); then verified (every record read through
  Durable's `Storage` from both, every file byte for byte), renamed into place, and only then its old files moved to
  `pre-files-backup/` (same relative paths). `uploads/<session>/` stays: it is where this machine materializes
  attachments now, and old transcripts name those paths. A crash redoes the session it was in; a second run skips
  what is done. `--dry-run` builds and verifies everything in a temporary directory. `scripts/data-report.ts` reads
  either layout: a report before and `--compare` after shows any difference. Tests: `pre-files-data.test.ts` (a data
  directory made by p2 just before this change), `v1-data.test.ts`.
- **Worker base:** session workers fork from Chord's worker base of `src/hosts/worker.ts` (split at dynamic imports).
  The entry imports only the worker's side (`@earendil-works/chord/workers/child`, `src/hosts/host-packages.ts`), so a
  fork loads no esbuild and no server API; pi-ai's provider SDKs load with their first request. It registers pi-ai's
  lazy OAuth flows and Bedrock (`registerLazyOAuthFlows`, `registerLazyBedrockProvider`): chunks of the snapshot, not
  pi-ai's source files (`test/p2/worker-base.test.ts`, `worker-oauth.test.ts`).
- **Worker failures:** a failed start stays failed (status error, Retry) and its holders wait (`failed { waiting }`,
  `whenLive` does not reject: tests use `failureOf`). A running worker that crashes is restarted for its holders, at
  most five times a minute per session; the next crash waits for Retry. A worker stays alive while objects
  linger on it (Chat 30 s after its last viewer), on top of `P2_IDLE_MS`.
- **Principals:** owners, guests and workers as before (`src/runtime/principals.ts`); the server host acts as `SERVER`
  (workers tell its own requests from a person's), a worker as `HOST`. A method's `ctx.get` acts as its caller; a
  `local` object's methods, routines and jobs act as the host, so a server object that must reach a worker as the
  server is a `local` one (`SessionOperations`, `SearchIndex`, `ConversationBroker`). Code outside Chord calls (a
  Durable tool, a route) uses `serverOf(self)().root(fn, context)` / `workerOf(self)().root(fn, context)`, which take
  a required context: a method passes `withoutAbortSignal(ctx)` (the call chain is kept, a caller giving up does not
  cut it off), a tool its Durable context. Revocation is Chord's (`revokedBy`: a device, remote owners, a guest).
- **Rules this code follows** (the p2 cleanup, `packages/chord/docs/decisions.md` "App authoring rules confirmed by
  the p2 audit"): state outside Chord is followed (`self.follow` of a synchronous observer: `Hosts.workers` follows
  the workers component, status follows Durable's task graph), never copied by a listener; a method awaits its own
  effects on the host that answers; long work is a job (`self.job`, persisted on the server's store where it must
  survive a restart: session lifecycle operations, index rebuilds) and its UI watches the job's state; a session's
  worker pushes what the server's index shows (title, `/tree` branches, subagent flags, working state) inside the
  method that changed it, awaited, and never pulls session data (the search cursor is the server's acknowledgement
  of what it indexed, not session data).
- **References:** `host.hold(T, params, ctx)` gives a reference at once (loading, live, failed, ended);
  `ctx.get`/`host.get` one once live. UIs use `src/runtime/refs.ts`: `follow` (a value with its current one first),
  `followRegistry`, `whenLive`, `statusOf`, `liveIn(ref, ...variants)` (`HeldIn`), `UI_LINGER`. A held reference's
  variant may be `undefined` until it binds, so `inVariant`/`expectVariant` do not narrow it: use `liveIn`.
- **Objects and state:** factories declare state with `defineState` (`defineTypedState` where pi-schema's optional
  fields are not JSON to TypeScript) and change it with `change(fn, ctx)`; derived members are `self.derive`; a
  `self.writable` is exposed through a derive. Natives (a Durable Harness, a database, a socket) are `self.open`
  values; another object reaches one through a single-native registry (`serveNative`, `nativeOf`): `WorkerProcess`
  (`workerOf`), `HarnessNative` (`harnessOf`), `ServerNatives` (`serverOf`), `ModelResources`, `EnvManagers`,
  `TerminalServices`, `DeviceAccesses`, `ForwardsNative`, `RadiusConnections`. A reader that needs a native while it
  activates also declares its owner (`self.get(Owner, {})`). Methods return `null` for nothing; their arguments are
  closed objects (schemas that check stored data stay open).
- **State outside Chord is followed:** a native's state (a store with `subscribe`, the configuration files, a
  database, `processLogs`) or a Durable document is a state member through `self.follow` of a synchronous observer
  (`followNative(self, subscribe, read)` from `@p2/app/v1` for a native that tells listeners; Durable's `observeDoc`), never a document a
  routine or listener copies it into. A method that changes it through the native answers after the native told the
  source, so the page holds the new state when the call resolves (models, envs, ports, login, mcp, logs, sharing,
  voice mode).
- **Registries:** keyed registries (`keyedRegistry`) compose contributions into a map; the core facets serve the base
  ones (`serveServerRegistries`, `serveWorkerRegistries`, `tuiCoreFacet`, `webCoreFacet`), a plugin serves its own
  (`serveKeyed`). One contribution per registry per object or facet.
- **Plugins:** see **Plugin layout** and **Plugin reloads**; the server loads its facets with `createPlugins`, workers
  get theirs from the workers component, pages from the web surface (`startPage`), the TUI bundle loads its own with
  `host.load`.
- **Protocol versions:** a page or TUI reloads when the server speaks a newer link protocol (`newerPeerProtocol`).
- **Contract versions:** pages and TUIs keep the contracts they were built with until they reload, so a deploy that
  bumps a contract a client holds must keep serving the old version: write the history with `evolve` (the released
  version as the base, verbatim, so old bundles' fingerprints match) and give the provider an `accepts` table mapping
  current state and results back (`Sessions` v3/v4, `Catalog` v2/v3, `SessionTree` v1, `Envs` v1/v2;
  `test/p2/contract-versions.test.ts` binds the released declarations). Without it, old clients wait unbound
  (`contract_mismatch`) until they reload.

## Radius and port forwards

```sh
npm run radius:login    # device-code sign-in, separate from model providers
npm start
```

- **Radius** (`plugins/radius`): a server resource (of an object of lifetime "host") keeps an outbound brain WebSocket when `radius.json`
  exists; absent config is checked again every 30 seconds. The private file contains gateway, stable brain ID,
  OAuth credential and the last brain origin. Credentials refresh before connecting. `P2_RADIUS=0` disables it.
  Relay v4 HTTP uses credit and uplink backpressure; WebSocket channels work too. End-to-end `stream` channels
  remain unsupported. Only the credential's authenticated owner can reach Pi. Relayed loopback requests carry
  a per-resource secret checked by the plugin's `RequestResolvers` contribution; the host stamps an owner
  principal with `access: "relay"`, a remote origin, and normal same-origin checks. They may sign in to model providers,
  but cannot mint local tokens or receive a local owner cookie. Credentials never reach web state.
- **Server name** (core: `ServerName` in `src/runtime/server.ts`, `ServerNameSettings` for Settings, General): the
  owner's name in `identity.json` while one is set, else the device's name read at start. The server owns it; Radius
  keeps a copy for its shell: `?name=` on every host connect and `PUT /v1/servers/<id>/name` on a rename while
  connected, so a rename never reconnects (which would drop every channel). A failed or offline rename goes with the
  next connect; Radius never changes the name. Project places still name the machine by `os.hostname()`.
- **Ports** (`plugins/ports`): server-owned `forwards.json` registry; owner **Envs → Ports** lists/adds/removes
  forwards and confirms public opt-in. Every forward is private by default and has an isolated
  `https://fwd--<brain label>--<random id>.rdtun.com/` address. Public forwards additionally have
  `https://pub--<brain label>--<id>.rdtun.com/`; anonymous channels can reach only currently-public forwards,
  never Pi. Removed IDs stop working. Radius forwards HTTP and WebSockets to `localhost:<port>` with local
  Host/Origin, public `X-Forwarded-*` and rewritten localhost redirects, without the relay secret. Pi's own
  port cannot be forwarded. Links appear after the owner opens Pi through Radius and survive restart;
  on-device Open uses localhost. Radius sees forwarded traffic; this is not a sandbox.
- **Shell page and share links**: the brain keeps its page in the Radius shell, `<shell>/pi/<organization ID>/<brain>`,
  from the relayed requests' shell origin (`radius.json` `shellPage`; one saved in the older `/pi/brains/…` form is
  read in the current one). People a session is shared with by email get `<shell page>/s/<session>`. The shell names
  the organization by its slug once it opens; a kept link names it by ID, which a slug change leaves valid.
- The worker's root-only `ports` tool has `list/open/close`, fixes owner/peer attribution at its calling assistant
  entry, and denies guest/unattributed turns. It lists every forward and explicitly names all public endpoints,
  asks the model to obtain confirmation before publishing. As in Pi Mobile (67cdb4ca4) it may change or close any
  forward: open on an already forwarded port keeps its address and opener and takes the new name and visibility,
  whoever opened it; close stops any forward. Archiving awaits the `SessionArchived` cleanup contributions; startup
  removes any archived-session forwards left by an interrupted archive. A remote-environment session cannot open
  (mobile's message names the env); list and close work. The transcript shows mobile's `ports` card (summary,
  **Open … →** / **Public link →** from `details.forward`).
- `test/p2/ports.test.ts` covers persistence, validation, ownership, fake-provider tool calls, reload, guest denial
  and archive cleanup. `test/p2/radius.test.ts` uses only a disposable localhost fake gateway/relay: remote-owner
  admission and provider access, HTTP credit in both directions, congestion, forwards, redirects, WebSockets,
  unavailable ports and anonymous public/private gates. All listeners use port 0 and private temporary data.

### TUI through Radius

`npm run tui -- --radius [<server-id>]` reaches the server through Radius, without a tunnel or owner link. The
launcher signs in to Radius itself (device code, saved in `~/.pi/p2-tui/radius.json`, separate from any server's
`radius.json`), picks the given server or the user's only online one (`GET /v1/servers`), and connects to
`/v1/servers/<id>/connect` with its bearer token (`pi-server.client.v2`). Radius admits only the server's owner and
opens a `ws` channel without a request; the brain ("Client channels" in `brain.ts`) reads the request from the
client's first message and makes it a loopback request marked like the owner's browser requests, without a shell
origin (`access: "relay"`: no owner links). The launcher's requests go through a transport (`tui-transport.ts`,
`tui-radius.ts`); the direct cookie transport is unchanged. Only v5 relays (channel sockets) carry client channels.

**Temporary: one Radius connection per request.** Radius allows 120 new connections a minute per user, shared with
the server's own reconnects, so through Radius the launcher checks for a new bundle every 10 s instead of every
second, and every request (owner check, manifest, bundle, downloads, uploads) and every chord link reconnect costs a
connection setup. The proper form keeps one connection per launcher and carries all of its requests and its chord
link over it: every message labelled with the request it belongs to, both sides sorting them, and large transfers
taking turns with the chord link so a download cannot hold up live output. Then the 1 s bundle check returns.
`test/p2/radius.test.ts` and `test/p2/tui-radius.test.ts` cover client channels with the same fake relay.

## Browser navigation

`src/web/navigation.ts` is an independent, minimized copy of Pi Mobile's stack. `src/runtime/web.tsx` exposes
`useNavigation()` and `useRoute()` to plugins. Routes contain a session/conversation, named sheet/viewer layers
(with small string locators), the workspace location, and an optional bottom terminal; or, instead of a session, a
sidebar rollup's or group's list (`page`). Only the top modal shows. The stack and per-area scroll positions persist in this
tab's sessionStorage; URLs identify conversations (`/s/<id>` and `/s/<id>/c/<conversation>`) and section lists
(`/list/<key>`), not modal payloads. Restored locators may be unavailable.

- **Links that open in another tab.** In-app destinations are real `<a href>` links whose click handler is
  `inPage(act)`: a plain primary click acts in the page; Cmd/Ctrl/Shift/Alt clicks, the middle button and "Open in
  new tab" stay the browser's. Links take their address from `useLinkHref()` (`linkHref`): `routeHref`, which adds
  the top layer when it is a viewer (`/s/<id>?viewer=<name>&at=<locator>`); sidebar rows and list pages have none, so
  theirs is `routePath`.
  A page loading such an address starts with that viewer over the conversation (`pathRoute(path, search)`); the
  address bar then shows the conversation's path again. Only viewers are linkable: they only show content, and every
  content fetch is authorized by its route, so a link (also another site's) cannot open a sheet that acts. Not yet
  links: the "Back to main conversation" and parent-session buttons, peer-message attributions, Discord's bound
  sessions.
- **Framed by the Radius shell** (`src/web/shell-bridge.ts`). Through Radius the app runs in a frame of the shell
  (`radius.earendil.com/pi/<organization>/<brain>`) on the brain's origin. The page names the shell's origin
  (`<meta name="p2-shell-origin">`, relayed requests only), and the bridge speaks the frame's side of the shell's
  `pi-shell` channel: `ready` on load, the route's `routeHref` as `location` after every navigation, and the shell's
  `hello` base becomes the base of `linkHref`, so a link opened in another tab, or copied, is the shell's URL
  (`…/pi/acme/<brain>/s/<id>`), not the frame's. The shell only replaces its URL with each report; the app's history
  entries stay the tab's, so Back moves the frame. Messages go to the shell's origin only; nothing is posted when the
  page is not framed or not relayed. The shell's side and the contract: Radius,
  `client/src/views/pi-shell/frame-bridge.ts`. `test/p2/shell-bridge.test.ts` (origins, reports, base) and
  `test/p2/ui-shell-frame.test.ts` (the real bundle framed by a stand-in shell on another site: mirrored URL, links,
  one history entry per step, Back and Forward).
- `push`: one step at the tap; `replace`: lateral changes and server/startup corrections. A correction can pass
  its captured route as `replace(next, expected)` so it cannot overwrite a later queued destination.
- `close`: whole-modal ×/scrim/Escape, or a sheet/file parent; `reset`: workspace tabs, dropping visited files/commits.
- `closeThenPush`: drawer destinations; `backOrPush`: a child's parent link. Never use browser history directly in
  plugins. `navigate({ session, conversation })` applies conversation carryover and drawer-close semantics.
- `openLayer({ kind: "sheet" | "viewer", name, locator? })` pushes plugin screens; footer destinations use
  `{ fromDrawer: true }`. `closeLayers()` closes their whole stack. Shared sheets and viewers use `useScrollMemory`;
  custom changing scroll areas should do so too, with a key for the content they display.
- Android Chromium uses one CloseWatcher while there is a step to undo, without adding history entries or browser
  page-back animation. Other browsers use history entries. With no internal step, system Back leaves the app.
- Conversation destinations in the same session retain the workspace tab and terminal placement, but reset
  file/commit/search locations and never carry the request to start a terminal; another session opens with its own
  panels (below). Server events never push.
- **Panels per session** (`src/web/session-panels.ts`): the right-hand panels (the workspace and its tab, the terminal
  below the chat or on the workspace's Terminal tab, the side panel's plugin panel or activity) belong to the session
  they were opened in. Problem: they used to stay open across a session switch, so a terminal opened in one session
  also opened in the next. Now every route change remembers its session's panels in `localStorage` `p2-session-panels`
  (per device, the last 200 sessions that had one open; closing them all forgets the session), and `conversationRoute`
  opens another session with its own: as it last had them, none if it never had any. Within a session (its subagents'
  and `/tree` conversations) the open panels stay, as before: the panels are the session's, its terminals are too, and
  the workspace follows the shown conversation's location; only an activity, which is a block of one transcript, is
  dropped in another conversation. A page load without history state of its own (a link, a new tab, a typed address,
  the installed app's launch) restores the session's panels too; a reload or Back keeps its entry's route, as before.
  Restored are the workspace's tab (not its folder or file) and the terminal's ID (a closed one falls back to the
  newest running terminal); a terminal never starts on its own. Restoring never covers the chat: the workspace comes
  back from 900 px (below, it takes the screen), the side panel from 700 px (below, it is a sheet), the terminal below
  the chat always; a phone opens a session at its chat (the views plugin's rule). Sizes stay global per browser
  (`useDragSize`: the side panel's and the workspace's widths, the terminal's height), as does the terminal's
  preferred placement for a new terminal: a size suits the screen, not the session, and per-session widths would make
  the chat column jump at every switch. The views plugin's layout was per session already
  (`p2.views.layout:<session>`). Leaving a session detaches its terminal view; the programs keep running in the
  terminal host and coming back reattaches from a VT snapshot (Terminals). A link that opens a viewer (`?viewer=`,
  branch `artifact-newtab`) shows it above the session's restored panels; on phones the side panel waits beneath it
  (`useSidePanelShown`). Test: `ui-session-panels.test.ts`.
- **Drawer swipe** (`src/web/drawer-swipe.ts`, phone layout only): with no modal open, a drag toward the inline end
  (rightward; leftward in RTL) anywhere on the chat column (`main`) drags the drawer open; a drag toward the inline
  start on the open drawer or scrim drags it closed. Not on the workspace panel, which is full screen above the
  drawer on phones. A touch is a scroll or a swipe, never both: the browser sends one cancelable `touchmove` after
  its touch slop and scrolls unless it is cancelled, so the axis is decided on that move (within 35 degrees of
  horizontal and toward the destination: the drawer owns the touch and cancels every move; otherwise the page keeps
  it). This needs a non-passive `touchmove` listener; pointer events cannot cancel a scroll. A touch that interrupts
  a fling has no cancelable moves (Chromium); `touch-action: pan-y pinch-zoom` on `.app`, `.scroller` and
  `.session-scroll` keeps the browser from panning a flat drag then, and a scroll under such a drag ends it. The
  drawer follows the finger 1:1; release settles by velocity over the last 100 ms (> 0.3 px/ms), else by half its
  width, with an ease-out whose duration continues the finger's speed (120 to 320 ms). Inline styles stay until the
  route has rendered the matching `drawer-open` class. Captured moves do not propagate, so the transcript does not
  see them. Text fields, `touch-action: none` elements (the terminal, resize handles), horizontal scrollers that can
  still scroll in the drag's direction, and drags extending a text selection keep their touches. Modeled on Ionic's
  menu gesture, Framework7's swipe panels and MUI's SwipeableDrawer (no code taken).

## Diagnostics

Failed worker starts now publish `WorkerState.error` through `SessionStatus`, including failures before a process
could be spawned and fatal bootstrap failures after control readiness. The session view replaces its spinner with
the error, **Retry** and owner-only **Show logs**; the sidebar marks it **Worker failed**. A failed start stays
cached so background references cannot continually respawn it. Owner-only `WorkerControl.restart` (Retry) stops the
old instance, clears the failure and notice, starts a worker (holding `WorkerBoundary` itself when nothing else holds
the session) and answers with the outcome: once the worker runs, or rejecting `worker_failed` with why it could not
start, so the button shows pending and then the result; drafts and attachments stay intact. Creating a session
navigates to its view before awaiting the worker, so a failed first start also has a visible recovery screen.

**The page never goes blank** (`src/web/app-boundary.tsx`): the React root renders inside `AppBoundary`, which shows
a failure with **Reload** and **Reset this device's saved state for this session** (localStorage keys naming the
session, its panels, its cached conversations, the tab's navigation and draft, the service worker's kept page).
Render failures, uncaught errors and rejections, and failures a view pane's boundary catches are reported to
`POST /client-error` (logs plugin; same-origin, owner or guest, a bounded body; at most 20 per page load and 60 a
minute on the server): an owner's page becomes a notice of source `web`, a guest's only a log line. Persisted client
state is device data an older page may have written: the layout (`parseLayout`) and the session panels (each field
checked) drop what does not fit. Test: `ui-recovery.test.ts`.

Host `onError`, refused reloads and worker failures publish bounded, redacted owner notices (`LogNotices`), with
Show logs and Dismiss. Notices keep the latest error per source (at most 50 sources); normal shutdown/abort
messages do not become worker-failure notices. Archived-session admission refusals are not cached as crashes,
so restoring an archive still works without an extra Retry. Archiving stops the worker with
`SessionWorkerControl.suspend`, not `stop`: holders of the session's objects (a page's lingering conversation) wait
suspended until a restore (`resume`) or their release, instead of starting a worker the archive refuses. Neither guests nor workers may read or dismiss notices, or invoke
the worker retry control. Dev controls additionally publish their own reload/restart results.

The owner-only `logs` plugin adds **Logs** to the Settings window (`SettingsSections`). Its sheet selects Server, session workers,
Terminal host or Dev supervisor, filters text, follows the tail and copies only the visible lines. A `logs` sheet
locator is the source ID (`session:<id>` for a failed worker); opening it never starts or holds a worker. Source
changes replace the route, so Back/reload retain the selected worker. Guests and workers cannot acquire `Logs`:
the contract has only an owner variant and the factory independently checks the authenticated principal.

`src/runtime/logs.ts` keeps a process-scoped diagnostics buffer across compatible facet reloads: 1000 lines and
256 KiB of text per source, at most 128 recently active sources. Individual lines over 16 KiB are omitted, as are
partial stream lines over 64 KiB. Complete UTF-8 lines are assembled before redaction, including split writes.
Provider credentials, resolved config/header values, secret environment variables, owner keys/tokens, OAuth
access/refresh values, auth/cookie headers, Basic/Bearer auth and URL passwords are redacted before storage;
configuration rotations retain previously known secrets. Pending secret/manual-code login answers and OAuth
callback code/state/token parameters are registered before provider code uses them. Server capture starts before
plugin resources open. Capture is a tee: the original stdout/stderr writes, bytes, encoding, callbacks and
backpressure are delegated unchanged and immediately. Only a bounded deferred copy is assembled into lines and
redacted for the ring; capture never buffers or rewrites real output. Test processes do not install capture unless
a test explicitly opts in (`inTests: true`). The reporter regression opts in for a real `node --test` run and
checks that its binary transport completes correctly; a separate subprocess verifies partial writes, binary bytes,
encodings, callbacks and backpressure.

The server captures its stdout/stderr (including host `onError` and dev reload events), and worker lifecycle,
startup failures and stdout/stderr under each session source. The terminal host and dev supervisor publish private,
atomic, bounded, already-redacted `terminals.logs.json` and `dev.logs.json` snapshots. The server imports changes
at 300 ms intervals. A synchronous final snapshot retains fatal-error stacks and explicit exits. New terminal
hosts no longer append raw output to `terminals.log`; an already-running older host requires the existing explicit
Restart action to adopt this implementation. Server/worker buffers are in memory and reset with their process;
detached snapshots survive a server restart. The terminal log preload runs before the main module is parsed, so
syntax/startup errors are retained too. Focused tests: `logs.test.ts`, `ui-logs.test.ts` and status cases in
`test-host.test.ts`; the browser regression exercises the original `Unknown p2 plugin: settings` failure, sticky
startup fencing, the list marker, owner notice, worker-filtered Show logs and recovery through Retry.

## Decisions

- **Where p2 differs from Pi Mobile on purpose** (from the parity audit before Pi Mobile was retired):
  - **Section and tool order:** p2 offers sections and tools in plugin load order, which is alphabetical
    (`src/hosts/plugins.ts`). Pi Mobile's order is its hand-written install sequence in `worker/main.ts` (coding
    tools, artifact, send_file, subagent, conversations, ports, session title; then preamble, cwd, the app guide,
    AGENTS.md, skills; then code mode and PowerShell). Reproducing it would need a hand-maintained rank of every
    plugin's extensions, which is the manifest p2 avoids (no plugin declares an order). The sections' relative order
    already matches mobile's except that `codemode` comes before the app guide; tool order is cosmetic. Documented,
    not changed.
  - **Fake provider one-shot agents:** kept p2's automatic schema-valid answers (a one-shot agent whose task is not
    `json …`/`slow…` answers a small value matching its schema), so the workflow examples (`docs/workflows.md`,
    `workflows.test.ts`) run end to end; `json …` and `slow…` prompts behave as in mobile (exact answers, retries with
    non-JSON echoes, long streams). See p2-notes "One-shot agents" and the `P2_FAKE` row.
  - **Subagent messages move a session up the list:** kept. p2 indexes
    subagent messages (search hits open their conversation), and their activity counts as the session's.
  - Items the reports mark intentional (owner links, sharing revisions, no heartbeat lease, sticky failed starts, the
    "Session unavailable" screen, the Devices sheet, `/s/<id>/c/<n>` URLs, the extra p2 fake triggers) stay as decided.
- **Beyond Pi Mobile:**
  - **Composer file completion** (p2-tui-port.md P7c, `src/web/file-completion.tsx`, `src/runtime/completion.ts`): in a
    session's composer, `@` after a token boundary opens a list of the session directory's files and folders (the
    `file-index` plugin, ranked like pi's `@`), and Tab on a path-like token completes it from that directory. While the
    list is open, Enter/Tab apply, the arrows move and Escape closes it, ahead of send and stop; closed, the composer
    behaves as before. IME composition never opens it. `@pi` (chat mode's mention) is never completed as a file; in chat
    mode "@pi — mention Pi" comes first. `~`, absolute and `..` paths complete nothing (the hint says so). The
    new-session composer has none (the session does not exist yet). Pi Mobile has no composer completion; this is the
    shared behavior of p2's TUI and web. Test: `ui-file-completion.test.ts`.
  - **`enabledModels`** in settings.json (p2-tui-port.md P3): the TUI's scoped model cycling; Pi Mobile has no such key.
  - **Chat version 3** (P3): `compact`, `abortCompaction`, `reset` (owner) and `dequeueOwn`, and the guest-safe `model`
    state, used by the TUI; the web UI is unchanged.

- **Durable names are p2's.** Documents `p2.subagents`, `p2.agent-run`, `p2.views`; tasks
  `p2.subagent-anchor`, `p2.subagent-reporter`; entries `p2.input`, `p2.peer-message`; extensions `p2-artifacts`, `p2-downloads` (and the
  unprefixed `subagent-tools`, which subagent conversations store in their agent state). No `mobile.*` name is read.
  p2 sessions created before the rename (with `mobile.*` documents) are not migrated: their subagent registry,
  one-shot agents and artifact index look empty (owner decision). Pi Mobile sessions were converted to these names by a one-time
  importer when the phone switched to p2 (removed afterwards; see git history). Old `pi.user` inputs that carry
  their author only in a `<mobile-speaker>` text block are not read back (no reader for them is left): they show
  as plain text without an author and attribute no tool call.
- **Hosts are thin.** `src/hosts/*` only accept connections, spawn workers and load facets. Everything app-level is a
  plugin under `plugins/<name>/{contract,server,worker,web}.ts(x)`. `src/hosts/plugins.ts` lists the plugin
  directories (alphabetical load order) and records type ownership and references from actual `serve`/`get` calls at
  runtime; the server bundles the selected web facets with the browser host (`src/hosts/bundles.ts`).
- **Plugin layout** (for Chord v2's plugin builder, `@earendil-works/chord/plugins`): every plugin directory is a
  package (`package.json` named after the directory). Plugins import p2 and Chord only through p2's plugin API
  `@p2/app/v1` (`src/api/v1`): `@p2/app/v1` for every kind (browser-safe: contracts, principals, schemas, entry
  kinds, owner notices), `/node` for server and worker (configuration files, logs, Durable contexts, downloads,
  environments), `/server`, `/worker`, `/tui` and `/web` per kind (`/web`: the browser runtime and `src/web`'s shared
  components). The alias is in p2's `tsconfig.json` (which therefore repeats the repository's workspace paths;
  `plugin-layout.test.ts` checks they match) and in `src/source-resolver.ts`; the web and TUI bundles resolve it
  through the tsconfig. Across plugins only contract files: `contract.ts` (any kind) and `contract.<kind>.ts(x)` (one
  kind: the Durable documents `plugins/subagents/contract.worker.ts` and `plugins/locations/contract.worker.ts`, the
  envs plugin's directory picker `plugins/envs/contract.web.tsx`); a contract imports only the API, shared packages
  and its own plugin's files. What two plugins share otherwise lives in the base and reaches them through the API
  (`src/runtime/schemas.ts`, `entries.ts`, `notices.ts`, `origin.ts`, `environments.ts`, `downloads.ts`,
  `tui-chat.ts`). Base code imports no plugin code; only the page's shared components (`ModelPicker.tsx`) read
  plugin contract types (`import type`). A plugin's own files stay in the plugin, assets
  included (`plugins/terminals/vendor/ghostty`). Facets use no `import.meta`: the p2 app directory is start data
  (`Server.info.app`, `WorkerInit.app`). The terminal host (`plugins/terminals/main.ts`) is its own program, not a
  facet, and imports base code directly. `plugin-layout.test.ts` builds every server, worker, TUI and web facet with
  Chord v2's `buildFacet` against the API.
- **Runtime registries and locals** (`src/runtime`): `Routes` (HTTP by `METHOD /path`, exact path), `WorkerInitValues`
  (the worker's start data, contributed per plugin; a throw refuses the start, e.g. archived sessions; a contribution
  may wait, as the sessions plugin's does for a copy's files), `Hosts` (worker states, followed from the workers
  component; restart for the holders), `HarnessHost`/`HarnessNative`, `Extensions`, `HarnessConfig`, `Slots`,
  `useObject`/`useReadable`/`useStatus`.
- **No configuration process globals.** Diagnostics alone have native process-scoped buffers because they capture
  stdout/stderr before/after object activation and survive facet reload. Host configuration is the core's: `Server` (server: `info` = data dir,
  fake, tunnel hosts, port; `revokeOwners`, `revokeGuests`), the `ServerNatives` (resource options, the session
  workers, a root of the server's own) and `WorkerProcess` (worker: `init` spawn parameters, `liveness` counters,
  `location` (where the session works now, see **Relocation**), a root of the worker's own). Code outside Chord calls
  (Durable tools) runs in those roots; objects read registries with `self.registry(R).value`. The server
  listens before loading plugins (so `info.port` is final); requests wait until the plugins are loaded.
- **Harness:** the core's `HarnessHost` opens the native Durable Harness and contributes it to `HarnessNative`;
  dependents read it with `harnessOf(self)` (`.durable`). Its `environments` are
  what Durable gets (`ExecutionEnvironments`): `session` is the session's location now, `locate(id, context, read?)`
  a conversation's location (see **Agent locations**), `at(location)` the environment there (async: one machine,
  i.e. connection, per environment name, opened lazily and shared by every conversation working there; one
  environment per directory). `conversationEnvironment` does both; `locateConversation` locates from code that must
  not hold the Harness (a prompt section, a tool). Resolve at each use; a relocation changes the session's location.
- **Location tools** (`plugins/locations`): `location_envs` (this device and the configured SSH environments: name,
  host, last test; never keys), `location_dirs` (`[env:]path` or `env`+`cwd`, at most 200 folders) and `location_move`.
  Every main agent has them, and so do the subagents and one-shot agents it gives them to (by default it gives all
  its tools). The server side (`AgentLocations`) admits only current worker generations. The main agent's move is deferred: it records `p2.location-move` on the main
  conversation; the worker applies it through `SessionMoves` (the owner's Relocate) once Durable has no task or
  submission (the turn ended, no subagent work), retries a busy refusal after the next commit, records a destination
  that became invalid as `failed` (shown by `location_envs`), and applies a record left by a stopped worker after its
  next start. A subagent's `location_move` changes only its own location, at once: its next tool calls run there.
  `subagent spawn/configure` take `env` (null: this device) and `cwd` (relative to the caller's cwd on its
  environment, to the home on another), and configure `followSession: true`; another environment needs an owner
  turn; a location changes only while the subagent is idle ("… is working"). PowerShell is per agent: the deferred
  `powershell` tool is offered (the agent's `tools`/`modelTools`) to each conversation whose location's machine runs
  Windows and that has `bash`, re-decided after commits and moves. Tests: `locations.test.ts`,
  `relocate-worker.test.ts` (PowerShell per agent), `powershell.test.ts`, `envs.test.ts` (listing an SSH env).
- **Agent locations:** every conversation works at a location `{ env, cwd }` (`src/runtime/location.ts`, browser-safe).
  The main conversation works at the session's (the catalog's `env` and `cwd`); a subagent spawned without a cwd and
  every one-shot agent follow it dynamically; a subagent spawned with a cwd stores its own location, `{ env: the
  caller's environment, cwd }`, in its `p2.subagents` registry entry (`location`), fixed for its lifetime. The
  subagents plugin serves `ConversationLocations` (`place`: migrate and list followers and own locations; `own`: one
  conversation's own location), which the Harness consults for Durable's environment builder (by conversation ID,
  not agent cwd), tools, prompt sections, attachments, workspace, file index and the server's terminals
  (`Child.location`, from `ChildStore`). A relocation moves the main conversation and its followers only; subagents
  with their own location keep their environment and cwd and stay usable on their machine. Migration: the registry
  document is version 2; version 1's own `cwd` becomes `unplacedCwd`, which the worker places before its Harness is
  live with the environment the server recorded (worker init value `subagentLocations`, from `ChildStore`), else the
  session's spawn environment (version 1 refused to move a session to another machine while it had them).
  `ChildStore` (state version 2) turns stored rows with an own `cwd` into `location` with the catalog session's
  environment at its first read and saves them so. UI: the subagent bar ("· in gpu:/path" or "· follows the
  session"), the sidebar row (own location), the spawn card, the workspace header and terminal tabs (title) show
  `env:/path`; the TUI's `/agents` rows and spawn card likewise. Envs: deletion is refused and config edits restart
  workers while any session or subagent location uses the environment (`sessionsUsing`). Sharing: read/write links
  need the remote confirmation when any of the session's conversations works on a remote environment
  (`remoteEnvironments`; `Sharing.env` lists them).
- **Session lifecycle operations** (`SessionOperations`, server, a host-lifetime `local` object of the sessions plugin;
  its job runs persist in the server's Chord store `<data>/server/store.sqlite` and run again after a crash, each run
  idempotent): `relocate`, `clone`, `fork` and `archive` answer once their visible effect committed on the server and
  run their long part as a job. `create`, `clone` and `fork` take a client-chosen ID (`id`, `copy`), so a page
  navigates before the answer; a chosen ID already in the catalog answers its row (a retry). `clone` and `fork` answer
  with the copy's row at once; the copy's worker start waits (in its start data) while its files are copied and, for
  an ID held before its row exists, up to 10 s for the row. `relocate` validates the destination at once (a missing
  directory rejects) and starts the move; `archive` archives the row, then closes the session's `SessionArchived`
  contributions and suspends its worker in the job (`restore` waits for a running archive first). `Sessions.operations`
  lists the running ones (`copying` while a copy's files are copied) and the failed ones with their error until
  `dismissOperation`: a busy worker refusing a move or a clone, a failed copy (its row archived again, its files
  removed). The agent's `location_move` goes through `SessionMoves.relocate`, which waits for the job and answers the
  refusal (not recorded). Tests: `session-operations.test.ts`, `fork-clone.test.ts`, `relocate.test.ts`. The UI:
  the web's new session and the TUI's `/new`, `/clone` and `/fork` choose the ID and open the session at once; the
  sidebar row and the TUI selector show running operations and failed ones with Dismiss (`/dismiss-failed`), the top
  bar "Moving…" during a move (`docs/optimistic-ui.md`).
- **Relocation (in place):** `Sessions.relocate` (web Relocate, TUI `/cd`) does not restart a running worker.
  - **Server** (the relocate job; `SessionWorkers.relocate`, serialized with starts, stops and pauses): fences the worker with
    `WorkerBoundary.prepare` (refused while anything runs: "Stop the current run before changing directory", a named
    subagent, background work), updates the catalog, then calls `WorkerBoundary.relocate`, which runs
    `Harness.relocate` and lifts the fence. The fence counts as an active call, so the worker cannot stop idle
    meanwhile. The steps run in the job, not in the caller's call: an aborted call or closed tab cannot cut them off. A worker is never left fenced: a failed catalog update lifts the fence (`cancel`); a
    worker whose fence state is unknown (prepare failed after the fence, or cancel failed) is stopped. A worker that
    exits during the steps (crash, idle stop racing the fence) gets only the catalog update. While a step calls the
    worker (prepare, move, cancel), its route fails on a dead link instead of queueing a start behind the relocation,
    which would wait for itself (`calling`); stops, restarts and catalog updates without the worker hold route
    resolution, so arriving clients wait and then get a worker (`waiting`). A stopped worker only gets the catalog
    update and starts at the new location.
  - **Fallback:** if the worker cannot follow (its relocate fails, or takes longer than `moveTimeoutMs`, 60 s like
    a start), the catalog is already moved: the server stops and restarts it, and the start reconciles the agent cwds
    (its references go `gone` and are re-got). If that start fails too, the move still stands and the failure is the
    worker's error status (Retry), not the call's.
  - **Worker** (`Harness.relocate`), in this order: opens the destination's environment (a machine that cannot be
    opened refuses before anything moves), switches the session's location (followers locate there from then on),
    commits the root and its followers to the new cwd (the same step as at startup, after the placement provider
    placed what version 1 left unplaced), sets `WorkerProcess.location` (`SessionLocation`: its listeners reopen
    what they keep), then retires what nothing uses any more: environments at directories neither the session nor a
    subagent's own location uses (their running commands killed), and machines without any (their connection
    closed). A subagent's own location keeps its environment, on its machine.
  - **Plugins** read `location.value` at each use instead of `init.values.session` (which stays the spawn
    location). Between the switch and the commit, `location.value` still names the old place while
    `Harness.environments` resolves on the new machine: what depends on the machine is decided from the environment
    (`isLocalEnvironment`), never from the location (attachments). What is
    kept for a location is keyed by `location.version` (bumped at each commit): prompt resources load anew from the
    new cwd/machine (superseded loads publish nothing), workspace backends reopen their watch (subscribed before
    their first open; a failed reopen is retried at the next use, superseded watches closed) and bump `changes`, the
    file index drops its cache and builds in flight, dev-tools and PowerShell detect again. Chord resources reopen
    only on reload, so these resources keep their value and swap what it holds inside. Clients keep every
    reference: Chat, workspace, file index and prompt objects stay live.
  - **Refused:** busy work (above), a destination that is not configured or not a directory, and whatever a
    `RelocationChecks` contribution refuses under the fence (`prepare({ to })`; a refusal lifts the fence before the
    catalog moves; none is contributed now). Subagents with their own location never refuse a move: they stay.
  - **Unchanged:** cloning stops the worker (`pause`: the store is copied while closed; same fence handling; the
    copy's catalog entry is read after the pause); idle stops; env-config edits (`envs` stops idle workers using an
    edited environment, through the session or a subagent's own location, serialized after a move).
  - **Tests:** `relocate.test.ts` (cold move, live references with bash/prompt templates/workspace at the new cwd
    and the same worker generation, followers vs own location with their prompt templates, the restart fallback and
    its failing start, a failing update/cancel/prepare, an exit while fencing, a client arriving meanwhile, a
    cross-machine move accepted under the fence with an own location, a crash before the move, a move past its
    bound, caller aborts, fences, a busy refusal leaving no fence), `relocate-worker.test.ts` (one worker host with
    the real Harness: PowerShell after real moves, a
    move during workspace activation, a transient reopen failure, the session moving to another machine while a
    subagent's own location stays with its tools, workspace and file index, concurrent commands on two machines with
    one connection each and closing only unused machines), `harness-cwd.test.ts` (version 1 registry placement),
    `envs.test.ts` (local to SSH and back in place, an own local location staying while the session moves to SSH,
    real sshd).
- **Projects** (`plugins/projects`, owner; the TUI's selector and the web sidebar's Projects rollup): `projects.json` names a codebase's places, one per
  environment (README, Configuration). The server observes it as envs.json is observed (`ProjectService`: one observer,
  the last valid projects and the reason the last read failed); `Projects` serves them to owners with `local`, the
  server's hostname, which the TUI writes for this device.
  - **Membership** is explicit, never derived from a path: `ProjectService` keeps session ID → project name in a
    persisted document of the server's Chord store (`p2.project-sessions`), not in the session catalog, so the
    catalog's schema and the `Sessions`/`Catalog` contracts stay as they are and dropping the plugin leaves only an
    unused document. Written by `Projects.assign` (the TUI's project rows, before `Sessions.create`; the web sidebar's
    project "+", once the session exists; refused for a name
    projects.json lacks) and by copies: the sessions plugin's `SessionCopied` registry (called once a clone's or fork's
    row exists) gives the copy its source's project. Nothing clears it; archived sessions keep theirs; a project removed
    from projects.json leaves its name on its sessions.
  - **Selector:** with an empty search (owner, active sessions, at least one project) the list is grouped: each project
    row, its sessions below it, then "Other" ("+ New session" and the sessions of no project or of a removed one, the
    latter dimmed with the old name). Within a group the order is the sort's (pinned first, then newest; relevance
    equals recent without a query) and the threaded sort nests subagent conversations; rows show their env:cwd. The
    grouped list has no scope (every session, Tab does nothing, no scope in the header or hints, owner decision); flat
    lists (a search, archived sessions, guests, no projects) keep Tab's current-folder/all scope as before, except that
    a search typed in the grouped list starts in "all" (that list showed every session).
  - **Places** are never resolved on the server: the sessions TUI resolves them with `Envs.listDirectory` (which
    expands `~` there and fails when the machine is unreachable). The project rows probe every place each time the
    selector is shown (picks made with left/right reset then). A failed probe is classified from the error's message,
    the only part that crosses the link (`placeFailure`): Node's and the pi-env daemon's `ENOENT`/`ENOTDIR` and the SSH
    manager's "Working directory is not a directory" are `?` (no folder), "Environment … is not configured" is `✗`
    "no such environment", anything else `✗` with its message; the selected row shows these reasons on a line below
    it. Only `✓` places are used: Enter waits for the places in preference order and creates the session at the first
    reachable one's absolute path.
  - **`/move`** without an argument opens a picker (the `/envs` list overlay, `ListOverlay`) of all the project's
    places in projects.json's order: the session's own one marked `•` current (not probed), the others probed when it
    opens with the rows' marks and reasons. The cursor starts on the first other place not known to be unusable and
    moves on as probes answer, until one is reachable or the reader moves it (`ListOverlay.select`). Enter on a `✓`
    place runs `/move <it>`, on the current one says "Already here" and closes, other places are refused with a note;
    Escape cancels. No project or no other place: the same errors, no picker.
  - **`/move <env>`** takes the session's stored project (an error without one, or when projects.json no longer has
    it) and its place on `<env>`, resolved there. The subfolder is kept when the cwd is below the project's place on
    the session's current machine (`below`, textual, so that machine may be unreachable: `~/rel` matches `/rel` at
    segment boundaries after a non-empty home, `~` matches everything with no subpath) and the target has it, else the
    move goes to the target's root (with a notice when the subfolder is missing there). Then `/cd`'s flow (its
    confirmation, `Sessions.relocate`). Tests: `projects.test.ts`, `tui-projects.test.ts`.
- **Web sidebar** (`plugins/sessions/sidebar/`; README, Projects): the sessions plugin owns it, because the Session
  sheet's optimistic edits must show in the rows (docs/optimistic-ui.md). Three layers:
  - **Facts** (unchanged): the catalog's rows, `SessionStatus`, `SessionReads`, `Subagents`, `Sessions.operations`,
    `Projects` (projects.json and memberships), `Envs` (sandboxes) and `SidebarSettings` (below), read once by the
    sidebar (`useSidebarData` in `web.tsx`). The sidebar is always mounted; it publishes what a list page needs
    (`publishPage`), so the list page shows the same rows and edits, offline too, without holding its own copy.
  - **Rules** (`model.ts`, pure, `sidebar-model.test.ts`): a `Rollup` collects sessions into one section, in one of
    three layouts: a flat list (`sessions`: Recents), groups of sessions (`groups`: every project, one per folder, each
    with where its "+" starts a session; a sandbox folder `sandboxed`), or a link only (`link`: the Archive).
    `ROLLUPS` are the built-in ones, `ordered` puts them in the owner's order. `sectionsOf` shows every rollup and
    applies relevance (pinned, open, working, unread, a failed worker, an operation, or `updatedAt` within the rollup's
    window: `1d`, `3d` (default), `1w`, `forever`): a session shows in every rollup and group that has it, a group only
    with relevant sessions, a collapsed rollup or group only its row. `listPageOf` makes a rollup's or a group's list
    page: every session, the aged ones (outside the window) after the others, by group for a rollup of groups; the
    archived ones newest archived first. Keys: `recent`, `projects`, `folders`, `archive`, `project:<name>`,
    `folder:<base64url of JSON [env, cwd]>` (no slash, for `/list/<key>`). Folders take as many trailing path segments
    as tell same-named ones apart. Rollup order never follows activity. `glyphsOf` picks project glyphs by the glyphs
    plugin's `placeSeed` (below); a group's tooltip is its path (a project's: its places), a Recents session's its cwd.
  - **View** (`Sidebar.tsx`, `Row.tsx`, `ListPage.tsx`, `RollupSheet.tsx`), on Elanor's `Sidebar` and
    `SideNavigation` and icons (re-exported by `src/web/navigation-components.ts`). Every row is a `NavRow`: a marker
    column as wide as an icon (a session's working mark, a group's project glyph, folder or lock, a Recents session's
    glyph; kept when empty; a rollup has none),
    the label (a link; an action: restoring an archived session, switching to another branch; or, with `expanded`, the
    control that shows or hides what is below the row, Elanor's chevron right after the label), details (the time of
    the last activity last) and controls (⋯, "+", a branch's rename), all one control whose hover and selected
    backgrounds (Elanor's ghost fills) span the row; the label's hit area covers it. Labels are one line, cut with "…" at
    the end (`.nav-label`). No leading disclosure column, so nothing is indented by it: a group's row shows or hides
    its sessions, not indented (every session's working mark is in one column); a group's row is medium weight. The
    owner's list starts with a "New session" row in a group's type ("+" marker, a link to `/new`, the new-session
    screen, selected while it shows); the header holds the Pi logo (the Familiar's button) and the
    collapse trigger. A session's row is a link to its main conversation,
    selected while that shows (the label's hit area covers the row: the label is not positioned, so its `::after` is
    laid out on the row). Its other conversations (its branches, then its subagents and one-shot agents, the most
    recently active first) are below it, shown or hidden only by its chevron (`Toggle`, a button after the label;
    showing a subagent shows them), in the secondary style, their labels and working marks in the session's columns. A rollup's name is a link
    to its list, its chevron a `Toggle` after it; a collapsed rollup lists nothing ("No activity" is for an open one). Rows start and end on the bars' icon line (`--nav-edge`, style.css). An open session is selected
    in one place: where this tab opened it from (per session, in sessionStorage), else the first place it shows. The
    list page in the main area (`Route.page`, at `/list/<key>`; the `page` slot instead of `main`; `openPage` closes
    the phone drawer as opening a conversation does; top-level links to it authenticate as `/s/` links do) lists
    sessions only (no conversations below them, `listsConversations`), in the transcript's column (`--chat-size`,
    `--chat-width`) inside one scroller across the main area, as the transcript; it has a search within its sessions (`Search` 3's `sessions`), kept with its scroll position across Back, its "+" for
    groups, and the error toast (`ErrorToast`, shared with the chat).
  - **State marks** (`Row.tsx`, the top of `style.css`): a row says two things in two places. The marker says whether
    a session runs: `IconMarker` frames the row's icon (a glyph, a folder, a lock) with a dash travelling around it
    (22px, 3px outside the icon, clear of a glyph's corner cells), `WorkingMark` is a spinner where a row has no icon (a
    group's sessions, conversations, the Familiar's logo, a collapsed rollup's details). That is the sidebar's only
    motion. The row's end says whether it wants the owner, steady: an unread answer makes the title bold
    (`.session-title.unread`) with a blue dot before the time (`UnreadMark`); a failed worker shows a warning sign and
    "Failed" (`FailedMark`, the error in its tooltip). Each state has its own shape, not only a colour (spinner or
    frame, dot, warning sign), so colour blindness does not merge them; the dots used to sit on a glyph's corner in the
    glyph's own colours. With reduced motion the spinner is a still ¾ ring and the frame dashed; in the phone's closed
    drawer they pause. A collapsed group or rollup sums up what it hides (`hidden`, `activityOf` in `model.ts`): a
    group frames its icon while one of them works, a rollup shows a spinner, and both count the failed ones (warning
    sign) and the unread ones (a blue count). The top bars' menu button (`menu-badge` slot, `MenuBadge` in `web.tsx`,
    rendered by the chat's and the list page's bar) counts the other live sessions that want the owner (`wantingOf`: a
    failure or an unread answer, the open one left out), red when one failed. The sidebar publishes it, as it publishes
    the list page's data. A "needs input" state waits for questions and approvals (`docs/waiting.md`).
  - **Settings** (`sidebar-settings.ts`, `SidebarSettingsStore`/`SidebarSettings`, owner): the rollups' order, windows
    and collapsed rollups and groups, one persisted document in the server's store (`p2.sidebar-settings-state`): a person's
    view, not the catalog. A project's "+" sets the new-session screen's location and a join (`NewSessionJoin`:
    `Projects.assign` once the projects are live), which the chat plugin runs once `Sessions.create` answered (a refused
    creation leaves no membership; a failed join shows in the toast) and clears after. Tests: `sidebar-model.test.ts`,
    `sidebar-settings.test.ts`, `ui-sidebar.test.ts`, the scoped search in `search.test.ts`, list links in
    `foreign-requests.test.ts`.
- **Project glyphs** (`plugins/glyphs`): `glyph.ts` (pure, browser-safe) draws a 3x3 identicon in the Radius mark's four
  colors from a seed (a path or a name; paths in their `shortPath` form, so `/Users/me/x`, `/home/me/x` and `~/x` draw
  one glyph): SHA-256 of `glyph-v1:<seed>` seeds two sfc32 streams, one for colors, mirror axis and corner style, one
  for cells and shapes (fan, leaf, drop, dome, wedge, circle, diamond, square). It is the "Tiles, 3x3" generator of
  the project-glyphs prototype (Radius artifact) with its recommended settings, and draws the same glyphs. Mirror
  axes only (vertical, horizontal, both diagonals): every glyph is mirror-symmetric, so none is a pinwheel (a
  swastika); 3x3 cannot hold one anyway. `plugins/projects/glyph-seed.ts` decides which glyph a place shows (`placeSeed`, kept with the projects it reads so other plugins' web facets can import it alone): a project's is
  seeded by its first place's path, and a folder or a session inside one of its places (a session also by membership)
  shows the project's; any other place its own path's. `GlyphIcon.tsx` draws one inline (the sidebar's groups and
  Recents, the chat's top bar before the location; the chat page holds `Projects` once for it, owner only);
  `GET /glyph.svg?seed=<seed>&size=<8 to 1024, default 64>` serves one as an SVG file to anyone (it reads no data; the
  seed is at most 1024 characters), cacheable for a day and embeddable from other origins. Tests: `glyphs.test.ts` (the prototype's output, seed forms, colors, symmetry),
  `sidebar-model.test.ts` (`glyphsOf`), `ui-sidebar.test.ts`.
- **Rollups made from code** (`plugins/rollups`; README, The web sidebar): a saved script over every session that returns
  one sidebar section, in the built-in rollups' layouts. The script decides what a rollup collects; the sidebar decides
  what it shows, so the window, sticky sessions and the owner's settings work the same as for the built-in ones.
  - **Schema** (`contract.ts`): `RollupOutput` is `{ layout: "sessions" | "link", members }` or `{ layout: "groups",
    groups: [{ key, name, title?, keep?, target?, members }] }`. A member is a session ID or `{ id, at?, keep? }`:
    `at` is the time the window compares and the list sorts by (default `updatedAt`), `keep` shows it whatever its time;
    a group's `keep` shows it without a relevant session; `target` (a folder, or a project by name) is where its "+"
    starts a session. `RollupDefinition`: `key` (sidebar key `rollup:<key>`, groups `rollup:<key>:<keyPart(group
    key)>`), `name`, `window` (a sidebar window the owner can change, or `none`: every member shows), `refresh`, `code`.
    The script's output is checked against the schema on the server (the trust boundary); a failed run keeps the last
    good output and records why.
  - **Input** (`runner.ts`, `inputOf`): `sessions` (every session but the Familiar's, archived ones included, oldest
    first, with `project`, `state` stopped/idle/working, `error`, `unread` and `model` as `provider/modelId`),
    `projects`, `now()`, and `await mentions(query, { since })`: the sessions with a user or assistant message matching
    the query (subagents included; `ftsQuery`'s keywords, all required), each with the time of its latest one, from
    one query over the search index (`SearchIndex.mentions`, version 2; a few milliseconds on 4k messages), never the
    transcripts. Scripts run in a code mode sandbox without tools (`CodemodeSandbox`, 5 s, 64 MiB), the input passed in
    its store; `mentions` is the sandbox global `__p2Mentions`, called with the run's token so it runs in the run's
    context.
  - **Refresh** (`server.ts`): `auto` runs again when what the script read changed (a routine over the catalog,
    status, read marks, projects and the Familiar's session, never over the rollups' own results: a script reading
    `now()` would otherwise run in a loop on its own write; one queue per rollup), and on the 30 s tick when it reads
    `now()`; `every` checks on its interval (the same tick) and runs when what it read changed; `manual` only by hand.
    Every rollup can be refreshed by hand (`refresh`), and saving one runs it. **What it read:** the wrapper hands the
    script proxies that record each session field read (`sessions.cwd`; `sessions.*` after a spread or
    `Object.keys`), any read of `projects`, `now()`, and each `mentions` call (`mentions:{"query":"p2"}`); the
    fingerprint (`fingerprintOf`) is a hash of the sessions' IDs in order plus those values, with what each `mentions`
    call answered (asked again for a check: one index query each). Equal fingerprints skip the run: a script is a
    function of what it read. A rename does not re-run a rollup that never read `title`; a new message re-runs a
    `mentions` rollup only when it changes what the call answers (indexing a message touches the catalog, which wakes
    the check). A failed run counts as having read every session field and the projects: it runs again once anything
    changed.
  - **Who:** `SidebarRollups` serves the owner (state and methods) and the Familiar's current worker (variant
    `familiar`: `list` and the methods; other workers, stale generations and guests are refused). The Familiar's worker
    gets the `sidebar_rollups` tool (`worker.ts`: list, preview, save, refresh, remove; its description renders the
    input and output schemas as TypeScript), offered in its tool lists; preview runs a script against the sessions now
    without saving. Definitions and last results are one persisted document in the server's store (`p2.rollups`), not
    the Familiar's session: the sidebar needs them while its worker is stopped.
  - **Sidebar** (`plugins/sessions/sidebar/custom.ts`): `customRollup` turns a saved rollup into a `Rollup` (its IDs
    resolved to the sidebar's live rows, archived and unknown ones dropped; a session in several groups takes its first
    member's `at` and `keep`); `Rollup.window`, `timeOf` and `keeps` and `Group.keep` carry them through `sectionsOf`
    and `listPageOf`. New rollups go before the Archive until the owner moves them. Their options (`RollupSheet`) say
    how they refresh, when they were last checked and why the last run failed, with **Refresh now** for `every` and
    `manual`. Tests: `rollups.test.ts`, `sidebar-custom.test.ts`, `ui-rollups.test.ts`.
  - **Not yet:** scripts with tools (`bash`, `models.classify`) for `every` and `manual` rollups, which would run in
    the Familiar's worker; a declared cheap check (for example `git rev-parse HEAD`) that decides whether such a
    script runs; editing a rollup's code from its options; the TUI shows no rollups. `auto` rollups run on the
    server, so after an edit (a new or moved session) their section follows one round trip and a run later; the
    built-ins are computed in the browser at once. Running `auto` scripts in the browser would need QuickJS in the web
    bundle (about 640 KB of wasm, `InlineCodemodeSandbox`), which p2 does not ship today.
- **Principals** (`src/runtime/principals.ts`, typed: `P2Principal`, with Chord's API typed by it in
  `src/runtime/chord.ts`): `owner` (a local owner session on loopback `access: "local"`, authenticated Radius `access: "relay"`, or a
  signed owner cookie `access: "device"` with a device ID), `guest`, `worker` (stamped by the server's `session:` route
  with the spawn generation), `server` (the server's own requests as a worker sees them, from the worker's `connect`)
  and `host` (every host's own code, `createHost({ self })`). Object keys: `owner:local`, `owner:relay`,
  `owner:device:<id>`, `guest:<id>:r<revision>`, `worker:<session>:<generation>`, `server`, `host`. Device IDs isolate
  cookie holders so logout can revoke their live objects/links; "revoke all remote owners" is two propagating patterns
  (`access: "relay"`, `access: "device"`). The owner's name on entries is settings.json `ownerName` (default "Owner"),
  read by the worker (`WorkerModels`, hot-reloaded) when it writes an entry; entries keep the name they got.
- **Placement** (Chord's `host` on remote contracts, `src/runtime/chord.ts`): `serverHost` (the server) or
  `sessionHost` (`session:` + the input's `session`). No caller names a host (no `at`): `get`, `hold`, `useObject`
  and the TUI's `watch` go where the contract places the input. `WorkerBoundary`, `SessionTransfer`
  and `PluginRemoval` (version 2) take a `session` input for that. Moving a type is a contract break.
- **Authors** are assigned by the worker from the principal and stored in the input's entry data (`p2.input`,
  `src/runtime/input.ts`); a peer session's message is a `p2.peer-message` entry, a subagent's report or `team`
  message a `p2.agent-message` entry (`src/runtime/entries.ts`). Their model message starts with a
  `<sender kind="owner|guest|session|subagent" …/>` block (`src/runtime/sender.ts`, values escaped; a subagent's
  text follows as `[<intent>] <text>`), which the preamble explains and nothing reads back: readers use the entry data.
  Stop/dequeue restore text only to its author; removing a queued input (×,
  no restore) discards it, as in Pi Mobile.
- **Windowed conversation view** (`plugins/chat/worker.ts`, `src/web/history.ts`, `src/runtime/conversation-stats.ts`):
  `Chat.view` is Durable's view as is: a window over the transcript (the fork-aware history in entry ID order, head
  markers in place), the newest 50 entries, then appends, back to 50 past 100, `before` the entry just before it. The
  worker holds one Durable watch per conversation (default window), shared by every viewer. Clients (web and TUI)
  keep a `TranscriptStore` per host and conversation over Durable's `ConversationTranscript`: every value of the view
  is merged in, so entries that leave the window stay; scrolling up loads earlier pages (`Chat.entries`, 100 entries
  or about 1 MB a page); a reconnect re-hydrates the shared window and its merge continues the transcript, or leaves a
  gap when more was committed meanwhile than the window holds. There is no per-client `transcript.resume`: Chord
  state is one cell per object, and the merge gives the same items. A gap is a "Load more" row styled as the top edge
  (`button.history-edge.earlier`), filled a page at a time while it is rendered (the virtual list renders rows near
  the viewport) and on a tap; in the TUI a muted "Load more" line, filled while it is in view. Reply quotes and search
  hits load earlier pages or gaps until their entry is there (`loadThrough`). The active context's numbers (context
  tokens, latest usage) are `Chat.stats`, kept in the worker by `ContextTally` (`src/runtime/conversation-stats.ts`)
  from the entries the window appends: the latest counted response's reported usage plus pi-ai's estimate of what
  follows it, about 4 µs per appended entry. Partials are `pi.live` changes and append no entry, so streaming costs
  nothing here. It reads the whole context (`Conversation.context()`, a scan of every active entry: 13 to 18 ms at
  3,000 entries) only at the start, after a compaction, reset or edit, and when the window skipped entries. The cost
  sheet reads `ChatCosts`, from `context()` when it opens. Measured with 3,000 seeded entries (fake provider, slayer):
  opening sends 50 entries (125 KiB, 14 ms) instead of 101 (251 KiB, 33 ms); paging to the start 30 pages, 244 ms
  (before: 29, 186 ms); building the whole transcript 1.3 ms (before: 10.9 ms).
- **Run failures** (`pi.live.runFailure`): why the newest run ended without an answer shows as a failure notice at the
  end of the transcript (web and TUI, the error notice style) until the next run starts: `model_error` and `no_model`
  "The model could not answer this input. <detail>", `faulted` "The run failed: <detail>", `orphaned` "The run could
  not continue: <detail>", `interrupted` "The answer was interrupted: the server stopped while the model was
  answering.", `restart_limit` "The run was stopped after repeated restarts. <detail>."; nothing for `aborted` (Stop)
  and `reset`. A blocking compaction failure that ended the run shows once (its compaction notice). p2 no longer
  writes `app.model-error` entries (they projected unanswered inputs before Durable had `runFailure`); stored ones
  still render.
- **Sheet swipe** (`src/web/sheet-swipe.ts`, phones only, below 700px where sheets are bottom sheets): a downward
  drag on a sheet's top edge (a grip above its header, and the header; both `touch-action: none`) always moves
  it with the finger and fades its scrim; release closes it on a downward fling (> 0.3 px/ms) or past 30% of its
  height, else it settles back; the route closes when the slide out ends. Owner decision (as iOS's sheets and Elanor's
  drawer): a drag down in the content pulls the sheet too when the content is at its top; scrolled, it scrolls the
  content, and once that reaches its top the same finger pulls the sheet on (`resume` in drag-gesture.ts: a touch left
  to the page offered again at each move). Fields and `touch-action: none` elements keep their touches; the content
  has no rubber band at its top (`overscroll-behavior-y: none`). Upward pulls give 20%. Both swipes share the drag
  mechanics (`src/web/drag-gesture.ts`: following one touch, deciding its axis within 35 degrees and owning it with
  cancelable moves, release velocity, settle timing); each supplies where it may start, which direction it takes, how
  it paints and what release means.
- **Arriving messages** (`useArriving` in `Chat.tsx`): rows appended after the previous last row while the transcript
  grows fade in and rise 8px (0.28 s, 45 ms apart, at most 360 ms of delay; none with reduced motion). Not the first
  rows, older history, rows replaced in place (a streaming answer committed, a sent message the server now shows) or
  rows the virtual list mounts again. Opacity and transform only, so no layout or scroll change. While following the
  answer, the transcript glides up by the appended rows' height (`#glide` in `use-chat-scroll.ts`: a 0.32 s transform
  animation on `.messages`, at most a viewport) instead of jumping. A transcript appearing fades in (0.18 s), and large
  spinners show only after 0.4 s, so a fast load (a kept conversation) never flashes one. All off with reduced motion.
- **Reopening the last conversation** (`resumeRoute` in `src/web/navigation.ts`): the installed app (standalone display
  mode, iOS `navigator.standalone`) launching at `/` reopens the conversation open when it was last used (recorded on
  navigation and when the page is hidden, `localStorage` `p2-last-conversation`) if that was less than 2 hours ago.
  The new-session screen forgets it; a browser tab opening `/` and a launch with another address are unaffected;
  signing out forgets it.
- **Home and the new-session screen** (`Route` in `src/web/navigation.ts`): home is `/`, a route without `session`,
  `page` and `newSession`; the chat shows the `home` slot there (the Familiar's, which replaces the route with its
  session), else the new-session screen. The new-session screen is `/new` (`NEW_SESSION`, `openNewSession`): the
  sidebar's "New session" row and a group's "+" open it, and a session archived or removed while viewed is replaced by
  it.
- **Conversations kept on the device** (`src/web/conversation-cache.ts`, IndexedDB, the owner's browser only): the
  transcript's newest entries without a gap among them (up to 4 MB) as a window (`before` the entry just before them),
  with the documents but without the live run and queue, and the measured row heights, of the 20 most recently used
  conversations, saved a second after changes and when the page is hidden. A page opening a conversation shows the
  kept one at once (cold start, reload after an update) by seeding its `TranscriptStore`; the first live view is
  merged in when it continues it (its `before` is one the kept entries reach), else the transcript starts over from
  the live view (no gap), as it does when the kept entries are newer than the live view's newest (the server lost
  them, e.g. restored from a backup). The database is version 2: what version 1 kept (a view and history pages) is
  dropped once. Kept conversations of sessions missing from the owner's session list are forgotten whenever it
  changes (`keepSessions`). Whether the browser was the owner is remembered in `localStorage`
  (`p2-owner`), so the composer is there before the connection; signing out, or the server saying this browser is no
  longer the owner, forgets both.
- **Elanor** (Earendil's design system): `@earendil-works/elanor-react`, `design-tokens` and `elanor-fonts` from npm
  (`elanor-react` brings `elanor-icons-react`, and Base UI). The repository's `.npmrc` exempts `@earendil-works/*`
  from its two-day `min-release-age`, so a new Elanor release installs at once.
  `src/web/elanor.css` loads the fonts (Mallos Serif, Commit Mono), the pi brand's tokens and the components' styles,
  before `style.css`. Cascade layers: `p2-reset` (p2's element resets in `style.css`), then `elanor` (all of
  Elanor's styles), then p2's unlayered rules. The tokens follow `<html data-color-scheme>`, set with `data-theme`
  (`theme.ts`, and the page's inline script). Fonts are files of the base bundle's assets (`.woff2`, `font/woff2`).
- **Markdown in Elanor's components** (`src/web/ElanorMarkdown.tsx`): `Markdown.tsx` renders through a component map
  (`MarkdownComponents`, `MarkdownComponentsContext`; `{}` renders plain elements), Elanor's by default: `Prose` with
  its flow spacing, `Text`, `Heading`, `List`, `Link`, `Table`, `CodeSnippet` with Copy, a read-only `Checkbox` for
  task items. p2's parser, its safety (raw HTML as text) and its streaming are unchanged. `elanor-markdown.css` sets
  the font family to the interface's sans (`--sans`) instead of the pi brand's prose serif, keeping Elanor's sizes and
  code font; the streaming dot and a marker's spacing are there too.
- **Service worker** (`public/sw.js`, served at `/sw.js` with `no-cache`): the app starts without the network once it
  was opened. App pages come from the network first and fall back to the last app page kept (on failure, or after 3
  seconds); the web surface's content-named files (`/_chord/web/…`, not `/_chord/web/base`) come from the cache first (the newest
  two base versions are kept);
  everything else goes to the network untouched. Pi Mobile had none because it would have kept stale code across Vite
  HMR and restarts; p2 serves no source modules (dev mode included), so every kept file is content-named and the page
  never wins over the network. Signing out deletes its caches.
- **Sending never waits** (`plugins/chat/outbox.ts`): Send clears the composer and the message shows at once as it
  will look (a person's message, or a queued input while a run is busy), whether or not the page is connected. A
  per-conversation outbox sends in order whenever the conversation's chat object is live, each message with its own
  request ID, so a retry after a lost answer is admitted once. Refusals (`forbidden`, `invalid`, a rejected upload) and
  a send failing six times while connected put the text, attachments and reply target back into the composer with
  the error; Stop takes back what was not sent yet. The outbox lives for the page: leaving with unsent messages asks
  first. Who the page is (`useOwner`, a guest's grant) is kept while reconnecting, so the composer never turns into
  the "Connecting…" bar after a drop; only a page that never connected shows it. A message sent before the
  conversation has loaded shows alone until it does. A message whose send started while no run was busy stays a
  message until its entry shows: the run it starts lists it as queued for a moment, and the server's state can arrive
  before the send's answer, so it would otherwise flash as a queued row above the composer and move it.
- **A new session's first message** (`plugins/chat/session-start.ts`) does not wait either: Send on the new-session
  screen clears the composer and shows the message there at once, online or not, above the session's (empty) context
  bar, so the composer stays in place when the session opens; it is the same composer (see **Chat frame**), so it
  keeps its focus and a phone's keyboard. The session is created (with the location and model chosen at that Send) whenever the owner's catalog is live, its messages move to the main
  conversation's outbox, which delivers them, and the page opens the session. Messages sent meanwhile join the same
  session. A creation the server refuses (its own errors: a missing directory, an unknown model) puts the messages
  back into the composer with the error; a connection failure is retried like an outbox send. The page chooses the
  session's ID at the first Send, so a creation whose answer was lost with the connection is tried again with the same
  ID and answers the same session; the new session's worker starts beside the creation (the page holds its main
  conversation while `create` runs; the worker's start waits for the row).
- **Chat frame** (`Main` in `plugins/chat/web.tsx`): the chat's `.chat` area and its dock outlive the screens shown in
  it (the new-session screen, a conversation, the next one). There is one composer, in the dock: a screen publishes
  what the dock shows (`useChatScreen`: a bar above, the composer's settings, queued rows, the footer, or a bar in the
  composer's place) after each of its renders, and renders its transcript into the frame's `.chat-view` (a
  `display: contents` element) through a portal. Changing screens never replaces the composer's textarea, so it keeps
  its focus and a phone's keyboard. Slots wrapping a screen start with the plugin registry's known table
  (`knownRegistry`), so a screen mounts once, not again when its wrappers arrive a render later.
- **Virtual transcript** (`src/web/use-chat-scroll.ts`, `virtual-list.ts`, `row-estimate.ts`, `scroll-gesture.ts`;
  after TanStack Virtual and react-virtuoso, without depending on either): the web transcript renders only the rows
  near the viewport (one viewport of overscan each way, everything up to the first row near the list's start) between
  two spacers rendered with the rows. Rows carry their spacing as padding, so a row's border box is all it adds. The
  scroll position counts from the top, so content arriving below the reader (an answer streaming in, tool calls, the
  composer growing) moves nothing and needs no correction; following the answer writes the end. Changes above the
  reader (older pages, rows measured for the first time) are kept by the browser's scroll anchoring where it has it
  (`overflow-anchor`, Chrome and Firefox; the spacers are never anchors), also mid-fling and under a finger. Without it
  (Safari) the first visible row keeps its place: compared in content coordinates while the reader scrolls, on screen
  otherwise; written to `scrollTop` when nobody scrolls, held as a transform of `.rows` while a finger is down, a fling
  or the wheel's smooth scroll runs, written once the scroll settles or right away near the edge it would push content
  past. Rendering a row at an end of the range can itself move the scroll position (scroll anchoring) and with it the
  range; a range change that drops exactly the rows the last change added keeps them (`#updateRange`), so the list
  settles instead of rendering every frame (`ui-virtual-scroll.test.ts`, fixture `edge-row.ts`). Measured heights are
  kept per conversation (`keptSizes`, 8 conversations); rows never shown are estimated from
  measured rows (`rowEstimates` in `Chat.tsx`: per row kind, a line over text length per width; images exact from
  their headers, `image-size.ts`; one fallback height before anything is measured). Older pages load while the reader
  is within 3 viewports of the loaded start, and the top edge (Earlier messages, a fading spinner, Start of
  conversation) has one height in every state. Rows far from the viewport are not in the DOM: browser find-in-page and
  tests see only rendered rows (`.rows[data-rows]` counts them); `jumpToEntry` reveals an entry through the list
  (`revealInTranscripts`).
- **References**: an awaited `ctx.get`/`host.get` is live with its state; UI runtimes hold synchronously
  (`host.hold` in `useObject` and `TuiScope.watch`) and read state through `useReadable` (undefined until hydrated).
  Chord rebinds a held reference by itself (a dropped link, a restarted worker, a reload); the UI never holds one
  again. Multi-variant references narrow with `liveIn(ref, ...variants)` or `useObject(type, params, { variant })`;
  a TUI `watch` binds once the reference is live, so its callback narrows on `ref.variant`. Tests use
  `holdIn(host, type, params, variant)`.
- **Optimistic UI** (`docs/optimistic-ui.md`): actions show their effect at once (`useOptimisticCall` on the web,
  `scope.optimistic(read, reduce?)` in the terminal, Chord's `TuiScope.optimistic`), long work shows a pending state,
  refusals roll back with the error.
- **Lingering views** (`UI_LINGER`, `src/runtime/refs.ts`): the web's `useObject` and the TUI's `TuiScope` release a
  Chat reference 2 minutes after its view goes (at most 4), so switching back to a conversation binds at once; a
  lingering reference keeps the worker up (a reference over its link). Transcripts live per host and conversation (`transcriptOf`, at most 4 not
  viewed), and a view taken again merges its snapshot into them.
- **Worker liveness**: Chord's `host.activity` (references over the worker's links, running jobs such as a user
  shell command, lingering objects such as a `Conversation` for 30 s) plus p2's counts (active
  calls under the relocation fence, Durable tasks); the host manager stops an idle worker after `P2_IDLE_MS`. Browsers re-`get` a reference that went `gone` (`useObject`).
- **Durable state is followed, never copied** (`self.follow` over Durable's synchronous observers): a
  conversation's view (`observeConversation`, shared by every viewer through `Conversation.view`), chat mode's switch
  and name (`observeDoc(ChatModeDoc)`), a conversation's artifact list (`observeDoc(ArtifactDoc)`), the task graph
  (status). A document nobody wrote yet is absent and cannot be followed, so chat mode and artifacts create it empty on
  first follow. A method that writes such a document returns after Durable's commit, by when the follow has the new
  value (`chat-mode.test.ts`). The same holds for p2's own natives: `PromptResources` follows the prompt loads.
- **Sharing** (`plugins/sharing`): `Shares` (server local; its tables in the server's store, `plugins/sharing/store.ts`:
  links and grants keyed by their session's address (`host(Session)`), guests with a revision; its lists are live
  queries over them), `Presence` (connected
  guests: derived from `host.references(GuestPresence)`, design §19), `GuestPresence` (held by a guest page's web
  facet; a link drop is a leaving), owner-only `Sharing` (links, connected guests, link/reset/remove). Guest
  principals carry their grant revision; removal, link reset, archive and restore bump it and call
  `invalidatePrincipal`, so the guest's objects go `gone` and its socket closes. The server consults the
  `Authenticators` registry (guest cookie) and `SessionAccess` (guests reach only their session at the current
  revision). Guest names are unique per session ("Alice (3)"), as in apps/mobile. The web share sheet is a
  `session-actions` slot in the chat top bar, held in the navigation stack; Back closes it and reload restores it.
  `test/p2/sharing.test.ts` covers guests over WebSocket; `ui-drawer.test.ts` a read-only guest page behind HTTPS.
- **Files** (`plugins/files`): `POST /upload?session=&name=` (owner or read/write guest of the session; exact
  same-origin `Origin`; 25 MiB) streams into the session's `Files` (space `uploads`, path `<id>-<name>`, key the
  upload's UUID, `source` `owner` or `guest:<id>`) through the worker's `SessionFiles` (server only, chunked; a failed
  upload is cancelled) and answers `{ id, name, size, mimeType? }`. `Chat.send({ attachments: [ids] })` resolves IDs
  through the worker's `Attachments` local (only uploads of that session): each is materialized before admission into
  the data directory's `uploads/<session>/` on this machine (for the default data directory that is
  `~/.pi/p2/uploads/<session>/`) and, when the receiving conversation works on another environment, into
  `~/.pi/p2/uploads/<session>/` there; the message lists those paths, with images inline (from this machine's copy)
  when the model accepts them. `DownloadStore` (server local) snapshots a server file into the session's files;
  producers on the worker (send_file) write there directly (space `downloads`, key the snapshot's UUID). `GET|HEAD
  /download?session=&id=` serves them through `SessionFiles` to the owner and the session's guests (no
  `Sec-Fetch-Site: cross-site`; ranges for audio/video). An archived or unknown session's downloads and artifacts
  answer 404 at once, and an upload to an archived session 409 (its worker would never start; the routes check the
  catalog before they reach it), until it is restored. Web: the composer's attach button, drag/drop and pasted images
  upload files at send time, including a new session's first prompt. A paste with plain text stays a text paste
  (Office apps add a picture of the copied text, Chrome on macOS a Finder file's icon); a paste with only images
  attaches them.
- **File index** (`plugins/file-index`): `FileIndex({ session, conversation })` (participants, as `Workspace`) answers
  `@` completion (`complete`, ranked like pi's `@`) and Tab completion (`list`, one directory) for the TUI and the web
  composer. A worker-local cache per conversation (`FileIndexCache`) builds from `WorkspaceBackend`'s `files` query
  (git ls-files or the bounded walk, `truncated` surfaced), derives directories from paths,
  and rebuilds lazily when `changes` advanced (at most once a second). Cwd-relative only (`~`, absolute and `..`
  complete nothing). Text handling shared by both UIs: `src/runtime/completion.ts`. p2-tui-port.md sections 8, 10.2.
- **Workspace** (`plugins/workspace`): owner/read-write-guest `Workspace({ session, conversation })` queries a
  worker-local backend shared by that conversation's viewers. Owns its environment-backed workspace
  reader, types/path/glob helpers, fuzzy filename ranking and `WorkspaceFile` (safe previews, inline diffs,
  line comments, outdated quotes). The backend validates the conversation and reads `Harness.environment`, never
  a server-local filesystem. Holds lease its `FileSystem.watch` (tree, HEAD, index, config); events increment
  `changes`, coalesced over 100 ms. The last hold closes it; no heartbeat or 75-second lease. Compatible plugin
  reloads keep the resource and listener. Liveness counts the held backend as a viewer, including while its watch
  is opening (and until it finishes closing), so slow filesystem activation is not mistaken for idle time.
  `GET|HEAD /workspace-file?session=&conversation=&path=` streams bounded worker byte chunks, including audio/video
  ranges; `POST /workspace-upload?session=&conversation=&path=&name=` sends chunks to a temporary file (25 MiB,
  exact same-origin Origin), then checks the destination is free before renaming. Worker upload writes serialize
  across conversations to prevent competing uploads from overwriting each other; external filesystem races remain
  the ExecutionEnv's confinement/rename limitation, not a sandbox. Every HTTP request rechecks current access;
  read-only guests and cross-session guests are denied. `.git` paths and paths out of the working directory cannot
  be opened. p2's data directory is a workspace like any other (sessions work in `<data>/plugins`, docs/agent-plugins.md):
  the panel, the file index and the watch neither refuse nor hide it.
  Web: route-owned sheet with Files (tree, fuzzy filter, uploads), Changes (working tree, paged branch commits),
  Search (literal text and include/exclude globs), File/Changes/Preview views, and Comments. Review drafts and open
  editors persist in localStorage per conversation; Send/Send all use ordinary attributed Chat input. Integration
  tests cover fake-provider prompts, a temp git repo, bounds, reload/watch lifetime, HTTP streaming/ranges, upload
  cleanup/concurrency and guest revocation; `ui-workspace.test.ts` the browser panel. The web panel docks at 1200 px,
  remembers its resizable list width (dragged at its left edge from 900 px, as an overlay too), and shows a file beside
  the list when both chat and file can retain 480 px.
  Read/write/edit cards supply one-step Open in workspace links. Files/commits push; views/search replace; tabs reset
  the trailing workspace run. List/file scroll positions survive Back and reload.
- **Remote environments** (`plugins/envs`, [guide](remote-envs.md)): owner-only `Envs` lists environments with their
  last test, saves/deletes/tests configs, accepts/forgets host keys and browses local/remote directories. Key generation,
  public-key retrieval and private-key upload are available to every owner (including associated and Radius owners),
  as in Pi Mobile, never guests (owner decision; formerly device-only). A proxy alone grants no ownership. Uploads
  pass through the tunnel/relay, which must be trusted with the private key. `envs.json` has independent server/worker observers; invalid edits
  retain the last valid state. Sessions persist `env` beside raw cwd and display `gpu:/path`; subagents with their own
  location carry its `env` (see **Agent locations**). Deletion checks all sessions and subagent locations, archived
  ones included. Valid edits stop idle workers using the environment; busy ones keep their captured environment until
  idle. `HarnessEnvironments` supplies a lazy machine per environment (`open(env)`: environments at its directories
  over one connection); missing/unreachable envs never use local tools. Attachments copy to remote
  `~/.pi/p2/uploads/<session>/` of the machine where the receiving conversation works, before admission; inline
  images retain the local upload copy. Project instructions, skills, workspace and downloads use the conversation's
  environment. The local global AGENTS.md stays
  local; remote skills use `~/.pi/p2/skills/`. New-session Browse directories and environment editors use route-owned
  locators (Back/reload); read/write remote shares require explicit confirmation at the API and in the browser.
  `envs.test.ts` uses a fake provider and disposable loopback sshd with private fixture keys/HOME (skips without sshd
  or a daemon). It covers host trust, key storage, directories, no local fallback, tools, workspace, uploads, prompt
  resources, downloads, terminal env selection, busy-edit/idle restart, archived deletion and share confirmation.
- **Terminals** (`plugins/terminals`): owner-only `Terminals({ session, view })` controls list/open/attach/close/resize/theme,
  acknowledgements and explicit host restart. A resource holds one connection to the data directory's detached terminal
  host through a host manager's `detachedSocketDriver`; stopping the manager detaches, never kills the host or its PTYs.
  The host has its own process lock and ten-minute idle exit, owns local/SSH pi-env daemons, and keeps a headless
  libghostty terminal per shell. Server and worker restarts leave programs running; reattach starts from a VT snapshot.
  A one-use, 30-second channel grant from the held owner object admits `/terminal` (owner + normal Host/Origin checks).
  Input/output bytes and ordered output metadata use this separate channel; incoming control JSON is refused. Slow
  viewers stop after a 256 KiB unacknowledged window (output after the latest snapshot; the snapshot itself does not
  count) and resnapshot once they catch up; socket backlogs over 8 MiB drop
  the connection. Attaching checks the terminal belongs to the object's session; `open({ conversation })` fills cwd and
  environment on the server, from the conversation's location (`ChildStore`'s `Child.location`, else the catalog).
  New terminals in archived sessions are refused. Compatible plugin reloads keep the attachment resource.
  Web: route-owned side sheet or resizable bottom panel, tabs, new/close/foreground-job confirmation, browser-native
  selection/copy, mouse/touch scrolling, pastes, IME corrections and the remembered Ctrl/Alt/Esc/Tab/arrows/symbol key
  row. Placement is remembered. The wasm, wrapper, renderer and input helper are independent copies under p2.
  Touch: a long press on a character of the output is Chrome's (word selection, handles, Copy); one on a blank cell
  puts the transparent textarea under the finger for Chrome's Paste (sent as a paste, bracketed when the program asks).
  Touch long presses and their contextmenu are never cancelled. While output is selected, rows are not redrawn (15 s
  after the selection last changed, or until it ends, the user types, pastes or scrolls), since redrawing a row drops
  a selection in it. Copy joins soft-wrapped rows and drops the blanks that fill rows. `terminal-clipboard.test.ts`
  covers this as far as CDP can (headless Chromium has no long-press gesture, selection handles or native menus).
  SSH configuration comes from the envs plugin and the conversation's location environment; the separate `terminal-sessions.json`
  mapping is no longer read. Host keys use `ssh/known_hosts` and `pi-env-<name>` aliases. `envs.test.ts` exercises a
  remote terminal against a disposable localhost SSH fixture; no real remote host is used. Windows PTYs remain unsupported. The workspace has an owner-only
  Terminal tab through the terminals plugin's `workspace-terminal` slot. Side and bottom panels are remembered per
  session (Browser navigation, Panels per session): another session opens with its own, never starting a terminal.
  Only explicit terminal-button/tab taps request auto-start; attachment updates replace the route, never push or
  reopen a later destination.
  Outdated hosts show Restart (ends all terminals), but idle outdated hosts are not automatically replaced yet; the
  agent's calls to an outdated host fail with that advice (`OUTDATED_HOST`); archiving closes its terminals with the
  viewer protocol every host speaks (list, then attach and force-close each).
  Each terminal has a number in its session (`index`: the lowest free one from 1, kept while it lives), an optional
  name and an `agent` mark; tabs show the name, else the title, else "Terminal N", agent terminals with a "Pi" badge.
  Every connection that listed a session hears its list change (`terminals`: opened, closed, exited, renamed, by any
  viewer or the agent); a panel showing a terminal keeps it, one showing none attaches the newest new one. Archiving a
  session closes its terminals (`SessionArchived`, a host-lifetime contribution; no host is started for it).
  **Agent terminal tool** (owner decisions): the agent drives the same terminals the owner sees (shared: the owner
  watches and types; the agent may read, type into and close any terminal of its session, the owner's too). Guest
  turns may use it, like bash. Code mode only, like MCP tools (`deferred`, `callers: ["tools"]`; scripts find it with
  `searchTools()`); while code mode is off `tool_search` loads it (installed once by `durableRegistry`, not by each
  plugin: two plugins contributing `tool-search` would be a registry conflict). The description says to use it only
  when the user asks for a terminal or for driving an interactive program in one, never instead of bash; no prompt
  section. Call: `tools.terminal({ command, args })`, tmux's argv after the command name, parsed getopt-style
  (`commands.ts`: no string parsing, tmux-like errors such as `send-keys: unknown option -- x` or `usage: …`):
  `new-window [-n name] [-c dir] [-w W] [-T s] [command ...]` (a shell at the calling conversation's location,
  `environments.locate`: a subagent's script opens it at the subagent's own location; `-c` relative to it; `command` is typed into it, then Enter, and the shell stays),
  `list-windows`, `send-keys -t T [-l] [-w W] [-T s] key ...` (tmux key names as keys, encoded by libghostty in the
  terminal's modes, other arguments as text), `read -t T [-w W] [-T s]` (output since the agent's last read),
  `capture-pane -t T [-S -N] [-e] [-p]` (the screen, N scrollback lines, `-e` with SGR colors), `kill-window -t T`.
  Targets: the number (`2`, `:2`) or the name. Waits `W`: `quiet` (0.5 s without output; default of new-window and
  send-keys), `exit`, `/regex/` (`/regex/i`) over the new plain text, `none` (read's default); `-T` seconds (default
  10, send-keys 5, max 120); a timeout is no error. Result (`structuredOutput`): `{ window, output, running,
  foreground?, exitCode?, error?, screen?, skipped?, timedOut? }`, `{ windows }`, `{ window, killed }`; output is the
  last 16 KiB of plain text (escape sequences removed, `\r` overwrites and backspaces applied, erase-in-line honored),
  or a full-screen program's screen (`screen: true`). The host keeps each terminal's last MiB of output
  (`OutputRing`) and the agent's read cursor, so reads survive server and worker restarts; it answers calls with ids
  (`call`/`reply`, `cancel` ends a wait) and does keyed calls (open, send, close) once per key (the tool call's task
  id; the last 1024 remembered). The tool is replay-safe: the read start and a killed window's id are memoized
  (`api.memo`). Server: `AgentTerminals` (worker variant only) serves the session's running current generation (as
  MCP's `currentWorker`), refuses archived sessions, opens only on environments the session works on (its own, its
  subagents'), forwards cancellation. The agent may have 8 running terminals per session (the owner's do not count).
  Web: the step's detail in the turn's activity sheet (code mode off) shows the command line and output with "Open
  terminal N"; code mode's calls show the command line. TUI: a card with the command line and the output's last lines.
  `terminals-host.test.ts` covers shells, disconnect snapshots, foreground jobs, themes and flood resync;
  `terminals.test.ts` covers guest/control denial, one-use byte grants, session isolation, reload and server restart;
  `terminal-agent-host.test.ts` the host's calls (keys done once, cursor, waits, cancel, plain text, the alternate
  screen, captures, ring overflow, list pushes, the cap, closing a session, an outdated host); `terminal-tool.test.ts`
  the tool end to end (scripts, shared with the owner both ways, errors, guest turns, stale workers and foreign
  environments refused, archiving, `tool_search` without code mode); `terminal-tool-unit.test.ts`,
  `terminal-commands.test.ts`, `terminal-plain.test.ts` and `terminal-keys.test.ts` the pure parts;
  `terminal-service.test.ts` closing a session (no host started; an outdated host's terminals closed as the panel does);
  `ghostty.test.ts` and `terminal-input.test.ts` cover the copied browser primitives. PTY tests skip when no daemon
  build exists (`npm run build:daemon` in `packages/env` builds a debug one).
- **Search** (`plugins/search`): `SearchIndex` (server local, `search.sqlite`: root/subagent user/assistant text in FTS5 and
  one cursor per conversation; derived, dropped on a schema change; version 2 adds `mentions`, each session's latest
  message matching a query since a time, for rollups made from code). Each worker's `Indexer` (lifetime "host") runs a task that reads
  the server's cursor (`SearchFeed`, worker principals only, session from the principal), scans each root/subagent
  conversation's immutable history after it in pages of 200, and sends them; each call returns once the server
  committed it, and the cursor sent stays put until the last page of a range, so an interrupted scan repeats the
  range (idempotent by entry ID). It runs at start and after every commit adding entries (Durable
  `observeCommits`), and retries after an error (server unreachable, reload) from a fresh cursor. The speaker and
  peer-sender blocks are not indexed. Owner-only `Search.rebuildIndex({ session })` (Pi Mobile's) starts a persisted job on `SearchIndex` (stop the worker, reset its entries, scan from a fresh worker; an archived session's starts without resuming its work and stops again) and answers once it started; `Search.rebuilds` shows it running and why it failed (`rebuild-index.test.ts`). Owner-only `Search.search({ query, archived, sessions })`: sessions whose title or
  cwd contains the query (sidebar order) and up to 41 message hits (literal terms, all required) in the archive scope,
  within `sessions` when given (3; a sidebar list's own sessions, applied before ranking and the limit).
  Search hits include conversation IDs, and a hit opens that conversation (a subagent's too); default titles derive from the first root user message, explicit titles
  survive reindexing, and `updatedAt` advances monotonically with indexed activity. A sidebar list page's search (owner) filters its
  sessions and lists message hits within them.
- **Configuration** (`plugins/models`): `ModelConfig` (server local) owns p2's `Resources` observer
  (settings.json, models.json, auth.json; hot reload) and contributes it to `ModelResources` (a native), plus `summary` (model
  picker) and `snapshot` (settings, providers, credential metadata, errors; never secrets). Workers run their own
  observer (`WorkerModels`). `startServer({ resources: { createModels } })` injects a fixture provider (tests).
  Edit `settings.json` as a file; valid changes hot-reload and in-flight requests keep their configuration.
  Set the default model and thinking level with **Make default for new sessions** in the model picker.
- **Settings** (`plugins/settings`): the owner's Settings window, opened from the gear before the theme switch in the
  sidebar's footer (the Drawer's `actions`, filled by the sessions plugin with `SlotList` `sidebar-actions:<name>`).
  It replaced the footer's More menu. The window is the route's `settings` sheet layer (`ModalSheet`): a list of
  sections beside a pane on wide screens (General when none is chosen; choosing replaces the step), on phones the
  list and then a section (a new step; Back returns to the list). Its own sections (General, Models, Agent, Requests,
  Compaction: the layer's locator) edit settings.json. The plugins' sections are their sheets: a plugin contributes
  `SettingsSections` (`src/runtime/web-core.ts`) once, keyed by its sheet layer's name, with `label`, `title`,
  `order` (the list sorts by it, then by key), `Sheet` (renders its sheet while the route opens it; the app's layout
  keeps every one mounted, `SettingsSectionSheets` in `src/web/SettingsNav.tsx`) and optionally `Shown` (Voice: only
  with a speech service). The section is that sheet's layer right above `settings`. While the window is open, every `Sheet` renders as a page in
  its pane (`SettingsPane`, `src/web/settings-embed.ts`): its title and Back, no scrim or × of its own (the window's
  close everything), `sheet-body` kept for the plugin's styles. The same sheets opened elsewhere (Sign in to a
  provider, a session's logs or Discord link) stay sheets of their own.
  Owner-only `Settings` shows `ModelConfig`'s settings and settings.json's load error; `update({ set, unset })`
  validates `set` as a partial settings.json (closed schema), reloads the file, merges the change into it (top-level
  keys, groups such as `stream` whole) and saves it through `ModelResources`, answering after the reload
  (`settings.test.ts`, `ui-settings.test.ts`). Selects and switches save at once (`Switch`, `src/web/Switch.tsx`:
  settings that apply at once are switches, checkboxes are for forms that submit); text and number fields on blur
  or Enter; an empty field or "Default" removes the setting.
- **Devices** (`plugins/devices`): `npm run owner-link [base-url]` signs in as the local owner, calls the local-owner
  `GET /owner-token` (same-origin or no Fetch Metadata only), then prints a private `/owner#<token>` link. At startup the
  server prints a one-time token for this machine, to paste into the sign-in page (added to the log redactor; only
  the terminal shows it). Base defaults to `P2_PUBLIC_URL` or `http://127.0.0.1:$PORT`; invitation
  lifetime is ten minutes, single-use. The nonced sign-in page is also the stranger landing page; it immediately
  scrubs the fragment, POSTs it, then redirects to `/`. HTTP/proxy URLs never carry the token. Signed per-device
  cookies are HttpOnly, SameSite=Lax, Secure on a remote origin, with a 30-day browser/server expiry. The private
  `owner-key` signs cookies; `owner-revoked.json` persists individual logout, and all-device logout rotates the key
  and revokes live remote-owner objects/links through `Server.revokeOwners`. First signed-cookie startup rotates
  the old exposed raw-key cookie once (`owner-cookie-version`); no legacy raw-cookie compatibility. The web host
  exposes no filesystem paths; it serves only app pages, `public/` files and bundle files. Headless `owner-token.txt`
  is replaced each startup. Cookies redeemed on a remote origin are remote owners (`access: "device"` plus device ID)
  and cannot mint invitations; redeemed on loopback they are local sessions. Compatible reloads keep invitations; restarts invalidate them but keep cookies/revocations.
  Tests use only temporary directories and port 0, with no real provider requests (`devices`, `proxy-marker`, `tui`,
  and the fragment-link browser regression in `ui-parity.test.ts`).
- **Loopback owner** (`plugins/devices`, `src/runtime/local-owner.ts`): loopback alone proves nothing on a shared
  machine, so the local owner (`access: "local"`) is a signed session cookie, the devices cookie with a `local.` kind
  (`p2_owner_<port>=local.<id>.<expiry>.<sig>`, HttpOnly, SameSite=Lax, never Secure, accepted only on loopback). A
  browser gets it by redeeming an owner link on loopback (the startup token pasted into the sign-in page, `npm run owner-link`); clients on the host
  get it by local sign-in: `POST /owner/local/challenge` (one-time, one minute, in memory), then `POST
  /owner/local/claim` with HMAC-SHA256(owner-key, `p2-local-owner:<port>:<challenge>`), so the key never leaves the
  client and a process squatting on the port learns nothing usable at the real one. Each app page load renews the
  session (same id, 30 more days; `PageCookies`). Sign-out of one local session revokes its id but leaves live local
  links (one shared principal); sign-out of all devices rotates the key and revokes `{ owners: "local" }` too.
  Lax, not Strict: a link from another site (or Chrome launching an installed app) must arrive signed in; the server
  drops every cookie principal of another site's requests except top-level navigations to app pages (Fetch Metadata).
  A foreign navigation without a cookie gets the sign-in page, which loads itself once more from p2's origin (that
  load is same-origin, so it cannot loop). Only an owner by cookie or relay skips a share's join form, so a fresh
  profile opening `http://127.0.0.1:<port>/join/<token>` joins as a guest; an owner cookie wins over a guest cookie.
  Browsers send cookies to every port of `127.0.0.1` (README: remaining risk). The old `<data>/device-cookie` is
  unused. Tests: `devices.test.ts`, `loopback-join.test.ts`, `foreign-requests.test.ts`, `tui.test.ts`.
- **Provider login** (`plugins/login`): `LoginService` (server local) runs its own `Logins` (provider-owned
  api-key and OAuth flows), which keeps the flow's `login` state (status, the pending prompt, notices; never
  credentials or answers); the service follows it, so `start`, `answer`, `dismiss` and `cancel` (which waits for the
  flow to end) answer with their change shown. `ProviderLogin` admits every owner (local, device-associated,
  or Radius), never guests, and adds the provider list. Web: Providers in the sidebar footer for every
  owner, regardless of browser hostname. Remote flows automatically choose device-code when the provider offers
  it; account selectors remain interactive. Browser-callback flows keep the provider's registered callback URL:
  complete sign-in in the provider tab, then paste the authorization code or final redirect URL. Anthropic shows a
  code; OpenAI ChatGPT may land on an unreachable localhost page, whose full address must be copied from the address
  bar and pasted into Providers. The manual prompt explains that the page need not load. A device-code event with
  `openBrowserOnConfirm: false` (a provider asking clients not to offer opening its page) shows the verification
  address as text instead of the Open link (web), and the TUI offers no "open in browser" for it. No pi-ai changes or custom
  callback URL. API keys and pasted codes pass through the tunnel/relay; use a trusted transport. Once no browser
  holds the sheet (no reference to its owner's `ProviderLogin` left, `host.references`), its unfinished login is
  cancelled. Tests use fake providers (login.test.ts and remote-login.test.ts).
- **Web slots**: `SlotList({ prefix })` renders every `prefix:<name>` slot (e.g. `sidebar-actions:settings`); `Sheet` is
  the shared modal with scroll memory (Escape and the scrim close the whole modal stack). Shell-level
  `workspace-panel` docks beside `main`; `workspace-terminal` is an optional terminals-plugin surface.
- **send_file** (`plugins/send-file`): owns its native tool, reading through the conversation's
  execution environment and saving immutable snapshots into the session's files (space `downloads`, `source: "agent"`).
  Directory sources and files over 25 MiB fail. The existing authorized `/download` route serves snapshots even
  after source deletion or plugin reload. `test/p2/send-file.test.ts` and the files integration tests cover it.
  The artifacts plugin supplies the file viewer.
- **Views** (`plugins/views`, `docs/views.md`): panes beside the transcript that the person and the agent share
  (a workspace Markdown file, the working tree's changes, artifacts, plugin kinds; `View.item` says what a view shows),
  laid out per device (tabs, splits, drag and drop; one pane at a time on phones), with an annotation layer (comments,
  removals, drawings on any pane, the transcript included). Selections and annotations go with the person's next
  message (send router `views`, entry kind `p2.view-input`; other plugins add blocks through `MessageContexts`); the
  agent's code-mode tools `view_list`, `view_open`, `view_close`, `view_arrange`, `view_resolve` (namespace `view`)
  open and arrange them. Core: `AppLayout` wraps `main` in the `workbench` slot, the chat's top bar has
  `view-actions`; `ViewKinds` (`{ Pane }`) and `ArtifactKinds` are the web registries. Custom views, view state, the
  library, rooms and view principals were removed on 2026-11-12 (docs/glyph-editor-port.md).
- **Artifacts** (`plugins/artifacts`, `docs/artifacts.md`): html pages and Markdown documents the agent writes with
  code-mode tools (namespace `artifact`), kept on the server per session (documents and a version table keyed by the
  session's host address, so export, import and delete carry them; clone and fork copy them through `SessionCopied`).
  `artifact_show` renders the artifact's pane in place in the transcript (mounted only while on screen); views of kind
  `html` and `md` show one beside the chat; the top bar's counter toggles the side panel listing every `ArtifactKinds`
  item (`SidePanel`, `Route.panel` "artifacts": docked on the right from 700px like a run's activity, which it replaces
  and which replaces it; a sheet on phones), where a row opens the item as a view, or for a read-only guest shows it in
  the panel. Dragging a docked side panel's left edge resizes it; every side panel shares that width, kept per browser
  (`p2-side-panel-width`; `useDragSize` in `src/web/drag-size.ts`, which the sidebar, workspace and terminal use too;
  frames take no pointer events during the drag). Html pages run in a sandboxed frame from `/artifact-frame` with the
  `window.p2view` bridge (state per artifact, selection, regions, console lines, the agent's code); new page errors go
  with the next message. The chat-content slot still supplies the transcript's card contexts and the sent-file viewer
  (`FilePanel`, a named `Route.layers` entry). Artifacts written before 2026-11-12 (the session's files, space
  `artifacts`) are not migrated.
- **Conversations** (`plugins/conversations`): the `conversations` tool (`scope: "main"`, `locked: "conversations"`) lists
  active roots without starting workers (with each one's location and project, and the projects), sends
  server-attributed peer input, reads the latest completed text answer (bounded scan, no thinking, including old
  history), creates a session at a project's place or a cwd with the message as its first peer input (its ID derived
  from the call, so a retried call finds it; the sender's model and thinking level unless it names a signed-in model;
  `SessionOperations.create`, shared with the owner's `Sessions.create`),
  stops a session's run (as Stop in the chat), and archives or restores a session (`SessionOperations`; never
  itself). `Conversations`
  accepts only current worker generations; `PeerConversation` accepts only the parent's `{ kind: "server" }`
  principal. The server brokers the sender's ID/title from the catalog, checks archive around startup/admission
  and receipts, and scopes deduplication to sender + Durable tool task/call. Calls are short and cancellable;
  cancellation after admission does not undo remote work. Final answers never auto-forward. Owner peer labels
  navigate to roots (restoring archives); guests get plain labels. `test/p2/conversations.test.ts` covers list/send/
  answer, peer replies, restart deduplication, concurrent cross-sends, busy answers, follow-ups,
  invalid destinations, reload, guest turns, child tool exclusion and inaccessible public ingress.
- **Familiar** (`plugins/familiar`): one long-running session above the others that keeps track of them and starts,
  steers, stops, archives and restores them. The server's `FamiliarStore` holds which session it is (persisted; the
  ID is chosen before the row is made, so a crash makes the same one); the owner's `Familiar.open` makes it on first
  use (home directory, default model, title "Ask Pi", its name for the owner) or restores it when archived, one open at a time. Workers learn
  whether they are it from their start data (`WorkerInitValues` key `familiar`). In its worker, the main conversation's
  `pi.agent` gets `modelTools` (conversations, codemode, history_search/read/handoff, sidebar_rollups) and `tools` (those plus `agent`,
  `bash` and `read`, so scripts and one-shot agents can look at the file system) at each start; its extension adds the
  `familiar` prompt section (role, notes in the code mode store key `familiar.notes`, finding folders).
  **Compaction by cost** (`cold.ts`): while its prompt cache is warm a turn reads the context at about a tenth of the
  input price and a summary (never cached) costs it all at full price, so only the regular cutoff applies; once cold
  the next turn rewrites the cache at full price anyway, so it compacts first. Cold: the last answer's time plus the
  model's cache lifetime (`getPromptCacheTtlMs`, `cacheRetention`) plus the 30 minutes the cache warmer refreshes while
  idle (`cacheWarming: "idle"`, the default); at once for a model without a prompt cache. It compacts when the last
  answer after the context's head reported at least 150k tokens, or the regular cutoff (window − `reserveTokens`) when
  lower, compaction is enabled, and the conversation is idle: from a timer set after each answer (only while the
  worker runs; an idle worker stops after 5 minutes without viewers or warming) and at each start, else in an
  `InputGate` before the next input is admitted, which waits for the summary. Web: home (the `home` slot: `/` replaces
  itself with its session, made on first use; while the owner has it archived, with the new-session screen) and the
  `drawer-brand` slot, the Pi logo at the start of the owner's sidebar header (a button titled "Ask Pi" that opens it,
  restoring it when archived; the session's working spinner or unread dot on its corner); the sessions plugin's `DrawerRowsContext` (`plugins/sessions/contract.web.tsx`) gives it the
  rows, `SessionDot` and `listApart`, which leaves its session out of the rollups. The TUI lists it as an ordinary session. Tests:
  `familiar.test.ts`, `ui-familiar.test.ts`, the conversations actions in `conversations.test.ts`.
- **Subagents** (`plugins/subagents`): owns its protocol-independent Durable extension (persistent
  anchor conversations and exactly-once background reporter tasks, model/thinking/tool validation). The worker
  facet (an object of lifetime "host") contributes it to `Extensions` and catches up child metadata after relevant commits, retrying
  acknowledged reports on errors/reload. Server `ChildStore` persists the list as one row per session in the server's store, keyed by its address
  (`plugins/subagents/children.ts`); worker
  generation fences late reports. Owner `Subagents` readers see every session; guests see only their own. Reading
  the list does not start/hold a worker. The sidebar expands children (latest entry first), with working marks;
  `/s/<id>/c/<conversation>` opens an independent chat, draft and model control. A parent link returns to the root.
  Browser configuration synchronizes the subagent registry via `ConversationConfigured`. Main Stop leaves child
  work running; direct child prompts do not report to the parent. **Tools** (`resolveChoice`/`resolveTools` in
  `contract.worker.ts`, validated before any commit, shared with one-shot agents): an agent gives from its own tools
  (`api.agent()`: offered, deferred and script-callable), never more. It may give every tool its model calls except
  `scope: "main"` ones (`subagent`, `rename_session`, `conversations`, `ports`, `sidebar_rollups`) and
  `scope: "subagent"` ones (`team`, which every subagent gets, offered from the start); `tools` names them in order,
  the default is all of them (code mode only while the main agent has it; naming a tool it lacks is refused with the
  list it may give). Deferred tools stay deferred unless named (then offered from the start). Durable enables exactly
  the names in a conversation's `tools` array, and code mode's nested calls resolve among the enabled tools, so an
  agent given `codemode` also gets the caller's script-only tools (`callers: ["tools"]`: MCP tools, `terminal`,
  `agent`, code mode's `models.*`) by name: at spawn/configure those installed then, and later ones (an MCP server
  connecting) from the worker, which follows the registry's script-only tools and appends missing names to every code
  mode subagent's array (`enableScriptTools`; a tool task resolves its agent once per phase, so this cannot happen
  inside the script's own call). Names are never removed by the worker: Durable ignores a name whose tool is gone. A
  `send` takes away what the caller can no longer give (its tools changed). The registry records the chosen names
  (`ConversationConfigured` records the agent's choosable tools after a browser change). Requirements are looked up
  by name in the worker's `Extensions` (`toolsByName`). `test/p2/subagents.test.ts` covers bad models, configured
  spawn, one report, answer retrieval, configuration, independent history, reload during child work, idle restart,
  guest reads, sidebar persistence across server restart, and tools: validation against the caller's tools, the
  default with code mode on and off, a script calling a coding tool, `agent` (also with code mode) and MCP tools
  installed after the spawn; `tool-access.test.ts` the resolution rules; `terminal-tool.test.ts` a subagent's script
  opening a window at its own location.
- **Tool requirements** (`src/runtime/tool-access.ts`): a plugin declares them on its tool (`P2Tool`, `defineP2Tool`):
  `scope` (`"any"` default; `"main"`: only top-level conversations, for tools acting on the session as a whole:
  `subagent`, `rename_session`, `conversations`, `ports`, `sidebar_rollups`; `"subagent"`: given to subagents only,
  `team`) and `locked` (in a locked session: `pass` default, `never`, or a capability the owner picked: `ports`,
  `conversations`). The worker's Durable registry wraps every tool with requirements (`guardTool`, in
  `durableRegistry`), so no tool checks them itself. There is no per-turn authority (removed: the owner decided, as for
  p3, that "who started this turn" is illusory against prompt injection): whoever may send input in a session may have
  its agent use every tool it has. What a session's agents reach is decided by its tool selection (subagent and
  one-shot `tools`), its location (a sandbox) and its lock. `test/p2/tool-access.test.ts`, `dev-tools.test.ts`.
- **Code mode** (`plugins/codemode`): the worker facet registers Durable's `codemode` extension
  (`createCodemodeExtension`, tool `codemode`, callers `["model"]`, replay-safe) in `Extensions`. One sandbox per worker
  (`CodemodeSandbox`, 256 MiB VM heap: `CODEMODE_MEMORY_LIMIT_BYTES`, kept constant because it is part of the VM
  fingerprint a resumed script must match) is a native of `CodemodeRuntime`: a reload opens a new sandbox and drains
  the old one (it closes once its running calls ended), so scripts running in it go on. Removing the plugin by a reload first ends its running calls (`plugins/codemode/calls.ts`:
  each reports "Code mode was removed while this script ran." in its output, then is aborted through Durable's
  `abortTask`, which ends its script and nested calls and settles it with an error), then closes the sandbox (VMs and
  worker threads end); the turn goes on without the tool. A worker stop (`Liveness.stopping`) skips that step, so
  the next worker replays the scripts. The extension reads the sandbox
  through a getter when a script starts. At worker shutdown the sandbox closes while the Harness is
  still open (Chord disposes holders first); Durable stores no outcome for a run the sandbox ended on its own, so the
  next worker replays the script. `codemode.test.ts` covers a script calling two tools (and its `details.calls`), live nested slots, a
  reload during a script, SIGKILL and graceful restarts mid-call (finished calls do not rerun; the interrupted unsafe
  `bash` call returns an error the script catches); the removal mid-script (prompt error, turn ends, the script's thread goes); `codemode-plugin.test.ts` the
  sandbox across reload/removal.
- **Cache warming** (`plugins/cache-warming`, policy in pi-ai's `cache-warming.ts`, as pi-coding-agent's): a hook-only
  Durable extension; each `afterResponse` starts the conversation's run, replacing the last one. The request comes from
  the core: the Harness's `Models` proxy remembers each `streamSimple` request by the message `result()` resolved with
  (`WeakMap`); `HarnessParts.requestOf(message)` takes it once as a read-only `ModelRequest` (Durable's frozen entry
  messages; never mutate, copy or freeze it; resending skips `beforeProviderRequest`). `completeSimple` (compaction,
  the refreshes) is not remembered. Each refresh: no phase while `pi.live.generation` exists, streaming while
  `pi.live.run` exists, idle only for top-level conversations, none once the model or the context's start changed;
  usage goes to `pi.usage`. Timers live in the plugin's native (a reload ends them); liveness kind `cacheWarming`.
  Setting `cacheWarming` (`"idle"`, `"streaming"`, `"off"`). Tests: `cache-warming.test.ts`,
  `harness-requests.test.ts` (pins that the hook's message is the object `result()` resolved with).
- **MCP servers** (`plugins/mcp`, plan `docs/mcp-durable.md`, WP6-8): the server's `McpManager` (local,
  host lifetime) owns every MCP process and connection; workers never spawn one or hold a credential. `<P2_DATA_DIR>/mcp.json`
  is the owner's `mcpServers` (pi-mcp's `validateMcpServerConfig`, plus p2's `shared` and `runOn`; invalid entries are
  skipped and listed in `errors`, `${VAR}` in headers and env values from the p2 host's environment; watched: an edited
  server restarts, a removed one closes; an invalid save keeps the last valid servers, also across a reload). Instances (`placement.ts`): stdio per session and location (key: session,
  location, server, hash of command, args, env, cwd and timeout; roots the location's cwd), `"shared": true` once on
  the host, HTTP shared unless `"shared": false` (one per session); a 401 of a server without an `Authorization` header shows `sign-in` (OAuth below). Stdio
  servers on an environment (`runOn: "location"` on a remote location, or `{ env }`) start through its pi-env daemon
  (`openProcess` behind pi-mcp's `PipeTransport`, `transports.ts`): one connection per environment and revision of its
  `envs.json` entry, shared by its instances and closed with the last (`environments.ts`), opened through the envs
  plugin's SSH manager (`EnvManager.connection`); `~` is the remote home, relative paths are relative to the location's
  cwd when it is on that machine (also the root), else to the home; on Windows everything but `.exe`/`.com` runs through
  `cmd.exe` with cross-spawn's quoting, the line passed in a variable (`windows-command.ts`); a daemon without the
  `process` operation fails for good with "update it"; an environment missing from `envs.json` shows `failed`. A lease
  gets servers only on an environment its session works on as the server records it (the catalog's session, the
  subagent store's own locations; else "not where this session works"). Projects: the worker reads `<cwd>/.pi/mcp.json`
  at each location through that location's environment and sends the text with `setLocations` (256 KiB at most); the
  manager checks it (`project.ts`): stdio servers only, run at that location for that session alone (no `runOn`,
  `shared`, `auth`, `oauth`, no HTTP, `${VAR}` never expanded), an entry without `command`/`url`/`type` only sets
  `enabled` of the owner's server of that name (so a disabled owner server can be turned on there), a redefinition of
  an owner server is refused; refusals and unreadable files are the lease's `errors` (the worker's view, and the
  owner's prefixed with the session). `Mcp` is the view: a worker
  principal's `setLocations`/`call` (only the session's running current generation, as the location tools check;
  session, generation and `ctx.incarnation` filled in by the view; `servers` without the owner's errors), the owner's
  `instances`, `errors`, `restart`; guests get nothing. Lease rules are pure functions (`leases.ts`): a generation sets
  exactly its locations (leaving one out ends that lease), a newer generation takes the session over and refuses an
  older one (decided inside the leases' change), calls go through the setting incarnation's lease, and the view's end
  (its worker's link went, after a 30 s linger, so a worker object taking it again keeps its processes) releases its
  generation's leases; a reload keeps them (an in-memory document of the manager), and the restarted natives start
  from the manager's memento of the last valid servers and the last listed tools. The manager follows `mcp.json`, the
  instances and the sign-ins (`self.follow`), so restart, sign-in, sign-out and cancel answer with their change shown. Unshared instances close with their last lease, shared ones stay while configured. A lost
  connection reconnects with backoff (`RECONNECT`: 1 s doubling to 60 s, reset after a minute up), tools still listed;
  `notifications/tools/list_changed` refreshes them; call errors never carry a server's stderr (the owner's `error`
  does). The worker object (`p2.mcp-worker`) sends `setLocations` with every location its conversations work at (the
  session's, active subagents' own) at start, after moves and subagent commits, and whenever the view re-activates (a
  refusal because a newer generation runs ends it), and
  contributes one Durable extension per configured server, `mcp:<server>` with the code-mode namespace `mcp__<server>`
  (`createMcpExtensions`, a `self.writable`, rebuilt only when the tool list changes). The namespace's description
  comes from the configuration only (and the sign-in hint for OAuth servers), so the prompt's code-mode section is the
  same before and after a server connects (the KV cache holds); a server's `instructions` (`Mcp` version 3, the
  instance's `instructions`) are reachable through `describeNamespace()`. There is no `mcp_servers` section. Deferred
  tools named by `createMcpToolName` (every tool of a colliding name gets the hash suffix, as in pi), results through
  `toLlmContent` and `limitMcpContent`, `structuredOutput` only for tools with an output schema. Without code mode,
  `tool_search` is installed by the worker's registry (`durableRegistry`: once, while code mode is off and any extension
  has a deferred tool the model may call; MCP's and the terminal tool share it). Tests: `mcp.test.ts` (manager and views on a bare host with `test/fixtures/mcp-server.mjs` and
  an HTTP fixture; projects, where sessions work, and an environment through the debug pi-env daemon, skipped without
  it: `npm run build:daemon` in `packages/env`, or `PI_ENV_DAEMON`), `mcp-instances.test.ts` (the supervisor with a
  short backoff), `mcp-leases.test.ts`, `mcp-environments.test.ts`, `mcp-project.test.ts`,
  `mcp-windows-command.test.ts`, `mcp-tools.test.ts`, `mcp-worker.test.ts` (fake provider: a project file, `tool_search`,
  a call, a relocation).
- **MCP sign-in** (`plugins/mcp/sign-in.ts`, `routes.ts`, `probe.ts`, `pages.ts`, `credentials.ts`; as built:
  `docs/mcp-durable.md` section 4.7): HTTP servers without an `Authorization` header use OAuth with pi-mcp's auth
  provider (stored tokens, refreshed, never a browser) and credentials in `<P2_DATA_DIR>/mcp-auth.json` (0600, keyed like
  pi's). Owners sign in at `GET /mcp/sign-in/<server>` (the web MCP sheet opens it in a new tab): the local owner's
  browser returns to a loopback callback on the p2 host; for a relayed or public owner a probe page first fetches a
  nonce URL from a 127.0.0.1 listener of p2 (CORS for that origin only), and returns to loopback when it answers, else to
  `GET /mcp/callback` on the origin p2 is reached through. Pasting the final redirect URL (web sheet, TUI `/mcp paste`)
  always completes a waiting sign-in. One flow per server, in memory, 10 minutes; a pending one keeps the manager held.
  Tests: `mcp-sign-in.test.ts` (a fake authorization server and MCP server).
- **One-shot agents** (`plugins/agent`, port of Pi Mobile a9335ebea and 0e238b29f): code mode scripts' `tools.agent({
  prompt, schema, label?, model?, thinkingLevel?, tools? })` (`callers: ["tools"]`, replay-safe). One conversation per
  call, owned by the tool task (abort cascades) and recorded in the task-scoped `p2.agent-run` doc, so a rerun
  reattaches; it does so before validating the model, so a model removed from the configuration since does not fail
  it. Submissions use `agent:<attempt>` request IDs. Workflow patterns with example scripts:
  [workflows.md](workflows.md); `workflows.test.ts` runs each of its scripts in fake mode (real model names replaced
  by the fake one) and checks its claim that a failed `tools.bash` rejects with `structuredOutput`. The answer is parsed as JSON (a fenced block is accepted) and checked
  with pi-schema's `compile` (formats checked, as TypeBox's compiler did) against `schema`; failures go back to the
  same conversation, up to 3 attempts. The result's
  `structuredOutput` is the value, `details` `{ conversationId, attempts }`; nothing is reported to the parent. It has no
  prompt section (as Pi Mobile 1b763d912): its description, Pi Mobile's verbatim, carries the usage notes, and code
  mode's section lists it with the other tools scripts call. Model/thinking/tool
  validation is the subagent tool's `resolveChoice` (one-shot agents get no `team`): from the script's conversation's
  tools, `codemode` and `agent` included, so a one-shot agent's scripts may start one-shot agents again (owner
  decision: no depth limit). Its prompts are `p2.subagent-task` entries with the script's turn's origin. The plugin contributes the tool unconditionally and does not
  depend on code mode: without a script nothing can call it (`callers: ["tools"]`), so code mode stays removable while
  it is loaded (code mode's listing then disappears; `agent.test.ts` removes and re-adds code mode). It depends on subagents,
  whose document lists its conversations. The creating commit
  also writes the agent into the `p2.subagents` doc's `oneShots`, keyed by its nested call ID
  (`<script call ID>/c<n>`); the subagents worker reports them as `Child` rows with `kind: "agent"`, `callId`, the
  label as name and `lastEntryId: 0`. Their entries do not wake the report task (no ChildStore write per commit; only
  the sidebar orders by activity). Read-only: the subagents plugin contributes `ReadOnlyConversations`
  (`src/runtime/worker.ts`), which `Chat.send`/`dequeue`/`configure` consult (`forbidden`, "One-shot agents are
  read-only"); `stop` stays allowed, and `SubagentControl.archive` refuses them. Web: the sidebar skips them; the code
  mode card's nested `agent` row is a button opening the conversation (`OneShotAgents` context, `src/web/Chat.tsx`);
  the child view shows the `agent` tag and a subagent bar ("One-shot agent of a script · read-only · Tools: …") with
  Stop while it works, the scroll-to-bottom button (otherwise carried by the composer), and no composer or model chip. The TUI's nested rows show the label (else the prompt).
  `agent.test.ts` covers parallel agents, retries, no reports, listing and read-only refusals; `ui-agents.test.ts` the
  row button, the read-only view, scroll-to-bottom and Stop.
- **Subagent archiving:** `archived` on a `p2.subagents` agent, set by the tool's `archive`/`restore` or the
  browser through the worker's `SubagentControl({ session }).archive({ conversation, archived })` (owner and read/write
  guests). Archiving aborts the conversation first (`setArchived`, shared by both); `send` clears the flag; spawning an
  archived name says so. `status` omits archived agents unless named and adds "N archived (status with a name shows
  one)." `Child.archived` reaches the sidebar (`ChildStore`), pushed by the worker before `SubagentControl.archive` answers (the tool's changes after their commit): archived
  children sit behind an **N archived** row per session, open while viewing one. The subagent view now has mobile's
  bar (Tools, Archive/Restore). The TUI lists no subagents, so archived ones need nothing there.
  `subagents.test.ts` covers tool archive, status, browser restore/archive-with-abort, send restoring and guest
  refusal; `ui-agents.test.ts` the bar and the sidebar row.
- **Subagent cwd** (port of Pi Mobile 24e3fccdd; see **Agent locations**): `spawn` takes `cwd` (description and errors
  verbatim), an existing directory resolved relative to the caller's cwd through the caller's environment
  (`absolutePath`, `canonicalPath`, `fileInfo` must be a directory; else "cwd X is not an existing directory."),
  configured as the child's `pi.agent` cwd and stored as `location: { env: the caller's environment, cwd }` on its
  `p2.subagents` agent (fixed; any other action with a cwd: "Only spawn takes a cwd."). Spawn details carry `cwd`
  and, on a remote environment, `env`; `status` shows "· in env:/path"; `Child.location` reaches the sidebar list
  (`ChildStore`). The Harness (`src/runtime/worker.ts`) gives Durable each conversation's environment at its location
  (`Harness.environments`: one machine per environment, one environment per directory, all cleaned up with the
  session's). `WorkspaceBackend` opens at the viewed conversation's location, and uploads write through
  `WorkspaceWrites.write({ location, upload })` (one workspace per environment, still serialized). The watch locates
  the git directory with `git rev-parse --git-dir --git-common-dir`, so a linked worktree's index/HEAD are watched.
  With Pi Mobile 78056b34e: at every worker start and every in-place relocation the Harness moves the root and every
  conversation that follows the session whose `pi.agent` cwd differs to the session's cwd, in one commit, before it
  is live (so nothing runs or resumes in a stale cwd). The followers come from the `ConversationLocations` local
  (`src/runtime/worker.ts`), served lazily by the subagents plugin (`placeSubagents`: subagents without a registry
  `location`, one-shot agents) and without a Harness dependency (it gets the opening Durable Harness as an
  argument). No timing assumption: the worker passes `serveHarness` a promise resolved once `host.load` has
  installed every plugin, the Harness awaits it, then gets the provider and awaits its activation; an unserved type
  (`unknown_type`) then means no followers and no own locations. Nothing resolves against the process cwd. Web: the
  subagent bar adds " · in <location>", the spawn card "cwd <relative>" (`env:/path` remotely), and the transcript's
  paths and the workspace panel use the child's cwd. TUI: the card's configuration line and `/agents` rows show it.
  Tests: `subagents.test.ts` (missing/file/relative cwd, listing, status, bash pwd, per-conversation workspace list
  and upload), `relocate.test.ts` (following vs own after a move), `subagent-cwd.test.ts` (a stale foreign cwd fixed
  on restart), `harness-cwd.test.ts` (a provider installed late and activating slowly still moves followers before
  the Harness is live; version 1 own cwds placed; without a provider only the root moves), `envs.test.ts` (real sshd:
  a cwd-less subagent's bash in the remote cwd, after moving local and back; an own local location kept),
  `workspace-environment.test.ts` (linked worktree index watch), `ui-agents.test.ts` (bar, card, sidebar row,
  workspace panel).
- **Code mode setting (owner decision, differs from Pi Mobile):** `settings.json` accepts Pi Mobile's `codemode`
  boolean, but p2 defaults it to on (mobile: off). `false` uninstalls the `codemode` extension live in every worker
  without unloading the plugin: the worker's `WorkerModels` exposes its current settings, and the codemode facet
  registers a switch in `ExtensionSwitches` (`src/runtime/durable.ts`), which leaves switched-off extensions out of
  the Durable registry snapshots (a running script keeps its pinned tool). The `agent` tool stays installed (Pi Mobile
  uninstalls it with code mode); it is described only in code mode's listing. Durable 8bb180bec's code mode (prompt section
  listing callable tools, `models.*` through internal `pi.codemode.*` tools, coding-agent result layout) uses its
  defaults (`inlineBudget` 3000, `models` on, no namespaces). p2 lists tools only from the subagents' fixed coding-tool
  set, so internal tools never appear; nested-call rows show them by their script name (`models.classify`).
  `codemode-setting.test.ts` toggles it live; `durable-registry.test.ts` covers switches.
- **Code mode's calls** (copied from Pi Mobile): the core knows nested calls only as Durable shows them
  (`ToolView.calls` in `src/web/transcript.ts`: live from `pi.live.nestedTools`, grouped by the model-issued call,
  depth from the `parentCallId` chain, then the last list this browser saw). Code mode's contributions read the rest
  (`plugins/codemode/nested.ts`, `nestedCalls` in `ToolActivity` and the TUI's `ToolRenderers`): settled from the
  result's `details.calls` (Durable's `CodemodeToolDetails`), live ones of internal tools by their script name. On the
  web the script is a step of its turn's activity (below): "Ran a script · N calls, k failed" with the script's first
  comment; its detail shows the script (highlighted JS, Show all past twelve lines), its calls as a timeline (repeated
  identical calls in a row merged, "N runs, k failed" from code mode's `repeated`; a call's own calls marked "nested")
  and the output; a call opens its input (a command line for bash, PowerShell and the terminal: their `CallInput`) and
  output, a one-shot agent's call its conversation. The TUI card (`plugins/codemode/card.ts`) shows the script and the
  newest eight calls by depth, all with Ctrl+O. `codemode-card.test.ts` covers grouping/depth, the details mapping, the
  TUI and the browser (fixture `test/fixtures/codemode-card.ts`).
- **Tool calls in the chat: a run's activity** (ported from the p2-elanor branch's redesign, `src/web/activity/`;
  reshaped by owner decisions after it). The agent's responses between two people's messages (or markers, failures,
  gaps) are one turn (`chatItems` in `model.ts`). Its thinking blocks and texts stay in the transcript in their order
  ("Thought ›" opens in place; text as prose); each run of consecutive tool calls between them is one **activity row**;
  the turn's last text is its **answer** (Copy, Branch, Reply and the time it began; a stop, an error or the length
  limit below it), followed by its **results** (sent-file cards, an artifact a script showed, an opened port's links).
  The activity row is a wheel of the run's calls: while the agent works the newest call faces the reader in the present
  tense ("Running npm test") and breathes, a failed one is red, and the run's time counts (until the next response
  begins); when it ends the wheel rolls to a summary ("Read 3 files, ran 2 commands · 6 steps") and the total time. The
  reader can roll it back (drag, mouse wheel, arrow keys); a tap opens the run's calls in **p2's own sheet** (the
  runtime's `Sheet`: grip, 52px header with "N steps · 18s" and Close, swipe down to close; a centred dialog from
  700px) as a route layer (`openActivity`, layer `{ kind: "sheet", name: "activity", locator }` with the row's key):
  one 44px row per call (icon, tool name and main argument, ✓ with its time, ✗ with an exit code, ● running,
  under it the clock time it started where the minute changes from the row before, chevron); a row opens the call's
  detail one layer up (Input, Output: the command and its output as a terminal, a read's numbered lines or image, an
  edit's diff, a subagent's message and answer with Open, a history tool's entries that reveal their messages), with
  Back in the header, and a script's call one more. Back (the browser's, Android's, the header's) leads down a layer
  at a time and finally closes the sheet, like every other sheet; a tap on the wheel opens what
  faces the reader: a call (rolled there, or the newest while it runs; also thinking and texts on the wheel), the
  summary or "Working…" the run. The transcript renders the sheet (`ActivityLayer` in
  `Messages`), so it follows a running run live. The last run is live while the transcript says the agent works
  (`working`), or, before the live view arrived (the copy kept on the device), while its entries say it is not over.
  Before the first response a waiting wheel ("Working…") stands for the run. The wheel and a script's timeline are
  Elanor's `Ticker` and `Timeline`, which Elanor's npm release 0.1.0 does not have yet: p2 builds them in
  `src/web/elanor-extra/` (ported from Elanor's source as the branch vendored it, styles in Elanor's layer) until
  Elanor ships them (its `Drawer` page stack there is no longer used); the wheel's icons are Elanor's Material Symbols
  (`@earendil-works/elanor-icons-react`), the sheet's p2's own. The activity uses the interface's sans: it sets
  Elanor's ui typography tokens anew with `--sans` (`activity.css`). The transcript and the composer are at most
  Elanor's width for running text (52rem). Owner decision: no docked side panel on wide screens (the branch's
  `#side-dock`); the sheet is the same at every width. Branch-only parts left out: the "files changed" card (needs
  worker support) and the lab's result rows and cards. Tests: `activity-model.test.ts` (parts in order, runs, labels,
  summaries, grouped calls), `ui-activity.test.ts` (the sheet, its layers and Back, the wide dialog, a mixed turn, a
  long run opening at its end), and the browser tests that open steps (`codemode-card`, `nested-calls`, `ui-agents`,
  `failed-turns`, `ui-mobile-fixes`).
- **Haptics** (`src/web/haptics.ts`): in p2's iOS app only (p2-ios, Capacitor with its Haptics plugin), through the
  bridge Capacitor injects into the page; in a browser nothing (owner decision: no `navigator.vibrate` on Android for
  now). `lightTap` (a light impact) when a message is sent; `tick` at each detent of an activity wheel, whether the
  reader rolls it (drag, mouse wheel, arrow keys) or a new step rolls in: iOS's selection feedback, as its picker
  wheels give. The Ticker reports detents through `onTurn`, a p2 addition to the Elanor port. `ui-haptics.test.ts`
  checks the calls with a stand-in for the app's bridge.
- **How much of a turn shows: settings.json `detail`** (owner decision: a level in settings.json for now, no app UI;
  read live from the owner's `Models` resources snapshot, so guests see the default; each chat holds that anew, so
  until it arrives the level this device last saw is used, `localStorage` `p2-detail`, and a chat opens laid out as it
  stays). 1: only the answer and its
  results; the turn's thinking, texts and calls on one wheel per turn (keyed by the item before the run, like the
  waiting wheel), its sheet listing thinking and texts among the calls ("Thought", "Note", each opening its words). The
  turn's last text becomes its answer only once the agent stopped: while it works a text may still turn out to be a
  note (a call follows), so it stays on the wheel, and the answer arrives in the transcript once, fading in as new rows
  do, instead of showing and then jumping back onto the wheel.
  2 (default, owner decision after trying it): the agent's texts in the transcript; thinking and calls on a wheel
  between them. 3: as above, thinking collapsed and only runs of calls on wheels. 4: thinking open in full and each call its own row (the sheet's row:
  icon, tool and argument, state), opening its detail alone; no wheels (a waiting wheel still stands for a run before
  its first call). `chatItems`' `detail` merges what goes on the wheels into the runs of calls (`wheels` in `model.ts`,
  `WheelEntry`); the summary of a wheel with thinking leads with "Thought". A result its tool shows in place (an
  artifact `artifact_show` showed, `hasResult` "inline") stays in place at 2, 3 and 4 (between wheels, or after its call's row at 4;
  the wheel after it is the row that waited there); at 1 it joins the results after the answer, drawn in full, so the
  turn keeps its one wheel. `activity-model.test.ts` covers the levels, `ui-detail.test.ts` the transcript and the
  sheet as the setting changes live, and the answer arriving once.
- **Tools' look comes from their plugins** (owner decision: no tool-specific code in `src/web`). A plugin's web facet
  contributes `ToolActivity` entries, keyed by tool name, to the `ToolActivities` registry (`src/runtime/web-core.ts`;
  type in `src/web/activity/model.ts`, the parts a detail is built from in `src/web/activity/api.ts`, all through
  `@p2/app/v1/web`): its words on the wheel and in the sheet (`describe`, `running`: a `Kind` from the activity's icon
  vocabulary, a verb, an object, an extra), the row's main argument, a failure word ("exit 1"), its words in a run's
  summary as a function of the count (tools sharing the function count together: write and edit), its `Detail`, the
  calls it made (`nestedCalls`) and how it words repeats of them (`repeated`), a nested call's `CallInput` and
  `CallDetail`, and a `Result` with `hasResult` saying where: after the answer, or inline, right after its call (an
  artifact `artifact_show` showed; the run of calls splits around it; at detail 1 after the answer). A script's
  nested calls place their results as top-level calls do (`withResults` in `model.ts`, from the nested call's name,
  arguments and status: it has no result of its own). Writing one:
  `docs/tool-ui.md`. A detail shows everything at once (no
  "Show all" inside it; long output scrolls with the sheet) and follows a running call live; the one cap kept is a
  script's calls: the newest eight, the rest behind "Show all", as the transcript's card had them. Owners: `coding-tools` (bash, read, write, edit), `terminals`, `codemode`, `powershell`,
  `subagents`, `agent`, `artifacts`, `send-file`, `ports`, `conversations`, `history`, each in its `activity.tsx`. The
  chat plugin reads the registry and passes the table to `transcriptRows` and `ToolActivityContext`. A tool without a
  contribution (an MCP tool, `team`) reads as its name and first short string argument with the generic icon ("used
  web_fetch", "used web_fetch 3 times" in a summary), its detail the input as JSON and the output; PowerShell
  contributes only its `CallInput`. Tool declarations and schemas carry nothing for this. Tests: `activity-model.test.ts` (contributed and generic words, summaries), `ui-activity.test.ts` (a
  plugin's detail and the generic one), the fixtures' table (`test/fixtures/transcript.ts`, `PLUGIN_TOOLS`).
- **Incoming messages** (`Incoming` in `src/web/Chat.tsx`): every message that is neither the owner's nor the agent's
  own (a subagent's answer, question, note or failure, `p2.agent-message`; another session's, `p2.peer-message`; a
  guest's input or chat message) has one shape: a header line "icon name · what · time" (answered, asks, wrote,
  failed, (guest) wrote), muted but the name, and the body as Markdown indented under the name, cut after about eight
  lines with "Show more". Owner decision: no coloured side edges, no left border lines, no per-kind or per-guest
  colours; kinds differ only by icon and word. A subagent's header (at least 44px, with a chevron) opens its
  conversation in this session, another session's header that session (owner only); both are navigation steps, so
  Back returns. A guest's has no target. The body is never a link. The owner's messages keep the bubble; inputs
  without an author (a main agent's task in a subagent's conversation) too. A sent one has its time, Edit and Copy
  below it (owner decision: timestamps quiet, in the action rows; `src/web/Time.tsx`, absolute: the clock today, the
  date before it on other days, the full moment as tooltip; no "n minutes ago", which would need a ticking clock).
  Not done: "Answered: …" under an answered subagent question (no data links a `team` question to the main agent's
  later `subagent send`). Test: `ui-incoming.test.ts`.
- **Earlier history while a turn is one row:** a page of a turn's tool calls can add next to no height (they are all
  one activity row), so the transcript loads earlier pages by itself while following the answer at the bottom and
  less than a viewport of history is above it, not only on a scroll up (`#loadEarlier` in `use-chat-scroll.ts`), and
  asks again after a page that grew the loaded history (`history.size`, the transcript's item count), not only after
  one that added rows. Before, a long turn could leave only its row under "Earlier messages", with nothing to scroll.
  `ui-mobile-fixes.test.ts` covers it.
- **Security limits (as Pi Mobile):** for static UI requests, guests may load their session's pages, the installable
  app's `public/` files, the bundle manifest and files from the current or briefly retained bundle generations
  (`src/hosts/web.ts`); other web-host paths are 403. Authorized plugin routes retain their own guest permissions.
  Raw filesystem source paths are never served directly; bundle source maps are available as bundle files. `/chord`
  sockets (`src/hosts/socket-limits.ts`): frames up to 1 MiB (Chord's part limit too), no limit on calls in progress (owner decision:
  Chord v2 has none), more than 4 MiB unsent output beyond the frame being sent
  terminates it, socket errors never crash the server. Terminal sockets keep their own 1 MiB frames and 8 MiB
  backlog. A provider login belongs to the owner principal that started it: only it sees, answers, cancels or
  dismisses it, and its leaving (all holds of its Providers sheet gone) ends it; another owner device cannot.
- **Reuse** of apps/mobile: none. Adapted implementations live beside their plugins; shared backend helpers live
  in `src/runtime`, shared browser code in `src/web`. p2 is an independent npm workspace with pinned dependencies.
  `src/web/style.css` is a copy of mobile's stylesheet; terminal and environment styles live beside their plugins.
  Web tests verify guest access to bundle files and rejection of raw backend, mobile and private-data paths.
- **Pi Mobile UI parity:** the web UI copies Pi Mobile's components, markup and styles; native Chord
  locators/references, leases, permission checks and byte channels replace mobile's transport (no mobile imports, no
  protocol compatibility client). Not exercised against live services: real terminal programs/SSH without a
  packaged/local pi-env daemon build (offline terminal layout tests do not prove shell integration), external provider
  sign-in, physical device sign-in/clipboard and Radius. Parity comparisons (390×844, 1280×900) covered representative
  screens, not every provider/tool/media/error combination.
- **Voice mode** (`plugins/voice`, `voice-server/`; README "Voice mode"): hands-free talk with a conversation, like
  Claude's voice mode; the screen stays on and audio goes through Bluetooth (no Android Auto app). Owner decisions:
  speech runs on slayer's CPU (no GPU there): Parakeet TDT 0.6B v3 (int8, sherpa-onnx; about 6% of real time on the
  i9-13900) and Supertonic 3 (picked over Kokoro, Piper and Supertonic 2 by ear; voice selectable, F1 default); English
  only; no full-screen mode, an orb in the composer. Design: the speech service is a separate Python service (its
  dependencies stay out of the npm tree) that p2 proxies for the owner, so the phone's p2 and slayer's both use it and
  the page's CSP stays `connect-src 'self'`. The browser does the conversation logic with the ordinary `Chat`
  contract: a final transcript is `send` (steering while busy), new answers (keys present when voice mode started are
  skipped) stream through `SpeechChunker` (sentences, no code blocks or tables) to `/voice/speak`, played in order.
  While audio plays the microphone is not streamed; pibot's barge-in detector (energy the playback does not explain)
  only starts streaming it. Owner rule: only words interrupt. The speech service sends interim transcripts
  (sts-server `interim`); the first with a real word (no filler, not the agent's own speech heard back) cuts the speech
  and stops the run at once, also while the agent works silently (`interruption.ts`); a trigger the room never hears as
  words is dropped and the agent goes on. Transcripts without words are never sent; a stop phrase also calls `stop`. A `voice.mode` conversation document turns the `voice` prompt
  section on (short spoken answers); the switch follows the button. Tests: `voice.test.ts`, `voice-ui.test.ts`
  (Chromium fake microphone).
