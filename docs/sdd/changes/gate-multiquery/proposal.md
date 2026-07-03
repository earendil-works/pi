# 变更提案: gate-multiquery

## 动机

当前 recall-precision pipeline 把"refuse 召回"和"query rewrite"塞进同一个 gate LLM 调用里,且 gate 只能输出单个 `search_query`。.retry-precision 实测发现:against 复合 query 如 `MGM项目的工时如何计算`,cross-encoder rerank 把所有 atom 打在 0.05~0.21 区间(全部 <threshold 0.5),最终 0 hits。复合 query 没有任何一个 atom 单独能完整覆盖, rerank 范式数学上无法处理 multi-hop 语义。

为解决:
1. **gate 限职责**:gate 现在的 search_query output实际是 rewrite 任务不该混进 binary LLM 调用,导致小模型双任务压力。gate 应该是 pure binary。
2. **rewrite 升级为 multi-query**:把 rewrite 任务独立成阶段,既能做 disambiguation (消失 指代词,用对话上文解 "之前那个"),又能拆复合 query为多条 subquery,让 recall 多路 fan-out。
3. **两组调用点共享**:LLM context hook (有对话上文)和 webui 直搜 (无上文)都共用同一 rewrite module,缓解 webui 直搜无法处理复合 query 的痛点。

## 影响范围

- 修改 Capability: `recall-precision` (gate schema 收紧为 pure binary; pipeline 扩展为 multi-recall+merge)
- 新增 Capability: `recall-multiquery` (rewrite 阶段 + merge helper)

## 非目标

- 不增加 atom corpus 的 metadata 字段 (无 schema 改动)
- 不修改 bge-m3 server.py 的 rerank 接口契约 (`/api/rerank` 接受单 query 不变)
- 不引入 ollama 新模型 — 沿用 qwen2.5:3b-instruct-q4_0
- 不为 TUI 新增 status 分支 — 复用现有 7 个 status (skip/no-match/fallback/happy),仅在 debug log 里增加 rewrite 行
- 不做 LLM-based 第一层粗排 (rerank 仍是 cross-encoder 范式,multi-query 只解决 recall 召回层)
- 不为 webui 加 query rewrite option flag — `filtered=true` 单一开关就等于"开 rewrite + rerank 全链路"

## 验收标准

- **gate schema 简化**: `GateDecision` 从 `{need_memory, search_query}` 改为 `{need_memory}`. 老 prompt 保留诞发 single search_query 的部分被移除. 现有 gate 测试全部要更新 (gate-fetch.test.ts 里用 `search_query` 的断言改为只查 need_memory)
- **rewrite.ts 新模块**: `rewriteQueries(query, recent?, options?) → Promise<string[] | RewriteError>`. 1-3 subqueries 上限. 同 ollama qwen2.5:3b-instruct-q4_0. timeout 1500ms.
- **rewrite 失败降级**: timeout/parse/unreachable 都 fallback 到 `[rawQuery]` (单元素 string[]),pipeline 后续行为与"未引入 rewrite" 等价。Non-blocking 是 hard contract (同 gate/rerank,见 AGENTS.md principle 6)
- **multi-recall + merge**: 在 context hook 和 webui search route 各处使用,for each subq recallAtoms 并行 → 同 atomId 取 rrf 最高(保留 cosine/sparseScore 对应),output 是 RecallResult[] 不增加字段
- **rerank 受信**: rerankAndFilter(`subqueries.join(" ")`, mergedHits) — rerank 看的是 unified disambiguated query,cross-encoder 复合语义画像高
- **webui filtered=true** 走全链路 rewrite + multi-recall + rerank,RG=MGM项目的工时如何计算 时返回 MGM atom + 工时计算 atom(非 0 hits)
- **复合精度测试**: 5 个复合 query 手工 smoke(qwen2.5:3b 拆出合理 subquery,合并后 rerank 至少有 1 个 hit,vs 今天 0 hits)。
- **gate 现有行为不退化**: 指代类 / ack / 历史回溯 5 个 scenario 状态保持 — gate 的 need_memory 字段不变.
- **npm run check 通过**: 不引入新 lint/TS error。
- **测试**: rewrite 单元测试 (mock fetch) + merge 单元测试 (pure function) + pipeline 集成测试 (gate→rewrite→recall→merge→rerank→format end-to-end)。
- **延迟预算**: context hook 总时延 ≤ 3s (gate 500ms + rewrite 1500ms + 多路 recall ~50ms + rerank 150ms)。今天 ~700ms,新城 ~2.2s,仍在 8s 预算内。