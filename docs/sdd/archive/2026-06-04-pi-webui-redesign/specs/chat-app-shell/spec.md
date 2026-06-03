# chat-app-shell Specification

## ADDED Requirements

### Requirement: Application Shell Two-Column Layout

The webui SHALL render a fixed two-column layout: a 260px sidebar on the left and a flexible main region on the right, with the main region containing a sticky topbar and the active route's content.

The sidebar SHALL contain five sub-components stacked vertically with no gap: `Brand` at top, `IconRow` below it, `SearchBox` below the icon row, `ConversationList` filling the remaining height, and `NewChatButton` pinned at the bottom.

The main region SHALL use `flex-1 overflow-auto` and SHALL host the chat page (Topbar + ChatMessages + InputArea) or other route content (Cron / Atoms).

#### Scenario: Initial page load shows sidebar
- **GIVEN** the user opens `http://127.0.0.1:8741/`
- **WHEN** the page finishes loading
- **THEN** a 260px-wide sidebar is visible on the left containing Brand / IconRow / SearchBox / ConversationList / NewChatButton
- **AND** the main region occupies the remaining width

#### Scenario: Brand component renders three pieces
- **GIVEN** the webui version is `0.34.3`
- **WHEN** the sidebar renders
- **THEN** the Brand area shows a blue "π" (24px), the text "pi webui" (16px semibold), and "v0.34.3" (10px gray) in a single horizontal row

#### Scenario: IconRow has 5 nav icons
- **GIVEN** the sidebar renders
- **WHEN** the IconRow mounts
- **THEN** it displays five lucide icons vertically: MessageSquare, Clock, Brain, Folder, User
- **AND** the MessageSquare icon has the active (blue) highlight by default
- **AND** clicking Clock navigates to `/cron`

### Requirement: Sidebar Search Filters Conversations

The SearchBox in the sidebar SHALL filter the ConversationList in real-time, case-insensitive, by substring match on each session's `title` field. An empty query SHALL display all sessions.

#### Scenario: Typing in search filters list
- **GIVEN** the ConversationList shows 17 sessions with titles including "deploy", "cron", "memory"
- **WHEN** the user types "deploy" in the SearchBox
- **THEN** the list filters to only sessions whose title contains "deploy" (case-insensitive)
- **AND** clearing the SearchBox restores all 17 sessions

#### Scenario: No match shows placeholder
- **GIVEN** the SearchBox has value "xyz123"
- **WHEN** the ConversationList renders
- **THEN** no session rows are shown
- **AND** the placeholder text "No conversations match" is displayed in gray

### Requirement: New Conversation via pi --new-session

Clicking the NewChatButton SHALL create a new session by calling `POST /api/sessions` on the server. The server SHALL attempt to spawn `pi --mode rpc --new-session --cwd <cwd>` and wait up to 5 seconds for a `session_created` RPC event. If the spawn fails or times out, the server SHALL fall back to a randomUUID-based empty session.

After the new session id is returned, the browser SHALL navigate to `/session/<id>`.

#### Scenario: Successful new conversation
- **GIVEN** the user is on `/` (no active session)
- **WHEN** the user clicks "+ New conversation"
- **THEN** the browser POSTs to `/api/sessions`
- **AND** the server returns `{id, sessionFile}` from the pi --new-session spawn
- **AND** the browser navigates to `/session/<id>`

#### Scenario: pi --new-session fallback
- **GIVEN** `pi` binary is missing or the spawn times out after 5 seconds
- **WHEN** the user clicks "+ New conversation"
- **THEN** the server logs a warning "pi --new-session failed, fallback to UUID"
- **AND** the server returns a session id from `randomUUID()` with an empty header JSONL
- **AND** the browser still navigates to `/session/<id>`

### Requirement: Conversation List Item

Each session row in the ConversationList SHALL display a `MessageSquare` icon, a truncated title (max 30 chars with "…" suffix), and on hover a Trash icon. Clicking the row calls `onSelect(id)`. Clicking the Trash icon prompts `window.confirm`; on confirm, calls `onDelete(id)`.

#### Scenario: Hover reveals Trash
- **GIVEN** the sidebar shows session rows
- **WHEN** the user hovers over a row
- **THEN** the Trash icon becomes visible (opacity-100) on the right side of the row

#### Scenario: Delete with confirm
- **GIVEN** the user hovers session A and clicks the Trash icon
- **WHEN** the confirm dialog appears
- **AND** the user clicks "OK"
- **THEN** the row is optimistically removed from the list
- **AND** the browser DELETEs `/api/sessions/<A-id>` and navigates to `/`

#### Scenario: Delete cancelled
- **GIVEN** the user clicks the Trash icon
- **WHEN** the user clicks "Cancel" in the confirm dialog
- **THEN** the row remains in the list and no API call is made

#### Scenario: Long title truncation
- **GIVEN** session title is 200 characters
- **WHEN** the row renders
- **THEN** the displayed title is truncated to 30 characters followed by "…"

#### Scenario: Empty title placeholder
- **GIVEN** session title is empty string
- **WHEN** the row renders
- **THEN** the displayed text is "New Chat" (placeholder)

### Requirement: Sticky Topbar in Main Region

The Topbar in the main region SHALL be sticky at the top (`sticky top-0 z-10`) and contain a Title (left), a ModelSelector (right), and an Actions component (right) with a Clear button and a Settings cog.

#### Scenario: Topbar stays visible while scrolling
- **GIVEN** the user is viewing a long session
- **WHEN** the user scrolls the main region
- **THEN** the Topbar remains at the top of the visible area (sticky positioning)

### Requirement: Switch Session Clears Drafts

Switching from session A to session B SHALL clear the input text and any pending input images, with no persistence. Re-selecting A SHALL show A with an empty input area.

#### Scenario: Switch clears input
- **GIVEN** the user is on session A with input "hello" and 1 image in preview
- **WHEN** the user navigates to `/session/B-id`
- **THEN** session B's main region loads with empty input text and no image previews
- **AND** returning to session A also shows an empty input area (no draft persistence)

## MODIFIED Requirements

### Requirement: Webui Layout Two-Column

The webui root layout SHALL be a 2-column flex container (sidebar 260px + main flex-1) provided by `AppShell.tsx`, replacing the prior `App.tsx` `Layout()` function which used a 200px sidebar.

#### Scenario: Sidebar width is 260px
- **GIVEN** the webui renders
- **WHEN** the user inspects the sidebar
- **THEN** the sidebar's width is 260px (was 200px in the prior layout)

#### Scenario: Cron route uses left IconRow
- **GIVEN** the user clicks the Clock icon in IconRow
- **WHEN** the route changes to `/cron`
- **THEN** the CronPage renders in the main region (NOT in a top-tab position)
- **AND** the prior top-tab navigation for Cron is removed
