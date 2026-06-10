# Tasks: agent-loop-recall-and-file-tracking

> **Design:** design.md | **Base:** 2e491be758a7519761c1d32358e66d9fb4432573

**Goal:** TUI `steer()` triggers memory recall hook; compaction tracks read/grep/find/list tools (local + satellite) and shared bash intent guardrail nudges LLM to use structured tools.

**Architecture:** Add `before_agent_start` emit in `steer()`; extend `extractFileOpsFromMessage` switch with `grep`/`find`/`list` cases plus `satellite_remote_exec` sub-tool matching; rename satellite sub-tool enum to align with local names (`read`/`write`/`edit`/`list`/`find`/`grep`); extract `checkBashIntentCommon` and add a local `bash` tool_call hook in personal-assistant.

**Tech Stack:** TypeScript, vitest, tsgo, biome

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
- **`前置阅读`** = context only (not execution order; orthogonal to parallelism)
- 整体采用 TDD 模式:每个实现任务前一个失败测试任务
- 三个 utils.ts (`packages/agent/src/harness/compaction/utils.ts` + `packages/coding-agent/src/core/compaction/utils.ts`) 同步修改

## 1. Steer 入口触发 before_agent_start

- [ ] 1.1 **steer() 触发 before_agent_start 失败测试 (S1)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增 it "steer() 触发 before_agent_start 钩子":stub 扩展 handler 订阅 `before_agent_start`,调用 `harness.steer("test new topic")`,断言 handler 被调用且 `event.prompt === "test new topic"`
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*before_agent_start"` 期望 FAIL
  - **依赖**: 无
  - **前置阅读**: `packages/agent/src/harness/agent-harness.ts:679-684`

- [ ] 1.2 **实现 steer() 触发 before_agent_start**
  - **文件**: `packages/agent/src/harness/agent-harness.ts` (Modify)
  - **内容**: 在 `steer()` 内 `await this.emitHook({ type: "before_agent_start", prompt: text, ... })`,放在 `this.steerQueue.push(...)` 之前
  - **验证**: 重跑 1.1 vitest,期望 PASS
  - **依赖**: 1.1

- [ ] 1.3 **steer 无扩展监听不抛错测试 (S6)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增 it "steer() 在无 before_agent_start 监听时不抛错"
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*no.*listener"` 期望 PASS
  - **依赖**: 1.2

- [ ] 1.4 **steer 不影响 in-flight LLM call 测试 (S2)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增 it "steer() 不中断当前 streaming LLM call"
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*in.flight"` 期望 PASS
  - **依赖**: 1.3

- [x] 1.5 **steer 覆盖 pendingMemorySearch 测试 (S10)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增 it "连续两次 steer 覆盖前一个 pending search"
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*overwrite"` 期望 PASS
  - **依赖**: 1.4

- [x] 1.6 **连续 5+ 次 steer 队列测试 (S13)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增 it "5 次连续 steer 全部入队"
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*multiple"` 期望 PASS
  - **依赖**: 1.5

- [x] 1.7 **steer 修改整体回归**
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts` 全部 PASS
  - **依赖**: 1.6

## 2. extractFileOpsFromMessage 加 grep/find/list case (本地)

- [x] 2.1 **本地 grep/find/ls 跟踪失败测试**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Create)
  - **内容**: describe "extractFileOpsFromMessage grep/find/ls",3 个 it case:grep 提取 args.path 到 fileOps.read,find 同,ls 同;缺省 path 不抛错
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep|find|ls"` 期望 FAIL
  - **依赖**: 无
  - **前置阅读**: `packages/agent/src/harness/compaction/utils.ts:24-51` + `packages/coding-agent/src/core/compaction/utils.ts:29-56` (两份)

- [x] 2.2 **实现 grep/find/ls case**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts:24-51` + `packages/coding-agent/src/core/compaction/utils.ts:29-56` (Modify 2 处)
  - **内容**: switch 块添加:
    ```ts
    case "grep":
    case "find":
    case "ls":
        fileOps.read.add(path);
        break;
    ```
  - **验证**: 重跑 2.1 vitest,期望 PASS
  - **依赖**: 2.1

## 3. Satellite 子工具改名 (read/write/edit/list/find/grep,transfer_file 不动)

- [x] 3.1 **schema + TOOL_HANDLERS 改名失败测试**
  - **文件**: `extensions/satellite/test/satellite-schema.test.ts` (Create)
  - **内容**: 测 REMOTE_EXEC_INPUT_SCHEMA 的 tool enum 包含 "read"/"write"/"edit"/"list"/"find"/"grep"(不包含 "_file"/"_dir"/"_files" 后缀);TOOL_HANDLERS key 与新名一致
  - **验证**: `cd extensions/satellite && npx vitest run test/satellite-schema.test.ts` 期望 FAIL
  - **依赖**: 无
  - **前置阅读**: `extensions/satellite/schema.ts:18-28` + `extensions/satellite/satellite-server.ts:1082-1111` + `extensions/satellite/satellite-server.ts:1118-1155` (description 文本)

- [x] 3.2 **改 schema.ts enum + TOOL_HANDLERS key + description 文本**
  - **文件**: `extensions/satellite/schema.ts` (Modify) + `extensions/satellite/satellite-server.ts:1082-1111` (Modify) + `extensions/satellite/satellite-server.ts:1118-1155` (Modify description)
  - **内容**:
    - schema.ts z.enum: `read_file`→`read`, `write_file`→`write`, `edit_file`→`edit`, `list_dir`→`list`, `find_files`→`find`, `grep_files`→`grep`, `transfer_file` 不动
    - TOOL_HANDLERS key 同步
    - createMcpServer description 里的子工具示例同步
  - **验证**: 重跑 3.1 vitest,期望 PASS
  - **依赖**: 3.1

- [x] 3.3 **personal-assistant 联动: BashIntent type + getBashGuidance 字符串** (covered by 3.2)
  - **文件**: `extensions/personal-assistant/tools.ts:273,286-302` (Modify)
  - **内容**:
    - `BashIntent` type 改名为 `read`/`edit`/`write`/`list`/`find`/`grep`
    - `getBashGuidance` 字符串里 `tool:"read_file"`→`tool:"read"` 等
  - **验证**: `cd extensions/personal-assistant && npx tsc --noEmit` 期望 0 错误
  - **依赖**: 3.2

- [x] 3.4 **现有 satellite-guards.test.ts 联动改测试断言** (covered by 3.2)
  - **文件**: `extensions/personal-assistant/test/satellite-guards.test.ts` (Modify)
  - **内容**: 所有 `tool: "list_dir"` → `tool: "list"`, `tool: "grep_files"` → `tool: "grep"`, `tool: "read_file"` → `tool: "read"` 等(line 18, 25, 38, 52, 179, 248 等)
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/satellite-guards.test.ts` 全部 PASS
  - **依赖**: 3.3

## 4. extractFileOpsFromMessage 加 satellite_remote_exec case

- [x] 4.1 **satellite_remote_exec 跟踪失败测试**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Modify)
  - **内容**: 新增 describe "extractFileOpsFromMessage satellite_remote_exec",3 个 it case:内部 tool=grep / find / ls 分别加到 fileOps.read;其他 tool (read/write/edit/bash/transfer_file) 不动
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "satellite"` 期望 FAIL
  - **依赖**: 2.2

- [x] 4.2 **实现 satellite_remote_exec case**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts:24-51` + `packages/coding-agent/src/core/compaction/utils.ts:29-56` (Modify 2 处)
  - **内容**: switch 块添加:
    ```ts
    case "satellite_remote_exec":
        if (args.tool === "grep" || args.tool === "find" || args.tool === "ls") {
            fileOps.read.add(path);
        }
        break;
    ```
  - **验证**: 重跑 4.1 vitest,期望 PASS
  - **依赖**: 4.1

## 5. read/write/edit 回归测试

- [x] 5.1 **read/write/edit 行为不变回归**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Modify)
  - **内容**: describe "read/write/edit 现有行为",3 个 it case 验证
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts` 全部 PASS
  - **依赖**: 4.2

## 6. 本地 bash intent guardrail (跨本地/Satellite 共享)

- [x] 6.1 **local-bash-guards 失败测试**
  - **文件**: `extensions/personal-assistant/test/local-bash-guards.test.ts` (Create)
  - **内容**: describe "checkBashIntentCommon local",5 个 it case:local bash cat→suggest read;ls→suggest list;find→suggest find;grep→suggest grep;local 和 satellite budget 独立
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts` 期望 FAIL
  - **依赖**: 3.4

- [x] 6.2 **提取 checkBashIntentCommon 函数**
  - **文件**: `extensions/personal-assistant/tools.ts:305-322` (Modify)
  - **内容**: 提取 `checkBashIntent(command, turnId, prefix: "local" | "satellite")` 函数,内部用 `${turnId}:${prefix}:${intent}` 作 budget key
  - **验证**: 重跑 6.1 vitest,期望 PASS
  - **依赖**: 6.1

- [x] 6.3 **validateSatelliteCall 调新函数 + 新增本地 tool_call 钩子**
  - **文件**: `extensions/personal-assistant/tools.ts:308-322` (Modify 调用) + `extensions/personal-assistant/tools.ts:943-951` (Modify 拆分钩子)
  - **内容**:
    - 原 `checkBashIntent` 改为调 `checkBashIntentCommon(..., "satellite")`
    - 原 `pi.on("tool_call")` 拆为:先判断 `toolName === "bash"` → 调 `checkBashIntentCommon(..., "local")`;再判断 `toolName === "satellite_remote_exec"` → 走 `validateSatelliteCall`
  - **验证**: `cd extensions/personal-assistant && npx vitest run test/satellite-guards.test.ts test/local-bash-guards.test.ts` 全部 PASS
  - **依赖**: 6.2

## Verification

- [ ] 全量测试: `cd packages/agent && npx vitest run` + `cd packages/coding-agent && npx vitest run test/compaction` + `cd extensions/personal-assistant && npx vitest run`
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && npx biome check --write packages/agent/src/harness/agent-harness.ts packages/agent/src/harness/compaction/ packages/coding-agent/src/core/compaction/ extensions/satellite/ extensions/personal-assistant/`
- [ ] 类型检查: `cd /home/qjh/workspace/personal/pi && npm run check` (在 monorepo 根)
