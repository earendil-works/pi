# 使用场景: agent-driven-memory-save

## 正常流程

### Scenario: agent 主动新增 atom (无 id, fingerprint 不命中)
- **GIVEN** 当前 DB 内无相同 fingerprint 的 atom;agent 决定"记住:用户偏好用 bun 而不是 npm"
- **WHEN** agent 调用 `memory_save({type:"rule", title:"...", content:"...", tags:["preference"], importance:0.7})`
- **THEN** tool: `computeFingerprint(content)` → 未命中 → `embedText(buildEmbeddableText(...), 15s)` → `insertAtom(newAtom, vector)` → `writeAtomToFile(newAtom, atomsDir)` → `reindexOne(newAtom.id)` → 返 `{action:"created", id:<uuid>}`;DB `memory_index` 1 row;`memory_vectors` 1 row;.md 已写;bge-m3 已重编码

### Scenario: agent fingerprint 命中已有 atom (无 id, 重复内容)
- **GIVEN** DB 已存在 active atom `a-789`,其 `content_fingerprint` 与 agent 新写入的 content 相同
- **WHEN** `memory_save({type:"rule", title:"new title", content:"same content", ...})` (无 id)
- **THEN** tool: `computeFingerprint` → `index.getActiveAtomByFingerprint(fp)` 命中 → 返 `{action:"skipped", reason:"duplicate_content", existing_id:"a-789"}`,不写入任何文件或 DB 行

### Scenario: agent overwrite 已有 atom (id 复用, in-place update)
- **GIVEN** DB 存在 atom `a-123`(recall 看到 summary);agent 决定更新它的内容
- **WHEN** `memory_save({id:"a-123", type:"rule", title:"...", content:"new content", tags:[...], importance:0.7})`
- **THEN** tool: `index.getAtom("a-123")` 命中 → `embedText` → `index.updateAtom(mergedAtom, vector)`(in-place UPDATE,SQL `version = version + 1` 自动 bump)→ `writeAtomToFile` overwrite .md → `reindexOne` → 返 `{action:"updated", id:"a-123"}`;DB row 复用 id,version 自增;.md 内容更新

### Scenario: safety net 在 agent save ≥ 1 时跳过
- **GIVEN** 当前 session segment 内 agent 已调用过 `memory_save`(无论成功或被 fingerprint 拒);compact 被触发
- **WHEN** `session_before_compact` hook 入口检查 `segmentMemorySaveCount >= 1`
- **THEN** hook 直接 `return undefined`,compact 继续,不跑抽取

### Scenario: safety net 在 0 save 时跑抽取
- **GIVEN** segment 内 `segmentMemorySaveCount == 0`;`session_before_compact` 触发
- **WHEN** hook 进入 safety net 路径
- **THEN** 执行 `runCompactExtraction` 原流程(LLM 抽取 → `executeItem` → fingerprint + oldId dedup);`ctx.ui.notify` 显示提取进度;compact 继续

### Scenario: TUI 与 webui 通过同一 recallPipeline 召回
- **GIVEN** agent 在 TUI 调 context hook;同时 user 在 webui MemorySearchTester 输入相同 query "BWA 引物验证"
- **WHEN** TUI context hook 调 `recallPipeline(index, {query, recent: [前 3 条 user msg], topK: 20, ...})`;webui `/api/memory/search` 调 `recallPipeline(index, {query, recent: null, topK: 20, ...})`
- **THEN** 两路径内部跑相同的 `rewriteQueries` (recent 不同) → `recallAtoms(topK:20)` × subqueries → `rerankAndFilter` (threshold 0.05, gap 0.15) → `mergeByRerankScore`;最终返回 atoms 与 rrf 一致(仅 `recent` 影响 rewrite 的 subqueries,进而影响候选集)

## 异常流程

### Scenario: agent 提供 id 但 DB 不存在
- **GIVEN** agent 调 `memory_save({id:"a-ghost", ...})`,DB 无 `a-ghost`
- **WHEN** tool 调 `index.getAtom("a-ghost")`
- **THEN** 返 `{action:"error", error:"id_not_found", id:"a-ghost"}`,不写入任何文件或 DB 行;agent 收到后可选择去掉 id 重试(走 create 路径)

### Scenario: 嵌入服务不可达 (15s 超时或 ECONNREFUSED)
- **GIVEN** ollama / bge-m3 embed endpoint 不可达
- **WHEN** tool 调 `embedText(embeddable, {timeoutMs: 15000})`
- **THEN** `embedText` 返回 `null`;tool 沿用 `extraction.ts:243, 258` 模式:`vector = null ?? new Array(1024).fill(0)`;`insertAtom` / `updateAtom` 用 zero vector;`reindexOne` 仍调(让 bge-m3 服务读 .md 重编码);atom 落库,recall 走 bge-m3 sparse channel 兜底

### Scenario: agent 用 `write` 工具直接落盘 atom 文件
- **GIVEN** agent 调 `write({path:"~/.pi/agent/memory/atoms/process/foo.md", content:"..."})`
- **WHEN** `tool_call` hook 命中路径解析
- **THEN** hook 返 `{block: true, reason:"memory atoms must be written via memory_save tool"}`;`write` 工具不执行

### Scenario: agent 用 `bash` heredoc 写 atom 文件
- **GIVEN** agent 调 `bash({command:"cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF\n...\nEOF"})`
- **WHEN** `tool_call` hook 解析命令,匹配 `>` / `>>` / `tee` + 解析后命中 `atoms/**`
- **THEN** hook 返 block error,bash 不执行

### Scenario: agent `read` 已有 atom 文件 (合法路径, hook 不拦截)
- **GIVEN** agent 调 `read({path:"~/.pi/agent/memory/atoms/process/a-123.md"})`
- **WHEN** hook 检查是读操作 (无 `>` / `>>` / `tee`)
- **THEN** hook 不拦截,read 正常返回内容;`tool_result` hook(memory.ts:997)后续 bump `access_count`

### Scenario: writer 自洽 (writeAtomToFile 自身不触发 hook)
- **GIVEN** `memory_save` 内部调 `writeAtomToFile` → `fs.writeFile(<atoms path>)`
- **WHEN** 这是 Node fs 直调,非 agent tool_call
- **THEN** tool_call hook 不触发,writer 不被自阻断

### Scenario: safety net 抽取失败
- **GIVEN** `personalAssistant.memory.extraction.{provider,model}` 未配置 / auth 失败 / LLM 报错
- **WHEN** safety net 跑 `runCompactExtraction` 抛错
- **THEN** catch 内吞 error,`ctx.ui.notify("memory: safety net skipped, <reason>", "warn")`,`return undefined`,compact 继续(不再 `cancel: true`)

### Scenario: webui 调用 recallPipeline 时 bge-m3 服务挂掉
- **GIVEN** bge-m3 服务不可达
- **WHEN** webui `/api/memory/search` 调 `recallPipeline` → 内部 `recallAtoms` → `hybridSearch` → fetch `/api/search` 抛 ECONNREFUSED
- **THEN** `hybridSearch` graceful 返 `[]`(search.ts:99 `console.warn` 提示);`recallPipeline` 内部 continue(无候选 → rerank 跳过 → merge 空数组);响应 `{results: [], embeddingServiceStatus: "down", ...}`;前端 MemorySearchTester 显示 "0 results"

### Scenario: TUI context hook 中 recallPipeline 全部退化
- **GIVEN** gate 通过;rewrite 失败(LLM timeout);recallAtoms 失败(bge-m3 down);rerank 跳过
- **WHEN** `recallPipeline` 内部全部 fallback
- **THEN** 返回 `results: []`;context hook 检测空结果 → 不注入 LLM context,直接 return 原 event;`ctx.ui.setStatus("memory", "🔍 no memory match")`

## 边界条件

### Scenario: importance 边界值 0 与 1
- **GIVEN** agent 调 `memory_save({importance:0, ...})` 或 `importance:1, ...`
- **WHEN** tool schema 校验 (Type.Number min/max 由 TypeBox 约束)
- **THEN** 通过(importance 上下界 [0,1] 由 TypeBox schema 强制);atom 落库,`importance` 字段原样存;decay 计算时 importance=0 的 atom 自然衰减最快,importance=1 衰减最慢

### Scenario: title 长度 200 边界
- **GIVEN** `extractionPlanSchema` 限制 `title.max(200)`;`writeAtomToFile.isSafeFilename` 限制 `id.length <= 200`
- **WHEN** agent 传 `title` 长度 1 / 100 / 200
- **THEN** 通过;201 应被 TypeBox schema 拒

### Scenario: content 极短(< 10 字符)
- **GIVEN** `extractionPlanSchema` 限制 `content.min(10)`
- **WHEN** agent 传 `content: "x"`(< 10 chars)
- **THEN** schema 拒绝;返 `{action:"error", error:"content_too_short"}`

### Scenario: tags 数组为空 vs 字段缺失
- **GIVEN** `memory_save({tags:[], ...})` vs `memory_save({...})`(无 tags 字段)
- **WHEN** tool 处理
- **THEN** 两种等价:落库时 `tags = []`,`normalizeTags` 后仍 `[]`;`buildEmbeddableText` 不含 tags 段

### Scenario: type 不在白名单
- **GIVEN** agent 调 `memory_save({type:"opinion", ...})`
- **WHEN** schema 校验 (Type.Union 不含 "opinion")
- **THEN** 拒绝,返 `{action:"error", error:"invalid_type", allowed:["rule","fact","process"]}`

### Scenario: agent 短时间多次 save (counter 累积)
- **GIVEN** segment 内 agent 调 5 次 `memory_save`(部分成功部分被 fingerprint 拒)
- **WHEN** 每次 `memory_save` execute 入口 `segmentMemorySaveCount++`
- **THEN** counter = 5;compact 触发时 safety net 跳过(>=1);计数与成功/失败无关,只与"agent 主动调用过"相关

### Scenario: segment 内先 save 后 compact (中间无任何 save)
- **GIVEN** segment turn 1-3 agent 调过 `memory_save`;turn 4-10 没有任何 save;turn 11 触发 compact
- **WHEN** safety net 检查 `segmentMemorySaveCount`
- **THEN** counter 仍是 turn 3 时的值(>0),safety net 跳过;counter 在 `session_start` 与 `session_compact` 重置,**不在** `before_agent_start` 重置(per-turn 不重置才能正确累积 per-segment)

### Scenario: tool_call hook 高频调用性能
- **GIVEN** agent 每 turn 调 5-10 个 tool,每个 tool_call 走 hook
- **WHEN** hook 检查路径
- **THEN** 单次 hook 路径 resolve + 正则匹配 < 1ms;非 memory 路径快速返回 undefined,无显著开销

### Scenario: webui 调 recallPipeline 时 `recent` 字段缺失
- **GIVEN** webui 请求体 `{query: "...", topK: 20}` 无 `recent` 字段
- **WHEN** webui 调 `recallPipeline(index, {query, recent: undefined, topK: 20, ...})`
- **THEN** `recallPipeline` 内部 `recent ?? null` 传给 `rewriteQueries`;`rewriteQueries` 用 `null` 拼 prompt(`Recent user messages: None`);与 webui 当前行为一致(无回归);TUI 与 webui 唯一差异是 `recent` 有无

### Scenario: recallPipeline 的 topK 参数边界
- **GIVEN** webui 请求 `{query: "...", topK: 200}`
- **WHEN** `recallPipeline` 内部 clamp `topK` 到 [1, 100]
- **THEN** topK > 100 截到 100;topK < 1 截到 1;NaN / undefined 用默认 20(与 TUI 对齐)