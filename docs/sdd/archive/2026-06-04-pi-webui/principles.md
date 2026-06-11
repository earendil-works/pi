# 本变更原则

- pi 核心代码不被 WebUI 改动，WebUI 进程通过 RPC 模式（`pi --mode rpc`）与 pi 通信，所有交互都走 stdin/stdout JSON-line 协议。
- Session 状态完全归属 pi 进程（JSONL 文件 + pi 的 SessionManager），Web Server 只持内存中的 session 引用，重启后从磁盘扫描 `~/.pi/agent/sessions/` 恢复。
- 复用 `extensions/personal-assistant/cron.ts` 已有的 `cron_write` 工具（4-action），仅追加 `trigger_now` action 升级为 5-action；不新建独立的 cron 工具。
- 复用 `extensions/personal-assistant/memory.ts` 已有的 memory atoms 系统（SQLite FTS5）；Web Server 删除 session 时抽取的 atoms 直接写入 `memory.db`，不新建独立的 memory 文件。
- 记忆抽取必须使用现有的 7 种 atom 类型（constraint/preference/workflow/knowledge/event/solution/insight），不发明新的摘要结构。
- 记忆抽取失败不阻止删除（compaction 钩子会兜底），但要让用户知道被跳过了。
- 工具描述优先于 system prompt 描述来约束 cron 行为（如 schedule 必填、prompt 必填）—— "Adapt the tool to the agent, don't try to change the agent" 原则的延伸。
- Web Server 仅绑定 loopback（127.0.0.1），不暴露到公网，所有跨网络访问由用户在终端用 SSH tunnel / ngrok 自行解决。
- Web Server 退出时必须清理所有 spawn 的 pi 子进程（先 SIGTERM，超时 5s 后 SIGKILL），不留僵尸进程。
- WebUI 是单用户本地工具，不实现多账号/认证/权限系统。
- cron 触发依赖 pi 进程（session_start hook），不依赖 Web Server 在线；Web Server 仅做展示。
- Cron Dashboard 是 WebUI 的一级视图（独立路由 `/cron`），不是埋在某页的子模块；用户能直接打开表盘管理所有定时任务，把 cron jobs 当"代办"看待。
- Cron Dashboard 的所有读写直接对 `~/.pi/agent/data/cron.json` 操作，与 TUI/extension 共用单一数据源，无需通知/同步。
