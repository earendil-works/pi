# Orchestra — self-supervising multi-agent layer for Pi

How it works, how to run it. See `docs/RECON.md` for the recon and `docs/DEVIATIONS.md` for deviations from `architecture.md`.

## Architecture (native)

```
human ── orchestra CLI ──► supervisor daemon (Node, sole writer, SQLite WAL)
                              │
                              ├─ HTTP 127.0.0.1 (extension-tool transport)
                              ├─ RPC stdio JSONL ◄► pi --mode rpc (per agent, git worktree cwd)
                              └─ MCP stdio ◄► shotd (1 Chromium, N contexts, CDP)
                                  ▲
                                  │ -e orchestra-agent-ext/dist/index.js + identity via
                                  │   --append-system-prompt (temp) + env ORCHESTRA_*
                                  │
                              agent-ext: tool_call guard + send_message/read_inbox/reply/spawn
```

Packages (no core edits):
- `packages/orchestra-core` — types, ULID, schema/migrations (node:sqlite), IPC DTOs, fake `StreamFn`, ports, stall signature.
- `packages/orchestra-supervisor` — daemon, `Store`, `RpcAgentRunner` (spawn pi RPC) + `InMemoryAgentRunner` (Agent + fake provider), reconciler, goal engine, proxy-me.
- `packages/orchestra-agent-ext` — Pi extension (identity, `tool_call` lease guard, tools). Loaded with `-e <dist>`.
- `packages/orchestra-cli` — `orchestra up|status` (bin `orchestra`).
- `packages/shotd` — MCP stdio server (`shot`, `zoom`, `dom_metrics`, `baseline_save`, `baseline_diff`), CDP browser, WebP via sharp.

Agent events flow: Pi `AgentSessionEvent` (via `toJsonEvent`) → supervisor `Store.addEvent` + heartbeat + budget counting (`turn_end` → turns, `message_end` usage → tokens). Control: supervisor `prompt/steer/follow_up/abort` over RPC stdin. Delivery: `steer` at safe points (Agent queue drains between tool calls); redelivery from `deliveries(queued)` each reconcile tick; receivers dedupe by message ID so at-least-once is safe.

Ownership: `tool_call` for `edit/write` asks `POST /can-edit`; supervisor enforces `owns_globs` + live leases, blocks with owner name + task + "message them with send_message". Reads always allowed. Commits carry agent ID (branch `agent/<name>`).

Goals: `checks(cmd|screenshot_diff|dom_assert)` run by supervisor in the agent worktree (agent cannot influence runner). All required pass → `done`; else failure report re-prompted via `prompt`, `attempts++`, `signature = sha256(check_id + normalize(output))`, same signature ×3 (`stallN=3` default) → `escalated`.

## Run

```bash
# build new pkgs (and deps if needed)
npm run build

# supervisor
ORCHESTRA_DB=.orchestra/orchestra.db node packages/orchestra-cli/dist/cli.js up

# status (second terminal)
ORCHESTRA_DB=.orchestra/orchestra.db node packages/orchestra-cli/dist/cli.js status

# spawn an agent (worktree + port + session + identity injected)
curl -s -X POST http://127.0.0.1:7788/spawn -H 'content-type: application/json' \
  -d '{"name":"ada","role":"builder","taskSpec":"implement /items","ownsGlobs":["src/api/**"]}'

# agent runs:
# node packages/coding-agent/dist/bundle/cli.js --mode rpc --session <sessionFile> --session-dir <dir> \
#   -e /abs/path/packages/orchestra-agent-ext/dist/index.js --append-system-prompt <identity file>
#   env ORCHESTRA_AGENT_ID=... ORCHESTRA_AGENT_NAME=ada ORCHESTRA_AGENT_ROLE=builder \
#   ORCHESTRA_SUPERVISOR_URL=http://127.0.0.1:7788
```

`shotd` (MCP): add to `mcp.json` (global or `.pi/mcp.json`):
```json
{ "shotd": { "command": "node", "args": ["/abs/path/packages/shotd/dist/server.js"], "exposure": "direct" } }
```
Or run manually: `SHOTD_DIR=.shotd node packages/shotd/dist/server.js`. Tools called as `mcp__shotd__shot` etc. Set `CHROMIUM_BIN` when Chrome is not on default paths.

Fake provider tests (no spend): supervisor tests use `InMemoryAgentRunner` + `FakeProvider` (scripted `StreamFn`). Real-provider smoke is manual only.

## Files

- DB: `ORCHESTRA_DB` (SQLite WAL). Shots/baselines: `SHOTD_DIR` (default `.shotd/`).
- Sessions: Pi session JSONL under `--session-dir` (default `~/.pi/agent/sessions/...` per cwd).
- Worktrees: `git worktree add <dir> -b agent/<name>` (supervisor via `execFile`).
