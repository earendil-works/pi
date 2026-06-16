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

### 1. 从 `memory.ts` export `MemoryIndex` + 三个 helper
**Decision**: `class MemoryIndex` 加 `export`，`searchAtoms` / `rewriteQuery` /
`writeAtomToFile` 三个函数加 `export`，`index.ts` re-export。Webui server 通过
`@earendil-works/pi-personal-assistant`（tsconfig path mapping 指向
`extensions/personal-assistant/index.ts`）直接 import。

**Rationale**: webui server 已经在用 `runMemoryExtraction`，证明这个 import 路径
能跑通。重复实现一份 SQLite 读 / 写逻辑会让两个文件漂移（schema 升级、文件 hash
算法变化都得改两边）。

**Alternatives considered**:
- 在 webui/server 里重写一份 read 逻辑 — 拒绝，违反 DRY，schema 漂移风险
- 把 `MemoryIndex` 抽到独立的 `@pi-mono/memory-store` 包 — 拒绝，单 repo 里多一个
  package.json 的开销大于收益，extension 自己的内存模块自己 export 即可

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

### 5. .md 文件重写时按 hash 迁移，原子替换
**Decision**: PATCH 改 `content` 时：算新 frontmatter + body → 算新
`sha256 = H2`。若 `H2 !== atom.content_hash`：写
`newPath = atomsDir/<newType>/<slug>.md`，`unlink(oldPath)`。最后 `upsertAtom`
同步更新 `file_path` / `content_hash` / `updated_at` / `version`。若 `H2 === H1`：
文件不变，只更新 `updated_at` / `version`（frontmatter 时间戳变了 hash 实际一定
不等，所以这条只发生在只改非 frontmatter 字段的场景——其实不会发生，作为防御
逻辑保留）。

**Rationale**: content-hash addressing 是个人助理 `memory.ts` 已有的设计，让
相同内容的 atom 物理文件唯一。改 body 必须走 hash 迁移以保持 `file_path` 永远
反映 `content_hash`，否则会出现"DB 写了一个 hash，磁盘上文件是另一个 hash"。

**Alternatives considered**:
- 永远覆盖同一文件 — 拒绝，违反现有 content-hash addressing 约定，下游
  缓存 / 备份工具会读到不一致状态
- 写新文件 + symlink 切换 — 拒绝，O(2) 复杂度，跨平台 symlink 不可靠

### 6. FTS 重建仅在 `title` 或 `tags` 变时执行
**Decision**: `upsertAtom` 内部已经 `DELETE FROM memory_fts WHERE id = ?` +
`INSERT INTO memory_fts`。所有 PATCH 都走 `upsertAtom`，所以这条是无条件执行
的——只是成本可忽略（O(1)）。v1 不做"title 没变就跳过 FTS"这种优化。

**Rationale**: 简单。FTS 单行 `INSERT` < 1ms，没必要为它增加 diff 逻辑。

### 7. Recall 测试走真实 `rewriteQuery` + `searchAtoms`
**Decision**: server 端 `POST /api/memory/search` 直接 import 调
`rewriteQuery(query, ctx, config)` + `searchAtoms(index, rewritten, topK)`，
把 `rewritten` 字段、每条 atom 的 `fts_score` / `cosine_score` / `hybrid_score`
一起返回。

**Rationale**: 真实 pipeline 才能让用户复现"Agent 这次注入的就是这批结果"。
Mock 一份"简化版 search"无法调试真实召回问题。

**Alternatives considered**:
- 纯 FTS 测试 — 拒绝，和 Agent 实际注入流程不一致
- 两种都给，UI 可切换 — 拒绝，YAGNI，v1 一种足够

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
mountMemoryRoutes(app, deps: { dbPath: string; settings: PersonalAssistantConfig; callLlm: ... }) {
  // GET /api/memory?type=&archived=&tag=&q=&limit=&offset=
  app.get("/api/memory", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atoms = idx.getActiveAtoms();   // or getAtomsByType for filtered
      const filtered = applyFilters(atoms, req.query);
      res.json(filtered.map(toClientAtom));
    } finally { idx.close(); }
  });

  // GET /api/memory/:id
  app.get("/api/memory/:id", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atom = idx.getAtom(req.params.id);
      if (!atom) return res.status(404).json({ error: "not found" });
      if (atom.file_path) {
        try {
          const fromFile = readAtomFromFile(atom.file_path, atom.content_hash);
          if (fromFile) atom.content = fromFile.content;
        } catch { /* memory-error: file missing or hash mismatch */ }
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

      // Read current body from disk (if file present) so unchanged body is preserved
      let currentBody = "";
      if (existing.file_path) {
        try {
          currentBody = readAtomFromFile(existing.file_path, existing.content_hash)?.content ?? "";
        } catch { /* ignore, will overwrite */ }
      }

      const merged: MemoryAtom = {
        ...existing,
        ...req.body,
        content: req.body.content ?? currentBody,   // explicit body from client wins
        version: existing.version + 1,
        updated_at: nowISO(),
      };

      // Write .md file: render frontmatter + body
      const fullText = serializeAtomFile(merged);   // frontmatter + "\n---\n" + merged.content
      const newHash = sha256(fullText);
      const newPath = atomFilePath(deps.atomsDir ?? ATOMS_DIR, merged);
      if (newHash !== existing.content_hash || merged.file_path !== newPath) {
        writeFileSync(newPath, fullText, "utf-8");
        if (existing.file_path && existing.file_path !== newPath) {
          unlinkSync(existing.file_path);
        }
        merged.file_path = newPath;
        merged.content_hash = newHash;
      }

      idx.upsertAtom(merged);
      idx.db?.prepare("DELETE FROM memory_embeddings WHERE id = ?").run(merged.id);

      res.json(merged);
    } finally { idx.close(); }
  });

  // POST /api/memory/:id/archive  body: {archived: boolean}
  app.post("/api/memory/:id/archive", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atom = idx.getAtom(req.params.id);
      if (!atom) return res.status(404).json({ error: "not found" });
      if (req.body.archived) idx.markArchived(atom.id);
      else {
        // restore: update archived=0, bump version
        const restored = { ...atom, archived: false, version: atom.version + 1, updated_at: nowISO() };
        idx.upsertAtom(restored);
      }
      res.json({ ok: true });
    } finally { idx.close(); }
  });

  // POST /api/memory/search  body: {query, topK}
  app.post("/api/memory/search", async (req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const modelCtx = buildModelCtx(deps);          // adapt to ExtensionContext shape
      const rewritten = await rewriteQuery(req.body.query, modelCtx, deps.settings);
      const atoms = await searchAtoms(idx, rewritten, req.body.topK ?? 10);
      res.json({ rewritten, atoms });
    } finally { idx.close(); }
  });

  // GET /api/memory/stats
  app.get("/api/memory/stats", async (_req, res) => {
    const idx = await openIndex(deps.dbPath);
    try {
      const atoms = idx.getActiveAtoms();
      const byType: Record<string, number> = {};
      for (const a of atoms) byType[a.type] = (byType[a.type] ?? 0) + 1;
      res.json({ total: atoms.length, byType });
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
| Body 编辑 → .md 重写时 `slugify` 冲突（两个 atom 同一 title） | 现有 `writeAtomToFile` 已经有 `slugify` + id 兜底机制，复用即可；冲突时新路径加 `-<short-uuid>` 后缀 |
| 编辑期间后端挂死，flush 永远 await | cleanup 200ms 兜底超时 + ref 标志位 setState 防止内存泄漏 |

## Testing Strategy

### 单元测试（`packages/webui/server/test/memory-routes.test.ts`）
- `GET /api/memory` 空 DB 返回 `[]`
- `GET /api/memory?type=preference` 过滤正确
- `GET /api/memory/:id` 存在返回 atom，不存在 404
- `GET /api/memory/:id` file 丢失时 `content: ""` + 不抛
- `PATCH /api/memory/:id` 改 title → DB 更新 + FTS 重建
- `PATCH /api/memory/:id` 改 content → `.md` 重写，hash 变、file_path 变
- `PATCH /api/memory/:id` 改 content 不变（hash 一致）→ 不写文件
- `POST /api/memory/:id/archive` 切换 archived 状态
- `POST /api/memory/search` 真实 pipeline 召回至少一条（mock callLlm）
- `GET /api/memory/stats` 正确分类计数

### 集成测试
- 端到端 PATCH：起真 SQLite + 真 `.md` 文件 → 改 content → 验证 .md 物理文件
  内容更新 + DB `content_hash` 更新 + `memory_embeddings` 行被清

### 边界条件
- 0 atom 列表
- 1 atom 列表
- 50KB body
- tags 空数组
- importance = 0 / 1
- type 改成 constraint 后 `runDecay` 跳过
- 路由快速切换闪入闪出

### 客户端组件测试
- `MemoryTypeBadge` 颜色映射正确
- `MemoryList` filter 逻辑（mock api）
- `useAutoSave` debounce 触发、flush 触发、error 状态

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
- `rewriteQuery` 需要 `ExtensionContext`（含 `ctx.model`, `ctx.modelRegistry`），
  server 端需要构造一个最小 mock context 或调 `modelRegistry.getApiKeyAndHeaders`
  的 standalone 路径。检查 `runMemoryExtraction` 是怎么绕过这点的——它用
  `extractMemoriesWithCallLlm` 接受外部 `callLlm` 函数。`/api/memory/search`
  走 `deps.callLlm`（已存在）+ 复用 `rewriteQuery` 的 LLM 路径需要单独适配。
  具体方案：写一个 `buildRewriteCtxForServer(callLlm, settings)` 工厂，构造
  一个含 `model: { id: settings.memory?.query_rewrite.model ?? "auto" }` +
  `modelRegistry: stub` 的 ctx，让 `rewriteQuery` 走 "configured model if set"
  分支；callLlm 在该分支里走 `getApiKeyAndHeaders` 失败时降级到
  `simpleKeywordExtraction`
- `serializeAtomFile` 必须严格对齐 `writeAtomToFile`（`memory.ts:786-840`）的
  frontmatter 序列化格式——同一份 atom 在 `readAtomFromFile` 里要能解析回来
- `atomFilePath(atomsDir, atom)` 必须和 `writeAtomToFile` 用同样的
  `slugify(atom.title)` + 路径生成规则
- `index.ts` re-export 时只 export 新加的，不动现有 `runMemoryExtraction` 等
- `useAutoSave` cleanup 里不要 setState 已 unmount 组件的 state（React 18+ 警告），
  用 ref 持有 `mounted` 标志位
- `MemoryPage` 默认 3s 轮询 list，详情单独 3s 轮询单个 atom；离开路由时 `clearInterval`
- `MemoryEditor` 内部按字段独立 debounce 没必要（用户改 title 时也改了 body？罕见），
  整个 atom object 级别 debounce 一次就够

### 不需要做的（明确）
- 不动现有 `runMemoryExtraction`（webui 删 session 时还在用）
- 不动现有 `MemoryIndex` schema（兼容现有所有 v1 数据）
- 不动现有 TUI 端 `registerMemory`（TUI 走自己的 UI 路径，跟 webui 解耦）
- 不在 v1 加 embedding 异步重算（v2）
- 不在 v1 加 WebSocket 推送（v2）
- 不在 v1 加 create / delete（v2 视情况）
