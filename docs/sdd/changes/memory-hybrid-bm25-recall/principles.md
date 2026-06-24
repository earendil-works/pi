# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- 召回融合默认走 RRF (Reciprocal Rank Fusion),不归一化 BM25 与 cosine,只取 rank 加权 — 量纲不同、分布不同的 score 强行相加不稳,RRF 用 `1/(k+rank)` 自然规避
- FTS5 行同步在 storage 层原子化,与 memory_index 同事务,FTS5 行只描述 active 文本层(不含 embedding),archive / supersede 立即让 FTS5 行失效
- 召回配置只暴露 `rrfK` 和 `recallThreshold` 两个 knob,其他全部硬编码在 `search.ts` — 加 knob 等于让用户调自己不懂的参数,YAGNI
- `recallThreshold` 默认 `1/(rrfK+1)` 严格相等,意味着单 channel rank=1 单独命中**不足以**过阈值,必须双 channel 都命中 OR 单 channel 极强 — 这是"宁可漏召不可误召"的保守姿态
- 召回对单 channel 降级鲁棒:dense 失败 → 纯 BM25 仍工作;BM25 返回 0 → 纯 dense 仍工作;两者都失败 → 返回 `[]`(同旧行为)