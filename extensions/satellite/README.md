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

### Why not just `ssh -L` in a one-liner?

A bare `ssh -N -L ...` service fails badly in three situations:

1. **Network change** (home → office wifi swap) — the persistent
   SSH connection dies, systemd's default `StartLimitBurst=5/10s`
   gives up after 5 fast restarts, service gets stuck in `failed`.
2. **Long outage** (vacation, plane) — naive `while true; sleep 15`
   hammers sshd with 5760 failed attempts over 24h, triggers the
   HPC's internal brute-force monitor.
3. **Auth misconfiguration** (e.g. wrong username after a
   `~/.ssh/config` change) — silent fallbacks retry the wrong
   credential and produce false-positive brute-force alerts.

The shipped `scripts/satellite-tunnel.sh` handles all three:
TCP-probes with exponential backoff (60s → 15min cap), 3-strike
auth-fail throttle (30min sleep), and greppable `[USER_RESOLVE]`
/ `[AUTH_FAIL]` / `[PROBE_FAIL]` log tags for any anomaly.

### One-time setup

**1. Install the script** (canonical copy lives in this repo):

```bash
cp extensions/satellite/scripts/satellite-tunnel.sh ~/.local/bin/
chmod +x ~/.local/bin/satellite-tunnel.sh
```

**2. Create the systemd service** at `~/.config/systemd/user/satellite-tunnel.service`:

```ini
[Unit]
Description=SSH tunnel to HPC login for satellite MCP (probe + backoff)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/<you>/.local/bin/satellite-tunnel.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Replace `/home/<you>/.local/bin/satellite-tunnel.sh` with the
absolute path to the script.

**3. Enable and start:**

```bash
systemctl --user daemon-reload
systemctl --user enable --now satellite-tunnel.service
```

The tunnel auto-starts on login and auto-recovers from network
outages. The script's `~/.ssh/config` must have a `Host login`
entry with `HostName` and `User` (the script uses `ssh -G login`
to resolve both — if either is missing, it logs a `[USER_RESOLVE]`
warning instead of silently guessing).

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
| Search for auth issues | `journalctl --user -u satellite-tunnel.service \| grep AUTH_FAIL` |
| Inspect | `curl -sS http://localhost:29001/metrics` |

### Log tag reference

| Tag | Meaning | When it fires |
|-----|---------|---------------|
| `[USER_RESOLVE]` | SSH alias / user resolution fallback | `~/.ssh/config` has no `User` for `login`, or `ssh -G` failed |
| `[AUTH_GUARD]` | Auth-config sanity warning | Resolved user equals local username, or `whoami` fallback used |
| `[AUTH_FAIL]` | SSH publickey auth rejected | Server says "Permission denied" or "Too many authentication failures" |
| `[PROBE_FAIL]` | TCP probe to `login:22` failed | Network unreachable, host down, or DNS broken |

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
- **`[USER_RESOLVE]` warning fires on startup** — your
  `~/.ssh/config` is missing `User <account>` for the `login`
  Host block. Add it.
- **`[AUTH_FAIL]` keeps firing** — wrong username, wrong key,
  or server's `authorized_keys` for your account is missing. Try
  `ssh -v login` from a regular shell to diagnose.
- **Tunnel stuck in `failed` after a long outage** — should
  not happen with the new script (loop runs forever, systemd
  sees one long-lived process). If it does, `systemctl --user
  reset-failed satellite-tunnel.service && systemctl --user start
  satellite-tunnel.service`.
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

## Debugging History

### 2026-06-08 — SSH 错账号触发 HPC 内部暴力破解告警(90 次/30min)

**Symptom**:用户公司 IT 推送"入侵监控-内网暴力破解"告警,主机 `172.30.0.4 (tjlogin004.hpc)` 在 30 min 内被来源 IP `172.25.199.35`(本机公司出口 IP)用账号 `qjh` 暴力破解 90 次。

**根因**:`scripts/satellite-tunnel.sh` 调试期间,`resolve_login()` 解析 `~/.ssh/config` 时**没有 `User` 字段就静默 fallback 到 `$(whoami)`**。在 systemd service 下 `whoami` 返回 `qjh`(本机用户名),但 HPC 那边只有 `qujiahao9430_test` 这个账号,key auth 必然失败。脚本"失败就 sleep 5s 再试"循环产生高频撞 sshd 行为,触发 HPC 内网 brute-force 监控规则。

**Fix**(已合入,见 `6c21cc06`):
1. 脚本改用 `ssh -G login` 同时解析 `hostname` + `user`,`User` 为空时 `fatal` 退出(不再 fallback)
2. 加 `-l "${SSH_USER}" "${LOGIN_ALIAS}"` 让 SSH config 完整生效
3. 加 `-o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=...` 锁死只用 `id_rsa`
4. 连续 3 次 auth fail → sleep 30 min(避免再触发监控)
5. 所有 fallback / 异常路径加显式 `[USER_RESOLVE]` / `[AUTH_FAIL]` / `[PROBE_FAIL]` 日志标签

**教训**:
- **不要在 systemd service 下用 `$(whoami)` 当 SSH user 的 fallback**。service 的 UID 经常跟真实登录用户不一致,fallback 出来的 user 几乎肯定是错的。
- **静默 fallback = 静默踩雷**。任何"找不到 X 就用 Y"的逻辑,必须有显眼日志。
- **debug 期脚本直接跑 production server 也会产生告警**。下次开发 tunnel 类工具,先在控制环境验证(本地 localhost 模拟),再上线。

**长期预防**(给 IT):
- 跟 HPC 那边申请把 `172.25.199.35` 加 sshd 白名单(或 `AllowUsers`),failed auth 不计入 brute-force 计数
- 这条告警一次性 ack,记录为 2026-06-08 debug 期间 false positive

## Requirements

- `fd` for `find_files` (install: `apt install fd-find`)
- `rg` for `grep_files` (install: `apt install ripgrep`)
- Bun runtime (for build)
- Node.js compatible HTTP client (MCP transport)
