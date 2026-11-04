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
| `P2_DATA_DIR` | `~/.pi/p2` | data directory: `catalog.sqlite`, `sessions/<id>.sqlite`, `settings.json`, `models.json`, `envs.json`, `mcp.json`, `auth.json`, `radius.json`, `forwards.json` |
| `PORT` | `8788` | listen port (loopback only), so p2 never collides with pi-mobile on 8787 |
| `P2_FAKE` | unset | `1`: the faux provider (`faux/faux-1`, echoes the prompt; `slow …` streams long; `rename-session <title>` calls the tool; `subagent`, `subagent-bad`, `subagent-answer`, `subagent-configure`, `subagent-send`, `subagent-archive`, `subagent-status` exercise subagents, `subagent <json>` calls the tool with those arguments, as do `team <json>`, `history_search|read|handoff <json>`, `location_envs|dirs|move <json>`, `tool_search <json>` and `mcp__<server>__<tool> <json>`; `codemode` runs a script calling bash and read, `codemode-restart` one whose slow middle call a restart interrupts, `codemode <script>` runs that script; `json <text>` answers exactly `<text>`; a one-shot agent whose task is not `json …`/`slow…` answers a small value matching its schema) |
| `P2_IDLE_MS` | `300000` | idle time before a session worker stops |
| `P2_PROVIDER`, `P2_MODEL` | unset | default model for new sessions after settings.json's `defaultModel` (both or neither; Pi Mobile's `PI_MOBILE_PROVIDER`/`PI_MOBILE_MODEL` work too) |
| `P2_RADIUS` | unset | `0`: disable the outbound Radius brain connection even when signed in |
| `PI_RADIUS_GATEWAY` | production Radius | gateway selected by `npm run radius:login` |
| `P2_TERMINAL_DAEMON` | unset | optional local pi-env daemon binary; otherwise use packages/env release/development builds |

- **Web UI:** `buildWebBundle` (`src/hosts/bundles.ts`) bundles `src/hosts/web/main.tsx` with the selected plugins'
  web facets. Content-named JS, CSS, assets and source maps are served from memory under `/__p2_web/`; `GET
  /__p2_web` returns the no-store `{ version, script, style }` manifest, and `src/hosts/web.ts` renders the page.
  Builds are deterministic across checkout locations and capped at 8 MiB excluding source maps. Startup builds in
  the background; failures produce an owner notice and page loads return 500 until a build succeeds. Plugin reload
  builds the web and TUI candidates before committing the backend, so a failed build preserves the old code and
  bundles. A custom esbuild loader records the exact app-source bytes it supplies for dev
  change tracking. Visible pages poll every 5 seconds and reload on any manifest-version change; foregrounding checks
  immediately. At most two previous generations remain available for up to 60 seconds. This polling is temporary
  until loader model D provides scoped, per-facet `ClientBundle` pushes (`docs/plugin-loading.md` 5.3 and 12.2 step
  4). The TUI launcher separately polls `/__p2_tui`. There is no Vite, source-module server or `index.html`.
- **Bundles for Radius Cloud Brain:** the public repo `earendil-works/bundled-ui` holds prebuilt copies of this web
  bundle, built from a pi-private checkout by its `scripts/build.mts` (imports `buildWebBundle`). The script patches
  three places in the built script: the Chord socket URL (`` new WebSocket(`${...}://${location.host}/chord`) ``),
  the version poll (`fetch("/__p2_web",{cache:"no-store",credentials:"same-origin"})`) and the `/__p2_web/` asset
  prefix. It fails when a target is missing, so changing those in `src/hosts/web/main.tsx` or `WEB_BUNDLE_PATH` means
  updating that script.
- `npm run dev` also watches plugins and supervises runtime restarts; see **Dev mode** below. Under `npm start`,
  code changes (web included) take effect only after a restart.
- **Data report** (`scripts/data-report.ts`, read-only, beside a live server): per session its title, location,
  conversations with their entry counts and newest entry IDs, subagents, share modes, artifacts, uploads and
  downloads, plus environment and forward names; never secrets. `--compare before.json` lists differences (exit 1).
  `scripts/verify-sessions.ts [url]` checks a running p2 against it as the loopback owner: the session list, and the
  newest entry of every conversation through `Chat` for the 10 newest sessions and all with subagents or shares
  (stopping workers it started). `test/fixtures/v1-data` is a data directory p2 wrote on Chord v1 (generated at
  aee97d3a9; the generator went with v1); `v1-data.test.ts` opens a copy and checks both tools and the contracts.
- One server per data directory (process lock). To try p2 next to a real setup without touching it, set
  `P2_DATA_DIR` to a temporary directory.
- Localhost is the device owner. Through an HTTPS tunnel host listed in `P2_ALLOWED_HOSTS` (comma-separated),
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
  rolls them out to the server and every running worker (`plugins.rollout([server step, workers step])`) and rebuilds
  the TUI and web bundles. A plugin whose build fails keeps its old code (an added one stays out) and the reload is
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

The `dev-tools` worker plugin provides **reload_plugins** (`{}` for dirty plugins, or
`{"plugins":["chat","sessions"]}`). It is limited to root conversations working on a local p2 checkout (or
its containing repository), and only owner-initiated input. The calling assistant entry fixes attribution;
a later guest message or forged subsequent speaker block cannot change it. Guests, peer input, unattributed
reports, subagents and remote-environment sessions are denied. It is not a location tool: it stays with the main
conversation, works only while the session is on the local p2 checkout, and no subagent can be granted it. Tool upgrades are not automatically replayed after
a crash. For runtime edits, use the explicit CLI `--restart` command instead. Do not invoke the owner server's
controls from tests: use disposable data dirs and independent supervisors.

`test/p2/dev.test.ts` uses a disposable checkout, fake provider and port 0: dirty-only saves, explicit button and
CLI reloads/refusals, hot additions/removals during streaming, private channel isolation, web edits (dirty, then a
new content-named bundle on Reload; non-plugin bundle inputs ask for a restart), manual runtime restarts,
unseen-worker restoration and no duplicate inputs. `dev-tools.test.ts` covers owner attribution, denial and tool
failure results.

## TUI

```sh
npm run tui                         # device owner on http://127.0.0.1:$PORT, default 8788
npm run tui -- https://pi.example    # prompts for an owner link unless its saved cookie is valid
npm run owner-link -- https://pi.example   # on the server machine, print a private fragment link
# Paste that link at the TUI prompt, or supply --owner-link '<link>' / P2_TUI_OWNER_LINK.
```

Direct HTTP loopback uses the core device-owner path without prompting or sending a cached remote cookie.
Its owner-only `GET /__p2_dev` preflight also works before a Devices protocol upgrade; a proxy marker refuses the
path and causes a link prompt. The default is always `http://127.0.0.1:$PORT` (8788 unset), not `P2_PUBLIC_URL`.
Remote URLs require HTTPS. `--owner-link <link>` (or `P2_TUI_OWNER_LINK`) redeems only a same-origin `/owner#<token>`
link through POST and saves the returned cookie. Without a valid saved cookie, the TUI prompts for that link. A share link works too: `--join <https://host/join/token>` (or pasting it at
the prompt) asks for a display name and redeems it with `POST /join`; the guest cookie is saved per origin beside any
owner cookie and reused after a `HEAD /__p2_tui` check. If the server stops admitting it (link reset, guest removed,
session archived) the TUI exits with a notice and forgets it. Loopback stays the device owner unless `--join` is given.
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

The launcher recognizes output, opaque chord-link frames, reload and exit requests, plus (p2-tui-port.md 3.6a)
`navigation`/`keyContext` reports, sanitized and rate-limited `title`/`progress`/`programStatus`, and `request`s for
registered launcher actions, which run only under a grant: the visitor's own privileged key or a confirmation in the
launcher-drawn consent screen (worker IO suspended meanwhile). Unknown requests are denied. Worker-set terminal modes
(autowrap, mouse only by the visitor's `prefs.json` `mouse` policy) are tracked and undone on exit, crash and swap. WebSocket frames are relayed unchanged with 4 MiB
frame/queue limits. Every output write passes `tui-filter.ts` (64 KiB UTF-8/frame): text, CR/LF/tab, SGR, cursor
movement/position, erase, cursor visibility, autowrap, synchronized output, bracketed paste, pi-tui alternate screen
and scroll region. OSC 52/title/hyperlinks, DCS, APC/PM/SOS, kitty graphics, C1 controls, unknown CSI/private modes and malformed
or incomplete escapes are stripped. No partial escape can cross a frame boundary. Raw worker errors/streams never
reach the terminal. Rendering is copied from coding-agent's interactive mode and DurableTui (p2-tui-port.md P0c/P2;
p2 imports neither coding-agent nor mobile): a fullscreen layout (transcript `ScrollView` over a dock of status lines,
pending area, pi's editor with the working indicator in its border, and pi's footer), incremental transcript
components keyed by the shared display items (`src/tui/components/`), pi's tool cards and renderers for bash, read,
write, edit (the result's diff), grep/find/ls and code mode (`src/tui/tools/`), and plugin contributions through
`TuiToolRenderers`, `TuiToolRendererResolvers`, `TuiEntryRenderers` and `TuiMarkdownTransformers`
(`src/runtime/tui-renderers.ts`). Drafts, pending send IDs and reading positions are kept per viewed
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
`/artifacts` shows an artifact there when the terminal fits it; it follows new versions through `ArtifactList`). The editor keeps
the focus; F2 (`p2.panel.focus`) moves it into the panel, where the runtime sets pi-tui's `capturesViewportInput` and
scrolls the panel with the viewport and select keys, keeps other keys from the editor and returns the focus on Escape.
Search stays on the transcript (the primary scroll view). Hidden below 100 columns; closed on navigation to another
conversation and whenever the command registry changes (a facet reload), like overlays.

The launcher polls the bundle version every second. A changed hash prepares a new worker while the old one remains
active; once ready, it copies bounded UI state (selection, drafts, send retry IDs, display toggles, reading position),
swaps the fixed-origin connection and terminates the old worker. Failed preparation retains the old worker.
`/reload` also creates a fresh worker, even for an unchanged hash. There is no local watcher or local facet reload.
Network drops reconnect with bounded exponential backoff; subscribed references rebind and gone references reacquire.
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
- **Worker failures:** a failed start stays failed (status error, Retry) and its holders wait (`failed { waiting }`,
  `whenLive` does not reject: tests use `failureOf`). A running worker that crashes is restarted for its holders, at
  most five times a minute per session; the next crash waits for Retry. A worker stays alive while objects
  linger on it (Chat 30 s after its last viewer), on top of `P2_IDLE_MS`.
- **Principals:** owners, guests and workers as before (`src/runtime/principals.ts`); the server host acts as `SERVER`
  (workers tell its own requests from a person's), a worker as `HOST`. A method's `ctx.get` acts as its caller: code
  that must reach a worker as the server runs in `serverOf(self)().root` (a root of the server's own). Revocation is
  Chord's (`revokedBy`: a device, remote owners, a guest).
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
- **Registries:** keyed registries (`keyedRegistry`) compose contributions into a map; the core facets serve the base
  ones (`serveServerRegistries`, `serveWorkerRegistries`, `tuiCoreFacet`, `webCoreFacet`), a plugin serves its own
  (`serveKeyed`). One contribution per registry per object or facet.
- **Plugins:** see **Plugin layout** and **Plugin reloads**; the server loads its facets with `createPlugins`, workers
  get theirs from the workers component, the TUI and web bundles load theirs with `host.load`.
- **Protocol versions:** a page or TUI reloads when the server speaks a newer link protocol (`newerPeerProtocol`).
- **Contract versions:** pages and TUIs keep the contracts they were built with until they reload, so a deploy that
  bumps a contract a client holds must keep serving the old version: write the history with `evolve` (the released
  version as the base, verbatim, so old bundles' fingerprints match) and give the provider an `accepts` table mapping
  current state and results back (`Sessions` v3/v4, `Catalog` v2/v3, `SessionTree` v1;
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
- **Ports** (`plugins/ports`): server-owned `forwards.json` registry; owner **Envs → Ports** lists/adds/removes
  forwards and confirms public opt-in. Every forward is private by default and has an isolated
  `https://fwd--<brain label>--<random id>.rdtun.com/` address. Public forwards additionally have
  `https://pub--<brain label>--<id>.rdtun.com/`; anonymous channels can reach only currently-public forwards,
  never Pi. Removed IDs stop working. Radius forwards HTTP and WebSockets to `localhost:<port>` with local
  Host/Origin, public `X-Forwarded-*` and rewritten localhost redirects, without the relay secret. Pi's own
  port cannot be forwarded. Links appear after the owner opens Pi through Radius and survive restart;
  on-device Open uses localhost. Radius sees forwarded traffic; this is not a sandbox.
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

## Browser navigation

`src/web/navigation.ts` is an independent, minimized copy of Pi Mobile's stack. `src/runtime/web.tsx` exposes
`useNavigation()` and `useRoute()` to plugins. Routes contain a session/conversation, named sheet/viewer layers
(with small string locators), the workspace location, and an optional bottom terminal. Only the top modal shows.
The stack and per-area scroll positions persist in this tab's sessionStorage; URLs identify conversations
(`/s/<id>` and `/s/<id>/c/<conversation>`), not modal payloads. Restored locators may be unavailable.

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
- Conversation destinations retain the workspace tab and terminal placement, but reset file/commit/search locations
  and never carry the request to start a terminal. Server events never push.
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
cached so background references cannot continually respawn it. Owner-only `WorkerControl.retry` stops the old
instance and clears the failure and notice before a new Chat hold; drafts and attachments stay intact. Creating a session
navigates to its view before awaiting the worker, so a failed first start also has a visible recovery screen.

Host `onError`, refused reloads and worker failures publish bounded, redacted owner notices (`LogNotices`), with
Show logs and Dismiss. Notices keep the latest error per source (at most 50 sources); normal shutdown/abort
messages do not become worker-failure notices. Archived-session admission refusals are not cached as crashes,
so restoring an archive still works without an extra Retry. Archiving stops the worker with
`SessionWorkerControl.suspend`, not `stop`: holders of the session's objects (a page's lingering conversation) wait
suspended until a restore (`retry`) or their release, instead of starting a worker the archive refuses. Neither guests nor workers may read or dismiss notices, or invoke
the worker retry control. Dev controls additionally publish their own reload/restart results.

The owner-only `logs` plugin adds **Logs** to `sidebar-foot:logs`. Its sheet selects Server, session workers,
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
Footer actions wrap so the additional Logs button cannot overflow the
translated phone drawer and intercept chat taps.

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

- **Durable names are p2's.** Documents `p2.subagents`, `p2.agent-run`, `p2.artifacts`; tasks
  `p2.subagent-anchor`, `p2.subagent-reporter`; entries `p2.input`; extensions `p2-artifacts`, `p2-downloads` (and the
  unprefixed `subagent-tools`, which subagent conversations store in their agent state). No `mobile.*` name is read.
  p2 sessions created before the rename (with `mobile.*` documents) are not migrated: their subagent registry,
  one-shot agents and artifact index look empty (owner decision). Pi Mobile sessions were converted to these names by a one-time
  importer when the phone switched to p2 (removed afterwards; see git history). The only Pi Mobile remnants are
  content, not kinds: the model-facing `<mobile-speaker>`/`<mobile-conversation>` header blocks, and
  `legacyMessage`, which reads old `pi.user` entries by that header.
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
  `tui-chat.ts`). Base code imports no plugin code; only the page's shared components (`src/web/Drawer.tsx`,
  `ModelPicker.tsx`) read plugin contract types (`import type`). A plugin's own files stay in the plugin, assets
  included (`plugins/terminals/vendor/ghostty`). Facets use no `import.meta`: the p2 app directory is start data
  (`Server.info.app`, `WorkerInit.app`). The terminal host (`plugins/terminals/main.ts`) is its own program, not a
  facet, and imports base code directly. `plugin-layout.test.ts` builds every server, worker, TUI and web facet with
  Chord v2's `buildFacet` against the API.
- **Runtime registries and locals** (`src/runtime`): `Routes` (HTTP by `METHOD /path`, exact path), `WorkerInitValues`
  (spawn parameters contributed per plugin; a throw refuses the start, e.g. archived sessions), `Hosts` (worker
  states, restart for the holders), `HarnessHost`/`HarnessNative`, `Extensions`, `HarnessConfig`, `Slots`,
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
  Every main agent has them; a subagent only when its main agent chooses them (`subagent spawn/configure tools`; not
  in the default selection). All require a turn the owner started (`originOf`; a main agent's message to its subagent
  carries the main turn's attribution as a `p2.subagent-task` entry), and the server side (`AgentLocations`) admits
  only current worker generations. The main agent's move is deferred: it records `p2.location-move` on the main
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
- **Relocation (in place):** `Sessions.relocate` (web Relocate, TUI `/cd`) does not restart a running worker.
  - **Server** (`SessionWorkers.relocate`, serialized with starts, stops and pauses): fences the worker with
    `WorkerBoundary.prepare` (refused while anything runs: "Stop the current run before changing directory", a named
    subagent, background work), updates the catalog, then calls `WorkerBoundary.relocate`, which runs
    `Harness.relocate` and lifts the fence. The fence counts as an active call, so the worker cannot stop idle
    meanwhile. The steps run in a root of the server's own (`host.root`), not the caller's: an aborted call or closed
    tab cannot cut them off. A worker is never left fenced: a failed catalog update lifts the fence (`cancel`); a
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
    `Harness.environments` resolves on the new machine: whether p2's private data directory is denied is decided from
    the environment (`isLocalEnvironment`), never from the location (workspace, file index, attachments). What is
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
    the real Harness: dev-tools and PowerShell after real moves, the private directory decided by the environment, a
    move during workspace activation, a transient reopen failure, the session moving to another machine while a
    subagent's own location stays with its tools, workspace and file index, concurrent commands on two machines with
    one connection each and closing only unused machines), `harness-cwd.test.ts` (version 1 registry placement),
    `envs.test.ts` (local to SSH and back in place, an own local location staying while the session moves to SSH,
    real sshd).
- **Retries:** `retrying()` (src/runtime/retry.ts) only retries `upgrade_conflict` (an old root reaching an object a
  reload migrated), in a fresh root. Roots of a worker that started behind the server are admitted by Chord.
- **Principals** (`src/runtime/principals.ts`, typed: `P2Principal`, with Chord's API typed by it in
  `src/runtime/chord.ts`): `owner` (trusted loopback `access: "local"`, authenticated Radius `access: "relay"`, or a
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
- **Authors** are assigned by the worker from the principal and written as the first speaker block of every input
  (`src/runtime/speaker.ts`); stop/dequeue restore text only to its author; removing a queued input (×,
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
  drag that starts on a sheet's top edge (a grip above its header, and the header; both `touch-action: none`) moves
  it with the finger and fades its scrim; release closes it on a downward fling (> 0.3 px/ms) or past 30% of its
  height, else it settles back; the route closes when the slide out ends. Drags in the content stay scrolls; upward
  pulls give 20%. Both swipes share the drag mechanics (`src/web/drag-gesture.ts`: following one touch, deciding its
  axis within 35 degrees and owning it with cancelable moves, release velocity, settle timing); each supplies where
  it may start, which direction it takes, how it paints and what release means.
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
  Going home forgets it; a browser tab opening `/` and a launch with another address are unaffected; signing out
  forgets it.
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
- **Service worker** (`public/sw.js`, served at `/sw.js` with `no-cache`): the app starts without the network once it
  was opened. App pages come from the network first and fall back to the last app page kept (on failure, or after 3
  seconds); the web bundle's content-named files come from the cache first (the newest two bundle versions are kept);
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
  the "Connecting…" bar after a drop; only a page that never connected shows it.
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
- **References** (Chord entry 8): an awaited `ctx.get`/`host.get` is ready with its state; UI runtimes hold
  synchronously (`host.hold` in `useObject` and the TUI's `watch`) and read state through `useReadable` (undefined
  until hydrated). Multi-variant references narrow on `variant` before using a member that not every variant has:
  inline, `inVariant(ref, ...variants)` (the ref or `undefined`; a loading ref has no variant yet), `useObject(type,
  input, { variant })`, or `expectVariant` where a mismatch is a bug (throws `not_in_variant`); all in
  `src/runtime/chord.ts`. A TUI `watch` binds after `ready`, so its callback narrows on `ref.variant`. Tests use
  `holdIn(host, type, input, variant)` (held, ready, `expectVariant`). Method-only references take `{ state: false }`.
- **Lingering views** (`UI_LINGER`, `src/runtime/refs.ts`): the web's `useObject` and the TUI's `TuiScope` release a
  Chat reference 2 minutes after its view goes (at most 4), so switching back to a conversation binds at once; a
  lingering reference counts as a viewer for worker liveness. Transcripts live per host and conversation (`transcriptOf`, at most 4 not
  viewed), and a view taken again merges its snapshot into them.
- **Worker liveness**: viewers (live Chat objects and held workspace backends), active calls, Durable tasks; the host manager stops an idle worker
  after `P2_IDLE_MS`. Browsers re-`get` a reference that went `gone` (`useObject`).
- **Conversation views** are mirrored with `cell.replace`: a new Durable revision shares unchanged containers with
  the last, so subscribers get a diff. `Chat` exposes `Conversation.view` directly (a held reference's state member).
  Durable watches become listener sources without memoizing: a reload keeps the subscription (same resource, same
  `select` source text), so a watch is never started twice.
- **Sharing** (`plugins/sharing`): `Shares` (server local, `shares.sqlite`: links, guest identities with a
  revision), `Presence` (connected guests, in memory), `GuestPresence` (held by a guest page's web facet; its
  resource enters/leaves `Presence`), owner-only `Sharing` (links, connected guests, link/reset/remove). Guest
  principals carry their grant revision; removal, link reset, archive and restore bump it and call
  `invalidatePrincipal`, so the guest's objects go `gone` and its socket closes. The server consults the
  `Authenticators` registry (guest cookie) and `SessionAccess` (guests reach only their session at the current
  revision). Guest names are unique per session ("Alice (3)"), as in apps/mobile. The web share sheet is a
  `session-actions` slot in the chat top bar, held in the navigation stack; Back closes it and reload restores it.
  `test/p2/sharing.test.ts` covers guests over WebSocket; `ui-drawer.test.ts` a read-only guest page behind HTTPS.
- **Files** (`plugins/files`): `POST /upload?session=&name=` (owner or read/write guest of the session; exact
  same-origin `Origin`; 25 MiB; stored in `<data>/uploads/<session>/`, never in the project) returns an attachment;
  `Chat.send({ attachments: [ids] })` resolves IDs through the worker's `Attachments` local (only files of that
  session), and the message lists their paths, with images inline when the model accepts them. `DownloadStore`
  (server local) saves immutable snapshots for producers (send_file); `GET|HEAD
  /download?session=&id=` serves them to the owner and the session's guests (no `Sec-Fetch-Site: cross-site`;
  ranges for audio/video). Owns local `Uploads`, `Downloads` and `filePreview` implementations. Web: the composer's
  attach button and drag/drop upload files at send time, including a new session's first prompt.
- **File index** (`plugins/file-index`): `FileIndex({ session, conversation })` (participants, as `Workspace`) answers
  `@` completion (`complete`, ranked like pi's `@`) and Tab completion (`list`, one directory) for the TUI and the web
  composer. A worker-local cache per conversation (`FileIndexCache`) builds from `WorkspaceBackend`'s `files` query
  (git ls-files or the bounded walk, private paths excluded, `truncated` surfaced), derives directories from paths,
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
  read-only guests and cross-session guests are denied. Private data and `.git` paths cannot be opened.
  Web: route-owned sheet with Files (tree, fuzzy filter, uploads), Changes (working tree, paged branch commits),
  Search (literal text and include/exclude globs), File/Changes/Preview views, and Comments. Review drafts and open
  editors persist in localStorage per conversation; Send/Send all use ordinary attributed Chat input. Integration
  tests cover fake-provider prompts, a temp git repo, bounds, reload/watch lifetime, HTTP streaming/ranges, upload
  cleanup/concurrency and guest revocation; `ui-workspace.test.ts` the browser panel. The web panel docks at 1200 px,
  remembers its resizable list width, and shows a file beside the list when both chat and file can retain 480 px.
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
  SSH configuration comes from the envs plugin and the conversation's location environment; the separate `terminal-sessions.json`
  mapping is no longer read. Host keys use `ssh/known_hosts` and `pi-env-<name>` aliases. `envs.test.ts` exercises a
  remote terminal against a disposable localhost SSH fixture; no real remote host is used. Windows PTYs remain unsupported. The workspace has an owner-only
  Terminal tab through the terminals plugin's `workspace-terminal` slot. Side and bottom panels carry across a
  session switch, showing that session's terminals without starting one. Only explicit terminal-button/tab taps
  request auto-start; attachment updates replace the route, never push or reopen a later destination.
  Outdated hosts show Restart (ends all terminals), but idle outdated hosts are not automatically replaced yet.
  `terminals-host.test.ts` covers shells, disconnect snapshots, foreground jobs, themes and flood resync;
  `terminals.test.ts` covers guest/control denial, one-use byte grants, session isolation, reload and server restart;
  `ghostty.test.ts` and `terminal-input.test.ts` cover the copied browser primitives. PTY tests skip when no daemon build
  exists.
- **Search** (`plugins/search`): `SearchIndex` (server local, `search.sqlite`: root/subagent user/assistant text in FTS5 and
  one cursor per conversation; derived, dropped on a schema change). Each worker's `Indexer` (lifetime "host") runs a task that reads
  the server's cursor (`SearchFeed`, worker principals only, session from the principal), scans each root/subagent
  conversation's immutable history after it in pages of 200, and sends them; each call returns once the server
  committed it, and the cursor sent stays put until the last page of a range, so an interrupted scan repeats the
  range (idempotent by entry ID). It runs at start and after every commit adding entries (Durable
  `observeCommits`), and retries after an error (server unreachable, reload) from a fresh cursor. The speaker and
  peer-sender blocks are not indexed. Owner-only `Search.search({ query, archived })`: sessions whose title or cwd
  contains the query (sidebar order) and up to 41 message hits (literal terms, all required) in the archive scope.
  Search hits include conversation IDs, and a hit opens that conversation (a subagent's too); default titles derive from the first root user message, explicit titles
  survive reindexing, and `updatedAt` advances monotonically with indexed activity. The sidebar search box (owner) filters sessions and
  lists message hits.
- **Configuration** (`plugins/models`): `ModelConfig` (server local) owns p2's `Resources` observer
  (settings.json, models.json, auth.json; hot reload) and contributes it to `ModelResources` (a native), plus `summary` (model
  picker) and `snapshot` (settings, providers, credential metadata, errors; never secrets). Workers run their own
  observer (`WorkerModels`). `startServer({ resources: { createModels } })` injects a fixture provider (tests).
  Edit `settings.json` as a file; valid changes hot-reload and in-flight requests keep their configuration.
  Set the default model and thinking level with **Make default for new sessions** in the model picker; there is no Settings editor UI.
- **Devices** (`plugins/devices`): `npm run owner-link [base-url]` calls the direct device-only loopback token path,
  then prints a private `/owner#<token>` link. Base defaults to `P2_PUBLIC_URL` or `http://127.0.0.1:$PORT`; invitation
  lifetime is ten minutes, single-use. The nonced sign-in page is also the stranger landing page; it immediately
  scrubs the fragment, POSTs it, then redirects to `/`. HTTP/proxy URLs never carry the token. Signed per-device
  cookies are HttpOnly, SameSite=Lax, Secure on a remote origin, with a 30-day browser/server expiry. The private
  `owner-key` signs cookies; `owner-revoked.json` persists individual logout, and all-device logout rotates the key
  and revokes live remote-owner objects/links through `Server.revokeOwners`. First signed-cookie startup rotates
  the old exposed raw-key cookie once (`owner-cookie-version`); no legacy raw-cookie compatibility. The web host
  exposes no filesystem paths; it serves only app pages, `public/` files and bundle files. Headless `owner-token.txt`
  is replaced each startup. Cookie owners are remote (`access: "device"`
  plus device ID), even when redeemed locally, so they cannot mint invitations. Device bootstrap privileges remain
  inherent to the machine. Compatible reloads keep invitations; restarts invalidate them but keep cookies/revocations.
  Tests use only temporary directories and port 0, with no real provider requests (`devices`, `proxy-marker`, `tui`,
  and the fragment-link browser regression in `ui-parity.test.ts`).
- **Loopback owner cookie** (Pi Mobile's, `src/runtime/loopback-cookie.ts`): the local owner's browser gets
  `p2_device_<port>` (HttpOnly, SameSite=Strict, secret in private `<data>/device-cookie`) when it loads an app page
  (`/`, `/s/…`) on loopback. Cookieless loopback requests stay the device owner (TUI, owner-link, first page load),
  except on a share's join page: only an owner by cookie or relay skips the form, so a fresh profile/incognito tab
  opening `http://127.0.0.1:<port>/join/<token>` joins as a guest. A guest cookie wins over the cookieless fallback
  for every request (pages, WebSocket, files); the loopback owner cookie wins over a guest cookie (the owner's
  browser stays owner). Checked only on loopback. `loopback-join.test.ts` (HTTP and Chromium with fresh profiles).
- **Provider login** (`plugins/login`): `LoginService` (server local) runs its own `Logins` (provider-owned
  api-key and OAuth flows); its events arrive through a listener and become the `login` state (status, the pending
  prompt, notices; never credentials or answers). `ProviderLogin` admits every owner (local, device-associated,
  or Radius), never guests, and adds the provider list. Web: Providers in the sidebar footer for every
  owner, regardless of browser hostname. Remote flows automatically choose device-code when the provider offers
  it; account selectors remain interactive. Browser-callback flows keep the provider's registered callback URL:
  complete sign-in in the provider tab, then paste the authorization code or final redirect URL. Anthropic shows a
  code; OpenAI ChatGPT may land on an unreachable localhost page, whose full address must be copied from the address
  bar and pasted into Providers. The manual prompt explains that the page need not load. A device-code event with
  `openBrowserOnConfirm: false` (a provider asking clients not to offer opening its page) shows the verification
  address as text instead of the Open link (web), and the TUI offers no "open in browser" for it. No pi-ai changes or custom
  callback URL. API keys and pasted codes pass through the tunnel/relay; use a trusted transport. Once no browser
  holds the sheet, an unfinished login is cancelled. Tests use fake providers (login.test.ts and remote-login.test.ts).
- **Web slots**: `SlotList({ prefix })` renders every `prefix:<name>` slot (e.g. `sidebar-foot:providers`); `Sheet` is
  the shared modal with scroll memory (Escape and the scrim close the whole modal stack). Shell-level
  `workspace-panel` docks beside `main`; `workspace-terminal` is an optional terminals-plugin surface.
- **send_file** (`plugins/send-file`): owns its native tool, reading through the conversation's
  execution environment and saving immutable private snapshots into the files plugin's download store directory.
  Directory sources and files over 25 MiB fail. The existing authorized `/download` route serves snapshots even
  after source deletion or plugin reload. `test/p2/send-file.test.ts` and the files integration tests cover it.
  The artifacts plugin supplies the shared viewer.
- **Artifacts and viewer** (`plugins/artifacts`): owns its native artifact tool and immutable version
  storage (2 MiB UTF-8). `ArtifactList` reads the conversation's latest-only `ArtifactDoc`, independently of
  transcript paging, compaction and reset; it subscribes before catching up and validates the conversation during
  activation. `/artifact?session=&name=&version=` rechecks authorization for owner/guest, rejects cross-site reads,
  and serves the preview with a CSP sandbox (no same-origin privilege, forms, child frames or objects). Only
  previews receive the diagnostics bridge; `download=1` returns the original source. HEAD describes the same
  representation as GET. The chat-content slot supplies the shared transcript card contexts and explicit-click
  file/artifact viewers; a top-bar counter opens a picker of every version, newest first. The viewer/picker lives in
  named `Route.layers` (Back and sessionStorage restoration); picking an artifact pushes a viewer above its list.
  HTML/SVG use a sandboxed iframe, Markdown/text render safely,
  sent files use the conservative file preview. Nothing opens from a server update. `test/p2/artifacts.test.ts`
  covers fake-provider publication, versions, independent index, reload/restart, CSP, HEAD, guest isolation and
  byte limits; `ui-viewers-search.test.ts` the picker and viewers.
- **Conversations** (`plugins/conversations`): the root-only `conversations` tool lists active roots without
  starting workers, sends server-attributed peer input, and reads the latest completed text answer (bounded scan,
  no thinking, including old history). The tool fixes owner/peer origin at its calling assistant entry: later guest
  input cannot change that grant, and unattributed reports do not inherit older owner access. `Conversations`
  accepts only current worker generations; `PeerConversation` accepts only the parent's `{ kind: "server" }`
  principal. The server brokers the sender's ID/title from the catalog, checks archive around startup/admission
  and receipts, and scopes deduplication to sender + Durable tool task/call. Calls are short and cancellable;
  cancellation after admission does not undo remote work. Final answers never auto-forward. Owner peer labels
  navigate to roots (restoring archives); guests get plain labels. `test/p2/conversations.test.ts` covers list/send/
  answer, authenticated peer replies, restart deduplication, concurrent cross-sends, busy answers, follow-ups,
  invalid destinations, reload, guest/forged attribution, child tool exclusion and inaccessible public ingress.
- **Subagents** (`plugins/subagents`): owns its protocol-independent Durable extension (persistent
  anchor conversations and exactly-once background reporter tasks, model/thinking/tool validation). The worker
  facet (an object of lifetime "host") contributes it to `Extensions` and catches up child metadata after relevant commits, retrying
  acknowledged reports on errors/reload. Server `ChildStore` persists the list in `subagents.sqlite`; worker
  generation fences late reports. Owner `Subagents` readers see every session; guests see only their own. Reading
  the list does not start/hold a worker. The sidebar expands children (latest entry first), with working dots;
  `/s/<id>/c/<conversation>` opens an independent chat, draft and model control. A parent link returns to the root.
  Browser configuration synchronizes the subagent registry via `ConversationConfigured`. Main Stop leaves child
  work running; direct child prompts do not report to the parent. `test/p2/subagents.test.ts` covers bad models,
  configured spawn, one report, answer retrieval, configuration, independent history, reload during child work,
  idle restart, guest reads and sidebar persistence across server restart.
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
- **MCP servers** (`plugins/mcp`, plan `docs/mcp-durable.md`, WP6 and WP7): the server's `McpManager` (local,
  host lifetime) owns every MCP process and connection; workers never spawn one or hold a credential. `<P2_DATA_DIR>/mcp.json`
  is the owner's `mcpServers` (pi-mcp's `validateMcpServerConfig`, plus p2's `shared` and `runOn`; invalid entries are
  skipped and listed in `errors`, `${VAR}` in headers and env values from the p2 host's environment; watched: an edited
  server restarts, a removed one closes; an invalid save keeps the last valid servers, also across a reload). Instances (`placement.ts`): stdio per session and location (key: session,
  location, server, hash of command, args, env, cwd and timeout; roots the location's cwd), `"shared": true` once on
  the host, HTTP shared unless `"shared": false` (one per session); a 401 shows `sign-in` (OAuth is WP8). Stdio
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
  generation's leases; a reload keeps them and the last listed tools (in-memory
  documents of the manager). Unshared instances close with their last lease, shared ones stay while configured. A lost
  connection reconnects with backoff (`RECONNECT`: 1 s doubling to 60 s, reset after a minute up), tools still listed;
  `notifications/tools/list_changed` refreshes them; call errors never carry a server's stderr (the owner's `error`
  does). The worker object (`p2.mcp-worker`) sends `setLocations` with every location its conversations work at (the
  session's, active subagents' own) at start, after moves and subagent commits, and whenever the view re-activates (a
  refusal because a newer generation runs ends it), and
  contributes one Durable extension `mcp` (a `self.writable`, rebuilt only when the tool list changes): deferred tools
  named by `createMcpToolName` (every tool of a colliding name gets the hash suffix, as in pi), results through
  `toLlmContent` and `limitMcpContent`, `structuredOutput` only for tools with an output schema. The worker facet also
  installs `tool_search`. Tests: `mcp.test.ts` (manager and views on a bare host with `test/fixtures/mcp-server.mjs` and
  an HTTP fixture; projects, where sessions work, and an environment through the debug pi-env daemon, skipped without
  it: `npm run build:daemon` in `packages/env`, or `PI_ENV_DAEMON`), `mcp-instances.test.ts` (the supervisor with a
  short backoff), `mcp-leases.test.ts`, `mcp-environments.test.ts`, `mcp-project.test.ts`,
  `mcp-windows-command.test.ts`, `mcp-tools.test.ts`, `mcp-worker.test.ts` (fake provider: a project file, `tool_search`,
  a call, a relocation).
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
  validation is the subagent tool's `resolveChoice`. The plugin contributes the tool unconditionally and does not
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
  one)." `Child.archived` reaches the sidebar (`ChildStore`): archived
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
- **Code mode card** (copied from Pi Mobile, `src/web/transcript.ts`, `Chat.tsx`, `icons.tsx`, `style.css`): the
  `codemode` card shows `<>` Code with the script's first line; its body the script (highlighted JS, clipped to six
  lines with Show all) and the output. `ToolView.calls` is the one source of nested-call rows: live from
  `pi.live.nestedTools` (grouped by the model-issued call, depth from the `parentCallId` chain), settled from the
  result's `details.calls` (Durable's `CodemodeToolDetails`). Rows show status, name, one-line arguments, duration and
  error or last output line; the newest eight while running, collapsed to "N tool calls · k failed" once settled.
  The TUI (`src/tui/messages.ts`) shows the first script line and indented rows (summary once settled, all with
  Ctrl+O) until the TUI port replaces it. `codemode-card.test.ts` covers grouping/depth, the details mapping, the TUI
  and the browser card (fixture `test/fixtures/codemode-card.ts`).
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
