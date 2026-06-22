# webui-memory-page Specification

## ADDED Requirements

### Requirement: Webui /memory 页面 (浏览/编辑/归档/召回)
Webui SHALL 暴露 `/memory` 路由, 渲染 2-column 布局 (左 300px 列表 + 右详情/编辑器/召回测试)。React 端用 `api.memory.*` 命名空间调后端 v2 7 个 REST routes; 后端 0 改动。

#### Scenario: 列出全部活跃 atom
- **GIVEN** `~/.pi/agent/memory.db` 有 12 条 `archived = 0` 的 atom
- **WHEN** user 访问 `/memory`
- **THEN** `MemoryPage` mount → `api.memory.list({archived: "active"})` 调 `GET /api/memory?archived=active`; 列表渲染 12 张卡片 (每卡: MemoryTypeBadge + title + strength·importance + last_access relative time)

#### Scenario: 打开 atom 详情
- **GIVEN** user 点击 list 中一个 atom 卡片
- **WHEN** 卡片 click
- **THEN** `setSelectedId(id)` → `MemoryDetail` 调 `api.memory.get(id)` → `GET /api/memory/:id` → 渲染 metadata form (MemoryEditor) + body editor + 状态条

#### Scenario: 编辑 metadata 字段
- **GIVEN** detail 装入完毕, user focus 在 `title` input
- **WHEN** user 改 title 并停手 3s
- **THEN** `useAutoSave` 触发 → `api.memory.patch(id, {title: "new"})` → `PATCH /api/memory/:id` body `{"title":"new"}`; 状态条 "Saving…" → "Saved 1s ago"; list 中对应行 refetch 后同步刷新

#### Scenario: 编辑 body (content) 触发 .md 重写
- **GIVEN** body textarea 当前内容 hash H1, file_path `<atom.id>.md`
- **WHEN** user 改 body 内容, 3s 后触发保存
- **THEN** `api.memory.patch(id, {content: "new"})` → server 调 `writeAtomToFile` 重算 frontmatter + body → 算 sha256 = H2 ≠ H1 → 写同 path (atom.id 命名) → `updateAtom(content_hash=H2, version+1)` → `deleteVector(id)`; client 状态条 "Saved"

#### Scenario: metadata 改动不破坏 body
- **GIVEN** atom 磁盘 body 5KB markdown, file_path `atoms/rule/<atom.id>.md`
- **WHEN** PATCH 只传 `{title: "new title"}` 不传 content
- **THEN** server 读 `currentBody` (file-store 拿) → 写新 frontmatter + 同一 body → file `content_hash` 变 (frontmatter `updated_at` 变了); file_path 不变 (v2 用 atom.id 命名); memory_vectors DELETE 该 atom id

#### Scenario: body 编辑后 hash 不变
- **GIVEN** user 改 body 又改回原值, hash 还是 H1
- **WHEN** PATCH 触发
- **THEN** server 重写文件但 content_hash 仍 H1; DB 行只更新 `updated_at` 和 `version`

#### Scenario: 归档 atom (不 debounce)
- **GIVEN** user 点 `Archive` 按钮
- **WHEN** 点击
- **THEN** 立即 `api.memory.archive(id, true)` → `POST /api/memory/:id/archive` body `{"archived":true}` → server `markArchived(id)`; list 中该行消失 (如当前 filter 含 archived 则置灰 + 标 "Archived")

#### Scenario: 召回测试 (v2 真实 pipeline)
- **GIVEN** user 在 MemorySearchTester 输入 "用户偏好什么字体"
- **WHEN** 点 `Search`
- **THEN** `api.memory.search(query, 10)` → `POST /api/memory/search` body `{"query":"用户偏好什么字体","topK":10}` → server `recallAtoms(index, query, 10)` → 返 `{results: [{atom, distance, cosine_similarity}], recallTimeMs, tokenBudgetUsed}`; UI 表格渲染每条 atom 的 distance/cosine/type/title/strength/importance

#### Scenario: 召回空结果 (ollama 不可用)
- **GIVEN** ollama 进程未启动
- **WHEN** user 点 Search
- **THEN** server `recallAtoms` 返 `{results: []}`; UI 标 "No results (embedding service unavailable)" 而非 error toast

#### Scenario: 路由切换强制 flush
- **GIVEN** detail 中 user 改 title 还没到 3s (pending timer)
- **WHEN** user 点 sidebar 切换到 `/sessions/<id>` 触发 unmount
- **THEN** `useAutoSave` cleanup 取消 pending timer, await in-flight PATCH 至多 200ms; 离开页面; 回 `/memory` 看到已保存版本

### Requirement: 客户端 API 命名空间 (api.memory.*)
`packages/webui/web/src/lib/api.ts` SHALL 导出 `api.memory.*` 6 个 method (list / get / patch / archive / search / stats), 复用现有 `request<T>` helper, 类型严格对齐 server response shape。

#### Scenario: api.memory.list 调 GET /api/memory
- **GIVEN** client 需要 list atoms
- **WHEN** `api.memory.list()` 被调
- **THEN** `request<MemoryAtom[]>("GET", "/api/memory")` 发起 fetch

#### Scenario: api.memory.list 接受 filter 参数
- **GIVEN** client 需要 `archived=active&q=pdf` 过滤
- **WHEN** `api.memory.list({archived: "active", q: "pdf"})` 被调
- **THEN** `request<MemoryAtom[]>("GET", "/api/memory?archived=active&q=pdf")` 发起
- **NOTE** `type` 过滤**不通过 server query 传** (server 只支持 single type, 拒 multi-select); 客户端拿到 atoms 后用 `applyFilter(atoms, filter)` 在 MemoryList 内存里 filter 跨多个 type

#### Scenario: api.memory.patch 调 PATCH
- **GIVEN** client 需要改 title
- **WHEN** `api.memory.patch(id, {title: "new"})` 被调
- **THEN** `request<MemoryAtom>("PATCH", "/api/memory/<id>")` body `{"title":"new"}` 发起

#### Scenario: api.memory.archive 调 POST
- **GIVEN** client 需要归档
- **WHEN** `api.memory.archive(id, true)` 被调
- **THEN** `request<{ok: true; atom: MemoryAtom}>("POST", "/api/memory/<id>/archive")` body `{"archived":true}` 发起

#### Scenario: api.memory.search 调 POST
- **GIVEN** client 需要召回
- **WHEN** `api.memory.search(query, 5)` 被调
- **THEN** `request<SearchResponse>("POST", "/api/memory/search")` body `{"query":"...","topK":5}` 发起

#### Scenario: api.memory.stats 调 GET
- **GIVEN** client 需要 stats
- **WHEN** `api.memory.stats()` 被调
- **THEN** `request<MemoryStats>("GET", "/api/memory/stats")` 发起

### Requirement: useAutoSave hook (3s debounce + unmount flush)
`packages/webui/web/src/lib/useAutoSave.ts` SHALL 导出 `useAutoSave<T>(value, save, options?)` hook, 状态机 `idle → dirty → saving → saved/error`, 3s 静默触发 save, unmount cleanup 强制 flush (200ms 兜底超时)。

#### Scenario: idle 初始状态
- **GIVEN** hook mount
- **WHEN** 立即读 `state`
- **THEN** `state === "idle"`, `lastSavedAt === null`

#### Scenario: value 变化 → dirty
- **GIVEN** hook 处于 idle
- **WHEN** 调用方改 value
- **THEN** `state === "dirty"`, 3s timer 启动

#### Scenario: 3s 静默 → saving → saved
- **GIVEN** hook 处于 dirty
- **WHEN** 等 3s
- **THEN** `state === "saving"` → 调 `save(value)` → 成功后 `state === "saved"`, `lastSavedAt = Date.now()` → 1.5s 后 `state === "idle"`

#### Scenario: save 抛错 → error (不重试)
- **GIVEN** hook 处于 saving
- **WHEN** `save` 抛 reject
- **THEN** `state === "error"`, `lastSavedAt` 不变; 调用方负责重试

#### Scenario: unmount cleanup flush (200ms 兜底)
- **GIVEN** hook 处于 dirty, pending save 未触发
- **WHEN** 组件 unmount
- **THEN** cleanup 立即 `save(value)` 但 await 不超 200ms; 如果 200ms 未完成, timer 中断; mounted 标志 setState 跳过避免 unmount 后 setState 警告

#### Scenario: flush() 主动 await
- **GIVEN** hook 处于 dirty
- **WHEN** 调用 `flush()`
- **THEN** 立即 await `save(value)` 完成; 不等 3s timer

### Requirement: MemoryTypeBadge 组件 (3 行组件)
`packages/webui/web/src/components/memory/MemoryTypeBadge.tsx` SHALL 渲染 type → 颜色 + label 映射: rule=blue/"Rule", fact=green/"Fact", process=yellow/"Process"。

#### Scenario: rule → blue "Rule"
- **GIVEN** `type="rule"`
- **WHEN** 渲染
- **THEN** 文本含 "Rule", className 含 "blue-100"

#### Scenario: fact → green "Fact"
- **GIVEN** `type="fact"`
- **WHEN** 渲染
- **THEN** 文本含 "Fact", className 含 "green-100"

#### Scenario: process → yellow "Process"
- **GIVEN** `type="process"`
- **WHEN** 渲染
- **THEN** 文本含 "Process", className 含 "yellow-100"

### Requirement: MemoryList 组件 (filter + 卡片列表)
`packages/webui/web/src/components/memory/MemoryList.tsx` SHALL 渲染左列 300px 宽 filter UI + atom 卡片列表。filter 逻辑: type multi-select (数组包含即 pass), archived 3 态 (active/archived/all), tag (chip 包含), q (title/摘要 case-insensitive substring)。filter 逻辑抽到 `lib/memoryFilter.ts` 的 `applyFilter(atoms, filter)` 函数。

#### Scenario: 默认显示 active atoms
- **GIVEN** 4 atoms (1 rule, 1 fact, 1 process, 1 archived)
- **WHEN** `filter = {archived: "active"}` (默认)
- **THEN** 渲染 3 张卡片 (排除 archived)

#### Scenario: archived="archived" 显示归档
- **GIVEN** 1 archived atom + 3 active
- **WHEN** `filter.archived = "archived"`
- **THEN** 渲染 1 张卡片, 标 "Archived" 灰

#### Scenario: type multi-select 过滤
- **GIVEN** 4 atoms 跨 3 types
- **WHEN** `filter.type = ["rule", "fact"]`
- **THEN** 渲染 2 张卡片 (rule + fact), 不含 process

#### Scenario: q free-text 命中 title/摘要
- **GIVEN** atom A title "PDF 图片提取", atom B title "CCA 散点图"
- **WHEN** `filter.q = "pdf"`
- **THEN** 渲染 atom A, 不渲染 B (case-insensitive substring)

#### Scenario: 0 atom 空态
- **GIVEN** atoms 数组空
- **WHEN** 渲染
- **THEN** 渲染 "No memories yet" placeholder

### Requirement: MemoryEditor 组件 (useAutoSave 集成)
`packages/webui/web/src/components/memory/MemoryEditor.tsx` SHALL 渲染 metadata form (title / type select / importance slider / tags chip input / summary textarea) + body editor (Edit/Preview tab) + MemoryEditorStatus 状态条。`useAutoSave<Partial<MemoryAtom>>` 集成, patching 期间 input 不可编辑。

#### Scenario: 改 title → 3s 后 PATCH 触发
- **GIVEN** MemoryEditor mount, atom 装入
- **WHEN** user 改 title input 并停手 3s
- **THEN** `onPatch(id, {title: "new"})` 被调, 状态条 "Saving…" → "Saved 1s ago"

#### Scenario: onPatch 抛错 → 状态条 "Save failed"
- **GIVEN** MemoryEditor mount, useAutoSave 处于 saving
- **WHEN** onPatch reject
- **THEN** 状态条显示 "Save failed" 红色 + Retry 按钮

#### Scenario: 改回原值 (hash 不变) 不触发
- **GIVEN** title 改到 "new" 又改回 "old"
- **WHEN** 等 3s
- **THEN** 不调 onPatch (因为 diff 为空)

#### Scenario: patching 期间 input 不可编辑
- **GIVEN** useAutoSave 处于 saving
- **WHEN** 渲染
- **THEN** 所有 metadata input `disabled={true}`

### Requirement: MemoryEditorStatus 组件 (状态条)
`packages/webui/web/src/components/memory/MemoryEditorStatus.tsx` SHALL 渲染一行状态条: idle=空白, dirty=灰 "Unsaved changes…", saving=蓝 "Saving…", saved=绿 "Saved Xs ago", error=红 "Save failed" + Retry 按钮。

#### Scenario: idle 空白
- **GIVEN** `state="idle"`
- **WHEN** 渲染
- **THEN** 文本空 / className `h-6`

#### Scenario: dirty "Unsaved changes"
- **GIVEN** `state="dirty"`
- **WHEN** 渲染
- **THEN** 文本 "Unsaved changes"

#### Scenario: saving "Saving…"
- **GIVEN** `state="saving"`
- **WHEN** 渲染
- **THEN** 文本 "Saving…", className 含蓝色

#### Scenario: error "Save failed" + Retry 按钮
- **GIVEN** `state="error"`
- **WHEN** 渲染
- **THEN** 文本 "Save failed", 红色 + Retry 按钮

### Requirement: MemoryDetail 组件 (atom 装入 + 归档 toggle)
`packages/webui/web/src/components/memory/MemoryDetail.tsx` SHALL 装入 atom 后渲染 header + MemoryEditor + 底部 [Archive]/[Restore] 按钮 (不走 debounce, 立即触发); null atom 时渲染 placeholder。

#### Scenario: null atom placeholder
- **GIVEN** `atom = null`
- **WHEN** 渲染
- **THEN** 文本 "Select an atom from the list"

#### Scenario: 装入 atom 渲染编辑器
- **GIVEN** `atom` 非空
- **WHEN** 渲染
- **THEN** header + MemoryEditor + 归档按钮可见

#### Scenario: Archive 按钮立即触发 (不 debounce)
- **GIVEN** atom.archived=false
- **WHEN** 点 Archive
- **THEN** `onArchive(id, true)` 立即被调 (不经 3s timer)

#### Scenario: Restore 按钮立即触发
- **GIVEN** atom.archived=true
- **WHEN** 点 Restore
- **THEN** `onArchive(id, false)` 立即被调

### Requirement: MemorySearchTester 组件 (query + results table)
`packages/webui/web/src/components/memory/MemorySearchTester.tsx` SHALL 渲染 query input + Search 按钮 + results table (distance/cosine/type/title/strength/importance 列)。空 results 时显示 "No results (embedding service unavailable)"。

#### Scenario: 输入 query + 点 Search 触发 fetch
- **GIVEN** query="PDF", topK=10
- **WHEN** 点 Search 按钮
- **THEN** `fetch` 被调 with `POST /api/memory/search` body `{"query":"PDF","topK":10}`

#### Scenario: mock fetch 返 results → 表格渲染
- **GIVEN** fetch mock 返 `{results: [{atom, distance, cosine_similarity}], recallTimeMs: 50}`
- **WHEN** Search 触发
- **THEN** 表格渲染 1 行, 显示 distance/cosine/type/title/strength/importance

#### Scenario: 空 results → "unavailable" 文案
- **GIVEN** fetch mock 返 `{results: []}`
- **WHEN** Search 触发
- **THEN** 文本 "No results (embedding service unavailable)" 出现

### Requirement: MemoryPage 顶层装配
`packages/webui/web/src/pages/MemoryPage.tsx` SHALL 是路由 entry, mount 时调 `api.memory.list({archived: "active"})`, 3s `setInterval` 拉新 (unmount `clearInterval`), 用 `applyFilter` filter atoms, 渲染 2-column grid `grid-cols-[300px_1fr]`, 左 `MemoryList`, 右 `MemoryDetail`。

#### Scenario: mount → 拉 list
- **GIVEN** MemoryPage mount
- **WHEN** mount 完
- **THEN** `api.memory.list({archived: "active"})` 调 `GET /api/memory?archived=active`, 列表渲染

#### Scenario: 3s 轮询
- **GIVEN** MemoryPage mount
- **WHEN** 等 3s
- **THEN** refetch `GET /api/memory?archived=active` 触发; unmount 后 clearInterval 不再拉

#### Scenario: PATCH 成功后 refetch 单条
- **GIVEN** MemoryEditor 调 onPatch
- **WHEN** PATCH 200
- **THEN** refetch `GET /api/memory/<id>` 拿到 fresh atom, 更新 list 中对应行

#### Scenario: 归档后 refetch list
- **GIVEN** user 点 Archive 按钮
- **WHEN** `api.memory.archive(id, true)` 200
- **THEN** refetch `GET /api/memory?archived=active` 拉新 (或 client-side 移除该 atom)

### Requirement: Sidebar IconRow 加 Memory icon
`packages/webui/web/src/components/sidebar/IconRow.tsx` SHALL 在现有 Chat / Cron 2 icon 之后加第 3 个 Memory icon (`Brain` from lucide-react), 链 `/memory`, active 状态判断 `pathname.startsWith('/memory')`。**不动现有 2 icon**。

#### Scenario: /memory 路由 active 时 icon 高亮
- **GIVEN** pathname = "/memory"
- **WHEN** 渲染 IconRow
- **THEN** Memory icon className 含 "bg-blue-100" (active), Chat/Cron 灰色

#### Scenario: 其它路由 active 时 Memory 灰色
- **GIVEN** pathname = "/session/123" 或 "/cron"
- **WHEN** 渲染 IconRow
- **THEN** Memory icon 灰色, 对应路由 icon 高亮

### Requirement: App.tsx 加 /memory 路由
`packages/webui/web/src/App.tsx` SHALL import `MemoryPage` 并加 `<Route path="/memory" element={<MemoryPage />} />`, 与现有 `/cron` 路由平行。**不动其它 route 或 ShellWrapper**。

#### Scenario: 访问 /memory 渲染 MemoryPage
- **GIVEN** BrowserRouter mount
- **WHEN** pathname = "/memory"
- **THEN** `<MemoryPage />` 渲染在 Outlet 内

#### Scenario: 现有路由不受影响
- **GIVEN** App.tsx 改后
- **WHEN** 跑所有 webui web 测试
- **THEN** 现有 6 个 web test files + CronPage / ChatPage / EmptyChat 行为不变

## MODIFIED Requirements

无。本变更不修改现有 Capability。

## REMOVED Requirements

无。本变更不删除现有 Capability。

## RENAMED Requirements

无。
