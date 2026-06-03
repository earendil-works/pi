# chat-topbar Specification

## ADDED Requirements

### Requirement: Topbar Title with Message Count

The Topbar SHALL display a title "Chat" (18px semibold) on the left and a subtitle showing the current session's message count in the format "N messages" (12px gray) directly below or beside the title.

#### Scenario: Title shows message count
- **GIVEN** the user is on session A which has 31 messages loaded
- **WHEN** the Topbar renders
- **THEN** it displays "Chat" followed by "31 messages"
- **AND** the count updates when new messages are received

#### Scenario: Empty session shows 0 messages
- **GIVEN** the user just created a new session with no messages
- **WHEN** the Topbar renders
- **THEN** the subtitle reads "0 messages"

### Requirement: Model Selector with Provider/Model Dropdown

The Topbar SHALL include a ModelSelector component that displays the current `{provider}/{model}` as a blue badge. Clicking the badge opens a dropdown listing all available providers and models. Selecting a model SHALL PATCH `/api/settings` with `webui.defaultModel`.

#### Scenario: Open dropdown
- **GIVEN** the Topbar shows the current model as `anthropic/claude-sonnet-4-6`
- **WHEN** the user clicks the badge
- **THEN** a dropdown appears listing all providers and their models
- **AND** the current selection is highlighted

#### Scenario: Select new model
- **GIVEN** the dropdown is open
- **WHEN** the user selects `openai/gpt-4o`
- **THEN** the browser PATCHes `/api/settings` with `{webui: {defaultModel: "openai/gpt-4o"}}`
- **AND** the badge updates to show `openai/gpt-4o`
- **AND** the current session's model is unchanged (setting only affects new sessions)

#### Scenario: Click outside closes dropdown
- **GIVEN** the dropdown is open
- **WHEN** the user clicks anywhere outside the dropdown
- **THEN** the dropdown closes

#### Scenario: Long model name truncated
- **GIVEN** the current model is `claude-3-7-sonnet-20250219-v1:0`
- **WHEN** the badge renders
- **THEN** the displayed text is truncated to 16 characters with "..." suffix (e.g. `claude-3-7-sonn...`)

### Requirement: Topbar Clear and Settings Actions

The Topbar SHALL include two action buttons on the right: a Clear button (text "Clear") and a Settings cog (⚙ icon). Clicking Clear SHALL prompt `window.confirm` and, on confirm, clear the local `messages` state. Clicking Settings SHALL be a no-op placeholder for this change.

#### Scenario: Clear messages with confirm
- **GIVEN** session A has 31 messages
- **WHEN** the user clicks the Clear button
- **AND** clicks "OK" in the confirm dialog
- **THEN** the local messages array becomes empty
- **AND** no API call is made (frontend-only)
- **AND** refreshing the page restores the messages (they still exist in the JSONL)

#### Scenario: Settings is placeholder
- **GIVEN** the user clicks the ⚙ icon
- **WHEN** the click is processed
- **THEN** no action occurs (placeholder for future settings panel)
