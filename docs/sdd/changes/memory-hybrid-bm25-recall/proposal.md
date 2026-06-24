# 变更提案: memory-hybrid-bm25-recall

## 动机

memory-v2 当前是纯 sqlite-vec dense 召回 (bge-m3 + cosine threshold)。2026-06-24 实测暴露三个本质问题:

1. **bi-encoder 的精度天花板**:bge-m3 dense-only 在中文场景的噪声底约 0.55,真正相关召回 0.74-0.81,信号/噪声 gap 仅 ~0.1。无法通过调阈值继续优化 —— 调高会丢真信号,调低会漏噪声。
2. **专有名词 / 低频词鲁棒性差**:"lefse没有结果" 这种带专有名词的 query,dense 召回了一堆不相关的客户数据 atom,因为 dense 不懂 lefse 是工具名。
3. **现有 CLAUDE.md 第 44 行原则** "记忆系统使用纯向量检索,删除 FTS5、混合检索、BM25 评分" 已不再符合实际 recall 需求 —— 该原则是 v2 重构时为了简化主动选择的 trade-off,现在召回质量出问题,trade-off 需要重估。

业界主流 hybrid retrieval (BM25 + dense + RRF) 是 production RAG 默认配置,sqlite 内置 FTS5 提供 BM25 零成本接入。本变更把 FTS5 BM25 加进来,与现有 sqlite-vec dense 走 RRF 融合,把 hardcoded `DEFAULT_THRESHOLD = 0.65` 移到 config。

## 影响范围

- 新增 Capability:
  - `memory.fts5` — FTS5 虚表 `memory_fts` 维护 title + summary + content + tags,unicode61 tokenizer
  - `memory.recall` — 召回配置 `rrfK` + `recallThreshold`,替换 hardcoded `DEFAULT_THRESHOLD`
  - `memory.hybrid-recall` — `recallAtoms` RRF 融合 (dense top-20 + BM25 top-20 → fused top-9)
- 修改 Capability:
  - `memory-vector-recall` (memory-search-get-decoupling) — `recallAtoms` 从单 dense 改为 hybrid;per-type top-3 / round-robin 不变(只是融合后的 top-9 再做 round-robin)
  - `memory-storage` — `MemoryIndex.init()` 加 FTS5 幂等构建;`insertAtom` / `supersede` / `archive` 同步 FTS5 行;`getAllAtoms` 路径不变
- 删除 Capability:
  - `memory-v2` 的 "纯向量检索,删除 FTS5、混合检索、BM25 评分" 原则 — sdd-archive 阶段 REMOVED
  - `search.ts` 中 hardcoded `DEFAULT_THRESHOLD` 常量

## 非目标

- 不引入 cross-encoder reranker (开销大,纯 dense + BM25 + RRF 在大多数场景已足够)
- 不引入新的 embedding 模型 / bge-m3 sparse / ColBERT 多向量 (本地 ollama 的 `/v1/embeddings` 不支持,需要换 client)
- 不改 extraction 流程 (compact 仍只产生 atom,BM25 是召回侧增强)
- 不改 `runDecay` / `archive` 流程 (FTS5 行跟随 `archived` 字段自动失效)
- 不支持 webui 端手动 rebuild FTS (init 幂等足够,跑一次就稳)
- 不做 query 改写 (RRF 已经能把 "lefse没有结果" 这种短 query 通过 BM25 找回相关 atom)

## 验收标准

1. **架构落地**:
   - `MemoryIndex.init()` 启动时检测 `memory_fts` 是否存在,不存在则 `CREATE VIRTUAL TABLE` 并回填 active atom
   - `recallAtoms` 流程:`embedText(query)` → dense top-20 + FTS5 `bm25()` top-20 → RRF 融合 → fused top-9 → per-type round-robin(各 type 最多 3)
   - `RecallResult` 加 `rrfScore` 字段 (UI / 调试用),`score` 保留乘法 boost (兼容性)
2. **配置化**:
   - `personalAssistant.memory.recall.rrfK` 默认 60 (RRF 标准)
   - `personalAssistant.memory.recall.recallThreshold` 默认 `1/rrfK` ≈ 0.01667 (strict:单 channel rank=1 贡献 0.01639 < 0.01667,不足以过阈值)
   - 两者均可在 `~/.pi/agent/settings.json` 覆盖
3. **质量指标**:
   - 用户实测 case `lefse没有结果` 不再误召回 `X101SC26052587 客户数据未回传`(该 atom 与 query 无 BM25 命中,RRF 排到 top-9 之外)
   - `recall-quality.test.ts` (现有 labeled dataset 14 atom / 9 query) avg_recall@5 ≥ 0.85 (从原 1.0 微降到 ~0.85-0.95),avg_precision@5 ≥ 0.4 (从原 0.27 提升 ~50%,因为 BM25 排掉大量噪声;实测幅度依赖数据集)
4. **测试**:
   - 单元测试 hermetic(不依赖 ollama),用 mock embedder + in-memory FTS5
   - 现有 16 个 search.test.ts 全部仍 pass
   - 新增 hybrid-recall.test.ts:覆盖 RRF 边界、BM25 单独命中、dense 单独命中、双命中、空 query、单 channel 降级
5. **代码 hygiene**:
   - FTS5 行同步在 storage 层原子化(同一事务,避免 FTS5 与 memory_index 不一致)
   - 不引入新依赖(FTS5 是 better-sqlite3 内置模块)
   - `npm run check` 全绿
6. **文档**:
   - memory-search-get-decoupling SDD 文档 Decision 8 同步更新(threshold 改为 config-controlled RRF score)
   - 新 principle 追加到 CLAUDE.md (sdd-archive 阶段合并)