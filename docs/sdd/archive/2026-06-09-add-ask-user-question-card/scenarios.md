# Scenarios: add-ask-user-question-card

## Happy Path

### S1: 单选卡片 — 点选提交
- **GIVEN** model 调 ask_user_question with 4 options(single-select)
- **WHEN** `extension_ui_request` event 到达 ChatPage
- **THEN** 助手消息末尾显示 inline 卡片,含 question 标题 + 4 个 option 按钮(label + description 两行)
- **AND** 用户点 "红色" → 卡片所有选项 disabled + 卡片上方显示 "你的选择: 红色"
- **AND** `extension_ui_response` 发到 ws(带 value="红色"),model 拿到 tool result "User selected: 红色" 继续推演

### S2: 多选卡片 — 输入编号提交
- **GIVEN** model 调 ask_user_question with `multiSelect: true` + 3 options
- **WHEN** `extension_ui_request` event 到达
- **THEN** 卡片显示编号列表(1. label / 2. label / 3. label) + 底部 input box(placeholder "输入选项编号,逗号分隔")
- **AND** 用户输 "1,3" → Submit → options disabled + 显示 "你的选择: 红色, 绿色"
- **AND** `extension_ui_response` 发(带 value="红色, 绿色"),ext 解析 `["红色","绿色"]`,返 "User selected: 红色, 绿色 (multi-select)"

### S3: 卡片在 session history 保留
- **GIVEN** 用户在某个 session 选了 "红色",卡片 disabled + 显示 "你的选择: 红色"
- **WHEN** 用户离开 session,过一会重新进入(API 重新拉 messages)
- **THEN** 卡片**不**重新渲染为 active(因为 tool 已执行完),但**返回的 messages 包含 card 数据**(disabled state)
- **AND** message 的 toolResult 部分显示 "User selected: 红色"

## Abnormal

### S4: model 发畸形 options → normalize 失败
- **GIVEN** model 调 ask_user_question with `options: {}` 或 `options: null`
- **WHEN** execute 跑 normalizeOptions
- **THEN** normalize 返 []
- **AND** 2-4 校验失败,返 isError "options must contain between 2 and 4 items"
- **AND** ChatPage 收到 tool_execution_end 携带 isError text,**不**渲染卡片(因为 tool 返 error,不是 actual call)

### S5: options=1(非法) → 不弹卡片
- **GIVEN** model 调 ask_user_question with 1 option only
- **WHEN** execute 校验
- **THEN** 返 isError,不触发 extension_ui_request
- **AND** ChatPage 不渲染卡片

### S6: 用户在 disabled 卡片上点选 → 无反应
- **GIVEN** 卡片已 disabled(用户已选或已超时)
- **WHEN** 用户 click 某个 option 或 input box
- **THEN** 无 `extension_ui_response` 发送,无 DOM 变化

### S7: ws 断开时到达 extension_ui_request → 卡片仍显示(离线)
- **GIVEN** ws connection 断续
- **WHEN** `extension_ui_request` 从 server 端到达(ChatPage 已有 event)
- **THEN** 卡片仍 render(因为 state 已 set)
- **AND** 但用户选后 ws.send 失败 — 卡片保留 active 等待重连(不 disable)

## Boundary

### S8: options=4(最大) + 每条 description 很长
- **GIVEN** 4 options,每项 description 200+ 字
- **WHEN** 卡片渲染
- **THEN** description 不 truncate(纯文本,scroll),卡片高度适应内容
- **AND** 不溢出 ChatPage 消息区

### S9: model 没调 ask_user_question → 无卡片
- **GIVEN** model 调其他 tool(如 bash)
- **WHEN** `extension_ui_request` type 不是 ask_user_question
- **THEN** ChatPage 不渲染卡片(toolCall 正常渲染为 ToolCallComponent)

### S10: 卡片在消息流内滚动跟随
- **GIVEN** 长对话 + 卡片在倒数第 3 条消息
- **WHEN** 用户发送新 prompt,消息流自动滚动到底部
- **THEN** 卡片随所在的助手消息正常跟随,不固定位置(非 position:fixed)

### S11: 5 分钟 timeout → 卡片 disabled + "已超时" 文字
- **GIVEN** ask_user_question 调起,用户不操作
- **WHEN** TIMEOUT_MS(5 分钟)到,`createDialogPromise` 内部 setTimeout 触发,返 undefined
- **THEN** execute 返 "User did not respond in time" content
- **AND** ChatPage 收到 `tool_execution_end`,卡片 disabled + 显示 "已超时" 文字

### S12: 多选输入 "1,3" → parse error handling
- **GIVEN** 多选卡片,用户输 "a,b"
- **WHEN** 提交
- **THEN** 卡片内不显示 error(简单过滤,取有效编号)
- **AND** 只返回 filter 后有效的选项 label 列表
