# WP03 — Remove drive deadlines

## Status

Complete. `DriveOptions.deadline` and the `DriveOutcome` `yielded` branch are removed from public types, active documentation, future package requirements, invariants, races, and tests. Obsolete `runtime2.md` is deleted. Focused tests, `npm run check`, and `./test.sh` pass.

WP02 is complete at `beac75ecc`. Preserve unrelated concurrent source work, especially current `packages/agent/src/harness/runtime2/lane.ts` changes, JSONL/fork work, plugins, RPC, and experimental directories.

## Problem

`DriveOptions.deadline` and the corresponding `DriveOutcome { kind: "yielded" }` do not provide a correctness boundary.

A deadline is checked only before starting another transition or effect. An admitted provider/tool/hook may run beyond it and the host may terminate the process anyway:

```text
check deadline
→ admit provider or tool
→ host limit expires while the effect is running
→ process dies with durable effect_pending
```

Unknown-outcome recovery remains mandatory. The deadline therefore does not prevent process loss, bound admitted work, make effects exactly once, or simplify recovery. Flue-style tool memoization depends on stable invocation ids and durable memos, not drive deadlines.

Deadline handling instead adds wall-clock policy to the durable core:

- a `yielded` public outcome unrelated to durable state;
- safe-boundary checks before hooks/effects/transitions;
- deadline-versus-retry-timer arbitration;
- deadline-versus-effect-admission races;
- convenience loops and event-bracket behavior for yields.

The host already owns scheduling and termination. Process loss is a controlled crash boundary recovered from durable operation state.

## Decision

Remove drive deadlines completely:

```ts
interface DriveOptions {
  operationId: string;
  waitForRetry?: boolean;
  pollDeferred?: boolean;
}

type DriveOutcome =
  | { kind: "settled"; operationId: string; outcome: TerminalOperationOutcome }
  | { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
  | { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle }
  | { kind: "action_required"; operationId: string; action: ActionInfo };
```

There is no deprecated alias, ignored `deadline` field, compatibility overload, alternate timestamp option, or replacement pause flag in WP03.

The next drive package uses direct durable transitions. Deterministic tests gate commits and control hooks, providers, tools, and timers without adding production execution barriers.

## Host behavior

Hosts own execution budgets:

```text
invoke drive
→ terminal or durable waiting result: schedule normally
→ planned shutdown: stop routing/releasing work and close session processes
→ forced termination: replacement attaches and recovers durable open operations
```

A process-per-session host may stop routing work and close before exit, and use process termination as the hard fence for non-cooperative providers, tools, hooks, storage, or event listeners. This operational policy does not require a wall-clock field in `DriveOptions`.

WP03 does not add `stopAfterCheckpoint`, `pause`, `quiesce`, or in-process crash simulation. Those ideas remain outside the direct durable-drive design. In-process process-loss simulation is not a public core primitive: an old continuation requires fencing, for which process isolation is the reliable mechanism.

## Work

### Public types

In `packages/agent/src/harness/agent-harness.ts`:

- delete `DriveOptions.deadline`;
- delete the `DriveOutcome` `yielded` branch;
- preserve expected-id fencing, retry waiting, deferred waiting, and manual action branches unchanged.

No current runtime2 drive implementation exists, so this package adds no execution behavior or owner.

### Normative documentation

Update `packages/agent/docs/harness.md` completely:

- remove safe-yield scheduling language from non-goals/orientation;
- remove only the deadline half of cancellation/deadline prerequisite wording in §3.6, §5.6's `before_drive` row, and invariant 22; the cancellation prerequisite remains;
- remove deadline checks and yielded returns from the drive-pass pseudocode;
- remove deadline policy from pass joining, retry waiting, convenience composition, recovery, and public method prose;
- remove `deadline` from `DriveOptions` and `yielded` from `DriveOutcome`;
- remove deadline-specific event/turn requirements;
- remove deadline language from `before_drive` hook timing;
- remove deadline/yield requirements from future work rows;
- replace invariant 25 with the explicit no-wall-clock-policy invariant while retaining the rule that an admitted effect settles normally or is recovered after task loss;
- remove deadline races from the race catalog;
- update the drive-pass glossary.

Do not alter generic RPC timeout/deadline documentation or unrelated process/model-catalog timeouts. Those are invocation/transport policies, not `AgentLane.drive`.

Delete obsolete `packages/agent/docs/runtime2.md`; `harness.md` plus linked handoffs are the sole implementation plan and history needed for active work.

Mark WP02 complete in its handoff and Part 8. Add WP03 as the concrete cleanup package. Leave the former R2/R3 drive rows as historical future candidates, minus deadline/yield requirements, until the reviewed direct-drive handoff replaces them.

### Delete

- `packages/agent/docs/runtime2.md`

### Type tests

Extend `packages/agent/test/harness/types.test.ts`:

- assert `keyof DriveOptions` is exactly `"operationId" | "waitForRetry" | "pollDeferred"`;
- assert `DriveOutcome["kind"]` excludes `"yielded"`;
- add `@ts-expect-error` coverage proving callers cannot supply `deadline`;
- retain existing drive/result signatures.

Run the focused type test after editing it.

### Downstream compatibility

Search protocol, server, coding-agent, examples, and tests for structural mirrors or exhaustive `DriveOutcome` switches. Update only compile-time/type compatibility forced by the public removal. Coding-agent experimental worker/remote-runtime behavior and tests are out of scope.

The current protocol harness schemas expose prompt/run/watch DTOs, not `DriveOptions` or `DriveOutcome`; no protocol edit is expected unless the final search proves otherwise.

## Non-goals

WP03 does not implement or redesign:

- `drive`, `resume`, prompt conveniences, operation ownership, or latest-result lookup;
- manual actions or automatic barrier release;
- provider/tool execution, recovery, retry timers, deferred polling, abort, or terminal settlement;
- checkpoint pause/quiesce;
- close admission changes;
- worker/RPC cancellation or experimental remote prompting;
- storage/schema/migration behavior.

## Required checks

```bash
# No drive deadline/yield contract remains in active harness docs or source.
rg -n 'deadline|yield' \
  packages/agent/src/harness \
  packages/agent/test/harness \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages

cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/types.test.ts

cd "$(git rev-parse --show-toplevel)"
git diff --check
npm run check
./test.sh
```

The removal grep may still match this handoff's historical problem explanation. Every remaining match must be reviewed; no active API, normative behavior, future acceptance criterion, or test expectation may retain the removed contract.

## Review

Before implementation:

1. Fable reviews this handoff against complete docs/source.
2. As explicitly requested by the user, `openai-codex/gpt-5.6-sol` reviews it with thinking level high.
3. Resolve all findings and repeat until no findings.

After implementation, repeat both reviews over the final documentation/type diff.

## Stop condition

Stop when:

- `DriveOptions` has no wall-clock budget;
- `DriveOutcome` has no `yielded` branch;
- active normative docs contain no deadline/yield behavior;
- future drive rows contain no hidden deadline requirements;
- type tests prove removal;
- unrelated timeout/deadline APIs remain untouched;
- focused tests, `npm run check`, and `./test.sh` pass;
- final Fable and Codex reviews have no findings.

Do not begin the direct durable-drive implementation in this package.
