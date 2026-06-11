# 使用场景

## 正常流程

### 场景: 启动 WebUI
**GIVEN** 用户在终端运行 `pi --web` 命令，pi 已安装并配置好至少一个 LLM provider
**WHEN** pi CLI 解析 `--web` 参数，spawn 出 web server 子进程（默认端口 8741，可通过 `--port` 覆盖），web server 启动 HTTP + WebSocket 服务
**THEN** 终端打印 `WebUI running at http://127.0.0.1:8741`，浏览器打开该 URL 看到 dashboard，左侧列出 `~/.pi/agent/sessions/--<cwd>--/` 下的所有 session，右侧带 chat 区域

### 场景: 创建并与 session 对话
**GIVEN** WebUI 已启动，用户在 WebUI 中点击 "+ New Session"，输入 prompt "分析当前目录的 package.json 依赖"
**WHEN** 用户按 Enter
**THEN** Web Server spawn `pi --mode rpc --cwd <当前工作目录>` 子进程，建立 JSON-line stdin/stdout 桥接；session 列表新增项（显示 title 截断、状态 running）；右侧 chat 区域显示用户消息，并随 LLM 流式输出 token 逐字渲染；agent 调用工具时显示 tool call 卡片；任务完成后 session 状态变为 idle

### 场景: 切换 session 而不中断后台
**GIVEN** 用户有两个 session 都在运行：session-A 处理一个长任务（pi 进程 stream 中），session-B 显示空 chat
**WHEN** 用户点击 session-B 切换
**THEN** 右侧 chat 区域切到 session-B；session-A 的 pi 进程继续在后台 stream，没有被打断或暂停；session-A 在 session 列表中显示 running 状态（带动画）；用户可在 session-B 发送新消息，两 session 完全独立

### 场景: 通过对话创建 cron job（5-action 单 tool）
**GIVEN** 用户在某个 pi session 中与 agent 对话，agent 工具白名单包含 `cron_write`
**WHEN** 用户输入"每天早上 9 点提醒我检查邮件"
**THEN** agent 调用 `cron_write({operations: [{action: "add", name: "morning-email", schedule: {kind: "cron", expr: "0 9 * * *"}, prompt: "检查邮件并总结"}]})`；extension 工具（复用现有 `extensions/personal-assistant/cron.ts`）将 job 追加到 `~/.pi/agent/data/cron.json`；Web Server 读同一文件，cron dashboard 页面立即显示新 job；session 中 agent 看到工具返回 "Added job: morning-email"

### 场景: 打开 Cron Dashboard 表盘
**GIVEN** WebUI 已启动，浏览器打开 dashboard
**WHEN** 用户点击左侧导航的 "Cron"（或访问 `/cron` 路由）
**THEN** 主区域显示 Cron Dashboard：顶部 "Cron Jobs" 标题 + "+ New Cron" 按钮；下方是 jobs 列表，每行包含 name、schedule（人类可读如 "every day at 09:00"）、enabled toggle、状态 chip（enabled=绿色 / disabled=灰色）、最后执行时间（"2 hours ago"）、下次执行时间（"in 7 hours"）；空状态显示 "No scheduled tasks yet. Add one to get started." 和一个明显的 "+ New Cron" 引导按钮

### 场景: 在 Cron Dashboard 创建新 job
**GIVEN** 用户在 Cron Dashboard，点击 "+ New Cron" 按钮
**WHEN** 模态框打开，用户填写 name="weekly-report"、prompt="汇总本周 GitHub 活动"、schedule 选择 "cron" 类型并填入 "0 17 * * 5"、enabled=true，点击 "Create"
**THEN** Web Server 调用 `cron_write({operations: [{action: "add", name, schedule, prompt, enabled}]})` 通过直接写 `cron.json`（或通过 spawn 的 helper pi 进程）；列表立即显示新 job 卡片，含 schedule 解析后的人类可读字符串 "every Friday at 17:00"；模态框关闭，浏览器无刷新

### 场景: 立即触发 cron job
**GIVEN** Cron Dashboard 列表中有 job "morning-email"，enabled=true
**WHEN** 用户点击该行的 ⚡ Trigger Now 按钮
**THEN** Web Server 调用 `cron_write({operations: [{action: "trigger_now", id: "..."}]})`；该 job 的 `last_run_at` 在下次 pi session 启动时立即生效（因为 trigger_now 实际上是把 `last_run` 重置为过期，让 `isOverdue` 返回 true）；UI 立即显示 toast "Triggered: morning-email (will run on next session start)"

### 场景: cron 到点自动执行
**GIVEN** 一个 cron job 处于 enabled 状态，schedule 到期（例如 "0 9 * * *" 时间到）
**WHEN** 用户在任意路径下启动 pi（或 WebUI 启动时尝试触发），触发 `session_start` 事件
**THEN** `cron.ts` 现有逻辑检查所有 enabled jobs，对 overdue 的 job 标记 `last_run`，并用 `pi.sendUserMessage({deliverAs: "followUp"})` 把 prompt 注入到当前 session 作为 followUp 消息；agent 在对话中自然处理；用户不需要 Web Server 运行也能让 cron fire

### 场景: 删除 session 触发记忆抽取
**GIVEN** WebUI 列出 session 列表，session-X 有 200 条 messages
**WHEN** 用户点击 session-X 的删除按钮，确认删除
**THEN** Web Server 读取 session-X 的 JSONL，调用 LLM（用当前 default model）抽取 memory atoms（type: constraint/preference/workflow/knowledge/event/solution/insight）；atoms 写入 `~/.pi/agent/data/memory.db`（复用 memory.ts 已有的 SQLite FTS5 schema）；session-X 的 JSONL 文件被删除；session 列表中该 session 消失

### 场景: 新 session 自动注入历史 atoms
**GIVEN** `~/.pi/agent/data/memory.db` 已有 20 个 atoms（之前累积的）
**WHEN** 用户创建新 session 并发送第一条消息
**THEN** `memory.ts` 已有的 `before_agent_start` 钩子自动触发 memory search（带 query rewrite 和可选 embedding），把匹配的 atoms 注入到 system prompt 的 `<memory-context>` 块；agent 自然看到历史知识；WebUI 不需做额外注入工作

## 异常流程

### 场景: Web Server 启动端口被占用
**GIVEN** 用户运行 `pi --web`，但 8741 端口已被其他进程占用
**WHEN** Web Server 启动失败
**THEN** 终端打印 `Error: port 8741 in use, try --port <other>` 并退出，exit code 非 0；pi 进程也退出

### 场景: pi 子进程意外崩溃
**GIVEN** session-A 的 pi 进程 stream 中，agent 正在执行长任务
**WHEN** pi 进程因 OOM / unhandled error / 收到 SIGKILL 崩溃
**THEN** Web Server 检测到 stdout EOF 或 stderr 包含 "FATAL"；session-A 状态变为 error（红色图标 + 错误信息 tooltip）；session JSONL 文件保留在磁盘上（崩溃可能中途）；用户点击 session-A 看到 "Session crashed: <last stderr line>"，可选择 "Delete"（触发 memory 抽取）或 "Discard"（不抽取直接删）

### 场景: 记忆抽取 LLM 调用失败
**GIVEN** 用户删除 session-X，Web Server 调用 LLM 抽取 atoms
**WHEN** LLM API 返回 5xx / timeout / 401
**THEN** Web Server 重试 1 次（间隔 2s），仍失败则跳过抽取，直接删除 session-X；不写入 `memory.db` 任何错误记录（保持 memory.db 干净）；用户看到 "Session deleted, memory extraction skipped due to LLM error"；memory 系统在下次 session compaction 时仍会兜底抽取

### 场景: Web Server 意外退出后重启
**GIVEN** Web Server 在运行中，session-A/B 都在工作
**WHEN** Web Server 被 SIGKILL（用户 Ctrl-C 不工作 / 机器断电）
**THEN** 重启 `pi --web` 后：从 `~/.pi/agent/sessions/--<cwd>--/` 扫描 JSONL 文件重新列出所有 session（active session 状态显示为 unknown，因为 spawn 出的 pi 子进程已死）；cron jobs 从 `~/.pi/agent/data/cron.json` 重新加载（不受 Web Server 状态影响）；memory.db 不受影响

### 场景: cron job 的 schedule 无法解析
**GIVEN** 用户或 agent 添加 cron job 时用了 `schedule: {kind: "cron", expr: "invalid expr"}`
**WHEN** cron.ts 的 `parseCronExpression` 返回 null
**THEN** 现有逻辑 `isOverdue` 直接返回 false，job 永远不 fire；WebUI 显示该 job 带黄色 "invalid schedule" 警告 badge；用户/agent 可点击 edit 修正

### 场景: 同一 session 在 Web UI 和 TUI 同时打开
**GIVEN** 用户在终端启动 `pi`（默认 TUI 模式），持有 session-X 的 file lock；同时通过 WebUI 打开同 cwd，session-X 出现在 WebUI 列表
**WHEN** 用户在 WebUI 尝试给 session-X 发送消息
**THEN** Web Server 检测到 lock contention（无法获得 file lock）；session-X 在 WebUI 显示为 "in use by another process"（橙色图标）；WebUI 只能只读查看历史消息，发送按钮 disabled；用户可点 "Open read-only" 进入查看模式

## 边界条件

### 场景: 同时运行 16 个 session
**GIVEN** WebUI 已运行 15 个 session（11 个 idle、4 个 running），用户创建第 16 个
**WHEN** Web Server 进程池达到上限（默认 16）
**THEN** 第 16 个 session 正常创建并 spawn pi 进程；如果用户尝试创建第 17 个，Web Server 返回 429 "Max sessions (16) reached, delete one to create new"

### 场景: 单 session 消息数达 1 万
**GIVEN** session-A 持续对话 1 万条 messages
**WHEN** Web Server 读取 session-A 历史（用于 render chat list）
**THEN** 只加载最近 200 条 messages 进 Web UI，更早的分页加载（"Load older" 按钮，每次拉 100 条）；session JSONL 文件完整保留在磁盘不被裁剪

### 场景: 同一 cwd 下累积 50 个 session 文件
**GIVEN** 用户长期使用，cwd `~/work/proj` 下累积 50 个历史 session JSONL
**WHEN** WebUI 加载 session 列表
**THEN** 列表显示所有 50 个（按 last_active 降序），分页或虚拟滚动；每条显示：title（首条 user 消息截断）、model、message count、最后活跃时间、status

### 场景: memory.db 累积 1000 个 atoms
**GIVEN** `~/.pi/agent/data/memory.db` 累积 1000 个 atoms（极少见，但可能）
**WHEN** 新 session 创建时 memory 系统搜索
**THEN** 现有 memory.ts 逻辑用 `injection.max_count` 配置（默认 N）限制注入数量；`strength` 字段自动 decay，低 importance/strength 的 atoms 在搜索结果中排名靠后但不删除；FTS5 + BM25 排序保证返回 top-N 是相关的

### 场景: 50 个 cron jobs 同时到期
**GIVEN** Web Server 重启 / 长时间未启动 pi 后，cron.json 中多个 jobs 错过执行时间
**WHEN** 用户启动 pi session，触发 `session_start` 事件
**THEN** `cron.ts` 现有逻辑按顺序逐个处理 overdue jobs（for 循环串行），每个 job 标记 `last_run` 后 inject 一次 followUp；不阻塞，但 followUp 消息会逐条排队

### 场景: 抽取后 atoms 包含敏感信息
**GIVEN** session-X 中讨论了 API 密钥、密码、内部 URL
**WHEN** 抽取的 atoms 进入 memory.db
**THEN** 现有 memory 系统不带 redaction；WebUI 提供"查看 memory atoms 列表"页面（settings/memory）让用户能 inspect 和 delete 任何 atom；用户应教育 LLM 在抽取时主动过滤敏感信息

### 场景: Cron Dashboard 列出 50 个 jobs
**GIVEN** `cron.json` 累积 50 个 cron jobs（用户重度使用）
**WHEN** 用户打开 Cron Dashboard
**THEN** 列表虚拟滚动显示所有 50 行（不一次性 DOM render 全部），顶部保持 sticky "+ New Cron" 按钮可访问；每行可独立操作；支持按 enabled 状态过滤（toggle "Show disabled" 隐藏 disabled jobs）
