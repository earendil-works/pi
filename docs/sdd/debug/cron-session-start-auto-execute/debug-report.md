# Debug Report: cron-session-start-auto-execute

- **日期**: 2026-06-09
- **症状**: 用户报告"每次新开的 session,会自动执行 cron"。每次新开 webui session,之前 overdued 的 cron job 都会再次被触发,产生 TUI session 副本 + 重复 LLM 调用。Sidebar 里 "TUI X101SC26031778-Z01-J002 sjm 检查" session 不断累积
- **根因**: `extensions/personal-assistant/cron.ts:480-526` (原代码) `pi.on("session_start")` handler 做了:
  1. 加载所有 cron jobs
  2. 找出所有 overdue 的
  3. 对每个 overdue 调 `pi.sendUserMessage(\`[Scheduled task: ${job.name}] ${job.prompt}\`, { deliverAs: "followUp" })`
  4. 这把 cron prompt 注入到新 session 的 agent,让 LLM 真正执行该 prompt
  - **因果链**: 用户开新 webui session → pi 子进程启动 → emit `session_start` event → personal-assistant 监听 → 找到 overdued jobs → sendUserMessage 把 cron prompt 当作 followUp 注入 → agent 把 cron prompt 当普通 user message 执行 → 实际触发 LLM + tools + 副作用
  - **设计意图错**: 代码注释说 "Check overdue jobs on session start" — 像是想"会话开始时补上错过的 cron"。但正确设计是**时间驱动**:到点了才跑,不是每个 session 都跑。"every 1 hour" 在两个 session 之间开 1 次 N 个,会跑 N 次
- **修复**: `extensions/personal-assistant/cron.ts:480` — 删掉整个 `pi.on("session_start")` handler(60 行),改为注释说明这是错的、应该用 time-based scheduler
- **防御层**:
  - **入口点 (event handler)**: 完全删除错误的 handler 而非加 guard 跳过。bug 结构性不可重现
  - **业务逻辑**: session_start 跟 cron 时间调度解耦
  - **测试覆盖**: 添加 reproducer test `cron session_start auto-execute (regression) > (a) session_start does NOT auto-execute overdue jobs`,断言 `pi.sendUserMessage` 调用计数 = 0
- **未来工作**: 这是个 stop-gap fix。**正确设计是 time-based scheduler**(到点才跑),参考 `/home/qjh/workspace/personal/nanobot/nanobot/cron/service.py` (564 LOC asyncio + filelock)。另开 change `add-cron-time-scheduler` 实现。届时 webui server 作为常驻进程承载 scheduler,scheduler 到点 spawn pi 子进程跑 cron prompt,产生独立 session 列入 sidebar
- **经验教训**:
  - **设计混淆**:"会话开始"和"时间到"是两件事。session_start 是用户行为触发,定时是时钟触发。原代码混淆了
  - **TDD 教训**: 原代码 540 行只有 4 个 test,覆盖 add/trigger_now/isOverdue/compat,**完全没测 session_start handler**。这是经典的"边缘功能被遗忘测试"
  - **e2e 教训**: 这个 bug 之前所有用户(包括我之前的 e2e 测试)都见过 — sidebar 里 "TUI X101SC26031778-Z01-J002 sjm 检查" session 不断累积就是症状。但大家以为"哦那是 TUI 创建的",没人问"为什么每次开新 session 都有 TUI session"
  - **AGENTS.md 加一条**: "session_start handler 永远不能做 side-effecting 跨用户操作(发消息/触发任务)。session_start 只用于初始化当前 session 的本地状态"
- **测试结果**:
  - 复现测试 RED → GREEN (session_start 不再 sendUserMessage)
  - 全量: ext 147 / server 218 / web 234 = **599 pass**
  - `npm run check` clean
