# Add SQLite Session Support to `pi-coding-agent`

## Goal

Add opt-in SQLite session persistence to `packages/coding-agent` by building on
PR #6594's `SqliteSessionRepo` and `SqliteSessionStorage`. Preserve existing
coding-agent behavior, JSONL compatibility, and extension-facing session APIs.
Do not make SQLite the default in this plan.

## Product Decisions

- Persistent storage is selected with `PERSISTENT_STORE=jsonl|sqlite`; the
  variable defaults to `jsonl` when unset.
- Reject unsupported `PERSISTENT_STORE` values with a clear startup error rather
  than silently falling back. Treat values case-insensitively and normalize them
  to the `PersistentStore` union `"jsonl" | "sqlite"`.
- `--no-session` remains the explicit memory-only mode and takes precedence over
  `PERSISTENT_STORE`; memory is not a persistent-store value.
- The default SQLite database is a single database under the agent directory,
  so listing sessions across working directories does not require scanning one
  database per project.
- `--session-dir` and the `sessionDir` setting remain supported. In SQLite mode,
  they select the directory containing the database rather than a JSONL file
  directory.
- Existing JSONL sessions remain readable and importable. Enabling SQLite does
  not silently migrate or dual-write them.
- SQLite sessions can always be exported to JSONL. JSONL import writes into the
  currently selected backend.
- A persisted session is identified by backend, session ID, and storage path.
  A database path alone is not a session identity.
- `getSessionFile()` remains a compatibility API and returns a value only for a
  JSONL-backed session. New internal code must use a backend-neutral session
  reference.
- Coding-agent keeps synchronous cached reads for rendering and extension
  callbacks, but initialization and every persistent mutation are asynchronous
  and awaited. Fire-and-forget SQLite writes are forbidden.
- Empty sessions that never receive an assistant message must not accumulate in
  the SQLite session selector.

## Working Rules

- Implement one unchecked numbered step per verified commit.
- Keep the branch buildable and the relevant package tests green after every
  step.
- Add or update tests in the same step as each behavior change.
- Reuse public APIs exported by `@earendil-works/pi-agent-core`; do not import
  SQLite schema internals from `packages/agent/src` into coding-agent.
- Do not add an npm SQLite driver to coding-agent. The Node integration uses the
  PR's `node:sqlite` adapter and the repository's existing Node requirement.
- Await persistence before an agent event settles, before replacing a runtime,
  and before process/session disposal.
- Preserve JSONL version-3 import/export and migration behavior.
- After changing package exports or dependencies, regenerate and check the
  coding-agent shrinkwrap and install lock.

## [ ] 1. Complete the Core Session Lifecycle Contract

- Add an optional close/cleanup capability to the shared session storage
  contract and expose an idempotent `Session.close()` method.
- Make JSONL and in-memory storage valid no-op implementations and wire SQLite
  storage cleanup through the common contract.
- Align the shared entry model needed by coding-agent, including leaf navigation,
  `active_tools_change`, `CompactionEntry.retainedTail`, and transitional
  optional `firstKeptEntryId` handling.
- Ensure a failed SQLite append restores every mutated in-memory field and
  includes the original failure as the `SessionError` cause.
- Extend the shared storage tests to run lifecycle, append, navigation,
  compaction, reopen, and close behavior against memory, JSONL, and SQLite.

**Acceptance:** callers can own and reliably close any core `Session`; all three
storage implementations satisfy the same tested lifecycle and entry semantics.

**Verify:**

```sh
npm run test:harness --workspace packages/agent
npm run build --workspace packages/agent
npx tsgo --noEmit
```

## [x] 2. Introduce a Backend-Neutral Coding-Agent Session Contract

- Define a backend-neutral session reference containing backend kind, session
  ID, and storage path, and add it to coding-agent session metadata.
- Split `SessionManager` responsibilities into a backend-independent facade and
  repository/storage adapters without changing JSONL behavior.
- Initialize the facade asynchronously, then maintain an in-memory snapshot for
  synchronous read methods used by rendering and extensions: `getEntry`,
  `getEntries`, `getBranch`, `getTree`, `getLabel`, `getSessionName`, and
  `buildSessionContext`.
- Convert persistent mutation methods to asynchronous methods that update the
  snapshot only after storage succeeds.
- Keep `getSessionFile()` as a JSONL-only compatibility method and migrate new
  internal identity comparisons to the backend-neutral reference.
- Add JSONL regression tests proving create, deferred persistence, resume,
  branch/reset, fork, labels, rename, compaction, and context construction are
  unchanged.

**Acceptance:** coding-agent session behavior is expressed through a backend
contract, JSONL remains fully functional, and no persistent mutation is
fire-and-forget.

**Verify:**

```sh
npm run test --workspace packages/coding-agent -- --run test/session-manager.test.ts
npm run test --workspace packages/coding-agent -- --run test/session-tree.test.ts
npx tsgo --noEmit
```

## [ ] 3. Add the SQLite Coding-Agent Repository Adapter

- Add a coding-agent SQLite adapter backed by `SqliteSessionRepo` and
  `SqliteNodeExecutionEnv` from the public agent-core SQLite subpaths.
- Implement create, open by session ID, continue recent, list by cwd, list all,
  delete, and fork operations.
- Resolve the default and custom database locations consistently with
  `agentDir`, `--session-dir`, and the `sessionDir` setting.
- Implement lazy creation or equivalent cleanup so abandoned pre-assistant
  sessions do not remain visible.
- Ensure each opened session has explicit ownership and closes its database
  handle during replacement or disposal.
- Add SQLite adapter tests covering durable reopen, exact-ID lookup, cwd
  filtering, custom database paths, forks, empty-session cleanup, lock errors,
  and repeated open/close cycles.

**Acceptance:** the coding-agent facade can perform its complete repository
lifecycle against SQLite without depending on JSONL files or leaking database
handles.

**Verify:**

```sh
npm run test --workspace packages/coding-agent -- --run test/sqlite-session-manager.test.ts
npm run test:harness --workspace packages/agent
npx tsgo --noEmit
```

## [ ] 4. Wire Persistent-Store Selection into CLI and SDK Startup

- Define and export a validated `PersistentStore = "jsonl" | "sqlite"` type and
  one environment parser for `PERSISTENT_STORE`; default it to `jsonl`, normalize
  case, and reject unsupported values.
- Select the repository from the normalized persistent-store value. Keep
  `--no-session` as a higher-precedence request for the memory backend rather
  than adding `memory` to `PersistentStore`.
- Add an explicit SDK `persistentStore` option so SDK users do not need to mutate
  process environment state; an explicit SDK value takes precedence over the
  environment variable.
- Route create, `--continue`, `--resume`, `--session <id>`, `--session-id`, and
  `--fork` through the selected backend.
- Keep direct `.jsonl` paths recognized as JSONL imports/opens rather than
  interpreting them as SQLite identities.
- Make duplicate explicit session IDs fail consistently in both backends.
- Add argument/startup tests for the unset/default JSONL value, explicit JSONL,
  SQLite selection, case normalization, invalid values, `--no-session`
  precedence, local/global lookup precedence, and custom session directories.

**Acceptance:** users and SDK callers can opt into SQLite while existing CLI
commands retain their behavior and JSONL remains the default.

**Verify:**

```sh
npm run test --workspace packages/coding-agent -- --run test/args.test.ts
npm run test --workspace packages/coding-agent -- --run test/sdk-session-storage.test.ts
npm run test --workspace packages/coding-agent -- --run test/sqlite-cli-session.test.ts
npx tsgo --noEmit
```

## [ ] 5. Await Persistence Across Agent and Runtime Lifecycles

- Await message, custom-message, model, thinking-level, compaction, branch
  summary, label, and session-name writes in `AgentSession` and interactive
  command paths.
- Await session creation/open/fork in `AgentSessionRuntime` for `/new`, resume,
  switch, fork, and import flows.
- Flush and close the old backend before rebinding extensions or exposing the
  replacement runtime.
- Close the active session during normal disposal and preserve the original
  error when both shutdown hooks and storage cleanup fail.
- Ensure persistence failures are surfaced as user-visible session errors and
  do not leave the cached tree ahead of durable storage.
- Add tests with delayed and failing fake storage to prove write ordering,
  replacement ordering, no post-disposal writes, and failure propagation.

**Acceptance:** session events and runtime transitions cannot outrun SQLite
writes, and all shutdown/replacement paths deterministically release storage.

**Verify:**

```sh
npm run test --workspace packages/coding-agent -- --run test/agent-session-persistence.test.ts
npm run test --workspace packages/coding-agent -- --run test/agent-session-runtime.test.ts
npm run test --workspace packages/coding-agent -- --run test/rpc-prompt-response-semantics.test.ts
npx tsgo --noEmit
```

## [ ] 6. Make Session Discovery and Selection Backend-Neutral

- Build the existing `SessionInfo` view for SQLite sessions, including created
  and modified times, parent identity, display name, message count, first user
  message, and searchable message text.
- Extend agent-core SQLite materialization through a migration if those fields
  cannot be listed efficiently through public repository APIs; keep migrations
  additive and covered by upgrade tests.
- Update session-selector family grouping to use backend-neutral parent
  identities instead of JSONL parent paths.
- Update rename, current-session highlighting, local/global search, exact/prefix
  ID matching, progress callbacks, and sorting to work for mixed backend
  results.
- Keep malformed or individually unreadable sessions isolated so one bad row or
  JSONL file does not break the selector.
- Add selector/search tests using equivalent JSONL and SQLite fixtures.

**Acceptance:** SQLite sessions have feature parity in resume/search/rename UI,
and listing does not require opening and decoding every session entry.

**Verify:**

```sh
npm run test --workspace packages/agent -- --run sqlite-migrations.test.ts
npm run test --workspace packages/coding-agent -- --run test/session-selector-search.test.ts
npm run test --workspace packages/coding-agent -- --run test/session-selector-rename.test.ts
npm run test --workspace packages/coding-agent -- --run test/sqlite-session-list.test.ts
npx tsgo --noEmit
```

## [ ] 7. Preserve JSONL Import and Export Interoperability

- Export the active branch of either backend as a valid version-3 JSONL file,
  with parent IDs re-chained exactly as the current exporter requires.
- Import JSONL transactionally into the selected backend, preserving cwd
  override behavior, labels, compactions, custom entries, and the active branch.
- Support forking a JSONL source into SQLite and exporting that fork back to
  JSONL without semantic changes.
- Detect ID collisions before import and leave both source and destination
  unchanged on parse or write failure.
- Keep HTML export backend-neutral by rendering from the cached/read-only
  session contract rather than reopening `getSessionFile()`.
- Add JSONL → SQLite → JSONL and HTML export round-trip tests.

**Acceptance:** SQLite never traps session data; import/export and cross-backend
forking preserve context, tree semantics, and user-visible metadata.

**Verify:**

```sh
npm run test --workspace packages/coding-agent -- --run test/session-import.test.ts
npm run test --workspace packages/coding-agent -- --run test/session-export.test.ts
npm run test --workspace packages/coding-agent -- --run test/sqlite-session-roundtrip.test.ts
npx tsgo --noEmit
```

## [ ] 8. Update Public APIs, Documentation, and Distribution Metadata

- Export the backend option and backend-neutral session reference from the
  coding-agent SDK without exposing implementation-only adapters.
- Document experimental enablement, database location, custom session
  directory semantics, backup requirements for WAL databases, JSONL
  interoperability, and rollback to JSONL.
- Update SDK session examples to demonstrate explicit SQLite configuration and
  disposal.
- Regenerate package lock, coding-agent shrinkwrap, and coding-agent install
  lock if package metadata or exports changed.
- Add a changelog entry that clearly states SQLite remains experimental and
  opt-in.

**Acceptance:** installed-package users can configure and understand SQLite
support using only documented public APIs, and generated dependency metadata is
consistent.

**Verify:**

```sh
npm run build
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
npm run check:pinned-deps
```

## [ ] 9. Run Full Validation and Record Rollout Readiness

- Run the complete monorepo test, check, and build suites on Node's minimum
  supported version or the closest CI-equivalent environment available.
- Run focused SQLite smoke tests in interactive, print, and RPC modes using a
  temporary agent directory.
- Verify no database, WAL, or SHM handles remain after session switching and
  process exit.
- Compare create, append, resume, list, and selector-search behavior against
  equivalent JSONL fixtures and record any intentional differences in docs.
- Confirm `PERSISTENT_STORE` defaults to JSONL and changing it between `jsonl`
  and `sqlite` does not modify or delete either backend's data.

**Acceptance:** all validation passes, no known data-loss or handle-leak issue
remains, and experimental rollout/rollback behavior is documented.

**Verify:**

```sh
npm test
npm run check
npm run build
```

## Completion Criteria

- `pi-coding-agent` supports create, resume, continue, list, search, rename,
  branch, fork, import, export, and delete with SQLite sessions.
- JSONL remains the default and all existing JSONL behavior remains covered.
- Every persistent mutation and lifecycle close is awaited.
- Session switching and process disposal leave no SQLite handles or queued
  writes behind.
- Session selection has equivalent user-visible metadata for JSONL and SQLite.
- SQLite schema changes are migration-tested from PR #6594's initial schema.
- Public SDK and CLI documentation describe enablement, storage location,
  interoperability, backup, and rollback.
- Full tests, checks, and builds pass.
