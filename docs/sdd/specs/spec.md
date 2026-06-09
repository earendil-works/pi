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

The pi agent can execute commands on a remote HPC server via the `satellite_remote_exec` MCP tool. The tool is a discriminated union of 8 sub-operations: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `transfer_file`, `find_files`, `grep_files`. Schemas are aligned with the native pi tools; bash is guarded against accidental file-tool substitution; file transfer uses HTTP body transport to keep bytes out of LLM context.

### Requirements

#### Requirement: Bash Guardrail Intent Detection

The satellite server SHALL detect bash command intent that indicates use of a dedicated file operation tool, and SHALL return an `isError: true` response with guidance to use the dedicated tool instead.

##### Scenario: bash cat guided to read_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="cat /path/to/file")`
- **WHEN** `detectIntent` returns `"read_file"`
- **THEN** The server returns `isError: true` with content: "Prefer read_file over bash cat. Use tool=read_file, path='/path/to/file'"

##### Scenario: bash sed -i guided to edit_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/x/y/' /path/to/file")`
- **WHEN** `detectIntent` returns `"edit_file"`
- **THEN** The server returns `isError: true` with content: "Prefer edit_file over bash sed -i. Use tool=edit_file, ..."

##### Scenario: bash echo/printf > guided to write_file
- **GIVEN** Agent calls `remote_exec(tool="bash", command="echo 'x' > /path/to/file")`
- **WHEN** `detectIntent` returns `"write_file"`
- **THEN** The server returns `isError: true` with content: "Prefer write_file over bash echo redirect. Use tool=write_file, ..."

##### Scenario: bash find guided to find_files
- **GIVEN** Agent calls `remote_exec(tool="bash", command="find /path -name '*.ts'")`
- **WHEN** `detectIntent` returns `"find_files"`
- **THEN** The server returns `isError: true` with content: "Prefer find_files over bash find. Use tool=find_files, pattern='*.ts', path='/path'"

##### Scenario: bash grep guided to grep_files
- **GIVEN** Agent calls `remote_exec(tool="bash", command="grep -r pattern /path")`
- **WHEN** `detectIntent` returns `"grep_files"`
- **THEN** The server returns `isError: true` with content: "Prefer grep_files over bash grep. Use tool=grep_files, pattern='pattern', path='/path'"

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
- **GIVEN** Agent has been intercepted twice in the same turn for `cat` → `read_file` guidance
- **WHEN** Agent calls `remote_exec(tool="bash", command="cat /path")` a third time
- **THEN** The server returns `isError: true` with content: "Blocked: you have tried bash cat 3 times. Use tool=read_file instead."

##### Scenario: different intent category resets counter
- **GIVEN** Agent has been intercepted once for `cat` → `read_file`
- **WHEN** Agent calls `remote_exec(tool="bash", command="sed -i 's/a/b/' /path")`
- **THEN** The server returns guidance error for `sed` and the `cat` counter is not affected

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

The satellite server's sub-operation schemas SHALL match native pi tool schemas in parameter name, type, optionality, and description.

##### Scenario: list_dir path is optional with default "."
- **GIVEN** Agent calls `remote_exec(tool="list_dir")` without `path`
- **WHEN** The schema validator parses the input
- **THEN** Validation succeeds and the handler uses `"."` as the default path

#### Requirement: File Transfer Sub-Operation

The satellite server SHALL provide a `transfer_file` sub-operation that moves file content between local and remote locations using HTTP body transport (no LLM context tokens for file content).

##### Scenario: transfer_file upload direction
- **GIVEN** Agent needs to read a remote file and write it locally
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="upload", local_path="/local/path", remote_path="/remote/path")`
- **THEN** The server reads `/remote/path` and returns its content in the response (agent writes to `/local/path`)

##### Scenario: transfer_file download direction
- **GIVEN** Agent needs to write a local file to remote
- **WHEN** Agent calls `remote_exec(tool="transfer_file", direction="download", local_path="/local/path", remote_path="/remote/path", content=<bytes>)`
- **THEN** The server writes the content to `/remote/path` and returns a success message

##### Scenario: transfer_file invalid direction rejected
- **GIVEN** Agent calls `remote_exec(tool="transfer_file", direction="push", ...)`
- **WHEN** The schema validator parses the input
- **THEN** Validation fails with `isError: true` and message: "direction must be 'upload' or 'download'"

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

#### Requirement: Remote File Search Sub-Operations

The satellite server SHALL provide `find_files` and `grep_files` sub-operations that delegate to `fd` and `rg` respectively, with explicit error messages when these tools are not installed.

##### Scenario: find_files with fd installed
- **GIVEN** `fd` is installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="find_files", pattern="*.ts", path="/remote/src/")`
- **THEN** The server executes `fd --glob --hidden --no-require-git --max-depth 10 '*.ts' /remote/src/` and returns the file list (truncated to `limit`, default 500)

##### Scenario: find_files with fd missing
- **GIVEN** `fd` is NOT installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="find_files", pattern="*.ts", path="/remote/src/")`
- **THEN** The server returns `isError: true` with content: "fd not found on remote server. Install with: apt install fd-find"

##### Scenario: grep_files with rg installed
- **GIVEN** `rg` is installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="grep_files", pattern="function", path="/remote/src/")`
- **THEN** The server executes `rg` and returns matching lines (truncated to `limit`, default 500)

##### Scenario: grep_files with rg missing
- **GIVEN** `rg` is NOT installed on the remote server
- **WHEN** Agent calls `remote_exec(tool="grep_files", pattern="function", path="/remote/src/")`
- **THEN** The server returns `isError: true` with content: "ripgrep not found. Install with: apt install ripgrep"

#### Requirement: Layer A System Prompt Soft Guardrail

The pi agent SHALL inject a system prompt section declaring remote path ownership when the satellite MCP server is configured with a `remotePathPattern` field.

##### Scenario: system prompt includes remote path declaration
- **GIVEN** `~/.pi/agent/mcp.json` contains satellite config with `remotePathPattern: "/TJPROJ\\d+"`
- **WHEN** The agent starts a session
- **THEN** The system prompt contains a "Remote Paths" section declaring that paths matching `/TJPROJ\d+/` are on the remote HPC and must be accessed via `satellite_remote_exec`

### MODIFIED Requirements

(none)

### REMOVED Requirements

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
