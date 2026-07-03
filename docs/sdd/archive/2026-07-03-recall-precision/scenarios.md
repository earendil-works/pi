# 场景: recall-precision

## Cap: gate

### S1 — 指代性 short query (need_memory=false)
- **GIVEN** session 上下文最近 2-3 条 user msg = ["把 search_3n_path.py 改成异步的", "改成异步后跑一下", "改成异步的版本跑出来了 但是 上面的脚本有问题"], 当前 user msg = "上面的脚本有问题"
- **WHEN** gate 调用 qwen2.5-3b, prompt 含上述 3 条 user msg
- **THEN** gate 输出 `{need_memory: false, search_query: ""}` (指代 "上面的脚本" 是对话上文的脚本, 不是 memory 里某个 atom)
- **AND** recall 被跳过, setStatus "🚫 gate skipped", 不注入 memory context, 端到端延迟 < 500ms

### S2 — 零信息量 ack query (need_memory=false)
- **GIVEN** recent user msgs = ["列一下 TODO", "列一下 TODO"], 当前 = "对"
- **WHEN** gate 调用
- **THEN** gate 输出 `{need_memory: false, search_query: ""}`
- **AND** recall 跳过, setStatus "🚫 gate skipped", 端到端延迟 < 500ms

### S3 — 语义清晰历史回溯 query (need_memory=true, 改写成功)
- **GIVEN** recent user msgs = ["我们之前用 bwa 做过引物验证吗", "做了 但是有个并发问题"], 当前 = "之前那个并发问题最后怎么解决的"
- **WHEN** gate 调用
- **THEN** gate 输出 `{need_memory: true, search_query: "bwa 引物验证 并发问题 解决方案"}`
- **AND** 后续 pipeline 用 `search_query` (不是原 user msg) 调用 recallAtoms

### S4 — 直接关键词查询不变写 (need_memory=true, search_query ≈ user msg)
- **GIVEN** recent user msgs = ["列一下 TODO"], 当前 = "mgm 项目的鉴权方案是什么"
- **WHEN** gate 调用
- **THEN** gate 输出 `{need_memory: true, search_query: "mgm 项目 鉴权方案"}` (只做轻度改写 / 保持原义)

### S5 — gate JSON 解析失败 (降级 skip)
- **GIVEN** qwen2.5-3b 返回不合法 JSON (缺失花括号 / 含前后杂字 / 不闭合)
- **WHEN** gate 解析
- **THEN** 重试 1 次 (retry-parse strip 后头杂字); 仍失败 → skip 召回 + setStatus "🚫 gate skipped (parse failed)", log warn 含原始输出前 200 字符

### S6 — gate 超时 (降级 skip)
- **GIVEN** ollama 500ms 内未响应 (CPU 占满 / 模型 lazy load 中)
- **WHEN** AbortController 触发
- **THEN** 不抛出, setStatus "⚠ gate timeout, skipped", context hook 直接返回原 event, 不注入

### S7 — ollama 服务挂掉
- **GIVEN** `curl http://127.0.0.1:11434/api/tags` ECONNREFUSED
- **WHEN** gate 调用 fetch
- **THEN** fetch 抛 ECONNREFUSED → catch 内吞掉 → setStatus "⚠ gate down, skipped"; 不阻塞 context hook; 端到端延迟 < 100ms

## Cap: rerank

### R1 — 正常精排路径 (rerank 改变原 RRF 顺序)
- **GIVEN** gate 通过 + recallAtoms 返回 8 个 bge-m3 RRF 候选
- **WHEN** 调用 `/api/rerank` (query + 8 个 hit 的 embeddable 文本), cross-encoder 给每个 score
- **THEN** 返回按 rerank_score 降序的 hit list, rerank_score 字段加进 RecallResult; 8 个 score 中假设 [0.92, 0.85, 0.55, 0.32, 0.21, 0.18, 0.15, 0.10]
- **AND** threshold ≥0.5 → 保留前 3 个 [0.92, 0.85, 0.55]
- **AND** 没有 gap > 0.15 出现在 0.55 之前 (相邻 0.92→0.85 = 0.07, 0.85→0.55 = 0.30 > 0.15!)
- **AND** gap 截断在 gap 前 → 实际保留 [0.92, 0.85]; 结果数组长度 2

### R2 — threshold 单独过滤 (无 gap 跳跃)
- **GIVEN** rerank scores = [0.92, 0.85, 0.55, 0.52, 0.51, 0.50, 0.30, 0.28]
- **WHEN** threshold ≥0.5 + gap>0.15 截断
- **THEN** threshold 过滤后 [0.92, 0.85, 0.55, 0.52, 0.51, 0.50]; 最大相邻 gap = 0.85→0.55 = 0.30 > 0.15 → 截断在 index 1 → 最终 [0.92, 0.85]

### R3 — 全部低于 threshold (不注入)
- **GIVEN** rerank scores = [0.48, 0.45, 0.42, 0.30] (gate 通过但 cross-encoder 全部否定)
- **WHEN** threshold 过滤
- **THEN** 所有 hit 被丢弃, 返回空数组; setStatus "🔍 no memory match"; 注入被跳过

### R4 — rerank 超时 (降级 fallback)
- **GIVEN** `/api/rerank` 500ms 内未响应
- **WHEN** AbortController 触发
- **THEN** 不重试, 直接返回 gate-通过后的原 RRF top-K (默认 top-3); setStatus "⚠ rerank fallback"; 8 个候选里取 RRF 分数前 3 (无精度过滤)

### R5 — rerank 服务挂 (降级 fallback)
- **GIVEN** bge-m3 server 未升级 / `/api/rerank` 端点未存在 (404) / 模型未加载 (503)
- **WHEN** rerank 调用
- **THEN** 等同 R4: fallback 到原 RRF top-K, setStatus "⚠ rerank fallback", 加一条 warn log 标明原因 (404 / 503 / connection)

### R6 — 空候选 (gate 通过但 recall 返回 0)
- **GIVEN** gate 通过 + recallAtoms 返回 []
- **WHEN** 进入 rerank 阶段
- **THEN** 不调用 rerank, 直接短路, setStatus "🔍 no memory match", 注入被跳过, 端到端 < 700ms

### R7 — 单一候选 (无 gap 计算)
- **GIVEN** rerank 仅返回 1 个 hit, score=0.7
- **WHEN** threshold ≥0.5 + gap 检查
- **THEN** threshold 通过 (≥0.5), gap 计算单元素视为 0 (无后继可比较), 保留 [0.7] 这 1 个

## Cap: pipeline / orchestration

### P1 — 完整 happy path
- **GIVEN** 用户输入 "之前那个并发问题最后怎么解决的", context event 携带最近 2-3 user msgs
- **WHEN** pipeline 触发
- **THEN** 顺序: gate (300ms) → hybridSearch (50ms) → rerank (500ms) → gap+threshold (0ms) → formatMemoryContext
- **AND** 总延迟 ~850ms, context 8s timeout 充裕
- **AND** RecallResult 携带 `rerank_score` 字段, formatMemoryContext 按 rerank_score 降序 (不是 RRF rrf) 

### P2 — context hook 不阻塞 import cold path
- **GIVEN** 上一 turn context 已注入 memory 后, 下一 turn 触发前
- **WHEN** gate 调 ollama
- **THEN** gate 用动态 import 拿 fetch, 不预先 import gate.ts; before_agent_start 改成只清理 module-level 状态, 不阻塞 session 启动

### P3 — 并发 prompt (keying 仍正确)
- **GIVEN** 两 prompt 几乎同时进入 context
- **WHEN** pendingMemorySearches Map lookup
- **THEN** 仍按 lastUserPrompt match; 不应因设计差异 (gate 路径 vs 旧路径) 改变 keying 规则

### P4 — idempotent
- **GIVEN** 同样 input pair 跑两次
- **WHEN** 两次 gate / rerank / format
- **THEN** 两次结果等同 (qwen2.5-3b temperature=0, rerank 无随机性), 不写 db, 不改 atoms

### P5 — 老路径用户禁用 gate (settings.json)
- **GIVEN** settings.json 含 `personalAssistant.memory.gate: {enabled: false}` (默认 enabled:true)
- **WHEN** pipeline 启动
- **THEN** skip gate, 直接走 rerank + gap (假阳性率从 ~80% 降到 ~45%, 适合用户过渡阶段) — 但 router 必须能把 enabled=false 识别为 valid config, 不抛TypeError

### P6 — 老路径用户禁用 rerank (settings.json)
- **GIVEN** settings.json 含 `personalAssistant.memory.rerank: {enabled: false}` (默认 enabled:true)
- **WHEN** pipeline 启动
- **THEN** gate 通过后直接返回 RRF top-K, 不走 rerank threshold/gap; 假阳性率随 gate 段阶降低

### P7 — 排序稳定性 (rerank_score 同分)
- **GIVEN** rerank 返回两个 hit score 都是 0.55
- **WHEN** sort + 截断
- **THEN** 按 RRF rrf 字段二次排序 (稳排序); 同分 hit 不会乱次序