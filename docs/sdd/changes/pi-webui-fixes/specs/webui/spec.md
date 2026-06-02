# webui Specification

## ADDED Requirements

### Requirement: WebUI 列出父 cwd 的 session
WebUI SHALL 显示运行 `pi --web` 时所在父 cwd 对应的 `~/.pi/agent/sessions/--<cwd-encoded>--/` 目录下的 session 文件,而不是 webui server 自己 `process.cwd()` 解析出的目录。

#### Scenario: 在 ~/pi 启动时只列 ~/pi 的 session
- **GIVEN** 用户在 `~/pi` 跑 `pi --web`
- **AND** `~/.pi/agent/sessions/--home-qjh-pi--/` 下有 3 个 session
- **AND** `~/.pi/agent/sessions/--home--qjh--workspace--personal--pi--packages--webui--/` 下有 12 个测试 session
- **WHEN** 浏览器打开 `http://127.0.0.1:8741/`
- **THEN** 左栏 session 列表显示 3 个,不是 12 个

#### Scenario: 全新的 cwd 没有 session
- **GIVEN** 用户在 `~/new-project` 跑 `pi --web`(该目录没跑过 pi)
- **WHEN** `GET /api/sessions`
- **THEN** 返回 `[]`,UI 显 "No sessions yet"

### Requirement: WebUI 走真 RPC 协议 (message 字段)
WebUI SHALL 在通过 stdin 给 pi 子进程发 prompt 时使用 `message` 字段(不是 `text`),与 pi 的 RPC 协议 (`rpc-types.ts:RpcCommand.prompt`) 字段名一致。

#### Scenario: 发送 "nihao" 收到真 LLM 响应
- **GIVEN** 已选中 session
- **WHEN** 用户输入 "nihao" 回车
- **THEN** assistant 流式回复真 LLM 响应(非 "nihao" 回显)
- **AND** stdin 收到的 JSON 含 `message:"nihao"` 字段不含 `text` 字段

#### Scenario: WS handler 内部不再有字段名错配
- **GIVEN** WebUI WS handler 处理 prompt 消息
- **WHEN** 调 `SessionPool.prompt()`
- **THEN** SessionPool 写入 stdin 的 JSON 形如 `{"type":"prompt","sessionId":"...","message":"...","images":[]}` 而**不**是 `text`

### Requirement: Session 标题 = 首条 user 消息前 30 字
WebUI SHALL 在 session 收到首条 user 消息后,把该消息的前 30 个字符作为 session 标题,通过 RPC `set_session_name` 命令写入 pi 子进程,让 pi 把它持久化到 session JSONL header 的 `name` 字段。

#### Scenario: 首条消息 30 字内
- **GIVEN** session 刚创建,JSONL header `name` 为空
- **WHEN** 用户发 "nihao"(5 字)
- **THEN** 1s 内 JSONL header `name` 字段变成 "nihao"
- **AND** 左栏该 session 卡片标题变 "nihao"

#### Scenario: 首条消息 30 字以上
- **GIVEN** session 刚创建
- **WHEN** 用户发 50 字的第一句
- **THEN** title 截前 30 字(不补省略号)

#### Scenario: 后续消息不改 title
- **GIVEN** session title 已是 "nihao"
- **WHEN** 用户发第二条消息 "hello world"
- **THEN** title 仍为 "nihao",不变

#### Scenario: pi RPC set_session_name 失败
- **GIVEN** pi 子进程未启动或响应 timeout
- **WHEN** 用户发首条消息
- **THEN** prompt 仍正常发送(不阻塞),title 留空,UI 显 "New Chat" 兜底

### Requirement: DELETE 乐观化
WebUI SHALL 让 DELETE `/api/sessions/:id` 在 500ms 内返回 200,即使后台 LLM 抽 atoms 失败,UI 立即从列表移除 session。

#### Scenario: LLM 抽 atoms 失败但 session 已删
- **GIVEN** session 有 10 条消息,LLM 抽 atoms 必然失败(超时 5s+retry 5s)
- **WHEN** 用户点删除并确认
- **THEN** DELETE 响应在 500ms 内返回 200
- **AND** JSONL 文件已被 unlink
- **AND** 后端 console.error 记录 "Background atom extraction failed" 但不影响响应

#### Scenario: LLM 抽 atoms 成功
- **GIVEN** session 有真实消息,LLM 抽 atoms 成功
- **WHEN** 用户点删除
- **THEN** session 立即从 UI 消失
- **AND** memory.db 在后台被追加 atoms(用户感知不到)

### Requirement: 主页为 chat-first 布局
WebUI SHALL 把 session 列表常驻左栏、主页 `/` 是空 chat 状态、点 session 跳到 `/session/:id` 进入聊天,布局像豆包 / ChatGPT。

#### Scenario: 打开主页是空状态
- **GIVEN** WebUI 服务起来
- **WHEN** 浏览器打开 `http://127.0.0.1:8741/`
- **THEN** 主页显居中空状态卡 "Start a new chat from the sidebar, or click + New Chat"
- **AND** 左栏常驻显 brand + Cron 链接 + session 列表(空时显 "No sessions yet") + 底部 New Chat 按钮

#### Scenario: 点 New Chat 创建并高亮
- **GIVEN** 主页空状态
- **WHEN** 点左栏底部 New Chat
- **THEN** 200ms 内新 session 出现在左栏顶部且高亮选中
- **AND** URL 跳到 `/session/<new-id>`,主区变空 chat 输入框

#### Scenario: 点左栏 session 切换
- **GIVEN** 左栏有 3 个 sessions
- **WHEN** 点其中一个
- **THEN** URL 跳到 `/session/<id>`,主区加载该 session 消息历史

#### Scenario: 路由 /sessions 已废弃
- **GIVEN** 主页是新的 chat-first 布局
- **WHEN** 浏览器访问 `/sessions`
- **THEN** 自动重定向到 `/` (replace)

#### Scenario: Cron 链接从左栏进
- **GIVEN** 左栏 nav
- **WHEN** 点 Cron 链接
- **THEN** 主区切到 cron 页(`/cron`),左栏仍可见

## MODIFIED Requirements

### Requirement: WebUI 单 session 标题生成 (原 deriveTitle 行为)
系统 SHALL 移除"以 cwd 末级名 + id 前 8 位"作为 session 标题的逻辑(`deriveTitle`),改为空 title 占位 + 首条 user 消息后通过 RPC `set_session_name` 写入真标题。

#### Scenario: 创建 session 时 title 为空
- **GIVEN** 用户点 New Chat
- **WHEN** 新 session 文件创建
- **THEN** JSONL header `name` 字段为空
- **AND** 左栏卡片标题临时显 "New Chat"

#### Scenario: 旧 session 文件无 name 字段
- **GIVEN** 已存在的旧 session 文件 `name` 字段不存在
- **WHEN** WebUI 列出 sessions
- **THEN** title 字段在 API 响应中是 "" (空字符串)
- **AND** 左栏卡片显 "New Chat" 兜底

## REMOVED Requirements

### Requirement: SessionsPage 独立页
- **Reason**: 主页改为 chat-first 布局,左栏常驻 session 列表。SessionsPage 路由被删。
- **Migration**: 用户改用左栏直接选 session 或 New Chat,无需单独 /sessions 路由。

## RENAMED Requirements
(无)
