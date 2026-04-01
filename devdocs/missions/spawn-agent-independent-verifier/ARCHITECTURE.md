# Architecture Proposal

## Summary

Implement an optional independent verifier flow for `spawn_agent`.

Recommended v1 shape:

- extend `spawn_agent` with opt-in verification inputs
- run verification sequentially: worker first, verifier second
- keep the verifier as a separate spawned child session with isolated context
- have the verifier check both correctness and adherence to `SPEC.md`
- return a simple verification report to the parent: `PASS|FAIL` plus issues
- keep parent control: the parent decides whether to retry, accept, or abort
- update prompt/policy surfaces so the behavior is legible in tool descriptions and agent policy

Mission meta-rule:

- until the productized verifier flow exists, this mission itself must use independently spawned verifier agents for milestone gates and other non-trivial validation work

## Proposed Boundaries

### `packages/coding-agent/src/tools/spawn-agent.ts`
- Own new verifier-facing inputs on the tool schema.
- Own sequential worker → verifier orchestration.
- Own the returned details/report shape exposed to the parent.

### `packages/coding-agent/src/tools/wait-agent.ts`
- Keep wait semantics compatible with worker-only and worker+verifier flows.
- Surface verifier completion cleanly when the parent waits on child ids.

### `packages/coding-agent/src/spawned-agents.ts`
- Own reminders/reports about unwaited child sessions.
- If needed, distinguish worker and verifier sessions in summary/report output.

### `packages/coding-agent/src/prompts/tools.yaml`
- Own the public contract for `spawn_agent` and `wait_agent`.
- Document how verification is requested and what the verifier checks.

### `packages/coding-agent/src/prompts/system.yaml`
- Keep the short tool descriptions aligned with the fuller tool contract.
- Make verification discoverable in the system prompt without overloading it.

### `~/.mu/agent/AGENTS.md`
- Own the durable policy language for spawned-agent verification.
- Clarify when verification is expected and how parent agents should treat verifier findings.

### Test Surface
- Unit tests for schema parsing, defaulting, report shape, and reminder/report projection.
- Integration tests for sequential worker → verifier flow.
- Prompt/policy checks for tool descriptions and agent-policy text.

## Key Abstractions

- `SpawnAgentVerificationRequest`
  - `verify?: boolean`
  - `verificationChecks?: string[]`
  - verifier reads `SPEC.md` from mission startup when available

- `SpawnAgentVerificationReport`
  - `status: "PASS" | "FAIL"`
  - `issues: string[]`
  - optional compact evidence summary or verifier session id

- `SpawnAgentCompositeResult`
  - worker session details
  - optional verifier session details
  - optional verification report

The parent remains the control point. The verifier supplies assessment; it does not silently patch source or auto-accept work.

## Tradeoffs

### Chosen design: independent verifier instead of self-verification
- avoids worker self-bias
- better matches “correctness + spec adherence” review
- costs an extra child session and extra latency

### Chosen design: same model first
- simpler and cheaper for v1
- easier to reason about defaults and inheritance
- does not maximize independence as much as a stronger-model verifier would

### Chosen design: sequential verification
- easier to implement and inspect
- verifier sees final worker output, not partials
- slower than a future parallel or streaming design

### Chosen design: simple report shape
- easy for parent agents and tests to consume
- leaves room to add richer findings later
- less expressive than a structured typed finding model

### Chosen design: mission-level meta-rule before product feature exists
- lets the mission practice the design immediately
- increases process discipline without blocking initial scaffolding
- depends on agent compliance until runtime enforcement exists

## What Matters Most

1. True verifier independence.
2. Correctness and spec-adherence checks, not vague “looks good” reviews.
3. Parent remains in control after verifier findings.
4. Prompt/tool/policy surfaces stay consistent with runtime behavior.
5. Mission execution itself uses independent verification for gates.
6. No unrelated agent-runtime refactors.

## Approval Requested

Please approve these boundaries, abstractions, tradeoffs, and priorities before implementation starts.
