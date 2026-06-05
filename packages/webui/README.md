# @earendil-works/pi-webui

Web-based UI for pi, powered by a Node.js WebSocket server and a Vite/React frontend.

## Quick reference

| | Production | Development |
| --- | --- | --- |
| Runs as | `pi --web` (system install) | `tsx server/index.ts` from this package |
| URL | `http://127.0.0.1:8741` | `http://127.0.0.1:8742` (or any free port) |
| Frontend | pre-built by `npm run build` | live, with Vite HMR |
| Restart after server edit | `npm run restart:web` (from `coding-agent`) | Ctrl-C + rerun |
| Restart after web edit | `npm run restart:web` | automatic (HMR) |
| Edit-and-ship everything | `npm run webui:update` (from `coding-agent`) | — |

The dev and prod instances are independent processes on different ports. The dev instance has full HMR for `web/` source; prod is whatever bundle was last installed.

## Architecture

- `server/` — Node.js HTTP + WebSocket server (session pool, LLM client, memory store, cron watcher)
- `web/` — Vite SPA frontend (React + Tailwind)
- `scripts/dev-webui.sh` — dev launcher (cwd switch + env injection)

The server is a single process that owns the HTTP routes, the WebSocket transport, the session pool, and (in dev) the Vite dev server as express middleware. The frontend is a static SPA built by Vite and served from `web/dist/` in production, or from Vite in dev.

## Manual End-to-End Test

This verifies the full stack: server, WebSocket transport, session management, streaming responses, and persistence.

1. **Start the server** — `pi --web`. Binds to `localhost:8741` by default. Use `pi --web --port <n>` to override.
2. **Open the browser** — `http://localhost:8741`. UI loads without console errors.
3. **Create a session** — click *New Session*. A session ID appears.
4. **Send a prompt** — type a prompt and submit. It appears in history immediately.
5. **Verify the stream** — response streams token-by-token, UI stays responsive, completes without errors.
6. **Delete the session** — select it, click *Delete*. UI reflects empty state.
7. **Check memory.db for atoms** — `sqlite3 memory.db "SELECT COUNT(*) FROM atoms;"` returns > 0.

## Development

A dev instance can run side-by-side with the production webui without touching it. Frontend edits hot-reload via Vite HMR; server edits need a manual restart.

### One command

```bash
cd ~/.pi/agent
PI_WEB_PORT=8742 npm --prefix /home/qjh/workspace/personal/pi/packages/webui run dev:webui
```

This starts a dev webui on `http://127.0.0.1:8742` with:

- cwd `~/.pi/agent` — pi subprocesses land in the user's project tree
- port `8742` — does **not** conflict with the production webui on 8741
- `PI_WEB_DEV=1` — vite HMR is attached, React source edits hot-reload
- Ctrl-C — tears the whole process group down

Open `http://127.0.0.1:8742` in a browser. The production webui at `:8741` keeps running untouched.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_CWD` | `$HOME/.pi/agent` | cwd for the dev process (pi subprocesses use it) |
| `PI_WEB_PORT` | `8742` | HTTP/WS port |
| `PI_WEB_DEV` | `1` | Set to `0` to run the dev script with the prod path (no HMR) |

`PI_WEB_CWD` must be a directory that already contains session files. To dev against a different project tree, set it to that project root:

```bash
cd /path/to/some/project
PI_WEB_CWD="$PWD" PI_WEB_PORT=8742 \
  npm --prefix /home/qjh/workspace/personal/pi/packages/webui run dev:webui
```

### What's the same, what's different

| Component | Production | Dev |
| --- | --- | --- |
| Port | 8741 | 8742 (override `PI_WEB_PORT`) |
| HTTP routes (`/api/*`) | yes | yes (identical code) |
| WebSocket (`/ws`) | yes | yes (identical code) |
| Session pool / pi spawn | yes | yes (identical code, same global `pi` bin) |
| Static asset serving | `express.static(dist/)` | `vite.middlewares` (HMR) |
| HMR WebSocket | n/a | same httpServer, path `/__vite_hmr` |

The dev instance is structurally identical to production — the only swapped piece is the static-asset middleware. There is no proxy layer, no second port, no port-forward dance.

### What dev does not touch

- The production webui process bound to 8741 and its bundle
- TUI pi processes owned by `pi --tui` runs
- Any session JSONL files — both instances read/write the same directory but each session is keyed by a unique UUID, so the two never collide

### Why one port, not two

A two-port setup (vite on 5173 + express on 8742, with vite proxying `/api` and `/ws`) was considered and rejected. The single-port design mirrors production: same URL shape, same process, same `lsof` output. The only thing the upgrade handler in `server/ws/handler.ts` adds is a path reservation for vite's `/__vite_hmr` — it does not destroy the socket, so vite's own listener can respond.

## Update production

Two things change a live webui: the bundle on disk, and the running process. The bundle is loaded into memory at startup, so a code edit does not show up until the process restarts.

### One command (recommended)

From `packages/coding-agent`:

```bash
npm run webui:update
```

This runs, in order:

1. `npm run build` in `packages/webui` — vite build (frontend) + esbuild (server bundle)
2. `npm run build` in `packages/coding-agent` — copies the webui artifacts into `dist/webui/`
3. `npm install -g .` in `packages/coding-agent` — symlinks the global install to this checkout so the next `pi --web` spawn picks up the new bundle
4. `npm run restart:web` — SIGTERMs the running production webui and spawns a new `pi --web` detached, logging to `/tmp/prod-webui.log`

A no-op if the production webui is not running — the install and build still run, but `restart:web` just starts a fresh one.

### Frontend-only edits

If the change is entirely under `web/` and you have a dev instance running, you do not need to deploy — Vite HMR pushes the new React code to the dev instance's browser. The dev instance is independent of the production one (different port), so prod keeps showing the old bundle until you run `npm run webui:update`.

### Server-only edits

If the change is entirely under `server/`, you can:

- **Iterate on the dev instance:** Ctrl-C, rerun `npm run dev:webui` (the dev script runs `tsx`, not `tsx watch`, by design — see "Common gotchas" below).
- **Ship to production:** run `npm run webui:update` (or `npm run restart:web` if you've already run `npm run build` once).

### Restart only (bundle already built)

If you ran `npm run build` in `packages/coding-agent` manually and just want to bounce the running process:

```bash
cd packages/coding-agent
npm run restart:web
```

### Verify

```bash
curl -s http://127.0.0.1:8741/api/health
# {"ok":true,"version":"0.1.0","uptime":<seconds>,"sessions":<count>}

curl -s http://127.0.0.1:8741/ | grep -oE 'index-[A-Za-z0-9_-]*\.js'
# the JS asset hash should match the one in packages/webui/web/dist/assets/
```

## Common gotchas

### `pi --web` is the only way to start prod

`node dist/webui/server.bundle.js` does **not** work when the global install is a symlink to this checkout. The bundle's self-exec check is `import.meta.url === "file://" + process.argv[1]`, which fails when `argv[1]` is the symlink path but `import.meta.url` is the resolved real path. `pi --web` works because the CLI spawns the bundle with the resolved path.

If you see the bundle exit silently with no error and no port bound, you're starting it wrong. Use `pi --web` (or the `restart:web` script).

### `npm install -g .` makes the install a symlink

`npm install -g .` from a local path creates a symlink at `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent` pointing to this checkout. Edits to `dist/` show up immediately on the next restart — no reinstall needed. If you want a frozen copy instead (e.g. for a release tarball), use `npm install -g <tarball>` rather than `npm install -g .`.

### The dev script does not auto-restart

`scripts/dev-webui.sh` runs `tsx` (not `tsx watch`) by design. Vite touches `web/vite.config.ts.timestamp-*.mjs` on startup, which `tsx watch`'s chokidar would treat as a code edit and loop on. The cost is that server edits need Ctrl-C + rerun; the dev iteration loop is mostly on `web/` source, which gets full HMR without restart.

### Vite HMR + `script-src` CSP

In dev mode, Vite injects a small inline `<script type="module">` preamble for React Refresh. The production CSP `script-src 'self'` blocks it. The dev server middleware loosens `script-src` to `'self' 'unsafe-inline'` so the preamble loads. This only affects the dev instance on 8742; the production instance on 8741 keeps the strict CSP.
