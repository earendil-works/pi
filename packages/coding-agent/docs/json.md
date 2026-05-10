# JSON Event Stream Mode

```bash
pi --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating pi into other tools or custom UIs.

## `--json-no-partial` (compact streaming)

```bash
pi --mode json --json-no-partial "Your prompt"
```

By default, every `message_update` event carries `assistantMessageEvent.partial` (the full accumulated `AssistantMessage` so far) AND `message` (the wrapping `AgentMessage`). For per-token streaming this means each NDJSON line includes every prior token of the assistant message — total log volume grows O(n²) with the number of tokens.

`--json-no-partial` strips those two fields from `message_update` events whose inner type is `text_delta`, `thinking_delta`, or `toolcall_delta`. Each line becomes O(new content). Consolidated `*_end` and `message_end` events are unchanged, so consumers still get the full content at message/turn boundaries.

When to use it:
- Wrapping `pi` from another agent and persisting its NDJSON to disk.
- Long thinking/streaming runs where the per-token partials would otherwise blow up log size.
- Any consumer that only needs the incremental `delta` plus end-of-message content.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts#L102):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events from [`AgentEvent`](https://github.com/earendil-works/pi-mono/blob/main/packages/agent/src/types.ts#L179):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts#L134):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
