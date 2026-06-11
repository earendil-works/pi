# Tasks: trim-bash-guardrail

> **Design:** design.md | **Base:** 68c2c5fd

**Goal:** Delete local bash guardrail entirely and remove `list`/`find`/`grep` sub-tools from satellite, keeping only the `cat/sed-i/echo>` → `read/write/edit` intent mapping for satellite bash.

**Architecture:** Two parallel surfaces (satellite server schema/handlers, client guardrail) get pruned. The local pi bash hook is deleted from the personal-assistant extension. Tests/docs/CHANGELOG sync to the new minimal surface (3 intents, 5 sub-tools).

**Tech Stack:** TypeScript, zod/v3, vitest, MCP SDK, satellite server (Bun runtime)

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
- **`前置阅读`** = context only (not execution order; orthogonal to parallelism)
- All paths in tasks are **absolute** (project root: `/home/qjh/workspace/personal/pi`)
- Verification commands assume cwd = project root
- All test runs use the project's `vitest` from `node_modules`

## 1. Satellite schema and server cleanup

- [x] 1.1 **Remove `list`/`find`/`grep` from REMOTE_EXEC_INPUT_SCHEMA enum**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/schema.ts` (Modify)
  - **内容**: Edit `z.enum([...])` array to contain only `["bash", "read", "write", "edit", "transfer_file"]`. Remove the 3 string literals.
  - **验证**: `cd /home/qjh/workspace/personal/pi && node -e "import('./extensions/satellite/schema.ts').then(m => { const e = m.REMOTE_EXEC_INPUT_SCHEMA.shape.tool.options; console.log(e); if (e.includes('list') || e.includes('find') || e.includes('grep')) process.exit(1); })"` — exits 0 and prints 5 values
  - **依赖**: 无

- [x] 1.2 **Delete `handleListDir` function and `MAX_LS_ENTRIES` constant**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Delete `async function handleListDir(...)` (currently lines 763-801) and the `const MAX_LS_ENTRIES = 500;` constant (line 139). Verify no other code uses `MAX_LS_ENTRIES` before deleting.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "handleListDir\|MAX_LS_ENTRIES" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.1

- [ ] 1.3 **Delete `handleFindFiles`, `runFd`, and `checkFdAvailable`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Delete `runFd` function (line ~807), `handleFindFiles` function (line ~870), and any `checkFdAvailable` helper. Use `grep -n "fd\|find_files" extensions/satellite/satellite-server.ts` first to find all related code.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "handleFindFiles\|runFd\|checkFdAvailable" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.2

- [ ] 1.4 **Delete `handleGrepFiles`, `runRg`, `checkRgAvailable`, `truncateLine`, `GREP_MAX_LINE_LENGTH`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Delete `GREP_MAX_LINE_LENGTH` constant (line 897), `truncateLine` function (line 899), `runRg` function (line 908), `handleGrepFiles` function (line 970), any `checkRgAvailable` helper.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "handleGrepFiles\|runRg\|checkRgAvailable\|truncateLine\|GREP_MAX_LINE_LENGTH" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.3

- [ ] 1.5 **Remove `list`/`find`/`grep` entries from `TOOL_HANDLERS`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Delete the 3 lines: `list: (args, _s, _p, sid) => handleListDir(...)`, `find: (args, ...) => handleFindFiles(...)`, `grep: (args, ...) => handleGrepFiles(...)`. Keep `read`/`write`/`edit`/`bash`/`transfer_file` entries.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -E "^  (list|find|grep):" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.2, 1.3, 1.4 (must be after all handlers are deleted)

- [ ] 1.6 **Update `createMcpServer` description string to remove list/find/grep examples**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Edit the multi-line description string passed to `server.registerTool("remote_exec", { description: ..., ... })`. Remove the lines: `List    { tool:"list",   path:"..." }`, `Search  { tool:"find", pattern:"...", path:"..." }`, `        { tool:"grep", pattern:"...", path:"...", glob?: "..." }`. Update the `Prefer the dedicated ops above.` line to remove `ls/find/grep` mention if present.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "tool:\"list\"\|tool:\"find\"\|tool:\"grep\"" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.5

- [ ] 1.7 **Update top-of-file comment to remove `list_dir`/`find_files`/`grep_files` mentions**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/satellite-server.ts` (Modify)
  - **内容**: Edit the `/** ... */` block at the top of the file (around line 9) that mentions `read_file, write_file, edit_file, bash, list_dir, find_files, grep_files`. Update to `read_file, write_file, edit_file, bash, transfer_file` (matching remaining sub-tools).
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "list_dir\|find_files\|grep_files" extensions/satellite/satellite-server.ts` — outputs 0 matches
  - **依赖**: 1.5

## 2. Client guardrail (personal-assistant)

- [x] 2.1 **Narrow `BashIntent` type to 3 values**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Edit `type BashIntent = "read" | "edit" | "write" | "list" | "find" | "grep";` to `type BashIntent = "read" | "edit" | "write";`. (Around line 273.)
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "type BashIntent" extensions/personal-assistant/tools.ts` — outputs `type BashIntent = "read" | "edit" | "write";`
  - **依赖**: 无

- [x] 2.2 **Remove `ls/ll/dir`/`find`/`grep` regex lines from `detectBashIntent`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Delete the 3 lines: `if (/^(ls|ll|dir)\b/.test(command)) return "list";`, `if (/(?<![/_\-a-zA-Z0-9])find\s+/.test(command)) return "find";`, `if (/(?<![/_\-a-zA-Z0-9])grep\s+/.test(command)) return "grep";`. (Currently lines 280-282.) Also update the doc comment above the function (line 270-272) to remove `ls/`.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n 'return "list"\|return "find"\|return "grep"' extensions/personal-assistant/tools.ts` — outputs 0 matches
  - **依赖**: 2.1

- [x] 2.3 **Remove `list`/`find`/`grep` cases from `getBashGuidance`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Delete the 3 `case "list":` / `case "find":` / `case "grep":` blocks. (Currently lines 295-300.) Update the switch to only handle `read`/`edit`/`write`.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n 'case "list"\|case "find"\|case "grep"' extensions/personal-assistant/tools.ts` — outputs 0 matches
  - **依赖**: 2.1 (TypeScript will error if cases reference types not in BashIntent union)

- [ ] 2.4 **Simplify `checkBashIntentCommon` signature and internal key**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: 
    1. Change function signature from `(command: string, turnId: string, prefix: "local" | "satellite")` to `(command: string, turnId: string)`
    2. Inside, replace `const key = \`${turnId}:${prefix}:${intent}\`;` with `const key = \`${turnId}:satellite:${intent}\`;`
    3. Update the call site in `checkBashIntent` (line 330): `return checkBashIntentCommon(command, turnId, "satellite");` → `return checkBashIntentCommon(command, turnId);`
    4. Update the call site in the local hook at line 948 — but Task 2.5 removes that call entirely, so no change needed here
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n 'checkBashIntentCommon(command' extensions/personal-assistant/tools.ts` — outputs 1 match without the 3rd argument
  - **依赖**: 2.1, 2.2, 2.3

- [ ] 2.5 **Delete the local bash hook branch from `tool_call` handler**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Delete the entire `if (event.toolName === "bash") { ... }` block (currently lines 945-950) including the comment above it. Also update the preceding section comment (line 944) to remove "Local bash: 共享卫星的 bash intent guardrail".
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n 'event.toolName === "bash"' extensions/personal-assistant/tools.ts` — outputs 0 matches
  - **依赖**: 2.4 (signature change must propagate first)

- [x] 2.6 **Update `validateSchemaShape` allowed values list**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Edit the string `"  bash, read, write, edit, list, find, grep, transfer_file"` (line 204) to `"  bash, read, write, edit, transfer_file"`.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "bash, read, write, edit" extensions/personal-assistant/tools.ts` — outputs the new 5-tool list (no `list/find/grep`)
  - **依赖**: 1.1 (schema must be updated first; otherwise client/server diverge)

- [ ] 2.7 **Update top-of-section comment for client-side guardrails**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/tools.ts` (Modify)
  - **内容**: Edit the comment at lines 170-180 that lists the 3 guardrail layers. Update layer 3 description to remove `ls/find/grep` mentions. The current text mentions `cat/ls/find/grep/sed/echo>`; update to `cat/sed -i/echo>`.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "cat/ls" extensions/personal-assistant/tools.ts` — outputs 0 matches
  - **依赖**: 2.1, 2.2

## 3. Tests

- [ ] 3.1 **Delete `local-bash-guards.test.ts`**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/test/local-bash-guards.test.ts` (Delete)
  - **内容**: Remove the entire file. Reason: local guardrail is being deleted in Task 2.5; this test file's `checkBashIntentCommon` tests with `prefix: "local"` are no longer applicable.
  - **验证**: `cd /home/qjh/workspace/personal/pi && test -f extensions/personal-assistant/test/local-bash-guards.test.ts && echo "still exists" || echo "deleted"` — outputs `deleted`
  - **依赖**: 2.5 (must come after local guardrail deletion)

- [ ] 3.2 **Update `satellite-guards.test.ts` to remove list/find/grep cases and add sentinel**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/personal-assistant/test/satellite-guards.test.ts` (Modify)
  - **内容**: 
    1. Delete the 3 test cases: `it("bash ls → suggests list", ...)`, `it("bash find → suggests find", ...)`, `it("bash grep → suggests grep", ...)` (currently lines 133-164)
    2. Update the "find as path component" and "grep as path component" tests (lines 196-229) — these test that bash with `find`/`grep` as path components is NOT intercepted. After our changes, ALL bash with `find`/`grep` anywhere is not intercepted. Rewrite the test descriptions to clarify "no longer intercepted" and update the assertion from `expect(r).toBeUndefined()` to be the same (still undefined, but the rationale changes)
    3. Add a new sentinel test: `it("bash ls/find/grep → no block (sentinel for trimmed guardrail)", ...)` that calls `validateSatelliteCall` with `tool: "bash", command: "ls /tmp"` 100 times in a loop and asserts all return undefined
    4. Update the "local and satellite budgets are independent" test — since we removed the local branch, this test no longer makes sense. Delete the corresponding test in `local-bash-guards.test.ts` (already handled by Task 3.1 deletion) and remove any satellite-side reference. If `satellite-guards.test.ts` doesn't have an "independent budgets" test, skip this sub-step.
  - **验证**: `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts` — all tests pass; the new sentinel test exists
  - **依赖**: 2.4, 2.5 (signature change must be in place)

- [ ] 3.3 **Update `satellite-schema.test.ts` to drop list/find/grep assertions and add negative test**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/test/satellite-schema.test.ts` (Modify)
  - **内容**: 
    1. In test `it("enum includes short names (read/write/edit/list/find/grep/bash/transfer_file)", ...)` (line 71), remove the 3 lines: `expect(enumValues).toContain("list");`, `expect(enumValues).toContain("find");`, `expect(enumValues).toContain("grep");`. Update test name to drop `list/find/grep`.
    2. In test `it("enum does NOT include long names", ...)` (line 84), remove the 3 lines: `expect(enumValues).not.toContain("list_dir");`, `expect(enumValues).not.toContain("find_files");`, `expect(enumValues).not.toContain("grep_files");`. Update test name to remove these mentions.
    3. In `describe("createMcpServer description ...")` block:
       - In test `it("description advertises short tool names (read/write/edit/list/find/grep)", ...)` (line 97), remove the 3 lines: `expect(DESCRIPTION).toMatch(toolRef("list"));`, `expect(DESCRIPTION).toMatch(toolRef("find"));`, `expect(DESCRIPTION).toMatch(toolRef("grep"));`. Update test name.
       - In test `it("description does NOT advertise long tool names", ...)` (line 106), remove the 3 lines: `expect(enumValues).not.toContain("list_dir");` etc. (currently lines 110-112). Update test name.
    4. In `describe("TOOL_HANDLERS ...")` block:
       - In test `it("declares short-name keys (read/write/edit/list/find/grep)", ...)` (line 122), remove the 3 lines for `list`/`find`/`grep` (lines 126-128). Update test name.
       - In test `it("does NOT declare long-name keys", ...)` (line 131), remove the 3 lines for `list_dir`/`find_files`/`grep_files` (lines 135-137). Update test name.
    5. **Add new test** in the first describe block: `it("enum does NOT include removed list/find/grep (negative)", async () => { const enumValues = extractEnumFromZodSchema(REMOTE_EXEC_INPUT_SCHEMA.shape.tool); expect(enumValues).not.toContain("list"); expect(enumValues).not.toContain("find"); expect(enumValues).not.toContain("grep"); });`
  - **验证**: `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/satellite/test/satellite-schema.test.ts` — all tests pass, including the new negative test
  - **依赖**: 1.1, 1.6 (schema and description must be updated first)

## 4. Documentation and CHANGELOG

- [ ] 4.1 **Update `extensions/satellite/README.md` tool table and Requirements section**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/README.md` (Modify)
  - **内容**: 
    1. In the tool table (around lines 188-198), delete the 3 rows: `list_dir`, `find_files`, `grep_files`. Keep `read_file`/`write_file`/`edit_file`/`bash`/`transfer_file` rows.
    2. In Requirements section (around lines 443-447), delete the 2 lines: `- fd for find_files (install: apt install fd-find)` and `- rg for grep_files (install: apt install ripgrep)`. Also check lines 229-232 (second tool table?) and remove the same rows if duplicated.
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -n "list_dir\|find_files\|grep_files" extensions/satellite/README.md` — outputs 0 matches
  - **依赖**: 1.5, 1.6 (server changes must be in place)

- [ ] 4.2 **Add `### Removed` section to satellite CHANGELOG**
  - **文件**: `/home/qjh/workspace/personal/pi/extensions/satellite/CHANGELOG.md` (Modify)
  - **内容**: Find `## [Unreleased]` section (or create it if missing). Add `### Removed` subsection with: `- Satellite \`list\`/\`find\`/\`grep\` sub-tools removed. Use \`bash\` for directory listing, file search, and content search. Client and server must be upgraded together.`
  - **验证**: `cd /home/qjh/workspace/personal/pi && grep -A 5 "## \[Unreleased\]" extensions/satellite/CHANGELOG.md | grep "### Removed"` — outputs the new section
  - **依赖**: 1.5, 1.6

- [ ] 4.3 **Add CHANGELOG entry for personal-assistant if a CHANGELOG exists**
  - **文件**: Check `/home/qjh/workspace/personal/pi/extensions/personal-assistant/CHANGELOG.md` (Modify if exists)
  - **内容**: If the file exists, add to `## [Unreleased]` section: `### Removed\n- Local bash guardrail layer (in \`extensions/personal-assistant/tools.ts\`) — local pi's default active tools don't include \`ls/grep/find\`, so the guardrail was redirecting to non-existent tools.`
  - **验证**: `cd /home/qjh/workspace/personal/pi && test -f extensions/personal-assistant/CHANGELOG.md && grep -A 3 "## \[Unreleased\]" extensions/personal-assistant/CHANGELOG.md || echo "no CHANGELOG, skip"`
  - **依赖**: 2.5

## 5. Verification

- [ ] 5.1 **Run lint + typecheck**
  - **文件**: 项目根
  - **内容**: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tee /tmp/trim-check.log`
  - **验证**: Exit code 0; no errors, no warnings, no infos. Output should mention "All pre-commit checks passed!" at the end.
  - **依赖**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7 (all code changes)

- [ ] 5.2 **Run targeted test suites**
  - **文件**: 项目根
  - **内容**: `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts extensions/satellite/test/satellite-schema.test.ts 2>&1 | tee /tmp/trim-test.log`
  - **验证**: All tests pass; sentinel test present and green
  - **依赖**: 3.1, 3.2, 3.3 (all test changes)

- [ ] 5.3 **Verify file deletion: `local-bash-guards.test.ts`**
  - **文件**: N/A
  - **内容**: `cd /home/qjh/workspace/personal/pi && test ! -f extensions/personal-assistant/test/local-bash-guards.test.ts && echo OK`
  - **验证**: Outputs `OK`
  - **依赖**: 3.1

- [ ] 5.4 **Verify no stale references to deleted symbols**
  - **文件**: 项目根
  - **内容**: `cd /home/qjh/workspace/personal/pi && grep -rn "handleListDir\|handleFindFiles\|handleGrepFiles\|runFd\|runRg\|checkFdAvailable\|checkRgAvailable\|GREP_MAX_LINE_LENGTH\|truncateLine\|MAX_LS_ENTRIES" --include="*.ts" --include="*.md" 2>&1 | head -20`
  - **验证**: 0 matches (only allowed if a file in `docs/sdd/archive/` references it for historical reasons)
  - **依赖**: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

- [ ] 5.5 **Verify no `tool:"list"/"find"/"grep"` references in any active code**
  - **文件**: 项目根
  - **内容**: `cd /home/qjh/workspace/personal/pi && grep -rn 'tool:"list"\|tool:"find"\|tool:"grep"' --include="*.ts" 2>&1 | grep -v "node_modules" | grep -v "docs/sdd/archive" | head`
  - **验证**: 0 matches in active source
  - **依赖**: 1.1, 1.6, 2.6
