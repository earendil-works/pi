# chat-message-rendering Specification

## ADDED Requirements

### Requirement: Step Wrapper Trigger

The webui MessageParts component SHALL wrap the assistant turn's **inference** content (thinking + toolCall + toolResult + image) in a collapsible step container when the `parts: Part[]` array contains any of: `thinking`, `toolCall`, `toolResult`, or `image`. **All `text` parts SHALL render OUTSIDE the step container as sibling elements, always visible regardless of step fold state.** When the parts contain only `text` blocks, the assistant turn SHALL render without a step wrapper (preserving the existing inline rendering). When `parts` is empty, the existing `(empty turn)` placeholder SHALL render.

#### Scenario: 纯 text turn 不裹 step
- **GIVEN** an assistant message with `parts: [{ type: "text", text: "hello" }]`
- **WHEN** the MessageParts component renders
- **THEN** no step header is in the DOM, and the text is rendered as a TextItem (markdown) directly

#### Scenario: 含 thinking + tool + final response 时: fold 包 inference,text 在 fold 外
- **GIVEN** an assistant message with `parts: [thinking, toolCall, toolResult, text]`
- **WHEN** the MessageParts component renders
- **THEN** a step header button appears in the DOM; the fold body contains the inference parts (ThinkingItem, ToolGroup) in original order; the final text TextItem renders OUTSIDE the step container as a sibling element, after the fold

#### Scenario: 纯 thinking turn 也包 step
- **GIVEN** an assistant message with `parts: [{ type: "thinking", text: "..." }]` only
- **WHEN** the MessageParts component renders
- **THEN** a step header is rendered; the step body contains a single ThinkingItem (which itself is collapsible). No text parts exist, so no sibling text elements appear

#### Scenario: 纯 tool turn 也包 step
- **GIVEN** an assistant message with `parts: [toolCall, toolResult]` only (no thinking, no final text)
- **WHEN** the MessageParts component renders
- **THEN** a step header is rendered; the step body contains a single ToolGroup with the tool call and result. No text parts exist, so no sibling text elements appear

#### Scenario: 空 parts 显示占位符
- **GIVEN** an assistant message with `parts: []`
- **WHEN** the MessageParts component renders
- **THEN** the literal text `(empty turn)` is rendered, no step header

#### Scenario: 多个 text block 中间夹 tool: inference 在 fold,text 在 fold 外
- **GIVEN** an assistant message with `parts: [thinking, text("interim"), toolCall, toolResult, text("final")]`
- **WHEN** the MessageParts component renders
- **THEN** a single fold wraps only the inference parts (thinking + ToolGroup); both `text("interim")` and `text("final")` render OUTSIDE the fold as sibling TextItem elements after the fold. The interim text is NOT inside the step body — both text parts are grouped together below the fold in original chronological order

### Requirement: Text Parts Outside Fold Wrapper

All `text` parts in an assistant message SHALL render OUTSIDE the step wrapper as sibling elements, regardless of fold state. The text SHALL be visible both when the fold is expanded (during streaming) and when the fold is collapsed (after streaming ends). This is the primary user-visible guarantee: the agent's reply text is never hidden inside a collapsed step.

#### Scenario: 推理过程展开时,text 在 fold 外可见
- **GIVEN** a turn with `parts=[thinking, toolCall, toolResult, text("final")]`, `isStreaming=true`
- **WHEN** MessageParts renders
- **THEN** the fold is open; the text "final" is visible in a TextItem that lives OUTSIDE the fold element (sibling, not descendant)

#### Scenario: 推理过程自动折叠后,text 仍可见 (核心 spec)
- **GIVEN** a turn with `parts=[thinking, toolCall, toolResult, text("final")]`, fold expanded, text visible
- **WHEN** `isStreaming` becomes `false`, fold auto-collapses
- **THEN** the fold body becomes hidden (ThinkingItem and ToolGroup removed from DOM); the text "final" remains visible in its sibling position below the fold. The user does not need to click the step header to see the agent's reply

#### Scenario: 纯 text turn 无 fold, text 直接渲染
- **GIVEN** a turn with `parts=[text("hello")]` only
- **WHEN** MessageParts renders
- **THEN** no step header is in the DOM and the text is rendered directly without any step wrapper. This is the same as the pre-existing pure-text rendering path

### Requirement: Step Header Status + Duration

The step header SHALL display a status icon (`●` for executing, `✓` for completed), a status word (`Executing` or `Completed`), a duration in seconds, and a chevron. The duration SHALL be computed as `Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)`. When the message `timestamp` is missing, the duration SHALL fall back to `Date.now()` (treating elapsed time as 0).

#### Scenario: Streaming 时 header 显示 executing + 倒计时
- **GIVEN** a step with `isStreaming=true` and `timestamp=2026-06-24T15:00:00.000Z`, current time 2026-06-24T15:00:12.000Z
- **WHEN** the step header renders
- **THEN** the header shows `● Executing (12s) ▼` (blue icon, down chevron)

#### Scenario: Done 后 header 变 completed + 不动 chevron
- **GIVEN** the same step after `isStreaming` becomes `false`
- **WHEN** the step header re-renders
- **THEN** the header shows `✓ Completed (Xs) ▲` (green icon, up chevron) where Xs reflects the time elapsed since the timestamp (continues to grow as `Date.now()` advances)

#### Scenario: 旧 turn (1h 前) 显示当前 elapsed 时间
- **GIVEN** a step with `timestamp=2026-06-24T14:00:00.000Z`, current time 2026-06-24T15:00:00.000Z, `isStreaming=false`
- **WHEN** the step header renders
- **THEN** the header shows `✓ Completed (3600s) ▲`. This is the elapsed-since-timestamp approximation, not the actual turn duration

#### Scenario: Aborted turn 也显示 step header
- **GIVEN** a step whose underlying message was aborted mid-flight
- **WHEN** the step header renders
- **THEN** a step header is visible (status reflects current `isStreaming` value at render time). The exact aborted icon (`⚠`) is out of scope for this change

### Requirement: Step Body Collapsible

The step body (the fold contents — inference parts) SHALL be visible (expanded) by default when `isStreaming=true` and hidden (collapsed) by default when `isStreaming=false`. The user SHALL be able to click the step header to toggle the body visibility. Once the user has clicked, the user's choice SHALL persist for the lifetime of that step instance; subsequent changes to `isStreaming` SHALL NOT override the user's choice. **Text parts are not part of the step body and are unaffected by fold state — they remain visible whether the fold is open or closed.**

#### Scenario: Streaming 时 body 默认展开
- **GIVEN** a step with `isStreaming=true`
- **WHEN** the step renders
- **THEN** the step body is visible (inference parts rendered). Text parts are also visible (they live outside the fold)

#### Scenario: Done 后 body 自动折叠,text 仍可见
- **GIVEN** a step where `isStreaming` was `true` and the body was visible
- **WHEN** `isStreaming` becomes `false`
- **THEN** the body auto-collapses (inference parts removed from the DOM); the header remains visible. **Text parts (rendered outside the fold) remain visible regardless of fold state**

#### Scenario: 用户点击 header 切换
- **GIVEN** a step with `isStreaming=false`, body collapsed
- **WHEN** the user clicks the step header button
- **THEN** the body becomes visible; clicking again hides it. Text parts are unaffected by the click and remain visible

#### Scenario: 用户点击后 isStreaming 变化不覆盖
- **GIVEN** a step where the user clicked to expand the body (user override = expand), and `isStreaming` then changes from `false` to `true`
- **WHEN** the step re-renders
- **THEN** the body remains visible (user override wins). When `isStreaming` changes back to `false`, the body remains visible (override still wins)

#### Scenario: 极长 turn 内部 ToolGroup 仍按 >4 tool 折叠
- **GIVEN** a step containing 100 tool calls
- **WHEN** the step body renders (either initially expanded or user-expanded)
- **THEN** the inner ToolGroup still applies its existing `>4` collapse-to-summary rule; the step wrapper does not interfere

#### Scenario: 推理中或完成后有 active card 时 step 强制展开
- **GIVEN** a step with `parts=[{type:"toolCall", id:"tc1", name:"ask_user_question", ...}]` and `cardStates.get("tc1")` exists (active card state for this tool call)
- **WHEN** the step renders (regardless of `isStreaming` value)
- **THEN** the step body is visible (force-opened) so the active card is always shown to the user. User's `userOverride` (if set) is ignored while a card is active. Once the card is removed from `cardStates` (user responds / `tool_execution_end` arrives), normal `userOverride ?? isStreaming` logic resumes

### Requirement: Streaming State Propagation

The webui ChatPage component SHALL compute `isLastMessageStreaming = isThinking && lastMessage?.role === "assistant"` and pass it as the `isStreaming` prop to the last message's `MessageBubble` (and recursively to `MessageParts`). When `isThinking` is `false`, all messages SHALL be rendered with `isStreaming=false`. Older messages in the same list SHALL always be rendered with `isStreaming=false` even if `isThinking` is `true`.

#### Scenario: 推理中最后一条 message 显示 streaming
- **GIVEN** `isThinking=true`, `messages=[..., {role:"assistant", parts:[...], timestamp:"..."}]` (last message is assistant)
- **WHEN** ChatPage renders
- **THEN** the last message's MessageBubble receives `isStreaming=true`; the step header shows `● Executing`

#### Scenario: 旧 message 在 active turn 中不显示 streaming
- **GIVEN** `isThinking=true`, `messages=[user, assistant, user, assistant(newer)]`
- **WHEN** ChatPage renders
- **THEN** only the LAST assistant message's MessageBubble receives `isStreaming=true`; the older assistant message receives `isStreaming=false`

#### Scenario: turn 还没持久化时 step header 还没出现
- **GIVEN** `isThinking=true`, the agent has not yet emitted the final `done` event
- **WHEN** ChatPage renders
- **THEN** the new assistant message is NOT in the `messages` array; no step header is rendered for it; the `ThinkingIndicator` component is rendered at the bottom of the chat

#### Scenario: 推理完成到下次 poll 之间
- **GIVEN** the agent just emitted `done`, `isThinking` flipped to `false`, but the next poll has not yet fetched the new message
- **WHEN** ChatPage renders with the stale messages list
- **THEN** the previous (older) messages still render with their existing state; the new message is not yet in the list. Within a few hundred ms the poll completes and the new message appears with `isStreaming=false` (done)
