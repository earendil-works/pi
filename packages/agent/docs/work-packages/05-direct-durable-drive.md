# WP05 — Direct durable drive

**Status: WP05 complete through M10: lane-owned inbox, immutable result records, 13 family-neutral leaves, atomic boundary planning, total cancellation/dispatch, public and replicated lane surfaces, documentation reconciliation, and lane-safe provider cache identity. Remaining assistant-output work is owned by the [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md), outside the public-drive gate.**

WP06's Session/Branch/Lane separation is part of the foundation. Public drive is enabled; `watchSession` is the sole deferred Harness method.

Format 4 remains work in progress. Every durable type replacement in this package requires no migration and no compatibility decoder for the pre-redesign shapes.

The standalone-compaction inbox/promotion design previously in this document is **withdrawn** (§5). R1–R3 and M7/M8 replace it. M9 reconciled `docs/harness.md`, which is normative on its own again.

## 0. Mandatory reading

Read completely before implementation work:

1. `packages/agent/docs/harness.md` (normative; reconciled by M9)
2. `packages/agent/docs/runtime-simplification.md` (its 22-leaf list is replaced by R3)
3. `packages/agent/src/harness/session/types.ts`
4. `packages/agent/src/harness/session/values.ts`
5. `packages/agent/src/harness/runtime/lane.ts`
6. `packages/agent/src/harness/runtime/types.ts`
7. every existing `packages/agent/src/harness/runtime/drive/*.ts`
8. `packages/agent/src/harness/runtime/progress.ts`
9. `packages/agent/src/harness/runtime/restore.ts`
10. `packages/agent/src/harness/execution/{effect-gate,assistant,tools}.ts`
11. relevant focused runtime tests

Do not inspect Git history or removed runtime implementations. The current source and these documents are the only implementation inputs.

## 1. Runtime model (target)

### Lane authority

`Lane.state` is authoritative while a Harness owns its Session. It contains all orchestration state required to dispatch:

- tip;
- lane configuration;
- the lane inbox: tagged queued-input ids (R1);
- last operation id (R2);
- operation metadata;
- flat operation state, including control.

Every supported mutation commits on the one Session mutation line and publishes the matching `Lane.state` before releasing the line. Drive procedures never reread `laneState`, `operationMeta`, `operationState`, `branchTip`, `laneConfig`, or `operationResult` from storage.

`SessionReader` is used only to dereference content named by in-memory state and to enumerate operation-owned cleanup addresses:

- tree entries and branch context;
- pending entry payloads;
- assistant frame lists;
- tool arguments, checkpoints, and memos;
- structural preparations;
- staged tool outcomes;
- cleanup-prefix scans.

### One lane-owned inbox (R1)

Queued input is lane-owned, never operation-owned. `LaneState` (durable and process-local) carries one ordered inbox of `{ entryId, kind }` items with `kind: "steer" | "followUp" | "nextRun" | "write"`. Payload staging is unchanged: enqueue mints the entry id and writes `pendingEntry(id)`; the inbox holds ids only. Item lifecycle is admission → consumption | cancellation; terminal cleanup never touches queue payloads.

Tags are consumption-eligibility markers, not ownership. Enqueue always succeeds — during runs, structural operations, cancellation, and idle. Every drain point selects eligible items per tag, applying queue modes during selection, but places all selected items in the inbox's single global admission order. Tag grouping must never reorder user input. At acceptance, request prompt entries follow the selected inbox items because the request is the newest admission.

| Drain point | Eligibility and decision order |
| --- | --- |
| acceptance (idle lane) | write + nextRun (all), steer (`steeringMode`: all or oldest), and followUp (`followUpMode`) are eligible. Place selected items in global admission order, then request prompt entries. The acceptance transaction places them and removes their ids; `starting` drains nothing. followUp is eligible because an idle lane vacuously satisfies its "after current work" condition. |
| turn-end boundary pass (run) | write + steer are eligible before threshold/continuation planning and are placed in global admission order. followUp becomes eligible only at `may_finish`, before `before_run_end` and finish. nextRun is never eligible mid-run and never blocks finish. |
| idle direct append | queued write items are placed in admission order, then the new entry, in one commit |
| abort (M7) | steer + followUp are removed from the inbox, payload values deleted, and payloads returned; nextRun and write items stay |

**One decision, at most one commit (R1b).** A boundary pass may enter the mutation line several times for bounded reads and for `before_run_end` mediation, but it performs **at most one commit**, and that commit always lands in a state that neither drains nor rechecks (`assistant.ready`, `summary.deciding`, placed entries + `assistant.ready`, or a terminal transaction). No boundary decision ever commits back into `checkpoint`. A crash before the commit re-runs the whole decision with nothing consumed; a crash after it lands past the decision point. Consequently `skipInboxOnce` and `thresholdCheckedTriggerEntryId` are deleted: drains cannot re-fire because their target states do not drain, and the threshold marker is replaced by a guard derived from the branch itself — threshold fires only when `shouldCompact` holds **and** the branch's newest compaction entry is older than the trigger entry, so a committed threshold compaction is its own durable marker. Mode remainders stay queued and are consumed at later boundaries, giving the per-turn steer cadence and per-run-end followUp cadence.

There is no terminal drain. `cancelQueued` triage is unchanged and single-location. Queued input survives operation termination (including abort, for nextRun/write) until consumed or cancelled; this is a deliberate product decision.

### Flat state (R3)

`OperationState` has one `at` discriminator with **13** direct leaves:

- `starting`
- `checkpoint`
- `assistant.ready`
- `assistant.effect_pending`
- `assistant.retry_wait`
- `tools`
- `deferred.suspended`
- `deferred.effect_pending`
- `summary.deciding`
- `summary.ready`
- `summary.effect_pending`
- `summary.retry_wait`
- `navigation.ready_to_commit`

Every leaf carries one uniform scope `{ control, settings, latestAssistantEntryId }`. There are no `run.`/`compaction.`/`navigation.` leaf prefixes, no per-family scope types, and no intersection zoo. The four `summary.*` leaves carry a `SummaryTask` whose `boundary` datum (a closed three-arm union, §8) decides what happens at the result boundary. `starting` and `navigation.ready_to_commit` are intent-locked entry leaves. `ToolBatch`/`ToolCall` remain the nested child collection state machine. `Control` stays orthogonal and loses its drained fields when M7 installs drain-and-return abort.

### Durable operation results (R2)

Every terminal transaction writes one small immutable result record at `operationResult(operationId)` (namespace `pi.result`, operation id key). The record is lane-lived; keeping it outside `pi.op.*` keeps that namespace's "deleted no later than the terminal transaction" grammar total and exception-free. `LaneState.lastOperationId` points at the newest record. `laneLastResult` (value, address constructor, and type union) is deleted.

- `drive(id)` becomes total for settled operations: current id → install/join; record exists → return the record itself; neither → `OperationMismatch`.
- Recovery and attachment never read result records; they are observation only.
- Terminal-control invariant: a terminal transaction that executes under durable `cancel_requested` always records `status: "aborted"`; equivalently, any other status implies running terminal control. (Every non-aborted terminal path goes through `continueOperation`, which diverts under cancellation, and the mutation line serializes the marker against the terminal commit.)
- There is no listing, filtering, pagination, or retention API for records — and no hydration layer. `getResult(operationId)` and the drive settled arm are the entire read surface; both return the record with no entry dereference, so observation can never fault on missing entries.

### One lane-owned Drive

Unchanged: one process-local Drive pass per lane; first matching caller installs, later matching callers observe the same completion; no caller owns it after installation; invocation cancellation rejects only that caller's observation; an installed Drive is never abandoned or replaced in-process; `requestAbort(operationId)` is the only durable operation cancellation; a stale operation id returns `OperationMismatch` and affects nothing. `Drive.context` removes the installing invocation signal.

### Close

Unchanged: close is not abort. It seals mutation admission, rejects local observations with `HarnessClosed`, observes detached pass failures, drains mutations admitted before the seal, and closes the Session. It writes no cancellation marker or synthetic terminal state and never replaces a Drive.

### No external finalization

Unchanged: no live-process external-finalization path, `OperationEnded`, `finalizedOutcome`, ownership-loss result, or exact-Drive ABA fence.

## 2. Procedure shape

Live procedures are ordinary straight-line async functions:

```text
prepare
→ commit intent
→ admit and await effect
→ commit settlement
```

A procedure is the sole writer that changes its top-level `at` leaf. `requestAbort` changes only `control` (and the lane inbox); inbox admission changes only the lane inbox. Operation state has exactly two supported writers: the procedure and `requestAbort`.

The Lane supplies `continueOperation` and `settleOperation` as today. A terminal decision appends the universal suffix:

1. procedure-specific publication and cleanup writes;
2. `setValue(operationResult(operationId), record)`;
3. idle `laneState` with `currentOperationId: null`, `lastOperationId: operationId`, and the preserved inbox;
4. idle process-local projection;
5. terminal result and event materialization.

The state argument is a type capability established by dispatcher control flow, never compared with current state at runtime.

## 3. Remaining concurrency checks

Keep checks only where another supported writer can change the relevant fact:

1. `requestAbort` versus effect admission and settlement;
2. lane-inbox arrival before a drain point, a summary result boundary, or terminal finish;
3. parallel tool-call statuses and source-ready placement;
4. queued frame/checkpoint writes versus settlement;
5. invocation memo/checkpoint calls versus effect completion;
6. retry timers versus cancellation/close;
7. deferred permit consumption;
8. accept/claim serialization;
9. external/provider/content validation.

Do not reintroduce operation identity, expected-`at`, exact-Drive, or ownership-loss checks into ordinary transitions.

`requestAbort` keeps the two-step gate order: `beginAbort` before the cancellation mutation, commit `cancel_requested`, `signalAbort` after the commit.

## 4. Completed milestones

### M0 — Withdrawn execution-step controls

Complete. Breakpoints, manual drive, and drive deadlines are absent.

### M1–M2 — Foundations and terminal mechanics

Complete. Includes the split effect gate, deterministic gated storage, authoritative process-local Lane projection, commit-result usage totals, progress channels, terminal cleanup, and immutable operation-result observation.

### M3 — Assistant generation and recovery

Complete. Includes `run.starting → run.checkpoint`, assistant ready/intent/effect/settlement, frame persistence and cleanup, configuration failure, unknown-outcome assistant recovery, and response/usage/state atomicity.

### M4 — Retry and deferred

Complete. Includes durable retry waits, local wait policy, one deferred poll permit per pass, unknown-poll replacement under fresh ids, and event-stream-preserving `Models.streamDeferred`.

### M5 — Durable tools

Complete. Includes planned/effect-pending/outcome-ready/completed calls, safe replay, unsafe interruption, invocation memos, bounded checkpoints, completion-order staging, source-order placement, sequential and parallel modes, and tool-reported usage.

### Pre-M6 simplification

Complete. Canonical flat `at` types, `continueOperation`/`settleOperation`, removal of the installer-owned Drive model, and conversion of M3–M5 procedures.

### M6 structural foundation

Committed (`9b23c6583`): `runtime/drive/structural.ts`, `test/harness/runtime/drive-structural.test.ts`, the one-provider-request seams in the compaction modules, threshold routing, overflow preparation, per-request structural intent/usage settlement, hook decisions, structural retry/recovery, and unsummarized navigation commit. Its family cross-product layer (triplicated quadruples, three-armed publishers) is rebuilt by R3; its effect seam, preparation plumbing, threshold/overflow logic, and navigation commit are retained.

## 5. Withdrawn: standalone-compaction inbox and run-continuation promotion

The design that gave `compaction.*` leaves a `RunScope` inbox and a one-way cross-family move into `run.*` at the result boundary is withdrawn. Its problems: a relaxed intent/state invariant with bespoke restore rules, `compact()` resolving with a run outcome that does not fit `CompactionResult`, suppressed `run_start` producing unbalanced event brackets, fused-consumption rules to avoid `cancelQueued` stranding, and promotion-specific arms in reconciliation, cleanup, watch, and admission.

Replacement, spread across this package:

- queued input during any operation is lane-owned (R1) — no operation inbox exists to promote;
- continuation after standalone compaction/navigation is a **second ordinary run operation** with a fresh id, composed in the convenience layer (M8);
- each operation delivers exactly one result; both results are returned by the convenience call and both are durable records (R2).

No code implements promotion. M9 removed the withdrawn design from `harness.md`; this section remains only as the historical decision record.

## 6. R1 — Lane-owned tagged inbox

### Goal

Move all queued input to one lane-owned tagged inbox first (R1a, implemented), then — after R3 — replace the transitional stepwise checkpoint drains with one shared atomic boundary planner (R1b). `Control.drained*` remains until M7 introduces drain-and-return abort; it is not part of inbox ownership.

### R1a — Ownership relocation

- `src/harness/session/types.ts` — durable `LaneState { currentOperationId, inbox }` with `InboxItem { entryId, kind }` replaces `pendingNextRun`; delete `Inbox` and `RunScope.inbox`. Keep `Control.drained*`, `skipInboxOnce`, and `thresholdCheckedTriggerEntryId` temporarily.
- `src/harness/runtime/types.ts` — process-local `LaneState.inbox` replaces `pendingNextRun`; `LanePatch.inbox` pairs durable lane-state replacement with process-local publication.
- `src/harness/runtime/lane.ts` — acceptance selects per tag and mode but places selected items in global admission order, then request prompt entries; it deletes selected pending values and removes their ids atomically with the `LaneBusy` check. A lone queued write never validates acceptance. `append` during any operation enqueues a write-tagged lane item without touching operation state; idle `append` places queued writes first, then the new entry, in one commit. `watch` derives queues and pending writes from the lane inbox.
- `src/harness/runtime/drive/checkpoint.ts` — transitional stepwise drains read and replace the lane inbox rather than operation state. `skipInboxOnce` and `thresholdCheckedTriggerEntryId` continue to protect those temporary multi-commit boundaries.
- `src/harness/runtime/drive/terminal.ts` — operation cleanup never deletes lane-inbox payloads. Staged `outcome_ready` results, drained abort payloads, and other operation-owned addresses are unchanged.
- `src/harness/runtime/drive/{generation,response,deferred,tools,structural}.ts` — `runScopeOf` and scope copies drop `inbox`; ordinary operation-state transitions cannot clobber concurrent input.
- `src/harness/runtime/restore.ts`, fork/legacy normalization, and focused tests use the tagged lane inbox.

### R1b — Shared atomic boundary planner

**Lands after R3**, because pre-R3 the structural result boundary is spread across the triplicated publishers: fusing the planner into three arms and then collapsing them in R3 would be double work, while post-R3 the single `ResultBoundary` switch is exactly one planner call site. The two `CheckpointData` patch fields ride through R3's mechanical rename as inert baggage.

**Core invariant: no boundary decision ever commits back into `checkpoint`.** `checkpoint` is the durable "boundary pending" resting leaf, entered only from settlements, run-start consumption, and deferred redemption. Every exit of its pass is `assistant.ready` (with any placed entries), `summary.deciding`, a placed follow-up + `assistant.ready`, or the terminal transaction.

One shared boundary planner with a process-local `threshold: "check" | "skip"` parameter has exactly two callers:

- the `checkpoint` pass (`threshold: "check"`): select write + steer (modes, global admission order) → threshold guard → continuation → followUp (at `may_finish`) → `before_run_end` → finish; one commit;
- the structural result boundary for `resume_checkpoint` (`threshold: "skip"`): the **same planner runs inside the publication commit** — compaction entry (on success) first, then selected write/steer items, then the routed continuation, all in one transaction. Any placed conversational item routes to `assistant.ready` with that item as trigger, overriding a `may_finish` resume continuation (steer semantics). With nothing queued: `need_assistant` resumes commit `assistant.ready` directly; `may_finish` resumes commit `checkpoint{may_finish}` as the resting leaf and the live pass continues into the finish phases.

**Threshold without the durable marker.** The guard is derived from the branch: threshold fires only when `shouldCompact` holds and the newest compaction entry is older than the trigger entry. A committed threshold compaction is therefore its own marker — any crash re-entry sees the newer compaction and skips. A **declined** threshold compaction publishes no entry and needs no marker: decline never lands on `checkpoint`. The decline decision stays process-local at `summary.deciding` until its single continuation commit (`assistant.ready`, follow-up + ready, or the terminal after `before_run_end`); a crash in that window restores `deciding` and re-runs `before_compaction` under its documented repetition contract. A live decline/recheck loop is structurally impossible because no decline path re-enters the threshold-checking pass.

**`before_run_end` without hooks on the mutation line.** The finish arm is the one multi-phase case: (1) on-line verdict, no commit — reached only at `may_finish` with no eligible write/steer/followUp; (2) hook runs off the line; (3) on-line **replan from current state** — if the inbox gained eligible items or control changed, the stale hook result is dropped and the planner takes the new decision; otherwise the single commit is the follow-up injection (entry + `assistant.ready`) or the terminal transaction. Stale-dropping is replanning, not a version check.

Concrete control trace (post-R3 names; threshold compaction with `may_finish` resume and a steer arriving mid-compaction):

```text
TX1 settlement:  response n7 + usage + tip, S=checkpoint{may_finish, trigger n7}
pass (check):    shouldCompact && newestCompaction < n7 → prepare
TX2:             preparation, S=summary.deciding{boundary: resume_checkpoint{may_finish, n7}}
TX3 (any time):  steer s1 → pendingEntry(s1), laneState.inbox += s1
TX4..n:          deciding → ready → effect_pending → nested request/usage settlements
TX-pub (skip):   insert compaction c1, tip=c1, insert s1 entry (parent c1),
                 delete pendingEntry(s1), laneState.inbox -= s1,
                 S=assistant.ready{trigger s1}          ← one commit, checkpoint never re-entered
…turn answers s1; next settlement → checkpoint{may_finish, trigger n9}
pass (check):    newestCompaction c1 > … tokens small → no threshold; inbox empty; verdict finish
                 → before_run_end off-line → replan: still empty, still running
TX-final:        record + cleanup + laneState{current: null, last: op}
```

Crash between TX4..n and TX-pub → structural recovery (attempt unknown, per existing rules); crash during the hook window → `checkpoint{may_finish}` restored, pass re-runs (threshold skipped by the recency guard), hook re-runs per contract.

Slices, in order (the order is load-bearing — deleting the marker while decline still re-entered `checkpoint` would live-loop):

1. **R1b-1**: fuse the future shared planner into the structural `resume_checkpoint` boundary (`threshold: "skip"`); structural success/decline route directly except for a `may_finish` resting checkpoint, which remains safe for either outcome while the durable marker still exists. Keep the route inline until R1b-2 creates its second caller. Both patch fields are still written and checked by the old checkpoint pass — harmless.
2. **R1b-2**: convert the `checkpoint` pass to single-commit exits with the recency guard, implement the three-phase finish arm, delete `skipInboxOnce` and `thresholdCheckedTriggerEntryId`.

### Rules

- The §1 eligibility table, global placement order, and one-decision-one-commit target are normative.
- Queue modes apply at selection time. Remainders preserve global admission order and are consumed only at later eligible boundaries.
- nextRun items are never consumed mid-run and never block run finish.
- Deferred-suspension enqueue always admits; consumption happens at the post-redemption boundary.

### Focused validation

Enqueue during idle/run/structural/cancelled states always admits; acceptance preserves global order with modes applied and remainders retained; `one-at-a-time` cadence gives each remaining steer its own later boundary; followUp is captured at idle acceptance and only at `may_finish` during a run; a boundary crash before its commit consumes nothing; threshold is checked at most once per boundary by construction; idle append places queued writes first; items survive every terminal status and process loss; `cancelQueued` works at every boundary; watch groups by tag without changing order; no terminal transaction deletes a lane-inbox payload; a lone queued write never validates acceptance.

## 7. R2 — Neutral operation outcome and durable result records

### Goal

Replace the three per-family outcome unions and `laneLastResult` with one immutable per-operation result record. The record **is** the public settled outcome; there is no separate outcome type, no embedded entries, and no hydration.

### Types

```ts
type TerminalStatus = "completed" | "declined" | "aborted" | "failed";

/** Stored at operationResult(operationId) — namespace "pi.result" — by the terminal transaction. Immutable, lane-lived. */
interface OperationResultRecord {
  operationId: string;
  kind: "run" | "compaction" | "navigation";   // meta.intent.kind; matches OperationAdmission.kind
  status: TerminalStatus;
  error?: OperationError;              // status "failed"
  fromTipId: string | null;            // meta.sourceTipId — start of the transcript segment
  tipId: string | null;                // lane tip at terminal — end of the segment
  startedAt: number;                   // Unix ms, from meta
  endedAt: number;                     // Unix ms, Date.now() at terminal planning
}

/** Convenience-only suspension observation for prompt()/resume() (M8). Never stored. */
interface SuspendedRun { operationId: string; status: "suspended"; deferred: DeferredHandle }
```

The record is a disposition plus a pointer to the transcript segment `(fromTipId, tipId]`. It never lists intermediate work (compactions, turns, tools) and never embeds entries. There is **no `tipEntry` and no `OperationOutcome` union**: a caller that wants the payload dereferences `tipId` with the already-public `getEntry`/`findEntry` (for runs, the final message was additionally delivered by `message_end`/`entry_added`). This buys three things: terminal planners perform zero outcome reads, observation cannot fault on a missing entry (a `getEntries` throw inside hydration was a harness-fault path for a read-only convenience), and the future protocol never serializes `Entry` inside results — a result frame is eight flat fields. `SuspendedRun` is the one non-terminal observation, exists only on convenience returns, and carries nothing derivable elsewhere.

### Files

- `src/harness/session/types.ts` — add the record; delete the `LaneLastResult` union; `LaneState` gains `lastOperationId: string | null`; delete `failure_drain`, `RunFailureDrainOperation`, and `FailureProvenance`.
- `src/harness/session/values.ts` — `operationResult(operationId) = value<OperationResultRecord>("pi.result", operationId)`; delete `laneLastResult`. The `pi.op.*` lifetime grammar stays total: no operation-lived namespace survives its terminal transaction.
- `src/harness/agent-harness.ts` — delete `RunOutcome`, `CompactionOutcome`, `NavigationOutcome`, `OptionalFinalAssistant`, `TerminalOperationOutcome`, `ResumeOutcome`, and the transitional `OperationOutcome` union; `DriveOutcome.settled` carries `OperationResultRecord` directly (no duplicate `operationId` field); result aliases become
  `RunResult = Result<OperationResultRecord | SuspendedRun, …>`,
  `CompactionResult = Result<{ compaction: OperationResultRecord; run?: OperationResultRecord | SuspendedRun }, …>`,
  `NavigationResult = Result<{ navigation: OperationResultRecord; run?: OperationResultRecord | SuspendedRun }, …>`,
  `ResumeResult = Result<OperationResultRecord | SuspendedRun, …>`;
  `QueueResult` loses `NoActiveRun` and absorbs `NextRunResult`. `SuspendedRun` is declared here but constructed only by M8 convenience paths.
- End-event payloads, one shape per event type: `run_end` and `navigation_end` carry `{ runId, status, error?, fromTipId, tipId }`. `compaction_end` is a segment event, not a terminal event — it also closes in-run threshold/overflow brackets — and always carries `{ runId, reason, status: "completed" | "declined" | "failed" | "aborted", error?, entryId? }`, where `entryId` names the compaction entry on success. Embedded `entry`/`summaryEntry`/final-assistant fields are dropped everywhere (`entry_added`/`message_end` already delivered payloads).
- `src/harness/runtime/types.ts` — `FinishDecision` carries the record instead of `lastResult`.
- `src/harness/runtime/lane.ts` — terminal suffix per §2; `getLastResult` is replaced by `getResult(operationId, context): Promise<OperationResultRecord | undefined>` — one `getValue`, nothing else; `inspectExecution` reports `lastOperationId` only.
- `src/harness/runtime/drive/terminal.ts` — `hydrateTerminalOutcome`/`hydrateOperationOutcome` are deleted outright; the file keeps only `operationCleanupWrites` and the `operationResultRecord` constructor. Finish decisions materialize `{ kind: "settled", outcome: record }` from the record they already built — no reader dereference inside any terminal planner.
- `src/harness/runtime/drive/{checkpoint,response,structural,recovery,deferred,tools}.ts` — every finish decision constructs the record; `runCompletion`, per-family last-result construction, and final-assistant plumbing in results are deleted. Every former `failure_drain` producer instead commits terminal failure directly: response publication and cleanup stay in the same transaction, in-run structural failure closes `compaction_end` then `run_end`, and queued lane input remains untouched for a later ordinary run. (`latestAssistantEntryId` stays in scope for cancellation classification and checkpoint logic; it just no longer feeds results.)
- `src/harness/runtime/restore.ts` — restore `lastOperationId`; attachment never reads records.
- Focused tests.

### Rules

- Records are written exactly once, by the terminal transaction, and never deleted, updated, or read by recovery.
- Terminal-control invariant (§1): a terminal transaction under durable `cancel_requested` records `aborted`; no path commits any other status under cancellation. M7 adds the enforcing test; M9 adds the Part 9 invariant.
- Forks exclude `pi.result` values.
- `drive(id)` arms: current → install/join; record → returned directly; neither → `OperationMismatch`.

### Focused validation

Record written for every terminal path of every operation kind and status; `drive(id)` returns records for arbitrarily old ids across reopen; `getResult` is a plain value read returning the record or `undefined`; no terminal planner or observation path reads entries for the result; `lastOperationId` restore; suspension never stored; fork exclusion; segment pointers correct (`fromTipId` = pre-acceptance tip, including navigation); `compaction_end` closes both standalone and in-run brackets, including `aborted` via reconciliation; each former failure-drain producer finishes in one transaction and preserves every lane-inbox item for a later run.

## 8. R3 — Family-neutral leaves and structural rebuild

### Goal

Collapse 22 leaves to the 13 in §1; rebuild `structural.ts`'s state-shape layer on one summary quadruple with an explicit result-boundary datum.

### Types

```ts
interface OperationScope { control: Control; settings: RunSettings; latestAssistantEntryId: string | null }

type ResultBoundary =                                  // closed; do not extend
  | { kind: "resume_checkpoint"; resumeAfter: CheckpointData }   // in-run threshold/overflow
  | { kind: "finish" }                                            // standalone compaction
  | { kind: "commit_navigation"; targetId: string; label?: string };

interface SummaryTask {
  taskId: string;
  reason?: "manual" | "threshold" | "overflow";
  customInstructions?: string;
  boundary: ResultBoundary;
}
```

The summary algorithm kind is **derived from the boundary** (`resume_checkpoint`/`finish` → compaction; `commit_navigation` → branch summary); it is not stored, so no contradictory kind/boundary combination is representable. `summary.ready/effect_pending/retry_wait` additionally carry the generation snapshot (result entry id, configuration, stream options, retry policy, attempt counters); the snapshot drops the `taskId`/`kind`/`reason` fields it previously duplicated. Canonical declarations land in `session/types.ts`. Uniform scope means compaction/navigation acceptance captures `settings` exactly like run acceptance; `latestAssistantEntryId` stays null for structural intents.

### Reachability (restore check; replaces the intent-prefix check)

| Intent | Admissible leaves |
| --- | --- |
| run | `starting`, `checkpoint`, `assistant.*`, `tools`, `deferred.*`, `summary.*` with boundary `resume_checkpoint` |
| compaction | `summary.*` with boundary `finish` |
| navigation | `navigation.ready_to_commit`; `summary.*` with boundary `commit_navigation` |

Forbidden and unreachable by construction (assert in tests, never implement): any edge into `starting` or `navigation.ready_to_commit` other than acceptance; `summary.*` → `tools`/`assistant.*` directly; `navigation.ready_to_commit` → `summary.*`; terminal → anything.

### Result-boundary rule

Every summary boundary (hook decline, hook-supplied result, generated success, terminal generation failure, model unavailability) plans on the mutation line and switches on `boundary` in one visible place:

- `resume_checkpoint` → publish result and restore the marked checkpoint on success or threshold decline; overflow decline or structural failure closes the compaction bracket and terminal-fails the run in the same commit;
- `finish` → publish the compaction entry and terminal-complete (or terminal declined/failed) in one commit;
- `commit_navigation` → the single move/summary/label/terminal commit (or terminal declined/failed).

A `cancel_requested` boundary defers to reconciliation and never takes its continuation.

### Files

- `src/harness/session/types.ts` — the 13-leaf union, `OperationScope`, `SummaryTask`, `ResultBoundary`; delete `RunScope`, `CompactionScope`, `NavigationScope`, `NavigationSummaryScope`, `RunCompactionScope`, `StructuralTask`, per-family `Extract` aliases, `isRunOperationState`.
- `src/harness/runtime/drive/structural.ts` — rebuild: keep `durableCompactionPreparation`/readers, the nested request seam, `performStructuralAttempt`, `runCompactionThreshold`, `prepareOverflowCompaction`, `commitNavigation`; delete the seven union aliases, the `startsWith` guards, and the three-armed `effectPendingFromReady`/`retryWaitFromEffect`/`readyFromRetryWait`/`publishStructuralReady`/`publishStructuralDecline`/`publishStructuralFailure`/`publishCompactionResult`-vs-`publishNavigationSummary` split; one quadruple of converters plus one boundary switch replace them.
- `src/harness/runtime/drive/{checkpoint,generation,response,recovery,deferred,tools,tool-placement,terminal}.ts` — leaf literal renames (`run.checkpoint` → `checkpoint`, …); `response.ts` overflow arm constructs `summary.deciding` with `resume_checkpoint`; no other behavior change.
- `src/harness/runtime/progress.ts` — frame/checkpoint fences currently match the leaf literals `"run.assistant.effect_pending"`, `"run.deferred.effect_pending"`, and `"run.tools"`; retarget them to the neutral leaves.
- `src/harness/runtime/restore.ts` — reachability predicate above.
- `src/harness/runtime/lane.ts` — `capturedModel` and `watch` switch over the neutral leaves; acceptance writes neutral initial leaves.
- `docs/runtime-simplification.md` — replace the 22-leaf list and status.
- `test/harness/runtime/drive-structural.test.ts` and other focused tests — retarget; behavioral assertions survive.

### Focused validation

Everything the M6 foundation covered, re-expressed over neutral leaves, plus: reachability accept/reject matrix (including corrupted boundary/intent combinations faulting restore); each boundary arm × {success, hook result, decline, failure, model absence} × {running, cancelled}; a post-terminal leak scan asserting every `pi.op.*` address is gone for every leaf while the `pi.result` record is present; crash/reopen at every leaf under every intent that can reach it.

## 9. M7 — Cancellation reconciliation and total switch

### Goal

**Implemented and reviewed.** Make the internal graph total without public wiring.

Create `src/harness/runtime/drive/reconcile.ts`, `src/harness/runtime/drive.ts`, and focused reconciliation and switch tests.

### `requestOperationAbort`

Package-private expected-id primitive:

1. reject with `OperationMismatch` when the expected id is not the current durable operation, including when that id already has a settled result record;
2. synchronously `beginAbort` on a matching live Drive;
3. one commit on the Session line: `control = cancel_requested` (with no drained fields) **plus** removal of steer/followUp-tagged ids from the lane inbox and deletion of their `pendingEntry` values; payloads are read in the same mutation and returned; nextRun/write items stay;
4. `signalAbort` after the commit;
5. after a newly requested abort commits, publish `{ type: "operation_abort", operationId, steer, followUp }` and return once cancellation is durable. This family-neutral event replaces `run_abort`/`runId`; the lane snapshot already identifies the operation kind. Repeat calls against the same current cancelled operation publish nothing, drain nothing further, and report `newlyRequested: false`.

With no Drive but a matching current durable operation, it commits the same marker and starts no pass. There is no `control.drained*`; the drained payloads exist only in the returned result (accepted loss: a crash inside the abort window loses their content).

### Reconciliation

Checked before `before_drive` and ordinary dispatch; a single switch over the 13 leaves; never starts new ordinary work. It must handle:

- assistant and deferred effects with live or reconstructed results;
- planned/effect-pending/outcome-ready tool calls;
- structural process-local results (discarded unless already atomically published);
- cancelled summary boundaries finishing `aborted` without taking their `ResultBoundary` continuation;
- retry waits, checkpoints, and suspended deferred work;
- best-effort deferred-provider cancellation using the Drive's close-only signal, never its already-triggered operation-abort gate;
- the aborted terminal transaction (result record `status: "aborted"`);
- the terminal-control invariant test: no terminal path commits a non-aborted status under cancelled control (this keeps §10's continuation rule decidable from the record alone).

Queued lane-inbox items are **not** applied or deleted by reconciliation; nextRun/write items simply remain queued.

Each Drive owns a private close controller and exposes its signal to mandatory cleanup. `closeGate()` aborts that controller on harness close or fault; operation abort does not. Deferred-provider cancellation uses this close-only signal, so the cleanup request can start after durable operation cancellation but cannot outlive harness shutdown. Do not add a harness-global cancellation controller.

### Total switch

`runtime/drive.ts` owns one direct `state.at` switch over 13 leaves. It imports only complete procedure modules. No graph table, action interpreter, ownership-loss arm, external-finalization arm, or storage-state reload. A `continue` result must correspond to a replaced `Lane.state` projection **or** to currently observable `cancel_requested` control, which the switch routes to reconciliation before ordinary dispatch; any other unchanged continuation is an invariant defect.

Public methods remain guarded through M7.

## 10. M8 — Public surfaces

**Implemented.** Execution guards were removed only after every leaf and reconciliation path became total.

Order:

1. admit compaction/navigation requests (acceptance captures `settings`; writes the R3 entry leaves);
2. implement `drive` install/join/record lookup (three arms, §7);
3. expose `requestAbort`;
4. add convenience compositions;
5. add queues/configuration/usage/idle surfaces;
6. retain `watchSession` as the sole `SliceNotImplemented` method.

### Queues

`steer`/`followUp`/`nextRun` are tag sugar over one enqueue and always admit. `queue_update` and `LaneSnapshot.queues` expose the same tagged ordered inbox, including pending writes; clients group by tag without reordering it.

### Client replication surface

Findings from a working RPC-shaped client replica (mini TUI exercise) fold in here. The goal is one testable contract: a remote client renders exclusively from a replicated `LaneSnapshot` and the event stream, with no side-channel getters.

- **Normative reducer.** Export `reduceLaneSnapshot(snapshot, event): LaneSnapshot | { rebase: true }` from `packages/agent`. It is the single supported event fold: in-run `compaction_start`/`compaction_end` are segments and must not clear `operation` (the fold knows the open operation's kind, so no event field is needed); `run_suspend` keeps `operation` non-null with `deferred` set; only `run_end`, `navigation_end`, and `compaction_end` under a compaction-kind operation are operation-terminal. `navigation_end` returns `{ rebase: true }` because the moved tip may lie outside the replica. Conformance assertion: for every non-navigation flow, folding a `watch()` snapshot over its own event stream equals a later `watch()` snapshot — this equivalence test is what keeps the event vocabulary complete.
- **Snapshot completeness.** `LaneSnapshot` gains `configuration: LaneConfiguration`, `lastResult?: OperationResultRecord` (replacing the bare `lastOperationId` field), a real `faulted` flag (the current hardcoded `false` is a defect), and session `stats: SessionStats` as the usage baseline (usage events already carry `totals`; the snapshot supplies the value before the first event).
- **Replicable configuration events.** Every `config_update` variant whose value is data carries `value`/`previous` (`streamOptions`, `retryPolicy`, `compactionSettings`, `steeringMode`, `followUpMode`, plus the existing lane variants); `tools`/`resources` remain notification-only because registries are code — clients re-fetch names.
- **Identity-based `setModel`.** `setModel` accepts `ModelIdentity` (`{ provider, modelId }`); a live `Model` object is a process-local registry concern, and an unregistered identity fails in-band at generation exactly like any registry absence.
- **Re-basing.** `WatchHandle.resnapshot(context): Promise<LaneSnapshot>` captures a fresh snapshot on the mutation line, serialized against the same stream — the recovery path after `{ rebase: true }` with no teardown/re-subscribe choreography.
- **Start-event timestamps.** `run_start`/`compaction_start`/`navigation_start` carry `startedAt` (operation starts: `meta.startedAt`; in-run segment starts: the commit timestamp), so folds never invent times.

### Convenience compositions and continuation

- `prompt`/`skill`/`promptFromTemplate`: accept + drive; return `Result<OperationResultRecord | SuspendedRun, …>` — the record for terminal outcomes, `SuspendedRun` when the run defers.
- `compact`/`navigateTree`: accept A + drive A. If A settled with status `completed`, `declined`, or `failed` and eligible steer/followUp/nextRun items exist, accept a continuation run B with the **public empty-prompt request** (`{ kind: "prompt", prompt: "" }`): acceptance places no request messages and is legal exactly when its capture places at least one conversational item; `OperationMeta.intent` is an ordinary run intent with empty `promptEntryIds`. Then drive B and return `{ compaction|navigation: A, run?: B }`. Never after `aborted`: abort already drained steer/followUp, and the terminal-control invariant (§7) makes `status ∈ {completed, declined, failed}` imply the operation was never durably cancelled, so the rule is decidable from the record alone. B is an ordinary run — it emits `run_start`, runs `before_run` (with `prompt: []`, the existing captured-only acceptance shape), and owns the full run graph with no continuation-aware special case.
- Continuation races: a competing accept that wins the idle window captures the queued input into its own run; the continuation accept then fails empty (`InvalidMessage`) or `LaneBusy`, and the convenience returns A without `run`. Both histories are valid. A crash between A's terminal and B's acceptance leaves the items queued; no auto-start on reopen.
- `resume`: inspect + drive current id, one deferred-poll permit; returns `OperationResultRecord | SuspendedRun`.
- `abort`: inspect + `requestAbort` + ensure a reconciliation pass; returns the drained steer/followUp payloads.
- `getResult(operationId)`: public.
- Equivalence: every convenience call ≡ its primitive composition using only public request kinds (`compact()` with continuation ≡ `accept(A); drive(A); accept({ kind: "prompt", prompt: "" }); drive(B)`), byte-identical writes and events — externally reproducible by any scheduler.

### Focused validation

One install and same-id joins; stale-id isolation; record lookup for old ids; caller cancellation before/after installation; close/fault during cooperative and non-cooperative effects; accept/drive vs convenience equivalence including continuation via the public empty-prompt request; steer-only, followUp-only, and nextRun-only continuation each start run B; both continuation race orders; abort drain-and-return including the both-orders abort/settlement race; enqueue during every state through public surfaces; full crash matrix across all 13 leaves; no unhandled detached rejection; no `SliceNotImplemented` except `watchSession`; reducer fold-equivalence across every non-navigation flow (including in-run compaction segments, suspend/resume, retry waits, and reattach mid-stream); `navigation_end` fold returns rebase and `resnapshot` restores equivalence; snapshot `configuration`/`lastResult`/`faulted`/`stats` replicate through events alone.

## 11. M9 — Documentation reconciliation

**Implemented.** `docs/harness.md` is reconciled to the runtime and normative on its own. Updated sections include:

- §1.3 address table and lifetime grammar: new lane-lived `pi.result` namespace, `laneLastResult` removed, `LaneState.inbox`/`lastOperationId`; `pi.op.*` stays strictly operation-lived;
- §1.7 JSONL/SQLite examples referencing `pi.lane.lastResult`; state the bounded growth tradeoff — one small immutable record per operation, retained forever, carried through JSONL snapshot compaction;
- §2.9 precise rewrite: decide and document the policy for records whose `tipId` the rewrite removes (retain-dangling or delete);
- §3.1–§3.2 state shapes: 13 neutral leaves, `OperationScope`, `SummaryTask`/`ResultBoundary` (kind derived from boundary), `Control` without drained fields, `CheckpointData` without `skipInboxOnce`/`thresholdCheckedTriggerEntryId`;
- §3.5 graph (one summary quadruple, boundary arms);
- §3.6 acceptance: per-tag mode-respecting selection, global admission-order placement, prompt entries last, idle followUp eligibility, and empty-prompt continuation acceptance;
- §3.9/§3.10 summary machinery expressed once over the boundary datum;
- §3.11 complete rewrite: one lane inbox, the selection table, one-decision-one-commit boundaries, silent deferral of late steer (an unconsumed steer becomes future-run input rather than an error), and unbounded write pendency during structural operations with the `waitForIdle`-then-append escape hatch;
- §3.12 checkpoint procedure: the one-commit boundary decision replaces the stepwise algorithm; failures terminalize while queued lane input remains for a later ordinary run;
- §3.13 terminal transactions: result records, universal suffix, observation contract (`drive(id)` total, `getResult`);
- §4.6 abort: drain-and-return, no drained control, and the client-visible consequence — drained steer/followUp payloads exist only in the returned result, so a crash or lost response in that window loses their content permanently;
- §5.1 lane surface and all result types; §5.5 `queue_update` and end-event payloads (`compaction_end` as a segment event with `aborted`);
- Part 9: invariants 12–16, 21, 26 (result-record lifetime, observation via records, continuation equivalence), the new terminal-control invariant (a non-aborted terminal status implies running terminal control), and the race catalog rows touching drained items, `cancelQueued`, and continuation;
- Appendix A glossary (Inbox, Result record, Continuation run, Boundary pass; remove Drained);
- §5.5 event taxonomy: state explicitly which events are operation-terminal (`run_end`, `navigation_end`, compaction-kind `compaction_end`) versus segment brackets (in-run `compaction_start`/`compaction_end`) versus non-terminal lifecycle (`run_suspend` leaves the operation durably open), and name `reduceLaneSnapshot` as the normative fold;
- §2.5 branch-scan sharp edge: `stopAtType` applies after ordering, so `oldestFirst` + `stopAtType: "compaction"` returns the oldest segment; document the canonical context read as `newestFirst` + reverse;
- serving-layer boundary statement: branch-relative reads/appends remain on `AgentLane`, while whole-tree browsing, forks, label inventory, and session listing live beside it in Session/repository services composed by an RPC facade.

Also update `docs/runtime-simplification.md` status and remove every remaining promotion reference in the repository's docs. Grep gate:

```bash
rg -i 'promotion|drainedSteer|drainedFollowUp|laneLastResult|lastResult|skipInboxOnce|thresholdChecked' packages/agent/src packages/agent/docs
```

(matches must be zero in `src`; docs may retain historical notes only inside completed-milestone records.)

## 12. M10 — Provider KV-cache identity review

### Goal

**Implemented and reviewed.** Core Session identity alone is not a valid provider cache lineage: several lanes may issue concurrent requests over divergent transcripts. Ordinary assistant requests therefore derive identity from Session metadata id plus lane name; structural requests remain isolated.

### Review scope

- Inventory every harness and pi-ai path that sets, preserves, derives, or consumes `SimpleStreamOptions.sessionId`, including prompt-cache keys, affinity headers, WebSocket/session-resource caches, deferred requests, and structural summary requests. Ordinary harness generation now forwards the derived lane identity; legacy `src/agent.ts` keeps its independent conversation id; structural summary requests mint fresh ids.
- Define a provider-request cache lineage distinct from the durable Session id and operation id. Concurrent lanes must never share one lineage merely because they belong to the same Session.
- Derive ordinary assistant lineage as `Session metadata id + ":" + lane name`; do not store another durable identifier. It remains stable for the lane's lifetime and differs across lanes in one Session.
- Preserve same-lane reuse across ordinary assistant turns and retries. Compaction, navigation, branch replacement, and model changes may miss an old prefix, but cannot incorrectly reuse it; do not add rotation machinery.
- Keep structural summary requests isolated: `cacheRetention: "none"` and fresh request identity per nested request remain the baseline unless the review proves a safe, useful alternative.
- Distinguish cache identity from observability correlation. Session, lane, operation, task, and request ids remain available to telemetry without being reused blindly as provider affinity/cache keys.
- Review provider-specific semantics rather than assuming `sessionId` means only KV caching; some adapters also use it for headers, WebSocket reuse, fallback state, or resource cleanup.

### Focused validation

- Two active lanes in one Session issue concurrent, divergent prompts and receive distinct provider cache/affinity identities.
- One lane keeps a stable lineage across append-only assistant/tool turns where reuse is valid.
- Context-prefix discontinuities safely miss old cached prefixes without lineage rotation.
- Assistant retries retain the lane identity; deferred handle polling needs no cache identity.
- Structural split-turn requests remain isolated from transcript assistant caching.
- Faux-provider tests assert stable same-lane and distinct cross-lane request identities.

### Exit condition

Ordinary assistant requests use the derived lane identity, structural requests keep fresh identities with `cacheRetention: "none"`, and deferred handle polling sends no cache identity. The policy is documented in `docs/harness.md` and independently reviewed before WP05 completion.

## 13. Mobile assistant-output handoff

**Tracked follow-up; not part of the M8/M10 public-drive gate.** A trivial mini coding-agent Session produced an approximately 300 KB JSONL file because live assistant streaming persists many `pi.pending.assistant_frame` list appends. Logical frame cleanup does not reclaim bytes already appended to the JSONL history, so short conversations can have disproportionate durable storage and replay cost.

The authoritative follow-up is the [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) and its numbered prerequisites in the [mobile handoff README](../mobile-handoff/README.md). It addresses the complete path rather than only batching frames: Chord op tracking, scoped pending-output durability, tool/assistant output reduction, and `message_update` replication amplification. Preserve the existing crash contract: an admitted assistant effect remains reconstructible, progress observation remains useful, and settlement retires operation-owned pending state.

Exit checks:

- representative short streamed responses do not create hundreds of kilobytes of durable frame history;
- crash/reopen at every assistant and deferred effect boundary reconstructs the same pending message;
- frame/checkpoint writers remain fenced to the owning durable effect;
- backend conformance covers both reconstruction and bounded write amplification.

## 14. Module boundaries

```text
session/**             durable storage; imports no runtime module
execution/**           neutral provider/tool/gate mechanics
runtime/types.ts       LaneState, Drive, command decisions
runtime/progress.ts    frame/tool progress channels
runtime/drive/*.ts     direct procedures
runtime/drive.ts       total flat switch, created only in M7
runtime/lane.ts        Lane actor and public surfaces
runtime/harness.ts     Harness lifecycle and Lane composition
```

Procedure modules import concrete `Lane<TContext>` type-only. `TContext` remains `object | undefined` invariant. No `any`, `Lane<any>`, `as unknown as`, `@ts-expect-error`, inline imports, parameter properties, enums, or other non-erasable TypeScript syntax.

## 15. Exclusions

Do not introduce:

- generic scheduler, graph, action interpreter, or effect-plan DSL — `ResultBoundary` stays a closed three-arm data union switched in one visible place;
- per-family outcome unions, `OptionalFinalAssistant`, or embedded result entries in stored records;
- result-record listing, filtering, pagination, status queries, or retention machinery;
- operation-owned queues, drained-control fields, or terminal queue cleanup;
- automatic continuation anywhere below the convenience layer (never inside `drive`);
- a second mutation line or transaction framework;
- expected-`at` runtime checks for the sole top-level writer;
- process-local Drive replacement or caller-owned lifetime;
- external finalization;
- storage rereads of authoritative control state;
- read caches, read budgets, or generic `getValues` batching;
- compatibility aliases for any pre-redesign durable shape;
- a `phase`/segment discriminator field on structural events — the reducer derives segment-vs-terminal from the open operation's kind;
- whole-tree, fork, label-inventory, or repository methods on `AgentLane`; branch-relative reads/appends remain part of the lane facade, while broader administration lives beside it.

Procedure-specific writes, effect admission, settlement classification, and event construction remain visible at their call sites.

## 16. Validation and reviews

After every code stage:

```bash
npm run check
```

Run each modified focused test file from the package root. Do not invoke the full Vitest suite directly. Run `./test.sh` only for final package validation or when explicitly requested.

Review checkpoints are mandatory at the end of R3, R1b, M7, M10, and final completion. Delegated reviews use provider `anthropic` and model `claude-fable-5`.

Final greps:

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome|OperationEnded' \
  packages/agent/src/harness packages/agent/test/harness
rg 'drainedSteer|drainedFollowUp|laneLastResult|RunOutcome|CompactionOutcome|NavigationOutcome|TerminalOperationOutcome|skipInboxOnce|thresholdCheckedTriggerEntryId' \
  packages/agent/src/harness
rg 'SliceNotImplemented' packages/agent/src/harness/runtime
rg ': any\b|<any>|as unknown as|@ts-expect-error' packages/agent/src/harness/runtime
```

Final exit conditions:

- every flat leaf is driveable and reconcilable;
- public primitive/convenience behavior is equivalent, including continuation;
- every focused test and backend conformance path passes;
- public drive exposes no partial graph;
- `watchSession` is the only deferred public method;
- `drive(id)` answers every settled operation id in the session;
- harness.md is self-consistent with the implementation (M9);
- provider cache/affinity identity is lane-safe across concurrent and context-reset histories (M10);
- independent final review reports no blocker.
