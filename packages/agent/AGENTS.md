# agent — Core Agent Abstraction

General-purpose agent with transport abstraction, state management, and tool execution loop.

## Structure
```
src/
  agent.ts       # Agent class — state machine (idle→running→done), message history, tool dispatch
  agent-loop.ts  # Core loop: send messages → process tool calls → collect results → repeat
  proxy.ts       # Transport proxy for remote agent connections
  types.ts       # AgentMessage, AgentToolResult, ThinkingLevel, tool schemas
  index.ts       # Public API re-exports
```

## Where to Look
| Task | Location |
|------|----------|
| Change agent loop behavior | `src/agent-loop.ts` |
| Add agent state/lifecycle | `src/agent.ts` |
| Modify message/tool types | `src/types.ts` |

## Conventions
- Agent is model-agnostic — delegates LLM calls to `@mariozechner/pi-ai` via `StreamFn` / `streamSimple`
- Tool execution modes: `"sequential"` or `"parallel"` (controls how tool calls from one turn execute)
- Parallel preflight is sequential (beforeToolCall hooks), then all execute concurrently, finalize in source order
- Steering messages delivered mid-run after current tool finishes; follow-up messages delivered when agent would stop
- `AgentMessage` supports declaration merging via `CustomAgentMessages` interface — web-ui uses this for `user-with-attachments` and `artifact` roles
- `proxy.ts` provides `streamProxy()` as a drop-in `StreamFn` for browser apps that can't call LLM providers directly
- Tests: `test/*.test.ts` — run from this directory with vitest (30s timeout, globals: true)
