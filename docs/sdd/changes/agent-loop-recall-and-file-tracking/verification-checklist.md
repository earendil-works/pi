# Verification Checklist: agent-loop-recall-and-file-tracking

> 生成时间: 2026-06-05 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | Steer 触发新主题记忆召回 | scenarios.md:L9 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*before_agent_start"` | PASS | [ ] |
| S2 | Steer 不影响 in-flight LLM call | scenarios.md:L17 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*in-flight\|steer.*queue"` | PASS | [ ] |
| S3 | Bash echo 重定向被跟踪 | scenarios.md:L27 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "bash.*redirect\|echo.*new"` | PASS（断言 `fileOps.written.has("new.txt")`） | [ ] |
| S4 | Bash mv 命令被跟踪 | scenarios.md:L33 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "bash.*mv"` | PASS（断言 `fileOps.written.has("src/new.ts")`） | [ ] |
| S5 | Grep 搜索目录被记为 read | scenarios.md:L41 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep.*path"` | PASS（断言 `fileOps.read.has("src")`，**不解析 result 内的匹配文件**） | [ ] |
| S6 | Steer 在 memory 扩展未启用时正常工作 | scenarios.md:L49 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*no.*extension\|steer.*idle"` | PASS（不抛错） | [ ] |
| S7 | Bash 命令无可识别模式 | scenarios.md:L55 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "bash.*no.*pattern\|bash.*noop"` | PASS（fileOps 大小不变） | [ ] |
| S8 | Bash 重定向路径含特殊字符 | scenarios.md:L61 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "bash.*special.*char\|bash.*space"` | PASS（v1 取首 token，不抛错） | [ ] |
| S9 | Grep 输出格式异常 | scenarios.md:L67 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep.*malformed\|grep.*no.*path"` | PASS（因不解析 result，缺省 path 不抛错） | [ ] |
| S10 | 之前 pendingMemorySearch 未消费,steer 覆盖 | scenarios.md:L73 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*overwrite\|pending.*replace"` | PASS（旧 promise 静默丢弃） | [ ] |
| S11 | Bash 输出在 `>` 后是变量而非字面路径 | scenarios.md:L81 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "bash.*variable\|\$.*output"` | PASS（v1 取字面 `$OUTPUT_FILE`，不抛错） | [ ] |
| S12 | 第一次 `before_agent_start` 还未消费,steer 立即再次 | scenarios.md:L87 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*rapid\|steer.*consecutive"` | PASS（最终 memory 反映最后一次主题） | [ ] |
| S13 | Steer 队列有 5+ 条消息 | scenarios.md:L93 | 单元测试 | `cd packages/agent && npx vitest run test/harness/agent-harness.test.ts -t "steer.*multiple\|steer.*batch"` | PASS（5 条消息依次 push，只有最新 memory 被消费） | [ ] |
| S14 | Grep 输出 > 50KB (truncate 后) | scenarios.md:L99 | 单元测试 | `cd packages/agent && npx vitest run test/compaction/file-tracking.test.ts -t "grep.*truncat"` | PASS（v1 不解析 result，truncation 不影响 fileOps；`args.path` 仍加到 read） | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Steer triggers before_agent_start | specs/agent-harness-steering/spec.md MODIFIED #1 | 代码审查 + 单元测试 | `agent-harness.ts:679-684` 含 `await this.emitHook("before_agent_start", { prompt: text, ... })`；S1-S2, S6, S10, S13 测试通过 | [ ] |
| R2 | Compaction tracks bash file operations via regex | specs/compaction-file-tracking/spec.md MODIFIED #1 | 代码审查 + 单元测试 | `compaction/utils.ts` 含 6 个 regex 模式；S3-S4, S7-S11 测试通过 | [ ] |
| R3 | Compaction tracks grep/find/ls search directories as read | specs/compaction-file-tracking/spec.md MODIFIED #2 | 代码审查 + 单元测试 | `compaction/utils.ts` switch 块含 `case "grep"/"find"/"ls"`；S5, S9, S14 测试通过 | [ ] |
| R4 | read/write/edit tool tracking unchanged | specs/compaction-file-tracking/spec.md MODIFIED #3 | 单元测试（回归） | 现有 3 个 case 行为不变（任务 5.1 测试通过） | [ ] |
| R5 | FileOperations interface supports optional deleted set | specs/compaction-file-tracking/spec.md MODIFIED #4 | 代码审查 + 单元测试 | `compaction/utils.ts` `FileOperations` interface 含 `deleted?: Set<string>`；`createFileOps()` 初始化该 Set | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S14) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R5) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → vitest 输出 (PASS 行)
- [ ] `npm run check` 在 monorepo 根通过
- [ ] 没有引入新的运行时依赖
