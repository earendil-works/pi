# Changelog

## [Unreleased]

## [0.64.0] - 2026-03-29

## [0.63.2] - 2026-03-29

## [0.63.1] - 2026-03-27

### Fixed

- Fixed Mom compaction status handling to follow the unified `compaction_start` and `compaction_end` session events, keeping compaction notifications working after the event rename ([#2617](https://github.com/badlogic/pi-mono/issues/2617))

## [0.63.0] - 2026-03-27

## [0.62.0] - 2026-03-23

## [0.61.1] - 2026-03-20

## [0.61.0] - 2026-03-20

## [0.60.0] - 2026-03-18

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

### Fixed

- Fixed mom startup crash caused by settings API drift by using `SettingsManager` with workspace-backed storage ([#1444](https://github.com/badlogic/pi-mono/issues/1444))

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

### Fixed

- Use coding-agent's SessionManager instead of custom MomSessionManager to fix API mismatch crash ([#595](https://github.com/badlogic/pi-mono/issues/595))

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- `AgentTool` import moved from `@mariozechner/pi-ai` to `@mariozechner/pi-agent-core`
- `AppMessage` type renamed to `AgentMessage`
- `Attachment` type replaced with `ImageContent` for image handling
- `MomSessionManager.loadSession()` renamed to `buildSessionContex()`
- `MomSessionManager.createBranchedSessionFromEntries()` signature changed to `createBranchedSession(leafId)`
- `ProviderTransport` removed from Agent config, replaced with direct `getApiKey` callback
- `messageTransformer` renamed to `convertToLlm`
- `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` no longer checked at startup (deferred to first API call)

### Changed

- Session entries now include `id` and `parentId` fields for tree structure support
- Auth lookup now uses `AuthStorage` class instead of direct environment variable access
- Image attachments use `ImageContent` type with `data` field instead of `Attachment` with `content`
- `session.prompt()` now uses `images` option instead of `attachments`

### Added

- Support for OAuth login via coding agent's `/login` command (link `~/.pi/agent/auth.json` to `~/.pi/mom/auth.json`)

## [0.20.2] - 2025-12-13

### Fixed

- **Skill paths now use container paths**: Skill file paths in system prompt are translated to container paths (e.g., `/workspace/skills/...`) so mom can read them from inside Docker.

## [0.20.1] - 2025-12-13

### Added

- **Skills auto-discovery**: Mom now automatically discovers skills from `workspace/skills/` and `channel/skills/` directories. Skills are directories containing a `SKILL.md` file with `name` and `description` in YAML frontmatter. Available skills are listed in the system prompt with their descriptions. Mom reads the `SKILL.md` file before using a skill.

## [0.19.2] - 2025-12-12

### Added

- Events system: schedule wake-ups via JSON files in `workspace/events/`
  - Immediate events: trigger when file is created (for webhooks, external signals)
  - One-shot events: trigger at specific time (for reminders)
  - Periodic events: trigger on cron schedule (for recurring tasks)
- `SlackBot.enqueueEvent()` for queueing events (max 5 per channel)
- `[SILENT]` response marker: deletes status message, posts nothing to Slack (for periodic events with nothing to report)
- Events documentation in `docs/events.md`
- System prompt section explaining events to mom

## [0.18.8] - 2025-12-12

### Changed

- Timestamp prefix now includes timezone offset (`[YYYY-MM-DD HH:MM:SS+HH:MM]`)

## [0.18.7] - 2025-12-12

### Added

- Timestamp prefix on user messages (`[YYYY-MM-DD HH:MM:SS]`) so mom knows current date/time

### Fixed

- Sync deduplication now strips timestamp prefix before comparing

## [0.18.6] - 2025-12-12

### Fixed

- Duplicate message in context when message has attachments (sync from log didn't strip attachment section before comparing)
- Use `<slack_attachments>` delimiter for attachments in messages (easier to parse/strip)

## [0.18.5] - 2025-12-12

### Added

- `--download <channel-id>` flag to download a channel's full history including thread replies as plain text

### Fixed

- Error handling: when agent returns `stopReason: "error"`, main message is updated to "Sorry, something went wrong" and error details are posted to the thread

## [0.18.4] - 2025-12-11

### Fixed

- Attachment downloads now work correctly
  - SlackBot now receives store for processing file downloads
  - Files are downloaded in background and stored in `<channel>/attachments/`
  - Attachment paths passed to agent as absolute paths in execution environment
  - Backfill also downloads attachments from historical messages

## [0.18.3] - 2025-12-11

### Changed

- Complete rewrite of message handling architecture (#115)
  - Now uses `AgentSession` from coding-agent for session management
  - Brings auto-compaction, overflow handling, and proper prompt caching
  - `log.jsonl` is the source of truth for all channel messages
  - `context.jsonl` stores LLM context (messages sent to Claude, same format as coding-agent)
  - Sync mechanism ensures context.jsonl stays in sync with log.jsonl at run start
  - Session header written immediately on new session creation (not lazily)
  - Tool results preserved in context.jsonl for multi-turn continuity

- Backfill improvements
  - Only backfills channels that already have a `log.jsonl` file
  - Strips @mentions from backfilled messages (consistent with live messages)
  - Uses largest timestamp in log for efficient incremental backfill
  - Fetches DM channels in addition to public/private channels

- Message handling improvements
  - Channel chatter (messages without @mention) logged but doesn't trigger processing
  - Messages sent while mom is busy are logged and synced on next run
  - Pre-startup messages (replayed by Slack on reconnect) logged but not auto-processed
  - Stop command executes immediately (not queued), can interrupt running tasks
  - Channel @mentions no longer double-logged (was firing both app_mention and message events)

- Usage summary now includes context window usage
  - Shows current context tokens vs model's context window
  - Example: `Context: 4.2k / 200k (2.1%)`

### Fixed

- Slack API errors (msg_too_long) no longer crash the process
  - Added try/catch error handling to all Slack API calls in the message queue
  - Main channel messages truncated at 35K with note to ask for elaboration
  - Thread messages truncated at 20K
  - replaceMessage also truncated at 35K

- Private channel messages not being logged
  - Added `message.groups` to required bot events in README
  - Added `groups:history` and `groups:read` to required scopes in README

- Stop command now updates "Stopping..." to "Stopped" instead of posting two messages

### Added

- Port truncation logic from coding-agent: bash and read tools now use consistent 2000 lines OR 50KB limits with actionable notices

## [0.10.2] - 2025-11-27

### Breaking Changes

- Timestamps now use Slack format (seconds.microseconds) and messages are sorted by `ts` field
  - **Migration required**: Run `npx tsx scripts/migrate-timestamps.ts ./data` to fix existing logs
  - Without migration, message context will be incorrectly ordered

### Added

- Channel and user ID mappings in system prompt
  - Fetches all channels bot is member of and all workspace users at startup
  - Mom can now reference channels by name and mention users properly
- Skills documentation in system prompt
  - Explains custom CLI tools pattern with SKILL.md files
  - Encourages mom to create reusable tools for recurring tasks
- Debug output: writes `last_prompt.txt` to channel directory with full context
- Bash working directory info in system prompt (/ for Docker, cwd for host)
- Token-efficient log queries that filter out tool calls/results for summaries

### Changed

- Turn-based message context instead of raw line count (#68)
  - Groups consecutive bot messages (tool calls/results) as single turn
  - "50 turns" now means ~50 conversation exchanges, not 50 log lines
  - Prevents tool-heavy runs from pushing out conversation context
- Messages sorted by Slack timestamp before building context
  - Fixes out-of-order issues from async attachment downloads
  - Added monotonic counter for sub-millisecond ordering
- Condensed system prompt from ~5k to ~2.7k chars
  - More concise workspace layout (tree format)
  - Clearer log query examples (conversation-only vs full details)
  - Removed redundant guidelines section
- User prompt simplified: removed duplicate "Current message" (already in history)
- Tool status labels (`_→ label_`) no longer logged to jsonl
- Thread messages and thinking no longer double-logged

### Fixed

- Duplicate message logging: removed redundant log from app_mention handler
- Username obfuscation in thread messages to prevent unwanted pings
  - Handles @username, bare username, and <@USERID> formats
  - Escapes special regex characters in usernames

## [0.10.1] - 2025-11-27

### Changed

- Reduced tool verbosity in main Slack messages (#65)
  - During execution: show tool labels (with → prefix), thinking, and text
  - After completion: replace main message with only final assistant response
  - Full audit trail preserved in thread (tool details, thinking, text)
  - Added promise queue to ensure message updates execute in correct order

## [0.10.0] - 2025-11-27

### Added

- Working memory system with MEMORY.md files
  - Global workspace memory (`workspace/MEMORY.md`) shared across all channels
  - Channel-specific memory (`workspace/<channel>/MEMORY.md`) for per-channel context
  - Automatic memory loading into system prompt on each request
  - Mom can update memory files to remember project details, preferences, and context
- ISO 8601 date field in log.jsonl for easy date-based grepping
  - Format: `"date":"2025-11-26T10:44:00.123Z"`
  - Enables queries like: `grep '"date":"2025-11-26' log.jsonl`
- Centralized logging system (`src/log.ts`)
  - Structured, colored console output (green for user messages, yellow for mom activity, dim for details)
  - Consistent format: `[HH:MM:SS] [context] message`
  - Type-safe logging functions for all event types
- Usage tracking and cost reporting
  - Tracks tokens (input, output, cache read, cache write) and costs per run
  - Displays summary at end of each agent run in console and Slack thread
  - Example: `💰 Usage: 12,543 in + 847 out (5,234 cache read, 127 cache write) = $0.0234`
- Working indicator in Slack messages
  - Channel messages show "..." while mom is processing
  - Automatically removed when work completes
- Improved stop command behavior
  - Separate "Stopping..." message that updates to "Stopped" when abort completes
  - Original working message continues to show tool results (including abort errors)
  - Clean separation between status and results

### Changed

- Enhanced system prompt with clearer directory structure and path examples
- Improved memory file path documentation to prevent confusion
- Message history format now includes ISO 8601 date for better searchability
- System prompt now includes log.jsonl format documentation with grep examples
- System prompt now includes current date and time for date-aware operations
- Added efficient log query patterns using jq to prevent context overflow
- System prompt emphasizes limiting NUMBER of messages (10-50), not truncating message text
- Log queries now show full message text and attachments for better context
- Fixed jq patterns to handle null/empty attachments with `(.attachments // [])`
- Recent messages in system prompt now formatted as TSV (43% token savings vs raw JSONL)
- Enhanced security documentation with prompt injection risk warnings and mitigations
- **Moved recent messages from system prompt to user message** for better prompt caching
  - System prompt is now mostly static (only changes when memory files change)
  - Enables Anthropic's prompt caching to work effectively
  - Significantly reduces costs on subsequent requests
- Switched from Claude Opus 4.5 to Claude Sonnet 4.5 (~40% cost reduction)
- Tool result display now extracts actual text instead of showing JSON wrapper
- Slack thread messages now show cleaner tool call formatting with duration and label
- All console logging centralized and removed from scattered locations
- Agent run now returns `{ stopReason }` instead of throwing exceptions
  - Clean handling of "aborted", "error", "stop", "length", "toolUse" cases
  - No more error-based control flow

### Fixed

- jq query patterns now properly handle messages without attachments (no more errors on empty arrays)

## [0.9.4] - 2025-11-26

### Added

- Initial release of Mom Slack bot
- Slack integration with @mentions and DMs
- Docker sandbox mode for isolated execution
- Bash tool with full shell access
- Read, write, edit file tools
- Attach tool for sharing files in Slack
- Thread-based tool details (clean main messages, verbose details in threads)
- Single accumulated message per agent run
- Stop command (`@mom stop`) to abort running tasks
- Persistent workspace per channel with scratchpad directory
- Streaming console output for monitoring
