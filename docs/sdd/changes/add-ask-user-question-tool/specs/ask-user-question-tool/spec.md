# ask-user-question-tool Specification

## ADDED Requirements

### Requirement: ask_user_question Tool Registration
The personal-assistant extension SHALL register a tool named `ask_user_question` that the LLM can invoke to ask the user a multiple-choice question.

#### Scenario: Tool is registered with the correct name
- **GIVEN** the personal-assistant extension is loaded in a pi session
- **WHEN** pi initializes the extension via `index.ts`'s default export
- **THEN** `pi.registerTool` SHALL have been called exactly once with `name: "ask_user_question"`

#### Scenario: Tool description matches Claude Code spec
- **GIVEN** the registered tool is visible to the LLM via the API request tools array
- **WHEN** the LLM inspects the tool definition
- **THEN** the tool's `description` SHALL mention "2-4 options" and "multiSelect" semantics so the LLM knows the constraints

### Requirement: Lenient Tool Schema for Hallucinated Argument Shapes
The `ask_user_question` tool's parameter schema SHALL accept every argument shape the LLM has been observed to emit in practice, including malformed wrapper objects.

#### Scenario: Standard Claude Code spec arguments
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", header: "H", options: [{label: "L1", description: "D1"}, {label: "L2", description: "D2"}], multiSelect: false}`
- **WHEN** pi validates the tool call against the registered schema
- **THEN** validation SHALL pass and `execute` SHALL be invoked with the raw arguments

#### Scenario: Nested `{item: {item: [...]}}` wrapper shape
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", header: "H", options: {item: {item: [{label: "L1", description: "D1"}, {label: "L2", description: "D2"}]}}}`
- **WHEN** pi validates the tool call
- **THEN** validation SHALL pass and `execute` SHALL receive the raw nested arguments
- **AND THEN** the `normalizeOptions` function inside `execute` SHALL unwrap the nested `.item` wrappers to produce a flat `[{label, description}]` array

#### Scenario: Missing `header` field
- **GIVEN** the LLM calls `ask_user_question` with `{question: "Q", options: [{label, description}, {label, description}]}` (no `header`)
- **WHEN** `execute` runs
- **THEN** the tool SHALL treat the `question` field as the title and SHALL NOT error

#### Scenario: Missing `multiSelect` field
- **GIVEN** the LLM calls `ask_user_question` with `{question, header, options}` (no `multiSelect`)
- **WHEN** `execute` runs
- **THEN** the tool SHALL default `multiSelect` to `false` and proceed in single-select mode

#### Scenario: Empty or missing `options`
- **GIVEN** the LLM calls `ask_user_question` with `{question, header}` and no `options`
- **WHEN** `execute` runs
- **THEN** the tool SHALL return an `isError: true` result with text "ask_user_question requires at least 2 options" and SHALL NOT invoke any UI prompt

### Requirement: Options Count Validation
The `ask_user_question` tool SHALL enforce the Claude Code spec constraint of 2-4 options.

#### Scenario: Exactly 2 options
- **GIVEN** the LLM calls with 2 options
- **WHEN** `execute` validates
- **THEN** validation SHALL pass and the UI SHALL prompt the user

#### Scenario: Exactly 4 options
- **GIVEN** the LLM calls with 4 options
- **WHEN** `execute` validates
- **THEN** validation SHALL pass and the UI SHALL prompt the user

#### Scenario: 1 option
- **GIVEN** the LLM calls with 1 option
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "requires 2-4 options"

#### Scenario: 5 or more options
- **GIVEN** the LLM calls with 5+ options
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "requires 2-4 options"

#### Scenario: multiSelect with fewer than 2 options
- **GIVEN** the LLM calls with `multiSelect: true` and 1 option
- **WHEN** `execute` validates
- **THEN** the tool SHALL return `isError: true` with text "multiSelect requires at least 2 options"

### Requirement: TUI Single-Select via Stock `ctx.ui.select`
In interactive TUI mode, the `ask_user_question` tool SHALL use `ctx.ui.select()` to prompt the user when `multiSelect` is false.

#### Scenario: TUI single-select happy path
- **GIVEN** pi is in `--mode interactive`, model calls `ask_user_question` with 3 single-select options
- **WHEN** `execute` runs
- **THEN** the tool SHALL call `ctx.ui.select(title, ["L1 — D1", "L2 — D2", "L3 — D3"], {timeout: 300000})` where labels are `label` concatenated with `description` via `" — "` separator
- **AND THEN** when the user selects "L1 — D1", the tool SHALL return `content: [{type: "text", text: "User selected: L1 — D1"}]` and `details: {selected: "L1 — D1", options: [...], multiSelect: false}`

#### Scenario: TUI user cancels via Esc
- **GIVEN** the user is viewing the TUI selector for `ask_user_question`
- **WHEN** the user presses Esc
- **THEN** `ctx.ui.select` SHALL resolve to `undefined`
- **AND THEN** the tool SHALL return `content: [{type: "text", text: "User cancelled the question"}]` and `details: {cancelled: true}`

#### Scenario: TUI timeout after 5 minutes
- **GIVEN** the user has been viewing the TUI selector for 5 minutes without action
- **WHEN** the `ExtensionUIDialogOptions.timeout` of 300000 ms elapses
- **THEN** `ctx.ui.select` SHALL resolve to `undefined` via pi's `createDialogPromise` timeout path
- **AND THEN** the tool SHALL return the same "User cancelled" result as the Esc case (timeout is a flavor of cancel)

### Requirement: TUI Multi-Select via Stock `ctx.ui.input`
In interactive TUI mode, the `ask_user_question` tool SHALL use `ctx.ui.input()` with a comma-separated placeholder when `multiSelect` is true.

#### Scenario: TUI multi-select happy path
- **GIVEN** pi is in `--mode interactive`, model calls `ask_user_question` with 3 options and `multiSelect: true`
- **WHEN** `execute` runs
- **THEN** the tool SHALL call `ctx.ui.input(title, "L1 — D1 | L2 — D2 | L3 — D3 (comma-separated)", {timeout: 300000})`
- **AND THEN** when the user enters "L1 — D1, L3 — D3", the tool SHALL return `content: [{type: "text", text: "User selected: L1 — D1, L3 — D3"}]`

### Requirement: Webui RPC Extension UI Request Forwarding
The webui server SHALL forward `extension_ui_request` events from the pi subprocess stdout to subscribed WebSocket clients.

#### Scenario: extension_ui_request reaches the browser
- **GIVEN** a webui session is subscribed to a session's events and the pi subprocess emits `{type: "extension_ui_request", id: "abc", method: "select", title: "...", options: [...], timeout: 300000}` on stdout
- **WHEN** the server's `session-pool.handleStdoutLine` parses the line
- **THEN** the server SHALL emit a `pool` event with `sessionId` and the parsed event
- **AND THEN** the WebSocket handler SHALL forward `{type: "session_event", sessionId, event: <extension_ui_request>}` to the subscribed client

### Requirement: Webui Server Writes RPC Extension UI Response
The webui server SHALL accept `extension_ui_response` messages from WebSocket clients and write them to the corresponding pi subprocess's stdin as JSONL.

#### Scenario: Web client submits an answer
- **GIVEN** a web client previously received an `extension_ui_request` with `id: "abc"` from session `s1`
- **WHEN** the web client sends `{type: "extension_ui_response", id: "abc", value: "L1"}` to the server
- **AND WHEN** the server's WS handler parses the message
- **THEN** the handler SHALL call `pool.sendExtensionUIResponse("s1", {id: "abc", value: "L1"})`
- **AND THEN** `pool.sendExtensionUIResponse` SHALL write `{type: "extension_ui_response", id: "abc", value: "L1"}\n` to the pi subprocess's stdin

#### Scenario: Response without active session
- **GIVEN** a web client has not subscribed to any session (`activeSession` is `undefined`)
- **WHEN** the client sends `{type: "extension_ui_response", id, value}`
- **THEN** the WS handler SHALL send an error message back to the client: `"No active session"` and SHALL NOT write to any pi subprocess

#### Scenario: Send to non-existent session
- **GIVEN** a pi subprocess for session `s1` has exited and been removed from `pool.sessions`
- **WHEN** the WS handler calls `pool.sendExtensionUIResponse("s1", {...})`
- **THEN** the method SHALL silently return (no-op) and SHALL NOT throw

### Requirement: Webui Client Modal Rendering
The webui client SHALL render a modal dialog when an `extension_ui_request` of method `select` or `input` is received, allowing the user to pick an answer.

#### Scenario: Modal renders question and options
- **GIVEN** the webui client receives `{type: "session_event", sessionId: "s1", event: {type: "extension_ui_request", id: "abc", method: "select", title: "Q1", options: ["L1 — D1", "L2 — D2"]}}`
- **WHEN** the `AskUserQuestionProvider` handles the event
- **THEN** the `AskUserQuestionModal` component SHALL mount showing the question text and the options as selectable buttons (label + description on two lines)

#### Scenario: Single-select submit
- **GIVEN** the modal is showing 2 single-select options
- **WHEN** the user clicks option "L1"
- **THEN** the modal SHALL call `onSubmit("L1")` and the provider SHALL send `{type: "extension_ui_response", id: "abc", value: "L1"}` over the WebSocket

#### Scenario: Multi-select submit
- **GIVEN** the modal is showing 3 multi-select options (checkboxes)
- **WHEN** the user checks "L1" and "L3" and clicks Submit
- **THEN** the modal SHALL call `onSubmit("L1, L3")` (labels in click order, comma-separated)

#### Scenario: User cancels the modal
- **GIVEN** the modal is showing options
- **WHEN** the user clicks the Cancel button or presses the Esc key
- **THEN** the modal SHALL call `onCancel` and the provider SHALL send `{type: "extension_ui_response", id: "abc", cancelled: true}` over the WebSocket

### Requirement: Webui Pending Placeholder in Chat
The webui chat page SHALL display a "⏳ waiting for user answer" placeholder when an `extension_ui_request` is received, and SHALL replace it with the full tool call + result on `tool_execution_end`.

#### Scenario: Placeholder inserted on request
- **GIVEN** the chat page is rendering messages and a new `extension_ui_request` for session `s1` arrives
- **WHEN** the `ChatPage` event handler processes it
- **THEN** an `<AskUserQuestionPending>` element SHALL appear at the end of the messages list with the question text

#### Scenario: Placeholder replaced on tool execution end
- **GIVEN** a `<AskUserQuestionPending>` placeholder with `id: "abc"` is visible in the chat
- **WHEN** the chat page receives `{type: "tool_execution_end", toolCallId: "abc", toolName: "ask_user_question", result: {content: [{type: "text", text: "User selected: L1"}]}}`
- **THEN** the placeholder SHALL be replaced with a complete tool call entry showing both the call args and the result

#### Scenario: Placeholder preserved on unrelated tool execution end
- **GIVEN** a `<AskUserQuestionPending>` placeholder with `id: "abc"` is visible
- **WHEN** a `tool_execution_end` event arrives for a different `toolName` (e.g., `read`)
- **THEN** the placeholder SHALL remain visible

### Requirement: Webui Multi-Modal Queue Per Session
The webui client SHALL queue multiple unanswered `extension_ui_request` events per session, showing them one at a time, and SHALL display a pending count when more than one is queued.

#### Scenario: Multiple requests queue serially
- **GIVEN** the modal is currently showing the request with `id: "abc"` from session `s1`
- **WHEN** a second `extension_ui_request` with `id: "def"` arrives for session `s1` while the first is still open
- **THEN** the second request SHALL be enqueued in `Map<sessionId, ModalState[]>` and SHALL NOT replace the current modal

#### Scenario: Next request shown after submission
- **GIVEN** 2 requests are queued for session `s1` and the user submits an answer for `id: "abc"`
- **WHEN** the submission completes
- **THEN** the modal SHALL close and the next queued request `id: "def"` SHALL automatically be shown

#### Scenario: Pending count indicator
- **GIVEN** 3 requests are queued for session `s1` and the modal for the first is currently displayed
- **WHEN** the provider updates the queue state
- **THEN** the topbar SHALL display "⏳ 还有 2 个未答问题" (or equivalent) for session `s1`

#### Scenario: Per-session queue isolation
- **GIVEN** a web client is subscribed to sessions `s1` and `s2`, and modal for `s1/id-a` is currently displayed
- **WHEN** a new `extension_ui_request` arrives for session `s2`
- **THEN** the new request SHALL be enqueued in `s2`'s queue, and the current modal for `s1/id-a` SHALL NOT be displaced

### Requirement: 5-Minute Timeout via Stock Pi Mechanism
The `ask_user_question` tool SHALL use the stock `ExtensionUIDialogOptions.timeout` mechanism (5 minutes) to bound how long the user has to respond.

#### Scenario: Timeout fires after 5 minutes with no response
- **GIVEN** the user has been viewing the `ask_user_question` UI for 5 minutes without responding
- **WHEN** the timeout elapses
- **THEN** the underlying `ctx.ui.select` or `ctx.ui.input` promise SHALL resolve to `undefined`
- **AND THEN** the tool SHALL return a cancel result and the LLM SHALL be informed that the user did not respond
- **AND THEN** the webui modal SHALL close and the chat placeholder SHALL be replaced with the cancel tool result

### Requirement: No Persistence of Unanswered Modals
The webui client SHALL NOT persist unanswered modal state to localStorage or any other storage. Refreshing the page SHALL drop the modal and the placeholder; the tool's timeout will eventually fire on the server side.

#### Scenario: Page refresh drops the modal
- **GIVEN** a modal is open and a chat placeholder is visible
- **WHEN** the user refreshes the browser
- **THEN** the modal and placeholder SHALL be gone after reload
- **AND THEN** the pi subprocess's `ctx.ui.select` SHALL still be waiting; after the 5-minute timeout, the tool SHALL return the cancel result and the LLM SHALL continue

### Requirement: No History Rewriting for Pre-Existing Not-Found Errors
This change SHALL NOT modify any existing session JSONL files to retroactively "fix" `Tool ask_user_question not found` errors that occurred before the change was deployed.

#### Scenario: Pre-existing error records are preserved
- **GIVEN** a session JSONL contains entries with `toolName: "ask_user_question"` and `isError: true` and `errorMessage: "Tool ask_user_question not found"`
- **WHEN** the change is deployed
- **THEN** those entries SHALL remain unchanged in the session JSONL

## MODIFIED Requirements

### Requirement: Webui Server WS Protocol Message Types
The `ClientMessage` type union in `ws/handler.ts` SHALL be extended to include `extension_ui_response` messages so that the browser can send back RPC extension UI responses.

#### Scenario: WS handler routes extension_ui_response messages
- **GIVEN** a web client sends a WebSocket message of type `extension_ui_response`
- **WHEN** the WS handler processes the message
- **THEN** the handler SHALL call `pool.sendExtensionUIResponse(sessionId, response)` with the active session ID
- **AND THEN** the handler SHALL NOT throw or send an "Unknown message type" error for this new variant

### Requirement: Webui SessionPool RPC Write Methods
The `SessionPool` class SHALL expose a `sendExtensionUIResponse(sessionId, response)` method for routing WebSocket-originated RPC responses to the pi subprocess.

#### Scenario: sendExtensionUIResponse writes valid JSONL
- **GIVEN** a session with a running pi subprocess
- **WHEN** `pool.sendExtensionUIResponse("s1", {id: "abc", value: "L1"})` is called
- **THEN** the method SHALL write `{"type":"extension_ui_response","id":"abc","value":"L1"}\n` to the subprocess's stdin
- **AND THEN** the method SHALL be a no-op (silent return) if the session has no proc or the proc has exited

## REMOVED Requirements

(None)

## RENAMED Requirements

(None)
