# WP00 — Runtime1 removal

## Status

Complete. No tag. Runtime2 is the sole public implementation. Do not release while its execution path is incomplete.

## Goal

Make runtime2 the sole public harness implementation, delete runtime1 and its obsolete tests, then stop before adding runtime2 behavior.

## Prerequisites

- The approved acceptance/hook redesign and durability handoffs are present in `harness.md`, `values.md`, `assistant-durability.md`, and `tool-durability.md`.
- Existing tests are evidence, not authority.

## Work, in order

1. **Reconcile the contract.** Fold the approved acceptance/hook redesign into `harness.md`, including durable `starting`, atomic hook-free acceptance, driver-owned `before_run`, `before_drive`, request-local system-prompt transformation, trusted restore, and removal of process-origin activation semantics. Audit §§0.4, 1.2, 3.1–3.6, 4.1–4.2, 4.5, 5.1–5.2, 5.5–5.6, and Parts 8–9; remove every stale `BeforeResumePrepared`, `before_resume`, `resumeData`, `systemPromptOverride`, stable-ID routing, reservation, and `fresh | continue | resume` activation reference. Delete obsolete runtime planning documents once `harness.md` and linked handoffs own the active contract.
2. **Harvest before deletion.** Inspect `agent-harness-runtime.test.ts`, `agent-harness-r2/r3/r4.test.ts`, and old `restore.test.ts`. Preserve unique scenarios in the detailed future rows or a temporary categorized inventory; explicitly discard old reservation, `before_resume`, `resumeData`, persisted hook prompt override, semantic restore audit, and pre-`outcome_ready` tool-crash behavior.
3. **Remove runtime1-only public members.** Delete `before_resume`, `BeforeResumePrepared`, `resumeData`, `systemPromptOverride`, and stable hook-ID routing. Add the approved `before_drive` and `transform_context` shapes. Update telemetry schema source and regenerate its document. Do not implement `starting` or acceptance behavior here.
4. **Switch the factory.** Add `packages/agent/src/harness/runtime2/index.ts`, point `agent-harness.ts` at it, and add a constructor-selection regression. Verify the experimental coding-agent worker still creates the harness, subscribes to events, and closes it.
5. **Delete runtime1 source and tests** listed below.
6. **Update `[Unreleased]` on `main` or a pull-request branch** for the public breaking removals and temporarily incomplete factory. Repository policy forbids changelog edits on `dev`, so WP00 records but does not perform that release-facing step here.
7. Run the retained tests and checks. Fix every failure; do not restore compatibility shims.

## Delete

```text
packages/agent/src/harness/runtime/**
packages/agent/src/harness/restore.ts
packages/agent/test/harness/agent-harness-runtime.test.ts
packages/agent/test/harness/agent-harness-r2.test.ts
packages/agent/test/harness/agent-harness-r3.test.ts
packages/agent/test/harness/agent-harness-r4.test.ts
packages/agent/test/harness/restore.test.ts
packages/agent/test/harness/scratch/r1.ts
packages/agent/test/harness/scratch/r2.ts
packages/agent/test/harness/scratch/r3.ts
packages/agent/test/harness/scratch/r4.ts
```

## Retain

- all `test/harness/runtime2/**` tests;
- Session, Branch, storage, repository, backend-conformance, and instrumentation tests;
- execution assistant/tool/primitives tests;
- config, hooks, events, telemetry, compaction, and branch-summary code/tests;
- `types.test.ts`, updated for the reduced public contract;
- `packages/agent/src/agent-loop.ts` unchanged.

Do not parameterize obsolete runtime1 suites against runtime2 and do not keep a runtime1 smoke suite.

## Acceptance

- No source import references `harness/runtime/*`.
- Public `AgentHarness.create()` selects runtime2.
- Runtime2 creation, events, inspection, close, and fault tests pass.
- These coding-agent tests pass:
  - `experimental-remote-runtime.test.ts`
  - `experimental-session-worker-manager.test.ts` (the upstream replacement for the removed `experimental-session-worker.test.ts`)
  - `experimental-session-worker-lifecycle.test.ts`
- Every modified test passes individually.
- Agent and root TypeScript pass.
- `git diff --check` and `npm run check` pass.

## Outcome

- The accepted hook/drive contract is normative in `harness.md`; stale acceptance/resume contracts are absent.
- Runtime1 source, validating restore, obsolete suites, and R1–R4 scratch scenarios are deleted.
- `AgentHarness.create()` resolves through `runtime2/index.ts`; a constructor-selection regression proves it.
- The scenario harvest added missing tool-close, identity-preflight, recovery-ordering, turn-bracket, and telemetry cases to future rows.
- Upstream added two real remote prompt tests after this handoff was drafted. They remain present but skipped with an R2 re-enable requirement because runtime2 execution is intentionally incomplete. Worker creation, attachment, lifecycle, operation correlation, and close coverage passes.

## Non-goals

- No bound-value/list implementation.
- No implementation of `starting` or atomic acceptance.
- No drive owner, provider, retry, deferred, or tool execution.
- No runtime1 parity work, compatibility layer, archaeology tag, or release.

## Stop condition

Stop once runtime1 is absent, runtime2 is the public factory, retained coverage is green, and all checks pass. Report the deletion and harvested scenarios; do not begin another work package.
