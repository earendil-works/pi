# recall-precision Specification

Capability: 在 memory recall pipeline 上加 gate (LLM 决策是否召回 + 改写 query) + cross-encoder rerank + gap 截断, 把假阳性率从 ~80% 降到 ~10%。

## ADDED Requirements

### Requirement: Recall gate via local LLM (qwen2.5:3b)
memory recall pipeline SHALL 在 `context` hook 入口先经过 gate LLM 决策: 给定当前 user msg + 最近 2-3 条 user msg, 输出 `{need_memory: boolean, search_query: string}`。gate 走 ollama qwen2.5:3b-instruct-q4_0 (温度 0), 500ms 超时, 失败一律降级 skip 召回 (不 fallback 走原 RRF), TUI 显示对应状态。

#### Scenario: 指代性 short query 被 gate 拦截 (S1)
- **GIVEN** recent user msgs = ["把 search_3n_path.py 改成异步的", "改成异步后跑一下", "改成异步的版本跑出来了 但是 上面的脚本有问题"], 当前 = "上面的脚本有问题"
- **WHEN** gate 调用 qwen2.5:3b
- **THEN** 输出 `{need_memory: false, search_query: ""}`, recall 被跳过, TUI 显示 "🚫 gate skipped", 不注入 memory context, 端到端延迟 < 500ms

#### Scenario: 零信息量 ack query 被 gate 拦截 (S2)
- **GIVEN** recent = ["列一下 TODO", "列一下 TODO"], 当前 = "对"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: false}`, 跳过 recall, status "🚫 gate skipped"

#### Scenario: 历史回溯 query 被 gate 改写后召回 (S3)
- **GIVEN** recent = ["我们之前用 bwa 做过引物验证吗", "做了 但是有个并发问题"], 当前 = "之前那个并发问题最后怎么解决的"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: true, search_query: "bwa 引物验证 并发问题 解决方案"}`, 后续 recallAtoms 用 `search_query` (非原 msg)

#### Scenario: 直接关键词查询轻度改写 (S4)
- **GIVEN** recent = ["列一下 TODO"], 当前 = "mgm 项目的鉴权方案是什么"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: true, search_query: "mgm 项目 鉴权方案"}`

#### Scenario: gate JSON 解析失败降级 skip (S5)
- **GIVEN** qwen2.5-3b 返回不合法 JSON (缺失花括号 / 含前后杂字 / 不闭合)
- **WHEN** gate 解析 (strip 前后非 `{...}` 段后重 parse) 1 次仍失败
- **THEN** 返回 null, skip 召回, status "🚫 gate skipped (parse failed)", debug log 含原始输出前 200 字符

#### Scenario: gate 超时 500ms (S6)
- **GIVEN** ollama 500ms 内未响应 (CPU 占满 / 模型 lazy load)
- **WHEN** AbortController 触发
- **THEN** 不抛出, 返 null, status "⚠ gate timeout, skipped", 完成 context hook 返回原 event

#### Scenario: ollama 服务挂掉 (S7)
- **GIVEN** `curl http://127.0.0.1:11434/api/tags` ECONNREFUSED
- **WHEN** gate fetch 抛 ECONNREFUSED
- **THEN** catch 内吞掉, status "⚠ gate down, skipped", 端到端延迟 < 100ms, context hook 不注入

### Requirement: Cross-encoder rerank endpoint on bge-m3 server
bge-m3 server (`/tmp/bge-m3-test/server.py` 即 http://127.0.0.1:11435) SHALL 加 `POST /api/rerank` 端点: 接收 `{query, hits: [{id, embeddable_text}]}`, 用 `BAAI/bge-reranker-v2-m3` (FlagReranker, lazy load, use_fp16=True) 对每对 `[query, embeddable_text]` 计算 score (normalize=True, [0,1] float), 返回 `{scores: [{id, score}]}`。模型首次 use 时 lazy load, 568MB 内存开销, 同进程同 GPU。`/api/health` SHALL 报告 `reranker_loaded` 与 `reranker_loading` 字段。

#### Scenario: rerank 端点 happy path
- **GIVEN** server 已启动, reranker 已 lazy loaded
- **WHEN** `POST /api/rerank` body `{"query":"bwa 并发","hits":[{"id":"a","embeddable_text":"bwa 引物并发问题解决方案"}]}`
- **THEN** 返回 `{"scores":[{"id":"a","score":0.6...,}]}` (score ∈ [0,1])

#### Scenario: reranker 未加载 503 (R5)
- **GIVEN** server 启动后第一次调 /api/rerank 且 lazy load 失败 (FlagEmbedding 类不可用)
- **WHEN** client POST
- **THEN** server 返 503, 客户端检测非-2xx → fallback 原 RRF top-K, status "⚠ rerank fallback"

### Requirement: rerank threshold + gap detection 截断
`rerankAndFilter(query, hits, options)` SHALL 在 rerank score 上应用双重截断: (1) threshold ≥0.5 过滤低分; (2) 相邻 gap >0.15 第一处截断。同分按原 RRF rrf 二次排序 (稳排序)。原始 bge-m3 RRF score 不再参与最终排序, formatMemoryContext 按 rerankScore 降序。

#### Scenario: threshold + gap 双截断 (R1)
- **GIVEN** rerank scores = [0.92, 0.85, 0.55, 0.32, 0.21, 0.18, 0.15, 0.10]
- **WHEN** threshold ≥0.5 + gap>0.15 截断
- **THEN** threshold 过 3 个 [0.92, 0.85, 0.55]; gap 在 0.85→0.55 = 0.30 > 0.15 截前 2 个 → 返 [0.92, 0.85]

#### Scenario: threshold 单独过滤无 gap 跳跃 (R2)
- **GIVEN** scores = [0.92, 0.85, 0.55, 0.52, 0.51, 0.50, 0.30, 0.28]
- **WHEN** threshold + gap
- **THEN** threshold 过 6 个, gap 在 0.85→0.55 = 0.30 > 0.15 → 截前 2 个

#### Scenario: 全部低于 threshold 不注入 (R3)
- **GIVEN** scores = [0.48, 0.45, 0.42, 0.30]
- **WHEN** threshold ≥0.5
- **THEN** 所有 hit 被丢, 返 [], status "🔍 no memory match", 注入跳过

#### Scenario: rerank 单一候选 (R7)
- **GIVEN** scores = [0.7]
- **WHEN** threshold + gap
- **THEN** threshold 过, gap 单元素视为无后继可比较 → 保留该 1 个 hit

### Requirement: rerank 故障降级 fallback
rerank 故障 (timeout 500ms / 404 / 503 / 模型未加载 / response shape 不合) SHALL 不阻塞 recall, fallback 到 gate-通过后的原 RRF top-K (客户端取 hits 数前 3 个)。TUI 显示 "⚠ rerank fallback"。debug log 区分超时 / 404 / 503 / 不可达。

#### Scenario: rerank 超时 (R4)
- **GIVEN** `/api/rerank` 500ms 内未响应
- **WHEN** AbortController 触发
- **THEN** 不重试, 直接返原 RRF hits.slice(0, 3) (前 3), status "⚠ rerank fallback"

#### Scenario: rerank 端点 404 (R5)
- **GIVEN** server 未升级, `/api/rerank` 不存在
- **WHEN** fetch 返 404
- **THEN** 同 R4 降级, status "⚠ rerank fallback (unavailable)"

#### Scenario: rerank disabled via config (P6)
- **GIVEN** settings.json `memory.rerank.enabled=false`
- **WHEN** pipeline 走到 rerank 阶段
- **THEN** 跳过 rerank, 直接返回 gate-通过后的原 RRF top-K (不取前 3 截断), 不调 `/api/rerank` (fetch not invoked)

### Requirement: gate + rerank pipeline 整合到 context hook
memory.ts SHALL 把 gate→recallAtoms→rerankAndFilter→formatMemoryContext 整条 pipeline 整合到 `context` hook (而非 `before_agent_start`), 因为 gate 需 recent user msgs 历史 (仅 ContextEvent 携 messages[])。`before_agent_start` hook SHALL 退化为 module-level `pendingMemorySearches` Map cleanup, 不再触发 recall。context hook 8s 总 timeout 不再需 race/pending-MAP lookup (pipeline 同步 await, P95 ~1.1s)。

#### Scenario: 完整 happy path (P1)
- **GIVEN** ContextEvent.messages 含最近 2-3 user msg + 当前
- **WHEN** pipeline 触发
- **THEN** 顺序: gate (~300ms) → recallAtoms (~50ms) → rerankAndFilter (~500ms) → formatMemoryContext, 总 ~850ms, 8s budget 充裕, RecallResult.rerankScore 已填, formatMemoryContext 按 rerankScore 降序

#### Scenario: idempotent (P4)
- **GIVEN** 同样 input pair 跑两次
- **WHEN** 两次 gate (temperature=0) / rerank (无随机)
- **THEN** 两次结果等同, 不写 db, 不改 atoms

#### Scenario: gate disabled via config (P5)
- **GIVEN** settings.json `memory.gate.enabled=false`
- **WHEN** pipeline 启动
- **THEN** skip gate, 直接走 recallAtoms + (可选 rerank) + format; gate fetch not invoked; 假阳性率降 ~45% (无 query 改写, 仍走 rerank 过滤)

### Requirement: pipeline per-call debug log
每次 context hook 触发 SHALL 在 pipeline 末尾 (无论 gate skip 还是 happy path) emit 一条 `console.debug` log: `[recall] gate=${gate.status} rerank=${rerank.status} pre=${hybridCount} post=${finalCount} latency {gate:${gateMs}ms recall:${recallMs}ms rerank:${rerankMs}ms}`。gate.status ∈ {pass, skip-false, parse-fail, timeout, down, disabled}; rerank.status ∈ {ok, fallback, skip, all-below, disabled}。0 表示未执行该步。

#### Scenario: 注入成功的 log 含全字段
- **GIVEN** gate pass + rerank ok, pre=8, post=2, 各段 latency 实测
- **WHEN** pipeline 末尾
- **THEN** `console.debug` 被调用 1 次, 内容含 `gate=pass`, `rerank=ok`, `pre=8`, `post=2`

#### Scenario: gate skip 时 log 仍 emit
- **GIVEN** gate 返 need_memory=false
- **WHEN** pipeline 末尾
- **THEN** log 含 `gate=skip-false`, `rerank=skip`, `pre=0`, `post=0`

### Requirement: TUI status palette 扩展
TUI `ctx.ui.setStatus("memory", <msg>)` SHALL 在 recall pipeline 7 个分支下分别显示: `🚫 gate skipped` (S1/S2) / `🚫 gate skipped (parse failed)` (S5) / `⚠ gate timeout, skipped` (S6) / `⚠ gate down, skipped` (S7) / `🔍 no memory match` (R3 + gate 通过 recall 空) / `⚠ rerank fallback` (R4/R5) / `📦 N atoms · rule=X fact=Y process=Z · top=<max rerankScore>` (P1 happy path)。top 字段优先取 `rerankScore` (happy path) 不可用时降级取 `rrf` (fallback 路径)。

#### Scenario: happy path status 含 atom 数与 top rerankScore
- **GIVEN** recall pipeline 返 2 atoms, rerankScore 分别 0.92, 0.85
- **WHEN** setStatus 调用
- **THEN** 字符串匹配 `📦 2 atoms · rule=.. fact=.. process=.. · top=0.92`

#### Scenario: rerank fallback 时 top 用 rrf
- **GIVEN** rerank 失败 fallback 原 RRF top-3, rrf 0.05 为最大
- **WHEN** setStatus 调用
- **THEN** 字符串匹配 `⚠ rerank fallback` (无 top 数字 — fallback 路径不取 top,避免误读)

### Requirement: RecallResult 扩展 rerankScore 字段
`RecallResult` interface SHALL 加 `rerankScore?: number` 字段 (optional, 老路径/老测试不破)。当且仅当 rerank 端点成功响应且自身过 threshold + gap 后, 字段被填; 否则保持 undefined。

#### Scenario: 老 search 不破
- **GIVEN** RecallResult 已有定义, search.ts 使用未打断
- **WHEN** 加 optional `rerankScore?: number`
- **THEN** `npm run check` 无 error, `test/search.test.ts` / `test/recall-quality.test.ts` 全绿 (没改实现)

#### Scenario: formatMemoryContext 优先用 rerankScore 排序
- **GIVEN** results 含 5 个 RecallResult, 3 个已填 rerankScore, 2 个 undefined (禁用 rerank 场景)
- **WHEN** formatMemoryContext 排序
- **THEN** sorted 对照: 有 rerankScore 的前 3 按 rerankScore DESC, 后 2 按 rrf DESC (兜底)