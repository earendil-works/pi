# Post-WP05 roadmap audit

**Audit baseline:** `5507d76ee` (`dev`, 2026-08-27).

**Status:** Planning inventory, not a behavior contract. [`harness.md`](harness.md) remains normative where it agrees with the current product boundary. Contradictions listed below must be resolved explicitly; this document does not silently choose one side.

## Scope and method

This audit covers the durable AgentHarness and its directly coupled Session backends and presentation path:

- `packages/agent/src/harness`, `packages/agent/src/search`, and their tests/docs;
- `packages/session-backends/sqlite-node`;
- the current `packages/protocol`, `packages/client`, and `packages/server` presentation path;
- `packages/coding-agent/src/experimental` and its focused tests where they host that path;
- telemetry plumbing in `packages/telemetry`, `packages/ai`, and `packages/agent`.

The inventory was checked against current source, tests, package READMEs, the complete `harness.md`, completed WP00–WP07 status, the actionable WP08 handoff, explicit stubs/TODOs/skips, and the shipped package boundaries. Historical handoffs are not treated as backlog when current source and the completed WP05 contract supersede them.

## Executive result

WP05 is complete through M10. Its remaining assistant-output work is owned by the [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) and its numbered prerequisites. The current Harness execution graph has no unfinished runtime path: `watchSession()` is the sole `SliceNotImplemented` Harness method.

That does **not** mean the surrounding durable system is complete. The remaining audit findings are:

1. normative JSONL snapshot-compaction behavior with no implementation;
2. one required Harness method stub (`watchSession`);
3. a deliberate removal of raw `RemoteSession` that conflicts with later normative WP06/`harness.md` text;
4. a public search type skeleton that conflicts with the newer search design and has no implementation;
5. a full telemetry vocabulary whose only production span is the tool-hook span;
6. smaller repository, client-watch, query-bound, documentation, and end-to-end-test gaps.

WP07 completed SQLite host-ownership alignment and live-source fork support after the audit baseline; its historical handoff is [`work-packages/07-sqlite-host-ownership-live-forks.md`](work-packages/07-sqlite-host-ownership-live-forks.md). WP08 now owns the separate named-branch, tree-state, and bounded-memory fork redesign; its actionable handoff is [`work-packages/08-named-branch-streaming-forks.md`](work-packages/08-named-branch-streaming-forks.md).

## Required missing functionality and contract contradictions

### R12 — Session-wide Harness watch

**Evidence**

- `AgentHarness.watchSession(context)` is public in `src/harness/agent-harness.ts`.
- `Harness.watchSession()` throws `SliceNotImplemented("watchSession")` in `src/harness/runtime/harness.ts`.
- `SessionSnapshot` currently contains only `{ lanes: LaneInfo[]; faulted: boolean }`.
- Lane watch, event buffering, delivery-tail barriers, and `resnapshot()` already exist in `src/harness/events.ts` and `src/harness/runtime/lane.ts`.

**Remaining boundary**

Define one coherent capture and fold for dynamic lane inventory and fault state. Decide whether the intentionally small `SessionSnapshot` stays small or gains session metadata/stats/global configuration. Then implement snapshot-before-events, lane creation, resnapshot, listener reentrancy, close/fault behavior, and a session reducer if event-only replication is promised.

**Dependency**

Independent of the mobile assistant-output handoff and SQLite internals. It should precede any revisioned Transcript service or remote session-wide observation built on it.

### JSONL snapshot compaction

**Evidence**

`harness.md` §1.7 normatively specifies temp-file-and-rename snapshot compaction, preserved sequence high-water marks/list cursors, threshold checks on open, and reclamation after terminal/outcome deletions. `JsonlStorage` implements atomic creation, torn-tail repair, legacy-v3 rewrite, append, and fork snapshots, but no current-state snapshot rewrite or dead-byte accounting exists.

**Consequence**

Superseded `pi.op.state`, deleted pending payloads, deleted tool checkpoints, and deleted assistant-frame lists remain physical bytes indefinitely. Generic compaction and the [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) are complementary. Compaction reclaims dead session-scoped write history after the fact; the handoff moves pending assistant/tool output into ephemeral scopes so it never becomes main-log history, and replaces full/per-frame replication with Chord op batches.

**Dependency**

The assistant-output handoff does not depend on J1: scoped storage is the intended lifetime mechanism for pending output, while J1 remains the reclamation mechanism for superseded session-scoped state. Measure both independently so their effects are not conflated.

### Remote Session contract contradiction — decision required

**Current product boundary**

Commit `f8a6e670d` deliberately deleted `RemoteSession`, its raw Session RPC protocol, and the server mutation-scope manager, replacing them with attachment-fenced routed semantic services. Current protocol/server READMEs explicitly state that real `Session` and `AgentHarness` objects remain process-local. The shipped path supports Session discovery/creation/attachment, main-lane prompt/watch, and allowlisted plugin-service calls; it does not expose `Session`, `SessionMutation`, values/lists, branches, or storage over RPC.

**Conflicting contract**

WP06, written after that deletion, requires the “current keyless RemoteSession mutation transport,” includes remote begin/read/commit/publication/end in required tests and stop conditions, and forbids its removal. `harness.md` §§2.8 and 9.1 likewise state that local and remote implementations preserve that lifecycle. No such implementation, protocol schema, client facade, server-held scope, worker adapter, or conformance test exists at the audit baseline.

**Required decision**

Choose one before scheduling implementation:

1. **Process-local Session remains intentional:** remove the false RemoteSession requirements from normative current-state docs while preserving semantic service RPC; or
2. **RemoteSession is required:** commission a dedicated package for mutation begin/read/commit/end, disconnect/timeout cleanup, publication-before-end, values/lists/branches/entries/stats, protocol validation, client/server/worker adapters, and remote conformance.

Do not count the current lane-watch compatibility RPC or plugin-service RPC as RemoteSession. Do not restore the deleted 507-line facade unchanged: it predates the keyless Session/Branch contract and relied heavily on untyped decoding.

### Telemetry contract exceeds implementation

**Evidence**

`src/harness/telemetry.ts` and generated `docs/telemetry-schema.md` declare `pi.ai.request`, operation, checkpoint, turn, step, tool, hook, sleep, event-handler, and session-write spans. Production source starts only `pi.harness.hook`, and only for registered `before_tool`/`after_tool` handlers. AI options propagate `telemetryContext`, but no provider path starts `pi.ai.request`. Server request ingress has cancellation but no trace carrier or client/server RPC spans. `TODO_CONTEXT` remains at transport/worker lifecycle and event-delivery boundaries.

**Remaining boundary**

Treat this as separate packages:

1. local Harness/Session/AI instrumentation and runtime tests;
2. RPC trace-carrier/client/server propagation;
3. an optional application-selected exporter/adapter.

First reconcile whether every declared span is still wanted. If retained, implement it; if not, remove the unsupported public schema surface and correct `harness.md`. Do not mix telemetry with Context/RPC cancellation, which already has independent request-ID signaling.

### S3 — Search

**Evidence**

`src/search/index.ts` exports a public `SessionSearchService` skeleton with `sync()`, `notify()`, and array-returning `searchEntries()`. `harness.md` §2.8 instead specifies a standalone service, separate catch-up/notify utilities, generation-aware cursors, and optional `AsyncIterable` entry search. There is no factory, sync utility, cursor store, projection, or source SQLite FTS implementation. At the audit baseline the SQLite README advertised nonexistent `createSqliteSessionSearch()` behavior; this audit corrected that README rather than treating the absent API as implemented.

**Remaining boundary**

Before implementation, replace or reconcile the draft public interface and decide metadata filtering (`cwd`), candidate restriction, or indexed metadata. Post-filtering after ranked `limit` is unsound. Then implement standalone catch-up and a separate SQLite FTS5 projection; do not add repository search methods.

### R11 — Schema migrations, activation-gated

No current format-4 migration is required. Memory is current-only; JSONL and SQLite reject unsupported storage versions; SQLite runs only idempotent `001_initial.sql`. R11 becomes required immediately before the first incompatible durable storage version/address/state change after format 4 is stabilized. It is not prerequisite work for the mobile assistant-output handoff or current WIP format replacement.

When activated, it must provide ordered transactional migrate-on-open under exclusive ownership, version-specific JSONL decoding plus post-migration compaction, and total mappings for every reachable open operation leaf and surviving value/list.

## Correctness and data-safety debt

### SQLite host ownership and live-source forks — completed by WP07

The authoritative product rule is in `plugins.md`: exactly one host-assigned process owns writable Session authority; normally it is the Session worker, while the server may temporarily own a newly created or forked destination before closing it and handing it off. Storage backends do not implement writer ownership. The server closes a worker before destructive repository administration.

SQLite now follows that rule: the writer-lease schema/module, claims, renewal timer, lease-loss path, and pre-commit callback are gone, with no replacement lock or ownership primitive. Create/open/fork/delete retain repository-local ID reservation. Metadata open and deletion use a true no-create read-write mode; listing and external fork sources use no-create read-only connections.

Same-repository forks retain the source `commitQueue` ordering seam. A source owned elsewhere, including a live worker, is read from its exact canonical container through one independent read-only deferred WAL transaction. Focused per-file and shared-container tests commit a complete later source transaction after the reader establishes its snapshot and before it closes: the first fork excludes the transaction wholly and a later fork includes it wholly.

WP07 also completed canonical `(containerPath, sessionId)` active identity, safe explicit-ID filenames, custom `databasePath` parent creation, Session-scoped shared deletion, WAL/SHM cleanup, and all-settled SQLite repository close. Writable open/delete reject foreign metadata; foreign fork sources are read only from their exact path. Equal-`createdAt` list ordering still has no deterministic tie-break and remains a later behavior-preserving cleanup.

### Repository close ownership is unspecified

`JsonlSessionRepo.close()` contains the only active Agent source TODO and closes no open Session handles. Memory still uses fail-fast `Promise.all`; SQLite now performs backend-local all-settled cleanup of currently open handles, but an already-admitted create/open/fork can still register a handle after repository close captured that set. `SessionRepo` itself declares no `close()` method and shared conformance does not define repository-to-handle ownership or draining of admitted repository operations. Resolve ownership and common cleanup in one repository-lifecycle package; do not patch one backend further without deciding the common contract.

### Client watch staleness after disconnect

`Client` clears its active watch-listener map on disconnect, but existing `LaneWatch` objects keep local `ready`/`started` state and old watch IDs. After reconnect/reattach they can call `start()` or `resnapshot()` and fail remotely instead of deterministically rejecting as stale, contrary to `packages/client/README.md`. Service-subscription objects have the sibling problem: their listeners are cleared and surviving objects become silently dead. Fix both with connection/attachment incarnation fencing and focused reconnect tests. This is independent of R12: the current client method is a compatibility main-lane watch.

### Query bounds and SQLite bind limits

- SQLite `getEntries(ids)` emits one placeholder per requested ID and can exceed the engine’s variable limit.
- Entry, usage, and branch limits use ad hoc `Math.max(0, limit)` behavior. Memory and SQLite diverge for `NaN`, infinities, fractions, and extreme values; unlike list reads, there is no shared normalization contract.

Define cross-backend query-limit semantics in agent conformance, then chunk SQLite ID lookups. This is a storage-contract hardening package, not part of WP07.

### Harness contract and conformance closure

- The public `OperationStatus` includes `"running"`, but lane inspection, snapshots, and `reduceLaneSnapshot` currently produce only `"open"` or `"aborting"`. Define and implement its producer or remove the dead variant.
- The pre-rewrite abort contract bound/published `operation_abort` before resolving the cancellation promise and signalling the live gate. Current `Lane.command()` materializes the result — resolving/signalling — before constructing and binding the event batch, although it still binds recipients before releasing the Session mutation line. Decide whether to change the implementation or retain/document the current no-interleaving order; add an explicit ordering test.
- The production gate-close contract permits only `HarnessClosed | HarnessFault`, but the private source primitive accepts any `Error` and isolated tests use that wider type. Narrow the source declaration and fixtures or explicitly retain the private widening.
- Part 9 of `harness.md` is the required conformance matrix. Existing focused tests cover the graph extensively, including cancellation reconciliation over all 13 leaves, but there is no audited one-to-one proof that every close/reopen leaf case and every race row has both deterministic orders. Audit the matrix and add only the missing cases rather than claiming blanket completion.

Keep this package separate from telemetry, RemoteSession, and the mobile assistant-output handoff; it is local contract/test closure.

### Disabled real worker persistence regression

`packages/coding-agent/test/experimental-remote-runtime.test.ts` still skips “completes and persists a prompt through the worker-owned Harness” with the obsolete note “Re-enable with runtime no-tool execution.” No-tool execution now exists. Re-enable or replace it with a deterministic faux-provider real-worker persistence test; do not use a real paid provider.

## Performance debt

### Mobile assistant-output handoff — durable and replication amplification

The user-supplied motivating mini Session outside the repository is 303,920 bytes across 569 physical lines. These external measurements are evidence, not a reproducible checked-in fixture:

- 477 assistant-frame appends totaling about 118,418 serialized write bytes;
- 12 frame-list deletes; physical lines mentioning the frame namespace total 148,214 bytes;
- about 51,568 bytes of superseded `pi.op.state` writes and 26,192 bytes of one structural preparation, showing why generic JSONL compaction and frame-specific bounding are distinct.

The authoritative design is the [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md), following the numbered `01-harness` prerequisites in [`mobile-handoff/README.md`](mobile-handoff/README.md). Chord delta tracking has landed; scoped storage, tool-output integration, and assistant-output integration have not.

Implementation must add a deterministic repository fixture and measurement script that reproduces or replaces these figures, then measure Memory logical elements, SQLite rows/pages/WAL, JSONL peak sidecar/main-log bytes, and reopen/replay time. The handoff must preserve unknown-outcome recovery, invocation fencing, non-blocking provider streaming, and settlement retirement while eliminating per-frame durable writes and quadratic `message_update` replication. Numerical budgets belong in its implementation handoff/tests, not in a competing standalone design.

### SQLite branch divergence

`createDivergentBranchForEntry()` copies every row after the newest compaction; with no compaction it copies root-through-parent. A first divergence from a long uncompacted transcript is therefore O(history) writes. This exposes an internal contradiction in `harness.md` §2.6: its opening bounded-prefix promise conflicts with its own compaction-based copy algorithm, which the implementation follows. Change both the specification and segment representation so a divergence can reference a covering segment at the parent boundary. Preserve shared-container support and add large uncompacted divergence plus chain-soundness tests/benchmarks.

### Fork contract and materialization — WP08 actionable

All current backends materialize source-sized fork snapshots. Branch scope defaults to `main` without named-Branch ancestry validation; tree scope omits application values/lists; JSONL closed-source fork replay may repair its source. WP08 replaces that contract with required named-branch or tree scope, one closed built-in-state policy, complete current application state for tree forks, and backend-specific bounded-memory copy procedures. It preserves WP07's host ownership, physical identity, same-repository ordering, and independent live-source WAL boundary.

### SQLite catalog, statements, stats, and reclamation

- Default per-session `list()` synchronously opens/configures every SQLite file serially and silently skips failures. A shared container or external catalog is the scalable deployment choice; bounded async scheduling does not make `DatabaseSync` nonblocking.
- Most hot queries prepare a fresh statement each call. Cache narrowly owned statements after measuring.
- Each usage row parses and rewrites the full aggregate JSON usage payload.
- Shared-container row deletion does not reclaim pages. Define maintenance/VACUUM policy separately; never add `VACUUM` to ordinary deletion casually.

These are measurable optimization/operations packages, not correctness fixes.

### Pending-payload amplification and mutation-line parallelism

Queued payloads deliberately write `pendingEntry → immutable entry`; measure pathological payloads before changing it. Keyed Session mutation lines remain optional and require profiling plus a fresh mutable-ownership audit. Neither is current correctness work.

## Behavior-preserving cleanup and documentation repair

Completed by this audit:

- rewrote the SQLite README’s nonexistent `SqliteSessionRepository`/search APIs, wrong `await using` and `appendMessage` example, FTS trigger/rebuild claims, and “one shared connection” claim;
- reconciled `harness.md`’s default one-file SQLite wording with the supported optional shared container;
- reconciled `harness.md` Part 8 with this audit and corrected stale drive-ownership/RPC-cancellation status in `telemetry.md`;
- corrected coding-agent settings docs: install telemetry configuration also controls selected provider attribution headers.

Remaining cleanup:

- **Harness-owned DTO boundary:** the durable Harness still imports legacy agent-loop DTOs from `src/types.ts`: `AgentMessage`, `AgentToolResult`, `AgentToolCall`, `AgentTool`, `QueueMode`, and `ThinkingLevel`. Make a later one-shot cut to independent `HarnessMessage`, `CustomHarnessMessages`, `HarnessToolResult`, `HarnessToolCall`, `HarnessQueueMode`, and `HarnessThinkingLevel` definitions; keep `AgentHarnessTool` as the executable Harness configuration type. Update Harness internals, root exports, declaration-merging tests, documentation, and experimental coding-agent consumers together. Do not alias the new message/tool DTOs back to legacy types, because that preserves the coupling this work is intended to remove.
- Preserve shared-container support; do not remove it incidentally.
- Remove or use unused `insertEntryRow()` and `insertUsageLedgerRow()`.
- Consolidate duplicated SQLite branch payload/structure scan plumbing only after correctness tests pin both paths.
- Decide whether unused `sessions.metadata` and unmeasured indexes have a future owner before schema removal; do not change schema casually.
- Consolidate `startAiSpan()`/`startHarnessSpan()` implementation only if the telemetry surface is retained.
- Mark historical durability documents as delivered where they still read as implementation queues. WP00–WP07, `runtime-simplification.md`, `values.md`’s old consumer deferrals, and external-finalization designs are not active runtime backlog.

## Optional or deferred product capabilities

These are not blockers for the durable Harness:

- standalone S3 search after its API decisions;
- Accounts removal and revisioned Transcript production;
- authenticated workspace/client authorization for the experimental local server;
- private returned references, service flow control, multi-pane presentation, plugin kernel/reload completion, and version-skew negotiation;
- administrative precise rewrite tooling;
- a partitioned Postgres backend/retention policy;
- generic remote Harness/object capabilities;
- DeltaState or delta replication before concrete snapshot pressure justifies it;
- a production telemetry exporter;
- schema migrations before an incompatible stabilized-format change activates R11.

## Recommended dependency order

The order is by data safety first, then dependencies. Independent tracks may proceed in parallel only when they do not edit the same contracts.

1. **Harness contract/conformance closure.** Resolve `OperationStatus.running`, abort signal/event binding order, gate-close typing, and the Part 9 coverage matrix.
2. **Remote Session decision (decision only).** Resolve the false normative boundary early. If process-local wins, repair the docs. If raw RemoteSession wins, later create a dedicated protocol/client/server/worker package; do not fold it into telemetry or R12.
3. **Client watch/subscription staleness** and **repository lifecycle contract.** Small independent correctness packages; complete them before expanding server/worker lifecycle semantics. The lifecycle package must also address Memory's fail-fast repository close.
4. **[Mobile Harness handoff](mobile-handoff/README.md).** Follow its numbered prerequisites through scoped storage, tool output, and assistant output; preserve all recovery boundaries and land deterministic amplification measurements.
5. **JSONL snapshot compaction.** Implement the already-normative physical reclamation path and metrics for remaining session-scoped history.
6. **R12 session-wide watch.** Complete the only Harness method stub before building revisioned Transcript/session-wide remote observation.
7. **Telemetry, if retained:** reconcile schemas, then local instrumentation, then RPC propagation, then an optional exporter. RPC propagation follows the Remote Session/product-boundary decision.
8. **WP08 — named-branch and streaming forks.** Implement the actionable handoff without reopening WP07 ownership or lifecycle decisions.
9. **SQLite branch/query performance hardening.** Keep separate from completed WP07 ownership alignment and WP08 fork semantics; require benchmarks.
10. **S3 search.** Resolve its API/filter/cursor decisions, then implement catch-up and the standalone FTS projection.
11. **R11 migrations.** Activate immediately before the first incompatible stabilized durable schema change, not earlier.

## Stop conditions for roadmap accuracy

This inventory must be updated when any of these facts changes:

- `watchSession` stops being the sole Harness `SliceNotImplemented` method;
- raw RemoteSession is either recommissioned or removed from the normative contract;
- JSONL snapshot compaction lands;
- telemetry schemas are implemented or removed;
- S3’s public API is reconciled;
- a durable format change activates R11;
- WP08 lands or its fork contract changes;
- the host-authority contract changes.
