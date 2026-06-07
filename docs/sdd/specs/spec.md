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
