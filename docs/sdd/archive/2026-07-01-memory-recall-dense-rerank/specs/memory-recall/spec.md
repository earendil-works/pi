# memory-recall Specification

## MODIFIED Requirements

### Requirement: 纯向量检索 (无 FTS,无混合)

recallAtoms SHALL 用 sqlite-vec KNN 单向量检索,不做 FTS 匹配,不做 BM25 + Vector hybrid scoring,不做 RRF 融合。cosine floor 0.7 是唯一召回门控。bge-m3 多语言模型直接 embed 原文(含混合 ASCII+CJK),不拆段。

#### Scenario: recallAtoms 不调 searchByFts / bm25Search / rrfFuse

- **GIVEN** DB 有 50 atom,memory_vectors 表有对应 embedding
- **WHEN** `grep -n "searchByFts\|bm25Search\|rrfFuse\|FTS5\|bm25" extensions/personal-assistant/search.ts`
- **THEN** 输出为空

#### Scenario: recallAtoms 走 sqlite-vec KNN

- **GIVEN** DB 有 50 atom,memory_vectors 表有对应 embedding
- **WHEN** recallAtoms(index, query) 执行
- **THEN** 调用 `index.vectorSearch(embedding, topK, {type, isLatestOnly, archived})`
- **AND** 不走任何 FTS MATCH 查询
- **AND** 不走任何 RRF 融合

#### Scenario: cosine floor 0.7 过滤

- **GIVEN** DB 有 atom A(cosine=0.75)和 atom B(cosine=0.55)
- **WHEN** recallAtoms(index, query) 执行
- **THEN** A 通过 cosine floor(c >= 0.7)
- **AND** B 被 cosine floor 过滤掉(c < 0.7)

#### Scenario: 混合 ASCII+CJK query 直接 embed

- **GIVEN** query = "mgm工时计算"(ASCII + CJK 混合)
- **WHEN** recallAtoms(index, "mgm工时计算") 执行
- **THEN** 不执行 splitQuery(已删),直接 embedText("mgm工时计算")
- **AND** bge-m3 输出单条 embedding 用于 KNN

### Requirement: per-type top-3 dense + round-robin recall

`recallAtoms` MUST run, for each of the three atom types (rule / fact / process) independently, a dense KNN search (sqlite-vec, top-K candidates), filter by cosine floor 0.7, compute score via `score = cosine × (1 + 0.3 × strength + 0.2 × importance) + 0.10 × tagOverlap + 0.05 × freshness`, take the top 3 by score per type (sparse types degrade), then interleave the per-type lists via round-robin into a single result list.

#### Scenario: per-type top-3 dense ranking

- **GIVEN** rule type has 3 atoms with cosine/strength/importance triples giving scores 1.05 / 0.8925 / 0.876
- **WHEN** `recallAtoms` ranks the rule slice
- **THEN** all 3 are returned in score DESC order

#### Scenario: sub-floor atoms are dropped

- **GIVEN** some rule-type candidates have cosine < 0.7
- **WHEN** `recallAtoms` returns
- **THEN** those candidates are NOT in the result list

#### Scenario: empty query returns empty

- **GIVEN** query is an empty string `""`
- **WHEN** `recallAtoms(index, "")` is called
- **THEN** returns `[]`

#### Scenario: ollama unavailable returns empty

- **GIVEN** ollama is not running, embedText returns null
- **WHEN** `recallAtoms(index, query)` is called
- **THEN** returns `[]` immediately (no FTS fallback, no keyword extraction)

## REMOVED Requirements

### Requirement: per-type top-3 RRF + round-robin recall

- **Reason**: RRF 融合已删除,召回改为纯 dense 单通道。per-type top-3 + round-robin 逻辑保留但通过纯 dense score 排序,不再通过 RRF fused score。
- **Migration**: 无 — 行为等价于删掉 BM25 channel + RRF fusion 后的 dense-only path。cosine floor 0.7 替代 RRF recallThreshold 作为门控。

### Requirement: hybrid retrieval fuses dense + BM25 via RRF

- **Reason**: BM25 通道对中文 query 系统性缺陷(escapeFtsQuery 白名单正则把 CJK 全剥光,FTS5 unicode61 tokenizer 对连续 CJK 生成单 token)。FTS5 索引仍含 content 列(embedding v2 已去 content),正文偶然同现 token 即命中。rank-only RRF 放行单通道 rank-0,无 BM25 绝对分下限。
- **Migration**: 无 — 纯 dense + cosine floor 0.7 + tagOverlap 精确匹配覆盖个人 atom 库规模的全部检索需求。

### Requirement: FTS5 行同步在 storage 层原子化

- **Reason**: `memory_fts` 表已删除。insertAtom / markSupersededTx / markArchived / unmarkArchived 不再操作 FTS 行。`init()` 新增 `DROP TABLE IF EXISTS memory_fts` 清理旧 DB 残留表。
- **Migration**: 现有 DB 的 `memory_fts` 表在下次 `init()` 时被 DROP,不影响 `memory_index` / `memory_vectors` 数据。

### Requirement: 召回配置暴露 rrfK 和 recallThreshold knob

- **Reason**: RRF 融合已删除,`rrfK` 和 `recallThreshold` 不再适用。`PersonalAssistantConfig.memory.recall` 对象及其字段已删除。
- **Migration**: 无 — 这两个 knob 从未被用户配置(默认值始终生效),删除无影响。

### Requirement: rewriteQueryWithCallLlm / searchAtomsWithScores server helpers

- **Reason**: 函数早在 memory-v2-refactor 已删除,spec 段未同步清理。`queryRewrite` 配置字段是死代码(`before_agent_start` 从不读取)。
- **Migration**: 无 — 函数已不存在,spec 段是文档残留。
