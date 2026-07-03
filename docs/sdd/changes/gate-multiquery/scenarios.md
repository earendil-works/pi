# 使用场景

## 正常流程

### 场景: 复合 query 被拆为多 subquery 多路召回合并 (R1)
- **GIVEN** 当前 user msg = "MGM项目的工时如何计算", 最近无指代上文
- **WHEN** rewrite 调用 qwen2.5:3b 返回 `["MGM项目", "工时如何计算"]`
- **THEN** pipeline 对每条 subquery 各调一次 `recallAtoms` (并行),得到 hits_A (MGM 项目 atom) + hits_B (工时估算 atom)
- **AND** merge 阶段以 atom.id 为 key 去重 (无重叠时 union),保留各自 rrf/cosine/sparseScore
- **AND** rerank 接收 `subqueries.join(" ")` = `"MGM项目 工时如何计算"`,对合并后的 hits 打分
- **AND** MGM atom + 工时 atom 在 rerank score 上都 ≥0.5 (复合语义被 cross-encoder 抓住),进入最终注入
- **AND** TUI status 显示 "📦 N atoms · ..."

### 场景: 单概念 query 被保持单 subquery (R2)
- **GIVEN** 当前 user msg = "bwa 并发问题怎么修"
- **WHEN** rewrite 调用
- **THEN** 返回 `["bwa 并发问题怎么修"]` (单元素 string[]),LLM 判定无可拆复合
- **AND** pipeline 走单路 recallAtoms,行为与未引入 rewrite 时等价

### 场景: 指代 query 经 rewrite 解上下文 (R3)
- **GIVEN** recent = ["把 search_3n_path.py 改成异步的", "跑了一下有报错"], 当前 = "之前那个并发问题最后怎么解决的"
- **WHEN** context hook 调 gate 返回 `need_memory=true`
- **AND** rewrite 接收 (current, recent) 调 qwen2.5:3b
- **THEN** rewrite 返回 `["search_3n_path.py 异步并发问题修复"]` (从上文解指代 + 拆为单原子 search key)
- **AND** recall 用此 single subquery,无 fan-out
- **AND** rerank 用同 query 打分

### 场景: webui 直搜复合 query (R4)
- **GIVEN** webui 用户在搜索框输入 "MGM项目的工时如何计算",无对话上文
- **WHEN** 前端 POST `/api/memory/search` body=`{query, filtered:true}`
- **THEN** server 调 `rewriteQueries(query, null)` (无 recent)
- **AND** rewrite 返回 `["MGM项目", "工时如何计算"]`
- **AND** 后续 multi-recall → merge → rerank → 返回 hits 至少 1 个
- **AND** 响应 body 含 `rerankScore` 字段 + `rerankTimeMs` + `rewriteTimeMs`

### 场景: 上文充分 → rewrite 能解指代并拆复合 (R5)
- **GIVEN** recent=["我们用 bwa 做过 MGM 项目的引物验证", "但工时上客户经理不满意"], 当前="那个验证的工时怎么算的"
- **WHEN** rewrite 调用
- **THEN** 返回 `["bwa MGM 引物验证", "工时计算"]` (指代被解 + 复合被拆)
- **AND** 两路 recall 分别拉到 bwa atom 和工时 atom,merge 后进入 rerank
- **AND** rerank 用 "bwa MGM 引物验证 工时计算" 对合并 hit 打分,双 atom 都过 threshold 0.5

## 异常流程

### 场景: rewrite 超时 1500ms (E1)
- **GIVEN** ollama 1500ms 内未响应 rewrite
- **WHEN** AbortController 触发
- **THEN** rewrite 返回 `RewriteError { reason: "timeout" }`
- **AND** pipeline 降级到 `[rawQuery]` (单元素),继续走单路 recallAtoms + rerank
- **AND** debug log 输出 `[recall] rewrite=timeout ...`,TUI status 走 no-match / happy 正常分支
- **AND** 端到端不阻塞

### 场景: rewrite 返回非合法 JSON (E2)
- **GIVEN** qwen 没在 JSON 里返回 string[],而是返回纯文本 "MGM项目,工时计算"
- **WHEN** rewrite 尝试 JSON.parse 失败,regex 提取 `[\s\S]` 后再 parse 仍失败
- **THEN** 返回 `RewriteError { reason: "parse" }`,pipeline 降级到 `[rawQuery]`
- **AND** console.warn 输出 raw 前 200 字符用于诊断

### 场景: ollama 服务挂掉 (E3)
- **GIVEN** ollama ECONNREFUSED (gate 已经 unreachable)
- **WHEN** rewrite fetch 也抛 TypeError
- **THEN** 返回 `RewriteError { reason: "unreachable" }`,降级 `[rawQuery]`
- **AND** 后续 recall + rerank 仍尝试,可能拿不到 hits (rerank 服务还活着),最终走 no-match status

### 场景: rewrite 返回空数组 (E4)
- **GIVEN** LLM 输出 `[]` (无效拆分)
- **WHEN** rewrite 校验 string[] 后发现 length=0
- **THEN** 视为 parse 失败,降级 `[rawQuery]`
- **AND** 不允许 pipeline 因 rewrite 输出 [] 而无 recall 可调

### 场景: subquery 超上限 (E5)
- **GIVEN** LLM 返回 5 条 subqueries `["a","b","c","d","e"]`
- **WHEN** rewrite 截断到 `subqueries.slice(0, 3)` 保留前 3 条
- **THEN** 只对前 3 条做 multi-recall, 不报错也不警告 (静默截断, 防生造子查询绕过上限)
- **AND** debug log 输出 `rewrite truncated 5→3`

### 场景: gate 已 skip → rewrite 不调 (E6)
- **GIVEN** gate 返回 `need_memory=false` 或 GateError
- **WHEN** pipeline short-circuit
- **THEN** rewrite 不会被调用 (重申 gate 是 rewrite 的前置门)
- **AND** TUI 显示 gate skip 相关 status, pipeline 立即返回

## 边界条件

### 场景: 单字符短 query (B1)
- **GIVEN** user msg = "好" 或 "对"
- **WHEN** gate 已经返回 `need_memory=false` (零信息量规则命中)
- **THEN** rewrite 不被调,pipeline skip
- **AND** 即使 gate 被禁 (gate.enabled=false) 强行走 rewrite,LLM 也只会返回 `["好"]` 单 subquery,recall 0 hits,no-match

### 场景: query 含特殊字符 (B2)
- **GIVEN** user msg = "search_3n_path.py 的并发问题"
- **WHEN** rewrite 调用,prompt 编码 user msg
- **THEN** ollama body JSON 转义正常,LLM 看到准确 string
- **AND** 返回 subqueries 不被特殊字符破坏 (JSON.parse 出 string[])

### 场景: corpus 中无任何匹配 (B3)
- **GIVEN** query = "量子计算原理论述" 且 corpus 54 atom 都不相关
- **WHEN** rewrite 拆出 1-3 subqueries,每路 recall 0 hits
- **THEN** merge 后为 [],rerank 跳过 (空 input),format 跳过
- **AND** TUI status "🔍 no memory match",pipeline 返回 event 原样

### 场景: 同 atom 被多 subquery 都召回 (B4)
- **GIVEN** rewrite 返回 `["bwa 引物", "bwa 验证方案"]`,两路 recall 都拉到 atom X
- **WHEN** merge 执行 atomId key 去重
- **THEN** 结果集只保留 X 一次,rrf/cosine/sparseScore 取**两路中 rrf 最高**的那一组
- **AND** rerank 看到的是 dedup 后的 candidate 池,不会重复打分

### 场景: rewrite subqueries 有重复字符串 (B5)
- **GIVEN** LLM 返回 `["MGM", "MGM", "工时计算"]`
- **WHEN** rewrite 处理 string[]
- **THEN** rewrite 内部对 subqueries 做 Set 去重 + 保序,最终 `["MGM", "工时计算"]`
- **AND** 避免 recallAtoms 重复调相同 query 浪费 bge-m3 service round trip

### 场景: webui filtered=false 显式跳过 rewrite (B6)
- **GIVEN** webui POST `/api/memory/search` body=`{query, filtered:false}`
- **WHEN** server 路由
- **THEN** 完全跳过 rewrite + rerank,直接 recallAtoms(query) 单路返原 RRF 9 个候选
- **AND** 响应不含 rerankScore / rerankTimeMs / rewriteTimeMs 字段

### 场景: gate.enabled=false 但 rewrite.enabled=true (B7)
- **GIVEN** settings.json `memory.gate.enabled=false`, `memory.rewrite.enabled=true`
- **WHEN** context hook 触发
- **THEN** 跳过 gate,直接进入 rewrite (拿 raw current msg 作 query,recent 可有可无)
- **AND** rewrite 后 multi-recall + rerank 仍走
- **AND** 与今天 gate disabled 行为的差异仅是多了 rewrite + multi-recall,可独立关闭

### 场景: rewrite.enabled=false 但 gate.enabled=true (B8)
- **GIVEN** settings.json `memory.rewrite.enabled=false`, `memory.gate.enabled=true`
- **WHEN** gate 返回 `need_memory=true`
- **THEN** pipeline 用 raw current msg (gate 不再产 search_query) 单路调 recallAtoms + rerank
- **AND** 行为与"今天没有 rewrite 时"等价 — gate 已不再输出 search_query (见 design decision),所以 raw query 直接喂 rerank

### 场景: 三 subquery 全部 0 hits (B9)
- **GIVEN** rewrite 拆出 3 条都偏门,recall 都返 []
- **WHEN** merge → [] → rerank skip → format skip
- **THEN** TUI status "🔍 no memory match"
- **AND** debug log 输出 `rewrite=ok(3) recall=0+0+0 rerank=skip post=0`