# 原则: memory-recall-dense-rerank

## 召回架构

- **召回是纯 dense 单通道**:sqlite-vec KNN + cosine floor 是唯一门控,无 BM25/FTS/RRF 融合。bge-m3 多语言语义检索 + tagOverlap 精确匹配覆盖个人 atom 库规模(几百条)的全部检索需求。

## 门控姿态

- **宁可漏召不可误召**:cosine floor 0.7 是硬门控,低于 floor 的候选不进结果列表。dense 是唯一通道,门控必须严(0.65 → 0.7),无 BM25 兜底。

## 删除纪律

- **删通道必删同步**:删 BM25 通道必须同步删 storage 层所有 FTS 行同步逻辑(insert/supersede/archive 三处),不能留死代码引用已删的 `memory_fts` 表。
- **删功能必删配置**:删 query rewrite 必须同步删 `PersonalAssistantConfig.memory.queryRewrite` 字段和 `settings-manager.ts` 的 `query_rewrite` 字段,配置不能引用不存在的功能。
- **删功能必清文档**:删功能必须同步清理 CLAUDE.md / spec.md 中引用该功能的段落,文档不能描述已删除的行为。

## 复用不变

- **scoring 公式不可变**:`cosine × (1 + 0.3s + 0.2i) + 0.10×tagOverlap + 0.05×freshness` 是稳定 API,乘法锚保证 cosine 主键地位,删 BM25 不影响 scoring。
- **per-type top-3 + round-robin 不可变**:rule/fact/process 各取 top-3 + 交错合并是类型多样性保证,与召回通道无关。
- **L0 discovery-only 不可变**:召回只返 `{id, type, title, summary, tags, distance, cosine, score}`,全文由 `memory_get(id)` 按需取,不注入 prompt。
