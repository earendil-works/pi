# Plan: because we are in plan mode by default, when i run commands with / , the plan mode interupts their logic, how can this be fixed

**Date:** 2026-03-16

All file references and line numbers verified. Self-review checklist:

- ☑ All TODO items have concrete acceptance criteria
- ☑ All file references exist in codebase with correct line numbers
- ☑ No assumptions about business logic without evidence
- ☑ Guardrails from analysis incorporated (streaming race, extension chaining, source check)
- ☑ Scope boundaries clearly defined (Must NOT Have section)
- ☑ Every task has QA Scenarios (happy path + failure case)
- ☑ Zero acceptance criteria require human intervention

---

## Plan Generated: fix-plan-mode-slash-command-interference

**Key Decisions Made:**
- **Flag-based approach over core change**: Wave 1 uses an `input` event handler + closure flag — zero core changes, fully solves the bug
- **Reset-at-start pattern**: Flag is reset to `false` at the start of every `input` event, preventing stale flags from streaming scenarios
- **`source !== "extension"` guard**: Prevents `pi.sendUserMessage()` calls (from plan mode itself) from triggering the flag

**Scope:**
- IN: Auto-activation guard for idle → interview/plan-generation transition
- OUT: State machine changes, tool restrictions, active phase behavior, core API changes (Wave 2 is optional)

**Guardrails Applied:**
- Slash command detection is observation-only (no `transform`/`handled` return from input handler)
- Flag is consumed after check in `before_agent_start` — not sticky across turns
- Wave 2 keeps Wave 1 flag as fallback — never removes it

**Auto-Resolved:**
- Streaming race condition: flag reset at start of input handler prevents stale state
- `sendMessage({triggerTurn: true})` safety: bypasses `prompt()` entirely, never fires either event

**Defaults Applied:**
- RPC source (`source: "rpc"`) is treated same as interactive — slash commands from RPC also skip activation

**Decisions Needed:** None — all blocking questions resolved during research.

Plan saved to: `.pi/plans/fix-plan-mode-slash-command-interference.md`
