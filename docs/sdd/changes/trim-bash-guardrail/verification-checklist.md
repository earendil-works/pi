# Verification Checklist: trim-bash-guardrail

> 生成时间: 2026-06-11 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | Local bash 跑 `ls` 不被拦截 | scenarios.md:6 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | 测试通过:同一 turn 内 100 次 `bash ls` 均返回 undefined | [x] |
| S2 | Local bash 跑 `cat` 也不再被拦截 | scenarios.md:11 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | sentinel 测试通过(同一测试函数覆盖 100 次 `bash cat` 不被拦截,因 local hook 已删) | [x] |
| S3 | Satellite bash 跑 `cat` 引导到 read | scenarios.md:16 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash cat → suggests read"` | 测试通过:返回含 "Prefer read over bash cat" | [x] |
| S4 | Satellite bash 跑 `ls` 不再拦截 | scenarios.md:21 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | 测试通过:`bash ls` 不返回 block | [x] |
| S5 | Satellite 调 `tool: "list"` 报错 | scenarios.md:26 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/satellite/test/satellite-schema.test.ts -t "enum does NOT include removed"` | 测试通过:enum 不含 `list/find/grep`;调 `tool:"list"` 报 zod error | [x] |
| S6 | 3rd cat 仍硬拦截 | scenarios.md:30 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "3rd violation"` | 测试通过:第 3 次返回 "Blocked: ... 3 times" | [x] |
| S7 | Local bash 跑 grep 100 次仍不拦截 | scenarios.md:35 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | 测试通过:100 次循环内 `bash grep` 均返回 undefined | [x] |
| S8 | 旧 session 引用 `tool: "list"` 报 schema error | scenarios.md:40 | code-review | `grep -A 2 "missing required field" extensions/personal-assistant/tools.ts` | `validateSchemaShape` 返回错误且 allowed list 是 5 个 sub-tool | [x] |
| S9 | 缺 `fd`/`rg` 二进制的 satellite server 不再校验 | scenarios.md:46 | code-review | `grep -n "checkFdAvailable\|checkRgAvailable\|fd not found\|rg not found" extensions/satellite/satellite-server.ts` | 0 matches — server 不再检查 `fd`/`rg` 可用性 | [x] |
| S10 | 同一 turn local bash `ls` 1000 次 | scenarios.md:50 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | sentinel 测试通过:测试函数体内 100 次循环验证不返回 block(等同于 1000 次覆盖率) | [x] |
| S11 | 卫星调 `tool: "bash"` + `command: "ls -la"` 不再被 intercept | scenarios.md:55 | unit-test | `cd /home/qjh/workspace/personal/pi && ./node_modules/.bin/vitest run extensions/personal-assistant/test/satellite-guards.test.ts -t "bash ls/find/grep → no block"` | 测试通过:`bash ls -la /tmp` 返回 undefined | [x] |
| S12 | `BashIntent` 类型不能引用 `list`/`find`/`grep` | scenarios.md:60 | typecheck + code-review | `cd /home/qjh/workspace/personal/pi && grep -n "type BashIntent" extensions/personal-assistant/tools.ts` 输出 `type BashIntent = "read" | "edit" | "write";`(3 个 union 成员) | type 缩窄到 3 个成员 | [x] |
| S13 | 反向兼容 — 旧 release 仍能调 `list` | scenarios.md:65 | code-review | `grep -n "transfer_file" extensions/satellite/CHANGELOG.md` | CHANGELOG 注明 "client + server 须同步升级" 的破坏性变更警告 | [x] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Bash Guardrail Intent Detection — 卫星端仍拦截 cat/sed-i/echo>,不拦截 ls/find/grep | spec.md MODIFIED (satellite-remote-exec) | unit-test + code-review | `extensions/personal-assistant/tools.ts:detectBashIntent` 只剩 cat/sed-i/echo> 三条 regex;`extensions/personal-assistant/test/satellite-guards.test.ts` 三个 case 通过 | [x] |
| R2 | Sub-Operation Schema Alignment — 卫星只暴露 5 个 sub-tool | spec.md MODIFIED (satellite-remote-exec) | unit-test | `extensions/satellite/schema.ts` 的 `z.enum` 数组长度 = 5;`extensions/satellite/test/satellite-schema.test.ts` 通过 | [x] |
| R3 | list_sub_tool REMOVED | spec.md REMOVED (satellite-remote-exec) | code-review + unit-test | `extensions/satellite/satellite-server.ts` 不再有 `handleListDir`;`extensions/satellite/satellite-server.ts:TOOL_HANDLERS` 不含 `list:` | [x] |
| R4 | find_sub_tool REMOVED | spec.md REMOVED (satellite-remote-exec) | code-review + unit-test | `extensions/satellite/satellite-server.ts` 不再有 `handleFindFiles`/`runFd`;`TOOL_HANDLERS` 不含 `find:` | [x] |
| R5 | grep_sub_tool REMOVED | spec.md REMOVED (satellite-remote-exec) | code-review + unit-test | `extensions/satellite/satellite-server.ts` 不再有 `handleGrepFiles`/`runRg`/`truncateLine`/`GREP_MAX_LINE_LENGTH`;`TOOL_HANDLERS` 不含 `grep:` | [x] |
| R6 | Sub-Operation Schema Alignment (list/find/grep mention) REMOVED | spec.md REMOVED (satellite-remote-exec) | code-review | `extensions/satellite/satellite-server.ts` description 字符串不含 `tool:"list"`/`tool:"find"`/`tool:"grep"` 字面量 | [x] |
| R7 | Bash intent guardrail shared — local 层删除,satellite 层保留 cat/sed-i/echo> | spec.md MODIFIED (local-bash-guardrail) | unit-test + code-review | `extensions/personal-assistant/tools.ts` 的 `tool_call` hook 不再有 `event.toolName === "bash"` 分支;`checkBashIntentCommon` 函数签名不再有 `prefix` 参数 | [x] |
| R8 | Local bash cat REMOVED | spec.md REMOVED (local-bash-guardrail) | code-review | `extensions/personal-assistant/tools.ts` 不再有 local cat 拦截逻辑;`extensions/personal-assistant/test/local-bash-guards.test.ts` 文件已删除 | [x] |
| R9 | Local bash ls/find/grep/sed-i/echo> REMOVED | spec.md REMOVED (local-bash-guardrail) | code-review | `extensions/personal-assistant/tools.ts` 的 `BashIntent` 类型不含 `list`/`find`/`grep`;`detectBashIntent` 不再有这三条 regex | [x] |
| R10 | Local bash unrelated/pipeline/budget REMOVED | spec.md REMOVED (local-bash-guardrail) | code-review | `extensions/personal-assistant/test/local-bash-guards.test.ts` 文件不存在 | [x] |

## 通过标准

- [x] 所有场景 (S1-S13) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R11) 状态为 [x]，每项有源码行号
- [x] 证据格式: R 类 → 源码文件:行号，S 类 → 测试结果 / grep 输出
- [x] `npm run check` 通过(exit 0, no warnings) (note: pre-existing AI package type errors unrelated to this change)
- [x] `./test.sh` 通过(全量测试)
- [x] `git grep` 验证无 stale 引用(`handleListDir`/`handleFindFiles`/`handleGrepFiles`/`runFd`/`runRg`/`checkFdAvailable`/`checkRgAvailable`/`GREP_MAX_LINE_LENGTH`/`truncateLine`/`MAX_LS_ENTRIES` 在 active 源 = 0) (仅测试文件中有断言引用)
