# Harness v2 promotion test matrix

QA1 inventory for tests removed by `44289550a feat(agent): promote durable harness API`.

This document maps each removed test case to one of the QA1 outcomes:

- **Covered** — the behavior is already covered by v4 conformance or another current test.
- **Ported** — the case was rewritten under the v4 API or moved to the SQLite package.
- **Inapplicable** — the old API, implementation detail, or compatibility path was intentionally deleted.
- **Uncovered** — the behavior may still be required but cannot be ported until a named implementation package lands. QA revisits it afterward; implementation packages derive their own tests from the design and do not use this matrix.

No production or test changes are part of QA1.

## Summary

| Area | Removed cases | Status |
|---|---:|---|
| Harness runtime and stream behavior | 37 | Mostly uncovered by design while `AgentHarness` is scaffolded; assigned to H/L/I/C/N packages. Scaffold-safe configuration is covered by F0. |
| Branch query and corruption behavior | 6 | Core query semantics are covered; bounded SQLite validation gaps were ported by QA2, and JSONL corruption behavior is covered by J3. |
| Compaction helper behavior | 2 | Covered by current compaction/context tests. |
| Memory/SQLite v4 conformance entrypoints | 3 | Ported to `packages/agent/test/harness/session/*` and `packages/session-backends/sqlite-node/test/conformance.test.ts`. |
| Repository/backend lifecycle and JSONL behavior | 38 | Format-4 lifecycle and crash/corruption behavior are covered by v4 conformance and J0–J3; format-3 normalization and conversion remain assigned to J4–J5. |
| Session aggregate/context behavior | 17 | Covered by v4 conformance plus current context tests. |
| SQLite search | 1 | Ported to SQLite package search tests; old scanning backend is inapplicable. |

## Harness runtime and stream tests

Removed files:

- `packages/agent/test/harness/agent-harness-stream.test.ts`
- `packages/agent/test/harness/agent-harness.test.ts`

The promotion intentionally replaced the behavior-complete legacy harness with the v2 scaffold. Runtime operation methods must reject with `HarnessNotImplemented` until their owning packages land; see the public method ownership table in `harness-v2.md` section 20.

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| snapshots stream options before provider request hooks | Uncovered | H1/H4 after I1/I4/L3: assistant request execution must snapshot stream options and run request hooks. |
| chains provider request patches and supports deletion semantics | Uncovered | I1 + I4 own hook aggregation/effect adapter; H1 covers run integration. |
| uses updated stream options for save-point snapshots without mutating the active request | Uncovered | H3/H4/H6: checkpoint/deferred configuration behavior and tool continuation snapshots. |
| chains provider payload hooks | Uncovered | I1 + I4, then H1 request integration. |
| constructs directly and exposes queue modes | Covered / Inapplicable | Direct construction is intentionally replaced by `AgentHarness.create()`. Queue-mode defensive configuration is covered by `agent-harness-scaffold.test.ts` (`keeps scaffold-safe configuration as defensive copies`). |
| rejects waiting before shutdown is requested | Inapplicable | Legacy shutdown API was deleted. `waitForIdle` belongs to H5 and currently rejects by F0 scaffold tests. |
| shuts down active work permanently and idempotently | Uncovered | H5 owns close/abort/wait settlement. |
| allows a hook to request shutdown without deadlocking its operation | Uncovered | H5 after I1/I2 owns close/abort settlement from hooks/events. |
| allows a subscriber to request shutdown without deadlocking its operation | Uncovered | H5 after I2 owns passive-listener settlement. |
| does not start a provider request when shutdown occurs during before_agent_start | Uncovered | H1/H5 after I1: before-run hook cancellation/close behavior. |
| aborts and awaits active compaction without persisting its result | Uncovered | H5 + C1: abort reconciliation for compaction. |
| aborts and awaits active tree navigation without moving the session leaf | Uncovered | H5 + N1: abort reconciliation for navigation. |
| does not treat concurrent mutations as active operations | Uncovered | I3 lane mutation line and H4 deferred writes/configuration. |
| awaits concurrent idle session mutations before shutdown resolves | Uncovered | I3/H5: mutation-line settlement before close. |
| shuts down an idle harness without modifying its durable session | Covered / Uncovered | F0 covers scaffold `close()` and record-free create. H5 must cover durable runtime close with no writes. |
| drains one queued steering message at a time and emits queue updates | Uncovered | H3 queues/checkpoints/events. |
| appends before_agent_start messages and persists them | Uncovered | H1 `before_run` initial message capture. |
| abort clears steer and follow-up queues but preserves next-turn messages | Uncovered | H5 durable abort queue draining; H3 owns queue state. |
| drains follow-up messages one at a time after the agent would otherwise stop | Uncovered | H3 checkpoint finish-boundary conditionals. |
| settles thrown hook failures with persisted assistant error messages | Uncovered | I1 hook isolation + H1/H2 terminal failure entries. |
| refreshes model, thinking level, resources, system prompt, and active tools at save points | Uncovered | H3/H4/H6 checkpoint and deferred configuration behavior. |
| orders pending listener session writes after agent-emitted messages | Uncovered | H4 deferred writes plus I2 listener delivery. |
| waitForIdle waits for external run settlement and awaited listeners | Uncovered | H5 after I2. |
| runs tool_call and tool_result hooks through the direct loop | Uncovered | L2/L3 tool phases, I1 hooks, H6 durable tool events. |
| passes a static application context to harness tools | Uncovered | I4 effect-context threading and H6 tool execution. |
| resolves async tool context providers for each turn snapshot | Uncovered | I4/H6. |
| persists generated compaction usage | Uncovered | C1 manual compaction operation. |
| persists hook-provided compaction usage | Uncovered | C1 with I1 hooks. |
| retries transient compaction errors and emits retry events | Uncovered | C1/C3 retry and event integration. |
| does not retry non-retryable compaction errors | Uncovered | C1/C3. |
| exhausts transient compaction retries after maxRetries failures | Uncovered | C1/C3. |
| retries transient branch summary errors and emits retry events | Uncovered | N1 navigation/branch-summary resume and retry behavior. |
| persists generated branch summary usage | Uncovered | N1. |
| persists hook-provided branch summary usage | Uncovered | N1 with I1 hooks. |
| preserves app tool types for getters and update events | Covered / Uncovered | Getter defensive copies are covered by F0 scaffold tests. Persisted active-tool selection and update events belong to H4/O1. |
| validates constructor tool names | Uncovered | H4 owns tool registry plus persisted active-tool validation. |
| preserves app resource types for getters and update events | Covered / Uncovered | Getter defensive copies are covered by F0 scaffold tests. Resource update events belong to O1/H0 event wiring. |

## Branch query and corruption tests

Removed file: `packages/agent/test/harness/branch-query.test.ts`.

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| provides identical in-memory query semantics | Covered | v4 backend conformance: `supports bounded filtered and cursor-based queries`; memory conformance runner. |
| rejects corrupt parent chains in array-backed readers | Covered / Inapplicable | The old array-backed reader type was deleted. The v4 JSONL equivalents are covered by `jsonl.test.ts`: `rejects an imported entry that references a missing parent` covers missing-parent replay, and `rejects a lane-bound entry that does not chain to the lane leaf` covers lane-tail parent chaining. Cycle parity is inapplicable for v4 JSONL replay because entries cannot reference future parents during sequential replay. |
| provides identical JSONL query semantics | Covered | J1/J2 JSONL v4 storage/repository tests plus backend conformance cover normal bounded branch queries. |
| does not decode SQLite branch entries outside query bounds | Covered | Ported to `packages/session-backends/sqlite-node/test/branch-query.test.ts`: `does not decode entries outside bounded branch queries` corrupts an out-of-bounds payload and branch-cache membership, proves bounded reads decode only requested rows, and proves an unbounded read still rejects the broken chain. |
| validates SQLite entries before filtering and limiting branch results | Covered | Ported to `packages/session-backends/sqlite-node/test/branch-query.test.ts`: `validates entries before branch query filters and limits` proves corrupt in-window entries reject before `type`, `customType`, and `limit` filtering can hide them. |
| does not validate SQLite ancestors beyond newest-first stop bounds | Covered | Ported to `packages/session-backends/sqlite-node/test/branch-query.test.ts`: `does not validate ancestors beyond newest-first stop bounds` proves `stopAtId` and `stopAtType` reads can return a valid suffix while unbounded reads still reject missing-parent and cyclic ancestor corruption. |

## Compaction helper tests

Removed cases from `packages/agent/test/harness/compaction.test.ts` during promotion.

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| falls back to firstKeptEntryId when a compaction has no retained tail | Covered | Current `session/context.test.ts` covers empty `retainedTail` context behavior; current compaction tests cover cut-point and retained-tail preparation. |
| prepares custom and branch summary entries for summarization | Covered | Current `compaction.test.ts` covers token estimation across custom, compaction, and branch-summary roles; `session/context.test.ts` covers custom projection and branch-summary context. |

## v4 conformance entrypoint tests

Removed/renamed files:

- `packages/agent/test/harness/experimental/session/memory.test.ts`
- `packages/agent/test/harness/experimental/session/sqlite.test.ts`

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| experimental memory conformance dynamic cases | Ported | `packages/agent/test/harness/session/memory.test.ts` runs the current v4 backend conformance suite. |
| uses one injectable id generator across lane views | Covered | `packages/agent/test/harness/session/memory.test.ts` keeps this focused v4 memory case. |
| experimental SQLite conformance dynamic cases | Ported | `packages/session-backends/sqlite-node/test/conformance.test.ts` runs the current v4 backend conformance suite. |

## Repository/backend lifecycle and JSONL tests

Removed files:

- `packages/agent/test/harness/repo.test.ts`
- `packages/agent/test/harness/session-backends.test.ts`

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| opens, deletes, and forks by metadata (memory) | Covered | v4 conformance: `creates lists and opens sessions`, `deletes sessions idempotently`, fork cases. |
| delegates full-session fork selection without opening the source | Inapplicable | Old repository optimization was deleted; v4 fork behavior is covered by conformance. |
| retains the opened aggregate instead of reloading for scoped reads | Inapplicable | Old aggregate caching detail was deleted with the legacy repository. |
| builds context from the branch storage without loading complete history | Inapplicable / Covered | Old branch-storage optimization was deleted; v4 context behavior is covered by `session/context.test.ts`. |
| rejects repository operations and session writes after disposal | Covered / Inapplicable | The v4 core `SessionRepo` contract has no disposable state, and the in-memory/JSONL repos do not implement permanent disposal. SQLite disposal is resource release rather than repo poisoning; `packages/session-backends/sqlite-node/test/repository.test.ts` covers the remaining applicable behavior in `closes active sessions when the repository is disposed`, proving active session writes reject after repository disposal. |
| supports lexical ownership with await using | Inapplicable | The old test covered permanent disposal on the deleted in-memory repository. The v4 core `SessionRepo` contract has no disposable surface, and memory/JSONL repos do not implement lexical ownership. SQLite `await using` is resource cleanup rather than repo poisoning; active-session closure is covered by `closes active sessions when the repository is disposed` in `packages/session-backends/sqlite-node/test/repository.test.ts`. |
| serializes conflicting create and fork destinations | Covered | JSONL tests cover concurrent create/create, create/fork, and fork/fork operations targeting the same destination, plus reservation release after failed operations. |
| encodes custom session IDs used in filenames | Covered | J2 JSONL repository lifecycle validates file-safe ids; `jsonl.test.ts` rejects invalid coding-agent filenames. |
| allows appends to different sessions to run concurrently | Covered | J2/v4 repository conformance and JSONL concurrent write tests cover accepted concurrent writes without the old keyed queue. |
| caps concurrent operations across JSONL sessions at four by default | Inapplicable | Old JSONL keyed-operation-queue implementation detail was deleted. |
| allows overriding the JSONL concurrency limit | Inapplicable | Old JSONL keyed-operation-queue implementation detail was deleted. |
| rejects invalid JSONL concurrency limits | Inapplicable | Old `maxConcurrentOperations` configuration was deleted with the JSONL keyed-operation queue. |
| releases JSONL concurrency capacity after an operation fails | Inapplicable | Old JSONL keyed-operation-queue implementation detail was deleted. |
| serializes appends to the same session | Covered | v4 single-writer/session mutation conformance and JSONL shared-sequence tests. |
| uses listing as a barrier between accepted session operations | Inapplicable | The old test covered deleted JSONL `KeyedOperationQueue.enqueueBarrier()` behavior. V4 JSONL intentionally does not retain created/opened storages in the repository and does not serialize repository operations; `harness-v2.md` says callers must await operations with ordering dependencies, so no listing barrier should be restored. The replacement serialization invariant is per opened session storage and is already covered by backend conformance `linearizes concurrent writes across two lanes` plus JSONL-specific `persists concurrent cross-lane writes in shared sequence order`. |
| waits for every accepted session operation during disposal | Inapplicable | The old test covered deleted JSONL backend-wide disposal and `KeyedOperationQueue.drain()` behavior. V4 JSONL repos are not disposable and do not retain opened storages, so there is no repo-wide set of accepted operations to drain. The replacement per-session append serialization is already covered by backend conformance `linearizes concurrent writes across two lanes` and JSONL-specific `persists concurrent cross-lane writes in shared sequence order`; harness close/recovery semantics are owned by H5/O3, not repository disposal. |
| waits for accepted appends before disposal and rejects later writes | Inapplicable | The old test covered deleted JSONL repository disposal: drain accepted appends, enter a permanent disposed state, then reject later writes through existing sessions. V4 JSONL repos are not disposable, do not retain opened storages, and have no repo-level closed state. Per-session append serialization remains covered by backend conformance `linearizes concurrent writes across two lanes` and JSONL-specific `persists concurrent cross-lane writes in shared sequence order`; close/drain/reject-after-close semantics belong to harness H5/O3, not `SessionRepo` disposal. |
| parses once when opened and retains state across appends | Inapplicable | Old JSONL in-memory aggregate implementation detail; v4 correctness is covered by reopen/shared-sequence tests. |
| collects sessions below encoded cwd directories and lists by cwd | Covered | J2 metadata lifecycle and listing tests cover v4 JSONL metadata and cwd filtering. |
| fails loudly when listing a malformed session file | Inapplicable / Covered | Section 13 now requires best-effort listing: malformed headers are skipped without opening or replaying the session. JSONL tests cover skipping the malformed file while retaining valid results; direct `open()` still rejects it. |
| rejects a missing active leaf when opened | Covered | JSONL and SQLite tests cover missing-reference rejection. |
| opens, deletes, and forks by metadata (JSONL) | Covered | J2 JSONL repo conformance. |
| persists header metadata through create, list, and fork | Covered | J0 codec and J2 repository metadata tests. |
| repository disposal closes its owned storage | Covered / Inapplicable | Old in-memory repo disposal is inapplicable because v4 memory/JSONL repos are not disposable and do not own returned session storage lifetimes. SQLite is the only disposable repository because it owns DB/lease resources; active-session closure is covered by `closes active sessions when the repository is disposed`, and DB close behavior is covered by existing SQLite connection lifecycle tests. |
| owns leaf navigation, labels, names, stats, and branch traversal | Covered | v4 conformance covers lanes, latest facts, labels, statistics, and branch queries. |
| serializes concurrent appends into one parent chain | Covered | v4 conformance `linearizes concurrent writes across two lanes`; JSONL storage shared-sequence tests. |
| includes assistant and summary usage in statistics | Covered | v4 conformance `keeps latest-value facts and computes ledger statistics across lanes`, JSONL storage, and SQLite repository statistics tests. |
| stops branch traversal at retained-tail compaction | Covered / Inapplicable | Branch-query stop semantics are still required outside context projection and are covered explicitly by backend conformance `supports bounded filtered and cursor-based queries` via `findEntriesOnBranch({ stopAtType: "compaction" })` across memory, JSONL, and SQLite. Retained-tail materialization is covered by context test `starts at the latest compaction and materializes its retained tail`. The old implicit `getBranch()` auto-stop-at-retained-tail-compaction behavior is inapplicable because v4 uses explicit branch bounds plus context projection. |
| writes headers and entries and reopens the aggregate | Covered | J1/J2 JSONL storage/repository tests. |
| fails loudly for malformed headers and entries | Covered | Direct JSONL opens reject malformed headers and complete invalid mutations without modifying the file; only a torn final JSON fragment is repaired. Listing separately skips malformed headers as required by section 13. |
| enforces entry uniqueness and does not recreate deleted files | Covered | v4 conformance rejects duplicate ids; J2 lifecycle covers delete/reopen behavior. |
| scopes entry uniqueness to the session path | Covered | v4 repository/session isolation conformance. |
| rejects non-object header metadata | Covered | Format-4 open rejects non-object header metadata, while listing skips that malformed file. Format-3 normalization remains assigned to J4. |

## Session aggregate and context tests

Removed file: `packages/agent/test/harness/session.test.ts`.

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| appends messages and builds context in order | Covered | v4 conformance appends entries in parent/sequence order; `session/context.test.ts` covers context projection. |
| reads entries forward from the requested sequence | Covered | v4 conformance `supports bounded filtered and cursor-based queries`. |
| tracks model and thinking level changes | Covered | Current `compaction.test.ts` built-context case covers model/thinking changes; R2 reducer tests cover effective configuration. |
| supports branching by moving the leaf and appending a new branch | Covered | v4 conformance lane isolation and lane move cases. |
| supports moving the leaf to root | Covered | v4 conformance lane lifecycle/targets. |
| reconstructs compaction summaries in context | Covered | `session/context.test.ts` starts at latest compaction and materializes retained tail. |
| supports moving with branch summary entries in context | Covered | `session/context.test.ts` includes branch summary context behavior. |
| persists compaction usage | Covered | v4 conformance statistics plus JSONL/SQLite statistics tests. |
| persists branch summary usage | Covered | v4 conformance statistics plus JSONL/SQLite statistics tests. |
| supports custom message entries in context | Covered | `session/context.test.ts` custom projection coverage. |
| keeps custom entries in context entries but omits them from messages by default | Covered | `session/context.test.ts` custom projection/default omission coverage. |
| projects custom entries with configured custom-entry projectors | Covered | `session/context.test.ts` custom projector coverage. |
| applies context entry transforms after default compaction selection | Covered | `session/context.test.ts` transform-after-compaction-boundary coverage. |
| normalizes session names | Covered | v4 conformance latest-value facts; JSONL metadata tests cover name metadata. |
| supports labels and session info entries without affecting context | Covered | v4 conformance facts/labels plus `session/context.test.ts` context projection. |
| rejects labels for missing entries | Covered | v4 conformance `keeps latest-value facts and computes ledger statistics across lanes` includes missing-label rejection. |
| persists leaf changes and appended entries through the backend | Covered | v4 conformance lane moves, reopen/list/fork cases across memory/SQLite/JSONL. |

## SQLite search test

Removed case from `packages/agent/test/harness/sqlite-node.test.ts`.

| Removed test | Classification | Coverage / follow-up |
|---|---|---|
| searches canonical session entries by scanning | Ported / Inapplicable | Search moved to `packages/session-backends/sqlite-node/test/search.test.ts` using FTS5. The old scanning-search backend is intentionally deleted. |

## Implementation prerequisites for the final QA pass

These packages must land before QA3 can re-evaluate the uncovered rows above. They do not use this matrix as their test plan.

- **QA2**: completed storage/query audit and ports for bounded-query corruption/validation behavior, repository/session disposal lifecycle, listing/disposal barriers, and branch-query retained-tail semantics outside context projection.
- **J3**: completed JSONL malformed-file, torn-tail, missing-reference, and lifecycle/concurrency coverage.
- **J4/J5**: v3 read-only normalization and first-write conversion; include malformed v3/header metadata cases.
- **I1/I2/I3/I4/L1-L3**: hook/event/mutation/effects/loop primitive coverage required before runtime harness tests can return.
- **H1-H8**: durable run, queue, configuration, wait/abort, tool, recovery, and deferred-provider runtime behavior formerly covered by legacy `agent-harness*.test.ts`.
- **C1-C3/N1**: durable compaction and navigation runtime behavior formerly covered by legacy harness compaction/branch-summary tests.
- **O1/O2**: complete event/watch snapshots and runtime telemetry around the restored operation paths.
