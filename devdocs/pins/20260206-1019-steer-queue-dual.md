# Pin: dual-queue semantics for /queue steer toggle

## Goal
When switching `/queue` mode between non-steer and `steer` while messages are already queued, **do not reclassify/flush** existing queued items.

New behavior:
- Existing queued items should remain "by end" (processed after the current agent run completes), even if the user switches to `steer`.
- Only messages queued while in `steer` mode should be considered "next" (injected between tool results and continuation).

UI microcopy:
- Non-steer queued items: keep existing microcopy (currently `↳ Queued:`).
- Steer queued items: display as `↳ Queued next:` (shortest acceptable microcopy; user suggested `Queued Next:`).

## Current state (verified)
- `steer` is implemented via:
  - `@kennyfrc/mu-ai` `AgentLoopConfig.interrupt()` hook (inject user messages after tool results).
  - `@kennyfrc/mu-agent-core` `Agent.queueMode = "steer"` uses `interrupt()` to drain *the* messageQueue at tool boundary.
- Today there is only one queue in `mu-agent-core` Agent: `messageQueue`.
- TUI mirrors queued items in `queuedMessages` (single list) and always calls `agent.queueMessage(...)` when streaming.

## Problem
With only one queue, switching to `steer` would cause already-queued items to be drained by the interrupt hook (becoming "queued next") rather than remaining "queued by end".

## Working hypothesis
Represent dual semantics by tagging each queued item at enqueue-time:

- `kind: "by-end"` — queued while queueMode != `steer`; drained only after the current agent run completes (`drainQueueAfterPrompt()`).
- `kind: "next"` — queued while queueMode == `steer`; eligible to be drained by the `interrupt()` hook at the tool boundary.

Implementation detail: keep a **single queue** (stable arrival order) where each item stores its `kind`. Draining at the tool boundary removes only `kind:"next"` items (in arrival order).

Ordering rule (explicit):
- Within each kind, preserve FIFO order.
- `next` items may be processed before earlier `by-end` items by design (that’s the purpose of steer).

Optional normalization (recommended): when switching *away* from `steer`, convert any queued `next` items to `by-end` so the label/behavior stays coherent when interrupt is disabled.

## Key files
- Core queue implementation: `packages/agent/src/agent.ts`
- Transport plumbing: `packages/agent/src/transports/*`
- Queue UI + editing: `packages/coding-agent/src/tui/tui-renderer.ts`
- Queue selector: `packages/coding-agent/src/tui/queue-mode-selector.ts`

## Next step
Answer (design-level) questions:
1) What data structures are needed to represent both "next" and "by end" semantics while preserving expected ordering?
2) What operations are needed (enqueue next/by-end, toggle behavior, drain at tool boundary vs agent end, fallback behavior when no tools)?
Then implement with tests.

## Current slice
Slice 1 / 2: Implement mu-agent-core queue kind + interrupt draining + unit tests. (DONE)

Slice 2 / 2: update coding-agent TUI microcopy to show `↳ Queued next:` for `kind:"next"`. (DONE)

## Done means
- Switching `/queue` mode from non-steer -> `steer` does not change existing queued items (they remain queued-by-end).
- Only messages queued while in `steer` mode are eligible to be injected at tool boundaries.
- TUI shows `↳ Queued next:` for steer-queued items.

## Verification ideas
- Add vitest(s) in `packages/agent/test/` for:
  - toggling queueMode to steer does not move existing queued-by-end messages into queueNext
  - queueNext is injected only for messages queued while steer was active
- Add coding-agent tests for UI microcopy if feasible (or at least settings + selector behavior).
