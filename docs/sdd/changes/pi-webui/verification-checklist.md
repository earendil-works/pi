# Verification Checklist: pi-webui

> 生成时间: 2026-06-01 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 启动 WebUI：用户运行 `pi --web`，终端打印 URL，浏览器看到 dashboard | scenarios.md:L6 | manual + curl | `pi --web &` 然后 `curl -s http://127.0.0.1:8741/api/health` | HTTP 200, body `{"ok":true}` | [ ] |
| S2 | 创建并与 session 对话：用户点 + New Session 发送 prompt，WebUI 实时显示流式响应 | scenarios.md:L11 | chrome-devtools | 1. 浏览器打开 http://127.0.0.1:8741 2. 点击 "+ New Session" 3. 输入 prompt 4. 观察右侧 chat 区域 | 新 session 出现在左侧，chat 区域显示流式 token，工具调用以卡片显示 | [ ] |
| S3 | 切换 session 不中断后台：session-A 在运行，点 session-B 后 A 仍 running | scenarios.md:L16 | manual | 1. 创建 session-A 发长 prompt 2. 不等结果，立即点 session-B 3. 切回 session-A | session-A 状态保持 running（动画持续），session-B 可正常对话 | [ ] |
| S4 | 通过对话创建 cron job：agent 调用 `cron_write` 写 cron.json，WebUI 立即显示 | scenarios.md:L21 | chrome-devtools + curl | 1. TUI: `pi -p "用 cron_write 加一个 daily 9am 任务"` 2. WebUI: 打开 /cron 路由 | 新 job 出现在 Cron Dashboard | [ ] |
| S5 | 打开 Cron Dashboard 表盘：用户点 Cron 侧边栏，主区域显示列表 | scenarios.md:L26 | chrome-devtools | 1. 浏览器打开 http://127.0.0.1:8741/cron | 看到 "Cron Jobs" 标题 + jobs 列表（或空状态） | [ ] |
| S6 | 在 Cron Dashboard 创建新 job：点 + New Cron 填表，列表立即显示 | scenarios.md:L31 | chrome-devtools | 1. /cron 页点 + New Cron 2. 填 name/schedule 3. 提交 | 模态框关闭，列表新增一行含人类可读 schedule | [ ] |
| S7 | 立即触发 cron job：点 ⚡ Trigger Now，job 的 last_run 被清空 | scenarios.md:L36 | chrome-devtools + file check | 1. /cron 页点 ⚡ 按钮 2. `cat ~/.pi/agent/data/cron.json \| jq '.[].last_run'` | 对应 job 的 last_run 为 null；toast 提示成功 | [ ] |
| S8 | cron 到点自动执行：schedule 到期，session_start 触发 followUp | scenarios.md:L41 | manual | 1. 添加 schedule 已到期的 job 2. 启动 `pi` 3. 观察是否收到 followUp 消息 | 收到 `[Scheduled task: ...]` followUp 消息 | [ ] |
| S9 | 删除 session 触发记忆抽取：WebUI 删除时 LLM 抽 atoms 写入 memory.db | scenarios.md:L46 | chrome-devtools + sqlite | 1. 创建 session 2. 删除 3. `sqlite3 ~/.pi/agent/data/memory.db "SELECT count(*) FROM memory_index"` | memory_index 计数增加，JSONL 文件被删除 | [ ] |
| S10 | 新 session 自动注入历史 atoms：memory.ts 钩子自动注入 | scenarios.md:L51 | manual | 1. 确认 memory.db 有 atoms 2. 启动新 session 3. 查 system prompt | system prompt 包含 `<memory-context>` 块含历史 atoms | [ ] |
| S11 | 端口被占用：`pi --web` 在 8741 已占时退出 | scenarios.md:L58 | bash | 1. `nc -l 8741 &` 2. `pi --web` 3. 观察 exit code | exit code 非 0，stderr 含 "port 8741 in use" | [ ] |
| S12 | pi 子进程意外崩溃：session-A 的 pi 进程死了，状态转 error | scenarios.md:L63 | manual | 1. 启动 session 2. `kill -9 <pi pid>` 3. WebUI 观察 | session 变红色 error 图标，点击显示崩溃信息 | [ ] |
| S13 | 记忆抽取 LLM 失败：删除时 LLM 5xx，跳过抽取 | scenarios.md:L68 | mock | 1. Mock LLM 返回 500 2. DELETE session 3. 检查 memory.db | 0 新增 atoms，JSONL 已删，toast 提示跳过 | [ ] |
| S14 | Web Server 意外退出后重启：session 从磁盘恢复，cron 重载 | scenarios.md:L73 | manual | 1. `pi --web &` 创建 session 2. `kill -9 <web pid>` 3. `pi --web` 重启 | 重启后能看到原 session，cron 列表正常 | [ ] |
| S15 | cron job schedule 无法解析：job 显示无效警告，永不 fire | scenarios.md:L78 | manual | 1. 手动编辑 cron.json 写入 `expr: "bad"` 2. WebUI 打开 | 该 job 显示黄色 "invalid schedule" badge | [ ] |
| S16 | 同一 session 在 TUI 和 WebUI 同时打开：WebUI 显示 "in use" | scenarios.md:L83 | manual | 1. TUI 启动 pi（持有 file lock） 2. WebUI 打开 3. 尝试发送消息 | WebUI 显示 in use 图标，发送按钮 disabled | [ ] |
| S17 | 同时 16 个 session：第 17 个被拒 | scenarios.md:L90 | bash | 1. 创建 16 个 session 2. 尝试创建第 17 个 | HTTP 429 含 "Max sessions (16) reached" | [ ] |
| S18 | 单 session 1 万 messages：只加载最近 200，分页加载 | scenarios.md:L95 | load test | 1. 用脚本生成 1 万条消息 session 2. 打开 WebUI | 初始显示 200 条，"Load older" 按钮可点 | [ ] |
| S19 | cwd 累积 50 个 session：列表虚拟滚动显示 | scenarios.md:L100 | bash | 1. 脚本生成 50 个 session JSONL 2. 打开 /sessions | 50 行可见，scroll 平滑（无明显卡顿） | [ ] |
| S20 | memory.db 1000 个 atoms：FTS5 BM25 仍能 top-N 排序 | scenarios.md:L105 | load test | 1. 脚本生成 1000 atoms 2. 启动 session 3. 查 system prompt 长度 | system prompt 包含的 atoms 不超 `injection.max_count` | [ ] |
| S21 | 50 个 cron jobs 同时到期：session_start 串行处理 | scenarios.md:L110 | manual | 1. 50 个 overdue job 2. 启动 pi 3. 观察 followUp 队列 | 50 条 followUp 消息依次入队处理 | [ ] |
| S22 | 抽取后 atoms 包含敏感信息：memory 系统不自动 redaction | scenarios.md:L115 | code-review | 查 `extensions/personal-assistant/memory.ts` 的 extraction prompt | prompt 未含 redaction 指令；UI 提供 settings/memory 页面让用户删除 | [ ] |
| S23 | Cron Dashboard 列 50 个 jobs：虚拟滚动 | scenarios.md:L120 | chrome-devtools | 1. 写入 50 jobs 到 cron.json 2. 打开 /cron | 列表虚拟滚动，每行可独立操作 | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Web Server Startup：--web flag 启动并打印 URL | spec.md ADDED #1 | bash | `packages/coding-agent/src/cli/args.ts` 含 `--web` 解析；`main.ts` 含 spawn 逻辑；`curl http://127.0.0.1:8741/api/health` 返回 200 | [ ] |
| R2 | Loopback-Only Binding：仅 127.0.0.1 | spec.md ADDED #1 (loopback) | bash | `lsof -i :8741` 显示仅 127.0.0.1；外网 IP `curl` 失败 | [ ] |
| R3 | Graceful Shutdown：SIGTERM → child SIGTERM → 5s 后 SIGKILL | spec.md ADDED #1 | bash | `kill -TERM <web-pid>` 后 `ps` 显示 pi 子进程也已退出 | [ ] |
| R4 | REST API: List sessions | spec.md ADDED #2 | curl | `curl http://127.0.0.1:8741/api/sessions` 返回 JSON 数组 | [ ] |
| R5 | REST API: Cron CRUD | spec.md ADDED #2 | curl | POST/GET/PUT/DELETE /api/cron/jobs 全部 200 | [ ] |
| R6 | REST API: DELETE session 触发 memory extraction | spec.md ADDED #2 | curl + sqlite | DELETE 后 `memory_index` 计数增加 | [ ] |
| R7 | WebSocket subscribe + broadcast | spec.md ADDED #3 | wscat | `wscat -c ws://127.0.0.1:8741/ws` 收到 session_event 帧 | [ ] |
| R8 | WebSocket send prompt forwards to pi | spec.md ADDED #3 | wscat | 发送 `{type:"prompt",text:"hi"}` 后 pi 进程 stdin 收到对应 RPC | [ ] |
| R9 | WebSocket disconnect 不杀 pi 进程 | spec.md ADDED #3 | bash | 关闭 wscat 后 `ps` 显示 pi 进程仍在 | [ ] |
| R10 | cron_write 5 actions: add/list/remove/toggle/trigger_now | spec.md ADDED #4 | code-review | `extensions/personal-assistant/cron.ts` 中 `Type.Literal("trigger_now")` 在 union 内；executeOperation switch 有 case | [ ] |
| R11 | cron_write 向后兼容 4-action 调用 | spec.md ADDED #4 | unit-test | `cd packages/personal-assistant && npx vitest run test/cron.test.ts` PASS | [ ] |
| R12 | trigger_now 把 last_run 设为 null | spec.md ADDED #4 | unit-test | `npx vitest run` 包含 trigger_now test，验证 cron.json 中 last_run: null | [ ] |
| R13 | Cron Dashboard 路由 /cron 存在 | spec.md ADDED #5 | chrome-devtools | 浏览器打开 http://127.0.0.1:8741/cron 渲染 CronPage | [ ] |
| R14 | Cron Dashboard 显示空状态当 0 jobs | spec.md ADDED #5 | chrome-devtools | cron.json 为 `[]` 时，UI 显示 "No scheduled tasks yet" | [ ] |
| R15 | Cron Dashboard "+ New Cron" 模态框 | spec.md ADDED #5 | chrome-devtools | 点击按钮打开 form，提交后模态框关闭 + 列表更新 | [ ] |
| R16 | Cron Dashboard ⚡ Trigger Now | spec.md ADDED #5 | chrome-devtools + file check | 点击后 cron.json 中 last_run 变 null | [ ] |
| R17 | Cron Dashboard 行展开 last-run 详情 | spec.md ADDED #5 | chrome-devtools | 点击行显示 last_run + last_run_status + next scheduled (from cron.json) | [ ] |
| R18 | Cross-Process Cron Sync：chokidar 监听变化 | spec.md ADDED #6 | bash | 外部 shell 改 cron.json 后 WebUI 500ms 内更新 | [ ] |
| R19 | Session Deletion Memory Extraction | spec.md ADDED #7 | chrome-devtools + sqlite | 删除 session 后 memory.db 增长 | [ ] |
| R20 | Extraction failure non-blocking | spec.md ADDED #7 | mock | Mock LLM 500 后 session 仍删除，memory.db 不变 | [ ] |
| R21 | Session Switching Independence | spec.md ADDED #8 | manual | session-A running 时切到 session-B，A 仍 running | [ ] |
| R22 | pi Core Unchanged：仅 args.ts + main.ts 改动 | spec.md ADDED #10 | bash | `git diff --name-only packages/coding-agent/src/ packages/ai/ packages/agent/ \| grep -v "^packages/coding-agent/src/cli/"` 为空 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S23) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R22) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
