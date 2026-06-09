# ask-user-question-card Specification

## ADDED Requirements

### Requirement: Webui Inline Card Rendering
Webui client SHALL render an inline card inside the assistant message bubble when an `ask_user_question` toolCall part is present, instead of a full-screen modal.

#### Scenario: Card appears inline in assistant message
- **GIVEN** model emits a toolCall part with name `ask_user_question`
- **WHEN** ChatPage receives the corresponding `extension_ui_request` event via ws
- **THEN** an `<AskUserQuestionCard>` is rendered inside the assistant message bubble, after the toolCall and before the toolResult

### Requirement: Single-Select Click Submits Immediately
Single-select card SHALL submit the chosen option on click, without requiring a separate Submit button.

#### Scenario: Click option sends ws message
- **GIVEN** card is in active state with 4 options, multiSelect=false
- **WHEN** user clicks option "红色"
- **THEN** `ws.send({type:"extension_ui_response", id, value:"红色"})` is called
- **AND** card transitions to disabled state with selected="红色"

### Requirement: Multi-Select Numbered Input
Multi-select card SHALL display numbered options and accept comma-separated numbers in an inline input box.

#### Scenario: Type numbers and submit
- **GIVEN** card is in active state with 3 options, multiSelect=true
- **WHEN** user types "1,3" in the card's input box and clicks Submit
- **THEN** `ws.send({type:"extension_ui_response", id, value:"label1, label2"})` is called
- **AND** card transitions to disabled state

### Requirement: Disabled Card Retains State
After user selection or timeout, the card SHALL remain in the message bubble with grayed options and a result text line.

#### Scenario: Disabled card shows selection
- **GIVEN** card is in disabled state with selected="红色"
- **WHEN** message is rendered
- **THEN** all options are grayed and non-interactive
- **AND** a text line "你的选择: 红色" appears above the options

#### Scenario: Timeout card shows timeout text
- **GIVEN** card is in timeout state
- **WHEN** message is rendered
- **THEN** all options are grayed and non-interactive
- **AND** a text line "已超时" appears above the options

### Requirement: Card Appears in Session History
Previous ask_user_question interactions SHALL be visible when re-entering a session, through the toolResult part's content text.

#### Scenario: Re-entering session shows past selection
- **GIVEN** a prior session where user selected "红色" via ask_user_question card
- **WHEN** user re-enters the session (API returns past messages)
- **THEN** the toolResult part shows "User selected: 红色"
- **AND** the card is NOT re-rendered in active state (no extension_ui_request event for past interactions)

### Requirement: Card Flows Inline with Messages
The card SHALL NOT be fixed-positioned or z-index overlay. It follows the normal document flow inside the message bubble.

#### Scenario: Card scrolls with messages
- **GIVEN** long conversation with a card in the middle
- **WHEN** user scrolls the chat
- **THEN** the card scrolls with its parent message, not fixed on screen

## MODIFIED Requirements

### Requirement: ChatPage Pending Placeholder Removal
ChatPage's `pendingQuestions` state and `AskUserQuestionPending` strip SHALL be removed. Pending ask_user_question state is tracked via `cardStates` Map and rendered inline via `AskUserQuestionCard`.

#### Scenario: No pending strip visible
- **GIVEN** `extension_ui_request` event arrives
- **WHEN** ChatPage renders
- **THEN** no `AskUserQuestionPending` strip appears
- **AND** the card renders inside the assistant message bubble instead

### Requirement: AppShell Provider Removal
AppShell SHALL no longer wrap children in `AskUserQuestionProvider`. Card state management is handled by ChatPage directly.

#### Scenario: AppShell renders without Provider
- **GIVEN** AppShell is mounted
- **WHEN** children are rendered
- **THEN** no `<AskUserQuestionProvider>` wrapper exists in the DOM
- **AND** sidebar + main layout remains unchanged

## REMOVED Requirements

### Requirement: AskUserQuestionModal Full-Screen Overlay
- **Reason**: 交互模式从全屏 modal 改为 inline 卡片,不再需要 fixed z-50 overlay
- **Migration**: 删除 `AskUserQuestionModal.tsx` + `AskUserQuestionProvider.tsx` + `AskUserQuestionPending.tsx`。新组件 `AskUserQuestionCard.tsx` 接手。

### Requirement: AskUserQuestionProvider Modal Queue
- **Reason**: 不再是 per-session queue(卡片嵌入消息流,同一消息内只出现一次)
- **Migration**: 卡片渲染由 `MessageParts` layer 接管,状态管理由 `ChatPage.cardStates` Map 接管
