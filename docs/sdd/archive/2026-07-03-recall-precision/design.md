# 技术设计: recall-precision

## 架构决策

### D1: pipeline 入口从 `before_agent_start` 改到 `context` hook
- **问题**: gate 需要最近 2-3 条 user msg。`BeforeAgentStartEvent` 仅含 `prompt: string` + `systemPrompt`, 不带历史; `ContextEvent` 才含 `messages: AgentMessage[]` 全对话。
- **决策**: 把 gate→recall→rerank→gap→format 整条 pipeline 移进 `context` hook。`before_agent_start` 保留为 no-op (清理 `pendingMemorySearches` map 防止 stale leak), 不再触发 recall。
- **代价**: 旧 `pendingMemorySearches` + 8s race 设计废弃; 现 context hook 内同步 await 全 pipeline (gate 300ms + recall 50ms + rerank 500ms = ~850ms), 仍在 8s context total budget 内。
- **替代方案被否**: (a) memory.ts 内加 module-level user-msg 短窗 buffer — 用户已拒 ("重复私信管理"); (b) ContextEvent 自带 messages 但 before_agent_start 可同步从 ExtensionContext.session 读历史 — 检查过 `BeforeAgentStartEvent` 与 ExtensionAPI 无 history 访问接口。
- **改动量**: memory.ts 删除 `before_agent_start` 内的 recall 触发逻辑 (~30 行), 移动到 `context` hook; `pendingMemorySearches` 与 8s race 整段 (~40 行) 删除, 替换为 pipeline await 模式; `CONTEXT_RECALL_TIMEOUT_MS` 提升到 `5000`ms (覆盖 gate+rerank 最坏情况)。

### D2: gate LLM 走 ollama qwen2.5:3b-instruct-q4_0
- **现状**: ollama 11434 已跑, 已下载 `qwen2.5:3b-instruct-q4_0` (1.8GB)。无新进程。
- **API**: `POST http://127.0.0.1:11434/api/chat` body `{model, messages, stream:false, options:{temperature:0}}`, response `{message:{content}}` (content 是字符串, 含 JSON)。
- **prompt 长度预算**: system ~80 token + 最近 3 user msg ~150 token + 当前 user msg ~50 token + JSON 输出 ~30 token = ~310 token。qwen2.5:3b 在 32768 ctx 内任意无压力。
- **timeout**: 500ms AbortController (qwen2.5:3b q4_0 warm 状态下 P50 200-300ms, P95 400ms)。冷启动 (模型第一次加载) 5-10s, 会触发 timeout → 降级 skip — 可接受 (用户重启 pi 第一次 recall 容忍一遍降级)。
- **不使用 completeSimple / settings.json 配置**: gate 是性能门, 不是用户可换的 quality-of-service 选项, 走 hardcoded 调用更简洁; 用户不喜欢可禁用整个 gate (D6)。

### D3: gate 输出 schema + 解析容错
- **正样本**: `{"need_memory": true, "search_query": "bwa 并发 验证方案"}`
- **负样本**: `{"need_memory": false, "search_query": ""}`
- **解析路径**:
  1. `JSON.parse(content.trim())`
  2. 失败则 strip 前后非 `{...}` 段(常见 qwen2.5 输出 `好的, 你的回复:` 前缀)后重 `JSON.parse`
  3. 验证: `typeof need_memory === "boolean"` 且 `typeof search_query === "string"`; 否则当 parse fail (S5 走降级 skip)
- **不引入 zod 或额外 schema 库**: ollama response shape 太简单, JSON.parse + 2 字段验证足够; extraction-dedup-confirm.ts 那 zod 风格仅用在需要复杂数据结构的场景。

### D4: rerank 占位 — server.py 加 `/api/rerank`
- **端点**: `POST /api/rerank` body `{query: string, hits: [{id, embeddable_text}]}`, response `{scores: [{id, score}]}`; score 是 [0,1] float (bge-reranker-v2-m3 输出 sigmoid 化)。
- **模型**: `BAAI/bge-reranker-v2-m3` (~568MB, HuggingFace)。在 `FlagEmbedding` 同包 `FlagReranker` 类加载: `from FlagEmbedding import FlagReranker; reranker = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)`, `.compute_pairs([[query, text], ...])` 返回 raw logits, sigmoid 化后 [0,1]。
- **常驻**: 在 `state` 模块变量上加 `state.reranker = None`, 启动 lazy-load (首次 `/api/rerank` 时加载, 不阻塞 server start); 568MB 内存额外开销, 单进程同 GPU 槽位。
- **embeddable_text 客户端构造**: 客户端复用 `buildEmbeddableText(atom)`(embed.ts) — 用 atom 的 `title+summary+tags` (与 dense encoding 同源, 与 atom contents 保持一致), 客户端 query→recall→发 atom embeddable text 给 rerank, server 不查 sqlite。
- **响应扩展**: server.py 已有 latency 中间件, rerank 端点自动 trace P50。

### D5: threshold + gap 截断算法 (客户端)
- **输入**: `[{id, score}]` 按 score 降序 (server 返回即排序, 客户端保险式 copy+sort)
- **步骤**:
  1. threshold filter: 丢弃 `score < 0.5`
  2. gap detection: 遍历相邻 i, i+1, 若 `scores[i] - scores[i+1] > 0.15` 则截断在 i 位置 (保留 [0, i])
  3. tie-breaker: 同 score 用 RRF rrf 降序 (caller 注入)
- **原 RRF score 不再参与排序**, 整 pipeline 输出顺序只看 rerank score。
- **空集规则** (S3): threshold filter 后空集 → 直接返回 []; gap 截断后空集 → 返回 []; 不取 top-1 兜底 (R3)。
- **单元素规则** (S7): 单 hit score ≥ 0.5 通过, gap calc 保留 (无相邻可比较)。

### D6: settings.json 禁用入口 (向后兼容)
- **schema 扩展** (memory.ts `PersonalAssistantConfig`):
  ```
  memory?: {
    enabled?: boolean  // 已有, 控整个 memory subsys
    gate?: { enabled?: boolean }      // 默认 true, 用户禁用直接跳 gate 走老 RRF
    rerank?: { enabled?: boolean }    // 默认 true, 用户禁用跳过 rerank 走 gate-后原 RRF top-K
    ...
  }
  ```
- **向后兼容缺失**: settings.json 老文件无 `gate`/`rerank` 字段 → `loadConfig()` 返回 `{}`, 代码内 `config.memory?.gate?.enabled ?? true` 永不抛错。

### D7: 失败降级矩阵
| 故障 | 行为 | TUI 状态 | 注入 |
|------|------|----------|------|
| gate skipped (need_memory=false) | 直接 return | "🚫 gate skipped" | 无 |
| gate JSON 解析失败 (retry 仍失败) | skip 召回 | "🚫 gate skipped (parse failed)" | 无 |
| gate 超时 500ms | skip 召回 | "⚠ gate timeout, skipped" | 无 |
| gate 服务连接拒绝 | skip 召回 | "⚠ gate down, skipped" | 无 |
| gate 通过 + recall 返回空 | 短路 | "🔍 no memory match" | 无 |
| gate 通过 + rerank 超时 500ms | fallback 到 gate-后原 RRF top-3 | "⚠ rerank fallback" | top-3 RRF 原序 |
| gate 通过 + rerank 端点 404/503 | 同上 | "⚠ rerank fallback (unavailable)" | top-3 |
| gate 通过 + rerank 全 score <0.5 | 不过注 | "🔍 no memory match" | 无 |
| gate 通过 + rerank 后结果 1-3 个 | happy path | "📦 N atoms · top=max.rerank_score" | rerank 降序 |

### D8: 模块边界
```
extensions/personal-assistant/
├── gate.ts          NEW    callGate(prompt, recentMsgs, timeoutMs=500) → Promise<{need_memory, search_query} | null>
├── rerank.ts        NEW    rerankAndFilter(query, hits, options) → Promise<RecallResult[]>  (包含 threshold + gap)
├── search.ts        MOD    recallAtoms 不变 (返回 HybridHit[]), 不做 rerank; RecallResult 加 rerankScore? 字段
├── format.ts        DEL    不变 (纯 renderer); 不重排 (rerank.ts 已排)
├── memory.ts        MOD    context hook 整合 gate→recall→rerank→format; before_agent_start 简化
├── types.ts         MOD    RecallResult 加 rerankScore?: number
└── server.py        MOD    /tmp/bge-m3-test/server.py 加 /api/rerank + lazy load reranker
```

### D9: 测试策略
- **gate.ts**: 单元测试用 nock / fetch mock, 覆盖 happy / parse-fail-retry / timeout / conn-refused / schema-valid
- **rerank.ts**: 单元测试 mock `/api/rerank` 响应, 覆盖 S1-R7 (threshold / gap / 单元素 / 全低分 / 404)
- **memory.ts**: integration 测试 FakeMemoryIndex + fetch mock 模拟 gate/rerank, 覆盖 P1/P4/P5/P6 (全 pipeline / idempotent / 禁用 gate / 禁用 rerank)
- **server.py**: 手测 + 新加 `/api/health` 报告 reranker 加载状态 (loaded: true/false), 不写 pytest (服务端 bge-m3 测试已有 tune_floors.py / rrf_eval.py 模式, 单测推到集成层面)

### D10: 不做事项 / 已否选项 (避免回头讨论)
- **HyDE**: 推理成本远超 gate, 不适合聊天上下文 — 不做。
- **二阶段 LLM rerank** (Cohere Rerank v3 风): 延迟 1-2s 太重 — 不做。
- **dense_floor 调到 0.7**: 治标, 不治 1/2 病因; 用户已选 rerank 路径 — 不做。
- **multi-query expansion**: gate 输出多 search_query 并 union 召回 — 复杂度 +1, 假设假阳性降到 ~5% 而非 10%, 边际收益不值 — 不做 (留 v2 follow-up)。
- **gate cache (per-prompt)**: 跨 prompt 同最后 result 复用 — 与"幂等 P4"已保证, 但副作用是 cache 失效检测复杂; qwen2.5:3b 轮询不算瓶颈 — 不做。
- **rerank 模型持久化 cache**: 同 query+hit_set 缓存 score — 同上原因, 不做。
- **改 RecallResult 类型加 `gate_decision`, `gate_query`**: format.ts 用不到, 测试用 mock 注入即可 — 不做 (debug log 现时已够)。

## 复用现有

- `embed.ts:buildEmbeddableText(atom)` — 构造 rerank 输入的 embeddable text, 不重复实现。
- `format.ts:formatMemoryContext` — 纯渲染, 接 rerank 排序后的 RecallResult[]。
- `search.ts:recallAtoms` — 不变, 仍是 bge-m3 RRF 候选生成器。
- `storage.ts:MemoryIndex.getAtom(h.id)` — RecallResult 构造时复用 hydration。
- `memory.ts:loadConfig()` — 复用 settings 解析; 仅扩展 PersonalAssistantConfig 类型 (D6)。
- `memory.ts:notifySafely` — 复用 ctx.ui.notify 容错封装。
- `memory.ts:pendingMemorySearches Map` — 保留并发 turn keying (P3), 不需重新设计。

## 延迟预算 (P95)

| 阶段 | P50 | P95 | timeout |
|------|-----|-----|---------|
| gate (qwen2.5:3b q4) | 200-300ms | 400ms | 500ms |
| hybridSearch (bge-m3) | 50ms | 100ms | 15000ms (沿用) |
| rerank (cross-encoder, top-8) | 400-500ms | 600ms | 500ms (重设) |
| threshold+gap (local) | 0ms | 0ms | — |
| formatMemoryContext (local) | 0ms | 0ms | — |
| **总** | **~750ms** | **~1100ms** | **8s budget 余量充分** |
<!-- archived-with: 2026-07-03-recall-precision | status: final -->
