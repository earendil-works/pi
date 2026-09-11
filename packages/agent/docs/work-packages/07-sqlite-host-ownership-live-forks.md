# WP07 — SQLite host ownership and live-source forks

**Status: implemented.**

The delivered backend has no writer lease or replacement ownership primitive. It provides no-create read-write/read-only opens, queued same-repository snapshots, independent read-only WAL snapshots for live external sources, canonical physical identity, path-safe IDs, repository-local deletion reservation, and all-settled close. The tests cover both per-file and shared-container layouts, including a writer commit completed after a read snapshot boundary but before that reader closes.

This package aligns `packages/session-backends/sqlite-node` with the product ownership model: the server owns Session records and worker lifecycle, and exactly one host-assigned process owns writable Session authority at a time. Normally that process is the Session worker. The server may temporarily own a newly created or forked destination, but it closes that Session before handing its metadata to a worker.

Storage does not implement writer ownership. Remove the SQLite writer lease; do not repair or replace it.

A server-side fork is intentionally different from a second writer: it may open a live worker-owned source concurrently for one coherent read-only snapshot while the worker keeps committing. Shared SQLite containers remain supported.

## 0. Mandatory reading

Read completely before editing:

1. `packages/agent/docs/plugins.md` ownership, replacement, and removal sections.
2. `packages/server/README.md` and relevant Session routing/removal source and tests.
3. `packages/agent/docs/harness.md` §§0.6, 1.4–1.7, 2.7–2.8, 4.3, and Part 9.
4. `packages/agent/docs/post-wp05-roadmap.md`.
5. completed WP06 §7 and repository/fork conformance.
6. every source file under `packages/session-backends/sqlite-node/src`.
7. every test and benchmark under `packages/session-backends/sqlite-node`.
8. `packages/session-backends/sqlite-node/README.md` and `CHANGELOG.md`.

Do not use stale files under `dist/` as implementation input. Completed WP01/WP06 documents are historical; do not rewrite them to hide the earlier lease implementation.

## 1. Fixed architecture

### 1.1 Writable authority belongs to the host

Exactly one host-assigned process owns a writable Session. The Session worker is the normal owner. Worker replacement closes the old owner before the new worker opens the Session. Server management serializes creation, forking, removal, and attachment lifecycle around that ownership transfer.

Memory, JSONL, and SQLite do not detect a second process opening the same Session for writes. Bypassing the server/worker lifecycle is a trusted-host defect, not a storage race to repair. A repository still rejects duplicate writable handles it owns in one process.

Do not add a storage lease, filesystem lock, fencing token, heartbeat, timeout-based takeover, deletion tombstone, quarantine protocol, or generic lock manager.

### 1.2 Read-only fork access may overlap the worker

The server owns repository administration and may fork a source while its Session worker continues writing it. The source side of that fork:

- opens the exact source container without creating it;
- is read-only;
- uses one deferred `BEGIN` transaction;
- reads the version-gated Session row, scalar values, and selected entries/branch index in that transaction;
- never upgrades to a write or claims writable authority;
- closes after `COMMIT`/`ROLLBACK`.

SQLite WAL permits later worker commits while the read transaction remains open. The fork sees each source commit entirely before or entirely after its snapshot boundary, never a mixture.

### 1.3 Same-repository fork ordering remains distinct

A source already open in the same repository uses its active `SqliteStorage.snapshot()` path. That snapshot is queued on the source `commitQueue`, preserving WP06's admitted-commit ordering seam and the existing conformance case.

Do not replace this path with an independent connection. Instead, bind active storage lookup to exact physical identity plus Session ID so metadata for another container cannot select it accidentally.

### 1.4 Destination ownership does not overlap

`SessionRepo.create()` and `fork()` continue returning an open Session. A server may temporarily own that new destination, capture its metadata, and close it before launching a worker. This is a valid ownership transfer, not a reason to redesign `SessionRepo` into a record-only API.

## 2. Problems in current source

### 2.1 SQLite duplicates host ownership

Current source contains:

- `writer_lease` schema state;
- claim, renew, and release helpers;
- lease claims in create/open/fork;
- an idle renewal timer and lease-loss path in `SqliteOpenSession`;
- a pre-commit renewal callback in `SqliteStorage`;
- lease-based deletion checks.

This is a second, incomplete ownership system. Its pre-commit renewal is not atomic with the following data transaction, but the correct fix is deletion of the ownership mechanism, not transaction-local fencing.

### 2.2 Non-creation access can create files

The database factory exposes only `open(path)`, which creates a missing SQLite file. Metadata open, listing probes, deletion, and fork-source reads must not turn a removed path into an empty database.

Fork-source reads also configure `PRAGMA journal_mode = WAL`, which is a write-oriented setup step and must not run on a read-only connection.

### 2.3 Delete does not reserve its local critical section

`delete()` checks `pendingIds` but does not reserve the ID. A same-repository create/open/fork destination can enter while asynchronous destructive work is in progress. Host lifecycle owns cross-process ordering; the repository still must serialize its own local operations.

### 2.4 Physical identity, paths, and close need correction

- `openStorages` is keyed only by Session ID, so the same ID at another physical path may select the wrong active source.
- `create()` makes `options.directory`, not the parent of an explicit `databasePath`.
- Per-session filenames interpolate arbitrary caller IDs directly; `/`, `\`, `..`, `%`, and platform separators must not escape `directory`.
- `repo.close()` uses fail-fast `Promise.all`, so it may return before every open Session has attempted to drain and close.

Deterministic list ordering, bind-variable limits, branch-copy cost, fork scalar filtering, prepared statements, and VACUUM policy remain separate.

## 3. Required result

### 3.1 Remove storage-layer writer ownership

Delete all runtime lease behavior:

- delete `src/sqlite/session/writer-lease.ts`;
- remove `writer_lease` from WIP `001_initial.sql`;
- remove lease deletion from `deleteSessionRows()`;
- remove claim/renew/release code from `SqliteSessionRepo`;
- remove `beforeCommit` from `SqliteStorage`;
- remove renewal/release options, timer, and `leaseError` from `SqliteOpenSession`;
- remove lease-specific tests and replace them with host-authority and live-fork coverage.

Keep:

- the Storage `commitQueue`;
- one `BEGIN IMMEDIATE` transaction per commit;
- in-transaction `next_seq` allocation;
- entry/usage uniqueness and parent triggers;
- Session mutation admission and close draining;
- process-local duplicate-open rejection.

Format 4 remains WIP. Remove the table from new schema in place; an old file containing an unused `writer_lease` table remains readable and the table and stale rows are ignored forever. Post-WP07 code does not delete them because doing so serves no runtime behavior. A pre-WP07 binary cannot open a new post-WP07 database without that table; backward compatibility for this WIP format is not required. Add no migration, compatibility path, or storage-version bump.

### 3.2 Add explicit database open modes

Extend `SqliteDatabaseFactory` with narrow operations:

- `open(path)` — intentional creation or create-if-missing;
- `openExisting(path)` — read-write open that fails if the file does not exist;
- `openReadOnly(path)` — read-only open that fails if the file does not exist.

The Node adapter uses `DatabaseSync(path, { readOnly: true })` for read-only access. Implement and test an actual no-create read-write mode for `openExisting`; do not rely on `access()` followed by a create-capable open.

Split connection setup:

- writable connections establish WAL mode and `busy_timeout`;
- read-only connections set only read-safe options such as `busy_timeout` and never attempt to change journal mode.

Use no-create modes for metadata open, listing probes, deletion, and fork-source reads.

### 3.3 Preserve both fork-source paths

**Source open in this repository:** retain `SqliteStorage.snapshot()` and queue it after prior admitted commits. Replace the ID-only active map key with canonical `(containerPath, sessionId)` identity and use the same helper for publish, lookup, and removal.

**Source not open in this repository:** this includes a closed source and a source currently owned by a worker in another process. Open the exact source through `openReadOnly`, then capture it in one deferred read transaction. Validate the Session row and storage version inside that transaction. Do not consult destination reservations, claim source ownership, or block the worker's later commits.

The destination remains a normal writable create/fork transaction after source capture. In shared-container mode the source worker and destination transaction may use the same file; SQLite serializes destination writes while preserving Session row isolation.

### 3.4 Make deletion locally exclusive

The host must close the Session worker before calling `repo.delete()`. Direct cross-process deletion of a live Session is unsupported.

Within one `SqliteSessionRepo`, deletion must reserve the Session ID from entry through completion and release it in `finally`:

- an already open or reserved Session rejects deletion;
- create/open/fork destination for that ID rejects while deletion runs;
- shared-container deletion removes only the target Session's rows in one `BEGIN IMMEDIATE` transaction on one connection;
- per-file deletion removes the database and its WAL/SHM sidecars after a no-create open/existence check;
- a missing Session rejects without creating a file.

Do not add a lease check, tombstone, quarantine rename, or stale-deleter protocol. Cross-process removal ordering is the server's responsibility.

### 3.5 Bind metadata to physical identity and make paths safe

- Canonical identity is `(canonical container path, sessionId)`.
- In per-file mode metadata must identify the repository-affine encoded path for its durable ID.
- In shared-container mode metadata must identify the configured canonical container and Session ID.
- A foreign or mismatched path must never alias a local active source. Pin in focused tests and the SQLite README whether foreign source metadata is rejected or read only from its exact path; do not silently substitute a local storage by ID.
- Create `dirname(databasePath)` when `databasePath` is configured.
- Encode arbitrary explicit IDs into safe per-session filenames without changing the durable ID. The encoding must prevent path escape and round-trip through metadata/list/open/fork.
- Two different Session IDs in one shared container remain independently addressable.

### 3.6 Drain all repository-owned closes

`SqliteSessionRepo.close(context)` must:

1. seal repository admission once;
2. start close on every currently open Session;
3. wait for every close to settle;
4. resolve when all succeed;
5. otherwise reject only after all cleanup attempts, returning the one error or an `AggregateError` containing all failures;
6. return the same promise on repeated close.

This is backend-local resource cleanup. Do not change the shared `SessionRepo` interface or JSONL lifecycle in this package.

## 4. Implementation slices

### Slice A — remove writer leases

Files:

- delete `src/sqlite/session/writer-lease.ts`;
- `src/sqlite/migrations/001_initial.sql`;
- `src/sqlite/session/session-row.ts`;
- `src/sqlite/storage.ts`;
- `src/sqlite/session.ts`;
- `src/sqlite/repo.ts`;
- lease-focused repository tests.

Tasks:

1. Remove schema/runtime lease state and timer behavior.
2. Preserve commit serialization, one write transaction, mutation draining, and process-local duplicate-open behavior.
3. Prove ordinary commits now use one write transaction rather than renewal plus write.

### Slice B — no-create opens and deletion reservation

Files:

- `src/index.ts`;
- `src/sqlite/types.ts`;
- `src/sqlite/repo.ts`;
- focused adapter/repository tests.

Tasks:

1. Add `openExisting` and `openReadOnly` with tested no-create behavior.
2. Separate writable and read-only connection configuration.
3. Reserve deletion locally for its full critical section.
4. Delete one shared-container Session in one transaction; preserve unrelated Sessions.

### Slice C — live-source read-only forks and identity

Files:

- `src/sqlite/repo.ts`;
- repository/conformance tests.

Tasks:

1. Key active storage by canonical container plus Session ID; keep same-repository queue ordering.
2. Use one independent read-only deferred transaction for non-open/live-worker sources.
3. Validate source metadata/version inside the snapshot.
4. Preserve shared-container destination behavior.

### Slice D — paths and close draining

Files:

- `src/sqlite/repo.ts`;
- focused repository/conformance tests.

Tasks:

1. Create the actual custom container parent.
2. Encode arbitrary IDs safely.
3. Reject or exactly handle foreign metadata without active-source aliasing.
4. Make repository close all-settled and error-complete.

### Slice E — documentation

Files:

- `packages/agent/docs/harness.md`;
- `packages/agent/docs/post-wp05-roadmap.md`;
- `packages/agent/docs/values.md`;
- `packages/session-backends/sqlite-node/README.md`;
- changelog only under normal branch rules.

Document host-owned writable authority, the two fork-source paths, no-create opens, local deletion reservation, and absence of storage-layer ownership.

## 5. Required tests

Use real independent `node:sqlite` connections. Test-only wrappers may expose deterministic transaction boundaries; production code gets no sleeps or race flags.

### Lease removal

- new schema has no `writer_lease` table;
- create/open/fork/commit/close perform no lease reads or writes and start no renewal timer;
- same-repository duplicate writable open still rejects through process-local reservation;
- ordinary commit remains one `BEGIN IMMEDIATE` transaction.

### Live fork source

For both per-file and shared-container layouts:

- a server repository forks a source held open by a separate repository/connection representing its worker;
- source capture uses a distinct read-only connection and claims no writable ownership;
- a source commit completed before the snapshot boundary appears wholly in the fork;
- a commit after the read snapshot is established can complete before the reader closes and is wholly absent from that fork;
- no fork contains an entry without the same commit's Branch tip/value/stats changes;
- a later fork includes the later commit;
- same-repository admitted-commit fork conformance remains unchanged.

### Deletion

- open/reserved Session first → same-repository delete rejects;
- delete reservation first → same-repository create/open/fork destination for that ID rejects;
- shared deletion removes only the target rows;
- per-file deletion removes database/WAL/SHM files;
- missing-path open/list/fork/delete does not create an empty database;
- tests state the host precondition: worker close precedes deletion; no cross-process bypass safety is promised.

### Identity and paths

- same Session ID at two physical paths cannot cross-select active source storage;
- two Session IDs in one shared container remain independent;
- `databasePath` succeeds when its parent does not exist;
- explicit IDs containing `../`, `/`, `\`, `%`, dots, and Unicode stay inside `directory` and preserve the metadata ID;
- metadata returned by create/list/open/fork names the actual container.

### Close

- one Session close failure does not prevent every other Session cleanup attempt;
- multiple failures are reported after all settle;
- repeated repository close returns the same promise;
- every successfully closed Session releases its connection.

### Regression

- existing storage and repository conformance remains semantically unchanged;
- fork destination reservation and same-repository source ordering remain intact;
- fork snapshots exclude operation/pending/result/usage/application state exactly as before;
- shared-container create/list/open/fork/delete remains supported;
- every write transaction still uses `BEGIN IMMEDIATE`;
- no migration, storage-version bump, compatibility layer, or replacement ownership primitive appears.

## 6. Validation and review

After each code slice:

```bash
npm run check
```

Run each modified focused test from `packages/session-backends/sqlite-node` with the repository Vitest binary. Final validation:

```bash
./test.sh
```

Review checkpoints:

1. Fable after Slice A: verify no storage ownership mechanism remains and close draining is intact.
2. Fable after Slice C: verify same-repository ordering and live-worker read-only overlap both hold.
3. Final Fable review of source, tests, docs, and exclusions.

Delegated reviews use provider `anthropic` and model `claude-fable-5`.

## 7. Exclusions

Do not include:

- any storage lease, lock, fence, heartbeat, takeover, tombstone, or quarantine;
- a record-only `SessionRepo` redesign or compatibility facade;
- server/router/worker-manager redesign; record any backend-independent lifecycle race separately;
- SQLite branch-segment redesign or uncompacted-divergence optimization;
- fork scalar filtering/indexing;
- `getEntries` bind-limit chunking or general query-limit normalization;
- statement caches or stats aggregation optimization;
- catalog redesign, async database replacement, or VACUUM policy;
- search/FTS;
- R11 migration machinery or a storage-version bump;
- [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) changes or JSONL compaction;
- repository-wide `SessionRepo.close()` contract changes;
- removal of shared-container support;
- transaction DSLs, schedulers, generic lock managers, or compatibility layers.

If implementation requires an excluded item, stop and revise the handoff rather than expanding silently.

## 8. Exit condition

WP07 is complete when:

- SQLite contains no active or schema-defined writer lease and implements no replacement ownership mechanism;
- host ownership is the documented single-writer authority;
- same-repository active-source forks retain their queued commit boundary;
- live worker-owned sources fork through an independent read-only snapshot while later WAL commits continue;
- deletion reserves its same-repository critical section and assumes worker-first host removal;
- non-creation paths cannot create empty databases;
- active source identity includes physical container plus Session ID;
- explicit IDs cannot escape the directory and custom database parents are created;
- repository close waits for every cleanup attempt;
- shared-container mode remains fully covered;
- focused tests, `npm run check`, and `./test.sh` pass;
- final Fable review reports no blocker.
