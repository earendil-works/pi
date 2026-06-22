# Design: webui-memory-page (v2)

## Context

Memory v2 (`memory-v2-refactor`, archived 2026-06-22) 已为 Agent 提供持久化记忆:

- **被动注入**: `before_agent_start` 触发 LLM 无关的 sqlite-vec KNN + bge-m3 cosine 召回,
  命中后注入 `<memory-context>` 到 user message
- **主动抽取**: `runMemoryExtraction(unified opts)` 走 LLM 读对话输出 `ExtractionPlan`,
  create / supersede / skip 三种动作
- **衰减**: `runDecay` 用 `λ = baseDecay * (1 - importance)` 指数衰减,跌破阈值自动
  archive (rule 类型除外)
- **存储**: SQLite `memory.db` (memory_index + vec0 memory_vectors(1024)) +
  `~/.pi/agent/memory/atoms/{rule,fact,process}/<atom.id>.md` frontmatter + body
  按 content_fingerprint (sha256 normalize) 寻址

**v2 后端 REST 7 routes 已交付并通过 46 server tests** (`packages/webui/server/
routes/memory.ts`):

| Route | Method | 用途 |
|-------|--------|------|
| `/api/memory` | GET | list (filter: type, tag, archived, q) |
| `/api/memory/:id` | GET | 读 atom (含 .md body) |
| `/api/memory/:id` | PATCH | union tags + recompute vector + 重写 .md |
| `/api/memory/:id/archive` | POST | toggle archived |
| `/api/memory/search` | POST | recallAtoms + token budget |
| `/api/memory/extract` | POST | runMemoryExtraction 手动触发 |
| `/api/memory/stats` | GET | counts (active + archived + byType) |

整套机制对 Agent 闭环,但用户侧黑盒:看不到存了什么、调试不了召回、不能手动修正。
本变更在 webui 加 `/memory` 页面,让用户**浏览 / 召回测试 / 编辑 / 归档** 记忆。

## Goals / Non-Goals

### Goals
- 浏览所有 atom (按 type / tag / archived 过滤, free-text 搜 title/摘要)
- 查看 atom 完整详情 (DB 元数据 + 文档正文)
- 编辑 metadata 任意字段 (title / type / importance / tags / summary) + body (content),
  3s debounce 自动 PATCH, 路由离开时强制 flush
- 归档 / 取消归档 (toggle, 不走 debounce)
- 召回测试: 调真实 `recallAtoms(index, query, topK)`,展示每条 distance/cosine/
  strength/importance; ollama 不可用时返空 (UI 标 "embedding service unavailable")
- Sidebar 加 Memory icon; 路由 `/memory`

### Non-Goals (v1)
- Create / delete atom (避免污染 LLM 抽取质量判断)
- 编辑后立即重算 embedding (server PATCH 已删 vector, lazy recompute)
- TUI ↔ webui 实时同步 (3s 轮询 + 手动 refresh)
- 版本历史 / 审计日志
- Bulk 操作
- `$EDITOR` 集成 (用 textarea + preview tab)
- 大 DB 虚拟列表 (10k+ atom, v2 评估 react-virtuoso)
- 不修后端任何代码 (memory.ts / storage.ts / routes/memory.ts 0 改动)
- 不加新 REST route

## Decisions

### 1. 后端 0 改动
**Decision**: `extensions/personal-assistant/{memory,storage,embed,extraction,search,
format,decay,file-store,types,index}.ts` 一行不改; `packages/webui/server/routes/
memory.ts` 一行不改; `packages/webui/server/index.ts` 一行不改。

**Rationale**: 后端已完成 855/855 tests 验证, archive 完。webui 端是纯新代码, 不
"完美设计一个后端 schema"诱惑我们重排, 直接复用。

**Alternatives considered**:
- 加一个 `getMemoryStats` aggregate route — 拒绝, `GET /api/memory/stats` 已有
- 加 `POST /api/memory/bulk-archive` — 拒绝, v1 不做 bulk
- 改 `mountMemoryRoutes` 顺序 — 拒绝, v2 已验证 static 先于 `:id`

### 2. 6 个 React 组件 + 1 个 hook, 单一职责
**Decision**:

| 文件 | 职责 |
|------|------|
| `pages/MemoryPage.tsx` | 顶层装配 (3-column layout, 路由 entry) |
| `components/memory/MemoryTypeBadge.tsx` | type → 颜色 + label 映射 (3 行组件) |
| `components/memory/MemoryList.tsx` | 左列: 列表 + filter UI |
| `components/memory/MemoryDetail.tsx` | 中列: 详情面板 (header + 调 list atom) |
| `components/memory/MemoryEditor.tsx` | 中列: metadata form + body editor (含 useAutoSave) |
| `components/memory/MemoryEditorStatus.tsx` | 状态条: Saving… / Saved Ns ago / Failed |
| `components/memory/MemorySearchTester.tsx` | 底部可折叠: query input + results table |
| `lib/useAutoSave.ts` | 3s debounce + unmount flush + 200ms 兜底 |

**Rationale**: 单一职责便于单测 (MemoryTypeBadge 纯函数; MemoryList 用 mock api 测
filter 逻辑); useAutoSave 独立 hook 可在 MemoryEditor 单测里直接测状态机。

**Alternatives considered**:
- 全塞 1 个大组件 — 拒绝, 不可测
- MemoryEditor 拆 metadata/body 两个子组件 — 边界, 暂不拆 (50 行内)
- MemoryPage 引入 Context — 拒绝, props drilling 够用 (3 层)

### 3. `useAutoSave` 设计: 3s debounce + unmount flush + 200ms 兜底
**Decision**:

```typescript
function useAutoSave<T>(value: T, save: (v: T) => Promise<void>, options?: {
  delay?: number;       // default 3000
  flushTimeout?: number; // default 200
}): { state: "idle" | "dirty" | "saving" | "saved" | "error"; lastSavedAt: number | null; flush: () => Promise<void> }
```

**状态机**:
```
idle  ── value 变 ──→ dirty
dirty ── 3s 静默 ──→ saving
saving ── save ok ──→ saved (1.5s 后回 idle)
saving ── save fail ──→ error (不重试, 由调用方决定)
```

**flush 时机**:
- 组件 unmount: 如果 `state === "dirty"`, 立即调 `save(value)`, 但不 await 超 200ms
- 用户主动 `flush()` 调: await 到结束

**Rationale**: 3s 决策窗; 1.5s 用户嫌短; 200ms 兜底防后端挂死; 失败不重试 (用户感知
  决定)。

**Alternatives considered**:
- 1.5s debounce — 拒绝, 用户反馈太短
- 失焦 / Cmd+Enter 提交 — 拒绝, metadata 字段无"提交"概念
- 实时 keystroke commit — 拒绝, 写库压力
- 自动重试失败 — 拒绝, UI 状态复杂; 第二次失败用户自己点 Retry 按钮

### 4. PATCH 失败回滚策略
**Decision**: 失败时**回滚 in-memory value 到 `lastSaved.current`**, 显示红色 toast
("Save failed. Click to retry.") 让用户点按钮重试。**不自动重试**。

**Rationale**: 自动重试 (debounce 3s) 在 server OOM 等场景下永远失败, 用户感觉"我改了
  但没保存"但 UI 不告诉原因, 误判成"我是不是没改成功"。手动 retry 按钮把责任推回给
  用户决策。

**Alternatives considered**:
- 失败后无限重试 — 拒绝, 风暴
- 失败 1 次后重试 1 次 — 失败再次则停手, 但用户没感知, 误判
- 失败 1 次后重试 1 次 + toast — 可接受, 但增加代码; v1 不做

### 5. 召回测试 = 真实 pipeline, 不 mock
**Decision**: `MemorySearchTester` 输入 query + topK → `api.memory.search({query, topK})`
→ server `POST /api/memory/search` → server `recallAtoms(index, query, topK)` → 返
`{results: [{atom, distance, cosine_similarity}], recallTimeMs, tokenBudgetUsed}`。

**UI 展示**: 每行 `[distance] [cosine] [type] [title] [strength] [importance]`; hover
  看完整 frontmatter。

**ollama 不可用时**: server 返 `{results: []}`, UI 标 "No results (embedding service
  unavailable)"。

**Rationale**: 真实 pipeline 才能让用户复现 "Agent 这次注入的就是这批结果"。v2 删了
  rewriteQuery 步骤, query 直接 embed; UI 也不显示 `keywords`/`target_types` chips
  (v1 才有, v2 不再适用)。

**Alternatives considered**:
- mock 一个 search 函数 — 拒绝, 用户测出来不一致
- 加 `getEmbedding(query)` 单独 API 测 — 拒绝, YAGNI; 完整 search 已有
- 测 `formatMemoryContext` — 拒绝, 那是 server 召回后注入格式化, 跟 webui UI 无关

### 6. 3s 轮询拉新
**Decision**: 详情 3s `GET /api/memory/:id` 拉新; list 3s `GET /api/memory?archived=active` 拉新。
只在 `/memory` 路由 active 时轮询, 离开 `clearInterval`。

**Rationale**: v1 不引入 WebSocket, webui 现有 WS 只接 session events, 扩到 memory
  流需新协议 / 新 client handler, 复杂度不匹配。3s 轮询对 100 atom 量级 < 50ms。

**Alternatives considered**:
- 1s 轮询 — 拒绝, 太多请求
- 完全不轮询 (靠 PATCH 后 server push) — 拒绝, 后台抽取要感知
- WebSocket 推送 — v2

### 7. 导航: IconRow 加 Memory icon
**Decision**: `components/sidebar/IconRow.tsx` 加第三个 icon `Brain` (lucide-react) 链
`/memory`, active 状态判断 `pathname.startsWith("/memory")`。**不动 IconRow 现
有 2 icon** (Chat / Cron)。

**Rationale**: 跟现有 cron 平行, 不引入新 layout 模式。

**Alternatives considered**:
- 全部 icon 提到 Sidebar 顶部 (去掉 IconRow) — 拒绝, scope creep
- Memory 放 Brand 下面独立 — 拒绝, layout 改

### 8. 不实现 create / delete
**Decision**: 不暴露 `POST /api/memory` (create) 和 `DELETE /api/memory/:id` (delete)
— 这两个 route **v2 后端就没实现**。删除用 `POST /api/memory/:id/archive {archived:
true}` 替代 (DB 行仍在, list 默认过滤掉)。

**Rationale**: 手动 create 出来的 atom 没经过 LLM extraction 的 context judgment, 会
  污染模型对"用户偏好"的判断。

**Alternatives considered**:
- 加 create route — 拒绝, 污染
- 加 delete route — 拒绝, 用 archive 替代

## Architecture

### 组件图

```
BrowserRouter
  └── /memory
        MemoryPage (pages/MemoryPage.tsx)
          ├── IconRow (现有, 加 Brain icon)
          ├── AppShell (现有, 接受 children via Outlet)
          └── <div class="grid grid-cols-[300px_1fr]">
                │
                ├─ MemoryList (左列 300px)
                │   ├── Filter: type multi-select (rule/fact/process)
                │   ├── Filter: archived 3-state (active / archived / all)
                │   ├── Filter: tag chip input
                │   ├── Search: free-text title/摘要
                │   └── atom 卡片列表 (每卡: type badge / title / strength / importance)
                │
                └─ MemoryDetail (右列 flex-1)
                      ├── Header: type / title / importance slider / tags chips
                      ├── MemoryEditor (metadata form + body editor)
                      │   ├── useAutoSave hook (3s debounce)
                      │   └── MemoryEditorStatus (status bar)
                      ├── Action buttons: [Archive] / [Restore]
                      └── MemorySearchTester (底部可折叠, 仅在 selectedId === null 时展开)
                            ├── Query input + [Search] 按钮
                            ├── Results table: distance | cos | type | title | str | imp
                            └── Hover row → 展开完整 frontmatter
```

### 关键接口

**API client** (`packages/webui/web/src/lib/api.ts` 加 memory 命名空间):

```typescript
// Types (添加到 api.ts)
export type MemoryAtomType = "rule" | "fact" | "process";
export interface MemoryAtom {
  id: string;
  type: MemoryAtomType;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  importance: number;        // 0..1
  strength: number;         // 0..1 (decayed)
  access_count: number;
  version: number;
  archived: boolean;
  file_path: string | null;
  content_hash: string;
  created_at: string;       // ISO
  updated_at: string;       // ISO
  last_access: string;      // ISO
  parent_id: string | null; // supersede chain
}
export interface MemoryStats {
  total: number;
  archived: number;
  byType: Record<MemoryAtomType, number>;
}
export interface RecallResult {
  atom: MemoryAtom;
  distance: number;            // sqlite-vec distance
  cosine_similarity: number;   // 1 - distance²/2
}
export interface SearchResponse {
  results: RecallResult[];
  recallTimeMs: number;
  tokenBudgetUsed: number;
}

// Methods (api.memory.*)
memory: {
  // filter 参数只传 server 支持的 (archived / q / tag / limit / offset);
  // type multi-select 在客户端用 applyFilter 处理 (server 只支持 single type)
  list(filter?: { tag?: string; archived?: "active" | "archived" | "all"; q?: string; limit?: number; offset?: number }): Promise<MemoryAtom[]>;
  get(id: string): Promise<MemoryAtom>;
  patch(id: string, partial: Partial<MemoryAtom>): Promise<MemoryAtom>;
  archive(id: string, archived: boolean): Promise<{ ok: true; atom: MemoryAtom }>;
  search(query: string, topK?: number): Promise<SearchResponse>;
  stats(): Promise<MemoryStats>;
}
```

**Client-side filter** (`packages/webui/web/src/lib/memoryFilter.ts`):

```typescript
export type MemoryFilter = {
  type?: MemoryAtomType[];        // multi-select, client-side only
  tag?: string;
  archived?: "active" | "archived" | "all";
  q?: string;                     // title/摘要 case-insensitive substring
};
export function applyFilter(atoms: MemoryAtom[], filter: MemoryFilter): MemoryAtom[] {
  let result = atoms;
  if (filter.type && filter.type.length > 0) {
    result = result.filter((a) => filter.type!.includes(a.type));
  }
  if (filter.tag) {
    result = result.filter((a) => a.tags.includes(filter.tag!));
  }
  if (filter.archived === "active") {
    result = result.filter((a) => !a.archived);
  } else if (filter.archived === "archived") {
    result = result.filter((a) => a.archived);
  }
  // filter.archived === "all" → no filter
  if (filter.q) {
    const q = filter.q.toLowerCase();
    result = result.filter(
      (a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q),
    );
  }
  return result;
}
```

**useAutoSave hook** (`packages/webui/web/src/lib/useAutoSave.ts`):

```typescript
type AutoSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function useAutoSave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  options?: { delay?: number; flushTimeout?: number }
): {
  state: AutoSaveState;
  lastSavedAt: number | null;
  flush: () => Promise<void>;
}

// 行为:
// 1. value 变化 → setState("dirty") → 3s timer → 触发 save
// 2. save 调用前 setState("saving"), try/catch 区分 saved / error
// 3. unmount cleanup: 如果 dirty, fire save, await 至多 200ms
// 4. flush() 暴露: 主动 await save 完成
```

### 数据流

**打开列表**: `MemoryPage` mount → `MemoryList` 调 `api.memory.list()` → 渲染卡片
**打开详情**: 卡片 click → `setSelectedId(id)` → `MemoryDetail` mount → `api.memory.get(id)` → 渲染
**编辑 metadata**: input onChange → local state → `useAutoSave` → 3s → `api.memory.patch(id, {title})` → server `updateAtom` + `deleteVector` → 200 → client "Saved 1s ago"
**编辑 body**: textarea onChange → `patch.content` → debounce → `api.memory.patch(id, {content})` → server 写 .md + deleteVector
**归档**: `Archive` button → `api.memory.archive(id, true)` → server `markArchived` → 200
**Recall**: 输入 query → `api.memory.search(q, 10)` → 渲染结果表

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| 后端 0 改动, 但 client API 类型与 server response 不一致 (drift) | 类型定义 (MemoryAtom etc.) 写一份, client import 同一份; 单测验 server response shape |
| React Testing Library 测试 + MSW mock fetch 复杂度高 | 用 vitest-fetch-mock (或自写 fetch stub); MemoryList 测 filter 逻辑不依赖真实 fetch, MemoryDetail 测空态/loading 状态 |
| 轮询 3s 拉新, 用户编辑中可能被覆盖 | MemoryEditor 显示 "Saving…" 时禁用 input, 防止竞态 |
| 大 DB (10k+ atom) 列表慢 | v1 限制 limit=200, 超量分页 + 警告; v2 评估 react-virtuoso |
| useAutoSave unmount flush 期间 setState 已 unmount 组件 | 用 ref 持 `mounted` 标志, 跳过 post-await setState |
| `MemoryTypeBadge` 颜色覆盖现有 Tailwind 配置 | 复用现有语义色 (蓝/绿/黄), 不引入新色板 |
| 用户误删重要 atom (archive) | archive 是软删除, "Restore" 按钮 + archived filter 可见; 不暴露 hard delete |

## Testing Strategy

### 单元测试 (Vitest + React Testing Library)

| 文件 | 测什么 |
|------|--------|
| `components/memory/MemoryTypeBadge.test.tsx` | 3 type → 颜色 + label 映射 |
| `components/memory/MemoryList.test.tsx` | mock api, 测 filter 逻辑 (type / tag / archived / q), 空态, loading 态 |
| `components/memory/MemoryDetail.test.tsx` | 空 selectedId 显示 "Select an atom" placeholder; 装入后显示 metadata + body; 归档按钮 toggle |
| `components/memory/MemoryEditor.test.tsx` | useAutoSave 集成: 改 input → 3s 后触发 patch; 改回原值不触发; 失败回滚 |
| `components/memory/MemorySearchTester.test.tsx` | mock api.memory.search, 显示 results; ollama 不可用时显示 "unavailable" |
| `lib/useAutoSave.test.ts` | 状态机: idle → dirty → saving → saved; 失败 → error; unmount flush; 200ms 兜底 |
| `lib/api.test.ts` (扩展) | memory.* 7 methods 调 fetch 正确, error 处理 |

### 集成测试 (Playwright 或 manual)
- 端到端: 启动 webui + 准备 fixture DB (含 3 type atom) → 打开 /memory → 列表显示
  → click atom → 详情显示 → 改 title → 3s 后 server PATCH 触发 → 状态条 "Saved" →
  切到 /cron 路由 → 回 /memory → 改动保留
- 这个可以走 dev server manual 验证, 不强制 Playwright (v1 webui 没 Playwright)

### 边界条件
- 0 atom 空态 (新 DB)
- 1 atom 极简态
- tags 空数组
- importance 边界 0/1
- 极长 body (50KB+)
- 同 type 同 title 多个 atom (v2 路径不冲突, 都写到 `<atom.id>.md`)

## Implementation Notes

### 任务依赖顺序
1. **类型 + API client**: `lib/api.ts` 加 MemoryAtom 等 4 个 interface + 6 个 method
2. **Bottom-up 组件**: TypeBadge → List → Detail → Editor (含 useAutoSave + Status)
   → SearchTester → Page 装配
3. **导航 + 路由**: IconRow 加 icon + App.tsx 加 route
4. **测试**: 组件测试 + useAutoSave 单测 + api 扩展测试

### 注意点
- **fetch stub**: 测试用 `vi.stubGlobal("fetch", vi.fn())`, 验证调用参数 (url, method,
  body); 不需要起真 server
- **React 18 useEffect cleanup 警告**: useAutoSave 内部用 ref 持 `mountedRef`, await
  后 setState 前检查 `if (mountedRef.current)`, 避免 unmount 后 setState
- **debounce 3s 在 vitest fake timers 测**: `vi.useFakeTimers(); vi.advanceTimersByTime(3000)`
- **类型严格**: api.memory.* 的入参 / 返回值类型写满, 不允许 `any`
- **依赖方向**: `components/memory/*.tsx` → `lib/api.ts` (单向); `pages/MemoryPage.tsx`
  → `components/memory/*.tsx` (单向); `lib/useAutoSave.ts` 无业务依赖 (纯 hook)
- **不破坏现有**: AppShell children (Outlet) 行为不变; IconRow 现有 2 icon 不动
- **Tailwind 类**: 复用现有色板 (blue-100 / green-100 / yellow-100 等), 不引新色

### 不需要做的 (明确)
- 不动后端 (memory.ts / storage.ts / routes/memory.ts)
- 不改现有 CronPage / ChatPage / EmptyChat
- 不实现 create / delete atom
- 不实现 WebSocket 推送
- 不实现 version history
- 不做 10k+ atom 虚拟列表
- 不在 v1 加 embedding 异步重算
- 不加新 REST route
- 不改 `mountMemoryRoutes` 顺序
- 不改 `extensions/personal-assistant/` 任何文件
