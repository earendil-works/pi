# Subagent Task POC — Outcome Summary

Date: 2026-01-21

## What worked
- **A subagent could complete a concrete file task.**
  - *Decision:* Use a child `pi --subagent` process plus a shared JSON task file.
  - *Why it helped:* The subagent had the same tool access as the main agent and could write files, so the task executed successfully once the model followed the task-file protocol.

## What didn’t work
- **The loop didn’t terminate reliably from the user’s perspective.**
  - *Decision:* Treat `task.status = "done"` (in the shared JSON) as the only completion signal.
  - *Consequence:* If the model delays or forgets to update the task file, the manager waits indefinitely and the Task tool appears “stuck,” even if work already happened.

- **Progress visibility was too weak (events felt “trash”).**
  - *Decision:* Use stdout streaming as the sole event channel from subagent → parent, without a structured event contract in the UI.
  - *Consequence:* Even when the subagent was active, the TUI had no clear signal that work was happening, so the user saw a long “working” state without meaningful feedback.

## Architectural decisions that drove the outcome
- **Shared task JSON as source of truth**
  - *Pros:* Simple, inspectable, and easy to update.
  - *Cons:* Completion depends entirely on the model mutating that file correctly. There is no secondary signal to confirm done.

- **Child process isolation**
  - *Pros:* The subagent runs independently and can use the full tool stack.
  - *Cons:* The parent only sees exit codes and stdout; without structured events, progress is opaque.

- **No explicit completion handshake**
  - *Pros:* Keeps the protocol minimal.
  - *Cons:* The orchestrator has no deterministic “done” acknowledgment beyond polling the task file.

## Bottom line
The POC proved that a child subagent can do real work, but visibility and termination semantics are not strong enough for a reliable UX. The current architecture relies too heavily on the model updating the task file correctly and lacks a robust progress / completion event channel.
