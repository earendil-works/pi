# Durable External Tool Result

## Goal

Allow a custom tool to suspend an `AgentSession` while an external controller collects a typed
result, then resume the same Pi session after JSONL export/open without synthesizing a user prompt.

This is a general Pi capability. It has no cloud, approval UI, database, or provider-specific
concepts.

## Public API

```ts
type ExternalToolResultInput = {
  toolCallId: string
  content: AgentToolResult<unknown>["content"]
  details: unknown
  isError?: boolean
}

session.listPendingExternalToolCalls(): PendingExternalToolCall[]
await session.submitExternalToolResult(result): SubmitExternalToolResultOutcome
```

`submitExternalToolResult()` is idempotent. A duplicate submission for an already resolved call
returns `already_resolved`; it never executes a tool twice.

## Session Semantics

1. A custom tool opts in by returning `defer: true` instead of `terminate: true`.
2. Pi persists the assistant tool call normally, then appends a `custom` JSONL entry with
   `customType: "pi.pending_external_tool"`. It does not append a tool-result message for that call.
3. The current agent turn settles without a synthetic result or continuation prompt.
4. `SessionManager.open()` rebuilds the pending call from JSONL.
5. The host submits a typed tool result for the original `toolCallId`.
6. Pi appends the native tool-result message and a `pi.external_tool_result` audit entry, removes the
   pending state, and schedules continuation through Pi's native turn machinery.

If several calls are deferred in one assistant response, Pi persists all of them but waits until
every outstanding deferred call has a native result. Earlier submissions return
`pending_external_results`; only the final submission continues the model turn.

## Invariants

- Pending and resolved state live in Pi JSONL, never in a host transcript reconstruction.
- Only a tool call already present on the active Pi branch can be resumed.
- A pending result may be submitted only while the session is idle.
- The result is appended once; duplicate submission is a no-op result, not an error or replay.
- Pi owns subsequent model/tool scheduling, retry, compaction, and cancellation.
- Existing `terminate: true` behavior remains unchanged.

## Initial Scope

The first change adds durable state and typed result persistence. It deliberately does not make
automatic model continuation policy configurable: the session exposes the result to Pi's native
next-turn path. Follow-up policy and UI remain host responsibilities.

## Required Tests

- defer -> export -> open -> list pending -> submit -> tool result persisted
- duplicate submit is idempotent
- unknown and non-pending tool call rejection
- submission while an agent run is active rejection
- regular `terminate: true` regression
