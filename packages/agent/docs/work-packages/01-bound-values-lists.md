# WP01 — Bound values and lists

## Status

Complete. `harness.md` is normative. [`values.md`](../values.md) supplies the detailed address, backend, and conformance design.

## Goal

Replace the retained register/custom-state storage surface with bound `Value<T>` and `ValueList<T>` addresses across Session, Memory, JSONL, SQLite, instrumentation, tests, and public application access. Stop before runtime execution consumers.

## Decisions fixed for this package

1. **Core and application namespaces.** Every core address uses the exact documented `pi.*` namespace. Applications use their own non-reserved namespaces through the same public `value()` / `list()` constructors. `fact.custom` and its API are deleted, not renamed to a built-in custom namespace.
2. **Forks.** Generic forks copy only explicitly handled core addresses: Branch tip/lane configuration plus fresh lane state, session name, and labels whose targets copy. They copy no `pi.op.*`, `pi.pending.*`, list, ledger, or arbitrary application address. A later application feature must add an address-specific fork policy before relying on copied application state.
3. **Trusted kind discipline.** Using one `(namespace, key)` as both a value and a list is a trusted-programming defect. Backends do not add cross-kind collision checks, triggers, registries, or catalogs.
4. **Operation names.** Keep source `OperationMeta` for immutable acceptance metadata and `Operation` for the process-local `{ meta: OperationMeta, state: OperationState }` projection. `operationMeta(id)` binds `Value<OperationMeta>`; the composite is never persisted as one value.
5. **Query ordering and bounds.** `scanValues()` returns key-ascending results. `readList()` limits only one query page, never total list length or bytes: reject non-positive or non-safe limits, default to 1,000, and clamp larger values to 10,000.
6. **No WIP compatibility.** Replace the unfinished format-4 storage schema in place. JSONL remains format 4/storage version 1 but accepts only the new value/list records. SQLite keeps `SQLITE_STORAGE_VERSION = 1`, edits `001_initial.sql` in place, renames `registers` to `scalar_values`, and adds `list_values`. Pre-WP01 format-4 JSONL and SQLite files are unsupported. Add no migration runner or legacy decoder.
7. **Generic infrastructure only.** WP01 defines every built-in value/list constructor, including future assistant/tool addresses, but does not implement their runtime consumers.

## Public and storage contract

Add `packages/agent/src/harness/session/values.ts` with:

- invariant `Value<T>` and `ValueList<T>` address types;
- universal `value<T>(namespace, key?)` and `list<T>(namespace, key?)` constructors;
- namespace/key validation only: non-empty namespace and no `\u0000` component;
- `StoredValue<T>`, `ListElement<T>`, `ListCursor`, and `ListReadOptions`;
- typed `setValue`, `deleteValue`, `appendList`, and `deleteList` write helpers using `NoInfer<T>`;
- every exact built-in constructor and the five scan-prefix constructors from `values.md`.

Replace the old API throughout:

```ts
getRegister(namespace, key)       -> getValue(address)
listRegisters(namespace, prefix) -> scanValues(prefixAddress)
register set/delete writes        -> typed value helpers
```

Storage and the historical Session reader, mutator, tree-view, and repository surfaces expose the same bound-address reads:

```ts
getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;
scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;
readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]>;
```

The historical tree-view and Session surfaces additionally expose one-commit direct writes:

```ts
setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void>;
deleteValue<T>(address: Value<T>): Promise<void>;
appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void>;
deleteList<T>(address: ValueList<T>): Promise<void>;
```

`SessionMutator` retains one explicit `commit(writes)` and does not gain direct committing methods. Each write array composes helper-constructed value/list writes with entries and usage.

Keep `getName` / `setName` and `getLabel` / `setLabel` as wrappers over `sessionName` and `entryLabel(id)`. Delete `getCustomFact` / `setCustomFact`. Rename the public passive metadata event from `fact_update` to the `value_update` shape already specified by `harness.md`; it covers only session-name and entry-label wrappers, not arbitrary application writes.

## Files

### Add

- `packages/agent/src/harness/session/values.ts`
- `packages/agent/test/harness/values.test.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session/values.ts`

### Delete or rename

- delete `packages/session-backends/sqlite-node/src/sqlite/session/registers.ts` after moving its scalar behavior to `values.ts`;
- remove all register/global-map/custom-fact declarations from `packages/agent/src/harness/session/types.ts`.

### Agent source

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/commit.ts`
- `packages/agent/src/harness/session/storage-state.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/fork.ts`
- `packages/agent/src/harness/session/index.ts`
- `packages/agent/src/harness/session/jsonl/storage.ts`
- `packages/agent/src/harness/session/jsonl/repo.ts`
- `packages/agent/src/harness/session/testing/storage-decorator.ts`
- `packages/agent/src/harness/session/testing/instrumented-storage.ts`
- `packages/agent/src/harness/session/testing/types.ts`
- `packages/agent/src/harness/session/testing/conformance/storage.ts`
- `packages/agent/src/harness/session/testing/conformance/session-repo.ts`
- `packages/agent/src/harness/session/testing/benchmark/storage.ts`
- `packages/agent/src/harness/session/testing/benchmark/session-repo.ts`
- `packages/agent/src/harness/session/testing/index.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/telemetry.ts`
- `packages/agent/src/index.ts` and `packages/agent/src/node.ts` only as needed to verify the new public exports; do not add a second export path.

### Agent tests and generated documentation

- `packages/agent/test/harness/memory-storage.test.ts`
- `packages/agent/test/harness/memory-conformance.test.ts`
- `packages/agent/test/harness/memory-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-storage.test.ts`
- `packages/agent/test/harness/jsonl-storage-conformance.test.ts`
- `packages/agent/test/harness/jsonl-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-session-repo-conformance.test.ts`
- `packages/agent/test/harness/storage-backed-session.test.ts`
- `packages/agent/test/harness/session-tree.test.ts`
- `packages/agent/test/harness/session-create-lane.test.ts`
- `packages/agent/test/harness/instrumented-storage.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/telemetry.test.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- regenerated `packages/agent/docs/telemetry-schema.md`

### SQLite backend

- `packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql`
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session.ts`
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`
- `packages/session-backends/sqlite-node/src/sqlite/index.ts` if needed for the renamed module
- `packages/session-backends/sqlite-node/test/storage.test.ts`
- `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`
- `packages/session-backends/sqlite-node/test/repo.test.ts`
- `packages/session-backends/sqlite-node/test/adapter.test.ts`
- `packages/session-backends/sqlite-node/test/sql.test.ts`

### Coding-agent consumer

- `packages/coding-agent/test/experimental-session-support.ts`
- verify `packages/coding-agent/test/experimental-remote-runtime.test.ts`
- verify `packages/coding-agent/test/experimental-server-replacement.test.ts`

If the final old-API grep identifies another retained source/test call site, it belongs to WP01; do not add a compatibility shim to avoid touching it.

## Work, in order

1. **Add the address vocabulary.** Implement `values.ts`, export it through the existing session/root path, and add focused compile-time/runtime address tests. Include exact built-in namespace/key/kind tests and prefix-constructor tests before migrating callers.
2. **Cut the shared API once.** Replace register types and writes in `types.ts`/`commit.ts`; split `StorageState` into current scalar values and surviving list elements; implement Memory reads/writes, ordered prefix scans, paged list reads, transaction validation/application, snapshots, and direct Session methods. Remove custom-fact APIs and migrate name/label wrappers.
3. **Migrate JSONL and generic fork/snapshot code.** Encode only `kind:"value"` and `kind:"list"`; replay set/delete/append/delete; preserve transaction-line torn-tail atomicity; serialize surviving list elements with original `seq` merged in global sequence order; preserve the sequence high-water mark. This extends existing snapshot serialization only—do not add a new compaction trigger or precise-rewrite feature. Forks copy the fixed core set from Decisions item 2, re-sequence destination scalar values after copied entries as today, and copy no lists.
4. **Migrate instrumentation, conformance, and benchmarks.** The storage decorator exposes all three reads; instrumented storage records erased value/list writes in exact order without content telemetry. Extend shared conformance before backend-specific assertions.
5. **Migrate runtime2 shell call sites.** Replace lane/harness raw writes with built-in constructors/helpers. `restore.ts` uses `scanValues(branchTipInventoryPrefix())` plus exact `getValue` lookups and performs no `readList()` call. Do not add acceptance, drive, hydration, or cleanup behavior.
6. **Replace the SQLite WIP schema and adapter.** Edit `001_initial.sql` in place, implement scalar operations and indexed list append/delete/paging in `session/values.ts`, keep every write inside the existing `BEGIN IMMEDIATE` writer-lease transaction, update both fork snapshot paths, and retain all entry/usage/branch/lease behavior from current `dev`.
7. **Migrate public events, tests, and the coding-agent helper.** Remove old type assertions and raw namespaces. Change `fact_update` to `value_update`. Keep the two remote prompt tests skipped for the existing WP00 reason; WP01 must not alter runtime execution.
8. **Update telemetry and documentation.** Change `pi.session.write` item kinds from `register` to `value` and `list`, regenerate `telemetry-schema.md`, run the old-API sweeps, and record any branch-policy-deferred changelog requirement. Do not edit a changelog on `gramps` unless it becomes a pull-request branch or the user requests it.

## Backend requirements

### Memory

- prepare and validate the complete transaction before mutating entries, values, lists, usage, or stats;
- current scalar replacement stores only the latest value and set `seq`;
- list append performs no list read and stores each global write `seq`;
- list delete removes the whole exact key;
- snapshots include current scalar values and surviving list elements.

### JSONL

- keep format 4/storage version 1 with no legacy register decode;
- one single-write object or multi-write array remains one atomic line;
- replay produces the same logical state as Memory;
- torn final lines expose no partial transaction;
- snapshot serialization preserves surviving list-element sequences and the next-sequence high-water mark.

### SQLite

Use:

```sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

Ascending and descending list queries use the primary key with an exclusive sequence predicate and `LIMIT`. Add `EXPLAIN QUERY PLAN` assertions proving no table scan or temporary ordering b-tree. Do not change storage version, add migrations, or weaken the current lease/fence/fork behavior.

## Required coverage

### Address and type tests

- invariant address typing and inferred scalar/list result types;
- `NoInfer` rejects incompatible set/append values;
- scalar helpers reject list addresses and list helpers reject scalar addresses;
- independently constructed equal addresses resolve the same location;
- empty key works; empty namespace and `\u0000` components reject;
- exact built-in namespaces/key grammars and exactly five prefix constructors;
- application-wide and dynamic non-reserved addresses require no second operation-time key;
- no registry, catalog, privilege constructor, global value map, or runtime `pi.*` gate.

### Shared scalar/list conformance

- scalar set/get/delete/delete-absent/recreate and latest set `seq`;
- namespace-scoped, key-ascending prefix scans;
- append one and several elements, including several appends in one transaction;
- appends separated by unrelated writes preserve per-list order and global element sequences;
- ascending/descending exclusive cursors;
- default, explicit, invalid, and clamped query-page limits;
- absent list, whole-list delete, delete-absent, and delete-then-append;
- atomic entry + usage + value + list transactions;
- rollback when any sibling write is invalid;
- no list read on append;
- close rejects later reads while already-admitted commits drain.

Do not add a value/list collision test: cross-kind misuse is intentionally an unenforced trusted-programming defect.

### Backend and repository tests

- identical Memory/JSONL/SQLite pages and cursors;
- JSONL single/multi-write replay, torn-tail behavior, and sequence-preserving snapshot output;
- SQLite query plans and writer-lease transaction behavior;
- branch/tree forks copy session name, eligible labels, and lane configuration/Branch tip with fresh lane state;
- forks exclude operation/pending values, all lists, application addresses, last results, queues, and ledger rows;
- repository parent metadata, entry IDs, stats, branch indexes, v3 normalization, UUIDv7/follower IDs, and current SQLite lease/fork scenarios remain unchanged;
- runtime2 restore enumerates lanes through the one prefix constructor and reads no list.

## Deferred consumers

The following `values.md` requirements are explicitly not WP01 coverage:

- assistant frame conversion, append scheduling, settlement, recovery, cancellation, snapshot hydration, and byte-growth tests (R2/R3/R6/R12);
- invocation `getMemo` / `setMemo`, tool-output checkpoint writes, outcome cleanup, and prefix-driven operation cleanup (R4/R6);
- any consumption-time list hydration beyond proving base restore reads no list;
- runtime acceptance, driving, provider/tool effects, or operation-state redesign.

WP01 still exports `pendingAssistantFrames`, `operationToolMemo`, `pendingToolOutput`, and every cleanup prefix so later packages do not redesign storage.

## Removal checks

These must have zero matches in retained source/tests, excluding immutable released changelog history and archived prose:

```bash
rg -n 'getRegister\(|listRegisters\(|RegisterValues|RegisterNamespace|RegisterSetWrite|\bRegister<' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n 'kind: "register"|getCustomFact\(|setCustomFact\(|fact\.(name|label|custom)|fact_update' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '"(branch\.tip|lane\.(config|state|lastResult)|op\.(meta|state|tool_args|preparation)|pending\.entry)"' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '\bregisters\b' packages/agent/src/harness/session packages/session-backends/sqlite-node/src \
  --glob '*.ts' --glob '*.sql'

rg -n '"register"' \
  packages/agent/src/harness/telemetry.ts \
  packages/agent/test/harness/telemetry.test.ts \
  packages/agent/docs/telemetry-schema.md
```

Do not treat unrelated model/provider/hook registration terminology as storage API residue.

## Validation

Run each created or modified test file directly and iterate until green. At minimum:

```bash
# From packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/values.test.ts \
  test/harness/memory-storage.test.ts \
  test/harness/memory-conformance.test.ts \
  test/harness/memory-session-repo.test.ts \
  test/harness/jsonl-storage.test.ts \
  test/harness/jsonl-storage-conformance.test.ts \
  test/harness/jsonl-session-repo.test.ts \
  test/harness/jsonl-session-repo-conformance.test.ts \
  test/harness/storage-backed-session.test.ts \
  test/harness/session-tree.test.ts \
  test/harness/session-create-lane.test.ts \
  test/harness/instrumented-storage.test.ts \
  test/harness/types.test.ts \
  test/harness/telemetry.test.ts \
  test/harness/runtime2/harness.test.ts \
  test/harness/runtime2/lane.test.ts \
  test/harness/runtime2/restore.test.ts

# From packages/session-backends/sqlite-node
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/adapter.test.ts \
  test/repo.test.ts \
  test/sql.test.ts \
  test/storage.test.ts \
  test/storage-conformance.test.ts

# From packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/experimental-remote-runtime.test.ts \
  test/experimental-server-replacement.test.ts
```

Then run from the repository root:

```bash
cd packages/agent && npm run check:telemetry-docs
cd "$(git rev-parse --show-toplevel)"
node_modules/.bin/tsgo --noEmit -p packages/agent/tsconfig.build.json
node_modules/.bin/tsgo --noEmit
git diff --check
npm run check
./test.sh
```

Never run unrestricted Vitest, `npm test`, paid-provider tests, or `npm run build`.

## Stop condition

Stop when every retained backend and Session surface uses bound values/lists; all core addresses use the exact `pi.*` grammar; arbitrary application addresses work but generic forks exclude them; old register/fact/custom-state APIs and physical names are absent; base restore performs no list read; schema/compatibility decisions above are implemented; focused, conformance, TypeScript, telemetry-doc, diff, and repository checks pass. Report the final schema and fork behavior. Do not begin runtime acceptance, assistant/tool consumers, or any later work package.
