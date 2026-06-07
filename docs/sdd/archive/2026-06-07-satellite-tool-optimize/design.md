# Design: satellite-tool-optimize

## Context

`satellite-server.ts` (v3, Bun HTTP, port 29001) exposes a single MCP tool `remote_exec` with a discriminated union of 5 sub-operations: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`. Three problems persist:

1. **Agent prefers bash over specialty tools**: within `remote_exec`, agent repeatedly selects `tool="bash"` with `cat`/`sed`/`echo >`/`find`/`grep` instead of the dedicated `read_file`/`edit_file`/`write_file`/missing `find_files`/`grep_files` sub-operations. Bash lacks truncation, timeout, diff feedback, and fuzzy matching. `find`/`grep` in bash hit deep HPC directory trees with no limits.

2. **No file-transfer primitive**: agent confuses local↔remote direction when passing files between machines, often reading/writing on the wrong side.

3. **Schema drift**: satellite schemas diverge from native pi tools in trivial ways (missing descriptions, `list_dir` path required vs optional, no `find`/`grep` sub-operations), making the tools feel unfamiliar.

## Goals / Non-Goals

- **Goals**:
  - Expand remote_exec from 5→8 sub-operations with verified tool coverage
  - Align satellite schemas with native pi tools (parameter names, types, optionality, descriptions)
  - Bash guardrail: intent detection + guidance error for cat/sed/echo/find/grep patterns
  - Bash default timeout 30s
  - transfer_file HTTP transport channel (POST/GET `/transfer`)
  - Layer A soft guardrail: `mcp.json` → `remotePathPattern` → system prompt injection

- **Non-Goals**:
  - No union architecture change (keep single `remote_exec` tool)
  - No transparent redirect (follow Forge guardrail: intercept → error → model self-corrects)
  - No MCP transport layer changes
  - No fd/rg fallback (require pre-installed tools, error if missing)

## Decisions

### 1. Guardrail: intercept + guidance error, not transparent redirect

**Decision**: Bash intent detection returns `isError: true` with guidance text; agent sees the error and self-corrects on next turn.

**Rationale**: Forge pattern — transparent redirect hides the problem, model never learns. Guardrail error forces the model to see its mistake and adapt. Agent training data has `bash(cat ...)` as high-probability path; only explicit negative feedback reduces that probability over time.

**Alternatives considered**: Transparent redirect (model unaware, continues to use bash). Rejected — waste tokens on bash→redirect round trips with no learning.

### 2. Guardrail retry budget: 2 intercepts then hard-block

**Decision**: Count consecutive intercepts per guardrail category per turn. On 3rd violation, return hard error with no further guidance.

**Rationale**: Prevents infinite retry loops if model ignores guidance. 2 retries gives model 3 total chances to learn (initial call + 2 corrections).

### 3. Bash default timeout: 30s with explicit override

**Decision**: `handleBash` applies `timeout = args.timeout ?? 30` (秒). When timeout kills the process, return `isError: true` with guidance to set `timeout=N` for longer tasks.

**Rationale**: HPC find/grep can silently hang for minutes. Agent rarely sets timeout. 30s catches the common case (forgotten timeout) while `timeout=600` allows legitimate long builds.

### 4. transfer_file: HTTP body transport, dual-path parameters

**Decision**: Add `POST /transfer?path=` and `GET /transfer?path=` endpoints to satellite Bun server. `transfer_file` sub-operation has `direction: "upload"|"download"`, `local_path`, `remote_path`. pi agent reads/writes `local_path` locally, transfers bytes via HTTP body.

**Rationale**: File contents must not pass through LLM context tokens (huge, expensive, truncation risk). HTTP body is the correct channel for raw bytes. Dual paths make the source→destination explicit.

### 5. find_files / grep_files: fd/rg required, no fallback

**Decision**: `which fd`/`which rg` at tool execution time. If missing, return `isError: true` with install instructions. No system find/grep fallback.

**Rationale**: System find is too slow for HPC deep trees (worse than useless). Explicit error forces operator to install the fast tool once, benefiting all subsequent usage. Agent can `bash(apt install fd)` in response.

### 6. Layer A: soft guardrail via MCP prompt injection

**Decision**: `mcp.json` satellite config gets optional `remotePathPattern` field. `_buildRuntime` or extension `before_agent_start` hook reads it and injects into system prompt: "Files matching {pattern} are on remote HPC. Use satellite_remote_exec." No hard rejection at agent level (deferred).

**Rationale**: Layer A hard interception requires agent-side execution chain hook, not self-contained in MCP. Soft prompt keeps satellite self-contained while still guiding the model.

## Architecture

```
satellite-server.ts (Bun HTTP, port 29001, single file)
│
├── /mcp (MCP端点, 现有 StreamableHTTP)
│   └── remote_exec tool (discriminatedUnion: 5→8 sub-ops)
│
├── /transfer (文件传输, 新增)
│   ├── POST ?path=  ← agent 上传  (body=raw bytes)
│   └── GET  ?path=  ← agent 下载  (response body=raw bytes)
│
└── /health (现有)

remote_exec 子操作 (8):
  read_file    { path, offset?, limit? }
  write_file   { path, content }
  edit_file    { path, edits[{oldText, newText}] }
  bash         { command, timeout?, cwd? }
  list_dir     { path?, limit? }         ← path 改为 optional
  transfer_file { direction:"upload"|"download", local_path, remote_path }
  find_files   { pattern, path?, limit? }
  grep_files   { pattern, path?, glob?, limit? }

Code structure (satellite-server.ts inlines):
  TOOL_SCHEMAS: zod schemas for all 8 sub-ops
  TOOL_HANDLERS: handler functions (reuse existing + 3 new)
  createMcpServer(): registers remote_exec tool
  detectIntent(command): RegExp-based pattern matching
  guardrailRetry: per-turn counter in handleBash closure
```

### Data flow: transfer_file

```
upload:
  agent: read(local_path)
  agent: POST /transfer?path=remote_path (body=content)
  satellite: writeFile(remote_path, body)
  agent: returns confirmation

download:
  agent: GET /transfer?path=remote_path
  satellite: readFile(remote_path) → response body
  agent: write(local_path, response body)
  agent: returns confirmation
```

### Data flow: bash guardrail

```
agent → remote_exec(tool=bash, command="cat /TJPROJ1/x.txt")
  ↓ handleBash
  ↓ detectIntent("cat /TJPROJ1/x.txt") → "read_file"
  ↓ guardrailRetry.read_file < 2
  ↓ return { isError: true,
      content: "Prefer read_file over bash cat. Use tool=read_file, path='/TJPROJ1/x.txt'" }
  ↓ agent sees error → retries with tool=read_file
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Guardrail false-positive intercepts (e.g., `cat` used in pipeline) | detectIntent regex checks for standalone usage: `^cat\s+\S+$` (no pipe, no redirect) |
| fd/rg not installed on remote → find_files/grep_files broken | Clear install instructions in error message. Operator installs once |
| transfer_file large file → memory pressure | Stream via fs.createReadStream → pipe to fetch body |
| layer A (soft) agent ignores prompt guidance | Acceptable — soft constraint by design. Hard enforcement deferred |
| 30s default timeout kills legitimate short-build commands | Agent must set `timeout=N` for any command expected to exceed 30s |

## Testing Strategy

- 单元测试: detectIntent regex matching (all 5 patterns), schema validation (all 8 sub-ops), timeout logic
- 集成测试: transfer_file end-to-end (upload+download round-trip), guardrail redirect cycle (bash error → model retry → success)
- 边界条件: empty command, missing args, direction="push" (invalid), fd/rg not installed, guardrail retry counter reset between turns

## Implementation Notes

- All changes in `extensions/satellite/satellite-server.ts` single file (server-side)
- Delete `extensions/satellite/satellite-mcp.ts` (v2 stdio, dead code)
- No changes to `packages/coding-agent/src/core/mcp/` (manager, tool-factory reused as-is)
- Layer A reads `mcp.json` directly in `personal-assistant/tools.ts` via existing `loadMcpConfig` helper from `settings-manager.ts` — no `McpServerConfig` schema change
- System prompt injection via `before_agent_start` hook in `personal-assistant/tools.ts`
- transfer HTTP endpoints re-use existing `checkAuth` middleware
- `which fd`/`which rg` rely on PATH

<!-- archived-with: 2026-06-07-satellite-tool-optimize | status: final -->
