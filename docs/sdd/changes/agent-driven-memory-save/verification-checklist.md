# Verification Checklist: agent-driven-memory-save

> 生成时间: 2026-07-10 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | agent 主动新增 atom (无 id, fingerprint 不命中) | scenarios.md:L26 | 单元测试 | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/memory-save-tool.test.ts` 中 `memory_save create fingerprint miss` | DB `memory_index` 1 row;`.md` 文件存在;`reindexOne` 被调用;`details.action === "created"` | [ ] |
| S2 | agent fingerprint 命中已有 atom (无 id, 重复内容) | scenarios.md:L33 | 单元测试 | 同上 `memory_save fingerprint hit skip` | `details.action === "skipped"` `details.existing_id` 与 DB 行 id 一致;DB 无新增 row;`.md` 未写 | [ ] |
| S3 | agent overwrite 已有 atom (id 复用, in-place update) | scenarios.md:L40 | 单元测试 | 同上 `memory_save overwrite id exists` | `details.action === "updated"`;旧 `.md` 内容覆盖;`memory_index.version + 1` | [ ] |
| S4 | safety net 在 agent save ≥ 1 时跳过 | scenarios.md:L48 | 单元测试 | 同上 `safety net skipped when count >= 1` | mock `runCompactExtraction` 未被调用;hook 返回 `undefined` | [ ] |
| S5 | safety net 在 0 save 时跑抽取 | scenarios.md:L55 | 单元测试 | 同上 `safety net runs when count == 0` | `runCompactExtraction` 被调用;返回 `undefined` | [ ] |
| S6 | TUI 与 webui 通过同一 recallPipeline 召回 | scenarios.md:L62 | 单元测试 | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/recall-pipeline.test.ts` + `cd packages/webui/server && node ../../../node_modules/vitest/dist/cli.js --run test/memory-routes.test.ts` | TUI mock 与 webui mock 都调用 `recallPipeline`;两个 mock 都用同一函数签名 | [ ] |
| S7 | agent 提供 id 但 DB 不存在 | scenarios.md:L70 | 单元测试 | `memory_save overwrite id not found` | `details.action === "error"` `details.error === "id_not_found"` | [ ] |
| S8 | 嵌入服务不可达 (15s 超时或 ECONNREFUSED) | scenarios.md:L78 | 单元测试 | `memory_save embedding down` | `details.embedding === "skipped"`;DB 1 row;vector = zero vector | [ ] |
| S9 | agent 用 `write` 工具直接落盘 atom 文件 | scenarios.md:L87 | 单元测试 | `tool_call blocks write to atoms/process/foo.md` | mock `write` execute 未被调用;hook 返回 `{block: true, reason: ...}` | [ ] |
| S10 | agent 用 `bash` heredoc 写 atom 文件 | scenarios.md:L94 | 单元测试 | `tool_call blocks bash redirect to atoms` | mock `bash` execute 未被调用 | [ ] |
| S11 | agent `read` 已有 atom 文件 (合法路径, hook 不拦截) | scenarios.md:L101 | 单元测试 | `tool_call does not block read of atoms/...` | mock `read` execute 被调用;hook 返回 `undefined` | [ ] |
| S12 | writer 自洽 (writeAtomToFile 自身不触发 hook) | scenarios.md:L108 | 代码审查 | grep `extensions/personal-assistant/memory-save.ts` 中 `writeAtomToFile` 调用确认不经 `tool_call` 事件 | `writeAtomToFile` 直接调 `fs.writeFile`;无 `pi.on("tool_call", ...)` 拦截 | [ ] |
| S13 | safety net 抽取失败 | scenarios.md:L115 | 单元测试 | `safety net graceful on extraction failure` | `notifySafely` 被调用且 type="warn";hook 返回 `undefined`;无 `cancel: true` | [ ] |
| S14 | webui 调用 recallPipeline 时 bge-m3 服务挂掉 | scenarios.md:L122 | 单元测试 | webui `embedding service status from pipeline` + `embedding service down surfaces status` | mock fetch 抛 ECONNREFUSED;`status.embeddingServiceStatus === "down"`;响应字段包含 `embeddingServiceStatus: "down"` | [ ] |
| S15 | TUI context hook 中 recallPipeline 全部退化 | scenarios.md:L129 | 单元测试 | `recallPipeline all fallback` | mock hybridSearch 返 [] + rerank fallback;`results: []`;pipeline 不抛 | [ ] |
| S16 | importance 边界值 0 与 1 | scenarios.md:L137 | 单元测试 | `memory_save importance boundary` | importance=0 与 1 都通过 TypeBox 校验,落库正确 | [ ] |
| S17 | title 长度 200 边界 | scenarios.md:L144 | 单元测试 | `memory_save title boundary` | title=1/100/200 通过;201 拒绝 | [ ] |
| S18 | content 极短(< 10 字符) | scenarios.md:L150 | 单元测试 | `memory_save content_too_short` | content="x" 返回 `error: "content_too_short"` | [ ] |
| S19 | tags 数组为空 vs 字段缺失 | scenarios.md:L156 | 单元测试 | `memory_save tags empty vs absent` | 两种等价:落库 `tags=[]` | [ ] |
| S20 | type 不在白名单 | scenarios.md:L162 | 单元测试 | `memory_save invalid_type` | type="opinion" 返回 `error: "invalid_type"` | [ ] |
| S21 | agent 短时间多次 save (counter 累积) | scenarios.md:L168 | 单元测试 | `segment counter increments on each execute` | 5 次调用(混合 outcome) → counter=5 | [ ] |
| S22 | segment 内先 save 后 compact (中间无任何 save) | scenarios.md:L175 | 单元测试 | `safety net counter survives between turns` | turn 1-3 调 3 次 save;turn 4-10 无 save;turn 11 触发 compact;counter=3 (未 reset,因 reset 在 session_compact) → 跳过抽取 | [ ] |
| S23 | tool_call hook 高频调用性能 | scenarios.md:L182 | 代码审查 | grep `extensions/personal-assistant/tools.ts` 中 path guard 分支;确认无重型 I/O | 仅字符串正则匹配;无 fs / network I/O | [ ] |
| S24 | webui 调 recallPipeline 时 `recent` 字段缺失 | scenarios.md:L189 | 单元测试 | `recallPipeline recent null` + `webui recent absent → null` | `recallPipeline(index, {recent: undefined, ...})` → 内部用 `null` 调 rewriteQueries | [ ] |
| S25 | recallPipeline 的 topK 参数边界 | scenarios.md:L196 | 单元测试 | `recallPipeline topK clamp` | topK=200 → 100; topK=0 → 1; undefined → 20 | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | memory_save tool exposes three write outcomes | spec/agent-memory-write-tool ADDED #1 | 代码审查 | `extensions/personal-assistant/memory-save.ts` 含 create / updated / skipped 三分支返回 | [ ] |
| R2 | memory_save validates input via TypeBox schema | spec/agent-memory-write-tool ADDED #2 | 代码审查 + 单元测试 | `MemorySaveParams` TypeBox 定义;type/invalid_importance/content_too_short 三个分支 | [ ] |
| R3 | memory_save gracefully falls back to zero vector when embed service is unavailable | spec/agent-memory-write-tool ADDED #3 | 单元测试 | `memory-save-tool.test.ts: memory_save embedding down` 测试通过 | [ ] |
| R4 | agent save counter increments on every memory_save call | spec/agent-memory-write-tool ADDED #4 | 单元测试 | `memory-save-tool.test.ts: segment counter increments on each execute` 测试通过 | [ ] |
| R5 | before_agent_start resets the segment save counter | spec/agent-memory-write-tool ADDED #5 | 单元测试 | `memory-save-tool.test.ts: before_agent_start resets segment counter` 测试通过 | [ ] |
| R6 | tool_call hook blocks direct file writes to memory atoms | spec/agent-memory-write-tool ADDED #6 | 单元测试 + 代码审查 | `memory-save-tool.test.ts` 5 个 tool_call path guard 测试通过;`tools.ts:934` 含 write/edit/bash 三个分支 | [ ] |
| R7 | session_before_compact is a graceful safety net | spec/agent-memory-write-tool ADDED #7 | 单元测试 | `memory-save-tool.test.ts` 3 个 safety net 测试通过;`memory.ts:336` 改 graceful skip | [ ] |
| R8 | before_agent_start system prompt informs agent about memory_save | spec/agent-memory-write-tool ADDED #8 | 单元测试 | `memory-save-tool.test.ts: before_agent_start system prompt contains memory section` 测试通过 | [ ] |
| R9 | shared `recallPipeline` is the single recall entry point | spec/tui-webui-recall-parity ADDED #1 | 代码审查 + 单元测试 | grep `memory.ts` 与 `routes/memory.ts` 中 `recallPipeline` 调用;无 inline rewriteQueries / recallAtoms / rerankAndFilter / mergeByRerankScore 调用残留 | [ ] |
| R10 | recallPipeline accepts `recent` for anaphora resolution | spec/tui-webui-recall-parity ADDED #2 | 单元测试 | `recall-pipeline.test.ts` 4 个 recent 测试通过;`memory-routes.test.ts` 3 个 webui recent 测试通过 | [ ] |
| R11 | recallPipeline default `topK` is 20 | spec/tui-webui-recall-parity ADDED #3 | 单元测试 | `recall-pipeline.test.ts: topK default 20` + `memory-routes.test.ts: webui topK default 20` 测试通过 | [ ] |
| R12 | recallPipeline exposes pipeline timing and status metadata | spec/tui-webui-recall-parity ADDED #4 | 单元测试 | `recall-pipeline.test.ts` 4 个 status 测试通过 | [ ] |
| R13 | webui response shape preserved with pipeline metadata | spec/tui-webui-recall-parity ADDED #5 | 单元测试 | `memory-routes.test.ts` 2 个 response shape 测试通过 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S25) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R13) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果