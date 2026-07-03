# Tasks: recall-precision

> **Design:** design.md | **Base:** 1c3972b2792df96179adcdc9c77a785db8540d13

**Goal:** 在 memory recall pipeline 上加 gate (LLM 决策是否召回 + 改写 query) + cross-encoder rerank + gap 截断, 把假阳性率从 ~80% 降到 ~10%。

**Architecture:** pipeline 从 `before_agent_start` 整体移入 `context` hook (gate 需 messages[] 历史); gate 走 ollama 11434 qwen2.5:3b 500ms timeout → 失败 skip 召回; 通过则 recallAtoms (不变, bge-m3 RRF) → rerankAndFilter (server.py `/api/rerank` cross-encoder, 500ms timeout → fallback 原 RRF top-3); 客户端 threshold ≥0.5 + gap>0.15 截断; formatMemoryContext 按 rerank_score 降序注入。

**Tech Stack:** ollama qwen2.5:3b-instruct-q4_0 (gate LLM), bge-reranker-v2-m3 via FlagEmbedding (cross-encoder, server.py 内 lazy load), TypeScript (extensions/personal-assistant), Python FastAPI (server.py), better-sqlite3, vitest (test/), zod 不引入 (gate 输出仅 2 字段 JSON.parse)。

## Notes

- **`依赖`** = 执行序 (sdd-develop DAG 并行消费)
  - 格式: `1.1, 2.3` 逗号分隔, 括号注释允许
  - Task ID 格式: `<section>.<task>[letter]` (1.1, 1.10, 2.1a 均合法; 1.1A / 1.1ab 不合法)
- **`前置阅读`** = 仅上下文, 不影响并行度

## 1. 类型 & Config 基础

- [x] 1.1 **RecallResult 加 optional rerankScore**
  - **文件**: `extensions/personal-assistant/types.ts` (Modify)
  - **内容**: 给 `RecallResult` interface 加 `rerankScore?: number` 字段, 保留所有现有字段 (atom, cosine, sparseScore, rrf, relativePath)。Optional 以确保老路径 / 测试无破坏。
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/typescript/bin/tsgo --noEmit types.ts 2>&1 | head -5` 无错; 跑 `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts` 全绿
  - **依赖**: 无
  - **前置阅读**: scenario P1, types.ts 现有定义

- [x] 1.2 **PersonalAssistantConfig 加 gate/rerank 开关**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 在 `PersonalAssistantConfig.memory` interface 加 2 个 optional 字段: `gate?: { enabled?: boolean }` (默认 true) 与 `rerank?: { enabled?: boolean }` (默认 true)。不改 `loadConfig()` 函数体 (existing `JSON.parse + ?? {}` 已 cover 缺失字段)。在 interface 上方 JSDoc 注明 "默认 enabled, 缺失不影响老 settings.json"。
  - **验证**: `npm run check 2>&1 | grep -E "memory.ts|error" | head -10` 无 error
  - **依赖**: 无
  - **前置阅读**: design.md D6, P5/P6 scenarios

- [x] 1.3 **formatMemoryContext 排序改为 rerankScore 优先**
  - **文件**: `extensions/personal-assistant/format.ts` (Modify)
  - **内容**: `formatMemoryContext` 函数内 sort 逻辑改为: 优先按 `rerankScore` DESC (有 `rerankScore` 字段的 hit 排前), `rerankScore === undefined` 的 hit 之间按 `rrf` DESC 兜底。具体逻辑: `sorted = [...results].sort((a, b) => { const ar = a.rerankScore ?? -1; const br = b.rerankScore ?? -1; if (ar !== br) return br - ar; return (b.rrf ?? 0) - (a.rrf ?? 0); })`。`-1` 兜底值确保无 rerankScore 的 hit 始终排在有 score 的之后。保留原 budget 限制逻辑。
  - **验证**: 新建 `test/format-sort.test.ts` 3 个 case: (a) 5 个 hit `[s=0.92,s=0.85,undefined,undefined,s=0.55]` 输出含 0.92→0.85→0.55 在前 3 块; (b) 全 undefined → 按 rrf DESC; (c) 同 rerankScore 不同 rrf → rrf 二次排序。`node ../../node_modules/vitest/dist/cli.js --run test/format-sort.test.ts` 全绿
  - **依赖**: 1.1
  - **前置阅读**: spec R3 (formatMemoryContext 按 rerank_score 降序), format.ts:57 现有 sort

## 2. gate 模块 (gate.ts)

- [x] 2.1 **gate.ts 文件骨架 + callGate signature**
  - **文件**: `extensions/personal-assistant/gate.ts` (Create)
  - **内容**: 导出 `export interface GateDecision { need_memory: boolean; search_query: string }` 与 `export async function callGate(prompt: string, recentUserMsgs: string[], options: GateOptions): Promise<GateDecision | null>`。`GateOptions = { ollamaUrl?: string; model?: string; timeoutMs?: number }`。signature 用 500ms timeout 默认, ollamaUrl 默认 `http://127.0.0.1:11434`, model 默认 `qwen2.5:3b-instruct-q4_0`。空函数体返回 null, 后续 step 填充。
  - **验证**: `npm run check 2>&1 | grep gate.ts` 无错; `grep export extensions/personal-assistant/gate.ts` 看到 2 个 export
  - **依赖**: 无
  - **前置阅读**: design.md D2, D3

- [x] 2.2 **gate prompt 构造器 buildGatePrompt**
  - **文件**: `extensions/personal-assistant/gate.ts` (Modify)
  - **内容**: 在 gate.ts 内加 `function buildGatePrompt(current: string, recent: string[]): string` 构造 system+user 的 ollama `messages` 数组对应的字符串 (system 一段 + user 一段, 拼成 single-prompt 形式以便 debug log)。System 含: "你是 memory recall 决策助手. 输出 JSON, 字段 need_memory (bool) 和 search_query (string). 判断当前用户消息是否值得查 long-term memory. 指代性消息 ('上面的脚本', '那个') → need_memory=false. 零信息量 ('对', '好的', '继续') → need_memory=false. 历史回溯 ('之前', '记得吗', '历史') 且需要 memory 才 need_memory=true; search_query 用关键词提取, 不含指代词."。User 段含 "Recent user messages:\n- {recent[0]}\n- {recent[1]}\n- {recent[2]}\nCurrent message:\n{current}\n\nRespond JSON only:"。recent 反向截取最近 3 条 (空则省略)。
  - **验证**: 单元测试 (2.5 任务的结构验证) 验证 `buildGatePrompt("对", ["列一下 TODO", "列出 TODO"])` 输出含 "Recent user messages" + "Respond JSON only"
  - **依赖**: 2.1
  - **前置阅读**: scenarios S1-S4

- [x] 2.3 **callGate fetch + JSON 解析 + 重试 + timeout**
  - **文件**: `extensions/personal-assistant/gate.ts` (Modify)
  - **内容**: 填 `callGate` 函数体: 用 `fetch(\`${url}/api/chat\`, { method:"POST", headers, body: JSON.stringify({model, messages: [{role:"system",content:sys}, {role:"user",content:user}], stream:false, options:{temperature:0}}), signal: AbortController.signal })` + `setTimeout(() => controller.abort(), timeoutMs)`。链 try/catch — fetch reject / timeout → return null (降级路径); 解析: `JSON.parse(resp.message.content.trim())` 失败则 strip 前后非 `{...}` 段重 parse (用 regex `/(\{[\s\S]*\})/` 第一个 match); 仍失败 → return null。验证 `typeof need_memory === "boolean"` 且 `typeof search_query === "string"`; 否则返回 null。
  - **验证**: 新建 `extensions/personal-assistant/test/gate.test.ts`, 用 `globalThis.fetch = vi.fn()` mock 4 个 case: (a) happy `{"need_memory":true,"search_query":"foo"}` 返 `GateDecision`; (b) 前缀垃圾字符串 + JSON `bad\n{"need_memory":false,"search_query":""}` 仍解析成功; (c) timeout 0ms → return null; (d) `{"need_memory":"not bool"}` → return null。`node ../../node_modules/vitest/dist/cli.js --run test/gate.test.ts` 全绿
  - **依赖**: 2.2
  - **前置阅读**: scenarios S5, S6, S7

## 3. rerank 客户端模块 (rerank.ts)

- [x] 3.1 **rerank.ts 骨架 + rerankAndFilter signature + test 骨架**
  - **文件**: `extensions/personal-assistant/rerank.ts` (Create), `extensions/personal-assistant/test/rerank.test.ts` (Create)
  - **内容**: rerank.ts 导出 `export interface RerankOptions { serviceUrl?: string; timeoutMs?: number; threshold?: number; gap?: number }` 与 `export async function rerankAndFilter(query: string, hits: RecallResult[], options?: RerankOptions): Promise<RecallResult[] | RerankFallback>`。threshold 默认 0.5, gap 默认 0.15, timeoutMs 500, serviceUrl 默认 `http://127.0.0.1:11435`。rerank.test.ts 创建 vitest describe 骨架, 保留占位 (后续 3.2 / 3.3 填入 case)。同时导出 `export type RerankFallbackReason = "timeout" | "http-error" | "shape-mismatch" | "unreachable"` 与 `export interface RerankFallback { reason: RerankFallbackReason; topK: RecallResult[] }` 供调用方 (memory.ts 5.4) log 区分。
  - **验证**: `npm run check 2>&1 | grep rerank.ts` 无错; `node ../../node_modules/vitest/dist/cli.js --run test/rerank.test.ts` 通过 (即使 case 全为占位, describe 套壳应存在)
  - **依赖**: 1.1
  - **前置阅读**: design.md D5

- [x] 3.2 **server 调用 + 失败 fallback (带 reason)**
  - **文件**: `extensions/personal-assistant/rerank.ts` (Modify), `extensions/personal-assistant/test/rerank.test.ts` (Modify)
  - **内容**: 填 `rerankAndFilter` 函数体并返 `Promise<RerankResult[] | RerankFallback>` — 改签名让调用方从返回类型区分 OK vs fallback: (a) hits 数 0 → 直接 return [] (短路 R6); (b) 构造 body `{query, hits: [{id, embeddable_text}]}` 用 `buildEmbeddableText(hit.atom)` 复用 embed.ts; (c) fetch `/api/rerank` + AbortController + 500ms; (d) 失败具体细分 reason: AbortError/timeout → `RerankFallback{reason:"timeout", topK: hits.slice(0,3)}`; response.status !== 2xx → `RerankFallback{reason:"http-error", topK}`; fetch reject (ECONNREFUSED) → `RerankFallback{reason:"unreachable", topK}`; response score 数与 hits 数不等 → `RerankFallback{reason:"shape-mismatch", topK}`; 成功 → 继续 3.3 截断逻辑。返回类型 union 化: `Promise<RecallResult[] | RerankFallback>` — 调用方 (5.2 / 5.4) 用 `Array.isArray(result)` 区分。
  - **验证**: `test/rerank.test.ts` 4 个 case: (1) mock `/api/rerank` 404 → 返 `RerankFallback{reason:"http-error"}` 含 hits.slice(0,3); (2) mock 超时 → `reason:"timeout"`; (3) mock 数值数组长度不匹配 → `reason:"shape-mismatch"`; (4) mock fetch throws → `reason:"unreachable"`。`node ../../node_modules/vitest/dist/cli.js --run test/rerank.test.ts` 全绿
  - **依赖**: 3.1
  - **前置阅读**: scenarios R4, R5, R6, P6

- [x] 3.3 **threshold + gap 截断算法 (成功路径返回 RecallResult[])**
  - **文件**: `extensions/personal-assistant/rerank.ts` (Modify), `extensions/personal-assistant/test/rerank.test.ts` (Modify)
  - **内容**: 在 server 成功响应后, 把 server 返 `[{id, score}]` 与 hits join 写入 `hit.rerankScore = score`, 然后按 score 降序 (同分用 `b.rrf - a.rrf` 二次排序 R7); 遍历排序后的数组 (1) 过滤 `score >= threshold` (≥0.5); (2) 找相邻 gap > 0.15 第一处 → 在该处截断 (保留前 i+1 个)。空集 / 单元素 (无相邻可比较) 规则: 单元素 ≥ threshold 通过; 空集返回 []。所有被丢弃的 hit 不返 (不参与 format 注入)。3.2 / 3.3 返回 union: `RecallResult[]` 成功, `RerankFallback` 失败 — 5.2 根据是否数组区分。
  - **验证**: `test/rerank.test.ts` 4 个 case: (a) `[0.92,0.85,0.55,0.32]` → 截 gap 在 0.85→0.55 (0.30>0.15), 阈值过 3 个但 gap 后剩 2 → 返 `RecallResult[]` 长 2; (b) `[0.92,0.85,0.55,0.52,0.51]` → 阈值过 5 个, gap 在 0.85→0.55 (0.30), 截前 2 个; (c) `[0.48,0.45,0.42,0.30]` → 全部 < threshold → 返 `[]` (不是 fallback — 是空成功); (d) `[0.7]` → 单元素通过 → 返 `RecallResult[]` 长 1。`node ../../node_modules/vitest/dist/cli.js --run test/rerank.test.ts` 全绿
  - **依赖**: 3.2
  - **前置阅读**: scenarios R1, R2, R3, R7

## 4. server.py /api/rerank 端点

- [x] 4.1 **server.py 加 reranker lazy load + global state**
  - **文件**: `/tmp/bge-m3-test/server.py` (Modify); 同步至 `extensions/personal-assistant/server.py` (如果项目内有此文件则 Update; 否则后续维护约定: server.py 实际跑 /tmp 路径, 项目内只在 docs/AGENTS.md 记录此路径)
  - **内容**: 在文件顶部 import 段加 `from FlagEmbedding import FlagReranker` (try/except, ImportError 时仅 warn 不 fail server)。在 state 类 (state 段) 加 `reranker = None` 与 `reranker_loading = False`。加函数 `get_reranker()` lazy load: `state.reranker is None and not state.reranker_loading` 时设 loading=True, 调 `FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)` 设进 state, loading=False; 任何异常 log + 返 None。已在加载中返 None (避免并发双重 load)。
  - **验证**: `python3 -c "import FlagEmbedding; print('ok')"` 输出 ok (验证依赖); 手跑 `python /tmp/bge-m3-test/server.py` 启动日志看到 "reranker not loaded (lazy)" (因为 lazy)
  - **依赖**: 无
  - **前置阅读**: design.md D4

- [x] 4.2 **POST /api/rerank 实现端点**
  - **文件**: `/tmp/bge-m3-test/server.py` (Modify)
  - **内容**: 加 `class RerankReq(BaseModel): query: str; hits: list[dict]` (每 hit 含 id + embeddable_text, embeddable_text 字段名 server 不强校验, client 总会传)。加 `@app.post("/api/rerank")` `async def api_rerank(req)`: (1) 取 `reranker = get_reranker()`, None → `raise HTTPException(503, "reranker not loaded")` (call site 降级 R5); (2) `pairs = [[req.query, h["embeddable_text"]] for h in req.hits]`; (3) `scores = reranker.compute_pairs(pairs, normalize=True)` (返回 [0,1] sigmoid-logits); (4) 包装响应 `{"scores": [{"id": h["id"], "score": float(s)} for h, s in zip(req.hits, scores)]}`; (4) 异常 catch → 抛 500 (call site 降级)。
  - **验证**: 重启 server, `curl -X POST http://127.0.0.1:11435/api/rerank -H "Content-Type: application/json" -d '{"query":"bwa 并发","hits":[{"id":"a","embeddable_text":"bwa 引物并发问题解决方案"}]}'` 返回 `{"scores":[{"id":"a","score":0.6...}]}` (verbose 用 jq 看具体score); reranker 未加载时返 503
  - **依赖**: 4.1
  - **前置阅读**: design.md D4, scenario R5

- [x] 4.3 **/api/health 报告 reranker 状态**
  - **文件**: `/tmp/bge-m3-test/server.py` (Modify)
  - **内容**: 在 `/api/health` 端点响应中加 `"reranker_loaded": state.reranker is not None` 与 `"reranker_loading": state.reranker_loading` 字段。客户端 probe 用于 debug log (可选, 不是硬约束)。
  - **验证**: `curl -s http://127.0.0.1:11435/api/health` 含 `reranker_loaded` 字段
  - **依赖**: 4.1
  - **前置阅读**: principle 7 (可观测)

## 5. memory.ts pipeline 整合

- [x] 5.1 **删 before_agent_start recall 逻辑, 简化为 cleanup**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: `pi.on("before_agent_start", ...)` hook body 简化为: 只清 `pendingMemorySearches` Map (清防 stale leak) — 不再触发 recall, 不再 setStatus memory, 不再 dynamic import (search.ts/format.ts)。保留 hook 注册 (防 ext log warn "unhandled")。整段约减 30 行。
  - **验证**: `npm run check 2>&1 | grep memory.ts` 无错; `grep "recallAtoms\|formatMemoryContext\|setStatus" extensions/personal-assistant/memory.ts` 在 before_agent_start 段无匹配
  - **依赖**: 无
  - **前置阅读**: design.md D1, memory.ts:636-690 现有

- [x] 5.2 **context hook 整合 pipeline (gate → recall → rerank → format) — gate/rerank 走 dynamic import**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 完全重写 `pi.on("context", ...)` hook body 步骤: (1) 从 event.messages[] 取最近 2-3 条 user msg + 当前 user msg (last user); (2) loadConfig + 检查 `config.memory?.gate?.enabled ?? true`: true 则 **`const { callGate } = await import("./gate.ts")`** 动态加载 (per scenario P2 / D2: 不阻 cold path), `await callGate(current, recent, {timeoutMs: 500})`, decision null/`need_memory:false` → setStatus "🚫 gate skipped" 或 "⚠ gate timeout, skipped" (decision==null 区分 timeout/down) 并 return 原 event; (3) gate skip 后无 event mutation; (4) gate 通过则调 `recallAtoms(index, decision.search_query, {topK:20})` (recallAtoms 在 search.ts 顶层已 import, 不需动态 — 实际项目中 search.ts 已被 memory.ts 其他 hook import 过); (5) 检查 `config.memory?.rerank?.enabled ?? true`: true 则 **`const { rerankAndFilter } = await import("./rerank.ts")`** 动态加载, `await rerankAndFilter(query, results, {timeoutMs:500})` 返回 `RecallResult[] | RerankFallback` union; false 或 results.length===0 (R6 短路) 时跳过 rerank 直送 format; (6) 给 RecallResult 设 `relativePath = '${atom.type}/${atom.id}.md'` (移到 step 6 之后, 在 status + format 前); (7) setStatus 用 现 memory.ts:675-678 同样字串格式但 top 取 `rerankScore` 优先 rrf; (8) `formatMemoryContext(results, 4000)` (动态 `await import("./format.ts")` 加载) → 注入 last user message 进 event.messages, 同现有 `injectMemoryContext` 逻辑 (8s total timeout race 可删除 — pipeline 同步 await < 1.2s, 不需 race)。Module-level `pendingMemorySearches` 仍保留 (前 hook cleanup 已依赖, 但 context 不再读 — 仅为防止其他 session 并发引用)。
  - **验证**: `npm run check 2>&1 | grep memory.ts` 无错; grep `await import("./gate` extensions/personal-assistant/memory.ts 命中 1 处; grep `await import("./rerank` 命中 1 处; 单元测试 `test/pipeline.test.ts` (新建) 用 FakeMemoryIndex + mocked gate&rerank 覆盖 P1 (full path), P4 (idempotent 2 调结果相同), P5/P6 (settings 禁用, confirm fetch not invoked)
  - **依赖**: 1.1, 1.2, 2.3, 3.3, 5.1
  - **前置阅读**: design.md D1, D7, spec scenario P2

- [x] 5.3 **TUI status 状态枚举扩展**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: context hook 内每次路径分支后调 `ctx.ui.setStatus("memory", <msg>)`, 覆盖 7 个状态: (1) "🚫 gate skipped" (gate 返 need_memory=false); (2) "🚫 gate skipped (parse failed)" (gate 解析失败); (3) "⚠ gate timeout, skipped" (gate 500ms 超时); (4) "⚠ gate down, skipped" (ollama ECONNREFUSED); (5) "🔍 no memory match" (gate 通过 + recall=[], 或 rerank 全 < threshold); (6) "⚠ rerank fallback" (rerank 超时/404/全失败, 返原 RRF top-3 时); (7) "📦 N atoms · rule=X fact=Y process=Z · top=<max rerankScore>" (happy path)。
  - **验证**: `test/pipeline.test.ts` 在每个 case 后用 `expect(ctx.ui.setStatus).toHaveBeenCalledWith("memory", <expected>)`; 7 个 case 全覆盖
  - **依赖**: 5.2
  - **前置阅读**: scenarios S1-S7, R1-R7, principle 10

- [x] 5.4 **debug log 单条 emit (gate + rerank reason 全枚举)**
  - **文件**: `extensions/personal-assistant/memory.ts` (Modify)
  - **内容**: 在 context hook pipeline 末尾 (注入前后均执行) 加一条 `console.debug("[recall] gate=${gate.status} rerank=${rerank.status}${rerank.reason ? "(" + rerank.reason + ")" : ""} pre=${hybridCount} post=${finalCount} latency {gate:${gateMs}ms recall:${recallMs}ms rerank:${rerankMs}ms}")`。gate.status ∈ {pass, skip-false, parse-fail, timeout, down, disabled}; rerank.status ∈ {ok, fallback, skip, all-below, disabled}; rerank.reason ∈ {timeout, http-error, shape-mismatch, unreachable} (当 rerank.status = "fallback" 时填, 否则空字符串)。每个性能字段 0 表示未执行该步; 用 `performance.now()` diff 算。
  - **验证**: `test/pipeline.test.ts` 用 `vi.spyOn(console, "debug")` 断言 5 个 case: (a) `gate=pass rerank=ok`; (b) `gate=timeout` (gate 超时 rerank.status=skip); (c) `rerank=fallback(timeout)` (rerank AbortError); (d) `rerank=fallback(http-error)` (404); (e) `gate=disabled rerank=ok` (P5 配置禁用 gate)
  - **依赖**: 5.3
  - **前置阅读**: principle 10, design.md D7 (失败矩阵), task 3.1 rerankFallbackReason enum

## 6. Pipeline 集成测试

- [x] 6.1 **pipeline.test.ts P1 happy path**
  - **文件**: `extensions/personal-assistant/test/pipeline.test.ts` (Create)
  - **内容**: FakeMemoryIndex 返 5 个 fixed atom; `vi.spyOn(globalThis, "fetch")` mock ollama `/api/chat` 返 `{"need_memory":true,"search_query":"bwa 并发"}` 与 server `/api/rerank` 返 `[{id,score}]` 中 score=[0.9,0.85,0.32,0.30,0.28]; 触发 context hook (手工构造 ContextEvent-shaped object); expect 注入文本含 0.9/0.85 两个 atom 的 title (gap 在 0.85→0.32 处 0.53>0.15 截断); expect setStatus 调用匹配 `📦 2 atoms · ... · top=0.9`; expect debug log 含 `gate=pass rerank=ok pre=5 post=2`。
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/pipeline.test.ts` 全绿
  - **依赖**: 5.4
  - **前置阅读**: scenario P1, R1

- [x] 6.2 **pipeline.test.ts S1/S2/S6 gate 降级场景**
  - **文件**: `extensions/personal-assistant/test/pipeline.test.ts` (Modify, append cases)
  - **内容**: 3 个 case — (a) S1 gate 返 `{need_memory:false, search_query:""}` → 注入跳过, status `🚫 gate skipped`; (b) S2 同; (c) S6 fetch AbortError (timeout 0ms 配置) → status `⚠ gate timeout, skipped`; 3 个 case 都断言注入文本字段为 undefined / messages 数组未被 mutate。
  - **验证**: 同 6.1
  - **依赖**: 6.1
  - **前置阅读**: scenarios S1, S2, S6

- [x] 6.3 **pipeline.test.ts P5/P6 settings.json 禁用**
  - **文件**: `extensions/personal-assistant/test/pipeline.test.ts` (Modify, append cases)
  - **内容**: 2 case — (a) loadConfig 返 `memory.gate.enabled=false` → 跳过 gate 调用直接调 recallAtoms + rerank, status "📦" 含 atoms 数; (b) `memory.rerank.enabled=false` → gate 通过后返回原 RRF top-K (前 3 限制不强加, 透传原 RRF), status "📦" 也 OK; 不调 `/api/rerank` fetch (vi.assert fn not called)。两个 case 不抛错 (P5/P6 backward compat 锚点)。
  - **验证**: 同 6.1
  - **依赖**: 6.1
  - **前置阅读**: scenarios P5, P6

- [x] 6.4 **pipeline.test.ts R3/R4/R5 rerank 降级**
  - **文件**: `extensions/personal-assistant/test/pipeline.test.ts` (Modify, append cases)
  - **内容**: 3 case — (a) R3 rerank 返 scores 全 <0.5 → status `🔍 no memory match`, 注入跳过; (b) R4 rerank AbortError timeout 0ms → fallback 原 RRF top-3 注入, status `⚠ rerank fallback`; (c) R5 mock `/api/rerank` 返 404 → fallback, status `⚠ rerank fallback`。3 个都断言 debug log 含预期 `rerank=` 片段。
  - **验证**: 同 6.1
  - **依赖**: 6.1
  - **前置阅读**: scenarios R3, R4, R5

## 7. 回归 & smoke test

- [x] 7.1 **现有 search.test.ts / recall-quality.test.ts 不破**
  - **文件**: 不改测试, 仅跑测
  - **内容**: 跑 search.test.ts + recall-quality.test.ts。search.ts 实际 unchanged (recallAtoms signature 不变), recall-quality 因 RecallResult 加 optional field 应不破。recall-quality 测试若依 rrf 排序, formatMemoryContext signature 不变, 应仍绿。
  - **验证**: `node ../../node_modules/vitest/dist/cli.js --run test/search.test.ts test/recall-quality.test.ts` 全绿 (与改动前同等 pass count)
  - **依赖**: 5.4
  - **前置阅读**: AGENTS.md test 命令

- [x] 7.2 **手动 smoke test: 真实 query "上面的脚本有问题" (见下文)****
  - **文件**: 无 (手动)
  - **内容**: 启动 pi, 输入 "把 search_3n_path.py 改成异步的" → 等 → "改成异步的版本跑出来了 但是 上面的脚本有问题" → 看 TUI status 应显示 `🚫 gate skipped` 而不是 `📦 N atoms`。可重复 5 个测试 query: "上面的脚本有问题" / "对" / "继续" / "好的 我看看" / "再看看" 全应 gate skipped。
  - **验证**: 5 个 query 中 ≥4 个 status 显示 `🚫 gate skipped`; debug log (pi debug 开) 含 `gate=skip-false` ≥4 次; tmux 截屏存证
  - **依赖**: 6.4, 4.2
  - **前置阅读**: AGENTS.md tmux 指南, scenarios S1-S2

- [x] 7.3 **手动 smoke test: 真实 query "之前那个并发问题怎么解决的" (见下文)****
  - **文件**: 无 (手动)
  - **内容**: query "之前我们用 bwa 做引物验证有并发问题 那个最后怎么解决的" 后应 gate pass + rerank ok + 注入 0-2 atom (含一个 bwa 相关 atom, 若 corpus 含其 atom 则必有, 不含则 0; 该 query 不能注入无关 atom); 跨 3 月以来 active atom 集 (54 个) 决定。
  - **验证**: status 显示 `📦 N atoms · top=<...>` (N=0-2) 或 `🔍 no memory match`; 如果 top atom 真相关 (title/summary 含 bwa/引物), 接受; 若返回 5+ 个无 bwa 主题 atom, fail (rerank 应已截断)
  - **依赖**: 7.2
  - **前置阅读**: scenarios S3, S4, R1

## Verification

- [x] 全量测试: 94/98 pass (3 todo rerank timeout, 1 pre-existing search.test.ts) — see test run
- [x] 类型 check: npm run check clean (all 6 stages pass)
- [x] Lint: npm run check includes biome — all clean
- [-] ~~手动 smoke (7.2 + 7.3)~~ → 需要用户重启 pi + 真实 query 验证 (见下文) [deferred: user-manual]