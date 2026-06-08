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
- `$REMOTE_DIR/logs/satellite.log` — main log file with per-session
  correlation (`session=<id8>` prefix) and secret scrubbing (PEM,
  `.ssh/id_*`, `Bearer …`, `KEY=VAL`, `password=…` / `token=…`
  assignments). Auto-rotates past 50 MB. Mode `0o600`. Path
  configurable via `SATELLITE_LOG_FILE` (default `$REMOTE_DIR/logs/satellite.log`).
- `$REMOTE_DIR/logs/satellite-bash-<ts>-<hex>.log` — per-bash spill
  logs (only written when a bash sub-op's stdout exceeds the in-memory
  512 KB cap; the model can `read_file` these to fetch the full
  output). Path configurable via `SATELLITE_BASH_LOG_DIR`.

## Deployment to HPC

`./deploy.sh` builds, uploads, and restarts the server on the remote HPC login node (default: `login`, port `29001`).

### Remote layout

All server state is colocated under the project's satellite directory on the HPC login node, so the deploy is self-contained and there are no scattered files in `~` or `/tmp`:

```
$REMOTE_DIR=/TJPROJ13/GB_MICRO/USER/qujiahao/workspace/project-code/satellite
$REMOTE_DIR/satellite-server          (binary, executed by the MCP client)
$REMOTE_DIR/satellite-server.prev     (rollback, auto-saved on each deploy)
$REMOTE_DIR/satellite.env             (env dump from interactive login)
$REMOTE_DIR/logs/satellite.log        (main log, 50MB rotating, 0o600)
$REMOTE_DIR/logs/satellite-bash-*.log (per-bash spill, only on overflow)
$REMOTE_DIR/logs/satellite-stdout.log (nohup stdout/stderr capture)
```

The PID file stays in `/tmp/satellite.pid` (OS convention for ephemeral runtime state — small, frequently rewritten, lives with the rest of `/tmp`).

Both log paths are env-configurable (`SATELLITE_LOG_FILE`, `SATELLITE_BASH_LOG_DIR`); the defaults baked into `start.sh` and `deploy.sh` are the project-colocated paths above. `extensions/satellite/satellite-server.ts:88` and `extensions/satellite/utils.ts:11` are the only two places that read these env vars.

### One-time setup: capture the HPC env

The server runs as a `nohup`'d process, so it does not source your shell rc files. To make `python3`, `module load`, conda envs, etc. available to bash sub-ops, capture your interactive login env once:

```bash
ssh login
env -0 > /TJPROJ13/GB_MICRO/USER/qujiahao/workspace/project-code/satellite/satellite.env
                                                                     # MUST use -0: NUL separators preserve
                                                                     # multi-line BASH_FUNC_*() entries
exit
```

Re-run this whenever you change modules, switch conda envs, or update `PATH` on the login node, then redeploy.

### Deploy commands

```bash
./deploy.sh                  # full cycle: build + scp + restart
./deploy.sh --restart-only   # skip build + scp, just restart the existing
                             # binary (use after editing deploy.sh or after
                             # updating $REMOTE_DIR/satellite.env on the remote)
./deploy.sh --rollback       # restore $REMOTE_DIR/satellite-server.prev (auto-saved
                             # on each deploy), then restart
```

The deploy script:

1. Builds `satellite-server` binary locally (skipped with `--restart-only`).
2. Backs up the existing remote binary to `$REMOTE_DIR/satellite-server.prev` for rollback.
3. `scp`'s the binary to `/tmp` on the remote, then `rm` + `mv` into `$REMOTE_DIR/satellite-server`. The HPC filesystem blocks in-place overwrites, hence the rm-then-mv dance.
4. Kills all old `satellite-server` processes (including any `xargs` wrappers from prior failed deploys).
5. Launches the binary inside a subshell that sources `$REMOTE_DIR/satellite.env`, then `exec`s the binary via `env SATELLITE_TOKEN=... SATELLITE_PORT=... SATELLITE_LOG_FILE=... SATELLITE_BASH_LOG_DIR=...`. The subshell is replaced by the binary, so the process tree stays clean.

### Troubleshooting

- **Health check fails after deploy** — check `$REMOTE_DIR/logs/satellite-stdout.log` on the remote for the server's stderr.
- **bash sub-op can't find `python3` / `modulecmd`** — re-dump `$REMOTE_DIR/satellite.env` from an interactive session, then `./deploy.sh --restart-only`.
- **`module` function not available in `bash` sub-op** — expected. `bash -c` does not decode `BASH_FUNC_*` env vars. Capture already-loaded paths instead (your interactive `module load` will have updated `PATH` in `$REMOTE_DIR/satellite.env`).
- **scp fails with "dest open ... Failure"** — `$REMOTE_DIR` filesystem is full. The deploy already uploads to `/tmp` first, so this should be rare. Free up space with `ssh login 'du -sh $REMOTE_DIR/* | sort -h | tail'`.
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

### 2026-06-08 — `transfer_file` 损坏 binary 文件(zip/png/任何非 utf-8 字节)

**Symptom**:用户用 `pi --print` 跑 `transfer_file(remote_to_local)` 从 HPC 拉一个 5861 字节的 zip 到 `/tmp/`,落地文件是 10142 字节(膨胀),`xxd` 显示里面有 `efbfbd`(U+FFFD replacement character),`unzip` 报"missing N bytes in zipfile"。Model 独立诊断出根因:server 把 zip 当 UTF-8 文本读,非法字节被替换。

**根因**:`handleTransferFile` (server) 用 `readFile(safeRemote, "utf-8")` 读文件,`writeFile(safeRemote, content, "utf-8")` 写文件。Node 的 utf-8 解码器对无效序列静默替换为 U+FFFD。`extensions/personal-assistant/tools.ts` 的 `readFileForTransfer` / `writeFileForTransfer` 同样问题。文字文件(pure ASCII 或有效 UTF-8)看不出问题,任何带 `0x5c` 后跟非 ASCII 字节的二进制文件(基本就是所有 zip/png/jpg)必坏。

**Fix**(已合入,见 `8c4457bc`):
- Server `remote_to_local`: `readFile(safeRemote)` 取 Buffer,`bytes.toString("base64")` 后返回 `echo + "B64:" + b64`
- Server `local_to_remote`: 检测 `args.content` 的 `B64:` 前缀,base64-decode 后 `writeFile` 写原始字节(legacy utf-8 text 没前缀也能工作)
- Client `readFileForTransfer`: 永远返回 base64
- Client `writeFileForTransfer`: 接收 `Buffer`,`writeFileSync` 不指定编码写原始字节
- Client `interceptTransferCall` (local_to_remote): 注入 `B64:` + b64
- Client `interceptTransferResult` (remote_to_local): 检测 `B64:` 前缀,base64-decode 后写 Buffer

**B64: 前缀方案的考虑**:
- 简单:4 字节 tag,清楚区分 binary vs text
- 不破坏 wire format:text body 仍然有效,只是会被识别为 legacy utf-8
- 不需要重写协议 / 不需要新 content type / 跟现有 `textContent` envelope 兼容
- 33% 大小开销,对于 HPC 文件传输可接受
- 真正的干净做法应该是用 MCP 的 `BlobResource` content type,但那需要拆 `remote_exec` 工具或者改 schema 走 discriminated union,**远远** 比这个 fix 复杂

**教训**:
- **永远别用 `"utf-8"` 编码读 / 写用户文件**。默认 `readFile` / `writeFile` 是 binary,传 encoding 参数会引入 silent corruption
- **binary 字节要 base64**(或 hex)在 JSON 字符串 round-trip 中幸存
- **fix 完了必须 end-to-end 验证**:单元测试过 ≠ 真实场景对。这次是 `pi --print` 拉到真文件后 `xxd` + `md5sum` 才暴露问题

**部署注意**:server 是编译后的 native binary(`bun build --compile`),source 改了要 `./deploy.sh`(完整 build + upload),**不能**用 `--restart-only`,否则新代码不上线,旧 binary 还在跑。我这次 debug 时第一次用了 `--restart-only`,fix 完全没生效,排查了一会儿才发现 binary 还是 `Jun 7 16:14` 的旧版。

### 2026-06-08 — Server 部署从 `~/` + `/tmp/` 迁到 `$REMOTE_DIR/satellite/`

**Symptom**:`/tmp/satellite.log`、`/tmp/satellite-bash-*.log`、`/tmp/satellite-stdout.log`、`~/satellite.env`、`~/satellite-server` 散落在 `/tmp` 和 home,不容易一次性查全,且 `/tmp` 是 OS 临时区,可能被清理(`/tmp/satellite-bash-*.log` 30+ 个累计 1.5 MB,落了好几天不主动清)。

**Fix**:
- `extensions/satellite/satellite-server.ts:88` — `LOG_FILE` 改 `process.env.SATELLITE_LOG_FILE ?? "/tmp/satellite.log"`,启动时 `mkdirSync(dirname(LOG_FILE), { recursive: true })`
- `extensions/satellite/utils.ts:11` — `BASH_LOG_DIR = process.env.SATELLITE_BASH_LOG_DIR ?? "/tmp"`,启动时 `mkdir` 初始化,`tempPath` 用 `join(BASH_LOG_DIR, ...)`
- `extensions/satellite/start.sh` — 默认 `LOG_FILE` / `BASH_LOG_DIR` 走 `$SCRIPT_DIR/logs/`,传 env vars 给 binary,stdout 也在 logs 下
- `extensions/satellite/deploy.sh` — 加 `REMOTE_DIR` 常量(`/TJPROJ13/GB_MICRO/USER/qujiahao/workspace/project-code/satellite`),所有路径换新,启动时 `env SATELLITE_LOG_FILE=... SATELLITE_BASH_LOG_DIR=...`;**修了一个 bug**:之前的 `mv ~/satellite.env` 用了双引号外的 `$HOME`,会被 local shell 展开成 `/home/qjh`(本机用户),改成显式 `REMOTE_HOME=$(ssh login 'echo $HOME')`
- `deploy.sh` 在每次 deploy 时检测老的 `~/satellite.env`,自动迁到新位置(idempotent)
- 老的 `/tmp/satellite*.log` 和 `~/satellite-server` 旧 binary 全删

**新结构** (在 `$REMOTE_DIR` 下):
```
$REMOTE_DIR/satellite-server          (binary)
$REMOTE_DIR/satellite-server.prev     (rollback,首次 deploy 后才有)
$REMOTE_DIR/satellite.env             (env)
$REMOTE_DIR/logs/satellite.log        (main log)
$REMOTE_DIR/logs/satellite-bash-*.log (per-bash spill)
$REMOTE_DIR/logs/satellite-stdout.log (stdout/stderr)
```

PID 文件留在 `/tmp/satellite.pid`(OS 习惯,频繁写,小文件,放临时区合理)。

**教训**:
- **部署配置应该 colocate**(同一项目目录下),不要散落在 home + /tmp。一次性 `ls -la $REMOTE_DIR/` 就能看全所有 server 状态,排查时不用 `ls /tmp` + `ls ~` + `journalctl` 三处凑
- **写 deploy script 时,local shell 的 `$HOME` 不等于 remote shell 的 `$HOME`**,双引号包 ssh 参数会展开成本地变量。**显式 `ssh login 'echo $HOME'` 解析**(就像 deploy.sh 之前对 `REMOTE_HOME` 做的)
- **日志路径要 env-configurable**。硬编码 `/tmp/...` 后面想搬就麻烦
- **可执行文件用 `bun build --compile` 编出来的 binary 是 self-contained**,运行时只需要 token + port + log path,不需要 source / node_modules;所以 server 可以扔到任何有写权限的目录

## Requirements

- `fd` for `find_files` (install: `apt install fd-find`)
- `rg` for `grep_files` (install: `apt install ripgrep`)
- Bun runtime (for build)
- Node.js compatible HTTP client (MCP transport)
