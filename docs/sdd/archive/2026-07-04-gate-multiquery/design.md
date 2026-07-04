# Design: gate-multiquery

## Context

recall-precision 引入了 gate (binary 决策)+ cross-encoder rerank (precision 截断) 的 pipeline, 但有两个缺口:

1. **gate 越权**: 当前 `GateDecision` 同时输出 `{need_memory, search_query}`,前者二分后者 rewrite 是两个语义任务。qwen2.5:3b 在单 prompt 双任务下,两类产出可信度都下降。
2. **复合 query rerank 数学失效**: query "MGM项目的工时如何计算" 由 "MGM项目" + "工时计算" 两个独立概念构成。cross-encoder 单 query-atom 配对打分时, 无任何 atom 单独覆盖两部分, scores 都落在 0.05~0.21 死区, 全部被 threshold 0.5 砍掉。0 hits 不是阈值选错, 是 cross-encoder 范式处理不了 multi-hop。
3. **webui 直搜吃不到 gate 红利**: webui `POST /api/memory/search` 不走 context hook (无对话上文), 但复合 query 的原始 user input 就需要拆分,bge-m3 单召回也覆盖不了。

本变更拆出独立 rewrite 阶段: gate 只做二分, rewrite 负责指代消解 + 复合拆分. 两个调用点 (context hook / webui search) 共用同一 rewrite module, pipeline 失败任一节点都降级到"今天行为等价", 不阻塞。

## Goals / Non-Goals

- **Goals**:
  - gate schema 收紧为 `{need_memory}` 纯二分
  - rewrite.ts 独立模块: 1-3 subqueries, qwen2.5:3b, 1500ms timeout, 失败降级 `[rawQuery]`
  - merge.ts pure function: 多路 recall 结果按 atom.id 去重取 rrf 最高
  - context hook 和 webui search route 共用 rewrite + merge
  - rerank 接收 `subqueries.join(" ")` 作为 unified query, cross-encoder 复合语义画像
  - 复合 query 测试用例 (MGM+工时) 从 0 hits 改为 ≥1 hit
- **Non-Goals**:
  - 不改 rerank server.py 接口契约 (`/api/rerank` 单 query 不变)
  - 不引入新 ollama 模型, 沿用 qwen2.5:3b-instruct-q4_0
  - 不加 TUI 新 status 分支, 复用现有 7-branch
  - 不改 bge-m3 service 任何代码
  - 不为 webui 加 rewrite=true 独立开关 (filtered 单键走全链路)
  - 不为 webui 前端 UI 加新组件 — 响应增字段但前端展示另立 change
  - 不做 LLM 第一层粗排 / LLM-based rerank — rerank 仍是 cross-encoder

## Decisions

### 1. gate schema 收紧为 `{need_memory}` 纯二分
**Decision**: 删除 `GateDecision.search_query` 字段, gate prompt 与 parse 不再要求 LLM 输出 search_query。
**Rationale**: 一个 LLM call 一件事是小模型可靠性边界条件。gate 今天实际承担"refuse 召回 + query rewrite"两任, 3b 双任务 prompt 下两类产出都掉点。砍掉 rewrite 任务后 gate 只做 need_memory 二分, prompt 简化, 小模型更专注。
**Alternatives considered**:
- 保留 gate.search_query, 新增 rewrite 只处理复合拆分: 三段串行 (gate rewrite → rewrite split → recall), gate.search_query 与 rewrite 输出拼接。更复杂, gate 仍双任务, 拒绝。
- gate 完全删除, 仅留 rewrite: 失去 refuse 能力, 短 msg / ack msg 直接进 recall 浪费一次 LLM 调用。拒绝。

### 2. rewrite.ts 独立模块, 失败降级 `RewriteFallback { reason, subqueries: [rawQuery] }`
**Decision**: `rewrite.ts` 作为单一 home 拥有 rewrite LLM 调用全部逻辑, 返回 `string[] | RewriteFallback`, 用 `Array.isArray` 判别 (与 rerank.ts 完全对称)。
**Rationale**: 失败路径把 fallback `subqueries: [rawQuery]` 写进结果对象, caller 不需手写降级 — 同 rerank.ts RerankFallback 模式。判别方式与 rerank 完全对称, pipeline 失败处理代码模板可复用。
**Alternatives considered**:
- 返回 `RewriteResult { ok: true/false, ... }` discriminated union: 失败时 caller 仍要自己写 `[rawQuery]`, 违反"homogenize 失败模式"原则。拒绝。
- rewrite 内联 fan-out + recall: 模块耦合 I/O, 两个调用点都要传 MemoryIndex 进去, 签名暴增, 测试要 mock recallAtoms。拒绝。

### 3. subquery 上限 3 (静默截断)
**Decision**: LLM 返多于 3 条时 `slice(0, 3)` 静默截断, debug log 输出 `truncated N→3`, 不报错不警报。
**Rationale**: 上限是 LLM 行为护栏 (防小模型凑数生造低质子查询), 不是性能护栏。bge-m3 三路并行仅 ~50ms, 性能上可接受更多。LLM 见上限暗示会生造, 静默截断不暴露 schema 给 LLM, 模型不知道上限。
**Alternatives considered**:
- 上限写入 prompt 作为软约束: LLM 反而会向 3 凑, "我必须拆 3 个" 模式下生造废 query。拒绝。
- 上限 5: 过宽, 给小模型更多凑数空间, 降噪不增益。拒绝。
- 无上限: 没护栏, LLM 偶发喷 10 条全走 recall 浪费槽位。拒绝。

### 4. rerank query = `subqueries.join(" ")` 空格连接, 不每次子查询独立打分取 max
**Decision**: rerankAndFilter 接收 `subqueries.join(" ")` 作为单一 query, cross-encoder 看到的是 unified disambiguated 复合语义画像。
**Rationale**: cross-encoder 对 query-atom pair 拿 query 整体做 attention。复合 query 是 "MGM项目 工时如何计算" 一句, 不是 "MGM项目" / "工时如何计算" 两个独立询问。整体画像让 cross-encoder 自行决定概念间权重, 比人工按子查询分别打分取 max 保留了概念间关联信号。
**Alternatives considered**:
- 每个 subquery 独立调 rerank, 对 atom 取所有 subquery score 中最高: 多次 service 调用 (3x), 或改 server.py 接受多 query (破坏契约 Non-Goal)。拒绝。
- rewrite 同时输出 `primaryQuery` (unified) + `subqueries`: LLM 既要拆又要合, 又回到双任务。拒绝。

### 5. merge.ts 独立模块 (4-6 行), 不是 inline
**Decision**: `mergeByAtomId(resultGroups: RecallResult[][]): RecallResult[]` 独立导出为 pure function。
**Rationale**: 两个调用点 (memory.ts hook 和 webui routes) 共用, inline 即复制, 改一处漏一处。独立模块副产品: 单测无 mock 难度。
**Alternatives considered**:
- merge 内联到 memory.ts / webui routes: ~6 行 Map 操作复制两次, 违反 DRY。拒绝。
- merge 合入 rerank.ts signature `rerankAndFilter(query, hits[][])`: rerank 模块职责是 cross-encoder, 不该承担 dedup 语义。拒绝。

### 6. gate.disabled 不影响 rewrite.enabled, 两个独立开关
**Decision**: `memory.gate.enabled` 和 `memory.rewrite.enabled` 互相独立, 任一组合都合法。
**Rationale**: gate 二分和 rewrite 拆分是两件不同事。用户可能想关 gate 保留 rewrite (B7), 或关 rewrite 保留 gate (B8)。捆绑为单开关让用户失去精细控制。
**Alternatives considered**:
- 单一开关 `memory.pipeline.enabled`: 用户失去精细控制, 拒绝。

## Architecture

### 关键 type additions

```typescript
// extensions/personal-assistant/rewrite.ts

export interface RewriteOptions {
    ollamaUrl?: string;
    model?: string;
    timeoutMs?: number;
    maxSubqueries?: number;
}

export type RewriteError = "timeout" | "parse" | "unreachable";

export interface RewriteFallback {
    reason: RewriteError;
    subqueries: string[];  // 已是降级后的 [rawQuery]
}

// 返回类型: string[] (成功) | RewriteFallback (失败), caller 用 Array.isArray 判别
export type RewriteOutcome = string[] | RewriteFallback;

export async function rewriteQueries(
    query: string,
    recent?: string[] | null,
    options?: RewriteOptions,
): Promise<RewriteOutcome>;
```

```typescript
// extensions/personal-assistant/merge.ts

import type { RecallResult } from "./types.ts";

export function mergeByAtomId(
    resultGroups: RecallResult[][],
): RecallResult[];
```

```typescript
// extensions/personal-assistant/gate.ts (修改后)

export interface GateDecision {
    need_memory: boolean;
    // search_query 字段删除
}
```

```typescript
// extensions/personal-assistant/memory.ts PersonalAssistantConfig (修改后)

memory?: {
    ...
    gate?: { enabled?: boolean };
    rewrite?: { enabled?: boolean };   // 新增, default true when missing
    rerank?: { enabled?: boolean };
    ...
}
```

### Pipeline data flow

```
Context hook:
  event.messages → extract current + recent (up to 3)
  → gate decision (binary need_memory)
    │ false / GateError → setStatus + return event 原样
    │ true
  → rewrite (current, recent, timeout 1500ms)
    → subqueries: string[] (1-3 条, 已截断/去重)
  → multi-recall: Promise.all(subqueries.map(q => recallAtoms(index, q, {topK:20})))
  → merge: mergeByAtomId(allResults) → RecallResult[]
  → rerank: rerankAndFilter(subqueries.join(" "), merged)
    → Array branch: filtered recallResults
    → Fallback branch: reranked.topK (原 merged topK)
  → format: formatMemoryContext(finalResults, 4000)
  → inject 到最后一条 user message

Webui POST /api/memory/search (filtered 默认 true):
  body.query → rewrite (query, null, timeout 1500ms)
    → subqueries
  → multi-recall: Promise.all(subqueries.map(q => recallAtoms(index, q, {topK, filter:type?})))
  → merge: mergeByAtomId
  → rerank: rerankAndFilter(subqueries.join(" "), merged)
  → res.json: { results, recallTimeMs, rewriteTimeMs, rerankTimeMs }

Webui POST /api/memory/search (filtered=false):
  → recallAtoms(query, {topK, filter}) 单路
  → res.json: { results, recallTimeMs } (不带新字段)
```

### 失败降级矩阵

| 阶段 | 失败 | 降级 | 状态 |
|------|------|------|------|
| gate | timeout/parse/unreachable | skip recall + rewrite + rerank + format | TUI ⚠/🚫 |
| gate | need_memory=false | skip 后续 | TUI 🚫 |
| rewrite | timeout/parse/unreachable | subqueries = [rawQuery] (单路) | debug log, TUI 不动 |
| rewrite | 返回 [] | 视为 parse 失败 → [rawQuery] | debug log |
| rewrite | 超上限 | slice(0,3) 静默截断 | debug log truncated N→3 |
| multi-recall | 单路 0 hits | merge 跳过该路 | 后续无 hit 即 no-match |
| multi-recall | 全 0 hits | merged=[] | rerank/format 跳过, no-match |
| merge | (pure, 不失败) | — | — |
| rerank | timeout/http-error/shape-mismatch/unreachable | reranked.topK top-3 | TUI ⚠ fallback |
| rerank | 全部 < threshold | [] | no-match, 不注入 |

所有路径任一失败, pipeline 行为退化到"今天没有 rewrite 时等价", 不会更糟。

## Existing Code to Reuse

### Reuse: callGate (gate.ts:120-156)
- **Path**: `extensions/personal-assistant/gate.ts:120`
- **Why**: fetch ollama + AbortController + JSON parse with regex retry + GateError union 返回模式. rewrite.ts 的 fetch body 几乎一一对应这模式, 只是 prompt 系统 message 不同 + parse 句法稍异 (string[] vs GateDecision).
- **Risk**: gate.ts 修改后 GateDecision schema 变, callGate 签名不变但产出不同. test 需重写校验.
- **Decision**: extend (clone the fetch/timeout/parse skeleton pattern into rewrite.ts; gate.ts is NOT imported by rewrite.ts to avoid gate.isa coupling)

### Reuse: buildGatePrompt structure (gate.ts:65-75)
- **Path**: `extensions/personal-assistant/gate.ts:65`
- **Why**: "system + user 双 message, recent 上文加 user content 末段 'Respond JSON only:'" 这套结构直接搬到 buildRewritePrompt.
- **Risk**: rewrite 的 system prompt 比 gate 复杂 (5 段规则), 模板长度溢出对 3b 的注意力分配不利. 设计假设决定: 5 段规则控制在每段 ≤30 字符.
- **Decision**: extend (沿用结构, prompt content 重写)

### Reuse: parseGateResponse retry strategy (gate.ts:82-109)
- **Path**: `extensions/personal-assistant/gate.ts:82`
- **Why**: "JSON.parse → 失败后 regex `/(\{[\s\S]*\})/` 提取再 parse" 是小模型输出脏时的标准模式. rewrite 同样面对 qwen2.5:3b 的非纯 JSON 输出.
- **Risk**: rewrite 期待的 shape 是 `{"subqueries": ["a","b"]}` 而非 `{"need_memory":...,"search_query":...}`, regex 正确提取但 schema 校验是 string[] 校验不是 boolean 字段校验. parseRewriteResponse 要自写不能复用双字段 schema 校验.
- **Decision**: extend (复用两段 retry 模式, 重写 schema validation)

### Reuse: rerankAndFilter (rerank.ts:79-152)
- **Path**: `extensions/personal-assistant/rerank.ts:79`
- **Why**: pipeline 在 merge 后调 rerankAndFilter(joinedSubq, mergedHits). 接口签名 (query: string, hits: RecallResult[]): Promise<RecallResult[] | RerankFallback> 不动.
- **Risk**: joinedSubq 内容包含空格连接多个原子, query 长度变长可能影响 cross-encoder 内部 attention (Norm score 范围漂). 实测 "MGM项目 工时如何计算" (复合) vs "bwa 并发" (单概念) 给同样 atom 打分幅度都正常 (0.05-0.85 没看到漂出 [0, 1]).
- **Decision**: reuse (零改动调用)

### Reuse: recallAtoms (search.ts:126-133)
- **Path**: `extensions/personal-assistant/search.ts:126`
- **Why**: 每条 subquery 走一次 recallAtoms, 返回 RecallResult[]. 标准用法, Promise.all 并行执行.
- **Risk**: 一次 context hook 触发 1-3 次 hybridSearch HTTP call (vs 今天 1 次). bge-m3 service 端没有限流, 3 路并行 rt 增量约 50ms 总耗时, cache 失效率轻微上升. 无运行时风险.
- **Decision**: reuse (零改动调用)

### Reuse: formatMemoryContext (format.ts:54-88)
- **Path**: `extensions/personal-assistant/format.ts:54`
- **Why**: rerank 后的 finalResults 仍按 rerankScore DESC + rrf DESC tiebreaker 排序, 不需改 format.
- **Risk**: 若 rewrite 失败降级到单路, 流程回到 "今天行为", format 对单 rerankScore 的处理已是 baseline.
- **Decision**: reuse (零改动调用)

### Reuse: registerPostSearch (memory.ts:799-841) [webui]
- **Path**: `packages/webui/server/routes/memory.ts:799`
- **Why**: 已有 `filtered` flag + 已有 rerank dynamic import + 已有 recallTimeMs/rerankTimeMs/response shape. 扩展为 rewrite → multivrecall → merge → rerank 链路, 原结构保留.
- **Risk**: dynamic import 新增 rewrite.ts / merge.ts 进 server bundle, esbuild 会 bundled 进 server.bundle.js. 体积估计 +5KB, 已是 5.5mb 不显著. webui 调 ollama 是新行为 (webui 进程从未直接 fetch ollama), 但 ollama 是 localhost, 同 trust model 与 hook 一致.
- **Decision**: extend (在现有 if-filtered 分支内扩展 rewrite+multivrecall+merge)

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| qwen2.5:3b rewrite prompt 失败率高 (parse / 错拆 / 不拆复合) | 失败一律降级到 [rawQuery], 与今天行为等价. 加 unit test 覆盖 5 类 LLM 异常输出. |
| 3b 对复合 query 不拆或乱拆 (e.g. "今天 黑马电影" 错拆成 ["今天", "黑马电影"] 破成语) | 拆分错对召回是 add-back, 不丢相关 atom (它们仍出现在其中一条 subquery 的候选里). 最坏情况等同不拆 = 今天行为. |
| gate prompt 简化后 need_memory 判定退化 (今天 S3 的 disambiguation 文本依赖可能就在 search_query 字段上隐性记着) | 跑 gate-fetch.test.ts 全部 15 测试, 只改 search_query 断言行不动 fail 断言. 确保 need_memory 误判率不动. |
| 延迟从今天 ~700ms 升到 ~2.2s worst case | 仍在 context hook 8s 预算内. 同时 gate / rewrite 失败都会快速短路 (gate 500ms 内, rewrite 1500ms 内). 失败不阻塞. |
| webui 默认 filtered=true 走全链路, 慢 query 不可接受 | 用户可显式发 `{filtered:false}` 走 RRF 单路. UI 默认开关另立 change 处理. |
| 三路 recall 多次访问 bge-m3 service | service 单查询 sub-ms, 3 路总 ~50ms. 无限流, cache 失效率轻. 不构成瓶颈. |
| rerank joined subquery 内空格连接混合概念, cross-encoder attention 可能错乱 | 实测 "bwa 并发" 0.85 vs "MGM项目 工时如何计算" 0.05-0.21 (复合 atom score 仍显著低于单概念匹配), 说明 cross-encoder 自身能 weight. 复合 atom 在 join 之后应升 score (MGM atom 与 "MGM项目 工时如何计算" 的 "MGM" 部分强匹配). |

## Testing Strategy

- **rewrite.ts 单元测试 (mock fetch)**:
  - LLM 返 `{"subqueries": ["a","b"]}` → 成功 string[]
  - LLM 返 `{"subqueries": []}` → parse 失败 (空)
  - LLM 返 5 条 → slice(0,3) 截断
  - LLM 返 `["a","a","b"]` → Set 去重 → `["a","b"]`
  - LLM 返 非合法 JSON → regex retry → 仍失败 → parse 错误
  - 超时 → timeout 错误
  - fetch ECONNREFUSED → unreachable 错误
  - LLM 返 1 条 subquery vs 返回 `{"subqueries": ["q"]}` → 单元素 string[]
- **merge.ts 单元测试 (pure)**:
  - 单组 input → 不动
  - 多组重叠 atomId → 取 rrf 最高
  - 全空组 → []
  - 三组混合 id 出现 2 次取 rrf 高
- **gate.ts 单元测试 (修改后)**:
  - S1-S7 5 个 fixture: 仅断言 `need_memory` not search_query
  - 确认 GateError 分支不变 (timeout/parse/unreachable)
- **pipeline 集成测试 (memory.ts context hook)**:
  - gate skip → rewrite 不调 + 无注入
  - gate pass + rewrite ok 2 subq → 2 路 recall + merge + rerank
  - rewrite timeout → subqueries = [rawQuery] + 单路 recall + rerank 用 rawQuery
  - rewrite parse 失败 → 同上
  - 3 subquery 有一路 0 hit, 另两路有 hit → merge 保留有 hit 的 atom
  - 全 0 hit → no-match status
  - rerank fallback (cross-encoder down) → topK fallback 注入
- **webui search route integration test**:
  - filtered=false → 单路 recall, response 不含 rerankScore/rewriteTimeMs
  - filtered=true + rewrite mock → multi-recall + merge + rerank
  - filtered=true + rewrite timeout → subq=[query] fallback, 仍返 hits
- **复合 query 端到端 smoke** (manual after develop):
  - "MGM项目的工时如何计算" filtered=true → ≥1 hit (vs 今天 0)
  - "bwa 并发问题怎么修" filtered=true → 单 hit (单概念, 不应被强拆)
  - "之前那个脚本有什么问题" filtered=true — webui 无上文, 期望无拆但被识别零相关, 0 hits (与 gate 路径不同 webui 没 gate)

## Implementation Notes

- **依赖顺序 (write_plan 阶段)**:
  1. gate.ts schema 修改 + 15 个测试更新 — 此项独立, 不依赖其后任务
  2. merge.ts 模块 + 单测 — pure function, 无依赖, 与 1 并行可
  3. rewrite.ts 模块 + 单测 — 依赖 gate.ts 的 fetch/parse pattern (clone 重写, 不 import)
  4. memory.ts PersonalAssistantConfig 加 `rewrite.enabled` 字段 + context hook pipeline 集成 — 依赖 1, 2, 3 全部就绪
  5. webui routes/memory.ts registerPostSearch 扩展 — 依赖 2, 3
  6. 端到端集成测试 (pipeline + webui) — 依赖 4, 5
  7. 文档更新 (spec.md capability 新增, recall-precision MODIFIED 段) — 依赖 5 收尾

- **prompt 写作注意**:
  - REWRITE_SYSTEM_PROMPT 控制段落数 ≤5, 每段 ≤30 字符 (中文 ~25 字符预算内, 大写英文 ~40). 3b 注意力分配对长 prompt 敏感
  - 5 段规则建议: (1) 输出格式 (2) 指代消解 (3) 复合拆分 (4) 单概念保留 (5) 去重不生造

- **gate schema breaking change on tests**: `gate-fetch.test.ts` 凡 `gateDecision.search_query` 断言要删 (断言改为只查 need_memory 给 boolean). 15 个测试估计 ~10 个断言行修改. 其余 5 个是 GateError 路径, 不变.

- **debug log 模板统一**: `[recall] gate=X rewrite=Y(N) recall=Z rerank=W(r) pre=P post=Q latency {gate:Nms rewrite:Nms recall:Nms rerank:Nms}`. 统一模板, 不破坏今天 7-branch 输出语义.

- **不动 server.py**: 不要在 develop 阶段顺手改 server.py 的 `/api/rerank` 接口. joined query 对 server 是单字符串, server 不知它是复合. 完整通过现有接口契约工作.

<!-- archived-with: 2026-07-04-gate-multiquery | status: final -->