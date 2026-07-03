# recall-multiquery Specification

Capability: 独立 query rewrite 阶段 + 多路 recall 合并,在 gate 二分与 cross-encoder rerank 之间扩展 pipeline,支持复合 query 多概念 fan-out.

## ADDED Requirements

### Requirement: Query Rewrite Stage (rewrite.ts)
The system SHALL provide an independent `rewriteQueries` module that, given a user query and an optional list of recent user messages, returns 1-3 atomic subqueries via ollama qwen2.5:3b-instruct-q4_0 (temperature=0, timeout 1500ms). Function signature: `rewriteQueries(query: string, recent?: string[] | null, options?: RewriteOptions): Promise<string[] | RewriteFallback>`. Failed calls (timeout / parse / unreachable) return `RewriteFallback { reason, subqueries: [rawQuery] }` (single fallback query), enforced via `Array.isArray` discrimination at caller.

#### Scenario: 复合 query 被拆为多 subquery (R1)
- **GIVEN** rewriteQueries("MGM项目的工时如何计算", undefined) 被 qwen2.5:3b 处理
- **WHEN** LLM 返回 `{"subqueries": ["MGM项目", "工时如何计算"]}`
- **THEN** 返 string[] `["MGM项目", "工时如何计算"]`
- **AND** subsequent 多路 recall 用此 2 条各自调 recallAtoms,merge 后进 rerank

#### Scenario: 单概念 query 保持单 subquery (R2)
- **GIVEN** rewriteQueries("bwa 并发问题怎么修", undefined) 被 LLM 处理
- **WHEN** LLM 判定无复合成分,返回 `{"subqueries": ["bwa 并发问题怎么修"]}`
- **THEN** 返 string[] `["bwa 并发问题怎么修"]` 单元素,行为与未引入 rewrite 时等价

#### Scenario: 指代 query 经 rewrite 解上下文 (R3)
- **GIVEN** recent = ["把 search_3n_path.py 改成异步的", "跑了一下有报错"], current = "之前那个并发问题最后怎么解决的"
- **WHEN** rewriteQueries(current, recent) 调用
- **THEN** 返 `["search_3n_path.py 异步并发问题修复"]` (从上文解指代 + 单原子 search key)
- **AND** recall 用此 single subquery,无 fan-out

#### Scenario: 上文充分 → rewrite 能解指代并拆复合 (R5)
- **GIVEN** recent=["我们用 bwa 做过 MGM 项目的引物验证", "但工时上客户经理不满意"], current="那个验证的工时怎么算的"
- **WHEN** rewriteQueries 调用
- **THEN** 返 `["bwa MGM 引物验证", "工时计算"]` (指代被解 + 复合被拆)
- **AND** 两路 recall 分别拉到 bwa atom 和工时 atom,merge 后进入 rerank
- **AND** rerank 用 "bwa MGM 引物验证 工时计算" 对合并 hit 打分

#### Scenario: webui 直搜复合 query 无上文 (R4)
- **GIVEN** webui POST `/api/memory/search` body=`{query:"MGM项目的工时如何计算", filtered:true}`
- **WHEN** server 调 `rewriteQueries(query, null)` (无 recent)
- **THEN** rewrite 返多 subqueries,后续 multi-recall + merge + rerank 返 ≥1 hit
- **AND** response body 含 `rerankScore` / `rerankTimeMs` / `rewriteTimeMs` 字段

#### Scenario: rewrite 超时 1500ms 降级 (E1)
- **GIVEN** ollama 1500ms 内未响应
- **WHEN** AbortController 触发
- **THEN** 返 `RewriteFallback { reason:"timeout", subqueries:[rawQuery] }`
- **AND** pipeline 降级单路 recall + rerank
- **AND** debug log 输出 `rewrite=timeout`

#### Scenario: rewrite 返回非合法 JSON 降级 (E2)
- **GIVEN** qwen 返回纯文本非 JSON
- **WHEN** rewrite JSON.parse + regex retry 仍失败
- **THEN** 返 `RewriteFallback { reason:"parse", subqueries:[rawQuery] }`
- **AND** console.warn 输出 raw 前 200 字符

#### Scenario: ollama 服务挂掉降级 (E3)
- **GIVEN** ollama ECONNREFUSED
- **WHEN** rewrite fetch 抛 TypeError
- **THEN** 返 `RewriteFallback { reason:"unreachable", subqueries:[rawQuery] }`

#### Scenario: rewrite 返回空数组降级 (E4)
- **GIVEN** LLM 返回 `{"subqueries": []}`
- **WHEN** rewrite 校验 length
- **THEN** 视为 parse 失败,返 `RewriteFallback { reason:"parse", subqueries:[rawQuery] }`

#### Scenario: subquery 超上限静默截断 (E5)
- **GIVEN** LLM 返 5 条 `["a","b","c","d","e"]`
- **WHEN** rewrite 处理 string[]
- **THEN** `slice(0, 3)` 截到 `["a","b","c"]`,不抛错不警告,debug log 输出 `truncated 5→3`

#### Scenario: rewrite subqueries 有重复去重 (B5)
- **GIVEN** LLM 返 `["MGM", "MGM", "工时计算"]`
- **WHEN** rewrite 处理 string[]
- **THEN** Set 去重保序为 `["MGM", "工时计算"]`
- **AND** 避免 recallAtoms 重复调相同 query

### Requirement: Multi-recall Merge Helper (merge.ts)
The system SHALL provide a pure function `mergeByAtomId(resultGroups: RecallResult[][]): RecallResult[]` that deduplicates atoms across multiple recall passes by `atom.id`, preserving the group with the highest `rrf` score for each id and the entire `cosine` + `sparseScore` + `rrf` triple from that group. No recompute of scores; bge-m3 RRF remains the sole ranking authority.

#### Scenario: 多组重叠 atomId 取 rrf 最高 (B4)
- **GIVEN** resultGroups = `[[a(r=0.05)], [a(r=0.03)]]`
- **WHEN** mergeByAtomId 执行
- **THEN** 输出 `[a(r=0.05)]` (同 id 只留一次,取 rrf 最高的整组三元 cos+rrf+sparse)
- **AND** cosine/sparseScore 是 r=0.05 那一组的对应值

#### Scenario: 三组全空合并 (B9)
- **GIVEN** resultGroups = `[[], [], []]`
- **WHEN** mergeByAtomId 执行
- **THEN** 输出 `[]`

#### Scenario: 单组空 + 一组非空 (B-like)
- **GIVEN** resultGroups = `[[], [a, b]]`
- **WHEN** mergeByAtomId 执行
- **THEN** 输出 `[a, b]` (没有 dedup 损失)

### Requirement: Rerank Query 是 subqueries 空格连接
cross-encoder rerank stage SHALL 接收 `subqueries.join(" ")` 作为 unified query,而非每条 subquery 独立打分取 max. Cross-encoder 看到的是 disambiguated 复合语义画像.

#### Scenario: 复合 query rerank 用 joined string (R1 续)
- **GIVEN** subqueries = `["MGM项目", "工时如何计算"]`
- **WHEN** pipeline 调 rerankAndFilter
- **THEN** 第一参数是 `"MGM项目 工时如何计算"` (空格连接),不是数组
- **AND** cross-encoder 对复合 query 单次打分,不分别 score 后取 max

#### Scenario: 单 subquery 时 join 等价原 query (R2 续)
- **GIVEN** subqueries = `["bwa 并发问题怎么修"]`
- **WHEN** join(" ")
- **THEN** 得到 `"bwa 并发问题怎么修"` (与原 query 等价)

### Requirement: rewrite.enabled 配置开关
`PersonalAssistantConfig.memory.rewrite.enabled` 控制是否启用 rewrite 阶段. Default 为 true. 与 gate.enabled / rerank.enabled 互相独立,不捆绑单开关.

#### Scenario: rewrite disabled 时跳 rewrite (B8)
- **GIVEN** settings.json `rewrite.enabled=false`, `gate.enabled=true`
- **WHEN** gate 返 need_memory=true
- **THEN** pipeline 跳 rewrite,subqueries = [current] (rawQuery)
- **AND** recall + rerank 仍跑,rerank query 是 raw current msg

#### Scenario: gate disabled 但 rewrite enabled (B7)
- **GIVEN** settings.json `gate.enabled=false`, `rewrite.enabled=true`
- **WHEN** context hook 触发
- **THEN** 跳 gate,直接调 rewrite (current, recent)
- **AND** rewrite 后 multi-recall + rerank 仍走
- **AND** debug log 显示 `gate=disabled rewrite=ok(N)`

### Requirement: webui filtered=true 走 rewrite + multi-recall + rerank
`POST /api/memory/search` 当 body `filtered=true` (default) 时 SHALL 走 rewrite + multi-recall + merge + rerank 全链路. 当 `filtered=false` 时仅 recallAtoms 单路返原 RRF 候选, 不调 rewrite / rerank.

#### Scenario: filtered=true 走全链路 (R4 续)
- **GIVEN** POST `/api/memory/search` body=`{query:"MGM项目的工时如何计算", filtered:true}`
- **WHEN** server 处理
- **THEN** 走 rewrite + multivrecall + merge + rerank
- **AND** response 含 `results` / `recallTimeMs` / `rewriteTimeMs` / `rerankTimeMs`

#### Scenario: filtered=false 显式跳过 rewrite (B6)
- **GIVEN** POST body=`{query:"x", filtered:false}`
- **WHEN** server 处理
- **THEN** 完全跳 rewrite + rerank,直接 recallAtoms 单路返原 RRF 候选
- **AND** response 不含 `rerankScore` / `rerankTimeMs` / `rewriteTimeMs` 字段

### Requirement: Gate 短路时 rewrite 不调
当 gate 返回 `need_memory=false` 或 GateError 时 SHALL 跳过 rewrite + recall + rerank + format 整条 pipeline,直接 return original event. rewrite 是 gate 的后置门,不是平行可调点.

#### Scenario: gate skip 时 rewrite 不调 (E6)
- **GIVEN** gate 返 `need_memory=false`
- **WHEN** context hook 处理
- **THEN** rewrite 不被调
- **AND** debug log 输出 `gate=skip-false rewrite=skip(pre-gate-skip)`

#### Scenario: gate timeout 时 rewrite 不调
- **GIVEN** gate 返 "timeout"
- **WHEN** context hook 处理
- **THEN** rewrite 不被调
- **AND** TUI status "⚠ gate timeout, skipped"
- **AND** pipeline 返回 event 原样