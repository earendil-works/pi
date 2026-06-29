# Tasks: memory-recall-dense-rerank

> **Design:** design.md | **Base:** 107005f3

**Goal:** 将记忆召回从 hybrid(BM25+dense+RRF)改为纯 dense 单通道 + cosine floor 0.7,同步清理 BM25/FTS/RRF 全部代码、测试和文档残留。

**Architecture:** 删除 `search.ts` 的 rrfFuse/splitQuery/mergeResults,简化 `recallAtomsSingleSegment` 为纯 dense KNN → cosine floor → computeScore → top-3 → round-robin。删除 `storage.ts` 的 bm25Search/escapeFtsQuery/MEMORY_FTS_SCHEMA 及 init/insert/supersede/archive 中的 FTS 同步逻辑。清理 CLAUDE.md/spec.md 失效段落。cosine floor 从 0.65 提到 0.7。删除 hybrid-recall.test.ts(整个文件测试已删的 hybrid 行为)。更新 search.test.ts / storage.test.ts / recall-quality.test.ts。

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, ollama bge-m3, vitest

## Constraints

- **Pre-commit requires green state**: 每个 commit 必须通过 `npm run check`。Intermediate broken 状态不能 commit。
- **合并 related deletions**: 删除一个被引用的符号必须同 commit 移除所有引用。
- **删除 hybrid-recall.test.ts**: 该文件(1146 行)整个测试 BM25/RRF 行为,文件整体删除,不重写。
- **更新 recall-quality.test.ts**: `recallThreshold: 0` 改为 `threshold: 0`(字段已重命名)。

## 1. Delete hybrid recall channel — production code (atomic)

- [x] 1.1 **Delete BM25/FTS/hybrid from production code (storage.ts + search.ts + memory.ts)**
  - **Files**:
    - Modify: `extensions/personal-assistant/storage.ts`
    - Modify: `extensions/personal-assistant/search.ts`
    - Modify: `extensions/personal-assistant/memory.ts`
  - **Content**: 一次性删除所有 hybrid channel 死代码:
    - `storage.ts`: delete `escapeFtsQuery` 函数 + 调用; delete `bm25Search` 方法
    - `search.ts`: delete `rrfFuse` 函数; delete `DEFAULT_RRF_K`, `DEFAULT_RECALL_THRESHOLD` 常量; delete `splitQuery`, `splitQueryRaw`, `mergeResults` 函数; delete `MAX_SPLIT_SEGMENTS` 常量; change `DEFAULT_DENSE_COSINE_FLOOR` 0.65 → 0.7 + 注释; rewrite `recallAtomsSingleSegment` 为纯 dense KNN → cosine floor → computeScore → sort by score DESC → slice top-K; rewrite `recallAtoms` 去掉 splitQuery/mergeResults 分支; clean `RecallOptions` 删除 `rrfK` / `recallThreshold` 字段
    - `memory.ts`: clean `PersonalAssistantConfig.memory.recall` 删除 `rrfK` / `recallThreshold`; clean `before_agent_start` hook 删除这两个参数
  - **Result**: `npm run check` 在所有 production 源码(不包含测试文件)上 0 错误。`search.ts` 和 `storage.ts` 中无对已删符号的引用。`memory.ts` 中无对已删字段的引用。
  - **测试文件**: 不动 — 由 task 2.7 / 1.7 后续处理。
  - **依赖**: 无

- [x] 1.2 **Delete FTS table sync from storage.ts**
  - **File**: Modify `extensions/personal-assistant/storage.ts`
  - **Content**: 删除 `MEMORY_FTS_SCHEMA` 常量; 删除 `init()` 中的 FTS 建表/backfill/repair 逻辑; 删除 `insertAtom` 中的 `INSERT INTO memory_fts`; 删除 `markSupersededTx` / `markArchived` / `unmarkArchived` 中的 FTS 操作; 在 `init()` 中新增 `DROP TABLE IF EXISTS memory_fts`(清理旧 DB 残留表)
  - **Result**: `grep -n "memory_fts" storage.ts` 只输出 `DROP TABLE IF EXISTS memory_fts` 一行
  - **依赖**: 1.1

- [x] 1.3 **Update webui route memory.ts**
  - **File**: Modify `packages/webui/server/routes/memory.ts`
  - **Content**: 删除 `registerPostSearch` 中对 `m?.recall?.rrfK` 和 `m?.recall?.recallThreshold` 的引用
  - **Result**: `grep -n "rrfK\|recallThreshold" packages/webui/server/routes/memory.ts` 输出空
  - **依赖**: 1.1

## 2. Update tests

- [x] 2.1 **Update search.test.ts + delete hybrid-recall.test.ts + update recall-quality.test.ts**
  - **Files**:
    - Modify: `extensions/personal-assistant/test/search.test.ts`
    - Delete: `extensions/personal-assistant/test/hybrid-recall.test.ts`
    - Modify: `extensions/personal-assistant/test/recall-quality.test.ts`
  - **Content**:
    - `search.test.ts`: 删除 `rrfFuse` / `splitQuery` / `splitQueryRaw` / `mergeResults` / BM25 相关测试 block; 改写 `recallAtoms` 测试断言纯 dense + cosine floor 0.7; 新增边界测试(cosine 恰好 0.70 通过 / 全部 < 0.7 返回 [] / 某 type 无候选 round-robin 跳过 / 空 query 返回 [])
    - `hybrid-recall.test.ts`: 整个文件删除(1146 行,全部测试已删的 hybrid 行为)
    - `recall-quality.test.ts`: 把 `recallThreshold: 0` 改为 `threshold: 0`(字段重命名)
  - **Result**: `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts test/recall-quality.test.ts` 0 错误 0 失败
  - **依赖**: 1.1

- [x] 2.2 **Update storage.test.ts**
  - **File**: Modify `extensions/personal-assistant/test/storage.test.ts`
  - **Content**: 删除 `escapeFtsQuery` describe block; 删除 `memory_fts FTS5 table` describe block 的全部测试(init creates memory_fts / init backfills / init repairs broken / init does not touch valid / markSupersededTx swaps / markArchived deletes); 新增测试 `init() drops legacy memory_fts table` — 构造旧 DB 含 memory_fts 表 + 行,调 init(),验证 memory_fts 表不存在, memory_index/vectors 数据保留
  - **Result**: `node ../../node_modules/vitest/dist/cli.js --run test/storage.test.ts` 0 错误 0 失败
  - **依赖**: 1.2

- [x] 2.3 **Add regression test for Chinese query no-false-positive**
  - **File**: Create `extensions/personal-assistant/test/regressions/recall-dense-floor.test.ts`
  - **Content**: 插入 2 atom: A(title="novo skill 创建方法", type="fact") 和 B(title="BMK 报告品牌替换", type="fact"); 用 mock embedder 控制 cosine: A=0.75(通过 floor), B=0.55(低于 floor); 断言 `recallAtoms` 只返回 A 不含 B
  - **Result**: `node ../../node_modules/vitest/dist/cli.js --run test/regressions/recall-dense-floor.test.ts` 0 错误 0 失败
  - **依赖**: 1.1

## 3. Documentation

- [x] 3.1 **Clean CLAUDE.md obsolete principles**
  - **File**: Modify `CLAUDE.md`
  - **Content**: 删除 line 63 "必重建 FTS 行"; 删除 line 65 "调真实的 `rewriteQueryWithCallLlm` + `searchAtomsWithScores`"(整条); 删除 line 86-92 整段 `## memory-hybrid-bm25-recall` 原则(5 子原则)
  - **Result**: `grep -n "FTS 行\|rewriteQueryWithCallLlm\|searchAtomsWithScores\|memory-hybrid-bm25-recall" CLAUDE.md` 输出空
  - **依赖**: 无

- [x] 3.2 **Clean spec.md hybrid/RRF/BM25 sections + update cosine floor value**
  - **File**: Modify `docs/sdd/specs/spec.md`
  - **Content**:
    - 删除 v1 search 路由 spec block(原 line 1128-1206,引用 `rewriteQueryWithCallLlm` / `searchAtomsWithScores` / `QueryRewriteResult` / `simpleKeywordExtraction`)
    - 删除"Search tester LLM rewrite fallback notice" scenario(引用 `simpleKeywordExtraction`)
    - 删除 `## memory-recall-dense-rerank` 中的 hybrid/RRF/BM25 requirement 段(line 1687-1730 附近): `per-type top-3 RRF + round-robin recall` / `hybrid retrieval fuses dense + BM25 via RRF` 及所有场景
    - 全文件 `0.65` → `0.7` 更新(cosine floor 值)
  - **Result**: `grep -nE "rewriteQueryWithCallLlm|searchAtomsWithScores|QueryRewriteResult|simpleKeywordExtraction" docs/sdd/specs/spec.md` 只输出在 `<!-- Removed: -->` HTML 注释和 "不调" exclusion 断言中的引用(4 行); `grep -n "0\.65" docs/sdd/specs/spec.md` 输出空
  - **依赖**: 无

- [x] 3.3 **Update CHANGELOG.md**
  - **File**: Modify `extensions/personal-assistant/CHANGELOG.md`
  - **Content**: 在 `## [Unreleased]` 下追加:
    - `### Changed`: `Recall pipeline from hybrid (BM25+dense+RRF) to pure dense + cosine floor 0.7`
    - `### Removed`: 4 条(`BM25/FTS5 channel` / `RRF fusion` / `Query splitting` / `queryRewrite config field`)
  - **Result**: grep 4 条新条目都在 `[Unreleased]` 下
  - **依赖**: 无

## 4. Final verification

- [x] 4.1 **Run full test suite + npm run check**
  - **Command**: `./test.sh && npm run check`
  - **Result**: 0 错误 0 警告 0 info
  - **依赖**: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3

- [x] 4.2 **Residual code grep**
  - **Command**: `grep -rn "searchByFts\|bm25Search\|escapeFtsQuery\|rrfFuse\|memory_fts\|MEMORY_FTS_SCHEMA\|splitQuery\|mergeResults\|MAX_SPLIT_SEGMENTS\|DEFAULT_RRF_K\|DEFAULT_RECALL_THRESHOLD\|rrfK\|recallThreshold\|queryRewrite\|query_rewrite" extensions/personal-assistant/ packages/webui/server/routes/memory.ts packages/coding-agent/src/core/settings-manager.ts --include="*.ts" | grep -v test/`
  - **Result**: 输出空(源码零残留;测试文件内的引用由对应任务清理)
  - **依赖**: 4.1

- [x] 4.3 **Residual doc grep**
  - **Command**: `grep -nE "FTS 行|rewriteQueryWithCallLlm|searchAtomsWithScores|memory-hybrid-bm25-recall|hybrid retrieval|BM25.*channel" CLAUDE.md docs/sdd/specs/spec.md`
  - **Result**: 输出空(文档零残留;`<!-- Removed: -->` HTML 注释和 "不调" exclusion 断言不在此 pattern 内)
  - **依赖**: 4.2
