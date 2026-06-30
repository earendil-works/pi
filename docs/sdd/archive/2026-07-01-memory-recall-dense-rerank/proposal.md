# 变更提案: memory-recall-dense-rerank

## 动机

实测搜索 `然后制做成为novo skill` 匹配到毫不相关的 fact `BMK 报告品牌替换三个修复`。根因有三:

1. **BM25 通道对中文全盲** — `escapeFtsQuery` 白名单正则 `/[^a-zA-Z0-9_\s]/g` 把 CJK 全替换成空格,中文 query 塌缩成剩余英文 token(如 "novo skill"),特异性丢失。
2. **FTS5 索引仍含 content 列** — embedding v2 已去 content(`embed.ts` v2),但 FTS schema 仍索引 `title,summary,content,tags`,不对称。正文偶然同现 token 即命中。
3. **rank-only RRF 放行单通道 rank-0** — `DEFAULT_RECALL_THRESHOLD = 1/(rrfK+1)`,BM25-only rank-0 恰好等于阈值,用 `>=` 放行。无 BM25 绝对分下限。

此外,`queryRewrite` 配置字段(`memory.ts:81` / `settings-manager.ts:81`)是死代码 —— `before_agent_start` hook 从不读取,rewrite 函数早在 memory-v2-refactor 已删。`CLAUDE.md:62-65` 仍引用已删函数(`rewriteQuery` / `rewriteQueryWithCallLlm` / `searchAtomsWithScores`),文档残留。

`docs/sdd/specs/spec.md` 存在自相矛盾:line 1420 "纯向量检索(无 FTS,无混合)" vs line 1721 "hybrid retrieval fuses dense + BM25 via RRF" —— 前者是 memory-v2-refactor 的 spec,后者是后续 memory-hybrid-bm25-recall 的 spec,两者未协调。

## 影响范围

- **修改 Capability**: memory-recall — 从 hybrid(BM25 + dense + RRF)改为纯 dense + 严格门控
- **删除 Capability**: memory-bm25-recall — FTS5 通道、RRF 融合、escapeFtsQuery、query rewrite 死代码
- **修改文档**: CLAUDE.md(清理 3 条失效原则)、spec.md(消除矛盾段)

## 非目标

- **不加 rerank** — ollama 不支持 cross-encoder;Xinference/ONNX 引入新依赖/服务,对当前 atom 库规模(几百条)过度工程。留作未来精度不足时的增量改进。
- **不换 ollama** — embedding 继续走 ollama `/v1/embeddings`,不迁移到 Xinference。
- **不动 DB schema 主体** — `memory_index` / `memory_vectors` 表保留,仅删 `memory_fts` 虚拟表。现有 atom 数据保留,无需迁移。
- **不动 extraction pipeline** — 提取/写入/supersede/decay 逻辑不变,仅删写入路径中的 FTS 行同步。
- **不动 format/inject** — `formatMemoryContext` / `injectMemoryContext` 不变,distance ASC 排序仍是注入主键。
- **不动 scoring 公式** — `computeScore` 乘法 boost `cosine × (1 + 0.3s + 0.2i) + 0.10×tagOverlap + 0.05×freshness` 保留。

## 验收标准

1. 搜索 `然后制做成为novo skill` 不再匹配 `BMK 报告品牌替换三个修复`(cosine < 0.7 被门控)
2. `grep -n "searchByFts\|bm25Search\|escapeFtsQuery\|rrfFuse\|memory_fts\|MEMORY_FTS_SCHEMA" extensions/personal-assistant/` 输出空(源码零残留)
3. `grep -n "queryRewrite\|query_rewrite" extensions/personal-assistant/ packages/coding-agent/src/core/settings-manager.ts` 输出空
4. `npm run check` 全绿(biome + pinned-deps + ts-imports + shrinkwrap + tsgo + browser-smoke)
5. 现有测试 `./test.sh`(非 e2e 子集)全绿
6. ollama 不可用时 recall 返回 `[]`(降级行为不变)
7. `recallAtoms` 按 type 分层 KNN(rule/fact/process 各 top-3)+ round-robin 交错行为保留
8. `CLAUDE.md` 不再引用 `rewriteQuery` / `rewriteQueryWithCallLlm` / `searchAtomsWithScores` / `memory_fts` / RRF
9. `spec.md` 不再包含 hybrid/RRF/BM25 要求段(矛盾消除)
