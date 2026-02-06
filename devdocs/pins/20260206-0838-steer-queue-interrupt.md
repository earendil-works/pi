# Pin: /queue steer mode (interrupt after tool calls)

## Goal
Add a new `/queue` mode `steer`.

Behavior (as requested): when the model finishes a tool-using turn (i.e., tool calls executed and tool results are available) and the user has queued a new message while it was running, inject that queued user message **before** the model continues with its next LLM call, so the next assistant response can react to the new instruction.

## Current state (verified)
- Queue modes today: `one-at-a-time`, `all`.
- `packages/agent/src/agent.ts` queues messages while streaming and drains them **only after** the entire agent run completes (`agent_end`).
- Tool calls + tool execution loops live in `@kennyfrc/mu-ai` `agentLoop()`.

Evidence: `tmp/queue-steer-discovery.ts` shows that a message queued during tool execution is processed only *after* the continuation assistant message and `agent_end`.

## Key files
- Queue mode selection UI: `packages/coding-agent/src/tui/queue-mode-selector.ts`
- `/queue` command wiring: `packages/coding-agent/src/tui/tui-renderer.ts`
- Queue mode persistence: `packages/coding-agent/src/settings-manager.ts`
- Agent queue + drain implementation: `packages/agent/src/agent.ts`
- Tool loop / turn boundaries: `packages/ai/src/agent/agent-loop.ts`

## Next step
Implemented.

## Implemented solution (high level)
- `@kennyfrc/mu-ai` (`packages/ai/src/agent/agent-loop.ts`): added `interrupt()` hook on `AgentLoopConfig` that can return `UserMessage[]` to inject between tool results and the continuation turn. Injected messages emit `message_start/message_end` and are included in `agent_end.messages`.
- `@kennyfrc/mu-agent-core` (`packages/agent/src/agent.ts`): added `queueMode: "steer"` which drains the queued messages at the tool boundary via the new `interrupt()` hook.
- `@kennyfrc/mu-coding-agent`: `/queue` selector + settings support `steer`.

## Verification
- `npm test -w @kennyfrc/mu-ai`
- `npm test -w @kennyfrc/mu-agent-core`
- `npm test -w @kennyfrc/mu-coding-agent`
- `npm run check`
