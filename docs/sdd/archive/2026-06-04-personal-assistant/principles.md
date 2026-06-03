# 设计原则

## 1. 忠实迁移
每个功能严格遵循 nanobot 源码的算法和流程, 不是\`参考思路自己写\`。
- 注入 = QueryRewriter + FTS5 + embedding 混合 + `<memory-context>`
- 提取 = search 已有记忆 + extract.md prompt + JSON plan + 报告
- 衰减 = constraint 豁免 + exp 公式 + archive

## 2. Fork 友好
- 个人助手代码: `<fork>/extensions/personal-assistant/`
- Pi 源码改动: `loader.ts` 加 1 个 discovery 源 + `settings-manager.ts` 加接口
- 运行时数据: `~/.pi/agent/data/` (不进 repo)
- 配置: 嵌入 Pi 的 `settings.json`, 不改配置体系

## 3. 全自动记忆
记忆系统不注册任何工具。注入、提取、衰减全部通过事件钩子自动执行。
LLM 不需要也不应该手动操作记忆。

## 4. 同类工具合并
同一资源的 CRUD 合并为单个工具 (todo_write, cron_write),
避免工具列表膨胀和多余的 round-trip。
完全不同操作的工具保持拆分 (web_search, web_fetch)。

## 5. 数据可读
记忆: YAML frontmatter + Markdown 文件 (`<data>/memory/atoms/{type}/{slug}.md`)
索引: SQLite FTS5 `<data>/memory.db`
待办 + cron: 结构化 JSON
用户可直接查看编辑。

## 6. 降级策略
- Embedding: Ollama bge-m3 不可用时 -> 仅 FTS5 关键词搜索
- Query rewriting: LLM 失败时 -> jieba 关键词 + 所有类型
- 搜索引擎: Tavily 不可用时 -> DuckDuckGo 无 key 降级

## 7. 最小侵入
- 不改 Pi 核心工具集
- 不改 Pi agent loop
- 不改 Pi 事件系统
- 全部通过 Extension API + 类型定义扩展实现

## 8. 渐进增强
Phase 1: 加载机制 + SOUL/USER + 记忆 (注入 + 提取 + 衰减)
Phase 2: todo_write + cron_write + web_search + web_fetch
Phase 3: skill 迁移 + prompt 模板
