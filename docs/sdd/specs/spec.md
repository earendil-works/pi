# System Specification

## Capability: theme

### Requirements

#### Requirement: codewhale.json 主题文件
系统 SHALL 支持通过 `/theme codewhale` 切换到 CodeWhale 深蓝风格主题。

##### Scenario: 切换到 CodeWhale 主题
- **GIVEN** Pi TUI 启动并显示默认 dark 主题
- **WHEN** 用户输入 `/theme codewhale`
- **THEN** TUI 切换到 CodeWhale 深蓝主题，所有颜色立即更新

##### Scenario: 主题文件格式错误
- **GIVEN** `~/.pi/agent/themes/codewhale.json` 格式不合法
- **WHEN** Pi 加载主题
- **THEN** 回退到默认 dark 主题，控制台显示错误信息

##### Scenario: 不支持 truecolor 的终端
- **GIVEN** 终端不支持 24-bit truecolor
- **WHEN** Pi 使用 CodeWhale 主题
- **THEN** 颜色自动降级到 256-color 模式，使用最近似的颜色

#### Requirement: CodeWhale 品牌色系
系统 SHALL 使用 CodeWhale 品牌色 `#3578E5` 作为 accent 颜色，深墨蓝 `#0B1526` 作为主要背景色。

##### Scenario: 用户消息卡片化
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** 用户发送消息
- **THEN** User 消息显示在深墨蓝背景卡片中，与 assistant 消息视觉区分明显

##### Scenario: 工具执行卡片化
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 执行工具（bash、文件操作等）
- **THEN** Tool 执行结果显示在带状态色的卡片中（pending=蓝色, success=绿色, error=红色）

##### Scenario: 代码块在深蓝背景下可读
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 输出包含代码块
- **THEN** 代码块使用 VS Code Dark+ 风格语法高亮，在深蓝背景下清晰可读

## Capability: footer

### Requirements

#### Requirement: Footer mode chip
系统 SHALL 在 Footer 第三行显示当前模式 chip（Plan/Agent/YOLO），使用语义颜色。

##### Scenario: Footer 显示 mode chip
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 处于 Plan 模式
- **THEN** Footer 显示 "📋 Plan" mode chip，颜色为 amber

##### Scenario: Footer 显示 Agent mode
- **GIVEN** Pi TUI 使用 CodeWhale 主题
- **WHEN** Agent 处于正常 Agent 模式
- **THEN** Footer 显示 "🤖 Agent" mode chip，颜色为 blue

##### Scenario: 极窄终端宽度
- **GIVEN** 终端宽度 < 60 列
- **WHEN** Footer 渲染
- **THEN** Mode chip 和 stats 自动截断，不溢出

##### Scenario: 多个扩展同时显示状态
- **GIVEN** 5 个扩展同时注册了 Footer 状态
- **WHEN** Footer 渲染
- **THEN** 所有状态在第三行显示，截断不溢出

## Capability: chat-message-rendering

### Requirements

#### Requirement: Structured Message Parts

The `/api/sessions/:id/messages` endpoint SHALL return messages with a `parts: Part[]` array containing typed content blocks instead of a single `content: string` field.

The `Part` type is a discriminated union of:
- `TextPart` — `{ type: "text", text: string }` — visible text content
- `ThinkingPart` — `{ type: "thinking", text: string }` — agent reasoning
- `ToolCallPart` — `{ type: "toolCall", id: string, name: string, args: Record<string, unknown> }` — tool invocation
- `ToolResultPart` — `{ type: "toolResult", toolCallId: string, content: string, isError?: boolean }` — tool output
- `ImagePart` — `{ type: "image", mediaType: string, data: string }` — base64-encoded image

The `Message` interface SHALL have:
- `role: "user" | "assistant" | "toolResult"` (replaces `"user" | "assistant" | "system"`)
- `parts: Part[]` (replaces `content: string`)
- `id`, `sessionId`, `timestamp` (unchanged)

##### Scenario: User message renders as single TextPart
- **GIVEN** a JSONL entry `{ "type":"message", "message":{ "role":"user", "content":[{"type":"text","text":"hello"}] } }`
- **WHEN** `/api/sessions/:id/messages` returns it
- **THEN** the response has `parts: [{ type:"text", text:"hello" }]`

##### Scenario: Assistant message preserves all part types in order
- **GIVEN** a JSONL entry with `role:"assistant"` and `content: [thinking, toolCall, text]`
- **WHEN** the API returns it
- **THEN** `parts` contains 3 entries in order: `ThinkingPart`, `ToolCallPart`, `TextPart`

##### Scenario: ToolResult is no longer filtered
- **GIVEN** a JSONL entry with `role:"toolResult"`
- **WHEN** the API returns the message list
- **THEN** the toolResult is included as a separate Message (not dropped)

##### Scenario: Malformed JSON lines are skipped
- **GIVEN** a JSONL session file with one invalid line and two valid entries
- **WHEN** the API returns messages
- **THEN** the response contains the 2 valid messages and the API returns 200 (no error)

##### Scenario: Unknown content type falls back gracefully
- **GIVEN** an assistant content item with `type: "futureType"`
- **WHEN** the API returns the message
- **THEN** the message's `parts` includes a `TextPart` with `text: "?"` (no throw)

#### Requirement: Thinking Block is Collapsible

The webui SHALL render `ThinkingPart` as a collapsible block, default closed, with the heading "💭 Thinking" and an expand button. When expanded, the full text is shown in monospace gray text.

##### Scenario: Thinking default closed
- **GIVEN** an assistant message with a ThinkingPart containing 200 characters
- **WHEN** the message bubble renders
- **THEN** the monospace `<pre>` is NOT in the DOM, and an "expand" button IS visible

##### Scenario: Click expand shows thinking text
- **GIVEN** a thinking block is rendered (default closed)
- **WHEN** the user clicks the expand button
- **THEN** the full thinking text appears in a monospace pre element

##### Scenario: Very long thinking stays performant
- **GIVEN** a ThinkingPart with 50KB of text
- **WHEN** the thinking is collapsed (default)
- **THEN** the text is not in the DOM (only the header is)
- **WHEN** the user expands it
- **THEN** the full text appears in a scrollable element with `max-height`

#### Requirement: Tool Call Card

The webui SHALL render `ToolCallPart` as a card showing the tool name and a summary of arguments. The full arguments object SHALL be in a collapsible `<details>` element.

##### Scenario: ToolCallCard shows name and arg summary
- **GIVEN** a ToolCallPart with `name: "read"` and `args: { path: "/home/foo" }`
- **WHEN** rendered
- **THEN** the card header shows `🔧 read` and a one-line summary `path: /home/foo`

##### Scenario: Full args hidden behind details
- **GIVEN** a ToolCallCard
- **WHEN** the user opens the details/summary element
- **THEN** the full args JSON is visible

#### Requirement: Tool Result Block with Size Limit

The webui SHALL render `ToolResultPart` as a block with content area of `max-height: 24rem (384px)` and `overflow: auto`. If the content exceeds 5KB, the block SHALL show only the first 5KB plus a "Show full output (N KB)" button to expand.

##### Scenario: Short tool result shows fully
- **GIVEN** a toolResult with 1KB content
- **WHEN** rendered
- **THEN** the full content is visible without truncation; no "Show full" button

##### Scenario: Long tool result truncates
- **GIVEN** a toolResult with 10KB content
- **WHEN** rendered
- **THEN** the first 5KB are visible; a "Show full output (10.0 KB)" button is present

##### Scenario: Show full expands content
- **GIVEN** a truncated tool result is rendered
- **WHEN** the user clicks "Show full output"
- **THEN** the full 10KB content is shown; the button label changes to "Show less"

#### Requirement: Image Block Inline Renders

The webui SHALL render `ImagePart` as an inline `<img>` element using a `data:` URL with the `mediaType` and `data` fields, with `max-height: 24rem` to prevent a single image from filling the screen.

##### Scenario: Image renders inline
- **GIVEN** a toolResult with content `[{type:"image", mediaType:"image/png", data:"<base64>"}]`
- **WHEN** rendered
- **THEN** an `<img src="data:image/png;base64,..." alt="image" max-h-96>` element is in the DOM

##### Scenario: Multiple images lay out horizontally
- **GIVEN** a toolResult message with 3 images
- **WHEN** rendered
- **THEN** the images are in a horizontal flex container (flex-wrap), each with `max-h-96`

##### Scenario: Very large image is constrained
- **GIVEN** a 5MB PNG image
- **WHEN** rendered
- **THEN** the image is displayed at max-h-96 height, scaled to fit; the page is not broken

#### Requirement: One Bubble Per Turn

The webui SHALL group an assistant's text + thinking + tool calls + tool results into a single MessageBubble. The render order SHALL follow the JSONL time order (which equals the `parts` array order).

##### Scenario: Assistant turn with multiple parts is one bubble
- **GIVEN** an assistant turn containing thinking + 2 tool calls + 2 tool results + final text
- **WHEN** the chat is rendered
- **THEN** there is exactly one "Assistant" bubble for this turn
- **AND** the bubble shows: ThinkingBlock → ToolCallCard A → ToolResult A → ToolCallCard B → ToolResult B → final text

##### Scenario: Empty assistant turn still renders
- **GIVEN** an assistant message with only thinking + toolCall, no text
- **WHEN** rendered
- **THEN** the assistant bubble shows the thinking block and tool cards, NOT an empty bubble

### MODIFIED Requirements

#### Requirement: SessionMessageType

The session message endpoint's response shape is changed from `{role, content: string}` to `{role, parts: Part[]}`. The `role` field is expanded to include `"toolResult"`. The `content: string` field is removed.

##### Scenario: API response uses parts not content
- **GIVEN** any session with messages
- **WHEN** client calls `/api/sessions/:id/messages`
- **THEN** each message has `parts: Part[]` (NOT `content: string`)

##### Scenario: Live streaming constructs parts
- **GIVEN** a user sends a prompt and the agent starts streaming
- **WHEN** the WebSocket sends a `message_end` event with `event.message.content` array
- **THEN** the chat page constructs `parts` from the content array (mapping text/thinking/toolCall/image → Part) and appends the Message with `parts` field, NOT `content`

## Capability: satellite-remote-exec

The pi agent can execute commands on a remote HPC server via the `satellite_remote_exec` MCP tool. The tool is a discriminated union of 5 sub-operations: `bash`, `read`, `write`, `edit`, `transfer_file`. Sub-tool names match the native pi tools (`read`/`write`/`edit`). Bash is guarded against accidental file-tool substitution via a satellite-only client-side guardrail; file transfer uses HTTP body transport to keep bytes out of LLM context. The `list`, `find`, and `grep` sub-operations have been removed — use `bash ls`, `bash find`, and `bash grep` instead.

### Requirements

#### Requirement: Bash Guardrail Intent Detection

The satellite server SHALL detect bash command intent that indicates use of a dedicated file operation tool, and SHALL return an `isError: true` response with guidance to use the dedicated tool instead. This guardrail SHALL apply only to satellite `satellite_remote_exec` + `tool: "bash"` (local `bash` is not guarded). The budget key SHALL be `${turnId}:satellite:${intent}`. The guardrail SHALL NOT match `ls`/`find`/`grep` commands — those bash invocations pass through to the server unchanged.

##### Scenario: bash cat guided to read
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat /path/to/file")`
- **WHEN** `detectBashIntent` returns `"read"`
- **THEN** The hook returns `{ block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/path/to/file' }" }`

##### Scenario: bash sed -i guided to edit
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/x/y/' /path/to/file")`
- **WHEN** `detectBashIntent` returns `"edit"`
- **THEN** The hook returns `{ block: true, reason: "Prefer edit over bash sed -i. Use { tool:\"edit\", path:'/path/to/file', edits:[{oldText,newText}] }" }`

##### Scenario: bash echo/printf > guided to write
- **GIVEN** Agent calls `remote_exec(tool="bash", command="echo 'x' > /path/to/file")`
- **WHEN** `detectBashIntent` returns `"write"`
- **THEN** The hook returns `{ block: true, reason: "Prefer write over bash echo redirect. Use { tool:\"write\", path:'/path/to/file', content:'...' }" }`

##### Scenario: legitimate bash command passes through
- **GIVEN** Agent calls `remote_exec(tool="bash", command="ls -la /path")`
- **WHEN** `detectIntent` returns `null`
- **THEN** The server spawns the command normally without interception

##### Scenario: bash pipeline usage not falsely intercepted
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat file1 file2 | grep x")`
- **WHEN** `detectIntent` evaluates the command
- **THEN** It returns `null` (pipe detected, command is a pipeline, not a simple cat)

##### Scenario: bash stdin redirect not falsely intercepted
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat < input.txt")`
- **WHEN** `detectIntent` evaluates the command
- **THEN** It returns `null` (stdin redirect, not a file read)

#### Requirement: Guardrail Retry Budget

The satellite server SHALL allow at most 2 consecutive intercepts per guardrail intent category per turn, and SHALL return a hard error on the 3rd violation.

##### Scenario: third violation hard-blocks
- **GIVEN** Agent has been intercepted twice in the same turn for `cat` → `read` guidance
- **WHEN** Agent calls `remote_exec(tool="bash", command="cat /path")` a third time
- **THEN** The hook returns `{ block: true, reason: "Blocked: you have tried bash with similar intent 3 times. Use tool=read instead." }`

##### Scenario: different intent category resets counter
- **GIVEN** Agent has been intercepted once for `cat` → `read`
- **WHEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/a/b/' /path")`
- **THEN** The hook returns guidance error for `sed` and the `read` counter is not affected

#### Requirement: Bash Default Timeout

The satellite server SHALL apply a default timeout of 30 seconds to bash commands when the agent does not specify a `timeout` parameter.

##### Scenario: command exceeding default 30s timeout is killed
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sleep 60")` without `timeout`
- **WHEN** 30 seconds elapse without the process completing
- **THEN** The server kills the process group and returns `isError: true` with content: "Command exceeded 30s timeout (no timeout set). Use timeout=<seconds> for long tasks."

##### Scenario: explicit timeout is respected
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sleep 60", timeout=5)`
- **WHEN** 5 seconds elapse
- **THEN** The server kills the process and returns `isError: true` with content: "Command exceeded 5s timeout."

#### Requirement: Sub-Operation Schema Alignment with Native Tools

The satellite server's sub-operation schemas SHALL match native pi tool schemas in parameter name, type, optionality, and description. Sub-tool names SHALL match the local tool names: `read`/`write`/`edit`. The satellite SHALL expose only 5 sub-operations: `bash`, `read`, `write`, `edit`, `transfer_file`. The `list`, `find`, `grep` sub-operations are removed.

#### Requirement: File Transfer Sub-Operation

The satellite server SHALL provide a `transfer_file` sub-operation that moves file content between local and remote locations using HTTP body transport (no LLM context tokens for file content).

##### Scenario: transfer_file remote_to_local direction
- **GIVEN** Agent needs to read a remote file and write it locally
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="remote_to_local", local_path="/local/path", remote_path="/remote/path")`
- **THEN** The server reads `/remote/path` and returns its base64-encoded content

##### Scenario: transfer_file local_to_remote direction
- **GIVEN** Agent needs to write a local file to remote
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="local_to_remote", local_path="/local/path", remote_path="/remote/path", content=<base64>)`
- **THEN** The server writes the decoded content to `/remote/path` and returns a success message

##### Scenario: transfer_file invalid direction rejected
- **GIVEN** Agent calls `remote_exec(tool="transfer_file", direction="push", ...)`
- **WHEN** The schema validator parses the input
- **THEN** Validation fails with `isError: true`

#### Requirement: HTTP Transfer Endpoints

The satellite server SHALL expose `POST /transfer?path=` and `GET /transfer?path=` HTTP endpoints for raw byte transport of file content, gated by `checkAuth`.

##### Scenario: POST /transfer writes body to remote path
- **GIVEN** A POST request to `/transfer?path=/remote/x.txt` with a body of bytes
- **WHEN** The server processes the request
- **THEN** It writes the bytes to `/remote/x.txt` (creating parent directories) and returns 200 with bytes written

##### Scenario: GET /transfer returns file bytes
- **GIVEN** A GET request to `/transfer?path=/remote/x.txt` with valid auth
- **WHEN** The server processes the request
- **THEN** It returns 200 with `Content-Type: application/octet-stream` and the file contents as body

##### Scenario: /transfer without auth returns 401
- **GIVEN** A request to `/transfer` without `Authorization: Bearer <token>`
- **WHEN** The server processes the request
- **THEN** It returns 401 Unauthorized

##### Scenario: /transfer missing path query returns 400
- **GIVEN** A request to `/transfer` without `?path=` query parameter
- **WHEN** The server processes the request
- **THEN** It returns 400 Bad Request

#### Requirement: Layer A System Prompt Soft Guardrail

The pi agent SHALL inject a system prompt section declaring remote path ownership when the satellite MCP server is configured with a `remotePathPattern` field.

##### Scenario: system prompt includes remote path declaration
- **GIVEN** `~/.pi/agent/mcp.json` contains satellite config with `remotePathPattern: "/TJPROJ\\d+"`
- **WHEN** The agent starts a session
- **THEN** The system prompt contains a "Remote Paths" section declaring that paths matching `/TJPROJ\d+/` are on the remote HPC and must be accessed via `satellite_remote_exec`

### MODIFIED Requirements

#### Requirement: Bash Guardrail Intent Detection (satellite-only)

The guardrail was changed from shared (local + satellite) to satellite-only. The budget key changed from `${turnId}:${prefix}:${intent}` to `${turnId}:satellite:${intent}`. Detection of `ls`/`find`/`grep` was removed — those commands now pass through.

#### Requirement: Sub-Operation Schema Alignment

Sub-tool names changed from `read`/`write`/`edit`/`list`/`find`/`grep` to `read`/`write`/`edit` (5 tools total). The `list`, `find`, `grep` sub-operations were removed from the server.

### REMOVED Requirements

#### list_sub_tool
- **Reason**: The `list` sub-tool was a thin wrapper around `fs.readdir`; equivalent to `bash(ls ...)`. Removed to reduce surface area.
- **Migration**: Replace `remote_exec(tool="list", ...)` with `remote_exec(tool="bash", command="ls ...")`.

#### find_sub_tool
- **Reason**: The `find` sub-tool delegated to `fd` subprocess, equivalent to `bash(find ...)`. The `fd` dependency was a deployment burden.
- **Migration**: Replace `remote_exec(tool="find", ...)` with `remote_exec(tool="bash", command="find ...")` or `remote_exec(tool="bash", command="fd ...")`.

#### grep_sub_tool
- **Reason**: The `grep` sub-tool delegated to `rg` subprocess, equivalent to `bash(grep ...)`. The `rg` dependency was a deployment burden.
- **Migration**: Replace `remote_exec(tool="grep", ...)` with `remote_exec(tool="bash", command="grep ...")` or `remote_exec(tool="bash", command="rg ...")`.

<!-- Removed: v2 stdio MCP transport (`extensions/satellite/satellite-mcp.ts`) — superseded by v3 StreamableHTTP transport. v2 has been unmaintained; all clients now connect to v3 HTTP endpoint at `http://<host>:29001/mcp`. Update any deployment scripts referencing `satellite-mcp` to use `satellite-server`. -->


## Capability: ask-user-question-tool

### Requirements

#### Requirement: ask_user_question Tool Registration
The personal-assistant extension SHALL register a tool named `ask_user_question` that the LLM can invoke to ask the user a multiple-choice question.

##### Scenario: Tool is registered with the correct name
- **GIVEN** the personal-assistant extension is loaded in a pi session
- **WHEN** pi initializes the extension via `index.ts`'s default export
- **THEN** `pi.registerTool` SHALL have been called exactly once with `name: "ask_user_question"`

##### Scenario: Tool description matches Claude Code spec
- **GIVEN** the registered tool is visible to the LLM via the API request tools array
- **WHEN** the LLM inspects the tool definition
- **THEN** the tool's `description` SHALL mention "2-4 options" and "multiSelect" semantics so the LLM knows the constraints

#### Requirement: Lenient Tool Schema for Hallucinated Argument Shapes
The `ask_user_question` tool's parameter schema SHALL accept every argument shape the LLM has been observed to emit in practice, including malformed wrapper objects.

##### Scenario: Standard Claude Code spec arguments
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", header: "H", options: [{label: "L1", description: "D1"}, {label: "L2", description: "D2"}], multiSelect: false}`
- **WHEN** pi validates the tool call against the registered schema
- **THEN** validation SHALL pass and `execute` SHALL be invoked with the raw arguments

##### Scenario: Nested `{item: {item: [...]}}` wrapper shape
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", header: "H", options: {item: {item: [{label: "L1", description: "D1"}, {label: "L2", description: "D2"}]}}}`
- **WHEN** pi validates the tool call
- **THEN** validation SHALL pass and `execute` SHALL receive the raw nested arguments
- **AND THEN** the `normalizeOptions` function inside `execute` SHALL unwrap the nested `.item` wrappers to produce a flat `[{label, description}]` array

##### Scenario: Missing `header` field
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", options: [{label, description}, {label, description}]}` (no `header`)
- **WHEN** `execute` runs
- **THEN** the tool SHALL treat the `question` field as the title and SHALL NOT error

##### Scenario: Missing `multiSelect` field
- **GIVEN** the LLM calls `ask_user_question` with `{question, header, options}` (no `multiSelect`)
- **WHEN** `execute` runs
- **THEN** the tool SHALL default `multiSelect` to `false` and proceed in single-select mode

##### Scenario: Empty or missing `options`
- **GIVEN** the LLM calls `ask_user_question` with `{question, header}` and no `options`
- **WHEN** `execute` runs
- **THEN** the tool SHALL return an `isError: true` result with text "ask_user_question requires at least 2 options" and SHALL NOT invoke any UI prompt

#### Requirement: Options Count Validation
The `ask_user_question` tool SHALL enforce the Claude Code spec constraint of 2-4 options.

##### Scenario: Exactly 2 options
- **GIVEN** the LLM calls with 2 options
- **WHEN** `execute` validates
- **THEN** validation SHALL pass and the UI SHALL prompt the user

##### Scenario: Exactly 4 options
- **GIVEN** the LLM calls with 4 options
- **WHEN** `execute` validates
- **THEN** validation SHALL pass and the UI SHALL prompt the user

##### Scenario: 1 option
- **GIVEN** the LLM calls with 1 option
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "requires 2-4 options"

##### Scenario: 5 or more options
- **GIVEN** the LLM calls with 5+ options
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "requires 2-4 options"

##### Scenario: multiSelect with fewer than 2 options
- **GIVEN** the LLM calls with `multiSelect: true` and 1 option
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "multiSelect requires at least 2 options"

#### Requirement: TUI Single-Select via Stock `ctx.ui.select`
In interactive TUI mode, the `ask_user_question` tool SHALL use `ctx.ui.select()` to prompt the user when `multiSelect` is false.

##### Scenario: TUI single-select happy path
- **GIVEN** pi is in `--mode interactive`, model calls `ask_user_question` with 3 single-select options
- **WHEN** `execute` runs
- **THEN** the tool SHALL call `ctx.ui.select(title, ["L1 — D1", "L2 — D2", "L3 — D3"], {timeout: 300000})` where labels are `label` concatenated with `description` via `" — "` separator
- **AND THEN** when the user selects "L1 — D1", the tool SHALL return `content: [{type: "text", text: "User selected: L1 — D1"}]` and `details: {selected: "L1 — D1", options: [...], multiSelect: false}`

##### Scenario: TUI user cancels via Esc
- **GIVEN** the user is viewing the TUI selector for `ask_user_question`
- **WHEN** the user presses Esc
- **THEN** `ctx.ui.select` SHALL resolve to `undefined`
- **AND THEN** the tool SHALL return `content: [{type: "text", text: "User cancelled the question"}]` and `details: {cancelled: true}`

##### Scenario: TUI timeout after 5 minutes
- **GIVEN** the user has been viewing the TUI selector for 5 minutes without action
- **WHEN** the `ExtensionUIDialogOptions.timeout` of 300000 ms elapses
- **THEN** `ctx.ui.select` SHALL resolve to `undefined` via pi's `createDialogPromise` timeout path
- **AND THEN** the tool SHALL return the same "User cancelled" result as the Esc case (timeout is a flavor of cancel)

#### Requirement: TUI Multi-Select via Stock `ctx.ui.input`
In interactive TUI mode, the `ask_user_question` tool SHALL use `ctx.ui.input()` with a comma-separated placeholder when `multiSelect` is true.

##### Scenario: TUI multi-select happy path
- **GIVEN** pi is in `--mode interactive`, model calls `ask_user_question` with 3 options and `multiSelect: true`
- **WHEN** `execute` runs
- **THEN** the tool SHALL call `ctx.ui.input(title, "L1 — D1 | L2 — D2 | L3 — D3 (comma-separated)", {timeout: 300000})`
- **AND THEN** when the user enters "L1 — D1, L3 — D3", the tool SHALL return `content: [{type: "text", text: "User selected: L1 — D1, L3 — D3"}]`

#### Requirement: Webui RPC Extension UI Request Forwarding
The webui server SHALL forward `extension_ui_request` events from the pi subprocess stdout to subscribed WebSocket clients.

##### Scenario: extension_ui_request reaches the browser
- **GIVEN** a webui session is subscribed to a session's events and the pi subprocess emits `{type: "extension_ui_request", id: "abc", method: "select", title: "...", options: [...], timeout: 300000}` on stdout
- **WHEN** the server's `session-pool.handleStdoutLine` parses the line
- **THEN** the server SHALL emit a `pool` event with `sessionId` and the parsed event
- **AND THEN** the WebSocket handler SHALL forward `{type: "session_event", sessionId, event: <extension_ui_request>}` to the subscribed client

#### Requirement: Webui Server Writes RPC Extension UI Response
The webui server SHALL accept `extension_ui_response` messages from WebSocket clients and write them to the corresponding pi subprocess's stdin as JSONL.

##### Scenario: Web client submits an answer
- **GIVEN** a web client previously received an `extension_ui_request` with `id: "abc"` from session `s1`
- **WHEN** the web client sends `{type: "extension_ui_response", id: "abc", value: "L1"}` to the server
- **AND WHEN** the server's WS handler parses the message
- **THEN** the handler SHALL call `pool.sendExtensionUIResponse("s1", {id: "abc", value: "L1"})`
- **AND THEN** `pool.sendExtensionUIResponse` SHALL write `{type: "extension_ui_response", id: "abc", value: "L1"}\n` to the pi subprocess's stdin

##### Scenario: Response without active session
- **GIVEN** a web client has not subscribed to any session (`activeSession` is `undefined`)
- **WHEN** the client sends `{type: "extension_ui_response", id, value}`
- **THEN** the WS handler SHALL send an error message back to the client: `"No active session"` and SHALL NOT write to any pi subprocess

##### Scenario: Send to non-existent session
- **GIVEN** a pi subprocess for session `s1` has exited and been removed from `pool.sessions`
- **WHEN** the WS handler calls `pool.sendExtensionUIResponse("s1", {...})`
- **THEN** the method SHALL silently return (no-op) and SHALL NOT throw

#### Requirement: Webui Client Modal Rendering
The webui client SHALL render a modal dialog when an `extension_ui_request` of method `select` or `input` is received, allowing the user to pick an answer.

##### Scenario: Modal renders question and options
- **GIVEN** the webui client receives `{type: "session_event", sessionId: "s1", event: {type: "extension_ui_request", id: "abc", method: "select", title: "Q1", options: ["L1 — D1", "L2 — D2"]}}`
- **WHEN** the `AskUserQuestionProvider` handles the event
- **THEN** the `AskUserQuestionModal` component SHALL mount showing the question text and the options as selectable buttons (label + description on two lines)

##### Scenario: Single-select submit
- **GIVEN** the modal is showing 2 single-select options
- **WHEN** the user clicks option "L1"
- **THEN** the modal SHALL call `onSubmit("L1")` and the provider SHALL send `{type: "extension_ui_response", id: "abc", value: "L1"}` over the WebSocket

##### Scenario: Multi-select submit
- **GIVEN** the modal is showing 3 multi-select options (checkboxes)
- **WHEN** the user checks "L1" and "L3" and clicks Submit
- **THEN** the modal SHALL call `onSubmit("L1, L3")` (labels in click order, comma-separated)

##### Scenario: User cancels the modal
- **GIVEN** the modal is showing options
- **WHEN** the user clicks the Cancel button or presses the Esc key
- **THEN** the modal SHALL call `onCancel` and the provider SHALL send `{type: "extension_ui_response", id: "abc", cancelled: true}` over the WebSocket

#### Requirement: Webui Pending Placeholder in Chat
The webui chat page SHALL display a "⏳ waiting for user answer" placeholder when an `extension_ui_request` is received, and SHALL replace it with the full tool call + result on `tool_execution_end`.

##### Scenario: Placeholder inserted on request
- **GIVEN** the chat page is rendering messages and a new `extension_ui_request` for session `s1` arrives
- **WHEN** the `ChatPage` event handler processes it
- **THEN** an `<AskUserQuestionPending>` element SHALL appear at the end of the messages list with the question text

##### Scenario: Placeholder replaced on tool execution end
- **GIVEN** a `<AskUserQuestionPending>` placeholder with `id: "abc"` is visible in the chat
- **WHEN** the chat page receives `{type: "tool_execution_end", toolCallId: "abc", toolName: "ask_user_question", result: {content: [{type: "text", text: "User selected: L1"}]}}`
- **THEN** the placeholder SHALL be replaced with a complete tool call entry showing both the call args and the result

##### Scenario: Placeholder preserved on unrelated tool execution end
- **GIVEN** a `<AskUserQuestionPending>` placeholder with `id: "abc"` is visible
- **WHEN** a `tool_execution_end` event arrives for a different `toolName` (e.g., `read`)
- **THEN** the placeholder SHALL remain visible

#### Requirement: Webui Multi-Modal Queue Per Session
The webui client SHALL queue multiple unanswered `extension_ui_request` events per session, showing them one at a time, and SHALL display a pending count when more than one is queued.

##### Scenario: Multiple requests queue serially
- **GIVEN** the modal is currently showing the request with `id: "abc"` from session `s1`
- **WHEN** a second `extension_ui_request` with `id: "def"` arrives for session `s1` while the first is still open
- **THEN** the second request SHALL be enqueued in `Map<sessionId, ModalState[]>` and SHALL NOT replace the current modal

##### Scenario: Next request shown after submission
- **GIVEN** 2 requests are queued for session `s1` and the user submits an answer for `id: "abc"`
- **WHEN** the submission completes
- **THEN** the modal SHALL close and the next queued request `id: "def"` SHALL automatically be shown

##### Scenario: Pending count indicator
- **GIVEN** 3 requests are queued for session `s1` and the modal for the first is currently displayed
- **WHEN** the provider updates the queue state
- **THEN** the topbar SHALL display "⏳ 还有 2 个未答问题" (or equivalent) for session `s1`

##### Scenario: Per-session queue isolation
- **GIVEN** a web client is subscribed to sessions `s1` and `s2`, and modal for `s1/id-a` is currently displayed
- **WHEN** a new `extension_ui_request` arrives for session `s2`
- **THEN** the new request SHALL be enqueued in `s2`'s queue, and the current modal for `s1/id-a` SHALL NOT be displaced

#### Requirement: 5-Minute Timeout via Stock Pi Mechanism
The `ask_user_question` tool SHALL use the stock `ExtensionUIDialogOptions.timeout` mechanism (5 minutes) to bound how long the user has to respond.

##### Scenario: Timeout fires after 5 minutes with no response
- **GIVEN** the user has been viewing the `ask_user_question` UI for 5 minutes without responding
- **WHEN** the timeout elapses
- **THEN** the underlying `ctx.ui.select` or `ctx.ui.input` promise SHALL resolve to `undefined`
- **AND THEN** the tool SHALL return a cancel result and the LLM SHALL be informed that the user did not respond
- **AND THEN** the webui modal SHALL close and the chat placeholder SHALL be replaced with the cancel tool result

#### Requirement: No Persistence of Unanswered Modals
The webui client SHALL NOT persist unanswered modal state to localStorage or any other storage. Refreshing the page SHALL drop the modal and the placeholder; the tool's timeout will eventually fire on the server side.

##### Scenario: Page refresh drops the modal
- **GIVEN** a modal is open and a chat placeholder is visible
- **WHEN** the user refreshes the browser
- **THEN** the modal and placeholder SHALL be gone after reload
- **AND THEN** the pi subprocess's `ctx.ui.select` SHALL still be waiting; after the 5-minute timeout, the tool SHALL return the cancel result and the LLM SHALL continue

#### Requirement: No History Rewriting for Pre-Existing Not-Found Errors
This change SHALL NOT modify any existing session JSONL files to retroactively "fix" `Tool ask_user_question not found` errors that occurred before the change was deployed.

##### Scenario: Pre-existing error records are preserved
- **GIVEN** a session JSONL contains entries with `toolName: "ask_user_question"` and `isError: true` and `errorMessage: "Tool ask_user_question not found"`
- **WHEN** the change is deployed
- **THEN** those entries SHALL remain unchanged in the session JSONL

### MODIFIED Requirements

#### Requirement: Webui Server WS Protocol Message Types
The `ClientMessage` type union in `ws/handler.ts` SHALL be extended to include `extension_ui_response` messages so that the browser can send back RPC extension UI responses.

##### Scenario: WS handler routes extension_ui_response messages
- **GIVEN** a web client sends a WebSocket message of type `extension_ui_response`
- **WHEN** the WS handler processes the message
- **THEN** the handler SHALL call `pool.sendExtensionUIResponse(sessionId, response)` with the active session ID
- **AND THEN** the handler SHALL NOT throw or send an "Unknown message type" error for this new variant

#### Requirement: Webui SessionPool RPC Write Methods
The `SessionPool` class SHALL expose a `sendExtensionUIResponse(sessionId, response)` method for routing WebSocket-originated RPC responses to the pi subprocess.

##### Scenario: sendExtensionUIResponse writes valid JSONL
- **GIVEN** a session with a running pi subprocess
- **WHEN** `pool.sendExtensionUIResponse("s1", {id: "abc", value: "L1"})` is called
- **THEN** the method SHALL write `{"type":"extension_ui_response","id":"abc","value":"L1"}\n` to the subprocess's stdin
- **AND THEN** the method SHALL be a no-op (silent return) if the session has no proc or the proc has exited


## Capability: ask-user-question-card

### Requirements

#### Requirement: Webui Inline Card Rendering
Webui client SHALL render an inline card inside the assistant message bubble when an `ask_user_question` toolCall part is present, instead of a full-screen modal.

##### Scenario: Card appears inline in assistant message
- **GIVEN** model emits a toolCall part with name `ask_user_question`
- **WHEN** ChatPage receives the corresponding `extension_ui_request` event via ws
- **THEN** an `<AskUserQuestionCard>` is rendered inside the assistant message bubble, after the toolCall and before the toolResult

#### Requirement: Single-Select Click Submits Immediately
Single-select card SHALL submit the chosen option on click, without requiring a separate Submit button.

##### Scenario: Click option sends ws message
- **GIVEN** card is in active state with 4 options, multiSelect=false
- **WHEN** user clicks option "红色"
- **THEN** `ws.send({type:"extension_ui_response", id, value:"红色"})` is called
- **AND** card transitions to disabled state with selected="红色"

#### Requirement: Multi-Select Numbered Input
Multi-select card SHALL display numbered options and accept comma-separated numbers in an inline input box.

##### Scenario: Type numbers and submit
- **GIVEN** card is in active state with 3 options, multiSelect=true
- **WHEN** user types "1,3" in the card's input box and clicks Submit
- **THEN** `ws.send({type:"extension_ui_response", id, value:"label1, label2"})` is called
- **AND** card transitions to disabled state

#### Requirement: Disabled Card Retains State
After user selection or timeout, the card SHALL remain in the message bubble with grayed options and a result text line.

##### Scenario: Disabled card shows selection
- **GIVEN** card is in disabled state with selected="红色"
- **WHEN** message is rendered
- **THEN** all options are grayed and non-interactive
- **AND** a text line "你的选择: 红色" appears above the options

##### Scenario: Timeout card shows timeout text
- **GIVEN** card is in timeout state
- **WHEN** message is rendered
- **THEN** all options are grayed and non-interactive
- **AND** a text line "已超时" appears above the options

#### Requirement: Card Appears in Session History
Previous ask_user_question interactions SHALL be visible when re-entering a session, through the toolResult part's content text.

##### Scenario: Re-entering session shows past selection
- **GIVEN** a prior session where user selected "红色" via ask_user_question card
- **WHEN** user re-enters the session (API returns past messages)
- **THEN** the toolResult part shows "User selected: 红色"
- **AND** the card is NOT re-rendered in active state (no extension_ui_request event for past interactions)

#### Requirement: Card Flows Inline with Messages
The card SHALL NOT be fixed-positioned or z-index overlay. It follows the normal document flow inside the message bubble.

##### Scenario: Card scrolls with messages
- **GIVEN** long conversation with a card in the middle
- **WHEN** user scrolls the chat
- **THEN** the card scrolls with its parent message, not fixed on screen

#### Requirement: Multi-Select Card Matches By Recency
When an `extension_ui_request` arrives with a UUID id that does NOT match any toolCall id (the real rpc-mode behavior, where each dialog opens with `crypto.randomUUID()`), the webui SHALL match the request to the most recent `ask_user_question` toolCall in any assistant message, source `options` and `multiSelect` from the toolCall args, and store the original request UUID on the cardState as `requestId` for echoing back in `extension_ui_response`.

##### Scenario: Method=input card renders with options from toolCall args
- **GIVEN** a toolCall part `id: "call_00_abc"` with `args.options = [...]` and `args.multiSelect = true` is in the messages state
- **AND** an `extension_ui_request` arrives with `id: "<random-uuid>", method: "input"` (no options in event payload)
- **WHEN** the handler processes the event
- **THEN** the cardState SHALL be keyed by the toolCall id `call_00_abc` (so ToolGroup can look it up via `part.id`)
- **AND** options/multiSelect SHALL come from the toolCall args, not the event
- **AND** the original request UUID SHALL be stored as `cardState.requestId`

##### Scenario: Submit echoes the request UUID, not the toolCall id
- **GIVEN** a card has `requestId: "uuid-real"` and `id: "call_00_abc"`
- **WHEN** user submits via the card
- **THEN** `ws.send({type:"extension_ui_response", id: "uuid-real", value})` SHALL be called
- **AND** the server's `pendingExtensionRequests` map (keyed by the request UUID) SHALL resolve the original promise

#### Requirement: tool_execution_end With Object-Shape Result Does Not Crash
When the pi agent runtime emits `tool_execution_end` with `result` shaped as the tool's return value `{content: [{type:"text", text:"..."}], details: {...}}` (the canonical shape), the webui handler SHALL extract the human-readable text from `result.content[0].text` rather than calling string methods directly on `result`. Calling string methods on the object shape throws `TypeError` and unmounts the entire ChatPage subtree.

##### Scenario: Real-protocol result with content array
- **GIVEN** a `tool_execution_end` event with `result: {content: [{type:"text", text:"User selected: A, B"}], details: {...}}`
- **WHEN** the handler processes the event
- **THEN** the text SHALL be extracted as `"User selected: A, B"`
- **AND** the matching card SHALL transition to disabled state
- **AND** the ChatPage SHALL NOT crash (no uncaught exception)

### MODIFIED Requirements

#### Requirement: Webui Client Modal Rendering
The webui client SHALL render an inline `<AskUserQuestionCard>` inside the assistant message bubble when an `extension_ui_request` of method `select` or `input` is received. Full-screen modal rendering via `AskUserQuestionModal` SHALL NOT be used.

##### Scenario: Card renders inline instead of modal
- **GIVEN** the webui client receives `{type: "session_event", sessionId: "s1", event: {type: "extension_ui_request", id: "abc", method: "select", title: "Q1", options: ["L1", "L2"]}}`
- **WHEN** the ChatPage handler processes the event
- **THEN** an `<AskUserQuestionCard>` SHALL render inside the assistant message bubble
- **AND** no `<AskUserQuestionModal>` SHALL mount

##### Scenario: Single-select click submits inline
- **GIVEN** an inline card with 2 single-select options is rendered
- **WHEN** the user clicks option "L1"
- **THEN** the card SHALL call `onSubmit("L1")` and the handler SHALL send `{type: "extension_ui_response", id, value: "L1"}` over the WebSocket

##### Scenario: Multi-select input box submits
- **GIVEN** an inline multi-select card with 3 numbered options is rendered
- **WHEN** the user types "1,3" in the input box and clicks Submit
- **THEN** the card SHALL call `onSubmit("L1, L3")` (comma-separated labels in input order)

##### Scenario: User cancels the card
- **GIVEN** an inline card is rendered with options
- **WHEN** the user clicks the Cancel button
- **THEN** the card SHALL call `onCancel` and the handler SHALL send `{type: "extension_ui_response", id, value: ""}` (empty value, not cancelled:true, to keep server-side contract consistent)

#### Requirement: Webui Pending Placeholder in Chat
The webui chat page SHALL NOT use a separate `<AskUserQuestionPending>` placeholder strip. The `<AskUserQuestionCard>` itself serves as the in-line placeholder, and persists across selection/timeout (as a disabled card showing the result).

##### Scenario: No pending strip rendered
- **GIVEN** an `extension_ui_request` arrives
- **WHEN** ChatPage renders
- **THEN** no `<AskUserQuestionPending>` strip SHALL appear at the end of the messages list
- **AND** the inline card SHALL appear inside the assistant message bubble that contains the matching toolCall

##### Scenario: Card transitions to disabled on tool execution end
- **GIVEN** an active card is visible
- **WHEN** the chat page receives a `tool_execution_end` event with `toolName: "ask_user_question"` whose `toolCallId` matches the card's toolCall id
- **THEN** the card SHALL transition to disabled state showing the result text
- **AND** the inline position SHALL be preserved

#### Requirement: Webui Multi-Modal Queue Per Session
The webui client SHALL NOT queue multiple `extension_ui_request` events in a `Map<sessionId, ModalState[]>`. Each `extension_ui_request` SHALL create its own inline card embedded in its assistant message bubble; multiple active cards SHALL coexist in the message stream.

##### Scenario: Multiple active cards coexist
- **GIVEN** the model emits two `ask_user_question` toolCalls in two different assistant messages
- **WHEN** the corresponding `extension_ui_request` events arrive
- **THEN** two `<AskUserQuestionCard>` instances SHALL be visible, one in each assistant message bubble
- **AND** no per-session queue SHALL be used

### REMOVED Requirements

#### Requirement: AskUserQuestionModal Full-Screen Overlay
- **Reason**: 交互模式从全屏 modal 改为 inline 卡片,不再需要 fixed z-50 overlay
- **Migration**: 删除 `AskUserQuestionModal.tsx` + `AskUserQuestionProvider.tsx` + `AskUserQuestionPending.tsx`。新组件 `AskUserQuestionCard.tsx` 接手。

#### Requirement: AskUserQuestionProvider Modal Queue
- **Reason**: 不再是 per-session queue(卡片嵌入消息流,同一消息内只出现一次)
- **Migration**: 卡片渲染由 `MessageParts` layer 接管,状态管理由 `ChatPage.cardStates` Map 接管

#### Requirement: Pending Count Indicator
- **Reason**: 不再有跨卡片的"等待数量"概念,每张卡片独立显示状态
- **Migration**: topbar 不再显示 "⏳ 还有 N 个未答问题"

## Capability: agent-harness-steering

### Requirements

#### Requirement: Steer triggers before_agent_start

The `steer()` method on `AgentHarness` SHALL emit the `before_agent_start` hook so that extensions listening on `before_agent_start` (e.g., memory recall) can react to the new user message as a fresh prompt topic. The hook SHALL fire after the message push and queue update, but before the next LLM turn begins.

##### Scenario: Steer emits before_agent_start with steer text as prompt
- **GIVEN** AgentHarness is in non-idle phase
- **AND** a test extension is registered that subscribes to `before_agent_start`
- **WHEN** user calls `harness.steer("看下 cron 模块性能")`
- **THEN** the extension's `before_agent_start` handler is called
- **AND** the event's `prompt` field equals `"看下 cron 模块性能"`
- **AND** the event's `systemPrompt` is the current harness system prompt (unchanged)
- **AND** the steer message is pushed to `steerQueue` for the next LLM turn to process

##### Scenario: Steer does not block when no extension listens
- **GIVEN** AgentHarness is in non-idle phase
- **AND** no extension is registered for `before_agent_start`
- **WHEN** user calls `harness.steer("any text")`
- **THEN** the call returns without throwing
- **AND** the steer message is in `steerQueue`

##### Scenario: Steer overwrites pending memory search
- **GIVEN** a previous `before_agent_start` already set `pendingMemorySearch = { promise: P1, ... }`
- **AND** P1 has not yet been consumed
- **WHEN** user calls `harness.steer("new topic")`
- **THEN** `pendingMemorySearch` is set to a new `{ promise: P2, ... }`
- **AND** P1's eventual resolution is silently discarded (its result is never injected into context)

## Capability: compaction-file-tracking

### Requirements

#### Requirement: Compaction tracks grep/find/ls as read (本地)

The `extractFileOpsFromMessage` function in both `packages/agent/src/harness/compaction/utils.ts` and `packages/coding-agent/src/core/compaction/utils.ts` SHALL recognize `grep`, `find`, and `ls` tool calls and add `args.path` to `fileOps.read`. If `args.path` is undefined, no path is added and no error is thrown.

##### Scenario: Grep with explicit path
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Find with explicit path
- **GIVEN** assistant message with `toolCall({ name: "find", arguments: { pattern: "*.ts", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Ls with explicit path
- **GIVEN** assistant message with `toolCall({ name: "ls", arguments: { path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Grep without path argument
- **GIVEN** assistant message with `toolCall({ name: "grep", arguments: { pattern: "TODO" } })` (no path)
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** no path is added to `fileOps.read`
- **AND** no error is thrown (path is optional)

#### Requirement: Compaction tracks satellite_remote_exec sub-tool as read

The `extractFileOpsFromMessage` function SHALL recognize `satellite_remote_exec` MCP tool calls and, when `args.tool` is `"grep"`, `"find"`, or `"ls"`, add `args.path` to `fileOps.read`. Other sub-tools (`read`, `write`, `edit`, `bash`, `transfer_file`) are not tracked by this capability.

##### Scenario: Satellite grep
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "grep", pattern: "TODO", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Satellite find
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "find", pattern: "*.ts", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Satellite ls
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "ls", path: "src" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src"`

##### Scenario: Satellite read sub-tool not tracked
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "read", path: "src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` does not contain `"src/foo.ts"`
- **AND** no error is thrown (out of scope for this capability)

##### Scenario: Satellite bash sub-tool not tracked
- **GIVEN** assistant message with `toolCall({ name: "satellite_remote_exec", arguments: { tool: "bash", command: "cat src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** no file paths are added to any `fileOps` set
- **AND** no error is thrown

#### Requirement: read/write/edit tool tracking unchanged

The `extractFileOpsFromMessage` function SHALL continue to track `read`, `write`, and `edit` tool calls exactly as before, without behavioral change.

##### Scenario: read tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "read", arguments: { path: "src/foo.ts" } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.read` contains `"src/foo.ts"`

##### Scenario: write tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "write", arguments: { path: "src/foo.ts", content: "..." } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.written` contains `"src/foo.ts"`

##### Scenario: edit tool call tracks path
- **GIVEN** assistant message with `toolCall({ name: "edit", arguments: { path: "src/foo.ts", edits: [...] } })`
- **WHEN** `extractFileOpsFromMessage` processes this message
- **THEN** `fileOps.edited` contains `"src/foo.ts"`

## Capability: webui-memory-page



### Requirements

#### Requirement: Webui Server List Memory Atoms
The webui server SHALL expose `GET /api/memory` that returns a JSON array of `MemoryAtom` objects. The server SHALL support query parameters `archived` (values: `"active"` default, `"archived"`, `"all"`), `type` (comma-separated multi-select), `tag` (single), `q` (free-text matching against `title` and `summary`), `limit` (default 200, max 1000), and `offset`. The server SHALL read atoms from `MemoryIndex.getAllAtoms()` and apply filters in this order: archived → type → tag → q → sort by `updated_at` desc → limit/offset. The response SHALL NOT include `.md` file body content (only DB-row metadata). When the DB file does not exist, the server SHALL initialize a fresh DB and return an empty array.

##### Scenario: List all active atoms by default
- **GIVEN** `~/.pi/agent/data/memory.db` contains 12 atoms with `archived = 0` spanning 7 types
- **WHEN** `GET /api/memory` is called with no query parameters
- **THEN** the response is a JSON array of 12 atoms, all with `archived: false`, sorted by `updated_at` descending

##### Scenario: List filters by archived mode
- **GIVEN** the DB contains 3 archived atoms and 9 active atoms
- **WHEN** `GET /api/memory?archived=archived` is called
- **THEN** the response contains exactly the 3 archived atoms
- **WHEN** `GET /api/memory?archived=all` is called
- **THEN** the response contains all 12 atoms

##### Scenario: List filters by type and tag and q
- **GIVEN** the DB contains a mix of 7 types, some atoms have tag `"rust"`, some titles contain `"font"`
- **WHEN** `GET /api/memory?type=preference,workflow&tag=rust&q=font` is called
- **THEN** the response contains only atoms whose `type` is `preference` OR `workflow`, AND `tags` includes `"rust"`, AND `title` or `summary` matches `"font"`

##### Scenario: List returns empty array on fresh DB
- **GIVEN** `~/.pi/agent/data/memory.db` does not exist
- **WHEN** `GET /api/memory` is called
- **THEN** the server initializes a fresh DB and returns `[]` with HTTP 200

##### Scenario: List returns empty array on existing DB with zero atoms
- **GIVEN** the DB exists but `memory_index` has 0 rows
- **WHEN** `GET /api/memory` is called
- **THEN** the response is `[]` with HTTP 200

#### Requirement: Webui Server Get Memory Atom Detail
The webui server SHALL expose `GET /api/memory/:id` that returns a single `MemoryAtom` JSON object including the `content` field read from the `.md` file. When the atom has a `file_path`, the server SHALL call `readAtomFromFile(file_path, content_hash)`. If the file is missing OR `readAtomFromFile` throws a hash-mismatch error, the server SHALL set `content: ""` and still return HTTP 200 (so the UI can render a `<memory-error>` placeholder). If the atom id does not exist, the server SHALL return HTTP 404 with `{ "error": "not found" }`.

##### Scenario: Get atom reads content from .md file
- **GIVEN** atom id `X` exists in DB with `file_path` and `content_hash` matching the on-disk file
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response includes `content` field with the file body (trimmed)

##### Scenario: Get atom returns 404 for missing id
- **GIVEN** atom id `X` does not exist
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 404 with `{ "error": "not found" }`

##### Scenario: Get atom returns empty content when .md file is missing
- **GIVEN** atom id `X` has `file_path = P` but the file `P` has been deleted externally
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 200 with `content: ""` and no error

##### Scenario: Get atom returns empty content when .md hash mismatches
- **GIVEN** atom id `X` has `content_hash = H1` but the file at `file_path` was externally edited and now hashes to `H2`
- **WHEN** `GET /api/memory/X` is called
- **THEN** the response is HTTP 200 with `content: ""` and no error

#### Requirement: Webui Server Patch Memory Atom
The webui server SHALL expose `PATCH /api/memory/:id` that accepts a JSON body of `Partial<MemoryAtom>` and updates the atom. The server SHALL: (1) load the existing atom via `getAtom(id)` — 404 if missing; (2) read the current body from the `.md` file via `readAtomFromFile(file_path, content_hash)`, falling back to `""` on file-missing or hash-mismatch; (3) merge `req.body` over the existing atom, using `req.body.content ?? currentBody` for the content field, bumping `version` by 1 and setting `updated_at` to now; (4) call `writeAtomToFile(merged, deps.atomsDir)` and adopt its returned `filePath` and `contentHash`; (5) `unlink` the old file if its `file_path` differs from the new one; (6) call `idx.upsertAtom(merged)`; (7) call `idx.invalidateEmbedding(merged.id)`. The response SHALL be the updated atom JSON.

##### Scenario: Patch metadata field bumps version and updates file
- **GIVEN** atom `X` exists with `title = "old"`, `version = 3`
- **WHEN** `PATCH /api/memory/X` with `{ "title": "new" }` is called
- **THEN** the response atom has `title = "new"`, `version = 4`, `updated_at` set to now, `content_hash` updated, `file_path` updated to reflect the new slug

##### Scenario: Patch metadata preserves file body bytes
- **GIVEN** atom `X` exists with on-disk body of 5KB markdown
- **WHEN** `PATCH /api/memory/X` with `{ "title": "new title" }` (no `content` field) is called
- **THEN** the new `.md` file body bytes are identical to the old body bytes; only the frontmatter lines changed (new `title`, `version`, `updated_at`)

##### Scenario: Patch body rewrites .md file with new hash
- **GIVEN** atom `X` has `content_hash = H1` and `file_path = P1`
- **WHEN** `PATCH /api/memory/X` with `{ "content": "new body" }` is called
- **THEN** a new file is written at `P2 = atomsDir/<type>/<slug>.md`; the old `P1` is unlinked; DB `content_hash = H2`, `file_path = P2`, `version+1`, `updated_at = now`; the `memory_embeddings` row for id `X` is deleted

##### Scenario: Patch with empty content string
- **GIVEN** atom `X` exists with non-empty body
- **WHEN** `PATCH /api/memory/X` with `{ "content": "" }` is called
- **THEN** the file is rewritten; the new file body is empty (or fallback to `summary` if `summary` is non-empty per `writeAtomToFile` body logic)

##### Scenario: Patch with empty tags array
- **GIVEN** atom `X` exists with `tags = ["foo", "bar"]`
- **WHEN** `PATCH /api/memory/X` with `{ "tags": [] }` is called
- **THEN** the DB row's `tags` JSON column is `[]` and the file's frontmatter reflects this

##### Scenario: Patch importance at boundary values
- **GIVEN** atom `X` exists
- **WHEN** `PATCH /api/memory/X` with `{ "importance": 0 }` or `{ "importance": 1 }` is called
- **THEN** the server accepts the value and persists; subsequent `runDecay` calls use `λ = baseDecay * (1 - importance)` so importance=1 means λ=0 (no decay)

##### Scenario: Patch type changes file_path directory
- **GIVEN** atom `X` has `type = "preference"`, `file_path = atomsDir/preference/foo.md`
- **WHEN** `PATCH /api/memory/X` with `{ "type": "constraint" }` is called
- **THEN** the new file is written to `atomsDir/constraint/foo.md`; the old `preference/foo.md` is unlinked; the new `file_path` reflects the new directory

##### Scenario: Patch returns 404 for missing id
- **GIVEN** atom id `X` does not exist
- **WHEN** `PATCH /api/memory/X` is called
- **THEN** the response is HTTP 404 with `{ "error": "not found" }`

#### Requirement: Webui Server Archive Memory Atom
The webui server SHALL expose `POST /api/memory/:id/archive` that accepts `{ "archived": boolean }` and toggles the atom's archived state. When `archived: true`, the server SHALL call `idx.markArchived(id)`. When `archived: false`, the server SHALL call `idx.upsertAtom({ ...atom, archived: false, version: atom.version + 1, updated_at: now })`. The response SHALL be `{ "ok": true, "atom": <updated atom> }` with HTTP 200, or HTTP 404 if the id does not exist.

##### Scenario: Archive active atom
- **GIVEN** atom `X` exists with `archived = false`
- **WHEN** `POST /api/memory/X/archive` with `{ "archived": true }` is called
- **THEN** the response is HTTP 200 with `ok: true` and the returned atom has `archived: true`; subsequent `GET /api/memory?archived=active` does not include `X`

##### Scenario: Restore archived atom
- **GIVEN** atom `X` exists with `archived = true`, `version = 5`
- **WHEN** `POST /api/memory/X/archive` with `{ "archived": false }` is called
- **THEN** the response is HTTP 200 with `ok: true` and the returned atom has `archived: false`, `version = 6`, `updated_at = now`

#### Requirement: Webui Server Memory Search (Real Pipeline)
The webui server SHALL expose `POST /api/memory/search` that accepts `{ "query": string, "topK"?: number }` and returns `{ "rewritten": QueryRewriteResult, "embedding_available": boolean, "results": Array<{ atom: MemoryAtom, fts_score: number, cosine_score: number, hybrid_score: number }> }`. The server SHALL call `rewriteQueryWithCallLlm(deps.callLlm, query, deps.settings)` to produce the rewritten query. If that call throws, the server SHALL fall back to `simpleKeywordExtraction(query)` and continue. The server SHALL then call `searchAtomsWithScores(idx, rewritten, topK ?? 10)` and return its result. The `embedding_available` field SHALL be `false` when the search used the pure-FTS branch (Ollama not running or `embedding.provider !== "local"`).

##### Scenario: Search returns results with score breakdown
- **GIVEN** the DB contains 3 atoms matching the query "字体"
- **WHEN** `POST /api/memory/search` with `{ "query": "用户偏好什么字体" }` is called and Ollama is available
- **THEN** the response includes `rewritten.keywords` and `rewritten.target_types`; `embedding_available: true`; `results` is a non-empty array where each result has `atom`, `fts_score`, `cosine_score`, `hybrid_score` fields

##### Scenario: Search falls back to simpleKeywordExtraction when LLM fails
- **GIVEN** `deps.callLlm` is configured to throw an error
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response is HTTP 200 with `rewritten.keywords` populated from `simpleKeywordExtraction`; results are still returned (possibly empty)

##### Scenario: Search uses pure FTS when embedding unavailable
- **GIVEN** Ollama is not running (or `embedding.provider` is not `"local"`)
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response has `embedding_available: false`; `cosine_score` on all results is `0`; FTS-only hybrid score is used

##### Scenario: Search on empty DB
- **GIVEN** the DB has 0 atoms
- **WHEN** `POST /api/memory/search` is called
- **THEN** the response has `results: []`, `embedding_available: false` (no candidates), HTTP 200

#### Requirement: Webui Server Memory Stats
The webui server SHALL expose `GET /api/memory/stats` that returns `{ "total": number, "archived": number, "byType": Record<MemoryAtomType, number> }` aggregating over `getAllAtoms(idx)`. `byType` SHALL include all 7 atom types (entries with count 0 may be omitted).

##### Scenario: Stats on empty DB
- **GIVEN** the DB has 0 atoms
- **WHEN** `GET /api/memory/stats` is called
- **THEN** the response is `{ "total": 0, "archived": 0, "byType": {} }`

##### Scenario: Stats with mixed types and archived
- **GIVEN** the DB has 5 atoms: 2 `preference`, 1 `workflow`, 1 `knowledge`, 1 archived `event`
- **WHEN** `GET /api/memory/stats` is called
- **THEN** the response is `{ "total": 5, "archived": 1, "byType": { "preference": 2, "workflow": 1, "knowledge": 1, "event": 1 } }`

#### Requirement: Personal-Assistant Public MemoryIndex API
The `extensions/personal-assistant/memory.ts` module SHALL export `class MemoryIndex`, `interface MemoryAtom`, `type MemoryAtomType`, `function writeAtomToFile(atom, baseDir?)`, `function readAtomFromFile(filePath, expectedHash?)`, `function searchAtoms(index, query, topK)`, `function rewriteQuery(query, ctx, config)`, `const ATOMS_DIR`, and `const MEMORY_DB_PATH` as public symbols. The `extensions/personal-assistant/index.ts` module SHALL re-export all of these so they are accessible via `@earendil-works/pi-personal-assistant`.

##### Scenario: Webui server can import MemoryIndex via the package alias
- **GIVEN** the webui server is configured with `paths` mapping `@earendil-works/pi-personal-assistant` to `extensions/personal-assistant/index.ts`
- **WHEN** a server file does `import { MemoryIndex, MemoryAtom } from "@earendil-works/pi-personal-assistant"`
- **THEN** TypeScript compiles without error and the symbols resolve to the extension's implementation

#### Requirement: Personal-Assistant Server-Friendly Memory Helpers
The `extensions/personal-assistant/memory.ts` module SHALL export the following server-friendly helpers: `function getAllAtoms(index: MemoryIndex): MemoryAtom[]` returning all atoms including archived; `function rewriteQueryWithCallLlm(callLlm: (prompt: string) => Promise<string>, query: string, config: PersonalAssistantConfig): Promise<QueryRewriteResult>` that uses the `callLlm` callback instead of `ctx.modelRegistry` and falls back to `simpleKeywordExtraction` on failure; `function searchAtomsWithScores(index, query, topK): Promise<{ results: Array<{ atom, fts_score, cosine_score, hybrid_score }>, embedding_available: boolean }>` that returns the score breakdown for the recall test panel.

##### Scenario: getAllAtoms includes archived atoms
- **GIVEN** the DB has 3 active atoms and 2 archived atoms
- **WHEN** `getAllAtoms(idx)` is called
- **THEN** it returns all 5 atoms (no archived filter)

##### Scenario: rewriteQueryWithCallLlm uses the provided callback
- **GIVEN** `callLlm` is a mock that returns `'{"keywords":["x"],"target_types":["preference"]}'`
- **WHEN** `rewriteQueryWithCallLlm(callLlm, "query", config)` is called
- **THEN** `callLlm` is invoked exactly once with the rewrite prompt; the function returns `{ keywords: ["x"], target_types: ["preference"], raw_query: "query" }`

##### Scenario: rewriteQueryWithCallLlm falls back on LLM error
- **GIVEN** `callLlm` rejects with an error
- **WHEN** `rewriteQueryWithCallLlm(callLlm, "hello world", config)` is called
- **THEN** the function returns the result of `simpleKeywordExtraction("hello world")` and does not throw

##### Scenario: searchAtomsWithScores returns breakdown with embedding
- **GIVEN** the DB has 3 atoms matching the query keywords, and Ollama is running
- **WHEN** `searchAtomsWithScores(idx, rewrittenQuery, 10)` is called
- **THEN** the result includes `embedding_available: true`; each result has `fts_score`, `cosine_score`, and `hybrid_score` numbers

##### Scenario: searchAtomsWithScores returns pure FTS breakdown when no embedding
- **GIVEN** Ollama is not running
- **WHEN** `searchAtomsWithScores(idx, rewrittenQuery, 10)` is called
- **THEN** the result has `embedding_available: false`; each result has `cosine_score: 0` and `hybrid_score` computed from FTS only

#### Requirement: MemoryIndex invalidateEmbedding Method
The `MemoryIndex` class SHALL expose a public method `invalidateEmbedding(id: string): void` that executes `DELETE FROM memory_embeddings WHERE id = ?`. This avoids exposing the private `db` field to external callers.

##### Scenario: invalidateEmbedding removes the embedding row
- **GIVEN** the DB has an embedding row for atom `X` in `memory_embeddings`
- **WHEN** `idx.invalidateEmbedding("X")` is called
- **THEN** the row is removed from `memory_embeddings`; subsequent `getEmbedding("X")` returns `null`

#### Requirement: Webui Client Auto-Save with Flush on Route Change
The webui client SHALL provide a `useAutoSave<T>(value: T, save: (v: T) => Promise<void>, delay?: number)` React hook (default delay 3000ms) that debounces calls to `save` until `value` has been stable for `delay` milliseconds. The hook SHALL expose a `state` field with values `idle | dirty | saving | saved | error`. On component unmount, the hook SHALL cancel any pending `setTimeout` and flush any pending save with a 200ms best-effort timeout. If `save` rejects, the hook SHALL transition to `error` state and retry once after another `delay` (no infinite retries).

##### Scenario: Debounce triggers save after 3s idle
- **GIVEN** a detail view is mounted with `useAutoSave({ title: "old" }, save)`
- **WHEN** the user changes the title to `"new"` and 3 seconds elapse without further changes
- **THEN** `save({ title: "new" })` is called exactly once

##### Scenario: Route change flushes pending save
- **GIVEN** the user has changed a field 1s ago (within the debounce window) and a pending `setTimeout` exists
- **WHEN** the user navigates away from `/memory` (component unmounts)
- **THEN** the pending `setTimeout` is cleared and the in-flight save is awaited with a 200ms best-effort timeout; if it succeeds the data is persisted before navigation completes

##### Scenario: Route quick toggle does not block
- **GIVEN** the user enters `/memory` and immediately clicks back to chat (no edit made)
- **WHEN** unmount happens
- **THEN** cleanup detects no pending save and no in-flight fetch; the route change completes immediately

##### Scenario: Save failure triggers one retry
- **GIVEN** the first PATCH attempt fails (network error or 5xx)
- **WHEN** the failure is observed
- **THEN** `state` becomes `error`; a second PATCH is attempted after `delay`; if the second attempt also fails the hook stops retrying and stays in `error` state

#### Requirement: Webui Client Memory Page
The webui client SHALL provide a `MemoryPage` React component at route `/memory` that displays a 3-pane layout: a left-side `MemoryList` (with type/tag/archived/q filters and a Refresh button), a right-side `MemoryDetail` (with `MemoryEditor` for metadata + body), and a collapsible `MemorySearchTester` panel at the bottom. The list and detail SHALL auto-refresh every 3 seconds via polling. The list SHALL include a stats badge in the header showing `total / byType` from `GET /api/memory/stats`. The page SHALL be reachable from a new Memory icon in the `AppShell` sidebar.

##### Scenario: Memory page route loads with empty state
- **GIVEN** the DB has 0 atoms
- **WHEN** the user navigates to `/memory`
- **THEN** the page renders the 3-pane layout with the list showing "No memories yet" and the detail showing an empty state

##### Scenario: Memory page lists atoms with type filter
- **GIVEN** the DB has 10 atoms across multiple types
- **WHEN** the user selects the `preference` type filter chip
- **THEN** the list re-renders showing only atoms whose `type === "preference"`

##### Scenario: Memory page shows stats badge
- **GIVEN** the DB has 12 atoms (2 preference, 3 workflow, 7 knowledge)
- **WHEN** the memory page loads
- **THEN** the header shows a stats badge with "12 total · 2 pref · 3 wf · 7 kn"

##### Scenario: Sidebar Memory icon navigates to /memory
- **GIVEN** the user is on `/sessions/<id>` (chat)
- **WHEN** the user clicks the Memory icon in the sidebar IconRow
- **THEN** the route changes to `/memory` and `MemoryPage` renders

#### Requirement: Webui Client Memory Detail and Editor
The `MemoryPage` SHALL provide a `MemoryDetail` component that loads the selected atom via `GET /api/memory/:id` and renders it via `MemoryEditor`. The `MemoryEditor` SHALL provide form controls for `title` (text), `type` (select), `importance` (slider 0-1 step 0.05), `tags` (chip input), `summary` (textarea), and `content` (textarea + Markdown preview tab). All field changes SHALL be funneled into a `Partial<MemoryAtom>` patch and passed to `useAutoSave` for 3s debounced PATCH submission. The detail header SHALL display read-only metadata (`strength`, `access_count`, `created_at`, `updated_at`, `last_access`, `file_path`) and the auto-save state badge.

##### Scenario: Click list item opens detail
- **GIVEN** the user is on `/memory` and the list shows 5 atoms
- **WHEN** the user clicks the first atom
- **THEN** the right pane loads the detail: `MemoryEditor` shows the title, type, importance, tags, summary, and content from `GET /api/memory/:id`

##### Scenario: Edit title auto-saves after 3s
- **GIVEN** detail for atom `X` is loaded
- **WHEN** the user changes the title to `"new title"` and stops typing for 3s
- **THEN** `PATCH /api/memory/X` with `{ title: "new title" }` is called; the header state badge transitions `dirty → saving → saved`; the list row reflects the new title

##### Scenario: Edit body auto-saves and triggers .md rewrite
- **GIVEN** detail for atom `X` is loaded with body 5KB
- **WHEN** the user changes the body content and stops typing for 3s
- **THEN** `PATCH /api/memory/X` with `{ content: "..." }` is called; the header shows `saved`; the underlying `.md` file at `atomsDir/<type>/<slug>.md` is rewritten with new hash

##### Scenario: Body editor with very long content
- **GIVEN** atom body is 50KB markdown
- **WHEN** detail loads
- **THEN** the body editor renders a textarea at 60vh with internal scroll; the preview tab uses the existing `Markdown` component to render the full content

#### Requirement: Webui Client Memory Search Tester Panel
The `MemoryPage` SHALL include a collapsible `MemorySearchTester` panel at the bottom that allows the user to enter a free-text query and POST it to `/api/memory/search`. The panel SHALL display the `rewritten.keywords` as chips, the `rewritten.target_types` as chips, an `embedding_available` indicator (gray "embedding unavailable" badge when false), and the result list with each row showing the atom's title and a hover tooltip revealing `{ fts_score, cosine_score, hybrid_score, strength, importance }`. Clicking a result SHALL select that atom in the detail pane.

##### Scenario: Search tester submits real query
- **GIVEN** the user expands the search tester panel
- **WHEN** the user types "用户偏好什么字体" and clicks Search
- **THEN** `POST /api/memory/search` with `{ query: "用户偏好什么字体" }` is called; keywords and target_types chips render; results render as a list

##### Scenario: Search tester shows score breakdown on hover
- **GIVEN** search returns 3 results
- **WHEN** the user hovers over a result
- **THEN** a tooltip shows `fts: 0.80 · cos: 0.60 · hybrid: 0.71 · str: 0.90 · imp: 0.70`

##### Scenario: Search tester shows embedding unavailable
- **GIVEN** Ollama is not running
- **WHEN** the user runs a search
- **THEN** the panel shows a gray "embedding unavailable" badge; `cosine_score: 0` is displayed in result tooltips

##### Scenario: Search tester LLM rewrite fallback notice
- **GIVEN** `deps.callLlm` fails (5xx or timeout)
- **WHEN** the user runs a search
- **THEN** the panel renders successfully with `simpleKeywordExtraction` keywords; a small note "using keyword fallback (no LLM rewrite)" appears above the results

#### Requirement: Personal-Assistant Slugify Collision Known Bug (Documented)
The `writeAtomToFile` function in `extensions/personal-assistant/memory.ts` SHALL use `join(atomsDir, atom.type, slugify(atom.title) + ".md")` as the file path, with no id-based suffix. Two atoms with the same title SHALL therefore map to the same file path; the later write SHALL overwrite the earlier one. This is a known bug; v1 SHALL NOT fix it. The webui client SHALL tolerate this by displaying `<memory-error>` when `readAtomFromFile` fails on the affected atom (via the empty-`content` behavior already specified in `Webui Server Get Memory Atom Detail`).

##### Scenario: Two atoms with identical title overwrite each other
- **GIVEN** atom A and atom B both have `title = "用 Rust 重写"` and are persisted
- **WHEN** either atom is read back via `GET /api/memory/:id`
- **THEN** the response has `content: ""` if the file's hash does not match the row's `content_hash` (because the file was last written by the other atom); the UI shows a `<memory-error>` placeholder

##### Scenario: Slug collision behavior is documented
- **GIVEN** the v1 implementation is shipped
- **WHEN** a user inspects the code or reads the design doc
- **THEN** `docs/sdd/changes/webui-memory-page/design.md` and the `Risks / Trade-offs` table document the slugify-collision behavior and note that the fix is deferred to v2
## Capability: memory-v2

持久化用户记忆:从 session 对话中提取 atom,根据 cosine 相似度去重,衰减归档,召回注入。完全替换 v1 (FTS5 + LLM query rewrite + slug 路径)。

### Requirements

#### Requirement: MemoryAtom 3 大类 (rule/fact/process)
MemoryAtom SHALL 用 `"rule" | "fact" | "process"` 三种类型。rule 包含用户的硬规则和偏好;fact 包含客观事实、时间事件、已知 bug;process 包含可执行流程、解决方案、跨 case 模式。

##### Scenario: type 字段只能是 3 选 1
- **GIVEN** extension 加载 `MemoryAtomType`
- **WHEN** 读取 `atom.type` 字段
- **THEN** 字段值是 `"rule"` 或 `"fact"` 或 `"process"`

##### Scenario: rule 类型永不因 strength 低而 archive
- **GIVEN** atom.type="rule",strength=0.05 (远低于 archiveThreshold)
- **WHEN** `runDecay(index, baseDecay, archiveThreshold)` 执行
- **THEN** atom.archived 仍为 false

##### Scenario: DB schema 强制 type CHECK 约束
- **GIVEN** `memory_index` 表已创建
- **WHEN** 尝试 `INSERT INTO memory_index (type, ...) VALUES ('constraint', ...)`
- **THEN** SQLite 抛 CHECK constraint failed 错误

#### Requirement: 内容指纹 dedup (sha256 normalize)
MemoryIndex SHALL 用 `content_fingerprint = sha256(normalizeContent(content)).slice(0, 16)` 作为精确去重的唯一标识,DB 唯一索引防并发重复。

##### Scenario: 同 normalized content 写入第二次被 UNIQUE INDEX 拦截
- **GIVEN** atom A 已存在,content_fingerprint="abc123def456"
- **WHEN** 尝试 INSERT 新 atom B, content_fingerprint="abc123def456"
- **THEN** SQLite 抛 UNIQUE constraint failed 错误 (idx_memory_active_fingerprint)
- **AND** INSERT 自动回滚

##### Scenario: normalizeContent 折叠空白 + lowercase
- **GIVEN** content = "PDF 图片  提取  \n\n"
- **WHEN** `normalizeContent(content)` 执行
- **THEN** 返回 `"pdf 图片 提取"` (多个空格折叠成 1,小写,trim)

#### Requirement: 余弦相似度去重阈值默认 0.92
executePlan SHALL 用 cosine 相似度阈值 0.92 判定 supersede。cosine > 0.92 → supersede 旧 atom 并新建带 parent_id 的 atom;cosine ≤ 0.92 → 新建独立 atom。

##### Scenario: cosine > 0.92 触发 supersede
- **GIVEN** atom A 已存在,embedding=[0.1, 0.2, ..., 0.5] (1024-dim)
- **AND** 新 item.content 算出的 embedding=[0.11, 0.21, ..., 0.51]
- **AND** cosine(A_emb, new_emb) = 0.93 > 0.92
- **WHEN** executePlan 处理该 item
- **THEN** atom A.is_latest=0
- **AND** 新 atom B.is_latest=1, B.parent_id=A.id
- **AND** A.strength transfer 到 B.strength
- **AND** A.access_count transfer 到 B.access_count

##### Scenario: cosine ≤ 0.92 创建独立 atom
- **GIVEN** 现有 atom 都不与新 item 相似 (cosine 都 ≤ 0.92)
- **WHEN** executePlan 处理新 item
- **THEN** 新 atom C.is_latest=1, C.parent_id=null
- **AND** DB 中现存 atom 的 is_latest 字段不变

#### Requirement: SQLite 事务保证 supersede 原子性
supersede 旧 atom (UPDATE is_latest=0) + 插入新 atom (INSERT) + 写 audit 必须用 `BEGIN IMMEDIATE` 包成一个事务。事务失败自动 rollback,DB 不留半状态。

##### Scenario: 事务中插入新 atom 失败 → 旧 atom is_latest 仍是 1
- **GIVEN** BEGIN TX 已执行,旧 atom A 已 UPDATE is_latest=0
- **AND** INSERT 新 atom B 抛错 (e.g., UNIQUE 冲突)
- **WHEN** 事务回滚
- **THEN** atom A.is_latest 仍是 1 (rollback 恢复)
- **AND** 新 atom B 不存在

##### Scenario: 成功提交事务后两 atom 状态正确
- **GIVEN** atom A is_latest=1,parent_id=null
- **WHEN** markSupersededTx(A.id, B.id) 成功执行
- **THEN** A.is_latest=0, A.superseded_at 不为空
- **AND** B.is_latest=1, B.parent_id=A.id
- **AND** memory_audit 有 2 条记录 (A action='mark_superseded', B action='create')

#### Requirement: Extraction prompt 移除 LLM 决策字段
Extraction prompt SHALL 不让 LLM 决定 create/update/skip,只让 LLM 输出 `{type, title, content, summary, tags, importance}`。LLM 不知道也不关心 dedup。

##### Scenario: prompt 不含 "action" 或 "update" 关键词
- **GIVEN** EXTRACT_PROMPT_V2 常量
- **WHEN** 检查 prompt 文本
- **THEN** 不含 `"action"` / `"create"` / `"update"` / `"skip"` / `"id"` (除了 reference to existing atoms id)

##### Scenario: prompt 要求 2-4 段 content
- **GIVEN** EXTRACT_PROMPT_V2
- **WHEN** 读取 "content" 字段说明
- **THEN** 含 "2-4 段" 或等效描述
- **AND** 不含 "one-sentence"

##### Scenario: prompt 含 3 类 type 标准
- **GIVEN** EXTRACT_PROMPT_V2
- **WHEN** 读取 "Memory Type" 段
- **THEN** 含 rule / fact / process 三个 type 的定义
- **AND** 每个 type 有 trigger words + example

#### Requirement: Embedding 输入是完整 atom 文本
`embedText(embeddableText)` SHALL 接受 `title + summary + content + tags` 拼接的文本作为输入,而非仅 title。

##### Scenario: buildEmbeddableText 包含所有字段
- **GIVEN** atom.title="X", atom.summary="Y", atom.content="Z", atom.tags=["A", "B"]
- **WHEN** `buildEmbeddableText(atom)` 执行
- **THEN** 返回字符串包含 "X", "Y", "Z", "A", "B"
- **AND** 至少包含 1 个 `\n\n` 分隔符

##### Scenario: 写入 atom 时 embedding 内容是完整文本
- **GIVEN** executePlan 写入新 atom
- **WHEN** 调 `embedText(buildEmbeddableText(newAtom))`
- **THEN** 调 ollama 时 `input` 字段含 atom 所有字段拼接 (不只 title)

#### Requirement: 纯向量检索 (无 FTS,无混合)
recallAtoms SHALL 用 sqlite-vec KNN 单向量检索,不做 FTS 匹配,不做 BM25 + Vector hybrid scoring。

##### Scenario: recallAtoms 不调 searchByFts
- **GIVEN** memory.ts / search.ts 源码
- **WHEN** `grep -n "searchByFts\|FTS5\|bm25" extensions/personal-assistant/search.ts`
- **THEN** 无匹配 (0 行)

##### Scenario: recallAtoms 走 sqlite-vec KNN
- **GIVEN** DB 有 50 atom,memory_vectors 表有对应 embedding
- **WHEN** recallAtoms(index, query) 执行
- **THEN** sqlite-vec 收到 KNN 查询
- **AND** 不走任何 FTS MATCH 查询

#### Requirement: L0/L1 双层注入 + Token budget
formatMemoryContext SHALL 按 distance 排序遍历 results,每个 result:
- Top-3 (i < topNL1) → L1 tier (含 `<content>` 字段)
- 其余 → L0 tier (仅 `<title>` + `<summary>` + `<tags>`)
且总 token 数 (估算 `Math.ceil(text.length / 2.5)`) 不超过 tokenBudget。

##### Scenario: Top-3 atom 输出 L1 块
- **GIVEN** recallAtoms 返 5 atoms (按 distance asc 排序)
- **WHEN** formatMemoryContext(results, tokenBudget=4000, topNL1=3)
- **THEN** output 含 3 个 `<memory>` 块带 `<content>` 标签
- **AND** output 含 2 个 `<memory>` 块不带 `<content>` 标签
- **AND** 总 token 估算 ≤ 4000

##### Scenario: token budget 完全不够 (1 个 atom 都装不下)
- **GIVEN** tokenBudget=100,5 个 atom 每个 L0 块 ~150 tokens
- **WHEN** formatMemoryContext 执行
- **THEN** output 是空 `<memory-context>\n</memory-context>`
- **AND** 不抛错

##### Scenario: 加下一个 atom 会超 budget 时停止
- **GIVEN** 已加 3 个 L0 block (累计 300 tokens),tokenBudget=400
- **AND** 第 4 个 block ~150 tokens (加超 400)
- **WHEN** formatMemoryContext 继续遍历
- **THEN** 第 4 个 block 不加入
- **AND** output 只含前 3 个 block

#### Requirement: 文件路径用 atom.id (不用 slug)
writeAtomToFile SHALL 写 `atoms/<type>/<atom.id>.md`,不使用基于 title 的 slug 路径。

##### Scenario: 文件名是 randomUUID
- **GIVEN** atom.id = "018ebaad-114c-4585-87d4-10d2c05e50c2"
- **WHEN** writeAtomToFile(atom) 执行
- **THEN** 文件创建在 `atoms/<type>/018ebaad-114c-4585-87d4-10d2c05e50c2.md`
- **AND** 路径不含 "slug" / "title" 衍生

##### Scenario: 同 title 两个 atom 写到不同文件
- **GIVEN** atom A.id="uuid-1", title="X"
- **AND** atom B.id="uuid-2", title="X" (title 相同)
- **WHEN** writeAtomToFile(A) 后 writeAtomToFile(B)
- **THEN** 写两个独立文件 (uuid-1.md, uuid-2.md)
- **AND** 无 "file hash mismatch" 错误

#### Requirement: 召回失败无 fallback
recallAtoms SHALL 在 ollama 不可用时返回空数组,不退回到 FTS、关键词提取或其他检索方式。

##### Scenario: ollama 不可用 → recallAtoms 返空
- **GIVEN** ollama 进程未运行
- **AND** DB 有 atom,memory_vectors 有 embedding
- **WHEN** recallAtoms(index, query)
- **THEN** `embedText(query)` 返 null
- **AND** recallAtoms 立即返 `[]`
- **AND** 不调 searchByFts / simpleKeywordExtraction / 任何 fallback

##### Scenario: 主对话 recall 失败 → 无注入
- **GIVEN** ollama 不可用
- **WHEN** `before_agent_start` 触发 recallAtoms
- **THEN** pendingMemorySearch.promise 解析为 `[]`
- **AND** `context` handler 不注入任何 memory 块
- **AND** 主对话照常进行 (无 error)

#### Requirement: Extraction ollama 失败时降级写入 (无 embedding)
executePlan SHALL 在 ollama 不可用时,跳过 dedup 检测但仍写入 atom (DB + .md),但不调 insertVector (memory_vectors 无对应行)。

##### Scenario: extraction 期间 ollama 挂 → atom 写入但无 vector
- **GIVEN** ollama 不可用
- **AND** executePlan 处理 1 个 fingerprint 不命中的 item
- **WHEN** executePlan 跑
- **THEN** fingerprint 检查 skip
- **AND** embedText 失败 → skip cosine dedup
- **AND** 新 atom C 写入 memory_index (is_latest=1)
- **AND** C 的 file_path 指向 .md 文件
- **AND** memory_vectors 表无 C.id 对应行 (后续 recall 不会找到 C)

#### Requirement: Webui REST routes (7 个)
memory route SHALL 暴露以下 endpoint:
- `GET /api/memory` (list + filter)
- `GET /api/memory/stats`
- `GET /api/memory/:id` (含 .md body)
- `PATCH /api/memory/:id` (union tags + recompute embedding)
- `POST /api/memory/:id/archive` (toggle)
- `POST /api/memory/search` (recall + token budget)
- `POST /api/memory/extract` (manual extraction)

##### Scenario: GET /api/memory 列表
- **GIVEN** DB 有 12 active + 3 archived atom
- **WHEN** `GET /api/memory?archived=active`
- **THEN** 返 12 个 atom JSON array,按 updated_at DESC 排序
- **AND** HTTP 200

##### Scenario: GET /api/memory/:id 含 content (preview-only)
- **GIVEN** atom X 在 DB 中,对应的 .md 文件存在且 hash 匹配
- **WHEN** `GET /api/memory/X`
- **THEN** 返 atom JSON 含 `content` 字段 (从 .md 读)
- **AND** content_hash 校验通过
- **AND** HTTP 200
- **AND** **`updateAccess` NOT called** — preview 是只读,strength feedback 仅由 agent 的 `memory_get` tool 触发

##### Scenario: PATCH union tags
- **GIVEN** atom Y.tags=["foo"]
- **WHEN** `PATCH /api/memory/Y` with `{tags: ["bar"]}`
- **THEN** merged atom.tags = ["foo", "bar"] (union)
- **AND** merged atom.version = old.version + 1
- **AND** recompute embedding + write .md + upsert

##### Scenario: POST /api/memory/search 返 results (decoupled)
- **GIVEN** recallAtoms 可用
- **WHEN** `POST /api/memory/search {query: "PDF", topK: 5}`
- **THEN** 返 `{results: [{id, type, title, summary, tags, distance, cosine, score}, ...], recallTimeMs: N}`
- **AND** 响应**不**包含 `file_path`、`tier`、`formattedText`、`tokenBudgetUsed`
- **AND** HTTP 200
- **AND** 搜索过程**不**调 `updateAccess` — search 是 discovery-only,strength feedback 仅由 `memory_get` tool 触发

#### Requirement: Decay rule 类型永不 archive
runDecay SHALL 在 atom.type='rule' 时**永远不**调用 markArchived,即使 strength 已衰减到 archiveThreshold 以下。

##### Scenario: rule 类型 strength=0.01 不 archive
- **GIVEN** atom.type='rule', strength=1.0, last_access=100 天前
- **AND** archiveThreshold=0.1
- **WHEN** runDecay 跑
- **THEN** new_strength ≈ 1.0 * exp(-0.025 * 100) ≈ 0.082 (低于阈值)
- **AND** **不** markArchived
- **AND** atom.archived 仍是 false

##### Scenario: fact 类型 strength<threshold 时 archive
- **GIVEN** atom.type='fact', strength=0.5, last_access=120 天前
- **WHEN** runDecay 跑
- **THEN** new_strength ≈ 0.05
- **AND** markArchived 触发
- **AND** memory_vectors DELETE 该 id

#### Requirement: 召回质量评估 (labeled dataset)
recall-quality.test.ts SHALL 用 labeled dataset (10-20 atom,5-10 query) 验证召回质量,assert 最低门槛。

##### Scenario: 中文 query 命中中文 atom
- **GIVEN** atom A.title="PDF图片提取必须用pymupdf", content 含中文
- **WHEN** recallAtoms(index, "图片提取")
- **THEN** A 在 top-5
- **AND** recall@5 ≥ 0.5 (中文 case,门槛低)

##### Scenario: 整体 recall 门槛
- **GIVEN** dataset 10 atom (rule/fact/process 各几个,中英文混合)
- **WHEN** 对 5-10 query 跑 recallAtoms
- **THEN** avg_recall_at_5 ≥ 0.7
- **AND** avg_recall_at_10 ≥ 0.85
- **AND** avg_precision_at_5 ≥ 0.5

#### Removed: FTS5 + 混合检索 + LLM query rewrite + slug 路径 (v1 实现)

v1 的记忆实现包含以下 v2 移除的组件,记录在此供历史追溯:

<!-- Removed: FTS5 索引 (memory_fts 表) — FTS5 unicode61 中文 tokenization 失败,改用纯向量检索 -->

<!-- Removed: searchByFts / searchAtoms / searchAtomsWithScores (混合检索) — 删 FTS 后纯向量检索,不需要混合 scoring -->

<!-- Removed: rewriteQuery / rewriteQueryWithCallLlm / callOllamaRewrite (LLM 改写 query) — LLM 改写经常把中文译英文,反而错位。直接 embed 原文 -->

<!-- Removed: simpleKeywordExtraction / dedupeRedundantKeywords / dedupeAgainstQuery — 关键词 dedup 不再需要,改用 content fingerprint + cosine -->

<!-- Removed: expandCjkKeywords (CJK 拆字) — bge-m3 是多语言 embedding,直接 embed 原文即可,不需要词袋级匹配 -->

<!-- Removed: isEmbeddingServiceAvailable 独立函数 — 失败即空,不展示 "embedding unavailable" badge -->

<!-- Removed: slug 文件路径 (基于 title 衍生的 slug) — 同 title collision 导致文件覆盖。改用 atom.id -->

## Capability: memory-search-decoupled

`memory-v2` 之后的进一步解耦:search 不再返回 file_path (LLM 不再能用 `read` tool 拿全文),转而暴露 `memory_get(id)` tool 作为唯一程序入口;搜索召回使用 per-type top-3 + 乘法 boost score 公式;`scoreUserTone` 给 extraction LLM 提供 `<user_tone>` hint 让其自主判断 importance。

### Requirements

#### Requirement: memory_get tool
The agent MUST expose a `memory_get` tool that, given an atom id, returns the full atom content and records the call as a strength-feedback signal.

##### Scenario: fetch full content by id
- **GIVEN** an atom exists in the DB with id=`X`, type=`rule`, title=`T`, summary=`S`, content=`C`
- **WHEN** the agent invokes `memory_get({ id: "X" })`
- **THEN** the tool returns `{ content: [{ type: "text", text: "T\nS\nC" }], details: { id: "X", type: "rule", title: "T", content: "C", summary: "S", tags, importance } }`
- **AND THEN** the atom's `access_count` is incremented by 1
- **AND THEN** the atom's `last_access` is set to the current ms epoch

##### Scenario: not found
- **GIVEN** no atom exists with id=`missing`
- **WHEN** the agent invokes `memory_get({ id: "missing" })`
- **THEN** the tool returns `{ content: [{ type: "text", text: "atom not found: missing" }], details: { error: "not_found", id: "missing" } }`
- **AND THEN** no row is modified

##### Scenario: tool registration contract
- **GIVEN** the `personal-assistant` extension is loaded
- **WHEN** `registerMemory(pi)` is called
- **THEN** `pi.registerTool` is invoked exactly once for the `memory_get` tool
- **AND THEN** the tool's `parameters` schema is a `Type.Object` requiring `id: string`

#### Requirement: user_tone hint in extraction prompt
The extraction LLM prompt MUST carry a `<user_tone>` segment when the user's message text exhibits strong / habit / weak / rare tone signals, so the LLM can calibrate `importance` accordingly.

##### Scenario: STRONG tone signals
- **GIVEN** messages contain tokens "千万" or "务必" or "必须" or "must" or "always"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>strong</user_tone>`
- **AND THEN** it contains `<importance_hint>0.85</importance_hint>`

##### Scenario: HABIT tone signals
- **GIVEN** messages contain tokens "总是" or "永远" or "习惯" or "usually"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>habit</user_tone>`
- **AND THEN** it contains `<importance_hint>0.65</importance_hint>`

##### Scenario: WEAK tone signals
- **GIVEN** messages contain tokens "可能" or "也许" or "如果" or "maybe" or "could"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>weak</user_tone>`
- **AND THEN** it contains `<importance_hint>0.35</importance_hint>`

##### Scenario: RARE tone signals
- **GIVEN** messages contain tokens "偶尔" or "有时" or "sometimes" or "rarely"
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt contains `<user_tone>rare</user_tone>`
- **AND THEN** it contains `<importance_hint>0.2</importance_hint>`

##### Scenario: NEUTRAL tone omits hint
- **GIVEN** messages contain none of the strong / habit / weak / rare tokens
- **WHEN** `buildExtractionPrompt(messages)` is called
- **THEN** the returned prompt does NOT contain `<user_tone>` or `<importance_hint>` segments

##### Scenario: EXTRACT_PROMPT_V2 documents the hint
- **GIVEN** `EXTRACT_PROMPT_V2` is the system-prompt text sent to the extraction LLM
- **THEN** it contains a paragraph instructing the LLM to use `<user_tone>` + `<importance_hint>` as a hint to calibrate importance, with explicit permission to deviate ±0.15 from the hint

#### Requirement: weighted score formula for search ranking
Search MUST rank recall results within each type by `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`. Cosine is the multiplicative anchor; strength/importance contribute a continuous boost on every comparison (never only on strict equality).

##### Scenario: zero cosine gives zero score
- **GIVEN** an atom with `cosine = 0` (completely unrelated)
- **WHEN** its score is computed
- **THEN** `score = 0 × (1 + 0.3 × strength + 0.2 × importance) = 0`
- **AND THEN** the atom cannot rank above any non-zero-cosine competitor regardless of strength/importance

##### Scenario: full cosine gives max boost
- **GIVEN** an atom with `cosine = 1`, `strength = 1`, `importance = 1`
- **WHEN** its score is computed
- **THEN** `score = 1.0 × 1.5 = 1.5`

##### Scenario: cosine dominates boost
- **GIVEN** atom X with `cosine = 0.6, strength = 1.0, importance = 1.0` (score = 0.9)
- **AND GIVEN** atom Y with `cosine = 0.85, strength = 0.0, importance = 0.0` (score = 0.85)
- **WHEN** compared
- **THEN** X ranks above Y because the 0.5 max boost from strength/importance cannot overcome the 0.25 cosine gap when cosine ≥ 0.667× the loser's cosine

##### Scenario: within-type sort uses score DESC
- **GIVEN** rule type has 3 atoms with cosine/strength/importance triples giving scores 1.05 / 0.8925 / 0.876
- **WHEN** `recallAtoms` ranks the rule slice
- **THEN** the returned order is [1.05, 0.8925, 0.876]

#### Requirement: per-type top-3 recall
`recallAtoms` MUST run three independent KNN searches (one per atom type) and return at most 3 results per type, interleaved round-robin.

##### Scenario: all 3 types have ≥3 atoms
- **GIVEN** DB contains 4 rule + 4 fact + 4 process atoms, all matching the query above cosine threshold
- **WHEN** `recallAtoms(index, query)` is called
- **THEN** 9 results are returned
- **AND THEN** result indices [0, 3, 6] are rule, [1, 4, 7] are fact, [2, 5, 8] are process (round-robin interleaving)

##### Scenario: sparse type slot is skipped
- **GIVEN** DB contains 1 rule + 0 fact + 2 process atoms matching the query
- **WHEN** `recallAtoms(index, query)` is called
- **THEN** 3 results are returned: `[rule@0, process@0, process@1]` — the fact slot is skipped, not padded with other types

##### Scenario: sub-threshold atoms are dropped
- **GIVEN** some rule-type candidates have `cosine < 0.5`
- **WHEN** `recallAtoms` returns
- **THEN** those candidates do not appear in results
- **AND THEN** the rule slice has at most `min(3, post-filter count)` entries

#### Requirement: search does not mutate access state
`recallAtoms` MUST NOT call `updateAccess` for any returned atom. Strength-feedback is recorded exclusively by the agent's `memory_get` tool and the webui `GET /api/memory/:id` preview endpoint.

##### Scenario: search leaves access_count at 0
- **GIVEN** an atom exists with `access_count = 0`
- **WHEN** `recallAtoms(index, query)` returns that atom
- **THEN** the atom's `access_count` remains 0 after the call
- **AND THEN** the atom's `last_access` remains null

##### Scenario: only memory_get bumps access_count
- **GIVEN** an atom exists with `access_count = 0`
- **WHEN** `recallAtoms` returns it (no bump)
- **AND THEN** the `memory_get` tool is invoked with the atom's id
- **THEN** `access_count` becomes 1 and `last_access` is set

#### Requirement: formatMemoryBlock emits id, not file_path
`formatMemoryBlock` MUST emit an `id:` line carrying the atom's UUID and MUST NOT emit a `file:` line. The LLM uses the id to call `memory_get` when full content is needed.

##### Scenario: id line present, file line absent
- **GIVEN** an atom with id=`abc-123`, type=`rule`, title=`T`, summary=`S`, tags=[`x`]
- **WHEN** `formatMemoryBlock(result)` is called
- **THEN** the block contains `id: abc-123`
- **AND THEN** the block does NOT contain `file:`

##### Scenario: formatMemoryContext re-sorts by cosine
- **GIVEN** two results: A with `score = 1.5, cosine = 0.7`, B with `score = 0.7, cosine = 0.95`
- **WHEN** `formatMemoryContext([A, B], 4000)` is called
- **THEN** B appears before A in the output text — sorting is by distance ASC (cosine DESC), NOT by score DESC
- **NOTE**: score is metadata for the search response / debug UI only. The LLM never sees it; it sees cosine-ordered blocks regardless.

#### Requirement: RecallResult shape
The `RecallResult` type MUST include a `score: number` field and MUST NOT include a `file_path` field.

##### Scenario: type contract
- **GIVEN** a `RecallResult` is constructed from a search hit
- **THEN** `result.score` is a non-negative number
- **AND THEN** `result.file_path` is not present in the shape

#### Requirement: webui search response shape
The webui `POST /api/memory/search` response MUST include `score` in each result and MUST NOT include `file_path` or `tokenBudgetUsed`.

##### Scenario: response shape
- **GIVEN** search returns 3 hits
- **WHEN** the response body is serialized
- **THEN** each result has `{ id, type, title, summary, tags, distance, cosine, score }`
- **AND THEN** `file_path` and `tokenBudgetUsed` are not present

#### Removed

搜索 / 格式层解耦带来的 4 项 removed 行为,在 `memory-v2` 之后不再适用,记录在此供历史追溯。

<!-- Removed: search-bumps-access-count — Search is discovery-only. Strength feedback must be intentional (the agent's `memory_get` call) to avoid spurious bumps from routine recall. Migration: Atom strength still reflects prior access history until the atom is updated by `memory_get`. New feedback loop requires the agent to call `memory_get` after search. -->

<!-- Removed: search-returns-file-path — file_path leaks storage layout to the LLM and creates a dependency on the `read` tool. Replacing with `id` keeps the LLM aware of the abstraction and routes full-content access through `memory_get`, where strength feedback lives. Migration: Clients that previously read `file_path` from the search response must instead call `memory_get(id)` to retrieve full content. -->

<!-- Removed: file-in-format-block — `formatMemoryBlock` previously emitted `file: <path>` which mirrored the old `read` tool flow. Migration: `formatMemoryBlock` now emits `id: <uuid>`. The LLM uses `memory_get` to resolve the id. -->

<!-- Removed: formatMemoryContext topNL1 L1 tier split — The format layer no longer hydrates content at recall time (search is path-IO-free and full content lives behind `memory_get`). The `topNL1` parameter, L1 tier (with `<content>` field), and `<memory-context>` wrapping are removed; formatMemoryContext now emits only summary + id blocks under a fixed token budget. -->

