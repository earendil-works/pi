# 变更提案: webui-memory-page

## 动机

Personal-assistant 扩展（`extensions/personal-assistant/memory.ts`）已为 Agent
提供持久化记忆：被动注入 `<memory-context>`、compaction 抽取、decay 衰减、embedding
混合召回。整套机制在 Agent 运行侧是闭环的，但用户侧完全黑盒：

- **不可见**：用户看不到记忆里存了什么，只能从 Agent 注入的 `<memory-context>` XML
  块间接观察
- **难调试**：召回质量出问题（命中错/漏召）时，无法复现"LLM 这次为什么召回这条 atom"
- **无法修正**：手输错、LLM 抽错、过期偏好想删除？只能等下次 compaction 重抽
- **API 不通**：`MemoryIndex` 类目前没 export，webui server 拿不到；唯一暴露的
  `runMemoryExtraction` 是删除 session 时的单次调用入口

这个变更在 webui 加一个 `/memory` 页面，让用户能 **浏览 / 召回测试 / 编辑 / 归档** 记忆，
server 端把 `MemoryIndex` 升级为 public API。

## 影响范围

- **新增 Capability: `webui-memory-page`**
  - server: `GET /api/memory`、`GET /api/memory/:id`、`PATCH /api/memory/:id`、
    `POST /api/memory/:id/archive`、`POST /api/memory/search`、`GET /api/memory/stats`
  - client: `pages/MemoryPage.tsx` + `components/memory/{MemoryList, MemoryDetail, MemoryEditor, MemorySearchTester, MemoryTypeBadge}.tsx`
  - client API: `lib/api.ts` 新增 memory 命名空间
- **修改 Capability**: 无（纯新增，不动现有 `chat-message-rendering` / `satellite-remote-exec` / `ask-user-question-tool`）
- **修改源码模块**（为支持 export + 加几个 helper，不改行为）:
  - `extensions/personal-assistant/memory.ts`：
    - `class MemoryIndex` → `export class MemoryIndex`
    - `interface MemoryAtom` / `type MemoryAtomType` → `export`
    - `searchAtoms` / `rewriteQuery` / `writeAtomToFile` / `readAtomFromFile` → `export`
    - `const ATOMS_DIR` / `const MEMORY_DB_PATH` → `export const`
    - **新增** `function getAllAtoms(index)`（含 archived 的全量 list）
    - **新增** `function rewriteQueryWithCallLlm(callLlm, query, config)`
      （server 用，绕开 `ExtensionContext.modelRegistry` 依赖）
    - **新增** `function searchAtomsWithScores(index, query, topK)` →
      `{results: Array<{atom, fts_score, cosine_score, hybrid_score}>, embedding_available: boolean}`
    - **新增** `method MemoryIndex.invalidateEmbedding(id)`（封装
      `DELETE FROM memory_embeddings WHERE id = ?`，避免 export 私有 `db` 字段）
  - `extensions/personal-assistant/index.ts`：re-export 新加的 symbols

## 非目标

- **不做 create / delete atom**：v1。Atom 由抽取流程自然生成，UI 手动创建容易污染模型对"用户偏好"的判断（v2 视情况）
- **不做编辑后立即重算 embedding**：v1 编辑后只 `DELETE FROM memory_embeddings WHERE id = ?`，下次访问走 lazy recompute（v2 单独加）
- **不做 TUI ↔ webui 实时同步**：v1 用 3s 轮询 + 手动 Refresh 按钮；WebSocket 推送 v2
- **不做版本历史 / 审计日志**：v1
- **不做 bulk 操作**（多选批量归档/删除）：v1
- **不做 Open in Editor（`$EDITOR` 集成）**：v1 用内置 textarea + preview tab

## 验收标准

1. **列表**：打开 `/memory` 看到所有 `archived = 0` 的 atom；按 `type` 多选过滤、按
   `tag` 过滤、按 `archived` 切含归档、free-text 搜 title/摘要
2. **详情**：点击列表项右侧装入详情；显示 `type / title / importance / strength /
   access_count / created_at / updated_at / last_access / file_path` 全部 metadata
   + 从 `.md` 文件读出的完整 `content` body
3. **metadata 编辑**：title / type / importance / tags / summary 任意字段变更后
   3s 静默期触发 `PATCH /api/memory/:id`；header 状态条显示 `Saving…` → `Saved Ns ago`；
   失败回滚原值 + 红色 toast
4. **body 编辑**：body textarea 变更后 3s 触发 `PATCH`；server 端重算
   `content_hash`；若 hash 变则写新 `.md` 文件、删旧文件、更新 `file_path` /
   `content_hash`、重建 FTS 行、清掉旧 embedding
5. **归档**：UI 上 `Archive` / `Restore` 按钮 toggle `archived`，立即 PATCH，不走
   3s debounce
6. **召回测试**：左侧底部折叠面板，输入 query，调真实 `rewriteQuery` +
   `searchAtoms`，展示 `keywords[]` / `target_types[]` + 每条 atom 的 `fts_score` /
   `cosine_score` / `hybrid_score`；Ollama 不可用时降级纯 FTS，UI 显示 "embedding
   unavailable"
7. **flush**：路由切换离开 `/memory`、关闭 tab、刷新页面前，未保存的编辑强制
   同步提交（`useAutoSave` cleanup 取消 pending `setTimeout` timer、await in-flight
   PATCH 完成，200ms 兜底超时防止后端挂死时页面卡住）
8. **空态**：DB 文件不存在（首次安装）时显示 "No memories yet" 而非 500
9. **路径**：sidebar IconRow 加 `Memory` icon；路由 `/memory`（与现有 `/cron` 平行）
10. **回归**：`packages/webui` 现有 5 个 route mount（health / cron / sessions /
    models / settings）行为不变；`createApp` mount 顺序不变（`mountMemoryRoutes`
    插在 static catch-all 之前）；`/api/sessions/:id` 删 session 时的
    `runMemoryExtraction` 流程不变
