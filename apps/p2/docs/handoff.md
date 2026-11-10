# p2 handoff

For whoever continues p2, human or agent, starting cold. It assumes you know pi and this repository, but not the
history of p2. Everything you need is in the repository; nothing depends on earlier conversations.

## What p2 is

p2 (`apps/p2`) is Pi Mobile rebuilt on **Chord**, an object runtime (Chord v2: `@earendil-works/chord`,
`packages/chord`; p2 runs on Chord v2 only, see `docs/p2-notes.md` **Chord v2**; Chord v1 is deleted).
Every feature is a plugin (`apps/p2/plugins/*`) with facets per process: `server.ts`, `worker.ts` (one worker per
session, running Durable), `web.tsx` and `tui.ts`. There is no manifest and no dependency list: p2 discovers plugins
by listing their facet files and loads them alphabetically. Chord resolves dependencies by contract name, so their
order does not matter; a missing provider fails loudly, naming the consumer. Compatible backend reloads preserve
unchanged state and resources; a successful reload publishes rebuilt web and TUI bundles.

p2 replaced Pi Mobile (formerly `apps/mobile`, removed; see git history). Its web UI matches Pi Mobile's (same DOM,
classes, styles); the data layer is Chord objects instead of Pi Mobile's hand-written protocol. On top of Pi Mobile,
p2 has hot reload with explicit reload/restart controls, logs and owner notices, chat mode with replies and `@pi`
mentions, owner sign-in links, an isolated TUI with pi's look and keys, and security hardening (CSP, restricted guest
web assets, WebSocket limits).

p2 lives in `earendil-works/pi` at `apps/p2` and keeps the name p2.

## State at handoff

| Where | What | Port | Data |
| --- | --- | --- | --- |
| Phone (Termux, Node 26) | p2, the daily driver; Pi Mobile's sessions were imported when it replaced Pi Mobile | 8787 | `~/.pi/p2` |
| slayer (`slayer.marioslab.io`) | p2 in dev mode, public at https://p2.mariozechner.at | 8788 | `~/.pi/p2` (test data) |

Done: everything Pi Mobile did (checked by a four-part audit; what differs on purpose is under Decisions in
`docs/p2-notes.md`), the switch of the phone, the TUI port phases P0–P7 and P9–P11, and Chord in `packages/chord`
replacing the old facet/service runtime and the `pi-client`, `pi-protocol` and `pi-server` packages (pi
`6db4070f1`). Open items are under [Open work](#open-work).

## The phone

- **Checkout:** `~/pi-private`, branch `private`. Old data: `~/.pi/mobile` (keep it: imported history refers to
  attachments there), `~/.pi/p2.parallel` and `~/.pi/p2.trial-oct10` (leftovers, deletable).
- **p2** runs in tmux session `p2` from `~/pi-private/apps/p2` (as planned for the switch; confirm with `tmux ls`
  and `ps`):
  ```sh
  PORT=8787 P2_ALLOWED_HOSTS=pim.ngrok.pro P2_PUBLIC_URL=https://pim.ngrok.pro npm run dev
  ```
  Update: `git pull`, `npm install --ignore-scripts` at the root if dependencies changed, then **Restart** in the app or
  `npm run reload -- --restart` (plugin changes: **Reload**).
- **Per-host stores:** a p2 with per-host stores refuses a data directory in the older layout. Once: stop p2,
  `npm run migrate-data -- --dry-run`, then `npm run migrate-data` (old files go to `~/.pi/p2/pre-files-backup/`;
  `scripts/data-report.ts` before and `--compare` after), then start it (`docs/p2-notes.md`, Migration).
- **Tunnel:** ngrok as a termux-services (runit) service, `$PREFIX/var/service/ngrok/run`, forwarding
  `https://pim.ngrok.pro` to port 8787 (`sv status|restart $PREFIX/var/service/ngrok`; logs in
  `$PREFIX/var/log/ngrok/current`).
- **Radius:** not configured (no `radius.json`); `npm run radius:login` enables it.
- **No boot scripts.** Run `termux-wake-lock` so Android keeps the processes alive.

## Running p2

```sh
cd apps/p2
npm run dev                  # dev mode: apply plugin changes, including web facets, with Reload or `npm run reload`
npm start                    # without the dev supervisor
P2_FAKE=1 npm start          # fake model, no provider needed
npm run owner-link [url]     # one-time owner sign-in link for another device (run on the machine itself)
npm run tui [url]            # TUI (Node >= 26.5.1); on loopback it signs in with the data directory's owner key
npm run reload [plugins] [--restart]
npm run check                # Biome + tsc
npm test                     # full suite; TUI tests need Node 26, browser tests need CHROMIUM_BIN
```

Environment variables: `docs/p2-notes.md` (Running). Configuration in the data dir: `models.json`, `settings.json`
(incl. `codemode`, default on in p2), `envs.json`, `projects.json`, `mcp.json`, `auth.json`, `radius.json`, `forwards.json`.

**Sign-in.** Loopback alone is nobody (shared machines). A browser on the host signs in once per profile with the
token the server prints at startup (pasted into the sign-in page); the TUI and scripts sign in with the data directory's owner key (README, Signing
in on this machine). Other devices get owner rights with a link from `npm run owner-link` (single use, 10 minutes,
long-lived signed cookie). Guests join through share links. Requests other
websites make never carry owner rights. Sign out per device or all devices in the Devices sheet.

**Dev mode.** A file watcher only marks plugins dirty; reloads are explicit (button, `npm run reload`, the
owner-only `reload_plugins` tool) because a watcher can't tell when an agent has finished a multi-file edit.
Runtime code (`src/hosts`, `src/runtime`, workspace packages such as `packages/chord`) needs a restart; the "Server
code changed" pill appears only when a module the server actually loaded changed.

**slayer.** `~/p2.mariozechner.at/` holds `run.sh` (starts `npm run dev` from the deploy worktree `~/p2-live`),
`deploy.sh` (moves `~/p2-live` to `origin/private` and restarts), `bridge.mjs` (unix socket for Caddy →
127.0.0.1:8788), `Caddyfile` and `docker-compose.yml` (Caddy only marks requests as proxied; p2 authenticates on its
own). It runs in tmux session `p2`. Development happens in `~/pi-private`; `~/p2-verify` is a scratch worktree for
verifying an agent's files on their own before committing. Node 24: `~/node-v24.4.1-linux-x64/bin`; Node 26 (TUI):
`~/.local/bin/node26`. Browser tests: `CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker`.

## Architecture in five minutes

- **Chord v2** (`packages/chord`, `docs/design.md` there): objects per (type, params, principal) placed on host kinds
  (`Server`, `Session({ id })`), JSON Schema contracts, held references, documents (`defineState`) and derives,
  natives (`self.open`), keyed registries, binary links over WebSocket and IPC with routes (browser → server →
  worker), the workers component (`createWorkers`) and the plugins component (`createPlugins`: build, load,
  rollout). How p2 uses it: `docs/p2-notes.md` **Chord v2**.
- **Hosts** (`src/hosts`): `server.ts` (HTTP, auth, WebSocket admission), `web.ts` (web serving), `bundles.ts`
  (content-named web and TUI esbuild bundles), `worker.ts` (session worker),
  `tui*.ts` (launcher, sandbox, filter, grants), `dev*.ts` (dev supervisor).
- **Runtime** (`src/runtime`): shared contracts and helpers (principals, worker and Harness, Durable registry,
  extension switches, input entries, settings, logs, fetch).
- **Plugins**: chat, chat-mode, sessions, familiar (the session above the others), subagents, agent (one-shot agents),
  codemode, cache-warming, coding-tools, prompt, models, login, search, status, drafts, files, send-file, artifacts,
  workspace, file-index, terminals, envs, mcp, ports, radius, sharing, devices, settings, proxy-marker, logs, dev-tools,
  powershell, web-shell, projects, views. Before writing one, read Chord's
  tutorial (`packages/chord/docs/tutorial/`) and plugin guide (`packages/chord/docs/plugin-authoring.md`), then an
  existing p2 plugin of the same shape.
- **Locations:** every conversation works at `{ env, cwd }`: the main one at the session's, subagents spawned with a
  cwd at their own (on the caller's environment), the others following the session. A session's location changes in
  place: relocating an idle running worker fences it, updates the catalog and moves the main conversation and its
  followers without a restart; subagents with their own location stay. Plugins resolve a conversation's location
  and environment through `Harness.environments`, the session's through `WorkerProcess.location`
  (`docs/p2-notes.md`, Agent locations and Relocation).
- **Durable** (`packages/durable`) runs the agent: conversations, inputs as custom entries (`p2.input`,
  `chat.mention`), display-only writes placed immediately, code mode (QuickJS sandbox; scripts call tools as
  `tools.<name>`, one-shot agents via `tools.agent`), compaction with visible failures, deferred tools and
  `tool_search` (MCP tools are for code mode scripts, as in pi; `tool_search` loads them only while code mode is off).

## The TUI

`npm run tui [url]` (Node ≥ 26.5.1). The launcher owns the terminal, the connection and sign-in; all TUI code (pi-tui
and plugin facets) comes from the server as one bundle and runs in a worker that drops every Node permission first.
Output passes a strict escape-sequence allowlist; privileged actions (copy, open URL, download, external editor,
attach, saving preferences, sign-out) need launcher grants, mostly with a launcher-drawn consent screen. Preferences
(keybindings, theme, display settings) are the visitor's own (`~/.pi/agent`, `~/.pi/p2-tui/prefs.json`). Threat
model: `DEV.md` and `README.md` (TUI isolation). Design and as-built notes: `docs/p2-tui-port.md`.

## Rules

From `AGENTS.md` and this project's history:

- **One tree.** p2, the packages, root config and scripts change together in `earendil-works/pi`. After p2 changes
  run `npm run check` both at the root and in `apps/p2`.
- **Commit only verified states.** When several agents edit one tree, copy an agent's files into a separate worktree
  on top of `HEAD`, run `npm run check` and the full `npm test` there, and commit exactly that content
  (`git hash-object -w` and `git update-index`). A browser test that times out under load and passes on its own is
  acceptable; anything else is not. Lockfile commits need `PI_ALLOW_LOCKFILE_CHANGE=1`; npm 11 strips `libc` fields,
  revert that noise. Never `--no-verify`.
- **Deploy only pushed commits** (`~/p2.mariozechner.at/deploy.sh` on slayer).
- **Port from the diff.** Changes copied from elsewhere start from the commit (`git show <hash>`), never from a
  summary; briefs to agents name the commit and the files.
- **No hand tests on real sessions.** Use throwaway sessions under `/tmp`, or a separate server on another port with
  a temporary data dir. Never print cookies, tokens or share links.
- **Check `pwd`** before working in a subagent, and spawn subagents with an explicit `cwd`.
- **`pkill -f` matches its own command line.** Kill by PID or by `/proc/<pid>/cwd` instead (it once killed the live
  tmux session).
- TypeScript: no `any`, erasable syntax only, top-level imports only (except the plugin loader's dynamic import).
  Use Opus-class models for documentation and tutorials.

## Open work

1. **The phone's daemon binary:** p2's file index uses the pi-env daemon's `listFiles` when the packaged daemon has
   it, else the old git/walk index. slayer has a fresh build in `packages/env/bin/pi-env-linux-x64` (static musl;
   built with `RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" cargo build --release --locked --target
   x86_64-unknown-linux-musl` in `packages/env/daemon`). On the phone: `cargo build --release --locked` there and copy
   it to `packages/env/bin/pi-env-android-arm64/pi-env`. The next pi-env release ships all targets through CI.
2. **TUI:** launcher images, a filtered terminal relay, a "trust like SSH" mode, web tool cards
   (`docs/p2-tui-port.md` §10). Fork from subagent conversations; fork/clone, shell and templates have no web UI yet
   beyond rendering.
3. **Cleanup leftovers:** two HTTP helpers were not merged because their semantics differ (byte ranges: files
   serves `bytes=-` whole, workspace answers 416; body readers: sharing answers 400 past the limit, devices 413);
   decide one behavior each.
4. **MCP:** `plugins/mcp` (WP6-8 of `docs/mcp-durable.md`: owner `mcp.json`, host stdio and HTTP, code mode
   tools (`tool_search` without code mode), servers on environments, project `.pi/mcp.json`, OAuth sign-in); code mode
   namespaces (WP9) are open, and whether Radius sends its cookie on a sign-in's redirect back is unverified.
5. **npm:** deprecate `@earendil-works/pi-client`, `pi-protocol` and `pi-server` (1.1.0), which no longer exist.
6. `docs/p2-notes.md` TODO: the TypeScript 5.9.3 pin (Termux), an isolating plugin loader, sandboxing third-party
   facets.
7. **Slow test suite:** about 11 minutes serially; files could run in parallel once their isolation is fixed. The
   chat-mode long-press reply browser test times out under load.
8. **After the Chord v2 port:** the TUI on Chord's sandbox (C2); no per-link call limit any more (owner decision;
   Chord v2 has none). Chord v1 and the old-page shim are deleted (C1).

## Documents

| File | Content |
| --- | --- |
| `README.md`, `DEV.md` | running, deployment behind a proxy, TUI sign-in and isolation |
| `docs/p2-notes.md` | decisions, configuration, plugin-by-plugin notes |
| `docs/p2-tui-port.md` | TUI design, as-built notes, open phases |
| `docs/optimistic-ui.md` | optimistic UI: the pattern for actions, pending states and loads (web and terminal) |
| `docs/tool-ui.md` | how a plugin shows its tool (web and TUI registrations), with a complete example plugin |
| `docs/workflows.md` | code mode workflows with one-shot agents |
| `docs/tree.md` | `/tree`: branches of the main conversation as Durable forks |
| `docs/views.md` | views beside the transcript (Markdown, changes, custom HTML views), layouts, annotations, saved views |
| `docs/remote-envs.md` | SSH environments |
| `packages/chord/docs/` | Chord v2's design, slices and guides; `tutorial/` for writing plugins |
