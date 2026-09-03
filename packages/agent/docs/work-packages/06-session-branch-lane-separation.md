# WP06 — Session, Branch, Lane separation

**Status: implemented before WP05 M4.** WP05 M3 remains complete. Retry/deferred work resumes on the composition, mutation, and ownership boundaries landed here.

This package replaces the mixed `SessionTree`/implicit-main inheritance design with four explicit concepts:

```text
Session       global durable data + one mutation line
Branch        one path through the entry tree, with a movable tip
AgentLane     Branch data surface + agent operations/configuration
AgentHarness  manager of AgentLanes; never a lane itself
```

---

## 0. Mandatory reading

Read completely before editing:

1. `packages/agent/docs/harness.md`.
2. `packages/agent/docs/work-packages/05-direct-durable-drive.md`.
3. `packages/agent/src/harness/session/types.ts`.
4. `packages/agent/src/harness/session/session.ts`.
5. `packages/agent/src/harness/session/memory.ts`.
6. `packages/agent/src/harness/session/jsonl/repo.ts` and `jsonl/storage.ts`.
7. `packages/session-backends/sqlite-node/src/sqlite/session.ts`, `storage.ts`, and repo implementation.
8. `packages/agent/src/harness/runtime/lane.ts`, `harness.ts`, `restore.ts`, and `types.ts`.
9. `packages/agent/src/harness/agent-harness.ts`.
10. `packages/agent/src/harness/session/fork.ts` and repository conformance tests.
11. Every test named in §8 before modifying it.

Do not inspect deleted runtime implementations or Git history. Current source, `harness.md`, WP05, and this package are the only sources of truth.

---

## 1. Problem

### 1.1 `SessionTree` mixes unrelated ownership

`SessionTree` currently contains:

```ts
interface SessionTree {
	// Lane/path data.
	getLeafId(...): Promise<string | null>;
	findEntriesOnBranch(...): Promise<Entry[]>;
	findEntryOnBranch(...): Promise<Entry | undefined>;
	appendMessage(...): Promise<string>;
	appendCustomEntry(...): Promise<string>;

	// Session-global data that is not lane- or branch-owned.
	getEntry(...): Promise<Entry | undefined>;
	getStats(...): Promise<SessionStats>;
	findEntries(...): Promise<Entry[]>;
	findEntry(...): Promise<Entry | undefined>;
	getValue(...): Promise<StoredValue<unknown> | undefined>;
	setValue(...): Promise<void>;
	readList(...): Promise<ListElement<unknown>[]>;
	appendList(...): Promise<void>;
	getName(...): Promise<string | undefined>;
	setName(...): Promise<void>;
	getLabel(...): Promise<string | undefined>;
	setLabel(...): Promise<void>;
}
```

A selected tree view changes only which mutation queue a global write enters. It does not change the durable address. Two views can therefore read the same global value under different lane lines and commit a lost update.

### 1.2 `Session` silently means `main`

`Session extends SessionTree`. Its inherited branch methods and high-level writes silently delegate to the `main` lane. `session.setValue(...)` is actually `setValueForLane("main", ...)`. A fresh repository session creates a partial implicit main lane before any harness exists.

### 1.3 `AgentHarness` silently means `main`

`AgentHarness extends AgentLane`, and the runtime `Harness extends Lane`. The manager object is inserted into its own lane map as `main`. Calls such as `harness.prompt(...)`, `harness.watch(...)`, or `harness.getModel(...)` silently target main.

### 1.4 Per-lane mutation queues solve the wrong problem

Storage already serializes atomic commits and assigns one session-wide `seq` per write. Per-lane mutation queues allow useful preparation overlap, but this runtime does not need that complexity now: all harness mutation callbacks perform bounded storage reads, prepare one write set, commit at most once, publish process-local state, and return. Providers, tools, hooks, timers, and asynchronous event delivery are outside mutation callbacks.

The approved first implementation uses one Session mutation line. Keyed lines may be added later if profiling proves the global line is a bottleneck; that future change requires a mutable-ownership audit but no public API redesign.

---

## 2. Approved terminology and ownership

### Session

Owns:

- session metadata;
- global entry and usage queries;
- application values and lists;
- session name and entry labels;
- Branch discovery/creation;
- one process-local mutation line for every supported mutation;
- one open storage/backend lifecycle.

A Session does not implement Branch and has no implicit branch.

### Branch

Data-only capability describing one named path through the immutable entry tree.

Owns only:

- its current tip;
- branch-relative entry queries;
- direct extension of its tip with message or custom entries.

A Branch has no model configuration, queues, operation state, drive, hooks, or agent policy.

### AgentLane

One Branch plus agent configuration and operations. It exposes Branch methods directly rather than exposing a nested `Branch`, tree, store, view, or access object.

When idle, `AgentLane.appendMessage` / `appendCustomEntry` extend the tip directly. During an active run, they retain the existing deferred-write semantics: reserve the entry id, persist `pendingEntry(id)`, and enqueue the id in the operation inbox for checkpoint placement. A raw Branch append is always a direct data append; raw Branch mutation while a Harness owns the corresponding lane is a trusted-programming defect.

### AgentHarness

Owns global registries/configuration, hooks, events, lifecycle, and a map of AgentLanes. It is not an AgentLane and exposes no implicit-main operation methods.

---

## 3. Target public types

### 3.1 Session reader and mutation

```ts
export interface SessionReader {
  getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
  getValue<T>(
    address: Value<T>,
    context: Context,
  ): Promise<StoredValue<T> | undefined>;
  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
  readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    context: Context,
  ): Promise<ListElement<T>[]>;
  scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

export interface SessionMutation extends SessionReader {
  /** Exactly zero or one attempt. A second call rejects, including after failure. */
  commit(writes: Write[], context: Context): Promise<CommitResult>;
  /** Wait for any admitted commit, invalidate the capability, and release the Session line. */
  end(context: Context): Promise<void>;
}

export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<TResult> = (
  mutator: SessionMutator,
  context: Context,
) => TResult | Promise<TResult>;
```

`beginMutation()`/`SessionMutation.end()` remain the transportable scope used by the current remote Session protocol. They are keyless and carry no lane field. Normal local/harness code uses `mutate()`; no caller selects a mutation key.

### 3.2 Branch

```ts
export interface Branch {
  readonly name: string;
  getTipId(context: Context): Promise<string | null>;
  findEntries(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage, context: Context): Promise<string>;
  appendCustomEntry(
    customType: string,
    data: JsonValue | undefined,
    context: Context,
  ): Promise<string>;
}
```

Because the receiver is already a Branch, the public names are `findEntries` and `findEntry`, not `findEntriesOnBranch` and `findEntryOnBranch`.

### 3.3 Session

```ts
export interface Session<
  TMetadata extends SessionMetadata = SessionMetadata,
> extends SessionReader {
  readonly metadata: TMetadata;
  readonly idGenerator: IdGenerator;

  // Direct reads. No mutation-line acquisition.
  getEntry(id: string, context: Context): Promise<Entry | undefined>;
  getStats(context: Context): Promise<SessionStats>;
  findEntries(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  getName(context: Context): Promise<string | undefined>;
  getLabel(targetId: string, context: Context): Promise<string | undefined>;

  // Existing Branch acquisition performs durable I/O and therefore receives Context.
  branch(name: string, context: Context): Promise<Branch | undefined>;
  createBranch(
    name: string,
    at: string | null,
    context: Context,
  ): Promise<Branch>;

  // Transportable explicit scope; RemoteSession maps begin/read/commit/end over RPC.
  beginMutation(context: Context): Promise<SessionMutation>;

  // Trusted sharp edge. The callback holds the sole Session mutation line.
  mutate<TResult>(
    mutation: SessionMutationCallback<TResult>,
    context: Context,
  ): Promise<TResult>;

  // One-write conveniences implemented through mutate().
  setValue<T>(
    address: Value<T>,
    next: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
  appendList<T>(
    address: ValueList<T>,
    element: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
  setName(name: string | undefined, context: Context): Promise<void>;
  setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void>;

  close(context: Context): Promise<void>;
}
```

`mutate()` remains public. Plugins are trusted not to retain the mutator, invoke nested public writers, perform effects, or hold the line across unbounded work. Misuse may block every mutation in that Session and is a plugin defect. `beginMutation()` exists for transport/lifecycle integration rather than ordinary plugin work; every direct caller must call `end()` in `finally`.

### 3.4 AgentLane

`AgentLane` keeps its operation/configuration/observation methods and directly adds the Branch surface:

```ts
export interface AgentLane {
  readonly name: string;

  getTipId(context: Context): Promise<string | null>;
  findEntries(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage, context: Context): Promise<string>;
  appendCustomEntry(
    customType: string,
    data: JsonValue | undefined,
    context: Context,
  ): Promise<string>;

  getLastResult(context: Context): Promise<LaneLastResult | undefined>;
  accept(
    request: OperationRequest,
    context: Context,
  ): Promise<OperationAdmissionResult>;
  drive(options: DriveOptions, context: Context): Promise<DriveResult>;
  requestAbort(
    operationId: string,
    context: Context,
  ): Promise<AbortRequestResult>;
  inspectExecution(context: Context): Promise<LaneExecutionInfo>;
  // Existing convenience, queue, configuration, idle, and watch methods remain.
}
```

Delete `AgentLane.sessionTree`.

### 3.5 AgentHarness

```ts
export interface AcquireLaneOptions {
  /** Used only when the AgentLane does not exist. Defaults to null. */
  createAt?: string | null;
}

export interface AgentHarness<
  TContext extends object | undefined = object | undefined,
> {
  lane(name: string, context: Context): Promise<AgentLane>;
  lane(
    name: string,
    options: AcquireLaneOptions,
    context: Context,
  ): Promise<AgentLane>;
  lanes(context: Context): Promise<LaneInfo[]>;

  // Session-global metadata wrappers preserve existing value_update events.
  getName(context: Context): Promise<string | undefined>;
  setName(name: string | undefined, context: Context): Promise<void>;
  getLabel(targetId: string, context: Context): Promise<string | undefined>;
  setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void>;

  // Existing global tools/resources/options/settings/hooks/events/watchSession/close surface.
}
```

`AgentHarness` does not extend `AgentLane`. Delete `createLane`; `lane()` is atomic get-or-create. Existing lanes ignore `createAt`. A missing lane uses `createAt ?? null`. Concurrent acquisitions return the same published AgentLane. Invalid names and unknown non-null targets reject with the existing tagged errors; close/fault reject with their existing lifecycle errors.

A fresh Session and fresh Harness contain no implicit main Branch or AgentLane. `await harness.lane("main", context)` creates main completely. `lanes()` may return `[]`.

---

## 4. Mutation and read semantics

### 4.1 One Session mutation line

Replace `LaneMutationLine` with a single `MutationLine`:

```ts
export class MutationLine {
  private tail: Promise<void> = Promise.resolve();
  private sealedError: Error | undefined;

  run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult>;
  seal(error: Error): Promise<void>;
}
```

`StorageBackedSession.beginMutation()` acquires that line and returns one explicit keyless capability; only `end()` releases it. `mutate()` is the callback convenience built from begin/end and always ends in `finally`. The callback may read, prepare, commit once, publish process-local state, synchronously bind event recipients, and return. `close()` seals admission and waits for every acquired scope to end before closing Storage.

High-level Session writes, Branch creation/appends, every `Lane.command`, progress writes, restore snapshots requiring coherence, and Harness lane acquisition all call the same `Session.mutate()`.

### 4.2 Reads bypass the line

Ordinary Session and Branch reads call Storage directly. They observe the latest fully applied atomic storage commit at the time each read executes:

- a queued/planning/unapplied mutation is invisible;
- no partial commit is visible;
- once Storage commit resolves, direct reads may observe it even while the mutation callback is still publishing process-local state;
- multiple reads outside one `mutate()` are not a snapshot;
- coherent read-decide-write/CAS uses `Session.mutate()`.

### 4.3 Effects stay outside

A mutation callback must not perform or await:

- providers or deferred fetch/cancel;
- tools;
- hooks;
- timers;
- asynchronous event delivery;
- idle callbacks or Drive completion;
- nested Session/Branch/AgentLane mutators.

The callback may synchronously call `emitBatch` after publication to bind recipients and retain its delivery promise. The public operation awaits delivery after `mutate()` returns.

### 4.4 Storage remains independently atomic

Storage retains its one-session commit serializer and assigns one global `seq` per write. The Session mutation line protects read-decide-commit-publication procedures; the Storage queue protects atomic transaction application, sequence assignment, fork snapshots, and backend callers. Do not merge the two abstractions.

---

## 5. Branch and lane durable shape

### 5.1 No implicit main

Repository `create()` writes only session metadata/header/catalog state. It writes no branch tip, lane configuration, or lane state. Remove main seeding from Memory and JSONL creation and from SQLite initialization.

Legacy coding-agent v3 normalization may still produce a main Branch because the imported transcript has one selected path.

### 5.2 Branch completeness

A Branch exists exactly when its required tip value exists. `createBranch(name, at, context)` validates name, absence, and non-null target, then writes the tip in one mutation. It writes no model configuration or operation state.

Use Branch terminology in source. This package renames the typed constructor and public concepts to `branchTip`/`tipId`. The persisted namespace and durable field spelling decision must be consistent across all backends and docs:

- use `pi.branch.tip` and rename format-4 fields from leaf to tip rather than retain misleading new-code aliases;
- format 4 and the new harness are WIP, so replace their schema and field names in place: no storage-version bump, migration, compatibility decoder, or old-format rejection path;
- legacy coding-agent v3 import remains supported: it maps its selected main leaf to a main Branch tip and walks that selected physical ancestry to reconstruct the nearest `model_change`, `thinking_level_change`, and `active_tools_change` independently; unsupported nearest values do not fall back to older history;
- when the importer can reconstruct a total configuration, it writes ordinary `laneConfig("main")` plus fresh idle `laneState("main")` before returning the Session; missing active-tools history normalizes to `[]` because v3 did not persist the initial tool inventory;
- if required model or thinking configuration is missing or unsupported, the importer leaves a data-only main Branch rather than persisting partial compatibility state;
- update the legacy active-tools record type to read its encoded `activeToolNames` array;
- update protocol schemas and experimental adapters for public `tipId` fields in the same package.

Inventory uses `branchTipInventoryPrefix()`. Legacy import emits only ordinary Branch/Lane values; there is no temporary compatibility address or attachment-time migration.

### 5.3 AgentLane completeness

An AgentLane adds total `laneConfig`, `laneState`, optional `laneLastResult`, and optional current operation values to an existing Branch.

`harness.lane(name, options?, context)` executes one Session mutation and handles exactly these cases:

| Durable state                                               | Result                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch absent; lane values absent                           | validate `createAt`, commit Branch tip + the immutable `AgentHarnessOptions` seed config + idle lane state, publish one AgentLane and `lane_created { at: createAt ?? null }` |
| Branch present; lane config/state absent and no last result | commit the immutable seed config + idle lane state at the existing tip, publish one AgentLane and `lane_created { at: existingTip }`                                          |
| Branch and complete lane values present                     | return the restored/published AgentLane; no commit/event                                                                                                                      |
| Any partial or contradictory combination                    | fault as storage corruption                                                                                                                                                   |

The committing callback publishes the new Branch/AgentLane into process-local maps and synchronously calls `emitBatch(lane_created, context)` before returning from `Session.mutate()`. Event delivery is awaited after line release.

`AgentHarness.create()` restores every complete durable AgentLane and open operation, but creates nothing and requires no main. A data-only Branch remains a Branch until `harness.lane(name, ...)` attaches agent state.

### 5.4 Append behavior

`Branch.appendMessage` / `appendCustomEntry` always commit an immutable entry parented to the current tip and move the tip in the same transaction.

`AgentLane.appendMessage` / `appendCustomEntry` retain harness semantics:

- idle: append and move tip immediately;
- active run: stage `pendingEntry(id)` and enqueue `inbox.writes`;
- active structural operation: retain the existing wait/re-evaluate contract when that surface lands;
- pending assistant messages reject before commit.

Both return the entry id reserved before their mutation.

---

## 6. Runtime composition

### 6.1 Harness

Replace inheritance with composition:

```ts
export class Harness<
  TContext extends object | undefined,
> implements AgentHarness<TContext> {
  readonly session: Session;
  readonly models: Models;
  readonly hooks: HookRegistry;
  readonly events: HarnessEventBus;
  readonly lanesByName = new Map<string, Lane<TContext>>();
  // global config/lifecycle fields
}
```

The constructor builds every restored Lane as an ordinary object. It never calls `super("main", ...)` and never inserts `this` into `lanesByName`.

Fault and close iterate ordinary Lane objects. Global getters/setters live only on Harness. Coding-agent experimental services and workers must acquire/cache `main` explicitly before invoking lane operations.

### 6.2 Lane

`Lane.command` and `commandDriveOwned` call keyless `session.mutate(plan, context)`. The live `Lane.state` remains the authoritative process projection. Exact Drive fencing remains adjacent to commit admission.

Lane directly implements Branch query/append names. It may hold a package-private Branch implementation for direct data reads, but no nested Branch is exposed publicly.

### 6.3 Restore

Restore no longer enters a named mutation line. `AgentHarness.create()` owns the Session attachment interval and performs one bounded keyless `Session.mutate()` callback to inventory/restore every complete AgentLane before publishing the Harness; it commits only when an intentional attachment normalization is required. Coherent live watch/inspection likewise uses `Session.mutate()` as a no-commit callback.

Restore inventories complete AgentLanes separately from data-only Branches. Missing main is legal.

---

## 7. Repository, backend, and fork requirements

### Memory/JSONL/SQLite

All Session facades:

- remove lane arguments and lane fields from begin/mutate capabilities;
- retain explicit `beginMutation(context)` / `SessionMutation.end(context)` forwarding for local lifecycle and remote transport;
- keep an explicit scope admitted until `end()` and keep callback `mutate()` admitted through its implicit finally/end;
- expose Branch acquisition/creation;
- keep direct reads outside the line;
- keep Storage commit sequencing unchanged.

SQLite and future SQL backends still serialize sequence-allocating commits in Storage. The Session mutation line intentionally serializes complete callbacks only within one open Session owner; separate sessions remain concurrent.

### Forks

Preserve one coherent source Storage snapshot. Update terms from lane leaf to Branch tip.

- branch-scope fork creates destination Branch `main` at the copied path;
- if no explicit source entry is provided, source `main` must exist or fork rejects;
- branch scope copies source main's configuration and writes idle lane state **together iff** source main is a complete configured AgentLane; an unconfigured/data-only source main produces only a data-only destination main Branch;
- tree scope copies every Branch tip; each complete configured source AgentLane copies its configuration plus fresh idle lane state together, while each data-only Branch remains data-only;
- operation values, pending values/lists, last results, and usage rows remain excluded;
- destination sessions do not gain an unrelated implicit main;
- retain the explicit begin/commit/end fork-ordering seam: code that must admit a commit before starting a fork snapshot calls keyless `beginMutation()`, invokes `commit()`, starts the repository snapshot only after commit admission, and calls `end()` in `finally`; Storage queues the source snapshot against commits to choose one coherent boundary.

---

## 8. Implementation phases and file manifest

Public drive remains disabled. Complete this package before resuming WP05 M4.

### Phase A — Session mutation and Branch

**Rename**

- `src/harness/session/lane-mutations.ts` → `mutation-line.ts`.

**Modify**

- `src/harness/session/types.ts` — `Branch`, keyless `Session.mutate` and keyless begin/end transport scope, no `SessionTree`, Session-global methods.
- `src/harness/session/session.ts` — one line, Branch implementation, no implicit-main delegates, direct Branch append; rename lane-creation validation errors to Branch terminology.
- Memory/JSONL/SQLite format-4 schema and codecs — replace WIP leaf/lane spellings in place; do not add a version gate or migration.
- `src/harness/session/memory.ts`.
- `src/harness/session/jsonl/repo.ts`, `jsonl/legacy-v3.ts`, and related open/create facade files.
- `packages/session-backends/sqlite-node/src/sqlite/session.ts` and repo creation.
- `src/harness/session/fork.ts`.
- `src/harness/session/index.ts` and package exports.
- storage/repository benchmarks and conformance call sites.

**Rename tests**

- `test/harness/session-tree.test.ts` → `branch.test.ts`.
- `test/harness/session-create-lane.test.ts` → `session-create-branch.test.ts`.

**Modify tests**

- `test/harness/storage-backed-session.test.ts`.
- `test/harness/memory-session-repo.test.ts`.
- `test/harness/jsonl-session-repo.test.ts`.
- `test/harness/memory-conformance.test.ts`.
- `src/harness/session/testing/conformance/session-repo.ts`.
- SQLite repo/storage tests.
- compaction/branch-summarization type fixtures.

### Phase B — Harness/Lane composition

**Modify**

- `src/harness/agent-harness.ts`.
- `src/harness/runtime/harness.ts`.
- `src/harness/runtime/lane.ts`.
- `src/harness/runtime/restore.ts`.
- `src/harness/runtime/types.ts` where `leafId` becomes `tipId`.
- `src/harness/session/values.ts` and durable state types for Branch tip naming.
- all runtime drive modules already present (`checkpoint`, `generation`, `recovery`, `terminal`, `progress`) only where names/signatures change.
- `src/harness/compaction/branch-summarization.ts`.
- `packages/protocol/src/harness.ts`.
- `packages/coding-agent/src/experimental/services/agent-controller-provider.ts`.
- `packages/coding-agent/src/experimental/services/models-provider.ts`.
- `packages/coding-agent/src/experimental/session-worker.ts`.
- experimental harness wire/session worker tests.

**Modify focused tests**

- every `test/harness/runtime/*.test.ts` helper/call site using keyed mutate, implicit Harness-as-main, `sessionTree`, `leafId`, or `createLane`;
- `test/harness/types.test.ts`;
- `test/harness/branch-summarization.test.ts`;
- protocol and coding-agent experimental tests.

Phases A and B are one atomic landing. Removing `SessionTree`, keyed mutate, and Harness inheritance cannot compile as separately committed compatibility phases, and this package intentionally adds no temporary aliases.

### Phase C — Normative documentation

Update `packages/agent/docs/harness.md` completely and consistently:

- orientation/system model and worked examples;
- bound Branch tip addresses;
- Branch, Session metadata, queries, forks, and repository boundary;
- operation metadata/result/snapshot `tipId` terminology;
- one Session mutation line in Parts 3–5;
- attachment with no required main;
- public Branch, AgentLane, AgentHarness, and Session surfaces;
- event/watcher ordering under the Session line;
- remove the old second harness-settings-line lock-order narrative: harness-global settings and every durable lane mutation now serialize through the sole Session line when a coherent snapshot is required; pure synchronous registry reads remain direct;
- work-package table, invariants, races, backend conformance, and glossary.

Update WP05 before M4:

- replace `SessionTree`/lane-line/inheritance assumptions;
- replace `leafId` source examples where the new type names require it;
- keep all M0–M3 historical behavior and M4–M8 durable requirements;
- state that WP06 is the foundation between M3 and M4.

Update every current supporting document whose public names or ordering statements change:

- `docs/assistant-durability.md` and `docs/tool-durability.md` — Session-line FIFO and `branchTip` terminology;
- `docs/values.md` — Session-global value/list surface, Branch tip addresses, and no `SessionTree`;
- `docs/telemetry.md` — receiver inventory and Session mutation spans;
- `docs/plugins.md` — remove `sessionTree`; the plugin's AgentLane directly supplies Branch methods, while a scoped Session-data facet supplies global value/list/name/label/query methods and excludes raw `mutate`, `idGenerator`, close, and backend authority;
- `docs/extensions/pi-extensions-v2.md` and `docs/extensions/pi-server-artifact/index.md` where examples/types use the changed surfaces;
- completed WP00–WP04 only where a forward-looking/current-state statement would otherwise claim the removed API still exists.

Retain the current remote Session mutation contract and update it from a named lane line to the sole Session line: worker `RemoteSession.mutate()` performs keyless begin RPC → local callback with remote reads/one remote commit → local post-commit publication → end RPC. The server holds the Session line through commit and publication until end acknowledgment. Disconnect/timeout terminates the scope under the existing hosting policy. Update the current remote protocol/vertical-slice documentation and every implementation/test present on dev; do not delete or defer this behavior.

Do not rewrite released changelog sections. Add no changelog entry on a non-main/non-PR development branch.

---

## 9. Required tests

### Session mutation line

- concurrent `mutate()` callbacks serialize globally, including callbacks invoked from different AgentLanes;
- a second callback does not enter until the first callback returns after commit/publication;
- direct reads do not wait for a callback that has not committed;
- direct reads observe a fully landed commit even while that mutation callback remains open after commit;
- no direct read observes a partial multi-write commit;
- two read-modify-write counter mutations produce `1`, then `2`;
- separate direct `getValue` + `setValue` calls remain deliberately non-atomic;
- zero-commit callback is legal;
- keyless `beginMutation()` excludes every other mutation until `end()`, commit does not release it, end-without-commit is legal, repeated end is idempotent, and close waits for end;
- RemoteSession begin/read/commit/publication/end preserves that same scope;
- second commit attempt rejects, including after a failed first attempt;
- nested public write from a mutation callback is documented as invalid and deterministically blocks/rejects according to the chosen guard;
- close-first rejects mutation; mutation-first completes and close waits; a trusted callback that never returns can block close;
- Storage commit `seq` and stats behavior is unchanged.

### Session and Branch

- fresh Session has zero Branches and no main tip value;
- no storage-version bump, migration, compatibility decoder, or rejection path is added for the replaced WIP format-4 schema;
- legacy coding-agent v3 import reconstructs ordinary total main-lane configuration plus idle state before returning when valid model/thinking history exists; otherwise it returns a data-only main Branch;
- legacy config tests cover complete and incomplete histories, invalid legacy fields, and branched histories where only changes on the selected main path apply;
- `branch(name, context)` returns undefined for absence and receives the exact Context on reads;
- `createBranch` validates name, target, and duplicate atomically;
- two concurrent creates have one winner;
- Branch queries default to its tip and preserve scan/filter/cursor behavior;
- direct Branch message/custom append extends its tip atomically;
- custom entry with absent data remains valid;
- pending assistant append rejects;
- Session global values/lists/name/labels/global queries no longer depend on a branch;
- all pre-close Branch objects reject after close;
- branch-scope fork copies config + idle state together iff source main is configured; tree scope does the same independently per configured lane; data-only Branches remain data-only;
- explicit keyless begin/commit/end preserves commit-before-fork-snapshot ordering and captures one Storage-serialized snapshot boundary.

### AgentHarness and AgentLane

- Harness has no AgentLane methods at type or runtime;
- Session has no Branch methods at type or runtime;
- AgentLane has Branch methods directly and no `sessionTree`/nested Branch property;
- fresh Harness `lanes()` is empty;
- `lane("main")` creates complete main atomically;
- missing named lane defaults to null tip; `createAt` anchors creation;
- existing data-only Branch becomes one complete AgentLane without moving its tip;
- existing complete AgentLane acquisition commits nothing and emits no creation event;
- concurrent acquisitions return the same object and emit exactly one `lane_created`;
- creation commit publishes the Lane and binds recipients before releasing `Session.mutate`;
- invalid name/unknown anchor commit nothing;
- restored complete lanes/open operations are inventoried without creating main;
- partial Branch/config/lane-state combinations fault;
- Harness global metadata wrappers retain commit → publication → `value_update` delivery;
- AgentLane idle append moves the tip; active-run append stages one deferred write and preserves authoritative state;
- close/fault seal every ordinary Lane without relying on Harness inheritance.

### Regression

- M2 exact-Drive ABA fence still checks immediately before commit admission;
- M3 generation intent/frame/settlement writes are byte-identical apart from renamed durable/public fields;
- frame FIFO remains correct under the one Session line;
- watch has only snapshot-first or publication-first outcomes;
- usage totals remain commit-boundary exact across lanes;
- Context remains trailing and source-identical throughout;
- Memory, JSONL, and SQLite repository/storage conformance pass.

---

## 10. Exclusions

Do not add:

- keyed mutation lines, arbitrary lock names, resource locks, multi-lock ordering, versions, or optimistic retries;
- a scheduler, transaction framework, action interpreter, or generic post-commit task system;
- a nested Branch/tree/store/access property on AgentLane;
- compatibility aliases for `SessionTree`, `view`, implicit Session main methods, Harness lane methods, or `createLane`;
- keyed/named begin/end RPC scopes or removal of the current keyless RemoteSession mutation transport;
- effects inside `Session.mutate()`;
- a second Storage commit/sequence mechanism;
- automatic work start from `AgentHarness.create()` or `harness.lane()`;
- public drive before WP05 M8.

Do not modify provider/tool behavior, durable execution phases, retry/deferred policy, or assistant-frame semantics beyond signature/name propagation required by this package.

---

## 11. Validation

Run every modified focused test, then:

```bash
git diff --check
npm run check
./test.sh

rg -n "SessionTree|sessionTree|\.view\(|LaneMutationLine|extends AgentLane|extends Lane" \
  packages/agent/src packages/agent/test packages/agent/docs \
  packages/session-backends packages/protocol packages/coding-agent/src/experimental \
  packages/coding-agent/test/experimental*

rg -n "beginMutation\([^)]*,|mutate\([^)]*,[^)]*," \
  packages/agent/src packages/agent/test packages/session-backends packages/coding-agent/src/experimental

rg -n "session\.mutate\([^)]*\"|\.mutate\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*," \
  packages/agent/src packages/agent/test packages/session-backends
```

Expected first grep matches only this package's problem statement, explicitly historical work-package API descriptions, negative type assertions, and unrelated coding-agent tree-widget names such as `SessionTreeNode`; no current harness `SessionTree` concept remains. The keyed-mutate grep must be empty after manually checking false positives.

Review the complete implementation and normative doc update with Fable before committing. Do not commit without explicit user approval.

---

## 12. Stop condition

WP06 is complete when:

- Session has one keyless mutation line; callback `mutate()` and explicit begin/commit/end remote transport share it, and neither accepts a lane key;
- direct reads bypass that line and expose only fully applied Storage commits;
- `SessionTree` and implicit-main Session behavior are gone;
- Branch is the data-only path/tip abstraction;
- AgentLane exposes Branch methods directly and retains operation-aware append semantics;
- AgentHarness is composition-only, has no AgentLane methods, and atomically gets/creates lanes;
- fresh Session/Harness require no main;
- all process-local publication and event-binding boundaries remain correct;
- all three backends and focused race tests pass;
- `harness.md` and WP05 describe the new model consistently;
- final Fable review reports no findings;
- WP05 M4 may resume.
