# 使用场景

## 正常流程

### 场景: TUI 单选 happy path
**GIVEN** 用户在 TUI(`pi --mode interactive`),personal-assistant extension 已加载,当前 turn 走到 model 生成 `ask_user_question` tool call,参数为 `{question: "smart-sample-find 的依赖条目里要不要加 [remote] 标识?", header: "Dep tag", options: [{label: "加 [remote]", description: "..."}, {label: "不加 [remote]", description: "..."}, {label: "所有依赖都加 [remote]", description: "..."}]}`
**WHEN** Model 调 `ask_user_question` execute
**THEN** TUI 调用 `ctx.ui.select(title, ["加 [remote] — ...", "不加 [remote] — ...", "所有依赖都加 [remote] — ..."], {timeout: 300000})`,屏幕显示 `ExtensionSelectorComponent` 弹窗,用户按上下键 + Enter 选 "加 [remote]"
**AND THEN** Tool 返回 `content: [{type:"text", text:"User selected: 加 [remote]"}]`,model 继续推演

### 场景: Webui 单选 happy path
**GIVEN** 用户在 webui 浏览器,订阅了 session `s1`,model 走到 `ask_user_question` tool call,参数同 TUI happy path
**WHEN** Model 调 `ask_user_question` execute
**THEN** Webui server 透传 `extension_ui_request` 事件到 web client,web client 收到后 (a) 聊天页面末尾插入占位"⏳ 等待用户回答: smart-sample-find 的依赖条目里要不要加 [remote] 标识?",(b) 弹 modal 显示 question + 3 个 option(label + description 两行)
**WHEN** 用户在 modal 点 "加 [remote]" 按钮
**THEN** Web client 发 ws 消息 `{type: "extension_ui_response", id: <req id>, value: "加 [remote]"}`,webui server 写回 pi 子进程 stdin `{type:"extension_ui_response", id, value:"加 [remote]"}`,pi 把该值给 `ctx.ui.select` 的 Promise resolve
**AND THEN** Tool 返回 `content: [{type:"text", text:"User selected: 加 [remote]"}]`,model 继续推演;同时占位被替换为完整 tool call + tool result 记录

### 场景: Webui multiSelect happy path
**GIVEN** 同 webui 单选 happy path,但参数 `multiSelect: true`
**WHEN** Model 调 `ask_user_question` execute
**THEN** Webui 弹带 checkbox 的 modal(每个 option 一个 checkbox),用户勾 "加 [remote]" 和 "所有依赖都加 [remote]" 提交
**THEN** Webui 发 `{type: "extension_ui_response", id, value: "加 [remote], 所有依赖都加 [remote]"}`,tool 返回值给 model

### 场景: TUI multiSelect input path
**GIVEN** 同 TUI 单选 happy path,但 `multiSelect: true`
**WHEN** Model 调 `ask_user_question` execute
**THEN** TUI 调 `ctx.ui.input(title, "加 [remote], 不加 [remote], 所有依赖都加 [remote] (用逗号分隔多项)", {timeout: 300000})`,用户在文本框输入 `加 [remote], 不加 [remote]`
**THEN** Tool 返回 `content: [{type:"text", text:"User selected: 加 [remote], 不加 [remote]"}]`,model 继续推演

## 异常流程

### 场景: 5 分钟无响应 timeout
**GIVEN** 用户在 webui 浏览器,modal 已弹 / TUI 选择器已显示,5 分钟内无任何操作
**WHEN** Pi 的 `createDialogPromise` 内部 setTimeout 触发
**THEN** (a) Pi 端:`ctx.ui.select` 的 Promise resolve 为 `undefined`(defaultValue),(b) `createDialogPromise` 解析后 select 返回 `undefined`,tool execute 走 cancel 分支,返回 `content: [{type:"text", text:"User did not respond within 5 minutes; please make a reasonable default choice or ask the user directly via prompt"}]`,`details: {cancelled: true, reason: "timeout"}`
**AND THEN** Webui 端:modal 自动关闭,占位被替换为 tool result "User did not respond within 5 minutes; please make a reasonable default choice or ask the user directly via prompt",model 继续推演(可能重发 user message / 选个默认)

### 场景: 用户按 Esc 取消
**GIVEN** Modal / TUI 选择器已弹
**WHEN** 用户按 Esc / 点 modal 的 Cancel 按钮
**THEN** `ctx.ui.select` resolve 为 `undefined`,tool 返回 `{content:[{type:"text", text:"User cancelled the question"}], details:{cancelled: true}}`,model 看到后可能重新组织问题或直接选默认

### 场景: Model 给畸形 options 嵌套 (`{item:{item:[]}}`)
**GIVEN** Model 调 `ask_user_question` 实际输出 `{question, header, options: {item: {item: [{label, description}, ...]}}}`
**WHEN** Tool execute 入口 normalize
**THEN** `normalizeOptions(raw)` 递归 unwrap `.item` 字段直到拿到 array,拿到标准 `[{label, description}]` 形态;后续流程与 happy path 一致
**AND THEN** 如果递归到非 object / 仍不是 array,抛 `TypeError("options must be a non-empty array of {label, description} objects")`,被 tool execute 顶层 catch 转成 `content: [{type:"text", text:"Invalid options: ..."}], isError: true`

### 场景: Model 缺 options 字段
**GIVEN** Model 调 `ask_user_question` 输出 `{question: "...", header: "..."}` 没 options
**WHEN** Tool execute
**THEN** TypeBox schema validation 失败(在 agent-loop 的 `prepareToolCall` 阶段)?或工具 execute 内 normalize 检测到空数组
**THEN** 返回 `{content: [{type:"text", text:"ask_user_question requires at least 2 options (Claude Code spec)"}], isError: true}`,model 看到后应重新调并补 options

### 场景: Model 调 multiSelect 但只有 1 个 option
**GIVEN** Model 调 `{question, header, options: [{label, description}], multiSelect: true}`
**WHEN** Tool execute
**THEN** Tool 校验 "multiSelect requires at least 2 options",返回 isError tool result,model 重新调

### 场景: Webui 收到 extension_ui_request 时 ws 已断
**GIVEN** Web client 与 webui server 的 ws 连接已断
**WHEN** Pi 调 `ctx.ui.select` 发出 `extension_ui_request`,webui server 试图 send 到 closed ws
**THEN** Webui server 检测 ws.readyState !== OPEN,自动 cancel(tool 返回 "User cancelled (web client disconnected)");session 不卡死
**AND THEN** Pi 端的 `pendingExtensionRequests` map 自动清理(走 `createDialogPromise` 的 cleanup 分支)

### 场景: 用户在 modal 未答时 abort 当前 turn
**GIVEN** Webui 弹 modal 等待回答,用户点 Stop / abort 按钮
**WHEN** Session-pool 收到 `abort` RPC,向 pi 发 `{type:"abort"}`
**THEN** Pi 端 ctx.signal abort,`createDialogPromise` 的 `onAbort` 触发,resolve `undefined`,tool 返回 cancel result,pending extension UI request 清理
**AND THEN** Webui 端 modal 关闭(可监听 abort 事件),占位被替换为 cancel tool result

### 场景: Model 调 ask_user_question 跟其他 tool 并发
**GIVEN** Model 在同一个 assistant message 里同时调 `ask_user_question` 和 `read`
**WHEN** Pi 的 `executeToolCallsParallel` 并发执行
**THEN** `read` 立即完成返回 tool result,`ask_user_question` 进入 wait state;agent-loop 等待所有 tool 完成后再继续推演。两者结果都进入 toolResultMessage

## 边界条件

### 场景: 多个 session tab 各自弹 modal
**GIVEN** 用户打开 webui 两个 tab,tab A 订阅 session s1,tab B 订阅 session s2,两个 session 同时调起 `ask_user_question`
**WHEN** 两路 `extension_ui_request` 同时到达 web client
**THEN** Client 端按 session 分组,tab A 的 modal 来自 s1 的 request,tab B 的 modal 来自 s2 的 request;不跨 session 干扰。每 tab 内部独立排队多 modal

### 场景: 同一 session 多个 ask_user_question 排队
**GIVEN** Session s1,model 在一个 turn 内连续调 2 次 `ask_user_question`(可能因为 model 设计上想先 confirm A 再 confirm B)
**WHEN** 第一个 request 弹出 modal 1,用户未答;第二个 request 排队
**THEN** Webui 顶部显示 "⏳ 还有 1 个未答问题" + "查看" 按钮;modal 1 提交后 modal 2 自动弹出
**AND THEN** TUI 不排队 — 因为 pi 的 `pendingExtensionRequests` 是按 `id` 区分,多个未答 select 会并行等待(每个都是独立的 `createDialogPromise`),TUI 用户当前在哪个 selector 就答哪个,Esc 取消当前

### 场景: User refresh 浏览器
**GIVEN** Webui 弹 modal / 有占位在聊天页面
**WHEN** 用户 F5 refresh
**THEN** Modal 状态丢失,占位丢失(因本地 state 不持久化);session 端 pi 还在等 `ctx.ui.select` 返回。Web client 重连 ws 后,不会重发 `extension_ui_request`(pi 已经发出,client 错过了);pi 端 `createDialogPromise` 的 5 分钟 timeout 最终触发,tool 返回 timeout cancel result,model 继续推演
**AND THEN** 不持久化未答 modal 是设计选择,见非目标

### 场景: Webui dev mode 多个 ws (HMR)
**GIVEN** Dev webui 模式下 vite HMR ws 在 `/__vite_hmr`,webui 自己的 ws 在 `/ws`
**WHEN** Extension ui request 到达 webui server
**THEN** 只有 `/ws` 客户端收到(代码 ws/handler.ts:84-90 遍历 `clients` map,只对 `subscriptions.has(sessionId)` 的 client 发送),HMR client 收不到;不会有冲突

### 场景: TUI 模式 description 拼到 label 后太长被截断
**GIVEN** Model 给一个 option label = "加 [remote]", description = 一段 200 字符的解释
**WHEN** Tool 把 description 拼到 label 后面:`"加 [remote] — 和现有依赖区分: 本地工具不加, HPC 工具加, 改成 ..."`(truncate 80 字)
**THEN** 走 pi 现有的 `truncateToWidth` 渲染,长 option 在 TUI 中按终端宽度自动截断;不影响功能,用户可读到的部分覆盖核心信息

### 场景: TypeBox schema 校验失败时,execute 仍能跑
**GIVEN** Model 给非标准但语义可解析的参数(如 `options` 是 object 不是 array,但内部可解出 array)
**WHEN** Pi 的 `prepareToolCall` 阶段(看 `packages/agent/src/agent-loop.ts:562`)调用 schema validation
**THEN** 如果 schema 太严,validation fail → tool 直接不进 execute。所以 tool schema 必须**宽松**到能接住所有实测 model 形态,execute 内部再做 normalize;否则 happy path 走不到 normalize
**AND THEN** 解决方案:schema 用 `Type.Any()` 接 options 字段,execute 内 normalize。这样 validation 不会卡住 model

### 场景: Webui 端 modal 提交后,占位替换时机
**GIVEN** Webui 收到 `extension_ui_request`,插占位 + 弹 modal;用户点击选项
**WHEN** Web client 发 `extension_ui_response` 给 server
**THEN** Server 写 stdin 后,pi resolve `ctx.ui.select` → tool execute 完成 → pi emit `tool_execution_end` event → server 透传给 client → client 收到后用 tool result 替换占位
**AND THEN** 替换时机靠 `tool_execution_end` event,不是靠 `extension_ui_response` 发完(发完时 pi 还没跑完,可能 user 立即收到占位变成 call 但 result 还没到的中间态,造成闪烁)。所以占位 → "tool call + result" 是一次性替换
