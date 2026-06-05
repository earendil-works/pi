# Satellite MCP Server

Remote file and shell operations over MCP (Model Context Protocol) using HTTP transport.

## Quick Start

```bash
cd extensions/satellite
./build.sh
./start.sh
```

Server runs on port 29001. Health check: `curl http://localhost:29001/health`

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

## Bash Guardrail

The server detects bash commands that should use a dedicated sub-op and returns guidance errors instead of executing them. Patterns intercepted:

- `cat <path>` → suggests `read_file`
- `sed -i ...` → suggests `edit_file`
- `echo/printf > ...` → suggests `write_file`
- `ls|ll|dir ...` → suggests `list_dir`
- `find ...` → suggests `find_files`
- `grep ...` → suggests `grep_files`

Each category has a retry budget of 2 per turn. On the 3rd violation, returns a hard error.

### Path scope (Layer B enforcement)

If the server is started with `SATELLITE_PATH_PATTERN=/TJPROJ\d+`, all file
sub-ops (read/write/edit/list/find/grep/transfer) **and** any path-like
tokens in `bash` commands are validated against the pattern after
`fs.realpath` resolves symlinks. This is the server-side complement to
the client-side `remotePathPattern` in mcp.json (Layer A). Catches:

- Direct out-of-scope reads: `read_file /etc/passwd` → rejected
- Symlink bypass: `ln -s /etc /tmp/x && read_file /tmp/x/passwd` → rejected
- `..` traversal: `read_file /TJPROJ1/../etc/passwd` → rejected
- Path-like args in bash: `cat /etc/passwd` → rejected

Mirror the `remotePathPattern` from mcp.json into the env file on login:

```bash
ssh login 'echo "SATELLITE_PATH_PATTERN=/TJPROJ\\\\d+" >> ~/satellite.env'
ssh login './deploy.sh --restart-only'   # or just rerun deploy
```

If `SATELLITE_PATH_PATTERN` is unset, no enforcement is applied (backward compatible).

### Schema guardrail

If a tool call lands on a known agent schema-confusion shape, the server
returns a guidance error instead of the cryptic MCP SDK message:

- `remote_exec({tool, args: {...}})` (nested `args` wrapper) → flat shape required
- `remote_exec({command})` (missing `tool` field) → discriminator required

Each error includes the WRONG / Correct example and the full sub-op
argument shape list, so the model can self-correct on the next turn.

## Observability

- `GET /health` — JSON status, version, active session count, path pattern
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

## Requirements

- `fd` for `find_files` (install: `apt install fd-find`)
- `rg` for `grep_files` (install: `apt install ripgrep`)
- Bun runtime (for build)
- Node.js compatible HTTP client (MCP transport)
