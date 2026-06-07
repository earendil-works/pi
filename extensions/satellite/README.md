# Satellite MCP Server

Remote file and shell operations over MCP (Model Context Protocol) using HTTP transport.

## Quick Start

```bash
cd extensions/satellite
./build.sh
./start.sh
```

Server runs on port 29001. Health check: `curl http://localhost:29001/health`

## Client Setup: SSH Tunnel

The server runs on the HPC login node, but the MCP client (`pi` or
`opencode`) usually runs on your laptop where the login node's
`29001` is not directly reachable. A local SSH tunnel bridges the
gap: your laptop's `localhost:29001` becomes a forwarder to the
server's `localhost:29001` over SSH.

### One-time setup: systemd user service

Create `~/.config/systemd/user/satellite-tunnel.service`:

```ini
[Unit]
Description=SSH tunnel to HPC login for satellite MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -N -L 29001:localhost:29001 login -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes
Restart=always
RestartSec=5
RestartPreventExitStatus=255

[Install]
WantedBy=default.target
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now satellite-tunnel.service
```

The tunnel auto-starts on login and auto-restarts on crash.
Replace `login` with whatever SSH alias you use for the HPC
login node (must be in `~/.ssh/config`).

### Verify

```bash
systemctl --user status satellite-tunnel.service   # service state
curl -sS http://localhost:29001/health              # server reachable
journalctl --user -u satellite-tunnel.service -f    # live logs
```

### Daily commands

| Task | Command |
|------|---------|
| Check tunnel | `systemctl --user status satellite-tunnel.service` |
| Restart tunnel | `systemctl --user restart satellite-tunnel.service` |
| Stop tunnel | `systemctl --user stop satellite-tunnel.service` |
| Tail logs | `journalctl --user -u satellite-tunnel.service -f` |
| Inspect | `curl -sS http://localhost:29001/metrics` |

### Multiple MCP clients share one tunnel

Both `pi` and `opencode` point to `http://localhost:29001/mcp` and
share the same tunnel — no per-client plugin needed.

- `~/.pi/agent/mcp.json` (for `pi`):
  ```json
  {
    "satellite": {
      "url": "http://localhost:29001/mcp",
      "token": "<your-token>",
      "remotePathPattern": "/TJPROJ\\d+"
    }
  }
  ```
- `~/.config/opencode/opencode.json` (for `opencode`):
  ```json
  {
    "mcp": {
      "satellite": {
        "type": "remote",
        "url": "http://localhost:29001/mcp",
        "headers": { "Authorization": "Bearer <your-token>" }
      }
    }
  }
  ```

### Troubleshooting

- **"Connection refused" on `localhost:29001`** — tunnel not up.
  Check `systemctl --user status` and `journalctl --user -u
  satellite-tunnel.service -n 50`.
- **Tunnel keeps restarting** — likely SSH auth failure. Verify
  `ssh login` works in an interactive shell.
- **Direct port (e.g. `10.1.x.x:29001`) is unreachable** — by
  design. HPC internal IPs are not routable from outside; the
  tunnel is the only path.

## MCP Configuration

In `~/.pi/agent/mcp.json`:

```json
{
  "satellite": {
    "url": "http://localhost:29001/mcp",
    "token": "<your-token>",
    "remotePathPattern": "/TJPROJ\\d+"
  }
}
```

### remotePathPattern

Optional. Regex pattern (POSIX extended). When set, the agent's system prompt is augmented with:

> Files matching pattern `<pattern>` are on the remote HPC server. Use `satellite_remote_exec` for all file operations on these paths.

This is a **soft guardrail** — it guides the model but does not block local tool use.

Example: `/TJPROJ\\d+` matches `/TJPROJ1/`, `/TJPROJ2/data/`, etc.

## Sub-Operations

The `remote_exec` tool is a discriminated union of 8 sub-operations:

| Sub-op | Purpose | Prefer over |
|--------|---------|-------------|
| `read_file` | Read file contents with offset/limit | `bash(cat ...)` |
| `write_file` | Create/overwrite file | `bash(echo > ...)` |
| `edit_file` | Apply text edits with fuzzy matching | `bash(sed -i ...)` |
| `list_dir` | List directory entries | `bash(ls ...)` |
| `bash` | Execute shell command (use sparingly) | n/a |
| `find_files` | Search files by glob (uses `fd`) | `bash(find ...)` |
| `grep_files` | Search file contents (uses `rg`) | `bash(grep ...)` |
| `transfer_file` | Move file between local/remote | n/a |

## Architecture: server = execute, client = guard

The satellite server is a **pure executor**. All guardrails (path scope,
intent substitution, schema pre-checks) live on the client side
(`extensions/personal-assistant/tools.ts`). The server only:

- Canonicalizes paths via `fs.realpath` (pure mechanics)
- Rejects paths whose realpath still contains `/..` segments (1-line
  safety net, no config)
- Truncates bash output via `OutputAccumulator` (50KB / 2000 lines)
- Scrubs secrets in logs (PEM, `id_*`, `Bearer …`, `KEY=VAL`)
- Exposes `/health`, `/metrics`, session TTL, log rotation

Why: a blocked tool call costs **zero network round-trips** when
intercepted on the client (the agent sees the `{block, reason}` and
self-corrects immediately). The server returning a guidance error over
MCP is one wasted call per mistake.

## Sub-operations

The `remote_exec` tool is a discriminated union of 8 sub-operations. The
tool description is intentionally short — a 141-word "mode library" that
shows the common tasks; exact field shapes come from the JSON schema.

| Sub-op | Purpose | Prefer over |
|--------|---------|-------------|
| `read_file` | Read file contents with offset/limit | `bash(cat ...)` |
| `write_file` | Create/overwrite file | `bash(echo > ...)` |
| `edit_file` | Apply text edits with fuzzy matching | `bash(sed -i ...)` |
| `list_dir` | List directory entries | `bash(ls ...)` |
| `bash` | Execute shell command (use sparingly) | n/a |
| `find_files` | Search files by glob (uses `fd`) | `bash(find ...)` |
| `grep_files` | Search file contents (uses `rg`) | `bash(grep ...)` |
| `transfer_file` | Move file between local/remote | n/a |

### transfer_file directions

Two clear direction names — no ambiguous "upload/download" from
whose perspective:

```jsonc
// server → agent: server reads remote_path, returns content.
// agent saves to local_path LOCALLY (on its own machine).
{ "tool": "transfer_file", "direction": "remote_to_local",
  "remote_path": "/hpc/file.txt", "local_path": "/tmp/file.txt" }

// agent → server: agent's MCP client reads local file and pushes
// via the HTTP /transfer?path=... endpoint to keep file bytes
// out of LLM context. Falls back to "content" field for small
// strings, but for big files prefer the HTTP path.
{ "tool": "transfer_file", "direction": "local_to_remote",
  "local_path": "/tmp/big.sh", "remote_path": "/hpc/big.sh" }
```

For `local_to_remote` of a large file: use the HTTP endpoint directly
to avoid burning LLM context on the file bytes:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
     --data-binary @/tmp/big.sh \
     "http://localhost:29001/transfer?path=/hpc/big.sh"
```

## Client-side guardrails (in `extensions/personal-assistant`)

The `tool_call` extension hook is the choke point. It fires before any
tool runs and can block with `{block: true, reason: "..."}`. Personal-
assistant registers three guards:

1. **Schema shape** — catches the "nested `args` wrapper" and "missing
   `tool` field" mistakes before they reach MCP.
2. **Path scope** — reads `mcp.json`'s `remotePathPattern` and rejects
   any path-arg outside that scope (using `realpathSync` to catch
   symlink bypass and `..` traversal).
3. **Bash intent** — detects `bash(cat|ls|find|grep|sed -i|echo>)` and
   suggests the dedicated sub-op, with a per-turn budget of 2 guidance
   errors then a hard block (mirrors the old server behavior, moved
   client-side for speed).

All 18 unit tests live in
`extensions/personal-assistant/test/satellite-guards.test.ts`.

## Observability

- `GET /health` — JSON `{ status, version, sessions }`
- `GET /metrics` — Prometheus text format: per-tool counters, recent
  latency (rolling avg of last 200 calls), uptime, active sessions
- `/tmp/satellite.log` — log file with per-session correlation
  (`session=<id8>` prefix) and secret scrubbing (PEM, .ssh/id_*,
  `Bearer …`, `KEY=VAL`, `password=…` / `token=…` assignments).
  Auto-rotates past 50 MB.

## Deployment to HPC

`./deploy.sh` builds, uploads, and restarts the server on the remote HPC login node (default: `login`, port `29001`).

### One-time setup: capture the HPC env

The server runs as a `nohup`'d process, so it does not source your shell rc files. To make `python3`, `module load`, conda envs, etc. available to bash sub-ops, capture your interactive login env once:

```bash
ssh login
env -0 > ~/satellite.env   # MUST use -0: NUL separators preserve
                           # multi-line BASH_FUNC_*() entries
exit
```

Re-run this whenever you change modules, switch conda envs, or update `PATH` on the login node, then redeploy.

### Deploy commands

```bash
./deploy.sh                  # full cycle: build + scp + restart
./deploy.sh --restart-only   # skip build + scp, just restart the existing
                             # binary (use after editing deploy.sh or after
                             # updating ~/satellite.env on the remote)
./deploy.sh --rollback       # restore ~/satellite-server.prev (auto-saved
                             # on each deploy), then restart
```

The deploy script:

1. Builds `satellite-server` binary locally (skipped with `--restart-only`).
2. Backs up the existing remote binary to `~/satellite-server.prev` for rollback.
3. `scp`'s the binary to `/tmp` on the remote, then `rm` + `mv` into `~/satellite-server`. The HPC filesystem blocks in-place overwrites, hence the rm-then-mv dance.
4. Kills all old `satellite-server` processes (including any `xargs` wrappers from prior failed deploys).
5. Launches the binary inside a subshell that sources `~/satellite.env`, then `exec`s the binary via `env SATELLITE_TOKEN=... SATELLITE_PORT=...`. The subshell is replaced by the binary, so the process tree stays clean.

### Troubleshooting

- **Health check fails after deploy** — check `/tmp/satellite-stdout.log` on the remote for the server's stderr.
- **bash sub-op can't find `python3` / `modulecmd`** — re-dump `~/satellite.env` from an interactive session, then `./deploy.sh --restart-only`.
- **`module` function not available in `bash` sub-op** — expected. `bash -c` does not decode `BASH_FUNC_*` env vars. Capture already-loaded paths instead (your interactive `module load` will have updated `PATH` in `~/satellite.env`).
- **scp fails with "dest open ... Failure"** — home filesystem is full. The deploy already uploads to `/tmp` first, so this should be rare. Free up space with `ssh login 'du -sh ~/* | sort -h | tail'`.
- **Old `xargs`/`satellite-server` processes lingering** — the new kill loop handles this, but if pids leak, run `ssh login 'pkill -9 -f satellite-server; sleep 2'` manually.
- **Agent keeps calling `bash(cat ...)` even after warnings** — the per-turn budget for the bash-intent guard is 2 guidance errors, then a hard block on the 3rd. The block clears at `turn_end`. If the budget is the issue, it resets each turn.

## Requirements

- `fd` for `find_files` (install: `apt install fd-find`)
- `rg` for `grep_files` (install: `apt install ripgrep`)
- Bun runtime (for build)
- Node.js compatible HTTP client (MCP transport)
