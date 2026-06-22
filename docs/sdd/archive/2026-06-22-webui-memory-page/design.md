# Design: webui-memory-page

## Context

Personal-assistant 扩展（`extensions/personal-assistant/memory.ts`）已经实现了一套
完整的 Agent 记忆机制：

- 被动注入：每次 `before_agent_start` 触发 LLM `rewriteQuery` + FTS5 + embedding
  混合召回，命中后注入 `<memory-context>` XML 到 system prompt
- 主动抽取：compaction 触发 `extractMemories` 走 LLM 读对话输出 `ExtractionPlan`，
  create / update / skip 三种动作
- 衰减：`runDecay` 用 `λ = baseDecay * (1 - importance)` 指数衰减 non-constraint
  atom 的 strength，跌破 `archive_threshold` 自动归档
- 存储：SQLite `memory.db`（`memory_index` + `memory_fts` FTS5 虚拟表 +
  `memory_embeddings`）+ `~/.pi/agent/data/memory/atoms/<type>/<slug>.md` 文档正文
  按 `content_hash` 寻址

这套机制对 Agent 是闭环的，但用户侧完全黑盒：看不到存了什么、调试不了召回、不能
修正 LLM 抽错的 atom。当前 webui server（`packages/webui/server/`）已经在用
`runMemoryExtraction`（仅暴露给 `DELETE /api/sessions/:id`），但 `MemoryIndex`
类本身和 `searchAtoms` / `rewriteQuery` / `writeAtomToFile` 三个函数都没 export，
server 端拿不到 memory 层的读 / 写 API。

这个变更在 webui 加一个 `/memory` 页面，让用户能 **浏览 / 召回测试 / 编辑 / 归档**
记忆，并把 `MemoryIndex` 升级为 public API 让 server 直接复用。

## Goals / Non-Goals

### Goals
- 浏览所有 atom（按 type / tag / archived 过滤，free-text 搜 title）
- 查看 atom 完整详情（DB 元数据 + 文档正文）
- 编辑 metadata 任意字段（title / type / importance / tags / summary）+ body（content），
  3s debounce 自动 PATCH，路由离开时强制 flush
- 归档 / 取消归档（toggle，不走 debounce）
- 召回测试：调真实 `rewriteQuery` + `searchAtoms`，展示 keywords / target_types /
  每条 fts / cosine / hybrid 分数
- `MemoryIndex` 升级为 extension 包的 public export

### Non-Goals（v1）
- Create / delete atom（避免污染 LLM 抽取质量判断）
- 编辑后立即重算 embedding（v2 lazy recompute）
- TUI ↔ webui 实时同步（v1 3s 轮询 + 手动 refresh）
- 版本历史 / 审计日志
- Bulk 操作
- `$EDITOR` 集成（v1 用内置 textarea + preview tab）

## Decisions

### 1. 从 `memory.ts` export 公共 API + 几个新 helper
**Decision**: `memory.ts` 加以下 export；`index.ts` re-export：

- `class MemoryIndex`（原 line 416 非 export → export）
- `interface MemoryAtom`（原 line 35 非 export → export，server 端需要 type API 响应）
- `type MemoryAtomType`（原 line 26 非 export → export，server 端 chip / select 控件要 type）
- `function writeAtomToFile(atom, baseDir?)`（原 line 728 非 export → export）
- `function rewriteQuery(query, ctx, config)`（原 line 786 非 export → export，
  in-process 路径继续用）
- `function searchAtoms(index, query, topK)`（原 line 970 非 export → export，
  in-process 路径继续用）
- `function rewriteQueryWithCallLlm(callLlm, query, config)`：**新增**，
  给 webui server 用。内部走和 `rewriteQuery` 一样的 prompt，但用 `callLlm` 回调
  而不是 `ctx.modelRegistry`（server 没有 ExtensionContext）
- `function searchAtomsWithScores(index, query, topK)`：**新增**，返回
  `Array<{atom, fts_score, cosine_score, hybrid_score}>` 而不是
  `MemoryAtom[]`，让 recall 测试 UI 能展示分项分数
- `function getAllAtoms(index)`：**新增**，返回所有 atom（含 archived）；
  现有 `getActiveAtoms()` 只返回 `archived=0`，`getAllRows()` 返回未转换的
  DB row。list endpoint 的"含归档"过滤需要这个
- `const ATOMS_DIR` / `const MEMORY_DB_PATH`（原 line 134-135 私有 const → 改 export const；
  server 端 PATCH handler 需要知道 atoms 写哪里）
- `function defaultAtomsDir()`（**新增**，等价于 `ATOMS_DIR`，但走函数形式便于测试时 stub）

Webui server 通过 `@earendil-works/pi-personal-assistant`（tsconfig path mapping
指向 `extensions/personal-assistant/index.ts`）直接 import。

**Rationale**: webui server 已经在用 `runMemoryExtraction`，证明这个 import 路径
能跑通。重复实现一份 SQLite 读 / 写逻辑会让两个文件漂移（schema 升级、文件 hash
算法变化都得改两边）。`runMemoryExtraction` 已经示范了"用 `callLlm` 回调绕开
`ExtensionContext`"的模式，`rewriteQueryWithCallLlm` 走同一套约定。

**Alternatives considered**:
- 在 webui/server 里重写一份 read 逻辑 — 拒绝，违反 DRY，schema 漂移风险
- 把 `MemoryIndex` 抽到独立的 `@pi-mono/memory-store` 包 — 拒绝，单 repo 里多一个
  package.json 的开销大于收益，extension 自己的内存模块自己 export 即可
- 在 server 端构造一个 stub `ExtensionContext`（带假 `modelRegistry`） — 拒绝，
  `modelRegistry` 接口大且和 session 生命周期绑定，stub 容易跑偏；用 callback
  形式更直接

### 2. Server 每个 request 起一个新 `MemoryIndex` 实例
**Decision**: 不在 `createApp` 时 cache 一个全局 `MemoryIndex`，每个 route handler
自己 `new MemoryIndex(dbPath)` + `init()` + 处理 + `close()`。

**Rationale**: `node:sqlite` 是同步 API，open+close 单次 < 1ms；webui route 并发量
低（用户主动操作），无谓起单例管理生命周期；单例在 reload 扩展、`MemoryIndex` 改
schema 等场景下要写额外 cleanup。

**Alternatives considered**:
- 单例 + 启动时打开 — 拒绝，多了"启动失败"和"shutdown 关闭"两条出错路径
- 池化 — 拒绝，over-engineering

### 3. Edit 用 3s debounce + 路由 unmount 强制 flush
**Decision**: 用户在 metadata form / body editor 任意字段变更后起一个 3s timer，
3s 内无新变更触发 `PATCH`。组件 unmount 时取消 timer 并 await in-flight PATCH
完成（带 200ms 兜底超时防止后端挂死时页面卡住）。

**Rationale**: 用户在 4s 决策窗内连续改 5 个字段，只发 1 个 PATCH 包含全量变更。
3s 是"用户已经停下来思考"的合理下界（之前选项 1.5s 用户嫌短）；flush 保证路由切换
不丢输入。

**Alternatives considered**:
- 1.5s debounce — 拒绝，用户反馈太短
- 失焦 / Cmd+Enter 提交 — 拒绝，metadata 字段没有"提交"概念，体感割裂
- 实时 keystroke commit — 拒绝，写库压力、FTS 重建
- 仅失焦，无 debounce — 拒绝，连续改 5 个字段 5 次请求

### 4. Body 编辑后只清 embedding，不立即重算
**Decision**: PATCH 改 `content` 触发 `.md` 重写 + FTS 重建；`memory_embeddings`
行 `DELETE`，不调 `getEmbedding` 重算。下次 `searchAtoms` 走这条 atom 时按现
有逻辑：`getEmbeddings(candidateIds)` 拿不到 → 走纯 FTS 分支，下次访问 / 重启
时不阻塞。

**Rationale**: embedding 算一次 ~1-5s（Ollama 本地），编辑页面不应该让用户等
embedding 算完才能继续编辑。Stale embedding 不影响 FTS 命中，hybrid score 在
embedding 缺失时退化为 0，但 FTS 部分照常工作。后续 v2 加后台 worker 批量重算。

**Alternatives considered**:
- PATCH 同步重算 embedding — 拒绝，UI 卡 1-5s
- 后台 worker — v2，v1 不做

### 5. PATCH 复用 `writeAtomToFile` 做 .md 写，行为对齐
**Decision**: PATCH handler **直接调 `writeAtomToFile(merged, atomsDir)`**（不要
自己重写 frontmatter 序列化）。`writeAtomToFile` 内部已经做了：
- `ensureDir(atomsDir/<type>)`
- `slugify(title)` → `filePath = atomsDir/<type>/<slug>.md`
- 渲染 frontmatter（13 个固定字段，固定顺序：id/type/title/summary/tags/
  importance/strength/access_count/last_access/created_at/updated_at/version/archived）
- `body = atom.content || atom.summary`
- `content = frontmatter + "\n\n" + body + "\n"`
- 原子写：`tmpPath = filePath + ".tmp"` → `writeFileSync` → `renameSync`（跨平台原子）
- 算 `sha256(content)` 返回 `{filePath, contentHash}`

PATCH handler 拿到 `{filePath, contentHash}` 后：
- 若 `filePath !== existing.file_path` → `unlinkSync(existing.file_path)`（删旧）
- `upsertAtom(merged)` 更新 DB
- `DELETE FROM memory_embeddings WHERE id = ?` 清 stale embedding

**Rationale**: 复用 = 不漂移。如果我们自己重写 frontmatter，将来 `memory.ts` 加
字段（比如加个 `confidence` 字段）时 webui PATCH 会写缺字段的 .md，下游
`readAtomFromFile` 解析照样能跑（frontmatter 解析容错）但数据会丢。复用是
单源真相。

**已知 bug（不在本变更范围）**：`writeAtomToFile` 的路径生成只有
`slugify(title).md`，**没 id 兜底**——两个 atom 同一 title 会被写同一文件，
后写者覆盖前写者。`slugify` 对非 ASCII title 用 MD5 前 8 位，碰撞概率极低
但非零。这次 v1 不修，记入"已知问题"，等真正撞了再说。

**Alternatives considered**:
- 自己重写 frontmatter 序列化 — 拒绝，违反 DRY，将来加字段会漂移
- 永远覆盖同一文件 — 拒绝，违反现有 content-hash addressing 约定

### 6. FTS 重建仅在 `title` 或 `tags` 变时执行
**Decision**: `upsertAtom` 内部已经 `DELETE FROM memory_fts WHERE id = ?` +
`INSERT INTO memory_fts`。所有 PATCH 都走 `upsertAtom`，所以这条是无条件执行
的——只是成本可忽略（O(1)）。v1 不做"title 没变就跳过 FTS"这种优化。

**Rationale**: 简单。FTS 单行 `INSERT` < 1ms，没必要为它增加 diff 逻辑。

### 7. Recall 测试走真实 `rewriteQueryWithCallLlm` + `searchAtomsWithScores`
**Decision**: server 端 `POST /api/memory/search` 调
`rewriteQueryWithCallLlm(deps.callLlm, query, settings)` + 
`searchAtomsWithScores(index, rewritten, topK)`，返回：

```typescript
{
  rewritten: { keywords: string[]; target_types: string[]; raw_query: string },
  embedding_available: boolean,  // false 表示走了纯 FTS 分支
  results: Array<{
    atom: MemoryAtom,
    fts_score: number,
    cosine_score: number,
    hybrid_score: number,
  }>
}
```

**Rationale**: 真实 pipeline 才能让用户复现"Agent 这次注入的就是这批结果"。
但 `rewriteQuery` 强依赖 `ExtensionContext.modelRegistry`，server 端拿不到
——所以新增 `rewriteQueryWithCallLlm` 用 callback 形式绕开（和
`runMemoryExtraction` 走的 `callLlm` 同一套约定）。`searchAtomsWithScores` 是
新函数，返回分项分数让 UI 能 hover 展示。

`embedding_available` 标志：现有 `searchEmbeddings`（line 933-968）只在
`embConfig.provider === "local"` 时尝试调 Ollama，否则直接返回空 Map
→ 走纯 FTS 分支。我们把这个判断结果显式透传给前端，避免 UI 把"无 embedding"
的纯 FTS 命中误标成"hybrid score 0"。

**Alternatives considered**:
- 直接调 `rewriteQuery` + 在 server 端 stub `ExtensionContext` — 拒绝，
  `modelRegistry` 接口大且依赖 session 状态，stub 易跑偏
- 纯 FTS 测试 — 拒绝，丢 LLM 改写步骤
- 两种都给，UI 可切换 — 拒绝，YAGNI

### 8. v1 不做 create / delete atom
**Decision**: 不暴露 `POST /api/memory` 和 `DELETE /api/memory/:id`。
"删除"用 `POST /api/memory/:id/archive {archived: true}` 替代（DB 行仍在，
list 默认过滤掉）。

**Rationale**: 手动 create 出来的 atom 没经过 LLM extraction 的"context
judgment"过程，会污染模型对"用户偏好"的判断（"我手动建了 100 条，模型觉得
用户偏好什么"）。归档是 v1 唯一的"软删除"。

### 9. 3s 轮询拉新（不 WebSocket）
**Decision**: 详情页打开后每 3s 触发一次 `GET /api/memory/:id` 拉新（只在
`/memory` 路由 active 时）；list 打开时每 3s 拉一次 `GET /api/memory`。TUI /
后台抽取在另一端写 DB，webui 这边轮询感知。

**Rationale**: v1 不引入 WebSocket——webui server 已有 WS 但只用于 session
events，扩展到 memory 流需要新协议 / 新 client handler，复杂度不匹配 v1 范围。
3s 轮询对 100 atom 量级 list < 50ms，完全可接受。

## Architecture

### 组件图

```
┌────────────────────────────────────────────────────────────────────────┐
│ web/src/pages/MemoryPage.tsx                                           │
│ ┌────────────────┬───────────────────────────────────────────────────┐ │
│ │ MemoryList     │ MemoryDetail (split)                              │ │
│ │ ┌────────────┐ │ ┌───────────────────────────────────────────────┐ │ │
│ │ │ type 过滤  │ │ │ MemoryEditor (top: metadata form)             │ │ │
│ │ │ tag 过滤   │ │ │  • title input                                │ │ │
│ │ │ 搜 title   │ │ │  • type select                                │ │ │
│ │ │ archived ▢ │ │ │  • importance slider                           │ │ │
│ │ ├────────────┤ │ │  • tags chip input                            │ │ │
│ │ │ atom 卡片  │ │ │  • summary textarea                            │ │ │
│ │ │ ...        │ │ ├───────────────────────────────────────────────┤ │ │
│ │ │            │ │ │ MemoryEditor (bottom: body editor)            │ │ │
│ │ │            │ │ │  • [Edit] [Preview] tab                       │ │ │
│ │ │            │ │ │  • textarea (debounce 3s) OR Markdown render   │ │ │
│ │ │            │ │ │  • header: Saving… / Saved Ns ago / error     │ │ │
│ │ │            │ │ │  • [Archive] [Restore] button                 │ │ │
│ │ └────────────┘ │ └───────────────────────────────────────────────┘ │ │
│ ├────────────────┴───────────────────────────────────────────────────┤ │
│ │ MemorySearchTester (bottom collapsible panel)                      │ │
│ │  [query input  ] [Search]                                          │ │
│ │  keywords: [chip] [chip]  target_types: [chip]                    │ │
│ │  results:                                                          │ │
│ │   [1] fts=.8 cos=.6 → "title..."   hover → {fts,cos,hybrid,...}   │ │
│ │   [2] ...                                                          │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
         │                          │                          │
         │ HTTP                     │ HTTP                     │ HTTP
         ▼                          ▼                          ▼
GET /api/memory?type=...&q=...  GET /api/memory/:id         POST /api/memory/search
PATCH /api/memory/:id           POST .../archive            {query, topK}
         │                          │                          │
         └──────────────────────────┼──────────────────────────┘
                                    ▼
                server/routes/memory.ts (mountMemoryRoutes)
                ┌────────────────────────────────────────────┐
                │ for each request:                          │
                │   idx = new MemoryIndex(MEMORY_DB_PATH)    │
                │   await idx.init()                         │
                │   try { ... } finally { idx.close() }     │
                └────────────────────────────────────────────┘
                                    │
                                    ▼
                @earendil-works/pi-personal-assistant
                (extensions/personal-assistant/)
                ├─ MemoryIndex class (NEW: export)
                ├─ searchAtoms / rewriteQuery / writeAtomToFile (NEW: export)
                └─ 现有 runMemoryExtraction / PersonalAssistantConfig
                                    │
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
        ~/.pi/agent/data/memory.db                ~/.pi/agent/data/memory/atoms/
        (SQLite: memory_index, memory_fts,        <type>/<id>.md (frontmatter + body)
         memory_embeddings)                       content-hash addressed
```

### 关键接口（pseudo-code）

**Server route handler**（`packages/webui/server/routes/memory.ts`）：

```typescript
mountMemoryRoutes(app, deps: {
  dbPath: string;                 // MEMORY_DB_PATH
  atomsDir: string;               // ATOMS_DIR
  settings: PersonalAssistantConfig;
  callLlm: (prompt: string) => Promise<string>;  // 已有, webui server 起服务时构造
}) {
  // GET /api/memory?type=&archived=&tag=&q=&limit=&offset=
  // archived: "active"(默认) | "archived" | "all"
  app.get("/api/memory", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const all = getAllAtoms(idx);
      const archivedMode = String(req.query.archived ?? "active");
      const filtered = archivedMode === "all"
        ? all
        : all.filter((a) => archivedMode === "archived" ? a.archived : !a.archived);
      const sliced = applyFilters(filtered, req.query);   // type/tag/q/limit/offset
      res.json(sliced.map(toClientAtom));
    } finally { idx.close(); }
  });

  // GET /api/memory/:id — 读 .md 正文
  app.get("/api/memory/:id", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atom = idx.getAtom(req.params.id);
      if (!atom) return res.status(404).json({ error: "not found" });
      if (atom.file_path) {
        try {
          const fromFile = readAtomFromFile(atom.file_path, atom.content_hash);
          if (fromFile) atom.content = fromFile.content;
        } catch { /* 丢失 / hash 错位 → content:"" UI 标 <memory-error> */ }
      }
      res.json(atom);
    } finally { idx.close(); }
  });

  // PATCH /api/memory/:id  body: Partial<MemoryAtom>
  app.patch("/api/memory/:id", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const existing = idx.getAtom(req.params.id);
      if (!existing) return res.status(404).json({ error: "not found" });

      // 从磁盘读当前 body,作为未提供 content 时的兜底
      let currentBody = "";
      if (existing.file_path) {
        try {
          const fromFile = readAtomFromFile(existing.file_path, existing.content_hash);
          currentBody = fromFile?.content ?? "";
        } catch { /* 丢失 / hash 错位, 走空 body */ }
      }

      const merged: MemoryAtom = {
        ...existing,
        ...req.body,
        content: req.body.content ?? currentBody,   // client 显式提供才覆盖
        version: existing.version + 1,
        updated_at: nowISO(),
      };

      // 复用 writeAtomToFile — 同样的 frontmatter 序列化、原子写 (tmp+rename)
      const { filePath: newPath, contentHash: newHash } = writeAtomToFile(merged, deps.atomsDir);
      if (existing.file_path && existing.file_path !== newPath) {
        unlinkSync(existing.file_path);
      }
      merged.file_path = newPath;
      merged.content_hash = newHash;

      idx.upsertAtom(merged);
      // 清掉旧 embedding (v1 不立即重算, 下次访问走 lazy recompute)
      idx.getDb().prepare("DELETE FROM memory_embeddings WHERE id = ?").run(merged.id);

      res.json(merged);
    } finally { idx.close(); }
  });

  // POST /api/memory/:id/archive  body: {archived: boolean}
  app.post("/api/memory/:id/archive", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atom = idx.getAtom(req.params.id);
      if (!atom) return res.status(404).json({ error: "not found" });
      if (req.body.archived) {
        idx.markArchived(atom.id);
      } else {
        // restore: archived=0, version+1, updated_at=now; 复用 upsertAtom
        idx.upsertAtom({ ...atom, archived: false, version: atom.version + 1, updated_at: nowISO() });
      }
      res.json({ ok: true, atom: idx.getAtom(atom.id) });
    } finally { idx.close(); }
  });

  // POST /api/memory/search  body: {query, topK}
  app.post("/api/memory/search", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const rewritten = await rewriteQueryWithCallLlm(deps.callLlm, req.body.query, deps.settings);
      const { results, embedding_available } = await searchAtomsWithScores(idx, rewritten, req.body.topK ?? 10);
      res.json({ rewritten, embedding_available, results });
    } finally { idx.close(); }
  });

  // GET /api/memory/stats
  app.get("/api/memory/stats", async (_req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const all = getAllAtoms(idx);
      const byType: Record<string, number> = {};
      let archivedCount = 0;
      for (const a of all) {
        byType[a.type] = (byType[a.type] ?? 0) + 1;
        if (a.archived) archivedCount++;
      }
      res.json({ total: all.length, archived: archivedCount, byType });
    } finally { idx.close(); }
  });
}
```

**Client auto-save hook**（`packages/webui/web/src/lib/useAutoSave.ts`）：

```typescript
function useAutoSave<T>(value: T, save: (v: T) => Promise<void>, delay = 3000) {
  const [state, setState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(value);

  // Track changes
  useEffect(() => {
    if (value === lastSaved.current) return;
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setState("saving");
      try {
        await save(value);
        lastSaved.current = value;
        setState("saved");
        setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1500);
      } catch {
        setState("error");
      }
    }, delay);
  }, [value, save, delay]);

  // Flush on unmount
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      if (value !== lastSaved.current) {
        // Synchronous-best-effort: fire and await up to 200ms
        const flush = save(value);
        inFlight.current = flush;
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { state, flush: () => save(value) };
}
```

### 数据流

**打开详情**: `MemoryList` click → `setSelectedId(id)` → `MemoryDetail` 调
`GET /api/memory/:id` → 渲染 metadata form + body editor (preview tab)

**编辑 metadata**: input onChange → local state `patch` → `<MemoryEditor>` 把
`patchedAtom` 传给 `useAutoSave` → 3s 静默 → `PATCH /api/memory/:id {partial}` →
server merge + upsertAtom + 清 embedding → 200 → client 标 "Saved"

**编辑 body**: body editor onChange → local state `patch.content` → debounce 3s →
`PATCH /api/memory/:id {content: "new body"}` → server: read existing frontmatter
from DB → 渲染 full text → 算 hash → 写新 / 删旧 / upsertAtom → 200

**归档**: 点 `Archive` → 立即（不走 debounce）`POST /api/memory/:id/archive
{archived: true}` → server `markArchived(id)` → 200 → client 切到 list 状态

**Recall 测试**: 输 query → 点 Search → `POST /api/memory/search {query, topK}` →
server: `rewriteQuery` → `searchAtoms` → 返回 `{rewritten, atoms[]}` → 渲染

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| `MemoryIndex` 改 schema（如加列）会同时影响 webui route | schema migration 在 `init()` 里用 `try { ALTER ... } catch {}` 模式（现有 `memory.ts:464-466` 已采用），webui 复用同一份 init，无新风险 |
| webui 用户编辑和 TUI 后台抽取并发写 | SQLite 串行化，last writer wins；前端 3s 轮询会感知到；不做 OT / CRDT |
| LLM `rewriteQuery` 在 recall 测试中调用慢（2-5s） | UI 显式 "Searching…" 状态；fallback 到 `simpleKeywordExtraction` 永远 < 100ms |
| 路由切换 flush 时 PATCH 仍在 in-flight，组件已 unmount | 用 ref 持有 promise，async cleanup 函数 await 一下（带 200ms 兜底超时） |
| 极端大 DB（10k+ atom）时 list 慢 | v1 不做虚拟列表（react-virtuoso 之类的）；先做简单列表 + 限制 `limit=200`；超量时分页 + 警告。v2 评估虚拟列表 |
| **已知 bug**：`writeAtomToFile` 路径生成只有 `slugify(title)`，两个 atom 同一 title 互相覆盖 | 不在 v1 修，记入"已知问题"，v2 加 id 兜底后缀；webui 侧不引入新风险（复用现有行为） |
| 编辑期间后端挂死，flush 永远 await | cleanup 200ms 兜底超时 + ref 标志位 setState 防止内存泄漏 |
| `MemoryIndex` class 现在 export 后，外部代码能改 `db` 等私有字段 | class fields `private` 是 TS 编译期，运行时仍可访问；但只在 webui server 内部用，不暴露给 client |

## Testing Strategy

### 单元测试（`packages/webui/server/test/memory-routes.test.ts`）
- `GET /api/memory` 空 DB 返回 `[]`
- `GET /api/memory?type=preference` 过滤正确
- `GET /api/memory?archived=all` 含归档；`archived=archived` 只列已归档
- `GET /api/memory/:id` 存在返回 atom，不存在 404
- `GET /api/memory/:id` file 丢失时 `content: ""` + 不抛
- `GET /api/memory/:id` file hash 错位时 `content: ""` + 不抛（与 file 丢失同一处理）
- `PATCH /api/memory/:id` 改 title → DB 更新 + FTS 重建（DELETE+INSERT memory_fts 行）
- `PATCH /api/memory/:id` 改 content → `.md` 重写、hash 变、file_path 可能变
  （title 变则 path 变）、旧 .md 被 unlink
- `PATCH /api/memory/:id` 不传 `content` 字段 → 文件 body 保持不变（`currentBody` 兜底）
- `PATCH /api/memory/:id` 改 importance 边界值 0/1 接受
- `PATCH /api/memory/:id` 改 type → file_path 跟着变（`atomsDir/<newType>/<slug>.md`）
- `POST /api/memory/:id/archive {archived:true}` → `archived=1`，GET 列表默认不显示
- `POST /api/memory/:id/archive {archived:false}` → `archived=0`，version+1
- `POST /api/memory/search` 真实 pipeline 召回至少一条（mock `callLlm` 返回
  `{"keywords":["x"],"target_types":["preference"]}`）
- `POST /api/memory/search` `callLlm` 抛错 → 降级 `simpleKeywordExtraction`，200 正常返回
- `GET /api/memory/stats` 正确按 type 分类计数 + archived 单独数

### `memory.ts` 新增函数单测（`extensions/personal-assistant/test/memory-exports.test.ts`）
- `getAllAtoms(idx)` 返回含 archived 的全量
- `rewriteQueryWithCallLlm(callLlm, q, config)` 调 `callLlm` 拿 LLM rewrite
- `rewriteQueryWithCallLlm` LLM 抛错时降级 `simpleKeywordExtraction`
- `searchAtomsWithScores(idx, q, k)` 返回 `{results, embedding_available}` 形状
- `searchAtomsWithScores` 0 embedding 时 `embedding_available: false`、纯 FTS 分支
- `MemoryIndex.invalidateEmbedding(id)` 删除对应行
- `writeAtomToFile(atom, baseDir)` 接受自定义 baseDir，写到指定位置
- `writeAtomToFile` 在已存在文件时 tmp+rename 覆盖（不报错）

### 集成测试
- 端到端 PATCH：起真 SQLite + 真 `.md` 文件 → 改 content → 验证 .md 物理文件
  内容更新 + DB `content_hash` 更新 + `memory_embeddings` 行被清
- `runMemoryExtraction`（已有，删除 session 时用）继续工作，regression test

### 边界条件
- 0 atom 列表
- 1 atom 列表
- 50KB body
- tags 空数组
- importance = 0 / 1
- type 改成 constraint 后 `runDecay` 跳过
- 路由快速切换闪入闪出
- 同 title 两 atom 触发 slug 冲突（已知 bug，验证 v1 行为：后写者覆盖前写者 + UI 标 memory-error）

### 客户端组件测试
- `MemoryTypeBadge` 颜色映射正确
- `MemoryList` filter 逻辑（mock api）
- `useAutoSave` debounce 触发、flush 触发、error 状态
- `useAutoSave` cleanup 200ms 兜底超时（mock save 永远 pending）

## Implementation Notes

### 任务依赖顺序（建议 sdd-write_plan 时遵循）
1. **后端先行**：`extensions/personal-assistant/memory.ts` 加 export → `index.ts`
   re-export → `packages/webui/server/routes/memory.ts` → `mountMemoryRoutes` 接入
   `createApp` → server 单测通过。这一步给前端一个稳定 API
2. **客户端 API client**：`packages/webui/web/src/lib/api.ts` 新增 `memory.*`
3. **底部往上做组件**：`MemoryTypeBadge` → `MemoryList` → `MemorySearchTester` →
   `MemoryDetail` + `MemoryEditor`（包含 `useAutoSave` hook）→ `MemoryPage` 装配
4. **入口接入**：`AppShell.tsx` 加 Memory icon → `App.tsx` / `main.tsx` 加路由
5. **回归测试**：确认现有 8 个 endpoint + `createApp` mount 顺序不变

### 注意点
- **`MemoryIndex` 还需要新增 `invalidateEmbedding(id)` public 方法**：PATCH handler
  要清掉旧 embedding，但 `db` 是 private（line 417）外部拿不到。要么 export
  `getDb()` 暴露底层 `Database` 引用（破坏封装），要么新加一个
  `invalidateEmbedding(id: string): void` 方法直接做 `DELETE FROM memory_embeddings
  WHERE id = ?`（封装、行为明确）。**选后者**。这条加到 Decision 1 的 export 列表
- **`rewriteQueryWithCallLlm` 内部逻辑**：`rewriteQuery`（line 786-840）实际是
  "有 model 就调 LLM，失败降级 `simpleKeywordExtraction`"。新函数 `rewriteQueryWithCallLlm`
  把 LLM 调用替换成 `deps.callLlm(prompt)`，其它流程（配置读取、降级路径、返回
  `QueryRewriteResult` 形状）完全相同。具体：检查
  `config.memory?.query_rewrite?.provider`+`model`，构造
  `buildRewritePrompt(query)` 后 `callLlm(prompt)`，parse JSON，失败/无 rewrite
  config 时走 `simpleKeywordExtraction(query)`
- **`searchAtomsWithScores` 内部逻辑**：复用 `searchAtoms`（line 970-1042）的
  候选打分逻辑，但额外返回每条 hit 的 fts / cosine / hybrid 三个分项。hybrid
  公式（line 993）：`(0.5 * ftsNorm + 0.5 * cosNorm) * (0.5 + 0.3 * strength + 0.2 *
  importance)`。embedding 不可用时 `cosScore = 0`、走纯 FTS 分支。`embedding_available`
  标志直接透传 `embeddingResults.size > 0`
- **`writeAtomToFile` 复用而非重写**：handler 直接 `writeAtomToFile(merged, deps.atomsDir)`，
  拿到 `{filePath, contentHash}`。`body = atom.content || atom.summary`（line 755）
  是文件 body 的来源——PATCH 把 `merged.content` 显式设成 `req.body.content ?? currentBody`，
  保证 client 没传 `content` 时文件 body 不变
- **frontmatter 字段顺序固定**（`memory.ts:737-753` 13 个字段，固定顺序），
  不能在 webui 侧改顺序，否则 `readAtomFromFile` 解析虽能跑（`fields[key] = val`）
  但 `version` 解析为字符串等问题会出
- **`readAtomFromFile` 返回的 `content` 是 `content.trim()`**（line 722），所以
  PATCH 读回的 `currentBody` 是 trim 过的；再 `writeAtomToFile` 写入时 body 是
  `merged.content || merged.summary` = `currentBody`，文件 body 不会再加尾部
  `\n`（其实 `writeAtomToFile` 的 `content = ... + "\n"` 会加，trim 是读时抹平），
  实际是"trim-on-read"约定；hash 变更是必然的（frontmatter `updated_at` 变了）
- **slugify 冲突 bug（已知）**：`writeAtomToFile` 路径只
  `slugify(title).md`（line 732-733），两个 atom 同 title 互相覆盖。`slugify`
  对非 ASCII title 用 MD5 前 8 位（line 368-378），碰撞概率极低但非零。**不在
  v1 修**，记入 Risks；如果 PATCH 写文件时检测到 `newPath` 已被其它 atom
  占用（不是 merged 自己），需要报警但 v1 不实现"自动加 short uuid 后缀"修复
- **`useAutoSave` cleanup 里不要 setState 已 unmount 组件的 state**（React 18+
  警告），用 ref 持有 `mounted` 标志位；或者在 cleanup 里只做"fire the save
  promise, don't await state update"
- **`MemoryPage` 默认 3s 轮询 list，详情单独 3s 轮询单个 atom**；离开路由时
  `clearInterval` + `useAutoSave` cleanup 双重保险
- **`MemoryEditor` 内部按字段独立 debounce 没必要**（用户改 title 时也改了
  body？罕见），整个 atom object 级别 debounce 一次就够
- **跨平台 `renameSync` 原子性**：`writeAtomToFile` 用 tmp+rename 已经是 POSIX
  atomic；Windows 上 Node `renameSync` 在同分区也是 atomic，跨分区退化为非
  atomic。`atomsDir` 内部都在同一文件系统下，不需要担心
- **`index.ts` re-export 时只 export 新加的**，不动现有 `runMemoryExtraction` 等
  re-export 顺序；类型 `MemoryAtom` / `MemoryAtomType` 加进 `export type { ... }`

### 不需要做的（明确）
- 不动现有 `runMemoryExtraction`（webui 删 session 时还在用）
- 不动现有 `MemoryIndex` schema（兼容现有所有 v1 数据）
- 不动现有 TUI 端 `registerMemory`（TUI 走自己的 UI 路径，跟 webui 解耦）
- 不在 v1 加 embedding 异步重算（v2）
- 不在 v1 加 WebSocket 推送（v2）
- 不在 v1 加 create / delete（v2 视情况）

<!-- archived-with: 2026-06-22-webui-memory-page | status: final -->
