# Design: agent-driven-memory-save

## Context

memory 子系统当前写入只有一条路径:`session_before_compact` → LLM 抽取 (`extraction.ts:executeItem`) → fingerprint dedup + LLM oldId 决策 → `MemoryIndex.insertAtom` 或 `updateAtom` + `writeAtomToFile` + `bge-reindex.ts:reindexOne`(让 bge-m3 服务读 .md 重编码)。`extraction.ts:99` 已明确锁定:"不再走 LLM 二次确认或余弦 gate:你的 oldId 字段是唯一的 update 引用方式"。cosine 0.65 supersede 仅剩 webui PATCH 路径(`supersedeIfSimilar` in `dedup.ts`)。

**痛点**:

1. **agent 缺显式写入口** — 想"立刻记下这条规则"必须等下一次 compact;agent 无法控制粒度或重要性。LLM 抽取是事后批处理。
2. **agent 直接写文件产生"幽灵 atom"** — agent 用 `write`/`edit`/`bash` 落盘 `~/.pi/agent/memory/atoms/**/*.md`,`tool_result` hook (memory.ts:997-1063) 调 `reindexOne` 让 bge-m3 重编码,但**不创建 `memory_index` 行** → `search.ts:136 if (!dbAtom) continue` 过滤 → recall 命中不到;bge-m3 索引里有但 sqlite 没行,无法被读取/审计/衰减/merge;下次 extract 还会被 LLM 重新发现并创建重复。
3. **抽取失败 = compact 取消** — `memory.ts:336-353` hard-gate,长 session 抽取失败率随消息数上升,用户体验差。
4. **TUI 与 webui recall pipeline 重复实现且开始漂移** — TUI `memory.ts:726 context` hook inline 写;webui `routes/memory.ts:845 registerPostSearch` inline 写。两份独立演化导致两处差异:
   - `rewriteQueries` 输入:TUI 传 `(current, recent[])` 最多 3 条前文;webui 传 `(query, null)` → webui 指代消解("上面的脚本" → "search_3n_path.py")完全失效
   - `topK` 默认:TUI 固定 20;webui 默认 10 → 候选池大小不同,rerank 输出可能不同

**为什么需要变更**: 补 agent 显式写工具 + 阻断幽灵 atom 路径 + 让 safety net 兜底 + 抽出共享 recall pipeline 让 TUI/webui 不再漂移。

## Goals / Non-Goals

### Goals

- agent 可通过单一 `memory_save` tool 显式写 atom,不依赖 compact
- 复用 extract pipeline 的 fingerprint + oldId dedup 逻辑(同一 `extraction.ts:executeItem` 函数,或抽出 `executeDedup` helper 共享)
- overwrite 走 `updateAtom` in-place(保留 id,SQL 自动 `version = version + 1`),与 extract 路径一致
- `tool_call` hook 阻断 `write`/`edit`/`bash` 写 `~/.pi/agent/memory/atoms/**`(`writeAtomToFile` 经 fs 直调,自洽)
- `session_before_compact` 退化为 safety net:仅在 agent 整段 0 次 save 时跑;失败 graceful skip
- 嵌入失败 graceful,atom 入库但 vector 用 zero-vector fallback(`embedding ?? new Array(1024).fill(0)`)
- 抽出 `recallPipeline(index, opts)` 共享 helper,TUI context hook 与 webui `/api/memory/search` 都调它,`topK` 默认 20 一致
- `recallPipeline` 接受 `recent: string[] | null`,TUI 传前 3 条 user msg(指代消解),webui 默认 null(无会话上下文)
- webui 响应可保留 `embeddingServiceStatus` 字段(TUI 不需要,webui debug 探针)
- webui PATCH `supersedeIfSimilar` 的 0.65 cosine supersede 行为不变(回归)
- extraction 流程不变(仍走 fingerprint + oldId)
- `tool_result` hook 行为不变(read→access_count / write/edit→reindexOne)

### Non-Goals

- 不引入 `memory_update` / `memory_archive` tool(overwrite 走 in-place update;归档走 webui / auto-decay / supersede)
- 不改 HTTP API 形态 / DB schema / 前端 UI 表现层(MemorySearchTester 不变)
- 不改 extraction LLM 抽取 prompt 与 `executeItem` 核心去重逻辑
- 不改 recall / gate / rerank / hybrid-search 任意读路径的算法(只重构 pipeline 编排)
- 不解决 inbox 堆积(后续独立 change)
- 不在 webui MemorySearchTester 注入对话上下文

## Decisions

### 1. 单一 `memory_save` tool 而非多 tool
**Decision**: 只暴露 `memory_save`,内部根据是否带 `id` 区分 create / overwrite / fingerprint-skip 三种 outcome。
**Rationale**: 用户已确认 save-only — 更新通过 overwrite 复用 id 完成,归档由 webui / supersede 链 / auto-decay 负责。少 tool = agent prompt 短、误用率低。
**Alternatives considered**: 多 tool (memory_save / memory_update / memory_archive) — 已被用户否决;单 tool + action 枚举 — action 字符串弱类型,错误信息模糊。

### 2. 复用 extract pipeline 的去重决策树(fingerprint + oldId)
**Decision**: `memory_save` 无 id 时先 fingerprint dedup(`index.getActiveAtomByFingerprint`),命中 → skip。**不**引入 cosine gate,与 extract pipeline `executeItem` (extraction.ts:202-261) 行为一致。
**Rationale**: extract 路径已锁定为 fingerprint + oldId 两条决策(2026-07-09 commit 2a9697795),再加 cosine 会引入新漂移源。`memory_save` 由 agent 显式调用,LLM 已经"决策过"该存什么,不需要 cosine 二次确认。webui PATCH 路径的 `supersedeIfSimilar`(0.65 cosine)保留不动,因为 user 手动编辑场景语义不同。
**Alternatives considered**: 引入 cosine 0.65 supersede — 与 extract 不一致;无 dedup — 重复 atom 污染 DB。

### 3. overwrite 走 `updateAtom` in-place UPDATE,不删不插
**Decision**: `memory_save` 带 id 且 DB 存在 → `embedText` + `index.updateAtom(mergedAtom, vector)`(in-place UPDATE,SQL `version = version + 1` 自动 bump)→ `writeAtomToFile` overwrite .md → `reindexOne`。
**Rationale**: 与 `extraction.ts:executeItem` 第 3 步 (line 227-252) 的 update 路径完全一致。`updateAtom` 不删 sqlite row,只 UPDATE 字段;`writeAtomToFile` overwrite .md 文件;`reindexOne` 让 bge-m3 重读。不产生 supersede chain(那是 webui PATCH 路径独有的)。
**Alternatives considered**: 删 file + `insertAtom`(同 id 会 PRIMARY KEY 冲突);走 `markSupersededTx` + 新 id(产生不需要的 chain)。

### 4. tool_call hook 硬阻断 + writer 自洽
**Decision**: `tools.ts:934` 的 `tool_call` hook 加分支,检测 `write`/`edit` 的 `path` 字段,以及 `bash` 的 `command` 字段中匹配 `>` / `>>` / `tee ` + 解析后命中 `~/.pi/agent/memory/atoms/**`,返回 `{block: true, reason: ...}`。`read` 不阻断。
**Rationale**: writer (`writeAtomToFile`) 直接调 `fs.writeFile`,不经 tool_call,自然不被 hook。agent `read` 已有 atom 全文是合法用例(便于显式 `memory_save` 前查看),hook 不应阻断。bash 阻断只看显式写模式,避免误伤 `cat ~/.pi/agent/memory/atoms/.../foo.md` 读操作。
**Alternatives considered**: 软警告 (写入成功但标 stale) — 污染 DB;仅挡 write/edit 不过滤 bash — agent 用 bash 一行就绕过。

### 5. safety net 仅在 0 save 时触发
**Decision**: `session_before_compact` 进入前检查 `segmentMemorySaveCount >= 1` → 跳过抽取;`== 0` → 跑原抽取流程。
**Rationale**: agent-driven 是主路径,auto-extract 是兜底。预期 agent save 率 ≥ 95%,safety net 触发 < 5%,既保留"agent 完全忘记存"的兜底又不重复做 agent 已经做过的抽取。counter 在 `memory_save` execute 入口 `++`;reset 只发生在 `session_start` 和 `session_compact` 两个会话边界 — 不在 `before_agent_start` reset,因为那样会导致长 segment 内早期 save 被吞掉,safety net 反而误触发 (S22/R5 矛盾点:plan-review Level 1 期间发现)。
**Alternatives considered**: 始终跑抽取 + 与 agent save 去重 — 烧 token;session 级去重 — 粒度粗;`before_agent_start` reset — 同一段内回滚会失效 (rejected)。

### 6. safety net 失败 graceful
**Decision**: safety net 路径 catch 抽取失败 (无 model 配置 / auth 失败 / LLM 错误),`ctx.ui.notify` 提示,`return undefined`,compact 继续。
**Rationale**: 当前是 `cancel: true` (memory.ts:352),把工程问题转嫁给用户体验。改成 graceful skip 后,user 至少 compact 能进行,memory 短暂缺失下次 agent 主动 save 补回。
**Alternatives considered**: 保留 cancel 但加 retry — 增加复杂度,没解决根因;fail loud (抛错给 user) — 已通过 notify 实现。

### 7. 嵌入失败 graceful(zero vector fallback)
**Decision**: `memory_save` 调 `embedText` 返回 `null` 时,沿用 `extraction.ts:243, 258` 模式:`vector = null ?? new Array(1024).fill(0)`,`insertAtom` / `updateAtom` 用 zero vector;`reindexOne` 仍调(让 bge-m3 服务读 .md 重编码,产出真实 sparse channel 向量)。
**Rationale**: zero vector sqlite-vec 接受(embed.ts:99 "sqlite-vec would reject anything else" 注释指的是 NaN/Inf,zero vector 通过)。`reindexOne` 是关键 — 它让 bge-m3 服务读 .md 并产生真实的 dense+sparse 向量,recall 主要走 bge-m3 而非 sqlite-vec,因此 atom 仍能被命中。
**Alternatives considered**: 完全不写 vector — `insertAtom` 必传 vector(签名约束),不可行。

### 8. 抽出 `recallPipeline()` 共享 helper
**Decision**: 新模块 `extensions/personal-assistant/recall.ts`,导出 `recallPipeline(index, opts)` 函数。内部跑:`rewriteQueries(query, recent ?? null)` → `Promise.all(subqueries.map(sq => recallAtoms + rerankAndFilter))` → `mergeByRerankScore(poolResults)`。
**Rationale**: TUI 与 webui 重复实现同一段 pipeline 已开始漂移(`recent` 和 `topK` 差异)。抽出共享函数强制一致 — 任何 pipeline 改动都必须走同一处,review 时拒绝 inline 重复实现。TUI context hook 改调 `recallPipeline(index, {query: current, recent, topK: 20, ...})`;webui `/api/memory/search` 改调 `recallPipeline(index, {query, recent: req.body.recent ?? null, topK: req.body.topK ?? 20, ...})`。
**Alternatives considered**: 不抽 helper,手工同步两处 — 已证明会漂移;把整个 recall + rerank + merge 合并成一个 fetch 调用 bge-m3 服务 — 算法层重组,超出本 scope。

### 9. `recallPipeline` 接受 `recent: string[] | null`,`topK` 默认 20
**Decision**: `RecallPipelineOptions` 接口含 `recent?: string[] | null`(内部 `?? null` 传给 `rewriteQueries`);`topK?: number` 默认 20(与 TUI 当前行为对齐);`rerankEnabled?: boolean` 默认 `true`(沿用当前 TUI 行为)。
**Rationale**: 消除两处差异。TUI 传 `recent: [前 3 条 user msg]`(来自 `context` hook 的 user messages 提取);webui 默认 `recent: null`(debug 工具无会话上下文,但 API 允许前端传,未来扩展)。
**Alternatives considered**: TUI 也传 `null` — 牺牲指代消解,UX 退化;webui 也强制传 recent — debug 工具无法提供。

### 10. system prompt 增量
**Decision**: `tools.ts:828 before_agent_start` 注入 memory 操作规范段,告知 agent `memory_save` 的存在、使用时机、conflict 处理。
**Rationale**: agent 不主动存是结构性遗忘风险的核心,prompt 提示是低成本缓解。规范包括:重要事实/规则/流程主动存;fingerprint 命中是 skip 不是 error;不存瞬时对话/工具输出/猜测性内容。
**Alternatives considered**: 不改 prompt,纯靠 tool 暴露 — 遗忘率不可控;强 prompt 强制每 turn 评估是否 save — cognitive overhead。

## Architecture

### 组件划分

```
extensions/personal-assistant/
├── memory-save.ts          [NEW]   tool 定义 + 三 outcome 编排 (skipped/created/updated)
├── recall.ts               [NEW]   recallPipeline() 共享 helper (TUI + webui)
├── dedup.ts                [REUSE] supersedeIfSimilar (webui PATCH only, 不动)
├── tools.ts                [MOD]   register memory_save + path guard 分支 + system prompt
├── memory.ts               [MOD]   session_before_compact safety net + segment counter reset
├── extraction.ts           [REUSE] fingerprint + oldId 决策 (executeItem), 与 memory-save 共用
├── file-store.ts           [REUSE] writeAtomToFile / isSafeFilename / computeContentHash
├── storage.ts              [REUSE] MemoryIndex.{insertAtom, updateAtom, getAtom,
│                                    getActiveAtomByFingerprint, deleteVector, upsertVector}
├── embed.ts                [REUSE] embedText / buildEmbeddableText (15s timeout, null on fail)
├── bge-reindex.ts          [REUSE] reindexOne (POST bge-m3 /api/atoms/{id}/reindex)
├── tag-alias.ts            [REUSE] normalizeTags
├── search.ts               [REUSE] recallAtoms (pass-through to bge-m3 /api/search)
├── hybrid-search.ts        [REUSE] hybridSearch (dual-channel RRF)
├── rewrite.ts              [REUSE] rewriteQueries (近期消息指代消解)
├── rerank.ts               [REUSE] rerankAndFilter (threshold 0.05 + gap 0.15)
├── merge.ts                [REUSE] mergeByRerankScore
├── format.ts               [REUSE] formatMemoryContext (TUI LLM 注入用)
└── test/
    ├── memory-save-tool.test.ts  [NEW]  fingerprint-skip / create / overwrite / id-not-found /
    │                                       embedding-down / path-guard / safety-net-skip
    └── recall-pipeline.test.ts    [NEW]  TUI 与 webui 共享同一函数 / recent 透传 / topK 默认

packages/webui/server/routes/memory.ts  [MOD] registerPostSearch 改为调 recallPipeline
packages/webui/server/test/memory-routes.test.ts  [MOD] 新测试覆盖 recent 字段 + topK 默认
```

### memory_save tool 接口 (TypeBox schema)

```typescript
const MemorySaveParams = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  type: Type.Union([
    Type.Literal("rule"),
    Type.Literal("fact"),
    Type.Literal("process"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  content: Type.String({ minLength: 10, maxLength: 5000 }),
  summary: Type.String({ minLength: 5, maxLength: 500 }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 10 })),
  importance: Type.Number({ minimum: 0, maximum: 1 }),
  source_session: Type.Optional(Type.String()),
});
```

返回值 (`details` 字段):
```typescript
type MemorySaveResult =
  | { action: "created"; id: string; embedding: "ok" | "skipped" }
  | { action: "updated"; id: string; embedding: "ok" | "skipped" }
  | { action: "skipped"; reason: "duplicate_content"; existing_id: string }
  | { action: "error"; error: "id_not_found" | "invalid_type" | "content_too_short"; details?: unknown };
```

### 数据流 (memory_save, create 路径)

```
agent: memory_save({type, title, content, tags, importance})
  ↓
[memory-save.ts] validate schema (TypeBox) → normalizeTags (tag-alias.ts)
  ↓
fingerprint = computeFingerprint(content)        // extraction.ts:30
  ↓
existing = index.getActiveAtomByFingerprint(fingerprint)  // storage.ts:312
  ├─ 命中 → return {action: "skipped", existing_id: existing.id}     [STOP]
  └─ 未命中 → continue
  ↓
embeddable = buildEmbeddableText({title, summary, tags})  // embed.ts:150
embedding = await embedText(embeddable, {timeoutMs: 15000})  // embed.ts:64
  ├─ null → vector = new Array(1024).fill(0)         [沿用 extraction.ts:243 模式]
  └─ ok   → vector = embedding
  ↓
now = Date.now()
newAtom: MemoryAtom = {
  id: randomUUID(),
  type, title, summary, content, tags, importance,
  strength: 1.0,                  // extraction.ts:278
  access_count: 0, version: 1, is_latest: 1,
  parent_id: null, superseded_at: null, archived: 0,
  created_at: now, updated_at: now, last_access: null,
  content_fingerprint: fingerprint,
  source_session: source_session ?? currentSessionId,
}
  ↓
await index.insertAtom(newAtom, vector)         // storage.ts:156 (sqlite row + memory_vectors row)
await writeAtomToFile(newAtom, atomsDir)        // file-store.ts:42 (.md 新建)
await reindexOne(newAtom.id)                    // bge-reindex.ts:43 (bge-m3 重读 .md)
  ↓
segmentMemorySaveCount++                        // module-level counter
  ↓
return {action: "created", id, embedding: embedding ? "ok" : "skipped"}
```

### 数据流 (memory_save, overwrite 路径)

```
agent: memory_save({id, type, title, content, ...})
  ↓
existing = index.getAtom(id)                    // storage.ts:278
  ├─ null → return {action: "error", error: "id_not_found", id}    [STOP]
  └─ ok   → continue (不管 is_latest / archived, 与 extraction.ts:228 一致不检查)
  ↓
fingerprint = computeFingerprint(content)
  └─ 实际无 fingerprint dedup 拦截 (与 extraction.ts:227-228 一致)
  ↓
embedding = await embedText(...)
vector = embedding ?? new Array(1024).fill(0)
  ↓
mergedAtom: MemoryAtom = {
  ...existing,
  type, title, summary, content, tags, importance,
  content_fingerprint: fingerprint,
  updated_at: Date.now(),
  // id, version 保留 (storage.ts:194 SQL version = version + 1 自动 bump)
  // source_session 保留
}
  ↓
await index.updateAtom(mergedAtom, vector)       // storage.ts:186 (in-place UPDATE)
await writeAtomToFile(mergedAtom, atomsDir)      // file-store.ts:42 (.md overwrite)
await reindexOne(mergedAtom.id)                  // bge-reindex.ts:43
  ↓
segmentMemorySaveCount++
  ↓
return {action: "updated", id, embedding: embedding ? "ok" : "skipped"}
```

### data flow (recallPipeline, 共享 helper)

```
[index.ts or webui route]
  await recallPipeline(index, {
    query: string,
    recent?: string[] | null,         // TUI 传 [前 3 条 user msg], webui 默认 null
    topK?: number,                    // 默认 20
    filter?: { type?: MemoryAtomType },
    rerankEnabled?: boolean,          // 默认 true
    embeddingServiceUrl?: string,
    atomsDir: string,
    embeddingServiceUrlProbe?: boolean, // webui=true 探针 / TUI=undefined/false
  })
```

内部步骤:
```
1. rewriteQueries(query, recent ?? null)         // rewrite.ts:316
   → subqueries: string[]

2. if embeddingServiceUrlProbe:
     probe /api/health (100ms timeout)
     → embeddingServiceStatus: "up" | "down"

3. open MemoryIndex (caller 传)

4. Promise.all(subqueries.map(async sq => {
     const sqResults = await recallAtoms(index, sq, {
       topK: topK ?? 20,
       filter,
       atomsDir,
     })
     if (sqResults.length === 0) return []
     if (!rerankEnabled) return sqResults
     const scored = await rerankAndFilter(sq, sqResults)  // rerank.ts:88
     return Array.isArray(scored) ? scored : scored.topK   // fallback ok
   }))

5. results = mergeByRerankScore(poolResults)     // merge.ts

6. return {
     results,
     status: {
       rewrite: "ok" | "skip" | "parse" | "timeout" | "unreachable",
       rerank: "ok" | "fallback" | "skip" | "all-below",
       recallMs, rewriteMs, rerankMs,
       embeddingServiceStatus?: "up" | "down",
     },
   }
```

### TUI context hook 改造 (memory.ts:726)

当前 inline pipeline(rewrite → recall → rerank → merge → format → inject)改为:
```typescript
// gate 部分保留 (callGate + decision + 跳过)
// rewriteEnabled + subqueries 部分保留

// 替换 inline Promise.all + recall + rerank + merge:
const { results, status } = await recallPipeline(index, {
  query: current,
  recent,                                     // 上文已提取的 user messages
  topK: 20,
  filter: undefined,
  rerankEnabled,
  atomsDir,
  embeddingServiceUrlProbe: false,             // TUI 不需要
});

// formatMemoryContext(results, 4000)           // TUI 仍需要
// inject into last user msg                    // TUI 仍需要
```

### webui `/api/memory/search` 改造 (routes/memory.ts:845)

当前 inline pipeline(rewrite → recall → rerank → merge)改为:
```typescript
// 移除 inline rewriteQueries + recallAtoms + rerankAndFilter + mergeByRerankScore
const { results, status } = await recallPipeline(index, {
  query,
  recent: typeof req.body?.recent === "string[]" ? req.body.recent : null,
  topK: clamp(parseInt(req.body?.topK) || 20, 1, 100),
  filter: type ? { type } : undefined,
  rerankEnabled: filtered !== false,
  atomsDir: deps.atomsDir,
  embeddingServiceUrlProbe: true,              // webui 需要 status
});

// 响应:
res.json({
  results: results.map(r => ({...})),
  recallTimeMs: status.recallMs,
  rewriteTimeMs: status.rewriteMs,
  rerankTimeMs: status.rerankMs,
  embeddingServiceStatus: status.embeddingServiceStatus,
});
```

### session_before_compact safety net (memory.ts:336)

```typescript
// 模块级 counter (与 tools.ts:828 已有 pattern 一致: todoItems / roundsSinceTodo)
let segmentMemorySaveCount = 0;

// reset 只在 session 边界 (session_start + session_compact),NOT before_agent_start
//   原因: counter 跨 turn 累积,长 segment 内 turn 1-3 三个 save 后,turn 4-10
//         即使无 save 也不应 reset,否则 safety net 误触发 (S22/R5)。
pi.on("session_start", async (_event, _ctx) => {
  segmentMemorySaveCount = 0;                 // [NEW]
});
pi.on("session_compact", async (_event, _ctx) => {
  segmentMemorySaveCount = 0;                 // [NEW]
});

// memory-save.ts tool execute 入口
segmentMemorySaveCount++;

// session_before_compact 改
pi.on("session_before_compact", async (event, ctx) => {
  if (segmentMemorySaveCount > 0) {
    // safety net 跳过, agent 已主动管理过 memory
    return undefined;
  }
  try {
    await runCompactExtraction(event, ctx);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[memory-v2] session_before_compact: safety net failed, skipping:", msg);
    notifySafely(ctx, `memory: safety net skipped — ${msg}`, "warn");
    return undefined;                         // [改] 不再 cancel: true
  }
});
```

### tool_call hook 路径拦截 (tools.ts:934)

```typescript
pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
  const turnId = String((event as any).turnIndex ?? "global");

  // 1. Satellite (existing)
  if (event.toolName === SATELLITE_TOOL_NAME) {
    const mcpConfig = loadMcpConfig();
    const validation = validateSatelliteCall(event.toolName, event.input, mcpConfig, turnId);
    if (validation) return validation;
    return interceptTransferCall(event);
  }

  // 2. [NEW] Memory atom path guard
  if (event.toolName === "write" || event.toolName === "edit") {
    const rawPath = (event.input.path ?? event.input.file_path) as string | undefined;
    if (typeof rawPath === "string" && isUnderAtomsDir(rawPath, atomsDir)) {
      return {
        block: true,
        reason: "memory atoms must be written via the memory_save tool, " +
                "not direct file write/edit. Use memory_save({type, title, content, ...}) instead.",
      };
    }
  }
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (looksLikeWriteToAtomsDir(cmd, atomsDir)) {
      return {
        block: true,
        reason: "memory atoms must be written via the memory_save tool, " +
                "not bash redirect/heredoc.",
      };
    }
  }

  return undefined;
});
```

`isUnderAtomsDir(path, atomsDir)` 复用 `memory.ts:makeAtomPathRegex` (line 233) 的思路:resolve `~` → home,检查 `${atomsDir}/${type}/${id}.md` 形式或 `${atomsDir}/...` 前缀。

`looksLikeWriteToAtomsDir(cmd, atomsDir)` 简化实现:正则匹配 `>(>?)\s*["']?~?/?[^{}<>]*atoms/` 或 `\btee\b\s+~?/?[^{}<>]*atoms/`,不解析完整 shell。

### system prompt 增量 (tools.ts:828 before_agent_start)

```typescript
// tools.ts:828 已有 planningSection, append memorySection:
const memorySection = [
  "",
  "## Memory",
  "",
  "You have a `memory_save` tool to durably record important facts, rules, and processes.",
  "Use it proactively when the user states a preference, defines a rule, or describes a workflow.",
  "",
  "Rules:",
  "  1. Save DURABLE knowledge only — preferences, rules, conventions, recurring processes. Do NOT save transient chat, tool outputs, or speculative guesses.",
  "  2. If `memory_save` returns `{action:\"skipped\", reason:\"duplicate_content\", existing_id}`, an atom with the same content already exists — do not retry.",
  "  3. If you need to update an existing atom, pass `id` in the call. To create a new one, omit `id`.",
  "  4. Set `importance` honestly (0-1): 0=trivial, 0.5=default, 1=critical. Don't inflate.",
  "  5. Tags should be lowercase, hyphen-separated, 1-3 words each, ≤10 tags.",
].join("\n");
```

## Existing Code to Reuse

### Reuse: writeAtomToFile
- **Path**: `extensions/personal-assistant/file-store.ts:42`
- **Why**: 唯一受支持的 atom file 写入路径,生成 frontmatter、`isSafeFilename` 校验、递归 mkdir。`memory_save` create / overwrite 路径都需要
- **Risk**: 假设 frontmatter schema / 路径 layout 不变
- **Decision**: reuse

### Reuse: computeContentHash
- **Path**: `extensions/personal-assistant/file-store.ts:105`
- **Why**: sha256(normalize(content)).slice(0,16) — 与 `extraction.ts:computeFingerprint` 等价(都用 `normalizeContent`)。`memory_save` 不直接用(它用 `extraction.ts:computeFingerprint`);reused 仅是 design 备注
- **Risk**: 算法不能变,否则 `memory_index.content_fingerprint` 与 .md 的 hash 不一致
- **Decision**: reuse (间接)

### Reuse: computeFingerprint
- **Path**: `extensions/personal-assistant/extraction.ts:30`
- **Why**: sha256(normalize(content)).slice(0,16) — `memory_save` 与 extract 共用的 fingerprint dedup 原语
- **Risk**: 算法不能变
- **Decision**: reuse

### Reuse: normalizeContent
- **Path**: `extensions/personal-assistant/extraction.ts:22`
- **Why**: fingerprint 与 file content hash 都基于 normalize 后的内容,保证两者一致
- **Risk**: 文件从 extraction.ts 导出,`memory-save.ts` 引入 extraction 模块(已有 dependency)
- **Decision**: reuse

### Reuse: isSafeFilename
- **Path**: `extensions/personal-assistant/file-store.ts:312`
- **Why**: id 合法性校验。`memory_save` overwrite 路径需校验 agent 提供的 id(从 recall 拿到的 uuid,通常安全,但 schema 不强制)
- **Risk**: 已有 limit 200 / 拒绝空 / 拒绝相对路径
- **Decision**: reuse

### Reuse: MemoryIndex.insertAtom
- **Path**: `extensions/personal-assistant/storage.ts:156`
- **Why**: 标准 atom 入库(事务:memory_index row + memory_vectors row)。`memory_save` create 路径必须用
- **Risk**: 必传 embedding;zero vector 接受(沿用 extraction.ts:243 模式)
- **Decision**: reuse

### Reuse: MemoryIndex.updateAtom
- **Path**: `extensions/personal-assistant/storage.ts:186`
- **Why**: in-place UPDATE,SQL `version = version + 1` 自动 bump。`memory_save` overwrite 路径与 `extraction.ts:executeItem` 第 3 步 (line 244) 共用
- **Risk**: 假设 `atom.version` 字段被忽略(SQL 自增);若 storage 重构需同步
- **Decision**: reuse

### Reuse: MemoryIndex.getAtom
- **Path**: `extensions/personal-assistant/storage.ts:278`
- **Why**: id 查找。`memory_save` overwrite 路径先查,id_not_found 错误判定
- **Risk**: 返回完整 MemoryAtom 含 source_session 等
- **Decision**: reuse

### Reuse: MemoryIndex.getActiveAtomByFingerprint
- **Path**: `extensions/personal-assistant/storage.ts:312`
- **Why**: `memory_save` 无 id 时 fingerprint dedup 第一关(沿用 extraction.ts:211 同一调用)
- **Risk**: 内置 `is_latest=1 AND archived=0` filter,假设不变
- **Decision**: reuse

### Reuse: MemoryIndex.deleteVector
- **Path**: `extensions/personal-assistant/storage.ts:827`
- **Why**: overwrite 路径不需要(因为 `updateAtom` 自带 vector 替换,line 200-204)
- **Risk**: N/A — 本变更不使用
- **Decision**: not-used (updateAtom 已处理)

### Reuse: embedText
- **Path**: `extensions/personal-assistant/embed.ts:64`
- **Why**: 唯一 embed 入口,15s timeout,失败返 null。`memory_save` 必须用它以保持失败语义一致
- **Risk**: 假设 15s timeout 足够
- **Decision**: reuse

### Reuse: buildEmbeddableText
- **Path**: `extensions/personal-assistant/embed.ts:150`
- **Why**: 与 `CURRENT_EMBEDDABLE_TEXT_VERSION = 2` 对齐 — embeddable = title + summary + tags(无 content),保持 recall 行为一致
- **Risk**: 假设 embeddable text 形状不变;version bump 走 storage.init 自动 re-index
- **Decision**: reuse

### Reuse: reindexOne
- **Path**: `extensions/personal-assistant/bge-reindex.ts:43`
- **Why**: 让 bge-m3 服务读 .md 重编码 dense + sparse 向量(POST /api/atoms/{id}/reindex)。`memory_save` create / overwrite 都调,与 extraction.ts:156 / 176 / 244 同一调用
- **Risk**: 5s timeout,失败 graceful 返 `{ok:false}` 不抛
- **Decision**: reuse

### Reuse: normalizeTags
- **Path**: `extensions/personal-assistant/tag-alias.ts:23`
- **Why**: tag alias 折叠 + Set 去重。`memory_save` 与 webui PATCH 共用
- **Risk**: alias map 配置缺失时跳过折叠(graceful)
- **Decision**: reuse

### Reuse: recallAtoms
- **Path**: `extensions/personal-assistant/search.ts:171`
- **Why**: 单 query 的 recall 入口,内部调 hybridSearch。`recallPipeline` per-subquery 步骤用它
- **Risk**: 服务不可达 graceful 返 []
- **Decision**: reuse

### Reuse: hybridSearch
- **Path**: `extensions/personal-assistant/hybrid-search.ts:56`
- **Why**: dual-channel RRF POST `/api/search`。`recallAtoms` 内部调用,`recallPipeline` 不直接调
- **Risk**: N/A (透传)
- **Decision**: reuse (transitively via recallAtoms)

### Reuse: rewriteQueries
- **Path**: `extensions/personal-assistant/rewrite.ts:316`
- **Why**: `(query, recent)` → subqueries。`recallPipeline` 必须用它以保持 rewrite 行为一致
- **Risk**: 假设 `recent ?? null` 行为不变(`buildRewritePrompt` line 81 处理 null)
- **Decision**: reuse

### Reuse: rerankAndFilter
- **Path**: `extensions/personal-assistant/rerank.ts:88`
- **Why**: cross-encoder rerank + threshold(0.05) + gap(0.15)。`recallPipeline` per-subquery 步骤用它
- **Risk**: 服务不可达返 `RerankFallback`,`recallPipeline` 必须处理(取 topK 兜底)
- **Decision**: reuse

### Reuse: mergeByRerankScore
- **Path**: `extensions/personal-assistant/merge.ts`
- **Why**: per-subquery 结果去重 + 按 rerankScore DESC 排序。`recallPipeline` 最后一步用它
- **Risk**: 假设排序 key 不变
- **Decision**: reuse

### Reuse: formatMemoryContext
- **Path**: `extensions/personal-assistant/format.ts:60`
- **Why**: TUI 把 recall 结果渲染成 LLM context 注入块。TUI `context` hook 在 `recallPipeline` 之后仍调它
- **Risk**: webui 不用(返回 raw JSON 给前端)
- **Decision**: reuse (TUI only)

### Reuse: supersedeIfSimilar
- **Path**: `extensions/personal-assistant/dedup.ts:18`
- **Why**: webui PATCH `supersedeIfSimilar` 0.65 cosine supersede。**`memory_save` 不调**(避免与 extract 路径不一致)
- **Risk**: webui PATCH 行为不变(回归)
- **Decision**: not-used (webui PATCH 路径独立保留)

### Reuse: extractMemoriesWithCallLlm / runMemoryExtraction
- **Path**: `extensions/personal-assistant/memory.ts:246` re-export,实现在 `extraction.ts`
- **Why**: safety net 跑抽取时仍用同一函数(行为不变,仅触发条件改)
- **Risk**: 无
- **Decision**: reuse

### Reuse: DEFAULT_DB_PATH / DEFAULT_ATOMS_DIR
- **Path**: `extensions/personal-assistant/memory.ts:126, 129`
- **Why**: `memory-save.ts` 启动时 `loadConfig()` 读 `dbPath` / `atomsDir`,fallback 到 default
- **Risk**: 用户自定义路径需 config-driven
- **Decision**: reuse

### Reuse: loadConfig
- **Path**: `extensions/personal-assistant/memory.ts:261`
- **Why**: 读 `~/.pi/agent/settings.json`,graceful fallback `{}`。`memory-save.ts` 启动时调
- **Risk**: 失败返 `{}` 而非抛错,调用方 coalesce
- **Decision**: reuse

### Reuse: notifySafely
- **Path**: `extensions/personal-assistant/memory.ts:137`
- **Why**: ctx.ui.notify 安全包装,safety net 失败时用
- **Risk**: 仅 ctx.ui 提供时调,否则降级 console.warn
- **Decision**: reuse

### Reuse: tools.ts tool_call hook 入口
- **Path**: `extensions/personal-assistant/tools.ts:934`
- **Why**: agent 所有 tool 调用的拦截点;新分支加在 satellite check 之后
- **Risk**: hook 已处理 satellite 工具,新分支不能干扰其 return
- **Decision**: extend (新增分支)

### Reuse: tools.ts before_agent_start system prompt 注入
- **Path**: `extensions/personal-assistant/tools.ts:828`
- **Why**: 每段对话开始注入 system prompt;新增 memory 段落
- **Risk**: 已注入 todowrite planning 段落;memory 段落不能与之冲突
- **Decision**: extend (新增段落)

### Reuse: makeAtomPathRegex (memory.ts:233)
- **Path**: `extensions/personal-assistant/memory.ts:233`
- **Why**: tool_call hook 路径检查用 `isUnderAtomsDir` helper 与其思路一致(regex 匹配 `${atomsDir}/${type}/${uuid}.md`)
- **Risk**: 内置 atom id regex `([0-9a-f-]{36})` 仅匹配 UUID;若 agent 用非 UUID id(overwrite 场景)需放宽
- **Decision**: extend (新 helper,更宽松的 regex 接受任意 isSafeFilename id)

### Reuse: packages/webui/server/routes/memory.ts:registerPostSearch
- **Path**: `packages/webui/server/routes/memory.ts:845`
- **Why**: 当前 webui 入口;改造为内部调 `recallPipeline`,响应 shape 保持兼容
- **Risk**: 响应字段必须保留(`embeddingServiceStatus`, `recallTimeMs` 等)向后兼容
- **Decision**: extend (内部重构,API 不变)

### Reuse: MemoryIndex (constructor + init)
- **Path**: `extensions/personal-assistant/storage.ts:67-126`
- **Why**: `recallPipeline` 需要传入已 init 的 index(TUI 与 webui 各自的 lifecycle 保留)
- **Risk**: caller 负责 close,`recallPipeline` 不管 lifecycle
- **Decision**: reuse

### Invent: memory-save.ts
- **Why**: 没有现成的"agent 显式写 atom"工具,需要新模块统一定义 tool schema + execute 编排 + dedup 调用
- **Risk**: 需在 `registerTools` 中注册,否则 agent 看不到 tool
- **Decision**: invent-new

### Invent: recall.ts (recallPipeline)
- **Why**: TUI 与 webui 重复实现同一段 pipeline,已漂移;需抽出共享 helper 强制一致
- **Risk**: TUI 与 webui 各自的 caller lifecycle 不变(`recallPipeline` 只管核心 pipeline 步骤)
- **Decision**: invent-new

### Invent: isUnderAtomsDir / looksLikeWriteToAtomsDir (path guard helpers)
- **Why**: 没有现成的"路径属于 atoms 目录"判定函数;新 helper 实现
- **Risk**: 路径 resolve 必须正确处理 `~` / 相对路径 / symlink
- **Decision**: invent-new (放 memory-save.ts 旁,或 tools.ts 内部 helper)

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| agent 遗忘 save,关键对话未被记录 | system prompt 显式提醒 + safety net 兜底(count=0 时跑抽取) |
| agent importance 主观性导致 DB 稀释 | tool schema 强制 `importance` 必填,TypeBox min/max 0-1 |
| agent overwrite 不慎覆盖重要 atom | overwrite 路径要求 agent 先 recall 拿到 id(已设计模式);in-place UPDATE 保留 version 链可见 |
| tool_call hook 误伤合法 `read` 已有 atom | hook 仅检查 `write`/`edit`/`bash` 写模式;`read` 路径完全不受限 |
| bash 命令解析不够 robust 漏过某些 heredoc 写法 | 第一版覆盖最常见模式 (`>`, `>>`, `tee`);后续可加强解析 |
| safety net 触发条件简单 (`>=1`) 长期可能不精准 | 第一版 ship,数据驱动调优 |
| embedding 服务长期 down → 新 atom 全 zero vector,recall 退化 | `reindexOne` 仍调,让 bge-m3 服务读 .md 产出真实 sparse channel 向量;sparse 兜底 |
| agent 用 overwrite 把别人写的 atom 覆盖掉 | overwrite 不区分 owner,任何 agent save 都能 overwrite;无 audit;trade-off 接受(单 user 系统) |
| TUI 与 webui 共享 `recallPipeline` 后,任意一边的状态泄漏给另一边 | helper 是 pure function,只接受显式 `index` + `opts`,不持有 module-level state;caller 各自管 lifecycle |
| webui 默认 `topK` 从 10 改 20 → 部分 webui 调用结果集变大,前端渲染变慢 | 渐进:先 ship helper + 强制 topK=20 默认;后续根据 webui MemorySearchTester 表现调 |
| `recent` 字段 API 新增 → 旧 webui 客户端不传(默认 null) | `req.body.recent` 缺失走 null 路径,与 webui 当前行为一致(无回归) |

## Testing Strategy

### 单元测试 (`test/memory-save-tool.test.ts`)

| Case | Given | When | Then |
|------|-------|------|------|
| create, fingerprint miss | DB 空 | `memory_save({...})` 无 id | `{action:"created", id}`;DB 1 row; .md 已写; reindexOne 调 |
| create, fingerprint hit | DB 有相同 fp | `memory_save({...})` 无 id | `{action:"skipped", reason:"duplicate_content", existing_id}`;DB 不变 |
| overwrite, id exists | DB 有 atom a-123 | `memory_save({id:"a-123", content:"new", ...})` | `{action:"updated", id:"a-123"}`;旧 .md 覆盖;vector 重 embed |
| overwrite, id not found | DB 无 a-ghost | `memory_save({id:"a-ghost", ...})` | `{action:"error", error:"id_not_found"}` |
| embedding down | ollama ECONNREFUSED | `memory_save({...})` | `{action:"created", embedding:"skipped"}`;DB 1 row, vector = zero |
| invalid type | — | `memory_save({type:"opinion", ...})` | `{action:"error", error:"invalid_type"}` |
| content too short | — | `memory_save({content:"x", ...})` | `{action:"error", error:"content_too_short"}` |
| safety net skip | segment 已调 1 次 memory_save | compact 触发 | safety net 跳过 |
| safety net run | segment 0 次 save | compact 触发 | runCompactExtraction 跑 |
| safety net graceful | 抽取失败 | compact 触发 | notify warn + compact continue |

### 单元测试 (`test/recall-pipeline.test.ts`)

| Case | Given | When | Then |
|------|-------|------|------|
| TUI 调用,recent 有内容 | mock index + rewrite + recall + rerank | `recallPipeline(index, {query, recent: ["msg1", "msg2"], topK: 20})` | rewriteQueries 收到 recent;pipeline 步骤顺序与原 inline 一致 |
| webui 调用,recent null | 同上 | `recallPipeline(index, {query, recent: null, topK: 20})` | rewriteQueries 收到 null;pipeline 行为相同 |
| topK 默认 | — | `recallPipeline(index, {query, recent: null})` 不传 topK | 内部用 20,与 TUI 默认一致 |
| topK clamp | — | `recallPipeline(index, {query, topK: 200})` | clamp 到 100 |
| embedding service down | mock hybridSearch 返 [] | `recallPipeline(...)` | results: [], status.embeddingServiceStatus: "down"(webui probe 模式) |
| rerank fallback | mock rerankAndFilter 返 RerankFallback | `recallPipeline(...)` | pool 降级用 fallback topK,results 不空 |

### 集成测试 (webui)

- `tool_call` hook mock:agent 调 `write({path:"~/.pi/agent/memory/atoms/process/foo.md"})` → block error
- bash heredoc mock:`bash({command:"cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF ..."})` → block
- `read` 不被 hook 拦截
- webui `/api/memory/search` 响应字段向后兼容(`embeddingServiceStatus`, `recallTimeMs`, etc.)
- webui 请求 `recent` 字段缺失 → `recallPipeline` 用 null

### 回归

- 现有 webui `PATCH /api/memory/:id`(`supersedeIfSimilar` + `updateAtomIfVersion`)行为不变
- 现有 `session_before_compact` 抽取流程行为不变(仅触发条件与失败处理变)
- 现有 `search.ts:recallAtoms` / `hybridSearch` / `bge-reindex` / `drift-sweep` 不变
- 现有 `tool_result` hook 不变
- 现有 `context` hook 在 gate 决策、rewriteEnabled 处理、formatMemoryContext、inject user msg 等步骤不变(仅 inline pipeline 部分被 `recallPipeline` 替换)

## Implementation Notes

### 任务依赖顺序

1. **recall.ts** (recallPipeline shared helper) — 基座,被 TUI 与 webui 都调
2. **memory-save.ts** (tool 定义 + 三 outcome 编排) — 独立模块,只依赖 storage/embed/file-store/bge-reindex
3. **tools.ts** 注册 `memory_save` + 路径拦截分支 + system prompt 段 — 依赖 memory-save.ts 与 recall.ts
4. **memory.ts** safety net + segment counter + `before_agent_start` reset — 依赖 memory-save.ts 的 module-level counter(通过命名导出 `getSegmentMemorySaveCount`)
5. **webui routes/memory.ts** 改造 `registerPostSearch` 调 `recallPipeline` — 依赖 recall.ts
6. 测试:memory-save 6 case + recall-pipeline 5 case + 集成 4 case

### counter 共享模式

`segmentMemorySaveCount` 放 `memory-save.ts` module-level,与现有 `tools.ts:todoItems` 同 pattern。`memory-save.ts` 导出 `incrementSegmentMemorySaveCount()` 和 `getSegmentMemorySaveCount()`。`memory.ts` 的 `session_before_compact` 读 `getSegmentMemorySaveCount()`;`memory.ts` 的 `before_agent_start` 调一个 `resetSegmentMemorySaveCount()`(从 memory-save 模块导出)。

### cosine 阈值对比 — 不适用

旧的 design.md 提到"0.65 vs 0.92"对比。**本变更不涉及 cosine 决策**:`memory_save` 走 fingerprint + LLM oldId(与 extract 一致),不引入 cosine gate;webui PATCH `supersedeIfSimilar` 的 0.65 阈值不变。两条路径完全不同,无对比意义。

### 文件改动清单

| 路径 | 动作 | 行数估计 |
|------|------|----------|
| `extensions/personal-assistant/memory-save.ts` | 新建 | ~180 |
| `extensions/personal-assistant/recall.ts` | 新建 | ~120 |
| `extensions/personal-assistant/tools.ts` | 改 (register + hook + prompt) | +80 |
| `extensions/personal-assistant/memory.ts` | 改 (safety net + counter reset) | +25 -10 |
| `packages/webui/server/routes/memory.ts` | 改 (调 recallPipeline, 响应 shape 不变) | -50 +30 |
| `packages/webui/server/test/memory-routes.test.ts` | 改 (新增 recent / topK 默认 test) | +40 |
| `extensions/personal-assistant/test/memory-save-tool.test.ts` | 新建 | ~250 |
| `extensions/personal-assistant/test/recall-pipeline.test.ts` | 新建 | ~180 |

合计 ~880 行新增/改动。

### 验证 checklist (sdd-review 阶段执行)

- [ ] npm run check 全绿
- [ ] memory-save-tool 单元测试 6 case 全过
- [ ] recall-pipeline 单元测试 5 case 全过
- [ ] 集成测试 4 case 全过
- [ ] 现有 webui PATCH 测试(`packages/webui/server/test/memory-routes.test.ts`)全过(回归)
- [ ] 现有 extraction 测试(`extensions/personal-assistant/test/extraction*.test.ts`)全过(回归)
- [ ] 手工 smoke:agent 调 `memory_save` 三种 outcome 各一次,UI 显示 ok
- [ ] 手工 smoke:agent 试图 `write` atom 文件,UI 显示 block error
- [ ] 手工 smoke:整段 0 save,compact 触发后 ctx.ui.notify 显示 extraction 进度
- [ ] 手工 smoke:TUI 与 webui 同 query 召回,rrf 排序一致(recent 字段差异除外)