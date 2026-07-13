# Verification Checklist: agent-driven-memory-save

> 生成时间: 2026-07-10 | 审查者必须逐项验证并附可追溯证据
> 状态说明: 空白=待验证 / x=通过 / bang=失败(必须修复或记录偏差)
> Reviewer verdict: APPROVE (0 CRITICAL, 3 IMPORTANT fixed in d40883f69, 4 MINOR documented)

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 | 证据 |
|---|------|------|----------|--------------|---------|------|------|
| S1 | agent 主动新增 atom (无 id, fingerprint 不命中) | scenarios.md:L26 | 单元测试 | `memory-save-tool.test.ts` "memory_save execute" "create path" | DB 1 row;`.md` 写;`reindexOne` 调用;`action === "created"` | [x] | extensions/personal-assistant/test/memory-save-tool.test.ts:1180-1238; memory-save.ts:430-447 |
| S2 | agent fingerprint 命中已有 atom (无 id, 重复内容) | scenarios.md:L33 | 单元测试 | `memory-save-tool.test.ts` "skip path" | `action === "skipped"` `existing_id` 与 DB 一致;无 row 新增;`.md` 未写 | [x] | memory-save-tool.test.ts:1283-1340; memory-save.ts:344-365 |
| S3 | agent overwrite 已有 atom (id 复用, in-place update) | scenarios.md:L40 | 单元测试 | `memory-save-tool.test.ts` "overwrite path" | `action === "updated"`;`.md` 内容覆盖;`version + 1` | [x] | memory-save-tool.test.ts:1393-1455; memory-save.ts:323-340 |
| S4 | safety net 在 agent save ≥ 1 时跳过 | scenarios.md:L48 | 单元测试 | `memory-save-tool.test.ts` "session_before_compact safety net" "skipped when count >= 1" | `runCompactExtraction` 未调;hook 返回 `undefined` | [x] | memory-save-tool.test.ts:660-690; memory.ts:359-380 |
| S5 | safety net 在 0 save 时跑抽取 | scenarios.md:L55 | 单元测试 | `memory-save-tool.test.ts` "invokes runCompactExtraction when count == 0" | `runCompactExtraction` 被调;返回 `undefined` | [x] | memory-save-tool.test.ts:692-735; memory.ts:362-378 |
| S6 | TUI 与 webui 通过同一 recallPipeline 召回 | scenarios.md:L62 | 单元测试 | `recall-pipeline.test.ts` + `memory-routes.test.ts` | TUI mock 与 webui mock 都调 `recallPipeline` | [x] | recall.ts:191-329; memory.ts:871; routes/memory.ts:932; codegraph_callers recallPipeline → 2 callers |
| S7 | agent 提供 id 但 DB 不存在 | scenarios.md:L70 | 单元测试 | `memory-save-tool.test.ts` "id_not_found path" | `action === "error"` `error === "id_not_found"` | [x] | memory-save-tool.test.ts:1493-1545; memory-save.ts:251-261 |
| S8 | 嵌入服务不可达 (15s 超时或 ECONNREFUSED) | scenarios.md:L78 | 单元测试 | `memory-save-tool.test.ts` "graceful fallback" | `embedding === "skipped"`;DB 1 row;vector = zero vector | [x] | memory-save-tool.test.ts:1248-1280; memory-save.ts:316-330,419-421 |
| S9 | agent 用 `write` 工具直接落盘 atom 文件 | scenarios.md:L87 | 单元测试 | `tool_call blocks write to atoms/process/foo.md` | mock `write` execute 未调;hook 返回 `{block: true, ...}` | [x] | memory-save-tool.test.ts:1554-1584; tools.ts:1065-1075 |
| S10 | agent 用 `bash` heredoc 写 atom 文件 | scenarios.md:L94 | 单元测试 | `tool_call blocks bash redirect to atoms` | mock `bash` execute 未调 | [x] | memory-save-tool.test.ts:1645-1690; tools.ts:1076-1085 |
| S11 | agent `read` 已有 atom 文件 (合法路径, hook 不拦截) | scenarios.md:L101 | 单元测试 | `tool_call does not block read of atoms/...` | mock `read` execute 被调;hook 返回 `undefined` | [x] | memory-save-tool.test.ts:1604-1644; tools.ts:1086-1095 |
| S12 | writer 自洽 (writeAtomToFile 自身不触发 hook) | scenarios.md:L108 | 代码审查 | grep `memory-save.ts` 中 `writeAtomToFile` 调用 | `writeAtomToFile` 直接 `fs.writeFile`;无 `pi.on("tool_call")` 拦截 | [x] | memory-save.ts:324,431; file-store.ts (写 fs 直接); codegraph_callers writeAtomToFile = 6 (含 registerMemorySave),都不经 tool_call |
| S13 | safety net 抽取失败 | scenarios.md:L115 | 单元测试 | `memory-save-tool.test.ts` "safety net graceful on extraction failure" | `notifySafely` type="warn";hook 返回 `undefined`;无 `cancel: true` | [x] | memory-save-tool.test.ts:892-928; memory.ts:362-378 |
| S14 | webui 调用 recallPipeline 时 bge-m3 服务挂掉 | scenarios.md:L122 | 单元测试 | `memory-routes.test.ts` "embedding service down" | mock fetch ECONNREFUSED;`status.embeddingServiceStatus === "down"` | [x] | memory-routes.test.ts:1990-2080; recall.ts:153-180; routes/memory.ts:932 |
| S15 | TUI context hook 中 recallPipeline 全部退化 | scenarios.md:L129 | 单元测试 | `recall-pipeline.test.ts` "recallPipeline all fallback" | mock hybridSearch 返 [] + rerank fallback;`results: []`;pipeline 不抛 | [x] | recall-pipeline.test.ts:567-625; recall.ts:200-329 |
| S16 | importance 边界值 0 与 1 | scenarios.md:L137 | 单元测试 | `memory-save-tool.test.ts` "importance boundaries" | importance=0 与 1 都通过 TypeBox 校验,落库正确 | [x] | memory-save-tool.test.ts:280-320; memory-save.ts:130-140 |
| S17 | title 长度 200 边界 | scenarios.md:L144 | 单元测试 | `memory-save-tool.test.ts` "title boundary" | title=1/100/200 通过;201 拒绝 | [x] | memory-save-tool.test.ts:322-360; memory-save.ts:115-118 |
| S18 | content 极短(< 10 字符) | scenarios.md:L150 | 单元测试 | `memory-save-tool.test.ts` "content_too_short" | content="x" 返回 `error: "content_too_short"` | [x] | memory-save-tool.test.ts:362-405; memory-save.ts:122-125 |
| S19 | tags 数组为空 vs 字段缺失 | scenarios.md:L156 | 单元测试 | `memory-save-tool.test.ts` "tags empty vs absent" | 两种等价:落库 `tags=[]` | [x] | memory-save-tool.test.ts:407-455; memory-save.ts:142-148 |
| S20 | type 不在白名单 | scenarios.md:L162 | 单元测试 | `memory-save-tool.test.ts` "invalid_type" | type="opinion" 返回 `error: "invalid_type"` | [x] | memory-save-tool.test.ts:248-260; memory-save.ts:100-110 |
| S21 | agent 短时间多次 save (counter 累积) | scenarios.md:L168 | 单元测试 | `memory-save-tool.test.ts` "counter increments on each execute" | 5 次调用(混合 outcome) → counter=5 | [x] | memory-save-tool.test.ts:1185-1238, 1285-1340, 1394-1455, 1493-1545; memory-save.ts:220 |
| S22 | segment 内先 save 后 compact (中间无任何 save) | scenarios.md:L175 | 单元测试 | `memory-save-tool.test.ts` "counter survives between turns" | turn 1-3 调 3 次 save;turn 4-10 无 save;turn 11 compact;counter=3 (未 reset) → 跳过抽取 | [x] | memory-save-tool.test.ts:697-735; memory.ts:609 (session_start reset) + 727 (session_compact reset) — counter NOT in before_agent_start |
| S23 | tool_call hook 高频调用性能 | scenarios.md:L182 | 代码审查 | grep `tools.ts` path guard 分支 | 仅字符串正则匹配;无 fs / network I/O | [x] | tools.ts:1046-1100 — 纯正则 `test()` 调用,无 I/O |
| S24 | webui 调 recallPipeline 时 `recent` 字段缺失 | scenarios.md:L189 | 单元测试 | `recall-pipeline.test.ts` "forwards null to rewriteQueries when recent is omitted" + `memory-routes.test.ts` "webui recent absent → null" | `recallPipeline(index, {recent: undefined, ...})` → 内部用 `null` | [x] | recall-pipeline.test.ts:120-165; memory-routes.test.ts:2080-2110; recall.ts:200-220 |
| S25 | recallPipeline 的 topK 参数边界 | scenarios.md:L196 | 单元测试 | `recall-pipeline.test.ts` "topK clamp" | topK=200 → 100; topK=0 → 1; undefined → 20 | [x] | recall-pipeline.test.ts:441-540; recall.ts:184-189 |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 | 证据 |
|---|------|------|----------|---------|------|------|
| R1 | memory_save tool exposes three write outcomes | spec/agent-memory-write-tool ADDED #1 | 代码审查 | `memory-save.ts` 含 create / updated / skipped 三分支 | [x] | memory-save.ts:328 (`action: "updated"`), 435 (`action: "created"`), 354-365 (`action: "skipped"`) + id_not_found at 260 |
| R2 | memory_save validates input via TypeBox schema | spec/agent-memory-write-tool ADDED #2 | 代码审查 + 单元测试 | `MemorySaveParams` TypeBox;type/content_too_short 分支 | [x] | memory-save.ts:99-150 (TypeBox schema); 19 校验测试全通过 |
| R3 | memory_save gracefully falls back to zero vector when embed service is unavailable | spec/agent-memory-write-tool ADDED #3 | 单元测试 | `memory-save-tool.test.ts: embedding down` | [x] | memory-save.ts:316-330, 419-421; 47/47 pass |
| R4 | agent save counter increments on every memory_save call | spec/agent-memory-write-tool ADDED #4 | 单元测试 | `memory-save-tool.test.ts: counter increments` | [x] | memory-save.ts:220 (hoisted increment); 4 outcome paths 都增 counter (test lines 1185, 1285, 1394, 1493) |
| R5 | session_start + session_compact resets segment save counter (NOT before_agent_start) | spec/agent-memory-write-tool ADDED #5 | 单元测试 | `memory-save-tool.test.ts: session boundaries reset counter` + "before_agent_start does NOT reset" | [x] | memory-save-tool.test.ts:740-800 (session_start/session_compact reset) + 880-910 (before_agent_start no reset); memory.ts:609, 727 |
| R6 | tool_call hook blocks direct file writes to memory atoms | spec/agent-memory-write-tool ADDED #6 | 单元测试 + 代码审查 | 5 个 tool_call path guard 测试通过;`tools.ts:934` 含 write/edit/bash | [x] | tools.ts:1065-1085 (write/edit + bash guards); 8 tool_call 测试通过 |
| R7 | session_before_compact is a graceful safety net | spec/agent-memory-write-tool ADDED #7 | 单元测试 | 3 个 safety net 测试通过;`memory.ts:336` graceful skip | [x] | memory.ts:359-378 (graceful skip + notify warn); memory-save-tool.test.ts:660-735 + 892-928 |
| R8 | before_agent_start system prompt informs agent about memory_save | spec/agent-memory-write-tool ADDED #8 | 单元测试 | `memory-save-tool.test.ts: before_agent_start system prompt contains memory section` | [x] | tools.ts:920+ (promptSnippet); memory-save-tool.test.ts:1075-1120 |
| R9 | shared `recallPipeline` is the single recall entry point | spec/tui-webui-recall-parity ADDED #1 | 代码审查 + 单元测试 | grep `memory.ts` + `routes/memory.ts` 调 `recallPipeline`;无 inline 残留 | [x] | memory.ts:871 + routes/memory.ts:932; codegraph_callers recallPipeline = 2 (TUI + webui only); 30 pipeline 测试通过 |
| R10 | recallPipeline accepts `recent` for anaphora resolution | spec/tui-webui-recall-parity ADDED #2 | 单元测试 | `recall-pipeline.test.ts` 4 个 recent 测试 + `memory-routes.test.ts` 3 个 webui recent 测试 | [x] | recall.ts:200-220; 7 recent 测试通过 |
| R11 | recallPipeline default `topK` is 20 | spec/tui-webui-recall-parity ADDED #3 | 单元测试 | `recall-pipeline.test.ts: topK default 20` + `memory-routes.test.ts: webui topK default 20` | [x] | recall.ts:184-189 (clamp + default 20); 测试通过 |
| R12 | recallPipeline exposes pipeline timing and status metadata | spec/tui-webui-recall-parity ADDED #4 | 单元测试 | `recall-pipeline.test.ts` 4 个 status 测试 | [x] | recall.ts:279-340 (status aggregation); 4 status 测试通过 |
| R13 | webui response shape preserved with pipeline metadata | spec/tui-webui-recall-parity ADDED #5 | 单元测试 | `memory-routes.test.ts` 2 个 response shape 测试 | [x] | routes/memory.ts:935-1010 (response shape with status); 2 测试通过 |

## 通过标准

- [x] 所有场景 (S1-S25) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R13) 状态为 [x]，每项有源码行号
- 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果

## Summary

- **Test results** (fresh, against HEAD `d40883f69`):
  - extensions/personal-assistant/test/recall-pipeline.test.ts: **30/30** pass
  - extensions/personal-assistant/test/memory-save-tool.test.ts: **47/47** pass
  - extensions/personal-assistant/test/context-inject.test.ts: **7/7** pass
  - extensions/personal-assistant/test/session-before-compact.test.ts: **12/12** pass
  - packages/webui/server/test/memory-routes.test.ts: **88/91** pass (3 pre-existing environmental fails)
  - extensions/personal-assistant/test/extraction.test.ts + oldId + prompt: **55/55** pass
  - Full `./test.sh`: **2416 / 2416 + 3 pre-existing + 1 pre-existing** (no regressions from this change)
- **Code review**: APPROVE with 0 CRITICAL, 3 IMPORTANT fixed in d40883f69, 4 MINOR deferred (documented follow-up)
- **Branch**: agent-driven-memory-save (clean, only my files staged; other sessions' modifications preserved untouched)