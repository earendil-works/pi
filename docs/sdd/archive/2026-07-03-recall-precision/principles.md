# 原则: recall-precision

1. **召回是优化, 故障必须降级不能停摆** — gate / rerank 是精度优化层, 任一故障跳过该层走老路径, 不阻塞 context 注入整体。

2. **gate 是 binary 决策不需要置信度** — `{need_memory, search_query}` 不带 confidence, 边界情况一律偏向 false (压假阳性优先), 把判断责任交给 rerank。

3. **rerank 输出才是 format 的事实** — formatMemoryContext 接收 rerank_score 降序的 hit, RRF rrf 只作为同分时的 tie-breaker; 不再以 bge-m3 的 RRF 输出作为最终排序依据。

4. **gate 上下文最小化** — 仅取最近 2-3 条 user msg (不含 assistant), 不读 atom store, 不读 db; 上文场景识别靠对话短窗口, 不靠全 memory。

5. **threshold + gap 双重截断, 单一阈值不可** — threshold ≥0.5 防低分混入, gap >0.15 截在分界突变处; 任意单阈值都会有一类失败 (高阈值 leak 低, 低阈值 leak noise)。

6. **non-blocking 是 hard contract** — gate / rerank / 任何新增环节, 进 context hook 后默认异步 + 500ms timeout, 不得进 await critical path 之外; context hook 8s 总超时剩余的 4-7s 应留给 hybridSearch / format / modelRegistry 等。

7. **简单调用, 一个端点一个职责** — server.py 加 `/api/rerank`, 输入 `(query, hits[])` 输出 `[{id, score}]`, 不暴露 cross-encoder 模型自身参数 (threshold / gap 在客户端做, server 只返分); 客户端不下推截断策略到 server。

8. **不增加 schema 也不破坏向后兼容** — memory_vectors / memory_index schema 不动; `RecallResult` 加 `rerank_score?: number` 必须是 optional 字段, 老测试不破坏; `before_agent_start` hook 保留但仍能 skip-gate 流程入口。

9. **新模块单一 home** — gate 逻辑在 `extensions/personal-assistant/gate.ts`; rerank 客户端在 `extensions/personal-assistant/rerank.ts`; threshold/gap 在 rerank.ts 内部封装为 `rerankAndFilter()`, 不外溢到 search.ts / memory.ts。

10. **可观测, 一次召回一条 log** — 每个 pipeline 触发输出单条 debug log: `[recall] gate=${gate.status} rerank=${rerank.status} pre=${hybridCount} post=${finalCount} latency {gate,recall,rerank}ms`, 不 spam 多条。