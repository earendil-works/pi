# webui Specification

## ADDED Requirements

### Requirement: Web Server Startup
The `pi` CLI SHALL accept a `--web` flag that spawns a Web Server process and prints the URL to the terminal.

#### Scenario: Default port startup
- **GIVEN** user runs `pi --web` in a terminal with no prior process on port 8741
- **WHEN** pi CLI parses `--web` and spawns the Web Server child process
- **THEN** terminal prints `WebUI running at http://127.0.0.1:8741` and the Web Server binds to loopback only

#### Scenario: Custom port via --port
- **GIVEN** user runs `pi --web --port 9000`
- **WHEN** the Web Server starts
- **THEN** the server binds to 127.0.0.1:9000 and terminal prints `http://127.0.0.1:9000`

#### Scenario: Port already in use
- **GIVEN** port 8741 is already bound by another process
- **WHEN** the Web Server attempts to bind
- **THEN** terminal prints `Error: port 8741 in use, try --port <other>` and the process exits with non-zero code

#### Scenario: Graceful shutdown on SIGTERM
- **GIVEN** the Web Server is running with 3 active pi child processes
- **WHEN** user sends SIGTERM (Ctrl-C)
- **THEN** Web Server sends SIGTERM to all pi children, waits up to 5 seconds, then SIGKILL any remaining; exits with code 0

### Requirement: Web Server REST API
The Web Server SHALL expose a REST API at `/api/*` for session list, cron management, and message history.

#### Scenario: List sessions
- **GIVEN** the Web Server has scanned `~/.pi/agent/sessions/--<cwd>--/` and found 3 sessions
- **WHEN** client sends `GET /api/sessions`
- **THEN** response is 200 with JSON array `[{id, title, status, lastActive, messageCount}, ...]`

#### Scenario: List cron jobs
- **GIVEN** `~/.pi/agent/data/cron.json` contains 2 jobs
- **WHEN** client sends `GET /api/cron/jobs`
- **THEN** response is 200 with JSON array of 2 jobs (each with id, name, schedule, prompt, enabled, last_run, created_at)

#### Scenario: Create cron job
- **GIVEN** client sends `POST /api/cron/jobs` with body `{name, schedule, prompt, enabled}` (no id, no created_at)
- **WHEN** the Web Server validates and writes to cron.json
- **THEN** response is 200 with the full job object including server-generated `id` and `created_at`; the file is updated atomically

#### Scenario: Trigger cron job now
- **GIVEN** a cron job with id "abc" exists in cron.json
- **WHEN** client sends `POST /api/cron/jobs/abc/trigger`
- **THEN** the job's `last_run` is set to `null` in cron.json; response is 200 with the updated job; the next session_start event will treat the job as overdue

#### Scenario: Delete session
- **GIVEN** session "X" exists at `~/.pi/agent/sessions/--<cwd>--/<ts>_X.jsonl` with 50 messages
- **WHEN** client sends `DELETE /api/sessions/X`
- **THEN** the Web Server reads the session JSONL, extracts memory atoms via LLM, writes atoms to `~/.pi/agent/data/memory.db`, and then deletes the JSONL file; response is 200 with `{ok: true, atomsExtracted: <count>}`

### Requirement: Web Server WebSocket Bridge
The Web Server SHALL expose a WebSocket endpoint at `/ws` that proxies pi process JSON-line events to connected browser clients in real-time.

#### Scenario: Subscribe to session events
- **GIVEN** a browser tab is connected via WebSocket
- **WHEN** the client sends `{type: "subscribe", sessionId: "X"}` and the Web Server has pi process "X" running
- **THEN** the Web Server adds the client to the subscriber set for session "X"; all subsequent pi stdout events for "X" are forwarded as `{type: "session_event", sessionId: "X", event: {...}}` to the client

#### Scenario: Send prompt via WebSocket
- **GIVEN** client is subscribed to session "X" and the session is idle
- **WHEN** client sends `{type: "prompt", text: "explain the project"}` over WebSocket
- **THEN** the Web Server writes the corresponding RPC message to pi process "X" stdin; subsequent streaming events are broadcast to the client

#### Scenario: WebSocket disconnect cleanup
- **GIVEN** client A is subscribed to session "X" and pi process "X" has 0 other subscribers
- **WHEN** client A disconnects (close or network error)
- **THEN** the Web Server removes A from the subscriber set; pi process "X" is NOT terminated (other future subscribers can rejoin)

### Requirement: Cron Tool 5-Action API
The `cron_write` tool in `extensions/personal-assistant/cron.ts` SHALL support 5 actions: `add`, `list`, `remove`, `toggle`, `trigger_now`. Existing 4-action usage SHALL remain backward-compatible.

#### Scenario: Add new job (existing 4-action)
- **GIVEN** an LLM agent calls `cron_write` with `operations: [{action: "add", name, schedule, prompt}]`
- **WHEN** the tool executes
- **THEN** the job is appended to `~/.pi/agent/data/cron.json`; tool returns `OK: Added job: <name>`; subsequent `isOverdue` checks on session_start fire when the schedule matches

#### Scenario: Trigger now (new 5-action)
- **GIVEN** a job with id "abc" exists in cron.json with `last_run: "2025-01-01T00:00:00Z"`
- **WHEN** agent calls `cron_write` with `operations: [{action: "trigger_now", id: "abc"}]`
- **THEN** the job's `last_run` is set to `null` in cron.json; the next `session_start` event treats the job as overdue (since `last_run` is null, all schedule kinds — at/every/cron — become immediately due when schedule matches)

#### Scenario: Backward compatibility
- **GIVEN** existing TUI scripts or agents call `cron_write` with only 4 actions
- **WHEN** the tool executes
- **THEN** all existing 4-action calls behave identically to before; only the new `trigger_now` action is added to the union type

### Requirement: Cron Dashboard View
The WebUI SHALL provide a Cron Dashboard as a first-class route at `/cron` that displays all cron jobs as a virtualized list with per-row actions.

#### Scenario: Open Cron Dashboard
- **GIVEN** WebUI is loaded in browser
- **WHEN** user clicks "Cron" in the left sidebar (or navigates to `/cron`)
- **THEN** the main panel renders the Cron Dashboard: title "Cron Jobs", a "+ New Cron" button, and a list of jobs (or empty state "No scheduled tasks yet" if zero jobs)

#### Scenario: Create job via Dashboard
- **GIVEN** user is on the Cron Dashboard
- **WHEN** user clicks "+ New Cron", fills the modal form (name, prompt, schedule, enabled), and clicks "Create"
- **THEN** the form is validated; `POST /api/cron/jobs` is called; the modal closes; the new job appears in the list with a humanized schedule string (e.g., "every Friday at 17:00")

#### Scenario: Trigger job from Dashboard
- **GIVEN** a job "morning-email" is enabled in the list
- **WHEN** user clicks the ⚡ Trigger Now button on that row
- **THEN** `POST /api/cron/jobs/morning-email/trigger` is called; a toast appears "Triggered: morning-email (will run on next session start)"; the job's `last_run` in the underlying file is set to `null`

#### Scenario: Expand last-run details
- **GIVEN** a job has `last_run: "2025-01-01T09:00:00Z"` and `last_run_status: "ok"` in `cron.json`
- **WHEN** user clicks the row to expand
- **THEN** an inline panel below the row shows: "Last run: 2025-01-01 09:00:00" with a green ✓ icon (ok) or red ✗ (error), and "Next scheduled: <computed from schedule>"; no separate history file is read; data comes from the same `cron.json`

### Requirement: Cross-Process Cron Sync
The Web Server SHALL detect changes to `cron.json` made by other processes (TUI, extension) and broadcast updates to all connected WebSocket clients.

#### Scenario: TUI adds job, WebUI updates
- **GIVEN** WebUI Cron Dashboard is open and connected via WebSocket
- **WHEN** user in another terminal runs `pi -p "use cron_write to add a job"` and the agent successfully adds a job
- **THEN** the chokidar watcher detects `cron.json` change within 200ms; WebUI receives `{type: "cron_changed"}` event; Cron Dashboard re-fetches and displays the new job

### Requirement: Session Deletion Memory Extraction
When a session is deleted via the WebUI, the Web Server SHALL extract memory atoms from the session content via LLM and write them to the existing `memory.db` before deleting the session file.

#### Scenario: Successful extraction
- **GIVEN** session "X" has 100 messages
- **WHEN** user clicks "Delete" on session "X" in WebUI and confirms
- **THEN** Web Server reads session JSONL, calls LLM with extraction prompt (using current default model from `~/.pi/agent/models.json`); LLM returns N atoms; atoms are written to `~/.pi/agent/data/memory.db` (in `memory_index` and `memory_fts` tables using existing schema); the JSONL file is deleted; response shows `atomsExtracted: N`

#### Scenario: Extraction failure is non-blocking
- **GIVEN** session "X" exists
- **WHEN** user deletes it but LLM API returns 5xx twice
- **THEN** Web Server logs the error, displays a toast "Session deleted, memory extraction skipped due to LLM error", and proceeds to delete the JSONL; `memory.db` is NOT modified

#### Scenario: Extraction timeout
- **GIVEN** LLM API is slow (>5s)
- **WHEN** Web Server times out on the extraction call
- **THEN** Web Server retries once (2s interval), if still fails, proceeds as in failure scenario

### Requirement: Session Switching Independence
Switching between sessions in the WebUI SHALL NOT interrupt or pause other active sessions.

#### Scenario: Two sessions running, switch
- **GIVEN** session-A is running (pi process streaming) and session-B is in the list
- **WHEN** user clicks session-B in the list
- **THEN** the chat panel shows session-B's content; session-A's pi process continues to stream in the background; user can switch back to session-A later and see the updated state

### Requirement: Loopback-Only Binding
The Web Server SHALL bind to `127.0.0.1` only and SHALL NOT accept connections from non-loopback addresses.

#### Scenario: External connection rejected
- **GIVEN** Web Server is running on 127.0.0.1:8741
- **WHEN** client attempts to connect from a non-loopback IP (e.g., LAN address 192.168.x.x)
- **THEN** the connection is refused at the OS level (process never sees it)

### Requirement: pi Core Unchanged
The pi core packages (`packages/coding-agent/src/`, `packages/ai/`, `packages/agent/`) SHALL have minimal modifications — only the CLI argument parser and entry point SHALL change to support `--web`.

#### Scenario: Restricted file changes
- **GIVEN** the implementation is complete
- **WHEN** running `git diff packages/coding-agent/src/ packages/ai/ packages/agent/`
- **THEN** the diff shows changes only in `packages/coding-agent/src/cli/args.ts` and `packages/coding-agent/src/main.ts` (or 1 file if combined); no other pi core file is modified

## MODIFIED Requirements

None. All pi core capabilities (session-manager, extension API, RPC mode, agent loop) remain unchanged.

## REMOVED Requirements

None. No existing capability is removed.

## RENAMED Requirements

None.
