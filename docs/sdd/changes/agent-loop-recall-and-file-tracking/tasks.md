# Tasks: agent-loop-recall-and-file-tracking

> **Design:** design.md | **Base:** 2e491be758a7519761c1d32358e66d9fb4432573

**Goal:** 让 TUI `steer()` 触发记忆召回钩子,并让 bash/grep/find/ls 工具的文件操作进入压缩 summary。

**Architecture:** 复用现有 `before_agent_start` 钩子机制覆盖 steer 入口;在 `extractFileOpsFromMessage` 中加 6 个 bash regex 模式 + grep/find/ls 的 `args.path` 提取;新增 `FileOperations.deleted?: Set<string>` 字段记录 `rm` 操作。

**Tech Stack:** TypeScript, vitest, tsgo

## Notes

- **`依赖`** = execution order (consumed by `sdd-develop` DAG for parallel dispatch)
- **`前置阅读`** = context only (not execution order; orthogonal to parallelism)
- 整体采用 TDD 模式:每个实现任务前一个失败测试任务

## 1. Steer 入口触发 before_agent_start

- [ ] 1.1 **添加 steer() 触发 before_agent_start 的失败测试 (S1)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify — 在现有 describe 块新增 it)
  - **内容**: 新增测试 case "steer() 触发 before_agent_start 钩子":stub 一个扩展 handler 订阅 `before_agent_start`,调用 `harness.steer("test new topic")`,断言 handler 被调用且 `event.prompt === "test new topic"`
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*before_agent_start"` 期望 FAIL (因为还没实现)
  - **依赖**: 无
  - **前置阅读**: `packages/agent/src/harness/agent-harness.ts:679-684` (现有 steer 方法)

- [ ] 1.2 **实现 steer() 触发 before_agent_start**
  - **文件**: `packages/agent/src/harness/agent-harness.ts` (Modify)
  - **内容**: 在 `steer()` 方法内 `await this.emitHook({ type: "before_agent_start", prompt: text, images: options?.images, systemPrompt: this.systemPrompt, resources: this.resources })` 调用,放在 `this.steerQueue.push(...)` 之前。`await` 等待 hook 链完成(与 executeTurn 中现有用法一致,见 570-577 行)
  - **验证**: 重跑 1.1 中的 vitest 命令,期望 PASS
  - **依赖**: 1.1
  - **前置阅读**: `packages/agent/src/harness/agent-harness.ts:570-577` (现有 before_agent_start emit 在 executeTurn 中,作为实现参考)

- [ ] 1.3 **添加 steer 无扩展监听时不抛错测试 (S6)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增测试 "steer() 在无 before_agent_start 监听时不抛错": 不注册任何 handler,调用 `harness.steer("x")` 期望正常返回
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*no.*listener"` 期望 PASS
  - **依赖**: 1.2
  - **前置阅读**: `packages/agent/test/harness/agent-harness.test.ts:265-280` (现有 context 钩子异常测试作为模式参考)

- [ ] 1.4 **添加 steer 不影响 in-flight LLM call 测试 (S2)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增测试 "steer() 不中断当前 streaming LLM call":mock 一个慢速 streaming response,在 streaming 中调用 `harness.steer("interrupting")`,断言当前 LLM call 完成才处理 steer 消息
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*in.flight"` 期望 PASS
  - **依赖**: 1.3

- [ ] 1.5 **添加 steer 覆盖 pendingMemorySearch 测试 (S10)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增测试 "连续两次 steer 覆盖前一个 pending search":mock 一个慢速 before_agent_start handler(P1 不立即返回),第一次 steer 等 P1 完成前,第二次 steer,断言最终 `pendingMemorySearch` 反映第二次主题(P1 静默丢弃)
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*overwrite"` 期望 PASS
  - **依赖**: 1.4

- [ ] 1.6 **添加连续 5+ 次 steer 队列测试 (S13)**
  - **文件**: `packages/agent/test/harness/agent-harness.test.ts` (Modify)
  - **内容**: 新增测试 "5 次连续 steer 全部入队":连续调用 5 次 steer,断言 steerQueue.length === 5
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*multiple"` 期望 PASS
  - **依赖**: 1.5

- [ ] 1.7 **steer 修改整体回归**
  - **验证**: `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts` 全部 PASS (无回归)
  - **依赖**: 1.6

## 2. FileOperations 接口扩展 (deleted 字段)

- [ ] 2.1 **添加 FileOperations.deleted 字段 + createFileOps 初始化**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts` (Modify — interface 区域 + createFileOps 函数)
  - **内容**: 
    1. 在 `FileOperations` interface 添加 `deleted?: Set<string>` 字段(可选,向后兼容)
    2. 在 `createFileOps()` 函数返回对象中新增 `deleted: new Set<string>()`
  - **验证**: `cd packages/agent && npx tsc --noEmit -p tsconfig.json` 期望无类型错误
  - **依赖**: 无

- [ ] 2.2 **更新 computeFileLists 处理 deleted 字段 (R5)**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts:53-59` (Modify)
  - **内容**: `computeFileLists` 返回值新增 `deletedFiles: string[]` 字段,从 `fileOps.deleted` 排序而来(`fileOps.deleted ?? []` 兜底)。**v1 不在 formatFileOperations 里显示删除文件**(保持 backward 兼容);只暴露给将来 v2
  - **验证**: `cd packages/agent && npx tsc --noEmit -p tsconfig.json` 期望无类型错误
  - **依赖**: 2.1

## 3. Bash 路径提取 (6 个 regex 模式)

- [ ] 3.1 **添加 extractBashPaths 函数的失败测试**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Create)
  - **内容**: 新建测试文件。describe "extractBashPaths",6 个 it case 分别覆盖:`>` 重定向,`>>` 追加重定向,`mv` 第二参数,`cp` 第二参数,`tee` 目标,`sed -i` 目标,`rm` 删除
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "extractBashPaths"` 期望 FAIL (函数不存在)
  - **依赖**: 无
  - **前置阅读**: `packages/agent/src/harness/compaction/utils.ts:24-51` (现有 extractFileOpsFromMessage 作为模式参考)

- [ ] 3.2 **实现 extractBashPaths 函数**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts` (Modify)
  - **内容**: 添加 `extractBashPaths(command: string, fileOps: FileOperations): void` 导出函数,实现 6 个 regex 模式:
    - `/>+\s*([^\s|&;]+)/g` → `fileOps.written`
    - `/\bmv\s+\S+\s+([^\s]+)/g` → `fileOps.written`
    - `/\bcp\s+\S+\s+([^\s]+)/g` → `fileOps.written`
    - `/\btee\s+(?:-\w+\s+)?([^\s|&;]+)/g` → `fileOps.written`
    - `/\bsed\s+-i[^|;&]*\s+([^\s]+)/g` → `fileOps.edited`
    - `/\brm\s+(?:-r?\s+)?([^\s]+)/g` → `fileOps.deleted` (需 `if (fileOps.deleted)` 守卫)
    - v1 接受 ~20% 漏报,在文件顶部加注释说明
  - **验证**: 重跑 3.1 vitest 命令,期望 PASS
  - **依赖**: 3.1

- [ ] 3.3 **在 extractFileOpsFromMessage 中接入 bash case**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts:39-49` (Modify — switch 块)
  - **内容**: 在现有 `case "edit"` 之后添加 `case "bash":` 分支:从 `args.command` 提取(若为字符串),调用 `extractBashPaths(command, fileOps)`
  - **验证**: 同一测试文件添加集成测试 "extractFileOpsFromMessage 处理 bash tool call":构造 assistant message 含 `toolCall({ name: "bash", arguments: { command: "echo x > new.txt" }})`,断言 `fileOps.written.has("new.txt")`;cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts 期望 PASS
  - **依赖**: 3.2

## 4. grep/find/ls 路径提取

- [ ] 4.1 **添加 grep/find/ls 的失败测试**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Modify)
  - **内容**: describe "extractFileOpsFromMessage 工具分发",3 个 it case:grep 提取 args.path 到 fileOps.read,find 同,ls 同;以及缺省 path 不抛错
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep|find|ls"` 期望 FAIL
  - **依赖**: 3.3

- [ ] 4.2 **在 extractFileOpsFromMessage 中接入 grep/find/ls case**
  - **文件**: `packages/agent/src/harness/compaction/utils.ts:39-49` (Modify)
  - **内容**: switch 块添加 `case "grep": case "find": case "ls":` 分支(共享逻辑):若 `typeof args.path === "string"` 则 `fileOps.read.add(path)`,缺省跳过
  - **验证**: 重跑 4.1 vitest 命令,期望 PASS
  - **依赖**: 4.1

## 5. 现有 read/write/edit 回归测试

- [ ] 5.1 **添加 read/write/edit 行为不变的回归测试**
  - **文件**: `packages/agent/test/compaction/file-tracking.test.ts` (Modify)
  - **内容**: describe "read/write/edit 现有行为",3 个 it case 验证:read → fileOps.read,write → fileOps.written,edit → fileOps.edited(对应现有 utils.ts:39-49 行为)
  - **验证**: `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts` 全部 PASS
  - **依赖**: 4.2

## 6. 端到端集成测试

- [ ] 6.1 **写一个 session 含 bash + grep,验证 summary 包含正确文件**
  - **文件**: `packages/agent/test/compaction/integration.test.ts` (Create)
  - **内容**: 构造一个 session entries 列表,内含 assistant message 调用 `bash({command: "echo 'x' > /tmp/new.txt"})` 和 `grep({pattern: "TODO", path: "src"})`。调用完整 `extractFileOperations(messages, entries, -1)` 函数,断言 `readFiles` 含 `src`,`modifiedFiles` 含 `/tmp/new.txt`
  - **验证**: `cd packages/agent && npx vitest run test/compaction/integration.test.ts` 期望 PASS
  - **依赖**: 4.2

## Verification

- [ ] 全量测试: `npm test --workspace=@earendil-works/pi-agent` (确保未破其他模块)
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && npx biome check --write packages/agent/src/harness/agent-harness.ts packages/agent/src/harness/compaction/utils.ts packages/agent/test/compaction/`
- [ ] 类型检查: `cd /home/qjh/workspace/personal/pi && npm run check` (在 monorepo 根)
