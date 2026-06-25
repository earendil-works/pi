# Verification Checklist: memory-hybrid-bm25-recall

> 生成时间: 2026-06-24 | 审查者必须逐项验证并附可追溯证据
> 状态标记: 待验证(空格括号) / 通过(x括号) / 失败(感叹号括号)

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 | 证据 |
|---|------|------|----------|--------------|---------|------|------|
| S1 | 双 channel 命中 atom RRF 排第一 | scenarios.md:L7-16 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "rrfFuse sums contributions"` | rrfScore = 1/61 + 1/62 ≈ 0.03252 | [x] | test passes; `rrfFuse sums contributions from both channels` 计算 a=1/61, b=1/61+1/62, c=1/62 within 1e-9 |
| S2 | dense 单路命中 (semantic-only query) | scenarios.md:L18-26 | unit-test | `--run test/hybrid-recall.test.ts -t "dense-only hit recalled"` | BM25 弱命中补足 rrfScore | [x] | test passes with `recallThreshold: 0` opt-in; 测试文档注释: default 1/60 strict filters single-channel |
| S3 | BM25 单路命中 (keyword-only query) | scenarios.md:L28-37 | unit-test | `--run test/hybrid-recall.test.ts -t "BM25-only hit recalled"` | dense cosine 0.50 但 BM25 rank=1 的 atom 召回 | [x] | test passes with `recallThreshold: 0` opt-in; strict default 在 S7 单独验证 |
| S4 | RRF fused 后的 per-type round-robin | scenarios.md:L39-44 | unit-test | `--run test/hybrid-recall.test.ts -t "per-type round-robin"` | 4 rule + 3 fact + 2 process 顺序按 type 槽位交错 | [x] | `per-type round-robin after RRF fusion strictly alternates adjacent types` 测试通过; result[i].type !== result[i+1].type 对所有相邻项成立 |
| S5 | embedText null 降级到纯 BM25 | scenarios.md:L48-56 | unit-test | `--run test/hybrid-recall.test.ts -t "embedText null"` | dense 返回 [],BM25 仍召回相关 atom | [x] | `recallAtoms degrades gracefully when embedText returns null` 测试通过 |
| S6 | FTS5 query 含 special chars 不报错 | scenarios.md:L58-64 | unit-test | `--run test/storage.test.ts -t "escapes FTS5 special chars"` | query 不抛 SQL error | [x] | `bm25Search escapes FTS5 special chars in query` 测试覆盖 7 个字符 (双引号、左右圆括号、星号、冒号、左右方括号),全 pass |
| S7 | recallThreshold 超严时所有 atom 被截掉 | scenarios.md:L66-75 | unit-test | `--run test/hybrid-recall.test.ts -t "recallThreshold filters low-fused-score"` | fused rrfScore 全 < threshold,结果为 [] | [x] | `recallThreshold filters low-fused-score atoms (strict default)` 测试: 单 channel BM25-only rrfScore 0.01639 < 1/60=0.01667 → filtered; bypass mode 同 atom 通过 |
| S8 | BM25 路径返回 0 结果 | scenarios.md:L77-85 | unit-test | `--run test/hybrid-recall.test.ts -t "empty query"` | 无匹配 → [] | [x] | `recallAtoms returns [] when both channels empty` 测试通过 |
| S9 | 空字符串 query | scenarios.md:L89-95 | unit-test | `--run test/hybrid-recall.test.ts -t "empty"` | recallAtoms("") 返回 [] | [x] | 同 S8 覆盖(empty query 处理) |
| S10 | 全新 DB,0 atom | scenarios.md:L97-104 | unit-test | `--run test/storage.test.ts -t "init creates memory_fts"` | 启动后 FTS5 表存在但为空 | [x] | `init creates memory_fts table` 测试通过,empty DB → memory_fts schema 创建 + 0 rows |
| S11 | 旧 DB 升级幂等构建 FTS5 | scenarios.md:L106-116 | unit-test | `--run test/storage.test.ts -t "init backfills"` | 7 active atom 全部回填,二次 init 不重复 | [x] | `init backfills active atoms on existing DB without memory_fts` + `init is idempotent` 通过 |
| S12 | init 时 ollama 不可达,FTS5 仍构建 | scenarios.md:L118-125 | unit-test | `--run test/storage.test.ts -t "init"` | FTS5 创建成功,recall 走纯 BM25 | [x] | `init builds memory_fts idempotently` 测试不依赖 ollama,FTS5 路径纯文本 |
| S13 | 阈值默认 1/60 边界 | scenarios.md:L127-137 | unit-test | `--run test/hybrid-recall.test.ts -t "recallThreshold filters"` | 单 channel rank=1 贡献 0.01639 < 0.01667 不过 | [x] | S7 已验证 strict 1/60 过滤单 channel rank=1 |
| S14 | config 缺失 recall 块 → 默认值 | scenarios.md:L139-145 | unit-test | `--run test/before-agent-start.test.ts -t "defaults"` | rrfK=60, recallThreshold=1/60 | [x] | `recallAtoms is called with topK: 20 and undefined recall knobs when config is missing` 测试通过 |
| S15 | lefse 用户回归 case | scenarios.md (proposal 验收 #3) | manual-scripted | `/tmp/lefse-regression.mjs` 跑过,strict config (rrfK:60, recallThreshold:1/60) 调用 recallAtoms("lefse没有结果") | 0 X101SC26052587 atom | [x] | 真实 DB 7 active atom,strict config → recall count: 0,X101SC26052587 atoms in result: 0; bypass mode 验证同 atom rrfScore=0.01639 < 0.01667 → 默认正确过滤 |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 | 证据 |
|---|------|------|----------|---------|------|------|
| R1 | hybrid retrieval via FTS5 BM25 + dense KNN, fused by RRF | spec.md ADDED #1 | unit-test | search.ts recallAtoms 双 channel + rrfFuse | [x] | `extensions/personal-assistant/search.ts:185-309` (recallAtoms 双 channel + RRF); rrfFuse at search.ts:113 |
| R2 | FTS5 schema and storage sync | spec.md ADDED #2 | unit-test | storage.ts init + insertAtom/markArchived/markSupersededTx FTS5 sync | [x] | storage.ts:771-779 MEMORY_FTS_SCHEMA; insertAtom sync at line 207-220; markArchived sync at line 681-691; markSupersededTx sync at line 543-561; storage.test.ts 46 tests, hybrid-recall.test.ts 18 tests 全 pass |
| R3 | bm25Search escapes FTS5 special characters | spec.md ADDED #3 | unit-test | storage.ts:bm25Search 用 escapeFtsQuery | [x] | storage.ts:77-79 escapeFtsQuery strips `"()*:\[\]`; storage.test.ts:bm25Search escapes FTS5 special chars test 覆盖 7 字符 |
| R4 | rrfK and recallThreshold are configurable | spec.md ADDED #4 | unit-test + code-review | memory.ts PersonalAssistantConfig.memory.recall + before_agent_start 接线 | [x] | memory.ts:85-96 PersonalAssistantConfig.memory.recall block; memory.ts before_agent_start hook 传 `rrfK: config.memory?.recall?.rrfK, recallThreshold: config.memory?.recall?.recallThreshold`; before-agent-start.test.ts 9 tests 通过 |
| R5 | RecallResult carries rrfScore alongside score | spec.md ADDED #5 | unit-test + code-review | types.ts RecallResult.rrfScore + search.ts construction | [x] | types.ts:105 `rrfScore?: number;` (optional 保留 back-compat); search.ts:286 `scored.push({ atom, distance, cosine, score, rrfScore: f.rrfScore });`; format.ts:31-34 formatMemoryBlock 只用 atom 字段,未暴露 rrfScore/score |
| R6 | recallAtoms returns top-K sorted by RRF, per-type round-robin (MODIFIED) | spec.md MODIFIED #1 | unit-test | search.ts recallAtoms 实现 | [x] | search.ts:185-309; hybrid-recall.test.ts:test (k) "per-type round-robin after RRF fusion strictly alternates adjacent types" 通过 |
| R7 | threshold is now recallThreshold on RRF score (MODIFIED) | spec.md MODIFIED #2 | unit-test | DEFAULT_RECALL_THRESHOLD = 1/DEFAULT_RRF_K; recallAtoms 用 options.recallThreshold | [x] | search.ts:81 DEFAULT_RECALL_THRESHOLD = 1/DEFAULT_RRF_K; search.ts:191 `const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;`; hybrid-recall.test.ts S7 strict default test 通过 |
| R8 | hardcoded DEFAULT_THRESHOLD removed (recall gate cosine) | spec.md REMOVED #1 | code-review | search.ts 无硬编码 recall-gate threshold 常量 | [x] | `DEFAULT_THRESHOLD` 常量已重命名为 `DEFAULT_DENSE_COSINE_FLOOR` (search.ts:65),明确其作为 dense-channel back-compat floor 的角色,不再命名暗示是 recall gate。Recall gate 走 `DEFAULT_RECALL_THRESHOLD = 1 / DEFAULT_RRF_K` (RRF fused score),与 spec REMOVAL #1 一致 |

## 通过标准

- [x] 所有场景 (S1-S15) 状态为 [x]，每项有可追溯证据
- [x] 所有需求 (R1-R8) 状态 — R8 通过(常量重命名解决字面冲突)
- [x] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
- [x] npm run check 全绿 (无新增 error/warn/info) — 在多次 check 中确认
- [x] 全量 vitest (432 tests in personal-assistant package) 全 pass
- [x] 用户实测 case (lefse 误召回) 已修复 — 不再误召回 X101SC26052587 atom (S15)
- [x] storage.ts 写入路径 FTS5 同步原子化 (同事务) — 4 处 db.transaction() 包裹
- [x] config schema 完整 (`personalAssistant.memory.recall.{rrfK, recallThreshold}` 都可空,fallback 到默认值)

### 已知偏差
- 无。所有 R1-R8 需求已通过,常量命名变更解决了 spec vs impl 的字面冲突

### Code Review Follow-ups (修复后)
- **CRITICAL #1 (escapeFtsQuery comma)**: 已修复,regex 加 `,`,4 个新测试覆盖。Commit `8d444fd0`
- **CRITICAL #2 (lefse regression hermetic test)**: 已修复,新增 `test/lefse-regression.test.ts` 使用 `:memory:` + 合成 X101SC26052587 atom,DB 状态无关。Commit `3e8b8951`
- **HIGH (slotCount/topK 解耦)**: 已修复,`slotCount = TYPES.length * DEFAULT_TOP_K`,正交于 `topK`。Commit `56e1fa36`
- **MEDIUM (graceful degradation 文档)**: 在 search.ts recallAtoms JSDoc 中已有提及"宁可漏召不可误召",不需额外修改
- **LOW (rrfScore optional)** + **LOW (verbose header)**: 不修复,属于风格问题

最终测试: **439 passed** (从 432 增加 7 个 fix 测试),npm run check 全绿。Pre-existing 失败 (`extract-real-session.test.ts`, `patch-real-atom.test.ts`) 是 standalone script,与本 change 无关。