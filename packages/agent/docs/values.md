# Typed values and lists

This document specifies the mutable storage primitive used by Session, the harness, and applications.

The public abstraction is a **bound typed address**:

- `value<T>(namespace, key?)` names one replaceable durable value;
- `list<T>(namespace, key?)` names one append-only durable list whose elements have type `T`.

The namespace/key pair is bound once when the address is constructed. Every later operation receives only that address. Application code therefore writes:

```ts
const state = value<ApplicationState>("my-app.state");
const events = list<ApplicationEvent>("my-app.events");

await session.getValue(state, context);
await session.setValue(state, nextState, context);
await session.readList(events, { limit: 100 }, context);
await session.appendList(events, event, context);
```

It does **not** repeatedly pass a second unexplained key:

```ts
// Not the API.
await session.readList(events, "another-key", { limit: 100 }, context);
```

When an application genuinely has keyed instances, it constructs the address for that instance:

```ts
const workspaceEvents = (workspaceId: string) =>
  list<ApplicationEvent>("my-app.events", workspaceId);

await session.readList(workspaceEvents("pi"), { limit: 100 }, context);
```

Storage may physically index the address as `(kind, namespace, key)`, but that representation does not leak into each read or write call. Storage, Session, harness code, and applications use the same address vocabulary. There is no global value-type map, dynamic registry, token catalog, or separate application-state storage mechanism.

## Goals

1. Give one exact durable address one compile-time value type.
2. Let applications define scalar values and lists without declaration merging or editing a core type map.
3. Use the same typed addresses and operation names from Storage through Session.
4. Preserve current scalar replacement semantics.
5. Append one list element without reading or rewriting existing elements.
6. Give every list element its own existing session-global transaction `seq`, used for ordering and pagination.
7. Commit values and list elements atomically with entries and usage.
8. Produce identical logical behavior on Memory, JSONL, and SQLite.
9. Keep list reads bounded and explicit.
10. Keep scalar operation state authoritative; auxiliary lists never select a recovery state.

## Non-goals

This slice does not define:

- assistant-frame contents or reduction semantics;
- tool-progress semantics;
- runtime validation of trusted in-process values;
- per-element or per-list byte limits;
- list truncation or per-element deletion;
- a generic event log, journal, stream-resumption protocol, or operation reducer;
- globally registering address objects;
- exposing raw Session or transaction access to tools.

Consumers own address construction, content limits, cleanup points, fork policy, migration policy, and consumption-time hydration. `assistant-durability.md` defines the first list consumer.

## Bound address model

```ts
declare const storedValueType: unique symbol;

interface StoredAddressBase {
  /** Stable persisted grouping name. */
  readonly namespace: string;
  /** Exact member inside that grouping. Empty is legal. */
  readonly key: string;
  readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
  readonly kind: "value";
  /** Compile-time only and invariant in T. */
  readonly [storedValueType]?: (value: T) => T;
}

export interface ValueList<T> extends StoredAddressBase {
  readonly kind: "list";
  /** T is one element, not the whole list. */
  readonly [storedValueType]?: (value: T) => T;
}

export function value<T>(namespace: string, key = ""): Value<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "value" });
}

export function list<T>(namespace: string, key = ""): ValueList<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "list" });
}
```

The phantom function makes `T` invariant: an address for one type cannot silently widen to another. It has no runtime field.

Rules:

- `namespace` must be non-empty;
- namespace `pi` and every `pi.*` namespace are reserved for built-ins by contract;
- applications that construct a reserved address are defective trusted in-process code; no runtime privilege split, registry, or catalog exists;
- neither component may contain the Memory backend's internal separator (`\u0000`);
- an empty key is valid and is the natural address for one application-wide value or list;
- object identity has no durable meaning;
- separately constructed addresses with the same `(kind, namespace, key)` identify the same durable location;
- constructing the same durable location with incompatible TypeScript types is a trusted-programming defect;
- scalar and list addresses may not share the same `(namespace, key)` in one storage version; violating this is a trusted-programming defect and storage performs no cross-kind collision check;
- changing an address's namespace, key, kind, or incompatible value shape requires migration.

The two components remain separate rather than concatenated. Dynamic application keys and operation IDs therefore require no escaping convention beyond the storage separator rule.

### Exact addresses, not families

An address names one value or one list. Internal code uses small constructors when it has dynamic keys:

```ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);

export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);

export const operationToolArgs = (
  operationId: string,
  stepId: string,
  sourceIndex: number,
) => value<Record<string, JsonValue>>(
  "pi.op.tool_args",
  `${operationId}:${stepId}:${sourceIndex}`,
);

export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  `${operationId}:${responseEntryId}`,
);
```

This encapsulates each key grammar at its owner. Call sites receive an already-bound typed address:

```ts
await reader.getValue(operationState(operationId));
await reader.readList(pendingAssistantFrames(operationId, responseEntryId), options);
```

### No global value map

Delete the existing global namespace-to-type maps:

```ts
interface RegisterValues { /* delete */ }
interface ListRegisterValues { /* delete */ }
type RegisterNamespace = keyof RegisterValues; // delete
```

A type belongs to an address constructor instead:

```ts
export const applicationState = value<MyApplicationState>("my-app.state");
export const applicationEvents = list<MyApplicationEvent>("my-app.events");
```

Applications should use a stable, collision-resistant namespace prefix. Namespace `pi` and the complete `pi.*` prefix are reserved for built-ins by contract; similar-looking names such as `pi2` remain legal. The same `value()` and `list()` constructors serve core and application code. Tests assert that every built-in address uses its reserved prefix. There is no runtime privilege split, registry, or catalog.

## Built-in addresses

Built-in constructors live together in `packages/agent/src/harness/session/values.ts` and are imported directly by consumers. Representative definitions:

```ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);
export const laneConfig = (lane: string) =>
  value<LaneConfiguration>("pi.lane.config", lane);
export const laneState = (lane: string) =>
  value<LaneState>("pi.lane.state", lane);
export const operationResult = (operationId: string) =>
  value<OperationResultRecord>("pi.result", operationId);

/** Used only by scanValues() to enumerate Branch names. */
export const branchTipInventoryPrefix = () =>
  value<string | null>("pi.branch.tip");

export const operationMeta = (operationId: string) =>
  value<OperationMeta>("pi.op.meta", operationId);
export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);
export const operationToolArgs = (operationId: string, stepId: string, sourceIndex: number) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    `${operationId}:${stepId}:${sourceIndex}`,
  );
export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", `${operationId}:${invocationId}:${name}`);
export const operationPreparation = (operationId: string, taskId: string) =>
  value<DurableStructuralPreparation>(
    "pi.op.preparation",
    `${operationId}:${taskId}`,
  );

/** Prefix addresses are exported only for namespace-scoped scanValues(). */
export const operationToolArgsPrefix = (operationId: string, stepId?: string) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    stepId === undefined ? `${operationId}:` : `${operationId}:${stepId}:`,
  );
export const operationToolMemoPrefix = (operationId: string, invocationId?: string) =>
  value<JsonValue>(
    "pi.op.tool_memo",
    invocationId === undefined ? `${operationId}:` : `${operationId}:${invocationId}:`,
  );
export const operationPreparationPrefix = (operationId: string) =>
  value<DurableStructuralPreparation>("pi.op.preparation", `${operationId}:`);

export const pendingEntry = (entryId: string) =>
  value<PendingEntry>("pi.pending.entry", entryId);
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  value<AgentToolResult<unknown>>(
    "pi.pending.tool_output",
    `${operationId}:${invocationId}`,
  );
export const pendingAssistantFrames = (operationId: string, responseEntryId: string) =>
  list<AssistantMessageFrame>(
    "pi.pending.assistant_frame",
    `${operationId}:${responseEntryId}`,
  );
export const pendingToolOutputPrefix = (operationId: string) =>
  value<AgentToolResult<unknown>>("pi.pending.tool_output", `${operationId}:`);

export const sessionName = value<string>("pi.session.name");
export const entryLabel = (entryId: string) => value<string>("pi.entry.label", entryId);
```

`OperationMeta` is immutable acceptance metadata stored at `pi.op.meta`. The process-local `Operation` projection is `{ meta: OperationMeta, state: OperationState }`, assembled from the separate metadata and state values; it is never stored at one address.

The five exported scan-prefix constructors are `branchTipInventoryPrefix`, `operationToolArgsPrefix`, `operationToolMemoPrefix`, `operationPreparationPrefix`, and `pendingToolOutputPrefix`. Their addresses are consumed only by `scanValues()`.

Applications define their own `value()` and `list()` addresses directly; there is no built-in custom application-state namespace or custom-state API. `AgentHarnessToolInvocation.getMemo()` and `setMemo()` are invocation-fenced capabilities over `operationToolMemo(...)`, not raw Session access. Invocation memos remain operation-owned and are deleted when their tool outcome becomes durable.

Tests assert that built-in constructors produce the documented kind, namespace, and key grammar. Because constructors may be dynamic, there is no runtime catalog that tries to enumerate every possible address.

## Shared read API

Storage, Session, SessionReader, and SessionMutator use the same read signatures:

```ts
export interface StoredValue<T> {
  address: Value<T>;
  value: T;
  seq: number;
}

export interface ListElement<T> {
  /** Global transaction-write sequence assigned by storage. */
  seq: number;
  value: T;
}

export interface ListCursor {
  seq: number;
}

export interface ListReadOptions {
  /** Exclusive cursor. */
  cursor?: ListCursor;
  /** Default: asc. */
  order?: "asc" | "desc";
  /** Query-page size. Default: 1,000. Values above 10,000 clamp to 10,000. */
  limit?: number;
}

interface ValueReader {
  getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;

  /** Internal bounded-prefix operation. The address key is interpreted as a prefix. */
  scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;

  readList<T>(
    address: ValueList<T>,
    options?: ListReadOptions,
  ): Promise<ListElement<T>[]>;
}
```

`scanValues(prefixAddress)` scans scalar addresses with exactly that namespace and keys beginning with the bound key, returning them in key-ascending order. Core call sites use only the exported prefix constructors above so raw namespace/key grammar stays in `session/values.ts`. Prefix addresses are passed only to `scanValues()`, never to exact get/set/delete operations. There is no unrestricted cross-namespace dump. Ordinary application reads use exact addresses.

`Session` exposes direct one-transition writes using the same addresses:

```ts
interface Session extends ValueReader {
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
}
```

Purpose-specific helpers such as `getName()`, `setName()`, `getLabel()`, and `setLabel()` may remain thin wrappers over built-in addresses. Applications define and use their own scalar/list addresses directly.

`SessionMutator` remains a read capability plus one atomic `commit(writes)`. It does not expose direct `setValue()`/`appendList()` methods that would consume its only commit separately; callers construct a typed write array and commit it together.

## Typed transaction writes

Writes are constructed through typed helpers. Entry and usage constructors hide their storage discriminants; value/list erasure happens only after the helper has checked the address/value type relationship:

```ts
interface EntryWrite {
  kind: "entry";
  entry: NewEntry;
}

interface UsageWrite {
  kind: "usage";
  row: Omit<UsageRow, "seq">;
}

interface ValueSetWrite {
  kind: "value";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

interface ValueDeleteWrite {
  kind: "value";
  op: "delete";
  namespace: string;
  key: string;
}

interface ListAppendWrite {
  kind: "list";
  op: "append";
  namespace: string;
  key: string;
  value: unknown;
}

interface ListDeleteWrite {
  kind: "list";
  op: "delete";
  namespace: string;
  key: string;
}

export function insertEntry(entry: NewEntry): EntryWrite;
export function insertUsage(row: Omit<UsageRow, "seq">): UsageWrite;
export function setValue<T>(address: Value<T>, next: NoInfer<T>): ValueSetWrite;
export function deleteValue<T>(address: Value<T>): ValueDeleteWrite;
export function appendList<T>(address: ValueList<T>, element: NoInfer<T>): ListAppendWrite;
export function deleteList<T>(address: ValueList<T>): ListDeleteWrite;
```

`NoInfer<T>` makes the address authoritative. TypeScript must not infer a wider `T` from an incompatible write value.

`Write` includes all six helper return types. One transaction may mix every write kind atomically. Harness and application code use the helpers rather than manually constructing storage write shapes.

The direct Session methods and transaction helpers intentionally use the same operation names. One performs and commits a single Session mutation; the other constructs a write for an explicitly composed transaction.

## Scalar semantics

For one `Value<T>` address:

- `setValue` replaces the current value;
- `deleteValue` removes it;
- deleting an absent value is a no-op;
- set after delete recreates it;
- there is no retained value history;
- the current value records the `seq` of its latest set;
- a failed transaction exposes neither the scalar write nor any sibling write.

## List semantics

One append write carries one immutable element. A transaction appending several elements contains several append writes. Every write receives its existing globally increasing transaction sequence:

```text
TX[
  appendList(frames, A),       // seq 41
  setValue(operationState, X), // seq 42
  appendList(frames, B),       // seq 43
]
```

Reading `frames` returns `A`, then `B`. Gaps from unrelated writes are expected. A list element's `seq` is session-global and unique to that committed write; it is an ordering/cursor identity, not an application domain ID. Applications that need domain identity include it in `T`.

Rules:

- append never reads existing elements;
- an element is immutable after commit;
- `deleteList(address)` removes every element at that exact address;
- deleting an absent list is a no-op;
- delete followed by append in one transaction creates a fresh list atomically;
- there is no per-element update, delete, insertion, or truncation;
- all validation and serialization required to admit a transaction completes before Memory state changes;
- a failed transaction exposes none of its list or non-list writes.

“Append-only” describes elements while the list exists. Whole-list deletion is lifecycle cleanup, not element mutation.

### List reads

- ascending reads return `seq > cursor.seq`;
- descending reads return `seq < cursor.seq`;
- results are ordered according to `order` before `limit` is applied;
- absent and empty both return `[]`;
- callers continue with the last returned element's `seq`;
- an empty page ends iteration;
- `limit` is only the query-page size: it must be a positive safe integer, defaults to 1,000, and values above 10,000 clamp to 10,000; it never limits total list length or bytes.

```ts
let cursor: ListCursor | undefined;
while (true) {
  const page = await reader.readList(events, { cursor, order: "asc", limit: 100 });
  if (page.length === 0) break;
  consume(page);
  cursor = { seq: page[page.length - 1]!.seq };
}
```

A cursor is a sequence filter, not a snapshot or list-incarnation token. Concurrent later appends may appear on later ascending pages. Whole-list deletion may make a cursor stale; reads simply apply its sequence comparison to currently surviving elements.

Do not add an unbounded “read the whole list” helper.

## Assistant partial frames

Assistant partial durability is the first built-in list consumer:

```ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
```

`AssistantMessageFrame`, `AssistantMessageFrameEncoder`, and `reduceAssistantMessageFrames()` come from `@earendil-works/pi-ai`. Do not define a second frame codec or reducer.

For every convertible non-terminal provider event, the assistant procedure:

```text
convert event to frame
→ synchronously enqueue appendList(frames, frame) on the Session mutation line
→ attach the ordinary harness-fault observer to that returned promise
→ replace the process-local latestFrameWrite reference
→ emit and await the existing message event
→ consume the next provider event
```

The provider loop does not await storage for every frame. Synchronous enqueue preserves provider-event order. Replacing the latest-promise reference never leaves an earlier rejection unobserved because every promise receives the fault observer. Bounded output bounds queued work. On stream settlement, the procedure stops frame admission and awaits the latest append promise before `after_response`; Session mutation FIFO means that completion implies every earlier append completed. There is no timer, batcher, coalescer, or flush API.

Scalar assistant `effect_pending` remains authoritative. Each append verifies that the same operation, attempt, and response ID still own the lane when its mutation executes. Frames never prove request admission, completion, success, or failure.

Final or synthetic assistant settlement deletes the exact list atomically with its immutable response, usage, Branch tip, and next scalar state:

```text
TX[
  insert final assistant entry,
  insert usage,
  deleteList(frames),
  setValue(operationState(operationId), nextState),
]
```

`assistant-durability.md` defines frame conversion, unknown-outcome synthesis, cancellation, deferred polling, snapshots, and event ordering.

## Restore policy

Scalar operation state remains the sole restart authority:

1. construct the trusted lane/operation projection from required scalar values;
2. trust committed typed values rather than auditing every referenced payload or phase relationship;
3. when a procedure or snapshot consumes auxiliary state, derive its exact bound address from current typed scalar state;
4. hydrate only the bounded scalar values or list pages that consumer requires.

A missing auxiliary list is legal unless its consumer explicitly requires an element. List contents never prove that an external effect completed. Live mutations still verify current operation, phase, attempt, and reserved identity as concurrency fencing; that is not restore validation.

Base restore does not enumerate lists. For assistant frames, snapshot or recovery derives `pendingAssistantFrames(operationId, responseEntryId)` only while consuming a typed assistant/deferred `effect_pending` state.

Each list consumer defines:

- address grammar;
- element and total-byte bounds;
- page/hydration budget;
- cleanup transitions;
- fork and migration policy.

## Memory backend

Memory may keep separate maps for current values and list elements:

```ts
const scalarValues = new Map<string, StoredValue<unknown>>();
const listValues = new Map<string, ListElement<unknown>[]>();

function physicalKey(address: StoredAddressBase): string {
  return `${address.namespace}\u0000${address.key}`;
}
```

- scalar set replaces one map value;
- scalar delete removes it;
- list append pushes the already-sequenced element;
- list delete removes the complete array;
- list read filters by exclusive cursor and slices to the validated limit;
- transaction preparation completes before entries, values, lists, usage, or stats mutate.

Storage snapshots used by JSONL/fork tooling include current scalar values and surviving list elements with original sequence numbers.

## SQLite backend

The logical schema has one current-value table and one list-element table:

```sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT    NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

WP01 replaces the unfinished format-4 schema in place: edit `sqlite/migrations/001_initial.sql`, rename the physical `registers` table to `scalar_values`, add `list_values`, and keep `SQLITE_STORAGE_VERSION = 1`. There is no migration runner in this WIP implementation, and pre-WP01 SQLite files are unsupported. Do not add migration machinery in this package.

List operations:

```sql
INSERT INTO list_values(namespace, key, seq, value) VALUES (?, ?, ?, ?);

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq > ?
ORDER BY seq ASC LIMIT ?;

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq < ?
ORDER BY seq DESC LIMIT ?;

DELETE FROM list_values WHERE namespace = ? AND key = ?;
```

For a missing cursor, omit the sequence predicate. Every write participates in the existing `BEGIN IMMEDIATE` transaction; writable Session ownership belongs to the host lifecycle, not SQLite storage. Assert with `EXPLAIN QUERY PLAN` that paging uses the primary key and no temporary sort.

## JSONL backend

Logical records carry the bound address's physical components:

```jsonl
{"kind":"list","op":"append","seq":41,"namespace":"pi.pending.assistant_frame","key":"O:R","value":{"type":"text_delta","contentIndex":0,"delta":"hi"}}
{"kind":"list","op":"delete","seq":52,"namespace":"pi.pending.assistant_frame","key":"O:R"}
```

Scalar records use `kind:"value"` with `op:"set"|"delete"`. WP01 keeps JSONL format 4 and storage version 1 but replaces the unfinished record spelling in place; pre-WP01 format-4 files are unsupported and no legacy `kind:"register"` decoder remains.

Replay folds records into the Memory state:

- scalar set replaces the current address;
- scalar delete removes it;
- list append adds `{ seq, value }`;
- list delete removes the complete list.

A transaction remains one physical JSONL line, using an array for multiple writes. Torn-tail handling therefore remains atomic without new framing.

### Snapshot compaction

Compaction writes every surviving list element with its original `seq`, merged in sequence order with surviving entries, scalar values, and usage rows. Do not collapse one live list into a synthetic element or assign new sequence numbers; either change breaks cursors and backend equivalence.

Deleted lists produce no snapshot records. Snapshot rewrites persist `nextSeq` in the format-4 header so dropping the latest delete cannot permit sequence reuse; ordinary append-only files may omit that field and derive it from replayed writes.

## Forks and rewrites

Fork and precise-rewrite code decides policy per concrete address grammar:

- operation-owned `pi.op.*` scalar values are not copied into an idle fork;
- immutable `pi.result` operation records are not copied by forks;
- `pi.pending.entry`, `pi.pending.tool_output`, and `pi.pending.assistant_frame` values/lists are not copied;
- lane and semantic session values follow their existing scope rules;
- application-defined values/lists are not copied by the generic fork; a consuming feature must add an explicit address-specific policy before relying on copied application state.

A precise rewrite retaining list elements preserves their `seq` values unless it explicitly remaps the entire destination sequence space.

## Schema evolution

A bound address's namespace, key grammar, kind, and value type are durable schema:

- changing namespace or key grammar requires explicit address migration;
- changing scalar to list or list to scalar requires explicit migration;
- storage never infers or coerces kind from observed records;
- changing TypeScript value shape requires total value migration when old stored values are incompatible;
- a list migration pages elements in sequence order and either maps them while preserving `seq` or deletes the complete list;
- a migration must not load an unbounded logical list at once.

Adding generic list storage replaces the current WIP backend schema in place. Constructing a new application address with no persisted value requires no migration.

## Instrumentation and telemetry

The instrumented storage decorator exposes the address-based read API and records committed erased writes in exact transaction order.

Telemetry session-write item kinds distinguish scalar-value writes from list writes. Namespace/key names may be attributes when the telemetry schema permits them, but values, assistant frames, prompts, and tool output never enter telemetry.

Append-path tests prove that no `readList` call occurs before append commit. Frame-persistence promises always receive the harness fault observer, even when an earlier promise is no longer the latest settlement-order reference.

## Invariants

1. One bound address has one stable namespace/key/kind and one trusted value type in a storage version.
2. Address object identity has no durable meaning.
3. Namespace `pi` and every `pi.*` are reserved by contract; every built-in namespace starts with `pi.`, and application use is a trusted-programming defect.
4. Exactly five built-in prefix constructors encapsulate Branch inventory and operation cleanup grammar; their results are consumed only by namespace-scoped `scanValues()`.
5. Scalar and list addresses must not occupy the same physical location; this is a trusted-programming rule, not a runtime cross-kind collision check.
6. Typed reads and helper-constructed writes preserve `T`.
7. Scalar helpers reject list addresses; list helpers reject scalar addresses.
8. A Session/Storage operation never requires a second key after address construction.
9. Every list element is immutable and carries its globally unique committed write `seq`.
10. Elements at one list address are returned in sequence order on every backend.
11. Append performs no read of the target list.
12. Scalar/list writes are atomic with entries and usage in the same transaction.
13. Whole-list delete leaves no elements at that address.
14. Missing and empty lists both read as `[]`.
15. Base restore depends only on required scalar state and never enumerates auxiliary lists.
16. Auxiliary lists never establish effect completion or select a restart state.
17. JSONL compaction preserves surviving element sequences.
18. Terminal cleanup leaves no operation-owned scalar values or lists.

## Required tests

### Address typing and identity

- `value<T>()` and `list<T>()` preserve their declared `T` invariantly;
- scalar reads infer the bound address's value type;
- list reads infer its element type;
- `setValue` rejects an incompatible value at compile time;
- `appendList` rejects an incompatible element at compile time;
- scalar helpers reject list addresses and list helpers reject scalar addresses;
- independently constructed equal addresses access the same durable location;
- incompatible definitions of one physical address are documented/tested as a programming defect;
- empty keys work, while empty namespaces and separator-containing components reject;
- core and application code use the same `value()` and `list()` constructors, with no private constructor, privilege token, registry, or catalog;
- built-in address constructors produce exact `pi.branch.tip`, `pi.lane.*`, `pi.op.*`, `pi.pending.*`, `pi.session.name`, and `pi.entry.label` namespace/key/kind triples;
- every built-in namespace starts with `pi.`, while application fixtures use non-reserved namespaces;
- `branchTipInventoryPrefix()` binds the empty-key `pi.branch.tip` inventory prefix and is used only to enumerate Branches through `scanValues`;
- tool-args prefixes cover one operation and optionally one step, tool-memo prefixes cover one operation and optionally one invocation, preparation and tool-output prefixes cover exactly one operation;
- each prefix constructor result is used only by `scanValues`, and no inventory or cleanup call constructs a raw reserved namespace;
- application addresses work without declaration merging or core catalogs;
- no Storage or Session operation accepts an additional key argument.

### Scalar regression

- set/get/delete/recreate behavior is unchanged;
- replacement retains only the latest logical value and latest set `seq`;
- typed write helpers preserve mixed transaction order;
- prefix scans interpret the bound address key as a prefix and remain namespace-scoped;
- new scalar JSONL/SQLite files use only the value/list schema; pre-WP01 WIP files are explicitly unsupported.

### List conformance

Extend the shared backend conformance suite:

- append one element and page it;
- multiple appends to one address in one transaction;
- appends separated by unrelated writes preserve per-list order;
- every element receives its own global write `seq`;
- ascending and descending exclusive cursors;
- default, explicit, invalid, and capped limits;
- absent list returns `[]`;
- whole-list delete and delete of absent list;
- delete followed by append in one transaction;
- rollback when a later write is invalid;
- atomic list + entry + usage + scalar transaction;
- identical pages and cursors on Memory, JSONL, and SQLite;
- JSONL torn multi-write transaction exposes no list element;
- JSONL replay and compaction preserve cursors;
- SQLite paging uses the primary key without temporary sorting;
- append performs no list read;
- base restore constructs trusted scalar projection without list reads, followed by bounded consumption-time hydration;
- close rejects later reads and honors already-admitted commits.

### Application surface

- an application-wide scalar value requires no extra key at get/set;
- an application-wide list requires no extra key at read/append;
- an application can construct dynamic per-workspace addresses explicitly;
- Storage and Session accept the same address objects and infer the same types;
- direct Session writes serialize and commit once;
- explicit `Session.mutate()` can atomically combine typed value/list writes with entries and usage.

### Assistant-frame integration — deferred beyond WP01

- every converted non-terminal frame appends under the exact bound effect-pending response address;
- terminal `done`/`error` events append nothing;
- appends enqueue synchronously without provider backpressure;
- every frame-write promise has an observed fault path;
- only the latest promise reference is retained for settlement ordering;
- awaiting the latest promise implies every earlier append completed;
- reduced pages reconstruct the same partial message as uninterrupted streaming;
- missing list restores as no durable partial;
- final/synthetic settlement atomically deletes the frame list;
- unknown-effect recovery reads only the bounded list derived from current scalar state;
- external finalization deletes the operation-owned list;
- idle forks contain no frame list;
- backend byte growth is append-linear rather than repeated-snapshot growth.

## Implementation map

Expected primary changes:

- replace `session/registers.ts` with `packages/agent/src/harness/session/values.ts` containing addresses, constructors, typed write helpers, and built-in address constructors;
- remove `RegisterValues`, namespace unions, register token types, and raw namespace/key read signatures from `session/types.ts`;
- expose `ValueReader` through Storage, SessionReader, SessionMutator, and Session;
- expose direct application scalar/list methods on Session using bound addresses;
- update Memory state, JSONL codec/storage, snapshots, fork/rewrite code, instrumentation, and conformance suites;
- replace SQLite's unfinished initial schema in place with `scalar_values` and `list_values`; keep storage version 1 and add no migration runner;
- update telemetry schema sources and regenerate `telemetry-schema.md`; do not edit that generated file manually.

WP01 stops after generic addresses/storage and projection-only restore coverage. `assistant-durability.md` specifies the later consuming lifecycle; assistant execution, deferred polling, recovery, snapshot hydration, memo/checkpoint capabilities, and operation cleanup land only with their runtime work packages.
