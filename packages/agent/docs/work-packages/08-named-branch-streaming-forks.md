# WP08 — Named-branch and tree forks with streaming copies

**Status: in progress — implementing Slice A.**

This package replaces the fork contract: `ForkOptions` gains a mandatory scope and a mandatory named source branch, branch forks validate a complete configured source AgentLane and ancestry membership, tree forks copy the complete immutable tree plus current application values/lists, and all three backends replace materialized source snapshot arrays with bounded-memory streaming copies. A JSONL fork never repairs or mutates its source. One closed core classifier owns every namespace's fork disposition.

WP07 is a hard dependency and is preserved unchanged: no-create database modes, canonical `(containerPath, sessionId)` identity, independent read-only WAL reader for external/live-worker sources, repository-local deletion reservation, and all-settled close. This package supersedes only the roadmap's "SQLite fork cost" performance item.

## 0. Mandatory reading

Read completely before editing:

1. `packages/agent/docs/harness.md` §§0.6, 1.3–1.7, 2.3, 2.7–2.9, Part 9 (invariants 3–5, 13, 16; ledger completeness).
2. `packages/agent/docs/values.md`, especially "Forks and rewrites" and the backend sections.
3. `packages/agent/docs/post-wp05-roadmap.md` (SQLite fork cost, repository lifecycle context).
4. Completed WP06 §7 and WP07 (historical; do not edit them).
5. `packages/agent/src/harness/session/fork.ts`, `types.ts` (`ForkOptions`, `SessionRepo`), `values.ts`, `in-memory-storage-state.ts`, `memory.ts`, `session/index.ts`.
6. `packages/agent/src/harness/session/jsonl/repo.ts`, `jsonl/storage.ts`, `jsonl/codec.ts`, `jsonl/legacy-v3.ts`, `jsonl/types.ts`.
7. `packages/session-backends/sqlite-node/src/sqlite/repo.ts`, `storage.ts`, `session/values.ts`, `session/entries.ts`, `session/branch-entries.ts`, `types.ts`.
8. `packages/agent/src/harness/session/testing/conformance/session-repo.ts` and every test named in §5.
9. `packages/agent/src/harness/session/testing/benchmark/session-repo.ts` and both `session-repo.bench.ts` files.

Do not use `dist/` output as implementation input. WP00–WP07 documents and released changelog sections are immutable in this package.

## 1. Fixed architecture

### 1.1 Public contract

```ts
export type ForkOptions =
	| { scope: "branch"; branch: string; entryId?: string; position?: "before" | "at"; id?: string }
	| { scope: "tree"; id?: string };
```

`scope` is required. `branch` is required for branch scope. There is no default scope, no implicit `main`, and no compatibility alias.

**Branch scope** requires a complete configured source AgentLane: `pi.branch.tip/{branch}`, `pi.lane.config/{branch}`, and `pi.lane.state/{branch}` must all exist. A missing tip rejects (`unknown branch`); a data-only Branch (tip without config/state) rejects; a partial config/state pair, or `laneConfig`/`laneState` present without a `branchTip`, is corruption and rejects. `entryId`, when supplied, must be an entry on that Branch's current tip ancestry (inclusive); an entry elsewhere in the tree rejects. Omitted `entryId` means the current tip. `position` defaults to `"at"`; `"before"` selects the target's parent and may yield a `null` destination tip (before the root entry, or a `null` source tip with no `entryId`) — legal. The destination contains exactly one Branch with the same name, the selected tip, the copied `LaneConfiguration`, and fresh idle lane state `{ currentOperationId: null, lastOperationId: null, inbox: [] }`. No other Branch or lane exists in the destination.

This deliberately makes branch forks of data-only Branches — including legacy v3 imports whose main lacked reconstructable model/thinking history — unavailable. Tree scope remains available for those sources.

**Tree scope** copies: every immutable entry, including entries unreachable from every current Branch tip; every Branch tip verbatim; every configured lane's config plus fresh idle lane state under the same name; data-only Branches (tip present, config/state absent) as data-only Branches. A partial config/state pair, or `laneConfig`/`laneState` without a `branchTip`, is corruption in both scopes: tree scope **rejects** it rather than dropping it.

**Both scopes**: copy `pi.session.name`; copy `pi.entry.label` values only for copied entries; exclude the usage ledger, `pi.result`, all `pi.op.*`, all `pi.pending.*` (entries, tool checkpoints, assistant frames), and every trace of open-operation state. Destination usage totals start at zero; destination `messageCount` equals the number of copied message entries, exactly as current conformance already proves. Destination metadata records `parentSessionId = source.id`. Copied entries, values, and list elements preserve their original `seq`; the destination `nextSeq` high-water mark is the source's, so no sequence is reused. Transformed built-ins keep coherent seqs: the rewritten `branchTip` and each fresh idle `laneState` reuse the seq of the source's current corresponding value row, and copied config, name, labels, application values, and list elements retain theirs — destination writes stay in original seq order under an unchanged high-water mark.

**Application values/lists (outside the reserved `pi`/`pi.*` namespaces)**: tree scope copies every current scalar value and every surviving list element with original seqs; branch scope copies none. A `seq <= tipSeq` cutoff is forbidden as "historical reconstruction" — it is provably not one:

```text
Scalar: TX[seq 10: set my-app.state = v1] · TX[seq 12: insert e1] ·
        TX[seq 50: set my-app.state = v2]     (v2 describes work after e1)
Branch fork at e1, cutoff seq <= 12: only v2 exists (v1 was replaced, no
history is retained); 50 > 12 excludes it → state absent, though the app
demonstrably had state v1 at the fork point. The cutoff cannot recover v1.

List:   append seq 5 · append seq 20 · deleteList seq 40 · append seq 60
Cutoff seq <= 30: elements 5 and 20 no longer exist (whole-list delete
destroyed them); only 60 survives and is excluded → empty list, though the
list held {5, 20} at seq-30 time.
```

Any cutoff filters *survivors*, silently mixing rewound intent with post-deletion reality. Branch scope therefore copies nothing application-owned, matching its fresh idle lane state and zero ledger; applications own their own re-derivation.

### 1.2 One closed fork classifier

All namespace fork knowledge lives in one core module beside `session/values.ts` and `session/fork.ts` (e.g. `session/fork-policy.ts`). It is a closed switch, not a registry, plugin policy, or DSL:

- `pi.op.*`, `pi.pending.*`, `pi.result` → exclude, both scopes.
- `pi.session.name` → copy.
- `pi.entry.label` → copy iff the keyed entry is copied.
- `pi.branch.tip`, `pi.lane.config`, `pi.lane.state` → structured lane actions; the scope-specific rules (branch keeps only the named lane and rewrites its tip; lane state is always replaced with fresh idle state; tree keeps all) live in one shared driver consumed by all backends.
- The exact namespace `pi` and any other `pi.*` namespace → the fork **fails**, but only when current surviving state exists at fork time (a current scalar row or a surviving list element). Historical writes later replaced or deleted are absent from current state on every backend and must not alone fail a JSONL fork — behavior is backend-equivalent. Introducing a new built-in namespace without declaring its fork semantics must break fork tests, not silently copy or drop state.
- Neither `pi` nor `pi.*` → application: copy on tree, exclude on branch. The only built-in list namespace (`pi.pending.assistant_frame`) excludes; application lists follow the application rule.

The driver exposes a streaming shape — accept one committed value/list write (or current row), emit zero or more destination writes, `finish()` emits fresh idle lane states and the rewritten branch tip — holding only bounded state (lane names, destination tip). Entry-copy membership is a backend-supplied predicate so each backend uses its own index. `createForkSnapshot`, `forkSnapshotWrites`, `ForkSourceSnapshot`, `ForkDestinationSnapshot`, and the `entriesComplete` escape hatch are deleted.

### 1.3 Bounded-memory backend procedures

Auxiliary memory during a fork must stay bounded regardless of source size. The unavoidable exceptions are Memory's destination state and the returned open destination Session (JSONL destination state after open). Source copy paths must not call array-returning full reads: no `snapshotEntriesAndValues()`, `captureForkSource()`, `readAllScalarValueRows()`, `readAllEntryRows()`, whole-file `readTextFile`, or SQLite `.all()` over unbounded row sets.

**Memory.** At a source `commitQueue` boundary, build the destination `InMemoryStorageState` directly by iterating source maps once through the classifier/driver. Branch scope walks `parentId` from the branch tip toward the root to compute the ancestry id set and verify `entryId` membership; copy exactly that set. No intermediate snapshot arrays; `MemoryStorage.fromSnapshot` and `captureForkSource` are removed.

**JSONL.** The source is read through a read-only path that captures a fixed file prefix — open a read handle, record the current length at capture time, and read only that prefix — and never writes the source: no torn-tail truncation/rewrite, no v3 normalization persistence, no `.tmp` beside the source. A torn or incomplete final line inside the captured prefix is discarded in memory. The source `nextSeq` high-water mark is derived as `max(header.nextSeq when present, highest complete captured write seq + 1)` — ordinary headers are not rewritten on every append, and a torn incomplete final write never advances it.

- *Both scopes* use two passes over the captured prefix with one temporary disk-backed index (deleted in `finally` on success and failure). Pass 1 streams every line and folds value/list writes into the index: per scalar address, the seq of the current surviving `set` (absent after a trailing `delete`); per list address, the set of surviving element seqs (whole-list delete clears it); plus entry `id → parentId` (parents always precede children) where branch scope needs ancestry. The fold applies the same current-state semantics replay does, without whole-state RAM.
- Pass 2 streams the prefix again in order and emits a write only when the index proves it current and the classifier selects it: an entry write in the selected set; a scalar `set` whose seq equals the index's current-row seq for its address; a list `append` whose element seq is in the survivor set. Deletes, superseded sets, and dead application value/list history are never emitted as destination state — the destination file contains only current selected rows, already in original seq order because source lines are seq-ordered.
- Transformed built-ins emit in place: when pass 2 reaches the seq of the source's current `branchTip` row for a kept branch it emits the (possibly rewritten) tip under that same seq, and when it reaches the seq of the current `laneState` row for a kept configured lane it emits fresh idle lane state under that same seq. No tail appends exist, so replay stays seq-monotonic and the high-water mark is untouched.
- *Branch scope* walks tip→root through the disk index to materialize the ancestry set on disk and verify `entryId` membership before pass 2; labels emit only for member entries.
- The destination is staged in a temp file and atomically renamed (existing `publishFileAtomically`); failure removes the temp file and the index. Legacy v3 splits by source state. Forking an **open** legacy-v3 `JsonlStorage` **rejects with a clear error** until a normal non-empty commit has upgraded and persisted its normalized format-4 ids: v3 normalization mints nondeterministic UUIDv7 tails, so an independent disk reparse cannot reproduce the ids the open Session exposes or validate a caller `entryId`; the fork must not mutate/upgrade the source itself. A **closed** legacy-v3 source uses the bounded fixed-prefix disk-backed parser/normalizer and never touches the file: tree forks succeed; branch forks may use an omitted `entryId` (the default normalized tip) when the import reconstructs a complete configured lane, while any caller-supplied process-local id from an earlier open is not stable across reparses and rejects normally; a data-only reconstructed lane rejects as everywhere. Ordinary writable `JsonlStorage.open` may retain in-memory normalization, but resident state is never a fork source.
- There is **no resident-state path**: an open same-repository JSONL source enqueues a short boundary callback on the source `commitQueue` whose only job is to capture the fixed read-only file-handle prefix (open handle, record length), then releases the queue; the fork runs the same two-pass disk-backed procedure over that prefix while later source appends proceed. Committed writes are durable in the file before they are applied to resident state, so the prefix is authoritative at the boundary, and file order preserves seq order without resident-Map ordering ambiguity.

**SQLite.** Iterator-based row transfer through a bounded-memory temporary on-disk SQLite **staging database**, used uniformly for per-file and shared-container layouts. The source reader never streams directly into the destination transaction — a WAL reader and one writer can coexist, but in shared-container mode the destination writer would hold the container's sole write lock and block the post-boundary source writer while capture is still streaming; staging into a separate file removes that coupling. Use prepared-statement iteration (`iterate`/stepwise), never source-sized `.all()` snapshot arrays:

- *External/closed/live-worker source:* WP07 path — `openReadOnly` on the exact canonical path, one deferred read transaction, session row and storage version validated inside it.
- *Same-repository open source:* open the independent read-only connection **first**, then enqueue a short boundary callback on the source Storage `commitQueue` whose only job is to `BEGIN` and establish the independent reader's snapshot (issue a trivial read) before releasing the queue. Do not begin a read transaction on the source writer connection and then release its queue, and do not hold the queue for the copy duration.
- *Stage:* while the source reader remains open, stream selected entries `ORDER BY seq` and classifier-selected current scalar/list rows (SQL-level namespace prefilters matching the classifier — enumerated built-in namespaces plus the application predicate excluding exact `pi` and `pi.%` — with each row still passing the classifier) into the temporary staging database in bounded batches. Branch scope enumerates the ancestry through the `branch_entries` segment chain up to the selected entry and answers `entryId` and label membership through that index, not an in-RAM id set. Later source commits use the original writer connection and may complete while staging streams, in **both** layouts, because stage writes target another file.
- *Publish:* close/commit the source read transaction, then stream the stage into one destination `BEGIN IMMEDIATE` transaction — entries in seq order maintaining the destination branch index and `message_count` incrementally, then values/list elements — and delete the staging database in `finally` on success and failure. Destination `next_seq` is the source's. Shared-container destinations write only the new session's rows.

### 1.4 Preserved WP07 behavior

Destination id reservation across create/open/fork/delete, no-create opens, foreign-metadata rejection, per-file and shared-container layouts, WAL commit-boundary wholeness (a source commit is wholly inside or wholly outside one fork), and all-settled repository close are unchanged.

### 1.5 Coding-agent status (record only)

`/fork`, `/clone`, and `--fork` run entirely on the legacy `SessionManager` (`createBranchedSession`, `forkFrom`) and are not migrated here. Future mapping when coding-agent adopts `SessionRepo`: `/fork` → `{ scope: "branch", branch: "main", entryId, position: "before" }`; `/clone` → `{ scope: "branch", branch: "main" }`; `--fork` → `{ scope: "tree" }`.

## 2. Problems in current source

- `ForkOptions` defaults `scope` to `"branch"` and hard-codes source/destination `main` (`fork.ts`, both backend branch readers).
- No ancestry membership check: `selectForkContents` walks parents from any supplied `entryId` anywhere in the tree and labels the result `main`.
- Every backend materializes the full source: `snapshotEntriesAndValues()` (Memory/JSONL), `readAllScalarValueRows` + `readAllEntryRows`/`scanBranchEntries` arrays (SQLite), all funneled through in-memory `createForkSnapshot`.
- `createForkSnapshot` renumbers copied scalar values with fresh seqs and computes `nextSeq` as `max entry seq + 1`, losing original value seqs.
- A JSONL fork of a closed source uses `JsonlStorage.open()`, which rewrites the source file on a torn tail — a fork can mutate its source today.
- Lists are never copied; application values are excluded with no declared tree policy (`values.md` explicitly defers it).
- Namespace fork knowledge is repeated across `fork.ts`, `values.md` prose, and conformance assertions; nothing forces a new `pi.*` namespace to declare fork semantics.
- `entriesComplete?: false` exists only to let SQLite branch snapshots skip tip validation for other branches.

## 3. Required result

1. `ForkOptions` and validation exactly as §1.1; all rejection paths create no destination file, database rows, or reserved-but-leaked ids.
2. The closed classifier/driver of §1.2, exported from core and consumed by all three backends; unknown reserved namespaces (exact `pi` or undeclared `pi.*`) fail the fork only when current surviving state exists, identically on every backend.
3. Streaming procedures of §1.3 on all three backends; `createForkSnapshot`/`captureForkSource`/`snapshot()` fork plumbing and their exports removed from `session/index.ts` and the sqlite-node import surface.
4. Seq preservation (including reused seqs for rewritten tips and fresh idle lane states) and source `nextSeq` high-water on every backend (JSONL derives it per §1.3); identical logical destination state across backends for identical sources (conformance).
5. JSONL source non-mutation, including torn-tail sources and legacy v3 sources.
6. Documentation: `harness.md` §2.7 (and the §1.7 fork-related sentences), `values.md` "Forks and rewrites" and backend snapshot mentions, `post-wp05-roadmap.md` (retire the SQLite fork-cost item, add/point to this package), `packages/session-backends/sqlite-node/README.md` fork paragraphs, `packages/agent/benchmark/session/README.md` if dataset wording changes. Historical WP docs and released changelogs untouched. Format/storage versions unchanged; no migration.

## 4. Implementation slices

### Slice A — contract and classifier (core, Memory reference)

Files: `session/types.ts`, new `session/fork-policy.ts`, `session/fork.ts` (rewritten or deleted), `session/values.ts` (only if new helpers are needed), `session/index.ts`, `session/memory.ts`, `session/in-memory-storage-state.ts`, conformance `testing/conformance/session-repo.ts`, `test/harness/memory-conformance.test.ts`, `test/harness/memory-session-repo.test.ts`.

1. Replace `ForkOptions`; implement validation and the classifier/driver.
2. Rewrite Memory fork as direct destination construction at a commit-queue boundary.
3. Rewrite the shared fork conformance for the new contract (§5) and pass it on Memory.

### Slice B — JSONL streaming

Files: `session/jsonl/storage.ts`, `session/jsonl/repo.ts`, `session/jsonl/types.ts`, streaming reader support in the `FileSystem` capability (`harness/types.ts`, `harness/env/*`) if required, `test/harness/jsonl-session-repo.test.ts`, `jsonl-session-repo-conformance.test.ts`, `jsonl-storage.test.ts`, `jsonl-v3-migration.test.ts`.

1. Read-only fixed-prefix source capture with in-memory torn-tail discard; the same capture at the source `commitQueue` boundary for open sources; no source writes on any fork path.
2. Two-pass disk-backed current-state fold and emission for both scopes; branch ancestry membership through the disk index; in-place transformed built-ins; atomic destination publish.
3. Open-v3 fork rejection and the closed-v3 disk-backed parser/normalizer path; update v3 fork tests per §5.


### Slice C — SQLite streaming

Files: `sqlite/repo.ts`, `sqlite/storage.ts`, `sqlite/session/values.ts`, `sqlite/session/entries.ts`, `sqlite/session/branch-entries.ts`, `sqlite/types.ts`, `test/repo.test.ts`, `test/repo-conformance.test.ts`.

1. Replace `SqliteStorage.snapshot()`/array snapshot helpers with the independent-reader-plus-boundary-callback design and iterator transfer into the temporary staging database, then stage-to-destination publication with `finally` cleanup.
2. Branch ancestry/membership/labels through the branch index; classifier-matching SQL prefilters.
3. Preserve WP07 identity, reservation, no-create, and close coverage; both layouts.

### Slice D — benchmarks and documentation

Files: `testing/benchmark/session-repo.ts`, both `session-repo.bench.ts` files, `benchmark/session/README.md`, `harness.md`, `values.md`, `post-wp05-roadmap.md`, sqlite-node `README.md`, changelogs only under normal branch rules.

Update fork option literals, add large-source fork benchmarks (tree and branch), and land the §3.6 documentation set.

## 5. Required tests

### Contract and validation

- branch scope rejects: unknown branch name; data-only Branch (tip only); partial config/state pair (corruption); `entryId` not on the named Branch's tip ancestry (present elsewhere in the tree); `entryId` unknown; `entryId` with a `null` tip. Each rejection leaves no destination artifact and releases its reserved id.
- branch scope accepts: omitted `entryId` (tip), explicit tip, mid-ancestry entry, `position: "before"` at a mid entry and at the root entry (`null` destination tip), `null` source tip with no `entryId`.
- destination shape: exactly one Branch, same name, copied config, fresh idle lane state, no other lane values, `parentSessionId` set.
- tree scope: unreachable entries copied; every tip copied; configured lanes get config plus fresh idle state; data-only Branches stay data-only; partial pairs fault.
- both scopes: session name copied; labels only for copied entries (branch fork excludes labels of non-ancestry entries); `pi.result`, `pi.op.*`, `pi.pending.*` (pending entries, tool checkpoints, assistant frame lists), and usage rows absent; exact stats expectation — a fork copying N message entries reports `getStats()` = `{ messageCount: N, usage: all-zero }`, matching current conformance; the ledger-completeness invariant ("a fork's ledger starts at zero") retained.

### Application values and lists

- tree fork copies every non-`pi.*` scalar and every surviving list element with original seqs; list cursors from the source page identically in the destination; a list deleted-then-reappended in the source reproduces only survivors.
- branch fork copies no application values/lists (pin the §1.1 scalar and list traces as regression cases: post-fork-point overwrite and delete-destroyed elements must not resurface under any implementation).
- current surviving state in an unknown reserved namespace (exact `pi` or an undeclared `pi.*` scalar or surviving list element) fails the fork on every backend; the same namespace **set then deleted** before the fork fails no backend — including JSONL, where the dead history remains as physical lines and the disk fold must classify it as absent. Construct both cases via raw committed writes.

### Sequence preservation

- copied entries, values, and list elements keep source seqs; rewritten branch tips and fresh idle lane states occupy the seqs of the source's current corresponding rows; destination `nextSeq` equals the source high-water mark and the first post-fork commit allocates above it on every backend (JSONL header `nextSeq`, SQLite `next_seq`).
- JSONL derives the high-water mark as `max(header.nextSeq when present, highest complete captured write seq + 1)`; a torn incomplete final write does not advance it.

### Bounded memory and source non-mutation

- instrumented source readers (test decorators/spies) assert fork paths never call `snapshotEntriesAndValues`, `captureForkSource`, `readAllScalarValueRows`, `readAllEntryRows`, whole-file `readTextFile`, or source-sized `.all()` arrays on entries/values/lists — bounded iterator steps and staging-database operations are permitted; deterministic large fixtures (extend the existing benchmark dataset generators) exercise tree and branch forks over multi-thousand-entry sources.
- SQLite staging databases are removed on success and failure; a failed fork leaves neither a stage file nor destination rows.
- JSONL: fork of a closed torn-tail source succeeds, the destination excludes the torn transaction wholly, and the source file bytes are unchanged (byte-compare before/after); fork of a legacy v3 source leaves the source file unchanged; no `.tmp` appears beside the source; temporary ancestry index files are removed on success and failure.
- JSONL fixed-prefix capture: a source append completed after capture is wholly absent from the fork.
- JSONL destination content: the destination file contains only current selected scalar rows and surviving list elements in original seq order — no delete records, superseded sets, or dead application history; the rewritten tip and fresh idle lane state sit at the source current rows' seqs.
- legacy v3: forking an **open** v3 source rejects with the clear pre-upgrade error; after one normal non-empty commit upgrades it to format 4, a fork succeeds and preserves the persisted ids; a **closed** v3 tree fork succeeds through the disk-backed parser (instrumented: no whole-state in-memory normalization on the fork path) and leaves the source byte-identical; a closed v3 branch fork with omitted `entryId` succeeds when a complete configured lane is reconstructed, a caller-supplied id from an earlier open rejects, and a data-only reconstructed main rejects.

### Coordination and ordering

- Memory open-source forks keep the queue-boundary conformance case: a commit admitted before the fork appears wholly; one admitted after does not.
- JSONL open-source forks capture the fixed prefix at the `commitQueue` boundary: a commit admitted before the boundary appears wholly; a source append completed after boundary capture proceeds while the fork is still streaming and is wholly absent from that fork.
- SQLite same-repo: the independent reader opens first, the boundary callback on the source `commitQueue` establishes its snapshot and releases the queue, and a subsequent source commit on the writer connection **completes while the reader is still streaming into the stage** and is wholly absent from that fork; a later fork includes it wholly. Assert this in **both** per-file and shared-container layouts (satisfiable in shared containers because stage writes target another file), plus the WP07 live external-worker case unchanged.
- destination-reservation races (create vs fork on one id, both orders) unchanged.

### Backend equivalence

- one shared conformance source (entries, unreachable entries, multiple lanes, data-only Branch, labels, app scalars/lists with deletes, open operation with pending/frame/checkpoint state, usage rows) forks to identical logical destination state on Memory, JSONL, and SQLite for both scopes.

## 6. Validation and review

After each slice: `npm run check`, then the modified focused tests via the repository Vitest binary from the owning package; `./test.sh` before final review. Grep guards: no remaining `createForkSnapshot|captureForkSource|ForkSourceSnapshot|entriesComplete` outside historical docs and this handoff; no **production fork source path** referencing `"main"` as a literal (this document and the recorded coding-agent mapping in §1.5 intentionally mention main).

Review checkpoints (delegated reviews use provider `anthropic`, model `claude-fable-5`):

1. After Slice A: contract, classifier closure, conformance shape.
2. After Slice C: same-repo ordering, reader independence, bounded-memory evidence.
3. Final review of source, tests, docs, and exclusions.

## 7. Exclusions

Do not include:

- compatibility aliases, a default scope, or implicit `main`;
- any `seq <= tip` cutoff or other historical-state reconstruction;
- a fork-policy registry, plugin hook, or DSL; per-address application opt-ins;
- copying usage rows, `pi.result`, or any open-operation state under any option;
- coding-agent `/fork`, `/clone`, `--fork`, or RPC migration;
- storage-version bumps, migrations, or format changes (formats stay WIP-in-place);
- J1 snapshot compaction (the streaming reader may be built shareable, nothing more);
- SQLite branch-segment redesign or the uncompacted-divergence fix;
- `SessionRepo` interface changes beyond `ForkOptions` (repository `close()` belongs to the lifecycle package);
- precise-rewrite tooling; search; edits to WP00–WP07 documents or released changelog sections.

If implementation requires an excluded item, stop and revise the handoff.

## 8. Exit condition

WP08 is complete when:

- `ForkOptions` is exactly the §1.1 union with the stated validation, on all three backends;
- branch forks require a complete configured source AgentLane and enforce ancestry membership; tree forks copy the complete immutable tree, every tip, configured and data-only Branches;
- tree forks carry all current application values and surviving list elements with original seqs; branch forks carry none;
- one closed core classifier owns every namespace disposition; unknown reserved namespaces (exact `pi` or undeclared `pi.*`) fail forks exactly when current surviving state exists, equivalently on all backends;
- all supported fork paths — including closed legacy v3 sources — are streaming and bounded in auxiliary memory per §1.3, proven by instrumented-reader tests over large fixtures; forking an open legacy-v3 source is explicitly unsupported (clear rejection) until an ordinary commit upgrades it, not handled by an in-memory exception;
- JSONL forks never mutate their source, including torn-tail and legacy v3 sources, and JSONL destinations contain only current selected rows in original seq order;
- SQLite forks stage through a temporary on-disk database (source reader → stage while open, stage → one destination `BEGIN IMMEDIATE` after reader close, stage deleted in `finally`), with the independent-reader boundary design and concurrent later writer commits proven in both layouts, preserving all WP07 behavior;
- copied seqs and `nextSeq` high-water marks are preserved and backends produce identical logical destinations;
- shared conformance, focused backend tests, benchmarks, `npm run check`, and `./test.sh` pass;
- normative docs and the roadmap reflect the new contract with historical documents untouched;
- final Fable review reports no blocker.
