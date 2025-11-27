# Changelog

## [Unreleased]

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
