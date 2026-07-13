# 变更提案: agent-driven-memory-save

## 动机

memory 子系统当前写路径是单点:`session_before_compact` → LLM 抽取 (`extraction.ts:executeItem`) → `writeAtomToFile` + `MemoryIndex.insertAtom` / `updateAtom` + bge-m3 `reindexOne`。这条路径有几个结构性问题:

1. **agent 没有显式写入口** — 想"立刻记下这条规则"必须等下一次 compact,粒度与重要性由 LLM 抽取决定,agent 无法控制。LLM 抽取是事后批处理,跨多轮才显现的认知常常漏掉。
2. **agent 可绕过 schema** — 通用 `write`/`edit`/`bash` 可直接落盘 `~/.pi/agent/memory/atoms/**`。`tool_result` hook (memory.ts:997-1063) 调 `reindexOne` 让 bge-m3 重读 .md,但**不创建 `memory_index` 行** → `search.ts:136 if (!dbAtom) continue` 直接过滤 → recall 命中不到。这是"幽灵 atom":bge-m3 索引里有,`memory_index` 没行,无法被读取/审计/衰减/merge,下次 extract 还会被 LLM 重新发现并创建一条。
3. **抽取失败 = compact 取消** — `session_before_compact` 当前是 hard-gate (memory.ts:336-353),LLM 不可达就阻止 compact;长 session 抽取失败率随消息数上升,用户体验差。
4. **TUI 与 webui recall pipeline 重复实现,已开始漂移** — TUI 在 `memory.ts:726` context hook 内 inline 写;webui 在 `routes/memory.ts:845 registerPostSearch` 内 inline 写。两份代码独立演化:
   - **rewrite 上下文不一致**:TUI 传 `(current, recent[])` 最多 3 条前文给 `rewriteQueries`,webui 传 `(query, null)` → 指代消解("上面的脚本" → "search_3n_path.py")在 webui 完全失效
   - **`topK` 默认值不同**:TUI 固定 20,webui 默认 10 → 候选池大小不同,rerank 输出可能不同

## 影响范围

- **新增 Capability: `agent-memory-write-tool`** — agent 可通过单一 `memory_save` tool 主动写 memory,不依赖 compact
- **新增 Capability: `tui-webui-recall-parity`** — 抽出 `recallPipeline()` shared helper,TUI context hook 与 webui `/api/memory/search` 都调它,确保除 gate 外的 pipeline 步骤完全一致
- **修改 Capability: `memory-v2`** — `session_before_compact` 改为 safety net(整段对话 0 次 `memory_save` 才跑抽取,失败 graceful 不再 cancel compact)
- **修改 Capability: `memory-v2`** — `tools.ts:tool_call` hook 加分支,硬阻断 `write` / `edit` / `bash` 写 `~/.pi/agent/memory/atoms/**`(读不受限;`writeAtomToFile` 不经 hook 自洽)
- **修改 Capability: `memory-v2`** — system prompt 增量(`tools.ts:828 before_agent_start`),告知 agent `memory_save` 的存在与使用规范

## 非目标

- 不替换 webui `PATCH /api/memory/:id` 路径(那是给人/UI 用的,与 agent 工具正交)
- 不引入 `memory_update` / `memory_archive` tool(更新走 overwrite 复用 id;归档由 supersede 链 / auto-decay / webui 负责)
- 不改 extraction LLM 抽取 prompt 与 `executeItem` 核心去重逻辑(已锁定为 fingerprint + oldId,见 extraction.ts:99 "不再走 LLM 二次确认或余弦 gate:你的 oldId 字段是唯一的 update 引用方式")
- 不改 HTTP API 形态 / DB schema / 前端 UI 表现层
- 不改 recall / gate / rerank / hybrid-search 任意读路径的算法(只重构 pipeline 编排,不调阈值或融合策略)
- 不解决 inbox 堆积(后续独立 change)
- 不在 webui MemorySearchTester 注入对话上下文(debug 工具,无会话上下文)

## 验收标准

### agent-memory-write-tool
1. agent 可通过 `memory_save` tool 主动写 atom,不依赖 compact 触发
2. `memory_save` 无 id 时先 fingerprint dedup(`getActiveAtomByFingerprint`):命中 → 返回 `{action:"skipped", reason:"duplicate_content", existing_id}`
3. `memory_save` 无 id 且 fingerprint 未命中 → `embedText` + `insertAtom` + `writeAtomToFile` + `reindexOne`,返 `{action:"created", id}`
4. `memory_save` 带 id 且 DB 存在该 atom → `updateAtom`(in-place,version 由 SQL 自增,保留 id),`writeAtomToFile` overwrite,`reindexOne`,返 `{action:"updated", id}`
5. `memory_save` 带 id 但 DB 不存在 → 返回 `{error:"id_not_found", id}`
6. agent 用 `write` 工具路径命中 `~/.pi/agent/memory/atoms/**` → tool_call hook 返回 block error
7. agent 用 `bash` 通过 `>` / `>>` / `tee` 显式写到该路径 → block error
8. 嵌入服务 15s 超时或不可达 → atom 入库但 vector 用 zero-vector fallback,`memory_vectors` 表行为不变(沿用 `extraction.ts:243, 258` 的 `embedding ?? new Array(1024).fill(0)` 模式)
9. 进程内 `writeAtomToFile` 不被 hook 拦截(直接调 `fs.writeFile`,不经 tool_call)

### session_before_compact safety net
10. 整段对话 agent `memory_save` ≥ 1 次 → safety net 跳过抽取,`session_before_compact` 直接 `return undefined`,compact 继续
11. 整段对话 agent `memory_save` = 0 次 → safety net 跑原抽取流程
12. safety net 抽取失败 (无 model 配置 / auth 失败 / LLM 错误) → graceful skip,`ctx.ui.notify` 提示,`return undefined`,compact 继续(不再 `cancel: true`)

### tui-webui-recall-parity
13. TUI context hook (memory.ts:726) 与 webui `/api/memory/search` (routes/memory.ts:845) 都通过同一 `recallPipeline(index, opts)` 函数完成 rewrite → recall → rerank → merge
14. 两路径 `topK` 默认值一致(20)
15. 两路径都接受 `recent: string[] | null` 参数(TUI 从 context hook 取前 3 条 user msg,webui 从请求体 `recent` 字段取,默认 `null`)
16. webui 响应额外加 `embeddingServiceStatus` 字段(TUI 不需要,这是 webui debug 探针,不影响一致性)
17. 现有 webui PATCH `supersedeIfSimilar` 的 0.65 cosine supersede 行为不变(回归)

### 回归
18. 现有 webui `PATCH /api/memory/:id` 路径行为不变(`supersedeIfSimilar` + `updateAtomIfVersion` CAS 不动)
19. 现有 extraction 流程行为不变(仍走 fingerprint + oldId + executeItem 旧逻辑)
20. 现有 `search.ts:recallAtoms` / `hybridSearch` / `bge-reindex` / `drift-sweep` 不变
21. 现有 `tool_result` hook 的 read→access_count / write/edit→reindexOne 行为不变