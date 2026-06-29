# 验证清单: memory-recall-dense-rerank

## 场景验证 (S*)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|---------|-------------|---------|------|
| S1 | 纯 dense 召回中文 query: A cosine≥0.7 通过, B cosine<0.7 过滤 | scenarios.md:L7 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/regressions/recall-dense-floor.test.ts` | 测试通过,结果只含 A 不含 B | [ ] |
| S2 | per-type 分层 KNN + round-robin: 3 rule + 2 fact + 1 process 交错 | scenarios.md:L17 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "round-robin"` | 交错顺序 rule[0],fact[0],process[0],rule[1],fact[1],rule[2] | [ ] |
| S3 | scoring 公式不变: cosine=0.85,s=1,i=1 score > cosine=0.80,s=0.5,i=0 | scenarios.md:L25 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "scoring"` | X score > Y score, X 排前 | [ ] |
| S4 | ollama 不可用 → 返回 [] | scenarios.md:L35 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "ollama unavailable"` | 返回 `[]`, TUI status `🔍 no memory match` | [ ] |
| S5 | 空查询 → 返回 [] | scenarios.md:L43 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "empty query"` | 返回 `[]` | [ ] |
| S6 | DB 无 atom → 返回 [] | scenarios.md:L51 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "empty db"` | KNN 返回 0, 返回 `[]` | [ ] |
| S7 | 所有候选 cosine < 0.7 → 返回 [] | scenarios.md:L59 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "all below floor"` | cosine floor 过滤后空, 返回 `[]` | [ ] |
| S8 | cosine 恰好 0.70 通过 >= | scenarios.md:L67 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "cosine equals floor"` | atom A(cosine=0.70) 通过过滤 | [ ] |
| S9 | 某一 type 无候选 → round-robin 跳过 | scenarios.md:L75 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "sparse type"` | 只有 fact 层有结果,不跨 type 补位 | [ ] |
| S10 | 混合 ASCII+CJK query 直接 embed 不拆段 | scenarios.md:L83 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts -t "mixed query"` | 直接 embedText("mgm工时计算"),不调 splitQuery | [ ] |
| S11 | FTS 表存在但 init() DROP | scenarios.md:L91 | unit-test | `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts -t "drops legacy memory_fts"` | memory_fts 表不存在, memory_index/vectors 保留 | [ ] |
| S12 | 写入 atom 不再同步 FTS 行 | scenarios.md:L99 | code-review | `grep -n "INSERT INTO memory_fts" extensions/personal-assistant/storage.ts` | 输出空 | [ ] |
| S13 | supersede 不再操作 FTS 行 | scenarios.md:L107 | code-review | `grep -n "DELETE FROM memory_fts\|INSERT INTO memory_fts" extensions/personal-assistant/storage.ts` | 输出空 | [ ] |
| S14 | archive 不再操作 FTS 行 | scenarios.md:L115 | code-review | `grep -n "memory_fts" extensions/personal-assistant/storage.ts` | 只输出 `DROP TABLE IF EXISTS memory_fts` | [ ] |

## 需求验证 (R*)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|---------|---------|------|
| R1 | 纯向量检索 (无 FTS,无混合) — cosine floor 0.7 唯一门控 | spec.md MODIFIED #1 | code-review | `grep -n "bm25Search\|rrfFuse\|FTS5\|bm25" extensions/personal-assistant/search.ts` 输出空; `grep -n "DEFAULT_DENSE_COSINE_FLOOR" extensions/personal-assistant/search.ts` 输出 `= 0.7` | [ ] |
| R2 | per-type top-3 dense + round-robin recall — score DESC 排序 + top-3 截断 + 交错 | spec.md MODIFIED #2 | code-review + unit-test | `search.ts:recallAtomsSingleSegment` 调 `vectorSearch` → cosine floor → `computeScore` → sort by score DESC → `slice(0, DEFAULT_TOP_K)`; `test/search.test.ts` round-robin 测试通过 | [ ] |
| R3 | REMOVED: per-type top-3 RRF + round-robin recall | spec.md REMOVED #1 | code-review | `grep -n "rrfFuse\|rrfScore\|rrfK" extensions/personal-assistant/search.ts` 输出空 | [ ] |
| R4 | REMOVED: hybrid retrieval fuses dense + BM25 via RRF | spec.md REMOVED #2 | code-review | `grep -n "bm25Search\|BM25\|RRF" extensions/personal-assistant/search.ts extensions/personal-assistant/storage.ts` 输出空 | [ ] |
| R5 | REMOVED: FTS5 行同步在 storage 层原子化 | spec.md REMOVED #3 | code-review | `grep -n "memory_fts" extensions/personal-assistant/storage.ts` 只输出 `DROP TABLE IF EXISTS memory_fts`; insert/supersede/archive 无 FTS 操作 | [ ] |
| R6 | REMOVED: 召回配置暴露 rrfK 和 recallThreshold knob | spec.md REMOVED #4 | code-review | `grep -n "rrfK\|recallThreshold" extensions/personal-assistant/memory.ts packages/webui/server/routes/memory.ts` 输出空 | [ ] |
| R7 | REMOVED: rewriteQueryWithCallLlm / searchAtomsWithScores server helpers | spec.md REMOVED #5 | code-review | `grep -n "rewriteQueryWithCallLlm\|searchAtomsWithScores\|queryRewrite" extensions/personal-assistant/ packages/coding-agent/src/core/settings-manager.ts --include="*.ts"` 输出空 | [ ] |
| R8 | CLAUDE.md 清理: 删 FTS 行 / rewriteQuery 引用 / hybrid 原则段 | tasks.md 4.1 | code-review | `grep -n "FTS 行\|rewriteQueryWithCallLlm\|searchAtomsWithScores\|memory-hybrid-bm25-recall" CLAUDE.md` 输出空 | [ ] |
| R9 | spec.md 矛盾消除: 删 v1 search 路由 spec + hybrid/RRF/BM25 段 | tasks.md 5.1-5.2 | code-review | `grep -n "rewriteQueryWithCallLlm\|hybrid retrieval\|BM25.*channel\|rrfK\|rrfScore" docs/sdd/specs/spec.md` 输出空 | [ ] |
| R10 | spec.md cosine floor 0.65 → 0.7 | tasks.md 5.3 | code-review | `grep -n "0\.65" docs/sdd/specs/spec.md` 输出空 | [ ] |
