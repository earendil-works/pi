# packages/mom/src

## Purpose
Slack bot ("mom") that delegates messages to the pi coding agent. Manages per-channel agent runners, handles Slack events, provides working indicator and message accumulation, supports sandboxed execution via Docker.

## Technology
TypeScript, ESM modules. `@slack/socket-mode` and `@slack/web-api` for Slack integration. `@mariozechner/pi-coding-agent` for agent execution. `@anthropic-ai/sandbox-runtime` for Docker sandboxing.

## Contents
- `main.ts` - Entry point: CLI arg parsing, Slack bot setup, per-channel state management, handler dispatch, events watcher, graceful shutdown
- `agent.ts` - `AgentRunner`: creates and manages pi coding agent sessions per channel, handles prompt execution and abort
- `context.ts` - Context adapter: converts Slack message context to agent-compatible format
- `slack.ts` - `SlackBot` class: Socket Mode connection, message handling, user/channel caching, file upload/download, attachment processing
- `store.ts` - `ChannelStore`: per-channel persistent storage for conversation state and file management
- `events.ts` - `createEventsWatcher()`: file-system watcher for event-driven triggers (cron-like events from files)
- `download.ts` - `downloadChannel()`: downloads full Slack channel history for archival
- `sandbox.ts` - `SandboxConfig`, `parseSandboxArg()`, `validateSandbox()`: Docker container sandboxing configuration
- `log.ts` - Structured logging utilities with timestamps and channel context
- `tools/` - Agent tool implementations for sandboxed execution (bash, read, write, edit, attach, truncate)

## Key Functions
- `main.ts`: `getState(channelId)` creates per-channel state with runner, store, and control flags
- `agent.ts`: `AgentRunner.run(ctx, store)` executes agent on user message, returns result with stopReason
- `slack.ts`: `SlackBot.start()`, `SlackBot.postMessage()`, `SlackBot.updateMessage()`, `SlackBot.uploadFile()`
- `events.ts`: `createEventsWatcher(workingDir, bot)` watches for `.event` files and dispatches them as bot messages
- `download.ts`: `downloadChannel(channelId, botToken)` downloads channel messages and files

## Data Types
- `ChannelState`: `{ running, runner, store, stopRequested, stopMessageTs? }`
- `SlackEvent`: `{ text, user, channel, ts, attachments? }`
- `MomHandler`: `{ isRunning(channelId), handleStop(channelId, slack), handleEvent(event, slack, isEvent?) }`
- `SandboxConfig`: `{ type: "host" } | { type: "docker", container: string }`
- `SlackBot`: class with message posting, updating, file upload, user/channel lookup

## Logging
Structured logging via `log.ts`: `logInfo()`, `logWarning()`, `logStartup()` with timestamps and channel context.

## CRUD Entry Points
- **Create**: `mom <working-directory>` starts the bot, creates per-channel state on first message
- **Read**: `store.ts` reads persisted channel data
- **Update**: Agent runs update channel state; Slack messages updated in-place with accumulated text
- **Delete**: `handleStop()` aborts running agent; shutdown handlers clean up

## Style Guide
- camelCase for functions/variables, PascalCase for classes/types
- Tab indentation
- Environment variables: `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN`
- Per-channel isolation pattern (channelStates Map)
- Working indicator pattern: accumulated text + " ..." suffix while running

```typescript
const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	},
	async handleEvent(event: SlackEvent, slack: SlackBot): Promise<void> {
		const state = getState(event.channel);
		state.running = true;
		const ctx = createSlackContext(event, slack, state);
		await state.runner.run(ctx, state.store);
		state.running = false;
	},
};
```
