# 变更提案: webui-memory-page

## 动机

Memory v2 (`memory-v2-refactor` 已 archive) 已为 Agent 提供持久化记忆:被动注入
`<memory-context>`、compaction 抽取、纯向量 (sqlite-vec + bge-m3) 召回、content
fingerprint dedup、rule 永不衰减。

后端 7 个 REST routes (list / get / patch / archive / search / extract / stats)
在 `memory-v2-refactor` 已交付,46 个 server 单测覆盖。整套机制在 Agent 运行侧
闭环,但用户侧**完全黑盒**:

- **不可见**: 用户看不到记忆里存了什么,只能从 Agent 注入的 `<memory-context>` 间接观察
- **难调试**: 召回质量出问题(命中错/漏召)时,无法复现 "LLM 这次为什么召回这条 atom"
- **无法修正**: LLM 抽错、过期偏好想删除? 只能等下次 compaction 重抽

这个变更在 webui 加一个 `/memory` 页面,让用户**浏览 / 召回测试 / 编辑 / 归档** 记忆。

## 影响范围

- **后端**: 0 行新代码。`packages/webui/server/routes/memory.ts` 的 7 routes 已存在。
  本变更不修改后端。
- **新增 Capability: `webui-memory-page`**
  - client 页面: `packages/webui/web/src/pages/MemoryPage.tsx`
  - client 组件: `packages/webui/web/src/components/memory/{MemoryList, MemoryDetail, MemoryEditor, MemorySearchTester, MemoryTypeBadge, MemoryEditorStatus}.tsx`
  - client hook: `packages/webui/web/src/lib/useAutoSave.ts`
  - client API: `packages/webui/web/src/lib/api.ts` 增 `memory.*` 命名空间 (7 methods)
  - 路由接入: `packages/webui/web/src/App.tsx` 加 `/memory` route
  - 导航: `packages/webui/web/src/components/AppShell.tsx` (或 Sidebar) 加 Memory icon
  - 客户端测试: 4-5 个 React Testing Library 组件测试 + 1 个 useAutoSave hook 测试
- **修改 Capability**: 无 (纯新增 UI,不修改现有 chat/cron/settings/sessions 组件)

## 非目标

- **不做 create / delete atom**: atom 由抽取流程自然生成,UI 手动 create 容易污染模型对真实用户偏好的判断;删除用归档 (`archived=true`) 替代
- **不做编辑后立即重算 embedding**: PATCH 后删除 vector,下次 recall 走 lazy recompute (服务端 PATCH 已实现此行为)
- **不做 TUI ↔ webui 实时同步**: 3s 轮询拉新 + 手动 Refresh;WebSocket 推送 v2
- **不做版本历史 / 审计日志**: v1
- **不做 bulk 操作** (多选批量归档): v1
- **不做 `$EDITOR` 集成**: 用内置 textarea + preview tab
- **不做大 DB 虚拟列表** (10k+ atom): 简单 list + limit=200 + 分页 + 警告
- **不做新后端 routes / 不改 memory.ts / storage.ts**: 后端完整且经过 855/855 tests 验证

## 验收标准

1. **列表**: 打开 `/memory` 看到所有 `archived = 0` 的 atom;按 `type` 多选过滤、按
   `tag` 过滤、`archived` 切含归档、free-text 搜 title/摘要
2. **详情**: 点击列表项装入详情;显示 `type / title / summary / importance /
   strength / access_count / tags / created_at / updated_at / last_access /
   archived` + 从 `.md` 文件读出的完整 `content` body
3. **metadata 编辑**: title / type / importance / tags / summary 任意字段变更后
   3s 静默期触发 `PATCH /api/memory/:id`;header 状态条显示 `Saving…` → `Saved
   Ns ago`;失败回滚原值 + 红色 toast + 一次重试
4. **body 编辑**: body textarea 变更后 3s 触发 `PATCH`;server 端重算 `content_hash`
   (frontmatter `updated_at` 变);**`.md` 文件路径在 v2 用 atom.id 命名,不变**;
   重建 vector (服务端 PATCH 已实现)
5. **归档**: UI `Archive` / `Restore` 按钮 toggle `archived`,立即 PATCH,不走
   3s debounce
6. **召回测试**: 左侧底部折叠面板,输入 query,调真实 `recallAtoms(index, query, topK)`,
   展示每条 atom 的 `distance`/`cosine_similarity`/`strength`/`importance`;
   ollama 不可用时返空结果,UI 显示 "No results (embedding service unavailable)"
7. **flush**: 路由切换离开 `/memory`、关闭 tab、刷新页面前,未保存的编辑强制
   同步提交 (`useAutoSave` cleanup 取消 pending timer、await in-flight PATCH,
   200ms 兜底超时)
8. **空态**: DB 文件不存在 (首次安装) 时显示 "No memories yet" 而非 500
9. **导航**: sidebar 加 `Memory` icon (与 `Cron` 平行);路由 `/memory`
10. **回归**: `packages/webui` 现有 routes (health / cron / sessions / models /
    settings / static) 行为不变;`createApp` mount 顺序不变;`runMemoryExtraction`
    路径不变

## 数据流

**打开详情**: `MemoryList` click → `setSelectedId(id)` → `MemoryDetail` 调
`GET /api/memory/:id` → 渲染 metadata form + body editor (preview tab)

**编辑 metadata**: input onChange → local state `patch` → `useAutoSave` 接管 →
3s 静默 → `PATCH /api/memory/:id {partial}` → server merge + `updateAtom` +
`deleteVector` → 200 → client 标 "Saved"

**编辑 body**: body editor onChange → `patch.content` → debounce 3s → PATCH →
server 写新 frontmatter + body → 算 hash → 写 `.md` (atom.id 文件名不变) →

**归档**: 点 `Archive` → 立即 (不走 debounce) `POST /api/memory/:id/archive
{archived: true}` → server `markArchived(id)` → 200 → client 切到 list 状态

**Recall 测试**: 输 query → 点 `Search` → `POST /api/memory/search
{query, topK}` → server `recallAtoms(index, query, topK)` → 返回
`{results: [...], recallTimeMs, tokenBudgetUsed}` → 渲染列表 + hover 详情
