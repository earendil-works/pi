# 使用场景: pi-webui-fixes

## 正常流程

### 场景: WebUI 列出当前 cwd 的真 sessions
- **GIVEN** 用户在 `~/pi` 跑过 `pi`,生成了 3 个 session 文件在 `~/.pi/agent/sessions/--home-qjh-pi--/`
- **AND** 跑 `./pi-test.sh --web` 从 `~/pi`
- **WHEN** 浏览器打开 `http://127.0.0.1:8741/`
- **THEN** 左栏 session 列表显示 3 个真 session(标题为各自首句),不显示 webui 包或其他 cwd 的 session

### 场景: 新建 session 立刻可见
- **GIVEN** WebUI 主路由打开,左栏 session 列表
- **WHEN** 点 New Chat 按钮
- **THEN** 200ms 内新 session 出现在左栏顶部,且高亮选中
- **AND** 主区域进入空 chat 状态

### 场景: 发送消息收到真 LLM 响应
- **GIVEN** 已选中一个 session
- **WHEN** 输入框打"nihao" 回车
- **THEN** 用户消息立刻出现在主区
- **AND** 助手消息以流式出现真实回复(非"nihao"回显)
- **AND** 完成后左栏该 session 标题更新为 "nihao"(短消息)或前 30 字

### 场景: 乐观删除 session
- **GIVEN** session 列表有 3 个 session
- **WHEN** 点其中一个的删除按钮,确认
- **THEN** 200ms 内该卡片从左栏消失
- **AND** 列表变 2 个
- **AND** JSONL 文件已被 unlink
- **AND** 若 LLM 抽 atoms 失败,后端日志记录错误但不影响响应

### 场景: Cron 页面空表
- **GIVEN** `~/.pi/agent/data/cron.json` 已清空
- **WHEN** 浏览器导航到 `/cron`
- **THEN** 显示空状态"No scheduled jobs, click + to add"

## 异常流程

### 场景: LLM 抽 atoms 超时不阻塞删除
- **GIVEN** session 有 10 条消息,LLM 抽 atoms 需要 8s
- **WHEN** 用户点删除
- **THEN** DELETE 在 200ms 内返回 200(session 已删)
- **AND** 后端日志显示 `Memory extraction failed after retry, but session deleted`

### 场景: pi RPC 子进程崩溃
- **GIVEN** session 正在跑,用户发了 prompt
- **AND** pi 子进程因 OOM/segfault 死亡
- **WHEN** 主区检测到 stream_end 异常关闭
- **THEN** 显示 "Agent disconnected" 错误条
- **AND** 左栏该 session 状态变 idle
- **AND** 下次再发 prompt 自动重启 pi 子进程

### 场景: WS 断线自动重连
- **GIVEN** 浏览器连上 WebSocket
- **WHEN** 网络抖动导致 ws 断开
- **THEN** 前端 1s 内自动重连
- **AND** 重连后重新 subscribe 之前选中的 session
- **AND** 中间产生的 events 因未订阅所以丢失(可接受)

### 场景: 同一 session 两个 tab
- **GIVEN** tab A 和 tab B 都打开了同一 session
- **WHEN** A 发 prompt
- **THEN** A 看到流式响应
- **AND** B 同步看到流式响应(共享同一个 pi 子进程)
- **WHEN** A 删 session
- **THEN** A 立即消失;B 显示 "Session deleted by another client" 提示

## 边界条件

### 场景: 空 prompt 拒绝
- **GIVEN** 已选中 session
- **WHEN** 用户按回车但输入框为空
- **THEN** 不发送,输入框红边提示

### 场景: prompt > 256KB 拒绝
- **GIVEN** 输入框打 300KB 文字
- **WHEN** 按回车
- **THEN** WS 服务端发 `error: invalid prompt`
- **AND** UI 显 "Message too long (max 256KB)"

### 场景: 第一条消息正好 30 字
- **GIVEN** 用户第一句恰好 30 个字符
- **THEN** title 完整存 30 字(不截断,前 30)

### 场景: 第一条消息包含换行
- **GIVEN** 用户第一句是 "hello\nworld"
- **THEN** title 存为 "hello world"(换行替换为空格),或 "hello\nworld" 原样(取前 30 字符前不替换)

### 场景: cwd 没 .pi/agent/sessions
- **GIVEN** 全新目录 `~/new-project`,没跑过 pi
- **WHEN** 跑 `pi --web`
- **THEN** `GET /api/sessions` 返回 `[]`
- **AND** 左栏显 "No sessions yet"

### 场景: 16 session 上限
- **GIVEN** 已有 16 个 session 的 pi 子进程在跑
- **WHEN** 用户在第 17 个 session 发 prompt
- **THEN** WS 显 "Max sessions reached, delete one to free up"
- **AND** 不启新进程

### 场景: 同时开两个 `pi --web` 进程
- **GIVEN** 端口 8741 已被占用
- **WHEN** 用户跑第二个 `pi --web`
- **THEN** 第二个进程退出并显 "port 8741 in use, try --port <other>"
- **AND** 不杀第一个
