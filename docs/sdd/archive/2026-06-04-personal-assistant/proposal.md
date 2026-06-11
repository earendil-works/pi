# 变更: Pi 个人助手定制

## 动机
Pi 是优秀的编码助手，但缺少个人助理能力。参考 nanobot，基于 Pi TUI 模式构建嵌入式个人助手。

## 架构决策
- 方案: fork 仓库根目录 `extensions/` + 改 `loader.ts` 1 行新增 discovery 源
  `来源: openclaw repo 结构`
- 运行时数据: `~/.pi/agent/data/` (memory.db, memory/, todo.json, cron.json)
- 配置: 嵌入 Pi `settings.json` 的 `personalAssistant` 段，API key 直接配置

## 范围

### 必须

- [ ] **SOUL.md + USER.md 注入** `来源: nanobot/templates/SOUL.md + USER.md + memory/persona_manager.py`
  注入点: 构建 system prompt 时 (persona_manager: `_load_persona()` -> `build_system_prompt()`)
  Pi 实现: `before_agent_start` 事件读取文件注入

- [ ] **记忆系统 (完整)**
  `来源: nanobot/memory/atom.py + memory_index.py + inject.py + query.py + memory_extractor.py + decay_task.py + templates/memory/extract.md + templates/memory/query_rewrite.md`
  全自动，不注册工具:
  - **注入**: QueryRewriter(LLM) -> MemoryIndex.search(FTS5 + embedding 混合) -> `<memory-context>` XML 拼在 user message 前
  - **提取**: search 已有记忆 -> render extract.md -> LLM 返回 JSON plan -> 写报告 + create/update/skip
  - **仅 `session_before_compact` 触发**, 会话关闭不提取
  - **衰减**: constraint 永不过期, 其他按公式 + archive

- [ ] **配置系统** `来源: nanobot/config/schema.py MemoryConfig + WebSearchConfig`
  嵌入 Pi `settings.json` 的 `personalAssistant` 段, 配置 agent/subagent/memory/search 模型和参数
  Pi 源码改动: `settings-manager.ts` 新增 `PersonalAssistantConfig` 接口族

- [ ] **扩展发现** `来源: 方案A`
  `loader.ts` 新增 `<repo>/extensions/` 扫描源
  Pi 源码改动: `loader.ts` `discoverAndLoadExtensions()` 加一行

### 应该

- [ ] **`todo_write` 工具** `来源: nanobot/agent/todo.py`
  合并 CRUD: `{todos: [{action: "add"|"done"|"update", content?, id?, priority?}], merge: bool}`
- [ ] **`cron_write` 工具** `来源: nanobot/cron/service.py + types.py`
  合并 CRUD: `{operations: [{action: "add"|"list"|"remove"|"toggle", name?, schedule?, prompt?, id?, enabled?}], merge: bool}`
- [ ] **`web_search` 工具** `来源: nanobot/agent/tools/search.py`
- [ ] **`web_fetch` 工具** `来源: nanobot/agent/tools/web.py`

### 可选

- [ ] weather skill `来源: nanobot/skills/weather/`
- [ ] frontend-slides skill `来源: nanobot/skills/frontend-slides/`
- [ ] frontend-design skill `来源: nanobot/skills/frontend-design/`
- [ ] skill-creator skill `来源: nanobot/skills/skill-creator/`
- [ ] 提示模板 /remember /todo /weekly /summary `来源: 新增`

### 排除

- HEARTBEAT `来源: nanobot/templates/HEARTBEAT.md` -- TUI 无持续轮询
- 多平台通道 `来源: nanobot/channels/` -- 需 daemon
- my skill `来源: nanobot/skills/my/` -- Pi 已有 ExtensionAPI
- opencode-coder `来源: nanobot/skills/opencode-coder/` -- Pi 自身即 agent
- tmux `来源: nanobot/skills-cract/tmux/` -- 非核心

### 验收标准

1. SOUL.md + USER.md 在 system prompt 中可见
2. `session_before_compact` 触发记忆提取 (create/update/skip), 下次会话可召回
3. 注入: query rewrite -> FTS5 + embedding 混合 -> `<memory-context>` 拼入 user message
4. constraint 永不过期, 其他类型按衰减公式归档
5. `todo_write` 可批量增删改查
6. `cron_write` 可管理定时任务, `session_start` 检查逾期执行
7. `web_search` + `web_fetch` 返回有效结果
8. `loader.ts` 改动后, `extensions/personal-assistant/` 从任意路径启动 pi 均加载
