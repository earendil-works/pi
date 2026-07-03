# 变更提案: recall-precision

## 动机

当前 memory recall 每条 user message 无条件触发, bge-m3 是 bi-encoder 在 dense 0.55-0.65 区间假阳性率约 60-80% (实测 "上面的脚本有问题" 返回 5+ 不相关候选)。三因子叠加:

1. **无 query 改写** — 口语化、指代性 query ("上面的脚本有问题" / "那个 bug 修了吗") 直接 embedding，bge-m3 看不到对话上文，按字面"脚本/bug"匹配所有含该词的 atom。
2. **无召回 gate** — `before_agent_start` 对每条 user message 都触发 recall，"对"/"好的"/"继续" 这种零信息量消息也烧 embedding + 走全程 pipeline。
3. **无重排** — bi-encoder query/doc 不交互，dense=0.55-0.65 假真难辨；RRF k=60 平滑常数让 0.59 cosine 排第 3 看不出问题。

目标: 将 P95 召回假阳性率从 ~80% 降到 ~10%，平均召回数从 5-8 降到 0-3，P95 端到端延迟 < 1.2s。

## 影响范围

- **新增 Capability**: recall-precision (gate + rerank + gap)
- **修改 Capability**: memory (recall pipeline 改造)
- **删除 Capability**: 无 (旧 path 作为 rerank 故障降级通道保留)

## 非目标

- 不改 recall 算法本身 (bge-m3 RRF 仍是候选生成器，不替换为 HyDE / multi-vector)
- 不改 atom extraction/dedup/decay (atom 生命周期不变)
- 不改 format.ts (纯渲染不变)
- 不改 storage.ts schema (不增加新表/字段)
- 不改 api contract / tools.ts (memory_get 已废弃, tool_result hook 仍是唯一 strength feedback)
- 不做 multi-query / HyDE / 二阶段 LLM rerank (overkill)
- 不增加新持久化状态 (gate 决策不缓存，每次现算)
- 不改 settings.json 新增针对 gate 的 config 段 (gate 走 ollama 默认+, 不需要单独配置 provider/model — 与 extraction 不同)

## 验收标准

1. **假阳性率** — 在 "上面的脚本有问题" / "对" / "继续" / "好的 我看看" 等 10 条口语/零信息量测试 query 上, 平均召回数 ≤ 1.5 (现状 ~5-8); 与上下文真无相关的 0 召回率 ≥ 30%。
2. **真阳性不退步** — 在 "之前我们怎么处理过 bwa 的并发问题" / "mgm 项目的鉴权方案" / "你记得 forge 那个 retain loop 的 fix 吗" 等 10 条语义清晰 query 上, top-3 recall@3 ≥ 现状 baseline (rerank 不砍掉真 hit)。
3. **延迟** — P50 ≤ 800ms, P95 ≤ 1.2s end-to-end (gate 300ms + hybridSearch 50ms + rerank 500ms + gap 0ms); gate 失败超时 500ms 不应阻塞 context hook 总 8s timeout。
4. **故障降级** — gate 超时 500ms → skip 召回 + setStatus "⚠ gate timeout, skipped"; rerank 超时 500ms → 返回 gate-通过后的原 RRF top-K (无精度过滤); rerank 全量 score <0.5 → 不注入 ("🔍 no memory match")。
5. **幂等** — 同一 (user msg, 最近 2-3 user msgs) 输入下 gate 输出确定 (qwen2.5-3b temperature=0); 重跑同一 session 不产生副作用。
6. **可观测** — 每次 recall 至少打出一条 debug log: `[recall] gate={pass|skip|timeout} rerank={ok|fallback|skip|all-below} pre=N post=M latency={gate,recall,rerank}ms`。
7. **TUI 状态** — 现有 `📦 N atoms · rule=… · top=0.XXX` / `🔍 no memory match` / `⚠ memory recall failed` 之外, 新增 `🚫 gate skipped` / `⚠ gate timeout, skipped` / `⚠ rerank fallback`。
8. **向后兼容** — rerank 模型未加载时 (bge-m3 服务端未升级 / 模型未下载) → fallback 到原 RRF; 不抛错; 不阻塞 recall; log warn。