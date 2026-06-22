# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- **不重写后端**: memory v2 后端 (sqlite-vec + 7 REST routes + 46 server tests)
  已 archive 并通过 855/855 tests;本变更只新增 React 端组件 + 1 个 useAutoSave
  hook + 1 个 API client 命名空间
- **不重排路由**: `mountMemoryRoutes` 的 7 routes 顺序 (static 先于 `:id`) 已是
  v2 验证;不重新排;新组件不引入新 REST 路径
- **后端 0 改动**: `extensions/personal-assistant/{memory,storage,embed,extraction,
  search,format,decay,file-store,types,index}.ts` 一行不改;`packages/webui/server/
  routes/memory.ts` 一行不改
- **`.md` 文件是 single source of truth,DB 是索引**: body 编辑必须重算 hash、
  重写文件、可能迁移 `file_path` (type 变时);必清 memory_vectors;v2 文件名
  固定 `<atom.id>.md`,不再基于 title slug
- **编辑必落盘**: 3s debounce + 路由切换 / 关闭 tab / 刷新页面时强制 flush
  pending save,不丢用户输入
- **Recall 测试 = 真实 pipeline**: 不 mock、不写测试专用的 search 函数;调
  `recallAtoms(index, query, topK)`,展示每条 atom 的 distance/cosine 让用户
  能定位召回失败原因
- **不做 create / delete atom**: atom 由抽取流程自然生成,UI 手动 create 容易
  污染模型对真实用户偏好的判断;删除用归档 (`archived=true`) 替代
- **编辑失败 = 视觉反馈 + 一次重试**: toast 提示、in-memory 值回滚、3s 后再试
  一次,第二次失败停手,不无限循环
- **3s 轮询拉新** (不 WebSocket): 详情 3s 拉一次,list 3s 拉一次;离开路由
  `clearInterval` + `useAutoSave` cleanup 双重保险
- **新增组件导入限制**: 新增 React 组件放 `packages/webui/web/src/components/
  memory/` 子目录;不污染 `components/` 顶层;API client 增 `memory.*` 命名空间,
  不和 chat/sessions API 混

## 不在范围 (v1 webui 限制)

- 不做 TUI ↔ webui 实时同步 (WebSocket 推送 v2)
- 不做版本历史 / 审计日志
- 不做 bulk 操作
- 不做 `$EDITOR` 集成 (用 textarea + preview tab)
- 不做 10k+ atom 虚拟列表 (简单 list + limit=200)
- 不在 v1 加 embedding 异步重算 (server PATCH 已删 vector,下次 recall lazy recompute)
