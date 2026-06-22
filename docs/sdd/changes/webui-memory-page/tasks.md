# Tasks: webui-memory-page

> **Design:** design.md | **Base:** 1302f8ae (memory-v2-refactor archive)

**Goal**: WebUI 加 `/memory` 页面, 让用户浏览/编辑/归档/测试召回 memory v2 atoms (后端 7 REST routes 已 archive).

**Architecture**: 在 `packages/webui/web/src` 新增 6 个 React 组件 + 1 个 useAutoSave hook + 1 个 API namespace (`api.memory.*`); IconRow 加 Memory icon; App.tsx 加 `/memory` route。**后端 0 改动** (memory.ts / storage.ts / routes/memory.ts 一行不改)。

**Tech Stack**: React 19 + Vite 7 + react-router-dom 7, vitest 2.1 + @testing-library/react 16, TypeScript 5.9, lucide-react (Brain icon), tailwindcss 4.1。

## Notes

- **TDD**: 每个 task 写失败测试 → 跑 RED → 实现 → 跑 GREEN → commit
- **测试运行**: webui 端测试从 `packages/webui/web/` 跑 `node ../../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`
- **后端不动**: 任何 task 都不修改 `extensions/personal-assistant/**` 或 `packages/webui/server/**`
- **fetch stub**: 组件测试用 `vi.stubGlobal("fetch", vi.fn())` 不起真 server
- **依赖图**: 1.* (api types) → 2.* (useAutoSave) → 3.* (components bottom-up) → 4.* (Page) → 5.* (navigation/route) → 6.* (test coverage gap fills)

## 1. API client (api.memory.* namespace)

- [ ] 1.1 **MemoryAtom / MemoryStats / RecallResult / SearchResponse 类型定义**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: 在文件顶部 type 定义区加 4 个 interface: `MemoryAtomType` (union `"rule"|"fact"|"process"`), `MemoryAtom` (id/type/title/summary/content/tags/importance/strength/access_count/version/archived/file_path/content_hash/created_at/updated_at/last_access/parent_id), `MemoryStats` (total/archived/byType), `RecallResult` (atom/distance/cosine_similarity), `SearchResponse` (results/recallTimeMs/tokenBudgetUsed)。**字段顺序、命名严格对齐 server response shape** (查 `packages/webui/server/routes/memory.ts:120-130` list response + `:215-260` PATCH response + `:571-630` search response)
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -10` 应无 error
  - **依赖**: 无

- [ ] 1.2 **api.memory 命名空间 6 个 method**
  - **文件**: `packages/webui/web/src/lib/api.ts` (Modify)
  - **内容**: 在 `export const api = { ... }` 末尾 (line 222 之前) 加 `memory: { list, get, patch, archive, search, stats }` 6 个 method。每个 method 调 `request<T>(path, { method, body })` 复用现有 helper。`list(filter?)` 调 `GET /api/memory?<URLSearchParams>` (filter 只传 `archived`/`q`/`tag`/`limit`/`offset`,**不传 `type`**: server 单 value 不支持 multi-select, type multi-select 走 client `applyFilter`); `get(id)` 调 `GET /api/memory/${id}`; `patch(id, partial)` 调 `PATCH /api/memory/${id}` body `JSON.stringify(partial)`; `archive(id, archived)` 调 `POST /api/memory/${id}/archive` body `{archived}`; `search(query, topK=10)` 调 `POST /api/memory/search` body `{query, topK}`; `stats()` 调 `GET /api/memory/stats`
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -10` 应无 error
  - **依赖**: 1.1

- [ ] 1.3 **api.memory.* 单测 (fetch stub)**
  - **文件**: `packages/webui/web/src/lib/api.test.ts` (Modify, 已有 100+ tests 测 sessions/cron)
  - **内容**: 加 describe block `api.memory.*`, 6 个 test: (a) `list()` 调 `GET /api/memory`; (b) `list({archived: "active", q: "pdf"})` 调 `GET /api/memory?archived=active&q=pdf`; (c) `get("X")` 调 `GET /api/memory/X`; (d) `patch("X", {title: "new"})` 调 `PATCH /api/memory/X` body `{"title":"new"}`; (e) `archive("X", true)` 调 `POST /api/memory/X/archive` body `{"archived":true}`; (f) `search("q", 5)` 调 `POST /api/memory/search` body `{"query":"q","topK":5}`。用 `vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))` 模式 (与现有 api.test.ts 一致)
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/lib/api.test.ts 2>&1 | tail -5` 应 6/6 memory tests pass
  - **依赖**: 1.2

## 2. useAutoSave hook

- [ ] 2.1 **useAutoSave hook 状态机实现**
  - **文件**: `packages/webui/web/src/lib/useAutoSave.ts` (Create)
  - **内容**: 实现 hook, 输入 `value: T`, `save: (v: T) => Promise<void>`, options `{delay?: number = 3000, flushTimeout?: number = 200}`, 输出 `{state: "idle"|"dirty"|"saving"|"saved"|"error", lastSavedAt: number | null, flush: () => Promise<void>}`。实现细节: (a) 用 `useEffect` 监听 `value` 变化 → `setState("dirty")` → `setTimeout` 3s → `setState("saving")` → try `await save(value)` → `setState("saved")` + `setLastSavedAt(Date.now())` → 1.5s 后 setState("idle"); catch → `setState("error")`; (b) 用 `useRef` 持 `mountedRef`, unmount cleanup 取消 timer, 如果 dirty 立即 `save(value)` 但 await 不超 `flushTimeout` ms; (c) `flush()` 主动 await 当前 in-flight save
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -5` 应无 error
  - **依赖**: 1.1

- [ ] 2.2 **useAutoSave 状态机 + flush 单测**
  - **文件**: `packages/webui/web/src/lib/useAutoSave.test.ts` (Create)
  - **内容**: 6 个 test, 用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(N)`: (a) 初始 state="idle"; (b) 改 value → state="dirty"; (c) 等 3s → save 被调 + state="saved"; (d) save 抛错 → state="error", 不重试; (e) 改 value 然后 1s 后 unmount (cleanup) → save 立即被调, 200ms 后 timer 中断; (f) `flush()` 在 dirty 状态调 → 立即 await save 完成。`renderHook` from `@testing-library/react` 配合 `act()`。mock save 函数用 `vi.fn().mockResolvedValue(undefined)`
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/lib/useAutoSave.test.ts 2>&1 | tail -5` 应 6/6 pass
  - **依赖**: 2.1

## 3. 组件 bottom-up (TypeBadge → List → Detail/Editor/SearchTester)

- [ ] 3.0 **filter 逻辑抽到 lib/memoryFilter.ts (供 List + Page 共享)**
  - **文件**: `packages/webui/web/src/lib/memoryFilter.ts` (Create)
  - **内容**: 导出 `type MemoryFilter = {type?: MemoryAtomType[], tag?: string, archived?: "active"|"archived"|"all", q?: string}` 和 `function applyFilter(atoms: MemoryAtom[], filter: MemoryFilter): MemoryAtom[]`. 实现: type multi-select 数组包含即 pass (client-side, 不传 server); tag chip 包含; archived 3 态; q title/摘要 case-insensitive substring
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/lib/memoryFilter.test.ts 2>&1 | tail -5` 应 ≥4 tests pass (type multi / tag / archived 3 态 / q substring)
  - **依赖**: 1.1

- [ ] 3.1 **MemoryTypeBadge 组件 (3 行组件)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryTypeBadge.tsx` (Create)
  - **内容**: 函数组件 `MemoryTypeBadge({type: MemoryAtomType})` 返 `<span className={...}>`, 三种 type 颜色: rule=blue, fact=green, process=yellow, 文字 label: "Rule" / "Fact" / "Process", className 模板: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`, color map: rule → `bg-blue-100 text-blue-700`, fact → `bg-green-100 text-green-700`, process → `bg-yellow-100 text-yellow-700`。导出 `type MemoryTypeBadgeProps = {type: MemoryAtomType}`。**先在文件最底部写 import + 内部 map + 组件骨架, 再写测试** (TDD)
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryTypeBadge.test.tsx 2>&1 | tail -5` 应 ≥3 tests pass
  - **依赖**: 1.1

- [ ] 3.2 **MemoryTypeBadge.test.tsx (颜色 + label 映射)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryTypeBadge.test.tsx` (Create)
  - **内容**: 用 `@testing-library/react` + `render()`: (a) 传 `type="rule"` → 文本含 "Rule" + className 含 "blue"; (b) `type="fact"` → "Fact" + "green"; (c) `type="process"` → "Process" + "yellow"
  - **验证**: 同 3.1
  - **依赖**: 3.1

- [ ] 3.3 **MemoryList 组件 (filter + 卡片列表)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryList.tsx` (Create)
  - **内容**: 接收 props `{atoms: MemoryAtom[], selectedId: string | null, onSelect: (id: string) => void, filter: MemoryFilter, onFilterChange: (f: MemoryFilter) => void}`, 内部 `useMemo(() => applyFilter(atoms, filter), [atoms, filter])` (用 3.0 抽出的 `applyFilter`)。UI: 顶部 type filter (3 button toggle, multi-select), archived filter (3 radio), tag input, free-text search input; 下方卡片列表, 每卡片 `MemoryTypeBadge + title + strength·importance + last_access relative time`, 选中态 `bg-blue-50` ring。空态 "No memories yet" placeholder。
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryList.test.tsx 2>&1 | tail -5` 应 ≥5 tests pass
  - **依赖**: 3.0, 3.1, 1.1

- [ ] 3.4 **MemoryList.test.tsx (filter 逻辑)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryList.test.tsx` (Create)
  - **内容**: mock fixture 4 atoms (rule/fact/process 各 1 + 1 archived), 5 个 test: (a) 默认显示 3 active; (b) 改 `filter.archived="archived"` 显示 1 条 + label "Archived"; (c) 改 `filter.type=["rule"]` 显示 1 条; (d) 改 `filter.q="pdf"` 命中 title 含 "pdf" 的; (e) 0 atom 显示 "No memories yet" placeholder。**filter 直接通过 props 注入, 不需要交互** (测纯逻辑, 交互留给 Playwright)
  - **验证**: 同 3.3
  - **依赖**: 3.3

- [ ] 3.5 **MemoryEditor 组件 (useAutoSave 集成)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.tsx` (Create)
  - **内容**: 接收 props `{atom: MemoryAtom, onPatch: (id: string, partial: Partial<MemoryAtom>) => Promise<void>}`, 内部用 `useState` 持 `patch: Partial<MemoryAtom>` (相对 atom 的 diff), 整个 patch 传入 `useAutoSave<Partial<MemoryAtom>>(patch, async (p) => { await onPatch(atom.id, p); setPatch({}); })` 触发 save。UI 拆两栏: (a) metadata form: title input, type select (rule/fact/process), importance slider (0-1, 0.05 step), tags chip input, summary textarea; (b) body editor: Edit/Preview tab (Edit 显示 textarea 60vh 高, Preview 调现有 `Markdown` 组件)。底部 `<MemoryEditorStatus state={state} lastSavedAt={lastSavedAt} />` 状态条。Patching 期间 input 不可编辑 (`disabled={state === "saving"}`)
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryEditor.test.tsx 2>&1 | tail -5` 应 ≥4 tests pass
  - **依赖**: 3.1, 2.1, 1.1

- [ ] 3.6 **MemoryEditor.test.tsx (useAutoSave 集成)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditor.test.tsx` (Create)
  - **内容**: mock fixture 1 atom, 4 个 test: (a) 渲染 metadata + body 输入; (b) 改 title input → 3s 后 `onPatch` 被调 with `{title: "new"}`; (c) `onPatch` reject → 状态条显示 "Save failed" (依赖 MemoryEditorStatus); (d) 改回原值 (hash 不变) → 不触发 patch (用 `vi.useFakeTimers` 验证)
  - **验证**: 同 3.5
  - **依赖**: 3.5

- [ ] 3.7 **MemoryEditorStatus 组件 (状态条)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditorStatus.tsx` (Create)
  - **内容**: 函数组件 `MemoryEditorStatus({state: AutoSaveState, lastSavedAt: number | null})` 返一行状态条: idle → 空白; dirty → 灰 "Unsaved changes…"; saving → 蓝 "Saving…"; saved → 绿 "Saved Xs ago" (用 `Date.now() - lastSavedAt`); error → 红 "Save failed" + Retry 按钮 (onClick 调 `flush()` 通过 props 传入)。className: idle "h-6", 其他 "h-6 px-2 flex items-center"
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryEditorStatus.test.tsx 2>&1 | tail -5` 应 ≥4 tests pass
  - **依赖**: 2.1

- [ ] 3.8 **MemoryEditorStatus.test.tsx**
  - **文件**: `packages/webui/web/src/components/memory/MemoryEditorStatus.test.tsx` (Create)
  - **内容**: 4 test: (a) state="idle" → 文本空 / className 含 h-6; (b) state="dirty" → 文本 "Unsaved changes"; (c) state="saving" → 文本 "Saving"; (d) state="error" → 文本 "Save failed" + Retry 按钮可点
  - **验证**: 同 3.7
  - **依赖**: 3.7

- [ ] 3.9 **MemoryDetail 组件 (装入 atom + 归档 toggle)**
  - **文件**: `packages/webui/web/src/components/memory/MemoryDetail.tsx` (Create)
  - **内容**: 接收 props `{atom: MemoryAtom | null, onPatch, onArchive}`. **不**传 `atoms` 给 SearchTester — SearchTester 自己管 query 状态, 不需要外部 atoms (atoms 是为了 fallback 不用 server, 但 v2 设计就调 server 真实 pipeline)。逻辑: atom=null → 渲染 placeholder "Select an atom from the list"; atom 非空 → 渲染 header (type badge + title + importance slider + tags + archived indicator), body (调 MemoryEditor), 底部按钮 [Archive] (if !atom.archived) 或 [Restore] (if archived), 点按钮立即 `onArchive(atom.id, !atom.archived)`, **不走 debounce**。底部固定渲染 `MemorySearchTester` (不折叠, 始终可见)
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryDetail.test.tsx 2>&1 | tail -5` 应 ≥3 tests pass
  - **依赖**: 3.5, 3.7, 3.11

- [ ] 3.10 **MemoryDetail.test.tsx**
  - **文件**: `packages/webui/web/src/components/memory/MemoryDetail.test.tsx` (Create)
  - **内容**: 3 test: (a) atom=null 渲染 "Select an atom"; (b) 传 archived=false atom + 点 Archive 按钮 → `onArchive(id, true)` 立即被调 (不 debounce); (c) 传 archived=true atom + 点 Restore 按钮 → `onArchive(id, false)` 被调
  - **验证**: 同 3.9
  - **依赖**: 3.9

- [ ] 3.11 **MemorySearchTester 组件 (query + results table)**
  - **文件**: `packages/webui/web/src/components/memory/MemorySearchTester.tsx` (Create)
  - **内容**: 不接 props (或接 `{}` 内部全管). 内部 `useState` 持 `query` + `results: RecallResult[] | null` + `loading: boolean`. 点 Search 按钮 → `setLoading(true)` → `const res = await api.memory.search(query, 10)` → `setResults(res.results)` → `setLoading(false)`. 渲染: 输入框 + Search 按钮; 结果表格 (table with thead: distance | cos | type | title | str | imp), 每行 hover 展开 frontmatter (MemoryTypeBadge). 空结果 (results.length === 0) → "No results (embedding service unavailable)"
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemorySearchTester.test.tsx 2>&1 | tail -5` 应 ≥3 tests pass
  - **依赖**: 1.2, 3.1

- [ ] 3.12 **MemorySearchTester.test.tsx**
  - **文件**: `packages/webui/web/src/components/memory/MemorySearchTester.test.tsx` (Create)
  - **内容**: 3 test 用 `vi.stubGlobal("fetch")`: (a) 输入 "PDF" + 点 Search → `fetch` 被调 with `POST /api/memory/search` body `{"query":"PDF","topK":10}`; (b) mock fetch 返 `{results: [...], recallTimeMs: 50}` → 表格渲染 1 行; (c) mock fetch 返 `{results: []}` → 文本 "embedding service unavailable"
  - **验证**: 同 3.11
  - **依赖**: 3.11

## 4. MemoryPage 顶层装配

- [ ] 4.1 **MemoryPage 组件 (3-column layout + 状态管理)**
  - **文件**: `packages/webui/web/src/pages/MemoryPage.tsx` (Create)
  - **内容**: 顶层 `useState` 持 `atoms: MemoryAtom[]` + `selectedId: string | null` + `filter: MemoryFilter`. `useEffect` mount 时 `const data = await api.memory.list({archived: filter.archived ?? "active"})`; `setAtoms(data)`. 3 秒 `setInterval` 拉新 (`api.memory.list`), unmount `clearInterval`. `useMemo` filtered = `applyFilter(atoms, filter)` (用 3.0 抽出的 lib). 渲染: 2-column grid `grid-cols-[300px_1fr]`, 左 `MemoryList`, 右 `MemoryDetail`. `onPatch` 实现: `await api.memory.patch(id, partial); const fresh = await api.memory.get(id); setAtoms(prev => prev.map(a => a.id === id ? fresh : a))` (更新 list). `onArchive` 实现: `await api.memory.archive(id, archived); refetch`
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -5` 应无 error
  - **依赖**: 3.0, 3.3, 3.9, 3.11, 1.2

- [ ] 4.2 **MemoryPage.test.tsx (装配 + refetch)**
  - **文件**: `packages/webui/web/src/pages/MemoryPage.test.tsx` (Create)
  - **内容**: 3 test 用 `vi.stubGlobal("fetch")`: (a) mount 调 `GET /api/memory?archived=active` + 渲染 list; (b) 点 list 项 → 调 `GET /api/memory/<id>` + 渲染 detail; (c) PATCH 成功后 refetch `GET /api/memory/<id>` + list 更新
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/pages/MemoryPage.test.tsx 2>&1 | tail -5` 应 ≥3 tests pass
  - **依赖**: 4.1

## 5. 导航 + 路由

- [ ] 5.1 **IconRow 加 Memory icon**
  - **文件**: `packages/webui/web/src/components/sidebar/IconRow.tsx` (Modify)
  - **内容**: 加 `Brain` import from `lucide-react`. 在 `/cron` Link 后加第 3 个 Link: `<Link to="/memory" aria-label="Memory" className={linkClass(isMemory)}><Brain size={18} /></Link>`. `isMemory = location.pathname.startsWith('/memory')`. 现有 2 icon (Chat / Cron) 不动
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -5` 应无 error
  - **依赖**: 无

- [ ] 5.2 **App.tsx 加 /memory 路由**
  - **文件**: `packages/webui/web/src/App.tsx` (Modify)
  - **内容**: 加 `import MemoryPage from "./pages/MemoryPage"` (line 2 附近现有 `import CronPage` 后). 在 `<Route path="/cron" element={<CronPage />} />` (line 84) 后加 `<Route path="/memory" element={<MemoryPage />} />`. 其他 route / ShellWrapper 不动
  - **验证**: `cd packages/webui/web && npx tsc --noEmit 2>&1 | head -5` 应无 error; `cd packages/webui/web && npx vitest --run 2>&1 | tail -3` 应所有现有 web tests + 新增 17+ tests pass
  - **依赖**: 4.1, 5.1

## 6. 集成验证

- [ ] 6.1 **回归测试 — webui web 端全量**
  - **文件**: `packages/webui/web` (测试入口)
  - **内容**: 跑全量 vitest 确认现有 6 个 web tests (App.test.tsx / main.test.tsx / Sidebar.test.tsx / AppShell.test.tsx / Lightbox.test.tsx / AskUserQuestionCard.test.tsx / CronForm.test.tsx / CronList.test.tsx) + 新增 17+ memory tests 全 pass
  - **验证**: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` 应 ALL pass
  - **依赖**: 5.2

- [ ] 6.2 **回归测试 — webui server 端 (确认 0 改动)**
  - **文件**: `packages/webui/server/test/memory-routes.test.ts` (未改)
  - **内容**: 跑 server 测试确认 46 个 memory routes tests + 264 个 webui server tests 全 pass (因为本变更 server 端 0 改动, 这条是 guard 防止意外回归)
  - **验证**: `cd packages/webui && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` 应 ALL pass
  - **依赖**: 5.2

- [ ] 6.3 **回归测试 — personal-assistant (确认 0 改动)**
  - **文件**: `extensions/personal-assistant/test/*.test.ts` (未改)
  - **内容**: 跑 personal-assistant 355 tests 确认全 pass
  - **验证**: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` 应 ALL pass (2 个 expected failures: extract-real-session + patch-real-atom 需 API key)
  - **依赖**: 5.2

- [ ] 6.4 **npm run check (biome + lint + tsgo)**
  - **内容**: 跑全量 check
  - **验证**: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tail -5` 应 0 error
  - **依赖**: 5.2

- [ ] 6.5 **端到端 manual 验证 (开发服务器)**
  - **内容**: 启 webui dev server, 准备 fixture DB 含 3 atoms (1 rule + 1 fact + 1 process), 浏览器访问 /memory → 列表显示 3 条 → click fact → 详情显示 → 改 title → 3s 后状态条 "Saved" → 切 /cron → 回 /memory → 改动保留 → 切回 ChatPage 不报错
  - **验证**: 浏览器 DevTools console 无 error; /memory 路由在 sidebar active
  - **依赖**: 6.1, 6.2, 6.3, 6.4

## Verification

- [ ] 全量 webui web 端测试: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (含 6 个新增组件测试 + 1 useAutoSave + 1 api 扩展 + 1 memoryFilter + 1 MemoryPage, 共 10+ 新 test files)
- [ ] 全量 webui server 端测试: `cd packages/webui && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (确认 0 server 改动, 264 tests pass)
- [ ] 全量 personal-assistant 测试: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (确认 0 pa 改动, 355 tests pass)
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tail -5`
