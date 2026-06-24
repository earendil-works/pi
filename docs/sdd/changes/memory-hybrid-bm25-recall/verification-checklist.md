# Verification Checklist: memory-hybrid-bm25-recall

> 生成时间: 2026-06-24 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

<!--
每个 scenario → 1 个 S 条目。
验证方式推断规则:
  - 含 /api/ HTTP/curl/请求 → curl
  - 含 点击/页面/UI/表单/按钮 → chrome-devtools
  - 含 hash/加密/存储 → 代码审查
  - 含 npm test/pytest/cargo test → 单元测试
  - 无法自动验证 → 手动标记
-->

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 双 channel 命中 atom RRF 排第一 | scenarios.md:L7-16 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "rrfFuse sums contributions"` | test passes; rrfScore 精确计算 1/61 + 1/62 ≈ 0.03252 | [ ] |
| S2 | dense 单路命中 (semantic-only query) | scenarios.md:L18-26 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "dense-only hit recalled"` | atom 仍能进 top-9,BM25 弱命中补足 rrfScore | [ ] |
| S3 | BM25 单路命中 (keyword-only query) | scenarios.md:L28-37 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "BM25-only hit recalled"` | dense cosine 0.50 但 BM25 rank=1 的 atom 召回 | [ ] |
| S4 | RRF fused 后的 per-type round-robin | scenarios.md:L39-44 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "per-type round-robin"` | 4 rule + 3 fact + 2 process 顺序按 type 槽位交错 | [ ] |
| S5 | embedText null 降级到纯 BM25 | scenarios.md:L48-56 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "embedText null degrades"` | dense 返回 [],BM25 仍召回相关 atom | [ ] |
| S6 | FTS5 query 含 special chars 不报错 | scenarios.md:L58-64 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "bm25Search escapes special chars"` | query 'lefse "没有" 结果' 不抛 SQL error | [ ] |
| S7 | recallThreshold 超严时所有 atom 被截掉 | scenarios.md:L66-75 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "recallThreshold filters low-fused-score"` | fused rrfScore 全 < 0.05,结果为 [] | [ ] |
| S8 | BM25 路径返回 0 结果 | scenarios.md:L77-85 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "empty query / no BM25 hits"` | query="qwertyuiop" → [] | [ ] |
| S9 | 空字符串 query | scenarios.md:L89-95 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "empty query"` | recallAtoms("") 返回 [] | [ ] |
| S10 | 全新 DB,0 atom | scenarios.md:L97-104 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "init creates memory_fts"` | 启动后 FTS5 表存在但为空 | [ ] |
| S11 | 旧 DB 升级幂等构建 FTS5 | scenarios.md:L106-116 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "init idempotent"` | 8 active atom 全部回填,二次 init 不重复 | [ ] |
| S12 | init 时 ollama 不可达,FTS5 仍构建 | scenarios.md:L118-125 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "init without ollama"` | FTS5 创建成功,recall 走纯 BM25 | [ ] |
| S13 | 阈值默认 0.0167 边界 | scenarios.md:L127-137 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "default threshold boundary"` | 单 channel rank=1 贡献 0.01639 < 0.0167 不过 | [ ] |
| S14 | config 缺失 recall 块 → 默认值 | scenarios.md:L139-145 | unit-test | `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run test/hybrid-recall.test.ts -t "config missing defaults"` | rrfK=60, recallThreshold=1/60 | [ ] |
| S15 | lefse 用户回归 case | scenarios.md (proposal 验收 #3) | manual-scripted | Script: backup ~/.pi/agent/memory/memory.db → init() → recallAtoms("lefse没有结果") → assert 无 X101SC26052587 atom | 0 noise atom,正确的 atom(若有)被召回 | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | hybrid retrieval via FTS5 BM25 + dense KNN, fused by RRF | spec.md ADDED #1 | unit-test | test/hybrid-recall.test.ts 包含 4 个 scenario 测试 (BM25-only, dense-only, double-channel, threshold filter) | [ ] |
| R2 | FTS5 schema and storage sync | spec.md ADDED #2 | unit-test + code-review | storage.ts:init() 创建 memory_fts; insertAtom/archiveAtom/supersedeAtom 同事务同步 FTS5 行(7 个 storage-level 测试) | [ ] |
| R3 | bm25Search escapes FTS5 special characters | spec.md ADDED #3 | unit-test | storage.ts:bm25Search 内部 escapeQuotes/escapeFtsQuery,test 7 个 case 覆盖 " ( ) * : | [ ] |
| R4 | rrfK and recallThreshold are configurable | spec.md ADDED #4 | unit-test + code-review | memory.ts:PersonalAssistantConfig.memory.recall.{rrfK, recallThreshold}; 默认值 60 / 1/60; test 3 个 scenario (missing/tighten/loosen) | [ ] |
| R5 | RecallResult carries rrfScore alongside score | spec.md ADDED #5 | unit-test + code-review | types.ts:RecallResult 加 rrfScore: number; search.ts: RecallResult 构造时填充; formatMemoryBlock 不暴露 | [ ] |
| R6 | recallAtoms returns top-K sorted by RRF, per-type round-robin (MODIFIED) | spec.md MODIFIED #1 | unit-test | search.ts:recallAtoms per-type RRF + round-robin; test (g)(j)(n) 仍 pass | [ ] |
| R7 | threshold is now recallThreshold on RRF score (MODIFIED) | spec.md MODIFIED #2 | unit-test | DEFAULT_THRESHOLD 常量删除/替换; 默认 recallThreshold=1/rrfK; test 验证默认行为 | [ ] |
| R8 | hardcoded DEFAULT_THRESHOLD removed | spec.md REMOVED #1 | code-review | search.ts: 无硬编码 `const DEFAULT_THRESHOLD = ...` 常量(替换为 config-driven 默认) | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S15) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R8) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
- [ ] npm run check 全绿 (无新增 error/warn/info)
- [ ] 全量 vitest (~104 tests) 全 pass
- [ ] 用户实测 case (lefse 误召回) 已修复 — 不再误召回 X101SC26052587 atom
- [ ] storage.ts 写入路径 FTS5 同步原子化 (同事务)
- [ ] config schema 完整 (`personalAssistant.memory.recall.{rrfK, recallThreshold}` 都可空,fallback 到默认值)