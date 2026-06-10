# Verification Checklist: agent-loop-recall-and-file-tracking

> 生成时间: 2026-06-10 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | Steer 触发新主题记忆召回 | scenarios.md:L9 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*before_agent_start"` | PASS | [ ] |
| S2 | Steer 不影响 in-flight LLM call | scenarios.md:L17 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*in.flight"` | PASS | [ ] |
| S6 | Steer 在 memory 扩展未启用时正常工作 | scenarios.md | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*no.*listener"` | PASS | [ ] |
| S10 | 之前 pendingMemorySearch 未消费,steer 覆盖 | scenarios.md | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*overwrite"` | PASS | [ ] |
| S13 | Steer 队列有 5+ 条消息 | scenarios.md | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*multiple"` | PASS | [ ] |
| S14 | Local grep 路径被跟踪为 read | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep.*path"` | PASS（`fileOps.read.has("src")`） | [ ] |
| S15 | Local find 路径被跟踪为 read | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "find.*path"` | PASS | [ ] |
| S16 | Local ls 路径被跟踪为 read | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "ls.*path"` | PASS | [ ] |
| S17 | Local grep 无 path 不抛错 | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep.*no.*path"` | PASS | [ ] |
| S18 | Satellite remote_exec(tool=grep) 路径被跟踪为 read | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "satellite"` | PASS（`fileOps.read.has("src")`） | [ ] |
| S19 | Satellite remote_exec(tool=read/write/edit/bash/transfer_file) 不进 fileOps | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "satellite.*read|satellite.*write"` | PASS | [ ] |
| S20 | read/write/edit 行为不变 (回归) | scenarios.md (本 change) | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "read.*write.*edit"` | PASS | [ ] |
| S21 | Satellite schema enum 包含 read/write/edit/list/find/grep | scenarios.md (本 change) | 单元测试 | `cd extensions/satellite && npx vitest run test/satellite-schema.test.ts` | PASS | [ ] |
| S22 | Satellite TOOL_HANDLERS key 与新名一致 | scenarios.md (本 change) | 单元测试 | 同上 | PASS | [ ] |
| S23 | Local bash cat → suggest read | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts -t "cat"` | PASS | [ ] |
| S24 | Local bash ls → suggest list | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts -t "ls"` | PASS | [ ] |
| S25 | Local bash find → suggest find | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts -t "find"` | PASS | [ ] |
| S26 | Local bash grep → suggest grep | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts -t "grep"` | PASS | [ ] |
| S27 | Local 和 satellite bash budget 独立 | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/local-bash-guards.test.ts -t "budget.*indep"` | PASS | [ ] |
| S28 | 现有 satellite-guards 测试在子工具改名后仍 PASS | scenarios.md (本 change) | 单元测试 | `cd extensions/personal-assistant && npx vitest run test/satellite-guards.test.ts` | PASS | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Steer triggers before_agent_start | specs/agent-harness-steering/spec.md MODIFIED #1 | 代码审查 + 单元测试 | `agent-harness.ts:679-684` 含 `await this.emitHook("before_agent_start", { prompt: text, ... })`；S1-S2, S6, S10, S13 测试通过 | [ ] |
| R2 | Compaction tracks grep/find/ls as read (本地) | specs/compaction-file-tracking/spec.md MODIFIED #2 | 代码审查 + 单元测试 | `compaction/utils.ts` switch 块含 `case "grep"/"find"/"ls"`;S14-S17, S20 测试通过 | [ ] |
| R3 | Compaction tracks satellite_remote_exec sub-tool as read | specs/compaction-file-tracking/spec.md MODIFIED #3 | 代码审查 + 单元测试 | `compaction/utils.ts` switch 块含 `case "satellite_remote_exec"` + args.tool 检查;S18-S19 测试通过 | [ ] |
| R4 | read/write/edit 工具跟踪不变 (回归) | specs/compaction-file-tracking/spec.md MODIFIED #4 | 单元测试（回归）| 现有 3 个 case 行为不变;S20 测试通过 | [ ] |
| R5 | Satellite sub-tool names align with local tools | specs/compaction-file-tracking/spec.md MODIFIED #5 | 代码审查 + 单元测试 | `extensions/satellite/schema.ts` z.enum 包含 "read"/"write"/"edit"/"list"/"find"/"grep",`TOOL_HANDLERS` key 同步;S21-S22 测试通过 | [ ] |
| R6 | Bash intent guardrail 跨本地 + Satellite 共享 | specs/local-bash-guardrail/spec.md ADDED #1 | 代码审查 + 单元测试 | `extensions/personal-assistant/tools.ts` `checkBashIntentCommon` 提取,新增本地 `pi.on("tool_call")` 钩子,budget prefix 分键;S23-S28 测试通过 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S28) 状态为 [x],每项有可追溯证据
- [ ] 所有需求 (R1-R6) 状态为 [x],每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号,S 类 → vitest 输出 (PASS 行)
- [ ] `npm run check` 在 monorepo 根通过
- [ ] 没有引入新的运行时依赖
