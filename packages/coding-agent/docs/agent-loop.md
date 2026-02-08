# Agent loop internals (turns, tools, events)

This doc explains how **mu** turns a user prompt into an interactive “agent run” that can:

1. stream an assistant message,
2. execute any tool calls the assistant produced,
3. feed tool results back to the model,
4. repeat until the assistant stops calling tools.

The core loop lives in **@kennyfrc/mu-ai** and is wrapped by **@kennyfrc/mu-agent-core** (state + message queue), then consumed by **@kennyfrc/mu-coding-agent** (TUI, sessions, CLI modes).

## 0) The three layers

### Layer A: `@kennyfrc/mu-ai` (provider-agnostic agent loop)

*Files*
- `packages/ai/src/agent/agent-loop.ts` — the loop + tool execution
- `packages/ai/src/agent/types.ts` — `AgentEvent`, `AgentLoopConfig`, `AgentTool`

Responsibilities
- Convert a **single user prompt** into one or more **turns**.
- Stream assistant output as incremental events.
- Execute tool calls and emit tool execution events.
- Emit a single `agent_end` event containing all new messages from this run.

### Layer B: `@kennyfrc/mu-agent-core` (stateful Agent wrapper)

*Files*
- `packages/agent/src/agent.ts` — `class Agent` (state, queue, prompt orchestration)
- `packages/agent/src/types.ts` — app-level `AgentState`, `AgentEvent` (same event names)
- `packages/agent/src/transports/ProviderTransport.ts` — runs `mu-ai`’s `agentLoop`

Responsibilities
- Maintain long-lived state: model, thinking level, tools, system prompt, full message history.
- Provide `agent.prompt(...)` that:
  - appends the user message,
  - runs the underlying loop,
  - appends generated messages into state.
- Manage the **message queue** (one-at-a-time / all / steer).

### Layer C: `@kennyfrc/mu-coding-agent` (CLI + TUI)

*Files*
- `packages/coding-agent/src/main.ts` — wiring: build system prompt, create `Agent`, choose mode
- `packages/coding-agent/src/tui/tui-renderer.ts` — subscribes to agent events and renders UI
- `packages/coding-agent/src/session-manager.ts` — saves `message_end` entries to JSONL sessions

Responsibilities
- Subscribe to events and render:
  - streaming assistant text
  - tool execution “cards” + streaming tool output
  - final “Done after …” marker on `agent_end`
- Persist messages into session files.
- Expose non-interactive output modes (`--mode text|json|rpc`).

## 1) The core concept: turns

**Turn** (in this repo) = “one assistant response” + “zero or more tool calls” + “tool results”.

In `packages/ai/src/agent/agent-loop.ts`, the loop does:

1. **Start**: emit `agent_start` then `turn_start`.
2. **Assistant**: stream the assistant message (with tool calls possibly appearing mid-stream).
3. **Tools** (optional): if the assistant ended with tool calls, execute them and emit tool events.
4. **Turn end**: emit `turn_end` with the assistant message + tool results.
5. **Continue**: if there were tool calls, start another turn and ask the model again.
6. **Stop**: when there are no tool calls, emit `agent_end`.

## 2) Events: what the UI listens to

The event names are consistent across layers (AI loop → agent wrapper → TUI):

- Lifecycle
  - `agent_start`
  - `agent_end` (contains `messages`, the new messages produced by the run)
- Turn lifecycle
  - `turn_start`
  - `turn_end` (contains the assistant `message` + the `toolResults` created this turn)
- Message lifecycle
  - `message_start` (user, assistant, toolResult)
  - `message_update` (assistant only; emitted while streaming)
  - `message_end` (final message object)
- Tool execution lifecycle
  - `tool_execution_start` (emitted once per tool call)
  - `tool_execution_progress` (optional; streaming output like bash stdout)
  - `tool_execution_end` (result or error)

Where to look
- `packages/ai/src/agent/types.ts` — authoritative event definitions produced by `agentLoop`
- `packages/agent/src/types.ts` — same event types, plus app-level message union
- `packages/coding-agent/src/tui/tui-renderer.ts` — `handleEvent(...)` switch over these events

### Important nuance: assistant streaming

`message_update` carries:
- the latest **partial assistant message** (`event.message`), and
- the underlying low-level stream event (`assistantMessageEvent`).

The TUI uses this to:
- keep updating the currently-streaming assistant bubble, and
- create tool UI components early as soon as tool calls appear in the partial message.

## 3) Tool execution semantics (ordering + parallelism)

Tool calls are discovered from the assistant message’s content blocks:

```ts
const toolCalls = message.content.filter((c) => c.type === "toolCall");
```

### Start/end events preserve FIFO order

In `executeToolCalls(...)` (`packages/ai/src/agent/agent-loop.ts`):

- `tool_execution_start` is emitted **upfront for all tool calls**, in the order they appear.
- Tools may run concurrently (depending on resource keys; see below).
- `tool_execution_end` is emitted in the **original FIFO order** (results are re-ordered before emitting).

This gives the UI stable ordering even if tools complete out-of-order.

### Resource keys serialize “same resource” tool calls

Tools may define:

```ts
getResourceKey?: (params) => string | undefined
```

The agent loop groups tool calls by key:
- `undefined`/`null` key → runs in the “parallel group”
- same non-null key → runs sequentially (FIFO) within that group

Practical example: tools that mutate a file can return `file:/abs/path` to avoid race conditions.

### Streaming tool output

Tool implementations can stream progress via an `onProgress(chunk)` callback; the loop emits:

- `tool_execution_progress` events as chunks arrive.

The TUI appends these chunks to the tool card (useful for long `bash` commands).

## 4) Queue modes (interactive UX)

Queue modes are managed by `@kennyfrc/mu-agent-core`’s `Agent` wrapper (`packages/agent/src/agent.ts`).

### `one-at-a-time` (default)

- If you submit messages while the agent is running, they’re queued.
- After the current agent run completes, queued messages are prompted **one by one**, each with its own agent run.

### `all`

- After the current run completes, all queued messages are combined into one prompt:
  - combined text: `msg1 + "\n\n" + msg2 + ...`
  - attachments are concatenated

### `steer`

Steer is special: it can inject queued messages **between tool execution and the continuation LLM call**.

Mechanism:
- `Agent.prompt(...)` passes an `interrupt(...)` function into `mu-ai`’s `agentLoop`.
- After a tool-using turn ends (tool results exist), `agentLoop` calls `interrupt(...)`.
- The wrapper drains queued messages of kind `next`, builds a new `UserMessage`, and returns it.
- `agentLoop` then emits that injected user message at the start of the next turn.

This is why steer feels like “mid-flight steering” without aborting the whole run.

## 5) Timestamps in user messages

In `packages/agent/src/agent.ts`, `Agent.prompt(...)` prepends a visible timestamp:

```xml
<user_message_time>Sunday, February 8, 2026 at 1:33 PM GMT+8</user_message_time>
```

This is included as the first text block of the user message. The coding-agent TUI strips this prefix for display in some places (e.g., queue matching).

## 6) How sessions get written

In the coding-agent TUI (`packages/coding-agent/src/tui/tui-renderer.ts`), the renderer subscribes to agent events and on every `message_end` it:

- saves the message into the session JSONL via `SessionManager.saveMessage(...)`, and
- starts the session header lazily once enough messages exist.

In non-interactive modes, the same pattern is used:
- `--mode json` prints events as JSONL (one per line)
- `--mode rpc` prints events and listens for stdin commands

## 7) Where to start reading in code

If you’re new to this codebase and want the fastest “I get it now” path:

1. `packages/ai/src/agent/agent-loop.ts`
   - Understand the loop + tool execution ordering.
2. `packages/agent/src/agent.ts`
   - See how state + queue wrap the loop.
3. `packages/coding-agent/src/tui/tui-renderer.ts`
   - See how events become UI + how sessions are persisted.

