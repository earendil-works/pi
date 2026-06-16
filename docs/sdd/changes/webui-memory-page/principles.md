# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- **`MemoryIndex` 是 personal-assistant 的 public API**：class 和 `searchAtoms` / `rewriteQuery` / `writeAtomToFile` 必须 export，webui server 通过 tsconfig path mapping 直接 import，不重复实现 SQLite 读写
- **`.md` 文件是 single source of truth，DB 是索引**：body 编辑必须重算 hash、可能重写文件、可能迁移 `file_path`、必重建 FTS 行、必清 embedding
- **编辑必落盘**：3s debounce + 路由切换 / 关闭 tab / 刷新页面时强制 flush pending save，不丢用户输入
- **Recall 测试 = 真实 pipeline**：不 mock、不写测试专用的 search 函数；调真实的 `rewriteQuery` + `searchAtoms`，展示分项分数让用户能定位召回失败原因
- **v1 不做 create / delete atom**：atom 由抽取流程自然生成，UI 手动 create 容易污染模型对真实用户偏好的判断；delete 用归档（`archived=true`）替代
- **编辑失败 = 视觉反馈 + 一次重试**：toast 提示、in-memory 值回滚、3s 后再试一次，第二次失败停手，不无限循环
