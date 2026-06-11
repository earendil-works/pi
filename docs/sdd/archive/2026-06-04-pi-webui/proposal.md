# 变更提案: pi-webui

## 动机
pi 是 TUI-only 的 coding agent，用户在终端使用，无法在浏览器中并行管理多个会话、查看定时任务、或在多设备访问。Hermes 通过 WebUI + 多 session + cron 已经证明这条路径可行。pi-webui 目标：基于 pi 现有 RPC 模式（不改 pi），构建独立 Web 面板，让用户能在浏览器中并行与多个 pi session 交互；session 被删除时自动 LLM 抽取记忆原子（atoms）注入已有的 memory 系统，避免知识丢失。

复盘发现已有能力：
- `extensions/personal-assistant/cron.ts` 已实现一个 4-action 的 `cron_write` 工具（add/list/remove/toggle）+ session_start 时检查 overdue 任务
- `extensions/personal-assistant/memory.ts` 已有完整 memory 原子系统：SQLite FTS5 索引、7 种 atom 类型（constraint/preference/workflow/knowledge/event/solution/insight）、importance/strength 评分、decay、query rewrite、embedding 检索、自动注入到 system prompt

本变更**复用这两个系统**而不是新建。

## 影响范围
- 新增 Capability:
  - `Web Dashboard`: Node.js/React SPA + Vite，提供浏览器访问入口。包含 3 个主视图：Sessions、Chat、Cron Dashboard
  - `Session Pool`: Web Server 进程池，每个 session = 一个独立 pi `--mode rpc` 进程
  - `Web Server`: Node.js 后台进程（独立 npm package 或 `packages/webui/`），提供 HTTP + WebSocket + 静态文件服务
  - `Cron Dashboard`: 独立路由 `/cron` 的表盘视图，用户在此查看/管理所有定时任务（cron jobs 即"代办"——按 schedule 触发的待办事项）。包含：
    - 列表视图：所有 jobs（含 name、schedule 人类可读字符串、enabled toggle、状态、最后执行时间、下次执行时间）
    - 创建/编辑表单：name、prompt、schedule（at/every/cron 三选一）、enabled
    - 单 job 操作：暂停/恢复、立即触发、删除
    - Last-run 详情：每个 job 展开显示 last_run 时间、last_run_status（从 cron.json 直接读）、next scheduled（从 schedule 计算）
  - `Session Deletion Handler`: Web Server 在删除 session 前调用 LLM 抽取 atoms，写入 `~/.pi/agent/data/memory.db`
  - `Web CLI flag`: `pi --web` 启动 Web Server（子进程），访问 `http://127.0.0.1:PORT`
- 修改 Capability:
  - `extensions/personal-assistant/cron.ts`: 扩展 `cron_write` 工具从 4 actions 增加到 5 actions（新增 `trigger_now`），保持单 tool；并在 job 完成时记录 `last_run_at` 和结果摘要到 JSON（供 WebUI 展示历史）
  - `pi CLI`: 新增 `--web` flag（最小改动，仅 spawn 子进程并打印 URL）
- 删除 Capability: 无

## 非目标
- 修改 pi 核心（agent loop、session-manager、extension API、RPC mode 内部都不改）
- 提供跨设备/公网访问（仅 loopback bind 127.0.0.1）
- 实现 todo 系统（用户明确排除；cron jobs 即本系统的"代办"——按时间表触发的待办）
- 在 Web 中提供 xterm 嵌入式终端（本期只做 React 渲染 chat，不做 TUI 嵌入）
- 多用户/多账号/认证系统（单用户本地使用）
- 移动端响应式优化（仅桌面浏览器）
- 多 profile 并行 agent（每个 session 一个 agent，不做 swarm）
- 离线/无 LLM 模式（始终依赖 LLM API）
- 重建 cron 存储或 memory 存储（必须复用现有 `cron.json` 和 `memory.db`）
- 重新设计 `cron_write` schema（保持现有 4 actions 兼容，仅追加 `trigger_now`）
- 在 Cron Dashboard 做高级过滤/搜索/标签（本期只是基础 CRUD + 历史）

## 验收标准
- [ ] `pi --web` 启动后，浏览器访问 URL 能看到 dashboard，包含 3 个主视图：Sessions（默认）、Chat（选中 session 后）、Cron Dashboard（`/cron` 路由）
- [ ] Sessions 视图：左侧 session 列表，右侧 chat 区域
- [ ] 用户能创建新 session，发送消息，实时看到流式响应和 tool 调用结果
- [ ] 用户能在多 session 间切换：切换时其他 session 继续在后台运行（pi 进程不退出）
- [ ] Web UI 显示每个 session 的状态：idle / running / error
- [ ] **Cron Dashboard 视图** (`/cron`)：
  - 顶部列出所有 cron jobs，每行显示：name、schedule 人类可读（如 "every day at 09:00"）、enabled toggle、状态（enabled/disabled）、上次执行时间、下次执行时间
  - 顶部 "+ New Cron" 按钮打开创建表单（name / prompt / schedule 三选一 / enabled）
  - 每行操作：Pause/Resume 按钮、Trigger Now 按钮（闪电图标）、Edit 按钮、Delete 按钮（带确认）
  - 点击行展开看 last-run 详情（last_run 时间、last_run_status ok/error、next scheduled 推断时间；不存储完整历史）
  - 空状态友好提示 "No scheduled tasks yet. Add one to get started."
- [ ] Cron 列表数据直接读 `~/.pi/agent/data/cron.json`，UI 操作通过 Web Server 写回同一文件（保持单一数据源）
- [ ] 用户在 pi TUI 的对话中输入"每天 9 点拉 GitHub issues 总结"，agent 调用 `cron_write({operations: [{action: "add", ...}]})` 成功，WebUI Cron Dashboard 立即显示新 job（共享同一 JSON 文件，无需通知）
- [ ] Cron 到时间自动触发：依赖 `session_start` 事件触发（已有逻辑），不依赖 Web Server 运行；用户下次开任意 pi session 时 overdue jobs 自动以 followUp 消息形式执行
- [ ] Web UI 列出 session 列表（含正在 TUI 中活跃的 session，因为读的是 `~/.pi/agent/sessions/` 目录）
- [ ] Web UI 中删除一个 session 时，先调用 LLM 抽取 atoms（用当前 default model），atoms 写入 `~/.pi/agent/data/memory.db`；之后才删除 session JSONL 文件
- [ ] 抽取失败时不阻止删除（已有 memory 系统在 compaction 时也会兜底抽取）
- [ ] 新 session 创建时，**不重复注入**——memory 系统已有的 `before_agent_start` 钩子已经自动注入；WebUI 不需做这件事
- [ ] pi 核心代码（`packages/coding-agent/src/`、`packages/ai/`、`packages/agent/`）git diff 为 0 或仅 1 个文件（仅 `--web` flag）
- [ ] Web Server 进程退出时，所有 spawn 的 pi 子进程被优雅清理（SIGTERM，超时后 SIGKILL）
- [ ] 重启 Web Server 后，所有 session 状态从磁盘恢复（直接从 session JSONL 解析）
- [ ] `cron_write` 工具仍向后兼容 4-action 调用（不破坏现有 TUI/extension 调用方）
