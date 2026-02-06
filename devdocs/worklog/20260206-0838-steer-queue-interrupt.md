# Worklog: /queue steer mode (interrupt after tool calls)

## Context discovery
- Read repo + package READMEs to confirm `/queue` currently supports `one-at-a-time` and `all`.
- Traced `/queue` implementation to TUI selector + settings persistence + Agent queue draining.
- Verified tool-loop boundary location in `packages/ai/src/agent/agent-loop.ts` (`turn_end` emitted after tool results are appended).

### Runtime verification
Added and ran:
- `tmp/queue-steer-discovery.ts`

Observed (expected with current code): queued message submitted during tool execution is not injected before the continuation LLM call; it is only processed after `agent_end` via `Agent.drainQueueAfterPrompt()`.

## Implementation (completed)
- Added `interrupt()` hook to `packages/ai/src/agent/types.ts` + `packages/ai/src/agent/agent-loop.ts`.
- Added `queueMode: "steer"` to `packages/agent/src/agent.ts` and plumbed `interrupt` through transports.
- Updated coding-agent `/queue` selector + settings to include `steer`.

Verification:
- `npm test -w @kennyfrc/mu-ai`
- `npm test -w @kennyfrc/mu-agent-core`
- `npm run check -w @kennyfrc/mu-coding-agent`
- `npm test -w @kennyfrc/mu-coding-agent`
- `npm run check`
