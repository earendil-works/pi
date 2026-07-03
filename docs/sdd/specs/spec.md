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

#### Requirement: Step Wrapper Trigger

The webui `MessageParts` component SHALL wrap the assistant turn's **inference** content (thinking + toolCall + toolResult + image) in a collapsible step container when the `parts: Part[]` array contains any of: `thinking`, `toolCall`, `toolResult`, or `image`. **All `text` parts SHALL render OUTSIDE the step container as sibling elements, always visible regardless of step fold state.** When the parts contain only `text` blocks, the assistant turn SHALL render without a step wrapper (preserving the existing inline rendering). When `parts` is empty, the existing `(empty turn)` placeholder SHALL render.

##### Scenario: 纯 text turn 不裹 step
- **GIVEN** an assistant message with `parts: [{ type: "text", text: "hello" }]`
- **WHEN** the MessageParts component renders
- **THEN** no step header is in the DOM, and the text is rendered as a TextItem (markdown) directly

##### Scenario: 含 thinking + tool + final response 时: fold 包 inference,text 在 fold 外
- **GIVEN** an assistant message with `parts: [thinking, toolCall, toolResult, text]`
- **WHEN** the MessageParts component renders
- **THEN** a step header button appears in the DOM; the fold body contains the inference parts (ThinkingItem, ToolGroup) in original order; the final text TextItem renders OUTSIDE the step container as a sibling element, after the fold

##### Scenario: 纯 thinking turn 也包 step
- **GIVEN** an assistant message with `parts: [{ type: "thinking", text: "..." }]` only
- **WHEN** the MessageParts component renders
- **THEN** a step header is rendered; the step body contains a single ThinkingItem (which itself is collapsible). No text parts exist, so no sibling text elements appear

##### Scenario: 纯 tool turn 也包 step
- **GIVEN** an assistant message with `parts: [toolCall, toolResult]` only (no thinking, no final text)
- **WHEN** the MessageParts component renders
- **THEN** a step header is rendered; the step body contains a single ToolGroup with the tool call and result. No text parts exist, so no sibling text elements appear

##### Scenario: 空 parts 显示占位符
- **GIVEN** an assistant message with `parts: []`
- **WHEN** the MessageParts component renders
- **THEN** the literal text `(empty turn)` is rendered, no step header

##### Scenario: 多个 text block 中间夹 tool: inference 在 fold,text 在 fold 外
- **GIVEN** an assistant message with `parts: [thinking, text("interim"), toolCall, toolResult, text("final")]`
- **WHEN** the MessageParts component renders
- **THEN** a single fold wraps only the inference parts (thinking + ToolGroup); both `text("interim")` and `text("final")` render OUTSIDE the fold as sibling TextItem elements after the fold. The interim text is NOT inside the step body — both text parts are grouped together below the fold in original chronological order

#### Requirement: Text Parts Outside Fold Wrapper

All `text` parts in an assistant message SHALL render OUTSIDE the step wrapper as sibling elements, regardless of fold state. The text SHALL be visible both when the fold is expanded (during streaming) and when the fold is collapsed (after streaming ends). This is the primary user-visible guarantee: the agent's reply text is never hidden inside a collapsed step.

##### Scenario: 推理过程展开时,text 在 fold 外可见
- **GIVEN** a turn with `parts=[thinking, toolCall, toolResult, text("final")]`, `isStreaming=true`
- **WHEN** MessageParts renders
- **THEN** the fold is open; the text "final" is visible in a TextItem that lives OUTSIDE the fold element (sibling, not descendant)

##### Scenario: 推理过程自动折叠后,text 仍可见 (核心 spec)
- **GIVEN** a turn with `parts=[thinking, toolCall, toolResult, text("final")]`, fold expanded, text visible
- **WHEN** `isStreaming` becomes `false`, fold auto-collapses
- **THEN** the fold body becomes hidden (ThinkingItem and ToolGroup removed from DOM); the text "final" remains visible in its sibling position below the fold. The user does not need to click the step header to see the agent's reply

##### Scenario: 纯 text turn 无 fold, text 直接渲染
- **GIVEN** a turn with `parts=[text("hello")]` only
- **WHEN** MessageParts renders
- **THEN** no step header is in the DOM and the text is rendered directly without any step wrapper. This is the same as the pre-existing pure-text rendering path

#### Requirement: Step Header Status + Duration

The step header SHALL display a status icon (`●` for executing, `✓` for completed), a status word (`Executing` or `Completed`), a duration in seconds, and a chevron. The duration SHALL be computed as `Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)` while the step is streaming, then frozen at the completion timestamp once `isStreaming` becomes `false` (so old completed turns display their actual turn duration, not a continuously growing "since-timestamp" approximation). When the message `timestamp` is missing, the duration SHALL fall back to `Date.now()` (treating elapsed time as 0).

##### Scenario: Streaming 时 header 显示 executing + 倒计时
- **GIVEN** a step with `isStreaming=true` and `timestamp=2026-06-24T15:00:00.000Z`, current time 2026-06-24T15:00:12.000Z
- **WHEN** the step header renders
- **THEN** the header shows `● Executing (12s) ▼` (blue icon, down chevron)

##### Scenario: Done 后 header 变 completed + 冻结的 duration
- **GIVEN** a step with `timestamp=2026-06-24T15:00:00.000Z`, started streaming at 15:00:00, completed at 15:00:30
- **WHEN** the step header renders after completion
- **THEN** the header shows `✓ Completed (30s) ▲` (green icon, up chevron). The 30s reflects the actual turn duration and does NOT continue to grow as wall-clock time advances

##### Scenario: 旧 turn (1h 前) 显示完成时 elapsed 时间
- **GIVEN** a step that started streaming at `2026-06-24T14:00:00.000Z`, completed 30s later
- **WHEN** the step header renders at `2026-06-24T15:00:00.000Z`
- **THEN** the header shows `✓ Completed (30s) ▲` — the duration is frozen at completion time, not the 3600s "since-timestamp" approximation. Older revisions of this spec computed the latter; the current implementation tracks `completedAt` via `useRef` so the duration stays stable after the step closes

##### Scenario: Aborted turn 也显示 step header
- **GIVEN** a step whose underlying message was aborted mid-flight
- **WHEN** the step header renders
- **THEN** a step header is visible (status reflects current `isStreaming` value at render time). The exact aborted icon (`⚠`) is out of scope for this change

#### Requirement: Step Body Collapsible

The step body (the fold contents — inference parts) SHALL be visible (expanded) by default when `isStreaming=true` and hidden (collapsed) by default when `isStreaming=false`. The user SHALL be able to click the step header to toggle the body visibility. Once the user has clicked, the user's choice SHALL persist for the lifetime of that step instance; subsequent changes to `isStreaming` SHALL NOT override the user's choice. **Text parts are not part of the step body and are unaffected by fold state — they remain visible whether the fold is open or closed.**

##### Scenario: Streaming 时 body 默认展开
- **GIVEN** a step with `isStreaming=true`
- **WHEN** the step renders
- **THEN** the step body is visible (inference parts rendered). Text parts are also visible (they live outside the fold)

##### Scenario: Done 后 body 自动折叠,text 仍可见
- **GIVEN** a step where `isStreaming` was `true` and the body was visible
- **WHEN** `isStreaming` becomes `false`
- **THEN** the body auto-collapses (inference parts removed from the DOM); the header remains visible. **Text parts (rendered outside the fold) remain visible regardless of fold state**

##### Scenario: 用户点击 header 切换
- **GIVEN** a step with `isStreaming=false`, body collapsed
- **WHEN** the user clicks the step header button
- **THEN** the body becomes visible; clicking again hides it. Text parts are unaffected by the click and remain visible

##### Scenario: 用户点击后 isStreaming 变化不覆盖
- **GIVEN** a step where the user clicked to expand the body (user override = expand), and `isStreaming` then changes from `false` to `true`
- **WHEN** the step re-renders
- **THEN** the body remains visible (user override wins). When `isStreaming` changes back to `false`, the body remains visible (override still wins)

##### Scenario: 极长 turn 内部 ToolGroup 仍按 >4 tool 折叠
- **GIVEN** a step containing 100 tool calls
- **WHEN** the step body renders (either initially expanded or user-expanded)
- **THEN** the inner ToolGroup still applies its existing `>4` collapse-to-summary rule; the step wrapper does not interfere

##### Scenario: 推理中或完成后有 active card 时 step 强制展开
- **GIVEN** a step with `parts=[{type:"toolCall", id:"tc1", name:"ask_user_question", ...}]` and `cardStates.get("tc1")` exists (active card state for this tool call)
- **WHEN** the step renders (regardless of `isStreaming` value)
- **THEN** the step body is visible (force-opened) so the active card is always shown to the user. User's `userOverride` (if set) is ignored while a card is active. Once the card is removed from `cardStates` (user responds / `tool_execution_end` arrives), normal `userOverride ?? isStreaming` logic resumes

#### Requirement: Streaming State Propagation

The webui `ChatPage` component SHALL compute `isLastMessageStreaming = isThinking && lastMessage?.role === "assistant"` and pass it as the `isStreaming` prop to the last message's `MessageBubble` (and recursively to `MessageParts`). When `isThinking` is `false`, all messages SHALL be rendered with `isStreaming=false`. Older messages in the same list SHALL always be rendered with `isStreaming=false` even if `isThinking` is `true`.

##### Scenario: 推理中最后一条 message 显示 streaming
- **GIVEN** `isThinking=true`, `messages=[..., {role:"assistant", parts:[...], timestamp:"..."}]` (last message is assistant)
- **WHEN** ChatPage renders
- **THEN** the last message's MessageBubble receives `isStreaming=true`; the step header shows `● Executing`

##### Scenario: 旧 message 在 active turn 中不显示 streaming
- **GIVEN** `isThinking=true`, `messages=[user, assistant, user, assistant(newer)]`
- **WHEN** ChatPage renders
- **THEN** only the LAST assistant message's MessageBubble receives `isStreaming=true`; the older assistant message receives `isStreaming=false`

##### Scenario: turn 还没持久化时 step header 还没出现
- **GIVEN** `isThinking=true`, the agent has not yet emitted the final `done` event
- **WHEN** ChatPage renders
- **THEN** the new assistant message is NOT in the `messages` array; no step header is rendered for it; the `ThinkingIndicator` component is rendered at the bottom of the chat

##### Scenario: 推理完成到下次 poll 之间
- **GIVEN** the agent just emitted `done`, `isThinking` flipped to `false`, but the next poll has not yet fetched the new message
- **WHEN** ChatPage renders with the stale messages list
- **THEN** the previous (older) messages still render with their existing state; the new message is not yet in the list. Within a few hundred ms the poll completes and the new message appears with `isStreaming=false` (done)

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

#### Requirement: supersedeIfSimilar Default Threshold
The `supersedeIfSimilar` function in `extensions/personal-assistant/dedup.ts` SHALL use 0.65 as the default cosine similarity threshold for dedup decisions when the caller does not specify `threshold`. The function SHALL continue to accept an optional `threshold` parameter for callers that want a different value (e.g. CLI migration script with `--threshold=0.60`).

##### Scenario: Caller does not specify threshold — 0.65 used
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding)` without threshold arg
- **WHEN** the function calls `index.findMostSimilarEmbedding(embedding, threshold)`
- **THEN** it uses `0.65` as the threshold

##### Scenario: Caller specifies threshold — that value used
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding, 0.80)`
- **WHEN** the function calls `index.findMostSimilarEmbedding(embedding, threshold)`
- **THEN** it uses `0.80` (caller's value, not the default)

##### Scenario: Cosine 0.64 pair not merged
- **GIVEN** corpus has 2 atoms with cosine 0.64
- **WHEN** `supersedeIfSimilar` runs with default threshold
- **THEN** pair is NOT merged (0.64 < 0.65)

##### Scenario: Cosine 0.66 pair merged
- **GIVEN** corpus has 2 atoms with cosine 0.66
- **WHEN** `supersedeIfSimilar` runs with default threshold
- **THEN** pair is merged (0.66 ≥ 0.65)

##### Scenario: Self-match guard — cosine 1.0 returns create
- **GIVEN** caller is PATCHing an existing atom, the most similar match is the atom itself (cosine 1.0)
- **WHEN** `supersedeIfSimilar` runs
- **THEN** returns `{ status: "create", atom: newAtom }` (self-match guard, no superseded attempted that would fail PRIMARY KEY)

#### Requirement: markSupersededTx Behavior (unchanged, but new no-insert variant)
The `markSupersededTx` method in `extensions/personal-assistant/storage.ts` SHALL continue to perform INSERT new row + UPDATE old row in one transaction. A NEW companion method `markSupersededNoInsert(oldId, parentId, now)` SHALL perform ONLY the UPDATE (mark old as archived, set parent_id, set superseded_at) without inserting a new row, for use by the migration script where the "winner" atom already exists with a different id.

##### Scenario: markSupersededTx inserts new row + marks old archived
- **GIVEN** extract emits new item, `supersedeIfSimilar` finds hit
- **WHEN** `markSupersededTx(hit.id, newAtom, embedding)` runs
- **THEN** INSERT new row with new id + UPDATE old row `is_latest=0, superseded_at=now` in single transaction

##### Scenario: markSupersededNoInsert only updates old row
- **GIVEN** migration script identifies cluster pair (winner A, hit B)
- **WHEN** `markSupersededNoInsert(B.id, A.id, now)` runs
- **THEN** UPDATE `memory_index` SET `is_latest=0, parent_id=A.id, superseded_at=now` WHERE id=B.id
- **AND** no INSERT of new row
- **AND** B's vector in `memory_vectors` unchanged (content unchanged, vector still correct)

##### Scenario: Migration script uses markSupersededNoInsert
- **GIVEN** migration script processes corpus and finds 0.65 cosine pair (winner A, hit B)
- **WHEN** script calls `markSupersededNoInsert(B.id, A.id, now)` for each pair
- **THEN** B rows marked archived + parent_id=A
- **AND** `getActiveAtoms()` no longer returns B
- **AND** recall uses A only (B excluded from active corpus)

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
recallAtoms SHALL 用 sqlite-vec KNN 单向量检索,不做 FTS 匹配,不做 BM25 + Vector hybrid scoring,不做 RRF 融合。cosine floor 0.7 是唯一召回门控。bge-m3 多语言模型直接 embed 原文(含混合 ASCII+CJK),不拆段。

##### Scenario: recallAtoms 不调 searchByFts / bm25Search / rrfFuse
- **GIVEN** memory.ts / search.ts 源码
- **WHEN** `grep -n "searchByFts\|bm25Search\|rrfFuse\|FTS5\|bm25" extensions/personal-assistant/search.ts`
- **THEN** 输出为空

##### Scenario: recallAtoms 走 sqlite-vec KNN
- **GIVEN** DB 有 50 atom,memory_vectors 表有对应 embedding
- **WHEN** recallAtoms(index, query) 执行
- **THEN** sqlite-vec 收到 KNN 查询
- **AND** 不走任何 FTS MATCH 查询
- **AND** 不走任何 RRF 融合

##### Scenario: cosine floor 0.7 过滤
- **GIVEN** DB 有 atom A(cosine=0.75)和 atom B(cosine=0.55)
- **WHEN** recallAtoms(index, query) 执行
- **THEN** A 通过 cosine floor(c >= 0.7)
- **AND** B 被 cosine floor 过滤掉(c < 0.7)

##### Scenario: 混合 ASCII+CJK query 直接 embed
- **GIVEN** query = "mgm工时计算"(ASCII + CJK 混合)
- **WHEN** recallAtoms(index, "mgm工时计算") 执行
- **THEN** 不执行 splitQuery(已删),直接 embedText("mgm工时计算")
- **AND** bge-m3 输出单条 embedding 用于 KNN

#### Requirement: per-type top-3 dense + round-robin recall
`recallAtoms` MUST run, for each of the three atom types (rule / fact / process) independently, a dense KNN search (sqlite-vec, top-K candidates), filter by cosine floor 0.7, compute score via `score = cosine × (1 + 0.3 × strength + 0.2 × importance) + 0.10 × tagOverlap + 0.05 × freshness`, take the top 3 by score per type (sparse types degrade), then interleave the per-type lists via round-robin into a single result list.

##### Scenario: per-type top-3 dense ranking
- **GIVEN** rule type has 3 atoms with cosine/strength/importance triples giving scores 1.05 / 0.8925 / 0.876
- **WHEN** `recallAtoms` ranks the rule slice
- **THEN** all 3 are returned in score DESC order

##### Scenario: sub-floor atoms are dropped
- **GIVEN** some rule-type candidates have cosine < 0.7
- **WHEN** `recallAtoms` returns
- **THEN** those candidates are NOT in the result list

##### Scenario: empty query returns empty
- **GIVEN** query is an empty string `""`
- **WHEN** `recallAtoms(index, "")` is called
- **THEN** returns `[]`

##### Scenario: ollama unavailable returns empty
- **GIVEN** ollama is not running, embedText returns null
- **WHEN** `recallAtoms(index, query)` is called
- **THEN** returns `[]` immediately (no FTS fallback, no keyword extraction)

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

#### Requirement: buildEmbeddableText drops content field (v2 embeddable text)
`buildEmbeddableText` SHALL construct the embeddable text from `title + summary + tags` only, excluding `content`. The exclusion is justified because recall is discovery-only (results carry `atom.id`; full content is fetched by `memory_get` on demand), and embedding the long verbose `content` field dilutes the curated title/summary/tags signal with incidental token mentions. The schema tracks the embeddable-text version via `embed_text_version` column on `memory_index` (`CURRENT_EMBEDDABLE_TEXT_VERSION = 2`); `init()` performs an idempotent `ALTER TABLE` to add the column on upgrade; `session_start` migrates any atom whose stored version is below current by re-embedding incrementally.

##### Scenario: corpus re-embed on session_start after version bump
- **GIVEN** the DB has 19 active atoms with `embed_text_version = 0` (pre-v2)
- **WHEN** the next `session_start` event runs
- **THEN** `init()` adds the `embed_text_version` column if missing
- **AND THEN** `session_start` calls `listStaleEmbedVersionIds(CURRENT_EMBEDDABLE_TEXT_VERSION = 2)`
- **AND THEN** for each stale atom, `buildEmbeddableText({title, summary, tags})` is called, then `embedText` is called, then `upsertVector` is called, then `setEmbedTextVersion(id, 2)` is called
- **AND THEN** subsequent `session_start` events no-op on this step (all atoms at v2)

##### Scenario: content is NOT included in v2 embeddable text
- **GIVEN** an atom with `title="X"`, `summary="Y"`, `content="Z"`, `tags=["t1", "t2"]`
- **WHEN** `buildEmbeddableText(atom)` is called
- **THEN** the returned string is `X\nY\nt1, t2` (or the equivalent concatenated form)
- **AND THEN** the string does NOT contain `Z`

##### Scenario: upsertVector uses DELETE + INSERT for sqlite-vec vec0 idempotency
- **GIVEN** a vector row with `id = X` already exists in `memory_vectors` (sqlite-vec `vec0` virtual table)
- **WHEN** `index.upsertVector(X, newEmbedding)` is called
- **THEN** an explicit `DELETE FROM memory_vectors WHERE id = X` runs first
- **AND THEN** an `INSERT INTO memory_vectors(id, embedding) VALUES (X, newEmbedding)` runs
- **NOTE**: `INSERT OR REPLACE` does NOT work against `vec0` — the unique constraint fires instead of deleting the prior row

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

<!-- Removed: hardcoded DEFAULT_THRESHOLD = 0.5/0.7 cosine gate — Pure cosine threshold is replaced by RRF fused score threshold (`recallThreshold`, default `1/(rrfK+1)` ≈ 0.01639 with rrfK=60). The dense cosine floor (`DEFAULT_DENSE_COSINE_FLOOR = 0.7`) remains as a separate per-channel pre-filter for the dense channel (catches dense-noise atoms like the lefse case at cosine 0.55), but is no longer the recall gate itself. Migration: Existing call sites that pass `{ threshold: 0.5 }` continue to work (dense floor), but to control the recall gate they should pass `recallThreshold` instead. No code change required at call sites that use defaults — recall just behaves better out of the box. -->

<!-- Removed: rrfK / recallThreshold recall config knob — RRF 融合已删除,`PersonalAssistantConfig.memory.recall.rrfK` 和 `recallThreshold` 字段不再适用,从 settings / webui routes / memory.ts 全栈删除。`recallThreshold` 默认值 `1/(rrfK+1)` ≈ 0.01639 with rrfK=60 不再被读取。Migration: 无 — 这两个 knob 从未被用户配置(默认值始终生效),删除无影响。cosine floor 0.7 替代 RRF recallThreshold 作为唯一召回门控。 -->

<!-- Removed: content field in buildEmbeddableText — v1 of `buildEmbeddableText` included `title + summary + content + tags`. v2 drops `content` because recall is discovery-only (results carry `atom.id`; full content is fetched by `memory_get` on demand), and embedding the long verbose `content` field diluted the curated title/summary/tags signal with incidental token mentions. Migration: `CURRENT_EMBEDDABLE_TEXT_VERSION = 2` triggers incremental re-embed on next `session_start` via `listStaleEmbedVersionIds` / `setEmbedTextVersion`. New atoms are embedded at v2 by default. -->

<!-- Removed: FTS5 special-char enumeration in escapeFtsQuery — The previous version enumerated the FTS5-special char set (`"`, `(`, `)`, `*`, `:`, `[`, `]`, `,`, `/`, `-`, `.`); FTS5 also raises syntax errors on `;`, `!`, `?`, `&`, `|`, `~`, `@`, `#`, `$`, `%`, `=`, `<`, `>`, `'`, `\`, `{`, `}` (each with a different error message). The whitelist rewrite `s.replace(/[^a-zA-Z0-9_\s]/g, " ")` keeps only the corpus's unicode61 token alphabet — closed enumeration, no whack-a-mole on new user queries. Migration: `escapeFtsQuery("foo!bar?")` previously returned `"foo!bar?"`; now returns `"foo bar"`. No corpus-side change needed (unicode61 already tokenizes the same way at insert time). -->

<!-- Removed: full-query semantic+BM25 fallback (long-prompt crash mode) — The v1 of `recallAtoms` always split the query into segments regardless of length. Long mixed queries (file path + project ID + description + commands, 15+ segments after split) over-recalled via OR-merge because recall probability scales as `1-(1-p)ᴺ`. The query-splitting cap (`MAX_SPLIT_SEGMENTS = 3`) plus whitelist `escapeFtsQuery` together form the new contract: short focused search terms (≤3 segments, both ASCII+CJK) split and benefit from per-segment dense+BM25; long messages (4+ segments) fall back to single-segment semantic+BM25 on the full string. The single-segment path was previously unreachable for long mixed queries due to the FTS5 syntax error; the whitelist fix in `escapeFtsQuery` is what unblocks it. -->

## Capability: memory-pipeline

### Requirements

#### Requirement: 写入冲突通过 If-Match 头终止
`PATCH /api/memory/:id` SHALL 要求请求带 `If-Match` 头,值为当前服务端 atom `version`(或 `"*"` 表示 any-version)。
服务端 SHALL 在 `existing.version !== ifMatch` 时返回 `409 {error:"version_conflict", current:atom}`,客户端 SHALL 用 409 响应触发重载或合并提示。

##### Scenario: 客户端带匹配的 If-Match,写入成功
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH /api/memory/:id` 带 `If-Match: "5"`
- **THEN** 服务端返回 200 + 新 atom(version=6)

##### Scenario: 客户端带过期 If-Match,返回 409
- **GIVEN** 服务端 atom `version=5`,客户端缓存 version=4
- **WHEN** 客户端发送 `PATCH` 带 `If-Match: "4"`
- **THEN** 服务端返回 409,响应 body 含 `current` 字段(服务端最新 atom)

##### Scenario: 客户端缺 If-Match,返回 400
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH` 不带 `If-Match` 头
- **THEN** 服务端返回 400 `{error:"missing_if_match"}`

##### Scenario: If-Match 为 * 表示 any-version
- **GIVEN** 服务端 atom `version=5`
- **WHEN** 客户端发送 `PATCH` 带 `If-Match: "*"`
- **THEN** 服务端跳过 version 校验,正常处理(预留逃生口)

#### Requirement: webui 写入路径自动 cosine 去重
`PATCH /api/memory/:id` SHALL 在写入前计算新内容的 embedding,与现有 active atom 求最大 cosine similarity;当 similarity ≥ 0.92 时 SHALL 走 `markSupersededTx`,新 atom 继承旧 atom 的 strength/access_count;否则正常 updateAtom。
当 `embedText` 返回 null(ollama down)时 SHALL 跳过 cosine 检查,走原 updateAtom 流程(graceful degradation,见 search.ts Decision 7)。

##### Scenario: 新内容与现有 atom cosine > 0.92,触发 supersede
- **GIVEN** 数据库存在 active atom A(content="X"),现有 PATCH 内容 Y 与 A cosine=0.95
- **WHEN** 客户端发送 PATCH 写 Y
- **THEN** 服务端调 `markSupersededTx(A.id, newAtom, embedding)`,A `is_latest=0`,新 atom `is_latest=1`,响应 body 含 `previousId: A.id`

##### Scenario: cosine = 0.92 边界走 supersede
- **GIVEN** 新内容与 A cosine=0.92(等于阈值)
- **WHEN** 客户端 PATCH 写入
- **THEN** 沿用 `>=` 比较,等同 supersede

##### Scenario: ollama 不可达,跳过 cosine 检查
- **GIVEN** `embedText` 返回 null
- **WHEN** 客户端 PATCH 写入
- **THEN** 服务端跳过 supersede 检查,走原 updateAtom 流程,响应 200 但 body 无 `previousId`

#### Requirement: tag 写入归一化
`PATCH /api/memory/:id` SHALL 在合并 tags 字段前调用 `normalizeTags(input, settings.memory.tagAliases)`。归一化规则:trim → 空字符串过滤 → alias map 折叠 → `new Set` 去重 → 保序。
当 `settings.memory.tagAliases` 缺失或非对象时 SHALL 跳过 alias 折叠,仅做 Set 去重。

##### Scenario: tag 输入经 alias 折叠后去重
- **GIVEN** `settings.memory.tagAliases = {"代码规范": "code-style", "coding-rule": "code-style"}`
- **WHEN** 客户端 PATCH 带 `tags: ["代码规范", "code-style", "coding-rule"]`
- **THEN** 写入 DB 的 `atom.tags = ["code-style"]`

##### Scenario: tag_aliases 缺失,跳过折叠
- **GIVEN** `settings.memory.tagAliases` 未设置
- **WHEN** 客户端 PATCH 带 `tags: ["a", "a", "b"]`
- **THEN** 写入 DB 的 `atom.tags = ["a", "b"]`(仅 Set 去重)

#### Requirement: 检索 score 公式含 tag_overlap 和 freshness
`recallAtoms` SHALL 在既有 `score = cosine × (1 + 0.3 × strength + 0.2 × importance)` 主项之上加法叠加 `tag_overlap` 和 `freshness_decay` 两维度:
- `tagOverlap = computeTagOverlap(query, atom.tags)`,query 经 alias 折叠后与 atom.tags 求交集大小 / 归一化 token 数
- `freshness = exp(-daysSinceUpdate / 30)`(固定半衰期 30 天,无 importance 因子)
- 默认权重 `tagOverlapWeight = 0.10`, `freshnessWeight = 0.05`,均可由 `settings.memory.{tagOverlapWeight, freshnessWeight}` 覆盖
- `RecallResult` SHALL 新增字段 `tagOverlap: number` 和 `freshness: number` 用于 debug

主项 `score = cosine × (1 + 0.3s + 0.2i)` SHALL 保持数值不变(back-compat)。

##### Scenario: tag 命中的 atom 反超纯 cosine 高的 atom
- **GIVEN** query="code-style",atom A tags=["code-style"] cosine=0.7,atom B tags=[] cosine=0.85
- **WHEN** 服务端执行 recall
- **THEN** A.score = 0.7×(1+0.3s+0.2i) + 0.10×1.0 + 0.05×f ≥ B.score 排序上 A 排在 B 前或同位

##### Scenario: 自然语言 query 不受 tag_overlap 影响
- **GIVEN** query="怎么写 JavaScript",所有 atom 的 tag 都不匹配该 token
- **WHEN** 服务端执行 recall
- **THEN** tagOverlap 全部 = 0,排序完全由 cosine × (1+0.3s+0.2i) + 0.05×freshness 主导

#### Requirement: 单 atom 状态通过 SSE 推送
服务器 SHALL 提供 `GET /api/memory/:id/stream` SSE 端点;当任一客户端 PATCH 该 atom 时,所有订阅的连接 SHALL 收到 `event: atom\ndata: <JSON>\n\n` 帧。
服务器 SHALL 每 25 秒发送 SSE 注释帧 `: ping\n\n` 维持 NAT/中间设备连接。
客户端 SHALL 仅在 `incoming.version > localAtom.version` 时接受推送(单调递增防乱序)。

##### Scenario: 订阅 SSE 后 PATCH 触发推送
- **GIVEN** 客户端 A 订阅 `GET /api/memory/<id>/stream`,客户端 B PATCH 同一 atom 成功
- **WHEN** 服务端完成 PATCH
- **THEN** 客户端 A 收到 `event: atom\ndata: {...}\n\n` 帧

##### Scenario: 心跳保活
- **GIVEN** 客户端订阅 stream 后 30s 内无 atom 变化
- **WHEN** 服务器保持连接
- **THEN** 服务器每 25s 推送 `: ping\n\n` 注释帧

##### Scenario: 客户端断连自动清理订阅
- **GIVEN** 客户端订阅 stream
- **WHEN** 客户端断开(res close)
- **THEN** 服务器从订阅表移除该连接,停止心跳发送

##### Scenario: 推送乱序防护
- **GIVEN** 客户端 localAtom.version=6
- **WHEN** 服务器因竞态先推 v=7 再推 v=6(理论上不应发生,但 EventSource 重连可能)
- **THEN** 客户端丢弃 `incoming.version < localAtom.version` 的事件

### MODIFIED Requirements

#### Requirement: webui 客户端用 SSE 替代 3 秒轮询
`MemoryDetail` SHALL 用 `EventSource` 订阅 `GET /api/memory/:id/stream` 替代 `setInterval(fetchAtom, 3000)` 的轮询模式;首次加载仍调用 `GET /api/memory/:id` 拿首屏数据。
客户端 SHALL 仅在 `incoming.version > localAtom.version` 时接受推送以避免乱序覆盖。
客户端 SHALL 在 `EventSource.onerror` 时显示"连接中断,正在重连"提示(浏览器原生重连)。

##### Scenario: 客户端首次加载拉一次完整 atom
- **GIVEN** MemoryDetail 挂载(id=X)
- **WHEN** 组件 mount
- **THEN** 调用 `GET /api/memory/X` 一次,设置初始 atom;不轮询

##### Scenario: SSE 推送更新 UI
- **GIVEN** MemoryDetail 已订阅 stream,显示 atom v=5
- **WHEN** 其他客户端 PATCH 该 atom,服务器推送 v=6
- **THEN** 客户端 `setAtom(incoming)`,UI 重新渲染

#### Requirement: write 流程包含 tag 归一化与 cosine dedup
`PATCH /api/memory/:id` SHALL 顺序执行:
1. `If-Match` 头校验
2. tag 归一化(`normalizeTags` + Set union with existing.tags)
3. embedding 计算
4. cosine dedup 检查(`supersedeIfSimilar`)
5. updateAtom 或 markSupersededTx
6. writeAtomToFile
7. 广播 SSE 事件

任意步骤失败 SHALL 返回 5xx,前面已成功的步骤 SHALL 回滚(事务)。

##### Scenario: 完整 PATCH 流程
- **GIVEN** atom A version=5,tags=["x"],content="old"
- **WHEN** 客户端 PATCH 带 `If-Match:"5"`,tags=["新标签"],content="new"
- **THEN** 服务端:校验 5 → 归一化 tags 与现有合并 → embed "new" → cosine 检查 → updateAtom 写 v=6,tags=["新标签","x"] → 写 .md 文件 → 广播 atom v=6 → 响应 200

## Capability: recall-precision

### Requirements

#### Requirement: Recall gate via local LLM (qwen2.5:3b)
memory recall pipeline SHALL 在 `context` hook 入口先经过 gate LLM 决策: 给定当前 user msg + 最近 2-3 条 user msg, 输出 `{need_memory: boolean, search_query: string}`。gate 走 ollama qwen2.5:3b-instruct-q4_0 (温度 0), 500ms 超时, 失败一律降级 skip 召回 (不 fallback 走原 RRF), TUI 显示对应状态。

##### Scenario: 指代性 short query 被 gate 拦截 (S1)
- **GIVEN** recent user msgs = ["把 search_3n_path.py 改成异步的", "改成异步后跑一下"], 当前 = "上面的脚本有问题"
- **WHEN** gate 调用 qwen2.5:3b
- **THEN** 输出 `{need_memory: false}`, recall 被跳过, TUI 显示 "🚫 gate skipped", 端到端延迟 < 500ms

##### Scenario: 零信息量 ack query 被 gate 拦截 (S2)
- **GIVEN** recent = ["列一下 TODO"], 当前 = "对"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: false}`, 跳过 recall, status "🚫 gate skipped"

##### Scenario: 历史回溯 query 被 gate 改写后召回 (S3)
- **GIVEN** recent = ["我们之前用 bwa 做过引物验证", "做了 但是有个并发问题"], 当前 = "之前那个并发问题最后怎么解决的"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: true, search_query: "bwa 引物验证 并发"}`, 后续 recallAtoms 用 `search_query` (非原 msg)

##### Scenario: gate JSON 解析失败降级 skip (S5)
- **GIVEN** qwen2.5-3b 返回不合法 JSON
- **WHEN** gate 解析 (strip 前后非 `{...}` 段后重 parse) 仍失败
- **THEN** 返回 null, skip 召回, status "🚫 gate skipped (parse failed)"

##### Scenario: gate 500ms 超时 (S6)
- **GIVEN** ollama 500ms 内未响应
- **WHEN** AbortController 触发
- **THEN** 返 null, status "⚠ gate timeout, skipped"

##### Scenario: ollama 服务挂掉 (S7)
- **GIVEN** ollama ECONNREFUSED
- **WHEN** gate fetch 抛
- **THEN** catch 内吞掉, status "⚠ gate down, skipped"

#### Requirement: Cross-encoder rerank endpoint on bge-m3 server
bge-m3 server SHALL 提供 `POST /api/rerank` 端点: 接收 `{query, hits: [{id, embeddable_text}]}`, 用 `BAAI/bge-reranker-v2-m3` cross-encoder 计算 score (normalize=True), 返回 `{scores: [{id, score}]}`。模型 lazy load, `/api/health` 报告 `reranker_loaded` 状态。

##### Scenario: rerank 端点相关分正确区分相关/不相关 (R1)
- **GIVEN** query="bwa 并发", hit_a="bwa 验证方案", hit_b="Python 爬虫"
- **WHEN** POST /api/rerank
- **THEN** hit_a score ≈ 0.85, hit_b score ≈ 0.0001, 差距 >0.5

##### Scenario: reranker 未加载 503 (R5)
- **GIVEN** server 启动后 FlagReranker 初始化失败
- **WHEN** client POST
- **THEN** server 返 503, client 检测 non-2xx → fallback 原 RRF top-3

#### Requirement: rerank threshold + gap detection 截断
`rerankAndFilter` SHALL 在 rerank score 上应用双重截断: threshold ≥0.5 过滤低分; 相邻 gap >0.15 处截断。同分按原 RRF rrf 二次排序。formatMemoryContext 按 rerankScore 降序。

##### Scenario: threshold + gap 双截断 (R1)
- **GIVEN** rerank scores = [0.92, 0.85, 0.55, 0.32, 0.21]
- **WHEN** threshold ≥0.5 + gap>0.15 截断
- **THEN** threshold 过 3 个, gap 在 0.85→0.55 = 0.30 > 0.15 截前 2 个 → 返 [0.92, 0.85]

##### Scenario: 全部低于 threshold 不注入 (R3)
- **GIVEN** scores = [0.48, 0.45, 0.42, 0.30]
- **WHEN** threshold ≥0.5
- **THEN** 所有 hit 被丢, 返 [], 不注入

#### Requirement: pipeline 整合到 context hook
memory.ts SHALL 把 gate→recallAtoms→rerankAndFilter→formatMemoryContext 整条 pipeline 整合到 `context` hook。gate/rerank/format 走 dynamic import 以保持 cold path 清洁。

##### Scenario: 完整 happy path (P1)
- **GIVEN** ContextEvent.messages 含最近 2-3 user msg
- **WHEN** pipeline 触发
- **THEN** gate→recallAtoms→rerankAndFilter→formatMemoryContext, 总 ~850ms

##### Scenario: rerank/all-threshold-below 返回空 (R3)
- **GIVEN** rerank 全 score <0.5
- **WHEN** threshold 过滤
- **THEN** 返回 [], status "🔍 no memory match"

#### Requirement: 失败降级矩阵
gate/rerank 各故障都对应明确降级行为: gate 失败 → skip 召回 (不注入); rerank 失败 → fallback 原 RRF top-3 (注入有精度下降); 全部低于 threshold → 不注入。

##### Scenario: gate disabled (P5)
- **GIVEN** settings.json `memory.gate.enabled=false`
- **WHEN** context hook 触发
- **THEN** 跳过 gate, 直接走 recallAtoms + rerank

## Capability: migration-atom-remigrate

One-shot memory corpus dedup + extract pipeline improvement to prevent future redundancy. Targets 90 legacy atoms + all future extract emissions.

### Requirement: Legacy Atom Migration Script
The system SHALL provide a one-shot script `migrate-legacy-atoms.mts` that performs programmatic 0.65-cosine deduplication against the active atom corpus, with backup + idempotency.

#### Scenario: One-shot programmatic 0.65 dedup migration runs
- **GIVEN** memory.db contains 90 active atoms (90 .md files in `atoms/{type}/`)
- **AND** bge-m3 service runs at `127.0.0.1:11435` (not called by this script — content unchanged, vectors still correct)
- **WHEN** user runs `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** script backs up memory.db → `memory.db.bak.YYYYMMDD`
- **AND** script reads 90 atoms, sorts by `(access_count DESC, last_access DESC NULLS LAST, created_at DESC)`
- **AND** for each atom, script reads its embedding from `memory_vectors`, calls `findMostSimilarEmbedding(embedding, 0.65)`
- **AND** if hit (not self), script calls `markSupersededNoInsert(hit.id, atom.id, now)` to mark hit archived
- **AND** script outputs "migration done: 90 → 75 active (archived 15). Re-run idempotent."

#### Scenario: Same-cluster 0.65+ cosine pair automatically merges
- **GIVEN** corpus has 2 atoms: "扩增子物种注释结果文件" (embedding A) and "扩增子物种注释结果文件路径" (embedding B), A↔B dense cosine = 0.756
- **AND** sort places A first (higher access_count or last_access)
- **WHEN** script iterates to A
- **THEN** `findMostSimilarEmbedding(A, 0.65)` returns B (cosine 0.756 ≥ 0.65)
- **AND** script calls `markSupersededNoInsert(B.id, A.id, now)`: B marked is_latest=0, parent_id=A, superseded_at=now
- **AND** A unchanged (id preserved, active, the "winner")
- **WHEN** script later iterates to B
- **THEN** B is already is_latest=0, `getActiveAtoms()` filters it out, script skips
- **AND** recall shows only A (B excluded), precision improves

#### Scenario: Atom content length is not expanded
- **GIVEN** 2 atoms with cluster relation; one has 200-char content, the other 300-char
- **WHEN** 0.65 dedup merge (hot atom wins)
- **THEN** winner keeps original content (200 or 300 chars), no lengthening
- **AND** bge-m3 vector still matches (content unchanged)
- **AND** recall shows user the 200 or 300 char version, not 500 chars (token savings)

#### Scenario: Idempotent re-run produces 0 changes
- **GIVEN** first migration completed, corpus no longer has cosine ≥ 0.65 pairs (dedup terminal state)
- **WHEN** user re-runs `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** second run: for each atom, `findMostSimilarEmbedding(embedding, 0.65)` returns self (cosine 1.0)
- **AND** self-match guard path, no-op
- **AND** 0 markSupersededNoInsert calls, 0 reindex
- **AND** report shows "0 changes (idempotent)"

#### Scenario: Backup creation failure aborts migration safely
- **GIVEN** memory.db is 4.4MB, target backup path disk is full
- **WHEN** `cp memory.db memory.db.bak.YYYYMMDD` fails
- **THEN** script aborts, logs "backup failed, refusing to migrate"
- **AND** 0 atoms changed

#### Scenario: User can rollback migration via backup file
- **GIVEN** migration completed, user runs recall once and finds "扩增子" recall has 1 result but needed 2 (some cluster wrongly merged)
- **WHEN** user runs `cp memory.db.bak.YYYYMMDD memory.db`
- **AND** user restarts bge-m3 service (it auto-rebuilds in-memory index from db on startup)
- **THEN** recall returns to pre-migration state (all ids present, all is_latest=1, content is pre-migration)

#### Scenario: Re-run with lower threshold 30 days later
- **GIVEN** first 0.65 dedup run completed, corpus 75 atoms, precision improved but 0.55-0.65 range cluster remnants
- **WHEN** user runs `npx tsx migrate-legacy-atoms.mts --threshold=0.60` (script supports CLI threshold)
- **THEN** second run with 0.60 dedup catches 36 new pairs (90 → 65)
- **AND** 0 mis-merges (sample data shows all real clusters)
- **AND** idempotent: 0.65-merged clusters not re-superseded by 0.60 (already archived)

#### Scenario: 30 days later user wants to re-run on smaller corpus
- **GIVEN** user manually archived 20 atoms before migration
- **WHEN** script scans active atoms, only sees 70
- **THEN** script only processes these 70, backup file size corresponds to full DB (90 rows)
- **AND** log shows "found 70 active atoms (db has N total, N-70 are archived/superseded)"

### Requirement: Cosine Dedup Threshold Alignment
The system SHALL use a single cosine dedup threshold of 0.65 across all write paths, providing a 0.10 buffer above the recall floor (0.55) and catching real cluster pairs that the legacy 0.92 threshold missed.

#### Scenario: supersedeIfSimilar uses 0.65 as default threshold
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding)` without specifying threshold
- **WHEN** the function runs
- **THEN** it calls `findMostSimilarEmbedding(embedding, 0.65)` (0.65 default, not 0.92)

#### Scenario: 0.65 threshold catches real cluster pairs (X101SC)
- **GIVEN** corpus has 2 atoms: "X101SC26052587 客户数据未回传" and "X101SC26052587 当前阻塞状态", cosine 0.708
- **WHEN** 0.65 dedup runs
- **THEN** pair is detected and merged (cosine 0.708 ≥ 0.65)

#### Scenario: 0.65 threshold catches real cluster pairs (iCAMP)
- **GIVEN** corpus has 2 atoms: "iCAMP分组柱状图顺序修复" and "iCAMP bar chart group order fix script", cosine 0.758
- **WHEN** 0.65 dedup runs
- **THEN** pair is detected and merged (cosine 0.758 ≥ 0.65)

#### Scenario: 0.65 threshold does not over-merge (preserves 0.55-0.65 borderline)
- **GIVEN** corpus has 2 atoms with cosine 0.58 (below 0.65)
- **WHEN** 0.65 dedup runs
- **THEN** pair is NOT merged (cosine 0.58 < 0.65, threshold not met)

### Requirement: Extract Pipeline LLM 二次确认 Dedup
The system SHALL, when `executeItem` finds a cosine ≥ 0.65 match between a new extraction item and an existing atom, call an LLM with both contents to determine the correct action (update / supersede / create / skip), rather than auto-superseding.

#### Scenario: Cosine < 0.65 — no LLM call, direct insert
- **GIVEN** extract emits a new topic item, `findMostSimilarEmbedding(0.65)` returns null or cosine < 0.65
- **THEN** executeItem takes create path: `index.insertAtom` + `writeAtomToFile` + bge-m3 reindex
- **AND** LLM dedup confirmation is NOT called (skip LLM cost for the 80% common case)
- **AND** this is the typical new-topic case

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "update" — in-place merge
- **GIVEN** user session mentions "check_seq.py 又改了输出格式,现在支持 JSON"
- **AND** corpus has atom "check_seq.py 脚本位置与输出格式" (tsv format)
- **WHEN** extract LLM emits an item, `executeItem` finds hit with cosine 0.77
- **THEN** executeItem calls LLM 二次确认 with hit.atom + newItem contents
- **AND** LLM returns `{ action: "update", merged: { title: "check_seq.py 脚本位置与输出格式", content: "原 content + 2026-07 新增 JSON 格式支持" } }`
- **THEN** executeItem takes update path: `index.updateAtom(mergedAtom)` in-place, version+1, `writeAtomToFile`, bge-m3 reindex
- **AND** old atom id preserved, new info merged in

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "supersede" — new atom replaces old
- **GIVEN** extract emits "扩增子物种注释结果文件" (item), corpus has "扩增子物种注释结果文件路径" (hit, cosine 0.756)
- **WHEN** LLM 二次确认 reviews hit+item
- **THEN** LLM judges this as nearly synonymous (file vs file path, 2 char difference), returns `action: "supersede"`
- **THEN** executeItem takes supersede path: `index.markSupersededTx(hit.id, item, embedding)`, hit marked archived+parent_id=item.id, item exists independently, `writeAtomToFile` + bge-m3 reindex

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "create" — independent new atom
- **GIVEN** extract emits "iCAMP 分组柱状图顺序修复" (item), corpus has "iCAMP 分组顺序 Skill 注册信息" (hit, cosine 0.78)
- **WHEN** LLM 二次确认 reviews hit+item
- **THEN** LLM judges these are different topics (one is fix, one is Skill registration), returns `action: "create"`
- **THEN** executeItem takes create path: hit unchanged, item inserted independently, `writeAtomToFile` + bge-m3 reindex
- **AND** recall shows both atoms, user selects which is relevant

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "skip" — full duplicate, no-op
- **GIVEN** LLM 二次确认 reviews hit+item, judges info fully duplicate (fingerprint dedup missed, but cosine 0.65+ matched)
- **WHEN** LLM returns `action: "skip"`
- **THEN** executeItem writes no files, item dropped, trace logs "dedup-confirm: skip"

#### Scenario: LLM 二次确认 fails (timeout / JSON parse) — fallback to supersede
- **GIVEN** LLM 二次确认 call hits 5s timeout or returns non-JSON
- **THEN** executeItem takes fallback path: `action: "supersede"` (conservative, matches cosine 0.65 hit)
- **AND** logs warn: "LLM dedup confirm failed for item X (hit Y), fell back to supersede"
- **AND** does not interrupt, continues with next item

### Requirement: Tag Vocabulary Injection
The system SHALL compute a top-50 high-frequency tag vocabulary from the active corpus at extract time and inject it into `EXTRACT_PROMPT_V2` so the LLM reuses existing tags rather than inventing near-synonyms.

#### Scenario: Tag dictionary loaded and injected at first extract
- **GIVEN** corpus has 90 atoms loaded
- **WHEN** `extractMemoriesWithCallLlm` is first called
- **THEN** construct prompt by first calling `loadTagVocabulary(index)` (new function), scanning `memory_index.tags` column (JSON parse), tallying frequency, taking top 50
- **AND** inject into prompt top: "## 现有 tag 字典 (优先复用,不要发明新近义 tag)\n" + comma-joined tags
- **AND** tagVocabulary cached in-memory until session end (not recomputed per extract)

#### Scenario: Tag dictionary injection prompt content
- **GIVEN** session triggers `session_before_compact` extract
- **WHEN** LLM receives prompt
- **THEN** prompt contains a section:
  ```
  ## 现有 tag 字典 (优先复用,不要发明新近义 tag)
  amplicon, 16S, MTB, R, 扩增子, 修复, bug, fix, position, location,
  flow, process, rule, prefer, prefer-not, prefer-must, ...

  ## Tag 规范
  - 大小写归一: 全部 lowercase (中文不变)
  - 同义合并: 写 "Amplicon" 视作 "amplicon"; 写 "Bug 修复" 视作 "bug fix"
  - 概念性 tag 至少 1 个 (动作/类别)
  - 总数 3-6 个
  ```

#### Scenario: LLM sees updatable new info and updates existing atom
- **GIVEN** user session mentions "check_seq.py 又改了输出格式,现在支持 JSON"
- **AND** corpus has atom "check_seq.py 脚本位置与输出格式" (tsv format)
- **WHEN** extract LLM analyzes this new info
- **THEN** LLM sees "## 主动更新,非扩张" rule in prompt
- **AND** LLM decides: append "2026-07 新增 JSON 格式支持" to existing atom content, do NOT create new atom
- **THEN** `executeItem` takes supersede path (cosine ≥ 0.65 hit, Decision 10), new version replaces old

#### Scenario: LLM emits new item but program dedup catches it (fallback)
- **GIVEN** LLM emits "check_seq.py 新增 JSON 格式支持" but missed the updatable existing atom
- **WHEN** `executeItem` runs fingerprint dedup + 0.65 cosine dedup
- **AND** new atom content_fingerprint matches existing → skip
- **OR** new atom cosine ≥ 0.65 with existing → supersede
- **THEN** existing atom content updated, new atom does not exist independently

#### Scenario: Corpus empty — tag dictionary injection is empty string
- **GIVEN** user first launch, corpus 0 atoms
- **WHEN** first extract triggers
- **THEN** `loadTagVocabulary` returns empty set, prompt's "## 现有 tag 字典" section reads "(空,自由 emit)"
- **AND** no error, extract proceeds normally

#### Scenario: Corpus at 1000 atoms — dictionary scan stays fast
- **GIVEN** corpus has 1000 atoms
- **WHEN** `loadTagVocabulary` scans all active atom tags columns
- **THEN** single scan ~50ms, cached in-memory for the whole session
- **AND** user does not perceive delay (session_before_compact already has 1-2s LLM call)

### Requirement: Program-Side Tag Normalization
The system SHALL normalize LLM-emitted tags in `executeItem` to ensure corpus-wide tag consistency, including lowercase folding, dictionary match priority, and concept-tag count check.

#### Scenario: Tag lowercase normalization (Chinese unchanged)
- **GIVEN** LLM emits `["Amplicon", "X101SC", "16S", "扩增子"]`
- **WHEN** `normalizeTag` is called on each (no dictionary)
- **THEN** result is `["amplicon", "x101sc", "16s", "扩增子"]` (Chinese unchanged via Unicode range detection)

#### Scenario: Tag dictionary match priority (MGM stays MGM)
- **GIVEN** dictionary contains "MGM"
- **WHEN** `normalizeTag` is called on "MGM" with that dictionary
- **THEN** returns "MGM" (not lowercased, because dictionary match takes priority)

#### Scenario: Tag dictionary match priority (Amplicon folds to amplicon)
- **GIVEN** dictionary contains "amplicon" (lowercase canonical)
- **WHEN** `normalizeTag` is called on "Amplicon" with that dictionary
- **THEN** returns "amplicon" (dictionary canonical form used)

#### Scenario: LLM emits all-proper-noun tags — concept warning
- **GIVEN** LLM emits `["Amplicon", "X101SC", "16S"]` (all proper nouns, no concept/* tags)
- **WHEN** `conceptTagCount` runs on these tags
- **THEN** returns 0
- **AND** executeItem logs warn: "item X lacks concept tag (0/N tags are concept/*)"
- **AND** item is still written (warning, not rejection — don't lose data)

### Requirement: EXTRACT_PROMPT_V2 Active Update Rule
The system SHALL include an "## 主动更新,非扩张" section in `EXTRACT_PROMPT_V2` instructing the LLM to prefer updating existing atoms over creating new ones when the new information belongs to an existing topic.

#### Scenario: EXTRACT_PROMPT_V2 contains active-update rule
- **WHEN** `EXTRACT_PROMPT_V2` is read
- **THEN** it contains the section:
  ```
  ## 主动更新,非扩张 (重要!)

  - 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同), 优先更新该 atom 的 content, 不要为这条信息创建新 atom
  - 更新方式: 在 content 末尾追加新段落, 标注日期 (e.g. "2026-07 新增 JSON 格式支持")
  - 仅在信息属于全新主题/新对象/新项目时才创建新 atom
  - 这是 corpus 持续精炼的关键: 主动合并而非堆叠
  ```

### Requirement: ExecutePlan Signature (extended with callLlm)
The `executePlan` function in `extensions/personal-assistant/extraction.ts` SHALL accept an optional `callLlm` parameter that is passed through to `executeItem` for the LLM 二次确认 dedup decision path. When `callLlm` is undefined, the legacy behavior is preserved (no LLM 二次确认, `supersedeIfSimilar` auto-supersede path).

#### Scenario: executePlan with callLlm — LLM 二次确认 enabled
- **GIVEN** `extractMemoriesWithCallLlm` calls `executePlan(index, atomsDir, plan, callLlm)` with the LLM callback
- **WHEN** `executeItem` finds cosine ≥ 0.65 hit
- **THEN** executeItem uses callLlm to confirm the dedup action
- **AND** behavior follows the LLM 二次确认 scenarios above

#### Scenario: executePlan without callLlm — legacy behavior
- **GIVEN** a test calls `executePlan(index, atomsDir, plan)` without callLlm
- **WHEN** executeItem runs
- **THEN** executeItem skips LLM 二次确认, falls back to `supersedeIfSimilar` auto-supersede
- **AND** legacy behavior preserved (backward compatibility)

### Requirement: ExecuteItem Behavior (cosine hit → LLM 二次确认)
The `executeItem` function in `extensions/personal-assistant/extraction.ts` SHALL, when finding a cosine ≥ 0.65 match between a new extraction item and an existing atom, call the LLM 二次确认 to determine the action (update/supersede/create/skip) rather than auto-supersede. The function SHALL also normalize tags and warn on missing concept tags before write.

#### Scenario: executeItem normalizes tags before write
- **GIVEN** LLM emits item with `tags: ["Amplicon", "16S", "扩增子"]`
- **WHEN** executeItem processes this item
- **THEN** it calls `normalizeTag` on each tag
- **AND** writes the atom with `tags: ["amplicon", "16s", "扩增子"]` (lowercased, Chinese unchanged)

#### Scenario: executeItem warns on missing concept tag
- **GIVEN** LLM emits item with `tags: ["amplicon", "16s"]` (no concept/* tag)
- **WHEN** executeItem processes this item
- **THEN** it calls `conceptTagCount(tags)` → 0
- **AND** logs warn: "item X lacks concept tag (0/2 tags are concept/*)"
- **AND** still writes the atom (warn, not reject)

#### Scenario: executeItem cosine ≥ 0.65 hit triggers LLM 二次确认
- **GIVEN** new item embedding has cosine 0.77 with existing atom
- **WHEN** executeItem calls `findMostSimilarEmbedding(embedding, 0.65)`
- **THEN** it finds the hit
- **AND** calls `confirmDedupAction(callLlm, hit.atom, newItem)` for the LLM 二次确认
- **AND** applies the action returned by LLM (update/supersede/create/skip)

#### Scenario: executeItem LLM 二次确认 returns update — in-place merge
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "update"` with `merged: { title, summary, content, tags }`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.updateAtom(mergedAtom, embedding)` (in-place, version+1)
- **AND** calls `writeAtomToFile(mergedAtom, atomsDir)`
- **AND** calls bge-m3 `reindexOne(mergedAtom.id)` (HTTP, 5s timeout, failure logged warn)
- **AND** returns `{ status: "update", atom: mergedAtom }`

#### Scenario: executeItem LLM 二次确认 returns supersede — old archived, new independent
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "supersede"`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.markSupersededTx(hit.id, newAtom, embedding)`
- **AND** calls `writeAtomToFile(finalNew, atomsDir)`
- **AND** calls bge-m3 `reindexOne(finalNew.id)`
- **AND** returns `{ status: "supersede", atom: finalNew }`

#### Scenario: executeItem LLM 二次确认 returns create — new independent, hit unchanged
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "create"`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.insertAtom(newAtom, vector)` (hit unchanged)
- **AND** calls `writeAtomToFile(newAtom, atomsDir)`
- **AND** calls bge-m3 `reindexOne(newAtom.id)`
- **AND** returns `{ status: "create", atom: newAtom }`

#### Scenario: executeItem LLM 二次确认 returns skip — no-op
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "skip"`
- **WHEN** executeItem applies the action
- **THEN** it writes no files, makes no DB changes
- **AND** logs trace: "dedup-confirm: skip"
- **AND** returns `{ status: "skip", atom: hit.atom }` (the hit, not the new item)

#### Scenario: executeItem LLM 二次确认 call fails — fallback to supersede
- **GIVEN** executeItem called `confirmDedupAction`, LLM call timed out or returned non-JSON
- **WHEN** executeItem catches the failure
- **THEN** it falls back to `action: "supersede"` (conservative, matches cosine 0.65 hit)
- **AND** logs warn: "LLM dedup confirm failed for item X (hit Y), fell back to supersede"
- **AND** calls `index.markSupersededTx(hit.id, newAtom, embedding)` (same as scenario "LLM returns supersede")
