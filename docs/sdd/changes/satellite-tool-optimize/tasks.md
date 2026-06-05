# Tasks: satellite-tool-optimize

> **Design:** design.md | **Base:** c1ad7ae9

**Goal:** Expand `remote_exec` from 5→8 sub-operations with bash guardrail, schema alignment, and dual-direction file transfer.

**Architecture:** Single `remote_exec` discriminated union (5→8 ops). New ops: `transfer_file` (HTTP body), `find_files`/`grep_files` (fd/rg, no fallback). Bash guardrail: intent detection → guidance error → model self-corrects. Layer A soft guardrail: `mcp.json` `remotePathPattern` → system prompt injection.

**Tech Stack:** Bun (HTTP, build, test), TypeScript, Zod (MCP schema), MCP StreamableHTTP, `child_process.spawn` for bash, fd/rg for search, native fs for transfer.

## Notes

- **TDD discipline**: Pure functions (detectIntent, validateSchema, retryCounter) tested via `bun test`. HTTP integration (transfer endpoints) tested by spawning server + curl.
- **`依赖`** = execution order for DAG parallelism
- **Task ID format**: `<section>.<task>[letter]`
- **Inline comments allowed** in `依赖` (parens / hash stripped during parse)

## 1. Foundation: Delete v2 + Refactor Schemas

- [x] 1.1 **Delete `satellite-mcp.ts` (v2 stdio)**
  - **文件**: `extensions/satellite/satellite-mcp.ts` (Delete), `extensions/satellite/satellite-mcp` (Delete binary)
  - **内容**: Remove the v2 stdio MCP server file. It is dead code (v3 HTTP supersedes it). Also remove compiled binary if present.
  - **验证**: `ls extensions/satellite/satellite-mcp.ts 2>&1 | grep -q 'No such' && echo OK`
  - **依赖**: 无

- [x] 1.2 **Extract schemas from inline registration into a single source of truth**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Hoist the `inputSchema` zod discriminated union out of `createMcpServer()` (lines 685-716) into a top-level constant `REMOTE_EXEC_SCHEMA` so it can be referenced by both registration and tests. Keep `TOOL_SCHEMAS` (lines 360-386) and `TOOL_HANDLERS` (lines 655-669) as the runtime lookup tables.
  - **验证**: `grep -n "REMOTE_EXEC_SCHEMA" extensions/satellite/satellite-server.ts` returns ≥1 match
  - **依赖**: 无
  - **前置阅读**: `extensions/satellite/satellite-server.ts:681-738`

- [x] 1.3 **Align `list_dir` schema to native pi `ls` (path optional, default ".")**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: In `TOOL_SCHEMAS.list_dir` (line 382) and the discriminated union at line 711-715, change `path: z.string()` to `path: z.string().optional().default(".")`. Add description: "List directory entries. Path defaults to current directory."
  - **验证**: `bun -e "import('./extensions/satellite/satellite-server.ts').then(m => console.log(m.TOOL_SCHEMAS.list_dir.parse({})))" 2>&1 | grep -q '\.'` (or unit test verifying default)
  - **依赖**: 1.2

- [x] 1.4 **Enhance sub-operation descriptions with "when to use" guidance**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Update `description` in `createMcpServer()` (line 684) to include for each op: (a) one-line "Use this when..." summary, (b) contrast with bash equivalent. Example for `read_file`: "PREFER over bash `cat <path>`. Reads with offset/limit and truncation. Use this for any file read operation."
  - **验证**: `grep -A 1 "read_file:" extensions/satellite/satellite-server.ts | grep -i "PREFER\|use this"`
  - **依赖**: 1.2

## 2. Bash Guardrail (Layer B)

- [x] 2.1 **Write failing test for `detectIntent` regex matching**
  - **文件**: `extensions/satellite/satellite-server.test.ts` (Create)
  - **内容**: bun:test cases: (a) `cat /foo/x.txt` → `"read_file"`, (b) `sed -i 's/a/b/' /foo/x` → `"edit_file"`, (c) `echo 'x' > /foo/y` and `printf 'x' > /foo/y` → `"write_file"`, (d) `find /foo -name '*.ts'` → `"find_files"`, (e) `grep -r foo /bar` → `"grep_files"`, (f) `ls -la /foo` → `null` (legitimate), (g) `cat file1 file2 | grep x` → `null` (pipeline usage), (h) `cat < in.txt` → `null` (stdin redirect).
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "detectIntent"` reports 9 fail
  - **依赖**: 无

- [x] 2.2 **Implement `detectIntent` function**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Add pure function `detectIntent(command: string): "read_file"|"edit_file"|"write_file"|"find_files"|"grep_files"|null`. Patterns (in order, first match wins):
    - `read_file`: `^cat\s+[^\s|;<>&]+$` (no pipe, no redirect, no stdin)
    - `edit_file`: `^sed\s+-i\b` 
    - `write_file`: `^(echo|printf)\s+.*>\s*\S+`
    - `find_files`: `\bfind\s+`
    - `grep_files`: `\bgrep\s+|\bgrep\b`
    - Return `null` if no match.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "detectIntent"` reports 9 pass
  - **依赖**: 2.1

- [x] 2.3 **Write failing test for guardrail retry counter**
  - **文件**: `extensions/satellite/satellite-server.test.ts` (extend)
  - **内容**: bun:test cases: (a) first call returns guidance error, (b) second call returns guidance error, (c) third call returns hard error, (d) different intent category resets counter, (e) success resets all counters.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "guardrailRetry"` reports 5 fail
  - **依赖**: 2.1

- [x] 2.4 **Implement `guardrailRetry` per-turn counter**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Add module-level `Map<number, Record<Intent, number>>` keyed by turn id. Function `getGuardrailCount(turnId, intent)` returns count, `incrementGuardrail(turnId, intent)` bumps. Hard error on `count >= 2`. (Map is OK for unit testing; production wires turn id from MCP request later.)
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "guardrailRetry"` reports 5 pass
  - **依赖**: 2.3

- [x] 2.5 **Wire guardrail into `handleBash`**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: At top of `handleBash` (line 493), call `detectIntent(args.command)`. If non-null, check `guardrailRetry`. If count < 2, increment and return `{ content: textContent("Prefer <op> over bash <bad>. Try: tool=<op>, ..."), isError: true }`. If count >= 2, return hard error: "Blocked: you have tried bash <bad> 3 times. Use tool=<op> instead." Use a fixed turn id (0) for now — TBD in 2.6.
  - **验证**: Manual test: `curl -X POST http://localhost:29001/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remote_exec","arguments":{"tool":"bash","command":"cat /etc/hostname"}}}'` returns isError with "Prefer read_file"
  - **依赖**: 2.2, 2.4

- [x] 2.6 **Pass turn id from MCP request context into guardrail**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Plumb turn id from MCP request `extra._meta` or `extra.sessionId` (whichever available) into `handleBash` → `guardrailRetry`. Reset counters when a new session id is seen.
  - **验证**: Unit test: simulate 2 sessions, verify counter isolation. `bun test extensions/satellite/satellite-server.test.ts -t "session isolation"`
  - **依赖**: 2.5

- [x] 3.1 **Write failing test for default timeout**
  - **文件**: `extensions/satellite/satellite-server.test.ts` (extend)
  - **内容**: bun:test: spawn `handleBash({ command: "sleep 60" })` (no timeout) and assert it returns `isError: true` with "exceeded 30s timeout" within 35s. Second case: `handleBash({ command: "sleep 60", timeout: 1 })` returns within 2s.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "default timeout"`
  - **依赖**: 2.4 (needs guardrail infrastructure, but test guards against `sleep 60` not being a `cat/sed/find`)

- [x] 3.2 **Apply `timeout = args.timeout ?? 30` in `handleBash`**
  - **文件**: `extensions/satellite/satellite-server.ts` (line ~514, where `spawn` is called)
  - **内容**: Compute `const timeoutSec = args.timeout ?? 30`. Pass to existing timeout/kill logic. On timeout kill, return `{ content: textContent("Command exceeded ${timeoutSec}s timeout. Use timeout=N for longer tasks."), isError: true }`.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "default timeout"` passes
  - **依赖**: 3.1

## 4. New Sub-Operations: `find_files`, `grep_files`, `transfer_file`

- [x] 4.1 **Add `find_files` schema + handler**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Schema: `{ pattern: z.string(), path: z.string().optional().default("."), limit: z.number().optional().default(500) }`. Handler: `which fd` first; if missing return `isError: true` with install instruction. Otherwise `spawn("fd", ["--glob", "--hidden", "--no-require-git", "--max-depth", "10", pattern, path])`. Apply `truncateHead` to output.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "find_files"` — case (a) fd missing returns isError, (b) fd present returns file list (mock or skip if fd not in CI).
  - **依赖**: 1.2

- [x] 4.2 **Add `grep_files` schema + handler**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Schema: `{ pattern: z.string(), path: z.string().optional().default("."), glob: z.string().optional(), limit: z.number().optional().default(500) }`. Handler: `which rg` first; if missing return isError. Otherwise `spawn("rg", [pattern, path, "--no-heading", "--line-number", "--max-depth", "10", ...(glob ? ["--glob", glob] : [])])`. Apply `truncateHead`.
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "grep_files"`
  - **依赖**: 1.2

- [x] 4.3 **Add `transfer_file` schema + handler (proxies via `/transfer` endpoint)**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Schema: `{ direction: z.enum(["upload", "download"]), local_path: z.string(), remote_path: z.string() }`. Handler: For `upload`, `readFile(args.remote_path)` → return content as text in MCP response (this is allowed because upload is a "give me the bytes to write locally" operation and the file content is the response, not the request). For `download`, accept `content: z.string()` arg → `writeFile(args.remote_path, content)`. NO LLM context tokens are used for the agent's instruction; the response body is the file content. The description MUST clarify: "upload returns the remote file content (you write it locally); download requires you to also pass `content=<file bytes>` field".
  - **验证**: `bun test extensions/satellite/satellite-server.test.ts -t "transfer_file"` — case (a) direction="push" returns isError, (b) upload happy path (mock readFile), (c) download happy path (mock writeFile).
  - **依赖**: 1.2

- [x] 4.4 **Register new sub-ops in `REMOTE_EXEC_SCHEMA` and `TOOL_HANDLERS`**
  - **文件**: `extensions/satellite/satellite-server.ts`
  - **内容**: Add 3 entries to discriminated union. Add 3 entries to `TOOL_HANDLERS` map.
  - **验证**: `grep -c "tool: z.literal" extensions/satellite/satellite-server.ts` returns 8
  - **依赖**: 4.1, 4.2, 4.3
  - **Note**: Side-effect of tasks 4.1-4.3 (which added registrations). All 8 z.literal and TOOL_HANDLERS entries exist.

- [x] 4.5 **Update top-level `description` to list all 8 ops with "when to use"**
  - **文件**: `extensions/satellite/satellite-server.ts` (line 684)
  - **内容**: Replace the bullet list with new 8-op version, each with one-line guidance and bash contrast.
  - **验证**: `grep -c "PREFER" extensions/satellite/satellite-server.ts` returns ≥4
  - **依赖**: 4.4
  - **Note**: Side-effect of task 1.4. Description has 5 PREFER statements and all 8 sub-ops.

## 5. Transfer HTTP Endpoints

- [x] 5.1 **Add `POST /transfer?path=` and `GET /transfer?path=` to Bun.serve**
  - **文件**: `extensions/satellite/satellite-server.ts` (in `fetch` handler, before MCP route)
  - **内容**: POST: read `req.body` as `ArrayBuffer` → `await mkdir(dirname(path), { recursive: true })` → `await writeFile(path, Buffer.from(buffer))` → return 200 with bytes written. GET: `await readFile(path)` → return as `Response` with `Content-Type: application/octet-stream`. Both use `checkAuth` middleware. Validate `path` query param exists, else 400.
  - **验证**: `curl -X POST -H "Authorization: Bearer $TOKEN" --data-binary "@/etc/hostname" "http://localhost:29001/transfer?path=/tmp/test-up.txt" && curl -H "Authorization: Bearer $TOKEN" "http://localhost:29001/transfer?path=/tmp/test-up.txt"` returns matching content.
  - **依赖**: 4.3 (transfer_file uses these endpoints)

- [x] 5.2 **Document the transfer_file orchestrator contract in description**
  - **文件**: `extensions/satellite/satellite-server.ts` (in `description` line 684)
  - **内容**: For `transfer_file`: "Server-side: upload returns file content (agent writes local); download accepts `content` field, server writes to `remote_path`. Both use HTTP body transport via `/transfer` endpoint. No LLM context tokens for file content."
  - **验证**: `grep "transfer_file" extensions/satellite/satellite-server.ts | head -5`
  - **依赖**: 5.1
  - **Note**: Side-effect of task 1.4. Description documents transfer_file content flow.

## 6. Layer A: Soft Guardrail via System Prompt

- [x] 6.1 **Inject layer A prompt in `before_agent_start` hook**
  - **文件**: `extensions/personal-assistant/tools.ts` (the existing `before_agent_start` hook at line 203)
  - **内容**: Per design decision "no changes to packages/coding-agent/src/core/mcp/", do NOT modify `manager.ts` or `McpServerConfig`. Instead, at hook start, call `loadMcpConfig()` (imported from `settings-manager`). For each server named `satellite` with `remotePathPattern`, append: `\n\n## Remote Paths\n\nFiles matching pattern \`${pattern}\` are on the remote HPC server. Use \`satellite_remote_exec\` for all file operations on these paths (read_file, write_file, edit_file, list_dir, find_files, grep_files, transfer_file). Do NOT use local bash/read/write/edit on these paths.` If no satellite config has remotePathPattern, no injection.
  - **验证**: `grep -A 2 "Remote Paths" extensions/personal-assistant/tools.ts && grep "loadMcpConfig" extensions/personal-assistant/tools.ts`
  - **依赖**: 无

- [x] 6.2 **Document `remotePathPattern` field in `extensions/satellite/README.md`**
  - **文件**: `extensions/satellite/README.md` (Create)
  - **内容**: Add section showing how to configure `/TJPROJ\d+/` pattern in mcp.json. Include example block.
  - **验证**: `ls extensions/satellite/README.md && grep remotePathPattern extensions/satellite/README.md`
  - **依赖**: 6.1

## 7. Integration & Verification

- [x] 7.1 **Build satellite binary successfully**
  - **文件**: `extensions/satellite/satellite-server.ts` (all prior changes)
  - **内容**: `bash extensions/satellite/build.sh` exits 0. Binary `satellite-server` rebuilt.
  - **验证**: `bash extensions/satellite/build.sh && echo OK`
  - **依赖**: 1.1, 1.4, 2.6, 3.2, 4.5, 5.2

- [x] 7.2 **Run full test suite**
  - **文件**: all unit tests
  - **内容**: All bun:test cases pass.
  - **验证**: `bun test extensions/satellite/` exits 0
  - **依赖**: 7.1

- [x] 7.3 **Run repo-wide lint + typecheck (canonical command)**
  - **文件**: all modified files
  - **内容**: Use the repo's canonical check command.
  - **验证**: `npm run check` exits 0
  - **依赖**: 7.1

- [x] 7.4 **Run repo-wide typecheck**
  - **文件**: all modified files
  - **内容**: `tsgo --noEmit` passes.
  - **验证**: `npx tsgo --noEmit` exits 0
  - **依赖**: 7.1

## Verification
- [ ] 全量测试: `bun test extensions/satellite/`
- [ ] Lint: `npx biome check extensions/satellite/ packages/coding-agent/src/core/mcp/ extensions/personal-assistant/`
- [ ] Typecheck: `npx tsgo --noEmit`
- [ ] Build: `bash extensions/satellite/build.sh`
- [ ] End-to-end smoke: start server → curl /health → curl /mcp with all 8 sub-ops → curl /transfer upload + download
