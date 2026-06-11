# chat-message-rendering Specification

## ADDED Requirements

### Requirement: Structured Message Parts

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

#### Scenario: User message renders as single TextPart
- **GIVEN** a JSONL entry `{ "type":"message", "message":{ "role":"user", "content":[{"type":"text","text":"hello"}] } }`
- **WHEN** `/api/sessions/:id/messages` returns it
- **THEN** the response has `parts: [{ type:"text", text:"hello" }]`

#### Scenario: Assistant message preserves all part types in order
- **GIVEN** a JSONL entry with `role:"assistant"` and `content: [thinking, toolCall, text]`
- **WHEN** the API returns it
- **THEN** `parts` contains 3 entries in order: `ThinkingPart`, `ToolCallPart`, `TextPart`

#### Scenario: ToolResult is no longer filtered
- **GIVEN** a JSONL entry with `role:"toolResult"`
- **WHEN** the API returns the message list
- **THEN** the toolResult is included as a separate Message (not dropped)

#### Scenario: Malformed JSON lines are skipped
- **GIVEN** a JSONL session file with one invalid line and two valid entries
- **WHEN** the API returns messages
- **THEN** the response contains the 2 valid messages and the API returns 200 (no error)

#### Scenario: Unknown content type falls back gracefully
- **GIVEN** an assistant content item with `type: "futureType"`
- **WHEN** the API returns the message
- **THEN** the message's `parts` includes a `TextPart` with `text: "?"` (no throw)

### Requirement: Thinking Block is Collapsible

The webui SHALL render `ThinkingPart` as a collapsible block, default closed, with the heading "💭 Thinking" and an expand button. When expanded, the full text is shown in monospace gray text.

#### Scenario: Thinking default closed
- **GIVEN** an assistant message with a ThinkingPart containing 200 characters
- **WHEN** the message bubble renders
- **THEN** the monospace `<pre>` is NOT in the DOM, and an "expand" button IS visible

#### Scenario: Click expand shows thinking text
- **GIVEN** a thinking block is rendered (default closed)
- **WHEN** the user clicks the expand button
- **THEN** the full thinking text appears in a monospace pre element

#### Scenario: Very long thinking stays performant
- **GIVEN** a ThinkingPart with 50KB of text
- **WHEN** the thinking is collapsed (default)
- **THEN** the text is not in the DOM (only the header is)
- **WHEN** the user expands it
- **THEN** the full text appears in a scrollable element with `max-height`

### Requirement: Tool Call Card

The webui SHALL render `ToolCallPart` as a card showing the tool name and a summary of arguments. The full arguments object SHALL be in a collapsible `<details>` element.

#### Scenario: ToolCallCard shows name and arg summary
- **GIVEN** a ToolCallPart with `name: "read"` and `args: { path: "/home/foo" }`
- **WHEN** rendered
- **THEN** the card header shows `🔧 read` and a one-line summary `path: /home/foo`

#### Scenario: Full args hidden behind details
- **GIVEN** a ToolCallCard
- **WHEN** the user opens the details/summary element
- **THEN** the full args JSON is visible

### Requirement: Tool Result Block with Size Limit

The webui SHALL render `ToolResultPart` as a block with content area of `max-height: 24rem (384px)` and `overflow: auto`. If the content exceeds 5KB, the block SHALL show only the first 5KB plus a "Show full output (N KB)" button to expand.

#### Scenario: Short tool result shows fully
- **GIVEN** a toolResult with 1KB content
- **WHEN** rendered
- **THEN** the full content is visible without truncation; no "Show full" button

#### Scenario: Long tool result truncates
- **GIVEN** a toolResult with 10KB content
- **WHEN** rendered
- **THEN** the first 5KB are visible; a "Show full output (10.0 KB)" button is present

#### Scenario: Show full expands content
- **GIVEN** a truncated tool result is rendered
- **WHEN** the user clicks "Show full output"
- **THEN** the full 10KB content is shown; the button label changes to "Show less"

### Requirement: Image Block Inline Renders

The webui SHALL render `ImagePart` as an inline `<img>` element using a `data:` URL with the `mediaType` and `data` fields, with `max-height: 24rem` to prevent a single image from filling the screen.

#### Scenario: Image renders inline
- **GIVEN** a toolResult with content `[{type:"image", mediaType:"image/png", data:"<base64>"}]`
- **WHEN** rendered
- **THEN** an `<img src="data:image/png;base64,..." alt="image" max-h-96>` element is in the DOM

#### Scenario: Multiple images lay out horizontally
- **GIVEN** a toolResult message with 3 images
- **WHEN** rendered
- **THEN** the images are in a horizontal flex container (flex-wrap), each with `max-h-96`

#### Scenario: Very large image is constrained
- **GIVEN** a 5MB PNG image
- **WHEN** rendered
- **THEN** the image is displayed at max-h-96 height, scaled to fit; the page is not broken

### Requirement: One Bubble Per Turn

The webui SHALL group an assistant's text + thinking + tool calls + tool results into a single MessageBubble. The render order SHALL follow the JSONL time order (which equals the `parts` array order).

#### Scenario: Assistant turn with multiple parts is one bubble
- **GIVEN** an assistant turn containing thinking + 2 tool calls + 2 tool results + final text
- **WHEN** the chat is rendered
- **THEN** there is exactly one "Assistant" bubble for this turn
- **AND** the bubble shows: ThinkingBlock → ToolCallCard A → ToolResult A → ToolCallCard B → ToolResult B → final text

#### Scenario: Empty assistant turn still renders
- **GIVEN** an assistant message with only thinking + toolCall, no text
- **WHEN** rendered
- **THEN** the assistant bubble shows the thinking block and tool cards, NOT an empty bubble

## MODIFIED Requirements

### Requirement: SessionMessageType

The session message endpoint's response shape is changed from `{role, content: string}` to `{role, parts: Part[]}`. The `role` field is expanded to include `"toolResult"`. The `content: string` field is removed.

#### Scenario: API response uses parts not content
- **GIVEN** any session with messages
- **WHEN** client calls `/api/sessions/:id/messages`
- **THEN** each message has `parts: Part[]` (NOT `content: string`)

#### Scenario: Live streaming constructs parts
- **GIVEN** a user sends a prompt and the agent starts streaming
- **WHEN** the WebSocket sends a `message_end` event with `event.message.content` array
- **THEN** the chat page constructs `parts` from the content array (mapping text/thinking/toolCall/image → Part) and appends the Message with `parts` field, NOT `content`
