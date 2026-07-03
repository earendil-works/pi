# 本变更原则

- gate 只做二分 (`need_memory`),不再做 query rewrite — 单职责 LLM call 是小模型可靠性的边界条件,双任务让 3b 的两个产出都掉点
- rewrite 是独立阶段,统一处理 disambiguation + multi-concept split,不与 gate 共享 prompt,失败降级到单 `[rawQuery]` 与今天等价
- subquery 上限 3 是 LLM 行为护栏,不是性能护栏 — 阻止小模型在简单 query 上凑数生造低质子查询
- 同 atom 被多 subquery 召回时,merge 取 rrf 最高那一路的 cosine/sparseScore 一组,不重新计算混合分数 — 保留服务端 RRF 单一权威
- rerank 拿的 query 是 `subqueries.join(" ")` — cross-encoder 看到的是 unified 的复合语义画像,而非各自打分取 max,后者会丢失概念间关联
- webui `filtered=true` 单一开关包含 rewrite+rerank 全链路 — 不为 rewrite 单独开 flag,避免组合爆炸配置
- rewrite 失败不阻塞 pipeline — non-blocking 是 hard contract (AGENTS.md principle 6 既有原则,本变更复用)
- gate 删除 `search_query` 字段是 breaking change on schema — 老 settings.json / 老 test 都要同步改,不允许保留向后兼容 (per AGENTS.md "不保留 backward compat")
- 三阶段串行 (gate → rewrite → recall+rerank) 总时延 ≤3s,仍在 context hook 8s 预算内 — 每阶段 timeout 是硬约束 (gate 500ms / rewrite 1500ms / rerank 500ms),总 2500ms + recall 50ms + format 微秒级
- merge helper 是 pure function,@sdd-guide 的 unit test 优先级高于 rewrite 的 mock fetch test
- debug log 行扩展为 `[recall] gate=X rewrite=Y(N) recall=Z rerank=W ...` — `rewrite=Y(N)` 输出 `ok(2)` / `timeout` / `parse` / `[raw]`,单行可读