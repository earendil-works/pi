# Pico v1 implementation specification

This file is the sole normative implementation specification for the clean-room Pico harness under
`packages/agent/src/harness/pico/`. Other Pico documents and prototypes are historical inputs and test
inspiration only. An implementer must not need them to implement the work packages
marked ready here.

The specification intentionally gates provider, tool/output/preview, hook-scratch and client integration
where their APIs are not settled. A gated package must not be implemented by guessing. The storage,
entry/context, task, transaction, admission, scheduling, recovery and cancellation foundation is fully
specified here.

## 1. Required behavior

Pico stores sessions containing conversations, immutable transcript entries, durable tasks and scoped
state. One process owns a session at a time. Task effects run concurrently; every mutation and scheduler
decision serializes on one commit line.

A task is one recoverable async operation:

1. Creation durably stores immutable input and status `pending`.
2. Reservation durably changes status to `running` before `execute` performs effects.
3. The task may atomically replace a full typed checkpoint while it runs.
4. A `running` task encountered by a later process runs `recover`, including when no checkpoint exists.
5. `execute` or `recover` completes effects and cleanup, then returns a terminal closure.
6. The harness invokes the closure once on the line and atomically stores its buffered writes, terminal
   outcome and scratch retirement.
7. Durable cancellation marks the task, revokes normal writes, signals and joins the old invocation,
   then starts a fresh `abort` invocation from immutable input and the latest checkpoint.
8. `abort` completes cleanup, then returns a restricted closure whose writes, aborted outcome and scratch
   retirement commit atomically.

Recoverability does not preserve a JavaScript stack and does not imply exactly-once external effects.
A crash after an unkeyed external action but before recording its identity/result remains uncertain.

Required exclusions: no imports from another harness implementation; no worker pool, polling scheduler,
lease, effect gate, author-defined lifecycle graph, `patch`, `settle`, status epoch, workflow replay,
generator DSL, returned step plan or specialized core verbs such as `startShell`.

## 2. Core data and identifiers

All durable application payloads are strict JSON.

```ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
interface JsonObject { readonly [key: string]: JsonValue }

type Id = number;
type Seq = number;
```

IDs and sequences are positive safe integers. One session sequence orders every mutation in every main
and scratch batch. A mutation that creates an object uses its sequence as that object's ID. There are no
reserved ranges and IDs are never reused.

A transaction starts from committed `lastSeq`. Its first buffered mutation receives `lastSeq + 1`.
Rejected transactions consume no IDs. IDs may reference earlier mutations in the same batch and may be
returned only after the outer commit is durable.

Mutable caller values are cloned at the API boundary before buffering. Storage owns another immutable
snapshot or an equivalently immutable representation. Mutating an object after passing it to Pico must
never alter buffered, committed or returned historical data. Reads return immutable values or owned
copies where the API promises mutation by the caller.

`Call` is Chord context:

```ts
import type { Context } from "@earendil-works/chord";
export type Call = Context;
```

Every asynchronous public, runtime, storage-adapter, provider, environment, hook and wait operation takes
a required final `Call`. Synchronous transaction builder methods take no `Call`.

## 3. Entries, conversations and context

### 3.1 Stored records

`Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ImageContent` and
`ToolCall` are provider-neutral pi-ai types. Current pi-ai has no `SystemMessage`; typed `pi.system`
model projection is reserved for the gated messages-only integration package.

```ts
type ContextEdit =
  | { readonly target: Id; readonly action: "omit" }
  | { readonly target: Id; readonly action: "replace"; readonly messages: readonly Message[] };

interface EntryIdentity {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly byTaskId?: Id;
}

interface EntryBase extends EntryIdentity { readonly key?: string }
interface EntryData<D extends JsonValue = JsonValue> { readonly data: D }
interface ModelProjection<M extends Message = Message> { readonly model: readonly M[] }
interface ContextHead { readonly head: Id }
interface ContextEdits { readonly edits: readonly ContextEdit[] }

type Entry = EntryBase & Partial<EntryData & ModelProjection & ContextHead & ContextEdits>;

type EntryInput<E extends Entry> =
  Omit<E, keyof EntryIdentity | "head"> &
  (E extends ContextHead ? { readonly head: Id | "self" } : { readonly head?: never });

interface DataEntryInput<D extends JsonValue = JsonValue> {
  readonly key?: string;
  readonly data?: D;
  readonly model?: never;
  readonly head?: never;
  readonly edits?: never;
}

interface EntryKind<E extends Entry = Entry> {
  readonly kind: string;
  is(entry: Entry | undefined): entry is E;
}

interface Conversation {
  readonly id: Id;
  readonly parent?: { readonly conversationId: Id; readonly at: Id };
  readonly owner?: Id;
}
```

Entries are append-only and never patched, reordered or renumbered. `data`, `model`, `head` and `edits`
are stored composable facets. No kind callback runs while reading or deriving context. Unknown entry kinds
retain all generic behavior because the facets are materialized.

`Entry.byTaskId` is set by Pico when an invocation appends the entry and is absent for a host append.
Tasks do not have a generic `byTaskId`; a task kind stores required provenance in its typed input.

Built-in kind strings are `pi.user`, `pi.assistant`, `pi.tool_result`, `pi.system`, `pi.notice`,
`pi.summary`, `pi.handoff` and `pi.reset`. Ready foundation witnesses are:

```ts
type UserEntry = EntryBase & { readonly model: readonly [UserMessage] };
type AssistantEntry = EntryBase & { readonly model: readonly [AssistantMessage] };
type ToolResultEntry = EntryBase & EntryData<JsonValue> & { readonly model: readonly [ToolResultMessage<JsonValue>] };
type NoticeEntry = EntryBase & Partial<EntryData> & { readonly model: readonly [UserMessage] };
type SummaryEntry = EntryBase & EntryData<{ readonly summarizedThrough: Id }> &
  { readonly model: readonly [UserMessage] } & ContextHead;
type HandoffEntry = EntryBase & { readonly model: readonly [UserMessage] } & ContextHead;
type ResetEntry = EntryBase & ContextHead;
```

Each user, assistant, tool-result, notice, summary and handoff entry contains exactly one corresponding
message. Reset has no model. `pi.system` is reserved but has no ready typed model witness. Stored entry-kind
names are indexed so open can report unknown kinds without scanning payload history.

### 3.2 Direct append validation

A direct append validates against committed state plus prior buffered mutations:

- The conversation exists, including one created earlier in the batch.
- `head: "self"` becomes the minted entry ID.
- A numeric head is a visible transcript entry at the append point.
- Let `P` be the newest visible prior head. A new head boundary cannot precede `P.head` in the logical
  transcript.
- A head boundary cannot split a successful assistant/tool-result exchange.
- Every edit target is an earlier visible entry. An edit outside the selected range during later context
  derivation is a no-op.
- Ordinary edits cannot target managed `pi.system` entries. The system-preparation operation is the only
  authority that may append a complete fresh managed baseline and omission edits for superseded managed
  entries in one batch.
- An assistant message is final-successful when `stopReason` is `"stop"`, `"length"` or `"toolUse"`.
  `"pending"` and `"deferred"` are not appendable terminal assistant entries. `"error"` and `"aborted"`
  may be stored for display but do not enter later model requests or create tool work.
- A successful assistant's tool-call IDs are unique. A tool-result entry key equals one visible call ID,
  its single message repeats that call ID/name, has one result at most, and belongs to the same conversation.
  Trusted turn authors remain responsible for creating the right tasks and input ownership.

An exchange consists of one successful assistant entry containing tool calls and its tool-result entries.
A head may retain the assistant (boundary at or before it) or omit the complete exchange (boundary after
its last required result). It may not omit the assistant while retaining any result or retain only a
suffix of its result entries. While future results can still land in that conversation, no boundary after
an incomplete assistant is valid. A self-head may omit an entire incomplete exchange inherited through a
fork when the fork has no local result-producing task for it; source tasks/results are not inherited.

### 3.3 Transcript versus model order

The transcript preserves append chronology. Admission prevents ordinary model-visible writes from being
inserted into an active turn and relying on projection to repair arbitrary chronology.

Projection performs only these deterministic transformations:

1. Stored head placement.
2. Stored edit folding.
3. Tool-result placement in the assistant call order.
4. Request-local missing-result repair when a historical fork cuts a successful exchange before all
   results. For each missing call, synthesize one `ToolResultMessage<JsonValue>` with the original call ID
   and name, `isError:true`, timestamp equal to the assistant timestamp, text
   `"Tool result unavailable: history ends before this call completed."`, and details
   `{ reason: "missing_after_fork" }`. The repair is request-local and is never stored.
5. Provider/model normalization in pi-ai.

Speculative collapse is the deliberate exception. A summary head may append chronologically while another
turn runs. The head targets an old complete exchange boundary and projects before its retained tail, so it
cannot split the current exchange.

### 3.4 Context derivation

For a conversation and inclusive target entry `T`:

```text
H       = newest fork-visible entry at or before T with a stored head
from    = transcript start when H is absent, otherwise H.head
range   = fork-aware visible entries from `from` through T, inclusive
edits   = for each target, the newest edit in range wins
entries = when H is absent: range
          when H exists: H followed by range with every head entry removed
model   = for each selected entry in order, omit/replace its projection using edits,
          concatenate messages, then order/repair tool exchanges request-locally
```

An entry without `model` contributes no messages. A replacement changes the effective messages at the
target's position without changing its ID. A current-handle cache is disposable derived state. Historical
queries older than its cursor derive separately and never rewind the live cache. A request captures an
immutable selected-reference array and immutable effective replacements through a durable cutoff; later
entries, heads, edits and cache changes do not mutate it.

### 3.5 Forks

A fork creates a conversation with `parent = { conversationId, at }`. The target must be a visible entry
of the source; `"start"` means no inherited entries. Source entries keep their original IDs and owners.
A fork's logical transcript recursively includes each source prefix capped at the recorded fork point,
then its local entries. Later source changes are invisible. Tasks are never inherited.

Any entry is a valid fork point. If it cuts a successful exchange, request projection supplies missing
results locally but creates or inherits no tasks. A fork link is history, not ownership.

## 4. State and addresses

```ts
type Scope =
  | { readonly type: "session" }
  | { readonly type: "conversation"; readonly conversationId: Id }
  | { readonly type: "task"; readonly taskId: Id };

type Collection = "value" | "list";
declare const addressType: unique symbol;

interface Address<T extends JsonValue = JsonValue> {
  readonly scope: Scope;
  readonly namespace: string;
  readonly key?: string;
  readonly collection: Collection;
  readonly rewind: boolean;
  readonly [addressType]?: T;
}

interface Value<T extends JsonValue> extends Address<T> { readonly collection: "value" }
interface List<T extends JsonValue> extends Address<T> { readonly collection: "list" }
interface Version<T extends JsonValue> { readonly seq: Seq; readonly value: T }
interface Element<T extends JsonValue> { readonly id: Id; readonly value: T }

type StickyAddressOptions = { readonly key?: string; readonly rewind?: false };
type ConversationAddressOptions = { readonly key?: string; readonly rewind: boolean };
declare function valueAddress<T extends JsonValue>(
  scope: Extract<Scope, { type: "session" | "task" }>, namespace: string,
  options?: StickyAddressOptions,
): Value<T>;
declare function valueAddress<T extends JsonValue>(
  scope: Extract<Scope, { type: "conversation" }>, namespace: string,
  options: ConversationAddressOptions,
): Value<T>;
declare function listAddress<T extends JsonValue>(
  scope: Extract<Scope, { type: "session" | "task" }>, namespace: string,
  options?: StickyAddressOptions,
): List<T>;
declare function listAddress<T extends JsonValue>(
  scope: Extract<Scope, { type: "conversation" }>, namespace: string,
  options: ConversationAddressOptions,
): List<T>;
```

Addresses are fully bound. Session constructors require no ID; conversation constructors require a
conversation ID; task-scratch constructors require a task ID. Handles validate the bound ID and never
silently replace it. Session addresses are sticky and require `rewind:false`; task addresses are never
rewindable; conversation addresses explicitly select `rewind:true` or `false`. Ready packages compare addresses structurally by the tuple
`[scope type, scope id or null, collection, rewind, namespace, key-present, key or null]`. String wire
encoding is deferred to client integration.

Values use complete replacement and deletion. Lists use intrinsic append/remove/clear operations. For a
rewindable value, deletion records durable absence. For a rewindable list, remove and clear hide elements
only at and after their own sequence, preserving earlier historical reads. Sticky state exposes current
contents; a backend may physically discard removed sticky elements.

Historical `at` is an entry ID. Rewindable conversation lookup chooses the newest local mutation with
sequence `<= at`. If none exists and the conversation has a parent, recurse into the parent with
`min(at, parent.at)`. Lists combine inherited and local operations under the same caps. Scratch and sticky
historical reads reject. Forks inherit no scratch and inherit sticky conversation state only through an
explicit copy policy at creation.

A rewindable conversation `getValue(..., at)` or `readList({at})` requires `at` to be a fork-visible entry
of that address's conversation; an unrelated/missing position rejects `InvalidHistoryPosition`. `undefined`
selects current state.

Within one main transaction, every rewindable conversation value/list mutation must precede every entry
append. This makes state in the same batch visible at a fork through that entry while excluding later
state. Sticky/session state and task mutations may occur anywhere. A violating builder throws and the
whole transaction rolls back.

Namespaces beginning `pi.` are protected. Public/plugin constructors reject them unless created with an
internal built-in authority. Managed system records and input/result/receipt state cannot be written via
generic `record`, value or list handles.

Host transactions may use any nonprotected bound address. Normal and abort task transactions may use
session addresses and conversation addresses in the current task's conversation/owned subtree. A task
address is accepted only by that same task's `scratch` API; it is rejected by main transactions and by
another task. `TaskConversation.value/list` accepts session addresses and addresses bound to that handle's
conversation, and rejects every other conversation/task address.

## 5. Task records and kinds

```ts
interface TaskCheckpoint extends JsonObject { readonly phase: string }
type NoCheckpoint = never;

type TaskOutcome<R extends JsonValue, F extends JsonValue, A extends JsonValue> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly failure: F }
  | { readonly status: "aborted"; readonly result: A }
  | { readonly status: "orphaned" };

interface TaskBase<I extends JsonValue, C extends TaskCheckpoint> {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly input: I;
  readonly checkpoint?: C;
  readonly after: readonly Id[];
  readonly background?: true;
  readonly turn?: true;
  readonly owns: readonly Id[];
  readonly abort?: true;
}

type Task<I extends JsonValue = JsonValue, C extends TaskCheckpoint = TaskCheckpoint,
          R extends JsonValue = JsonValue, F extends JsonValue = JsonValue,
          A extends JsonValue = JsonValue> = TaskBase<I, C> & (
  | { readonly status: "pending" | "running"; readonly outcome?: never }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R, F, A> }
);

type RunningTask<I extends JsonValue, C extends TaskCheckpoint> =
  TaskBase<I, C> & { readonly status: "running"; readonly outcome?: never };

type Completion<R extends JsonValue, F extends JsonValue> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly failure: F };
```

Input is immutable. A checkpoint is optional and every write replaces the complete checkpoint. Its
`phase` is a kind-defined tag that the generic scheduler never interprets. Result, failure and abort
payloads are kind-specific strict JSON. Structurally identical checkpoint types are intentionally
assignable in TypeScript; kind attribution is supplied by the current runtime, not a nominal durable
brand. Differently shaped checkpoints, partial checkpoints and another kind's incompatible shape reject.

A task kind has five payload types and one literal capability:

```ts
type Turn = false | true;

declare const taskTypes: unique symbol;
interface TaskTypes<I extends JsonValue, C extends TaskCheckpoint,
                    R extends JsonValue, F extends JsonValue, A extends JsonValue> {
  readonly [taskTypes]?: { input: I; checkpoint: C; result: R; failure: F; aborted: A };
}

declare const taskKindBrand: unique symbol;
interface TaskKindBase {
  readonly kind: string;
  readonly turn: Turn;
  readonly [taskKindBrand]: true;
}

interface TaskKind<I extends JsonValue, C extends TaskCheckpoint,
                   R extends JsonValue, F extends JsonValue,
                   A extends JsonValue, T extends Turn = false>
  extends TaskKindBase, TaskTypes<I, C, R, F, A> {
  readonly turn: T;
  execute(task: RunningTask<I, C>, runtime: RuntimeFor<I, C, T>, call: Call):
    Promise<TerminalClosure<I, C, R, F, T>>;
  recover(task: RunningTask<I, C>, runtime: RuntimeFor<I, C, T>, call: Call):
    Promise<TerminalClosure<I, C, R, F, T>>;
  abort(task: RunningTask<I, C>, runtime: AbortRuntimeFor<I, C, T>, call: Call):
    Promise<AbortClosure<I, C, A, T>>;
}

type NoExtra<Expected, Actual extends Expected> =
  Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;

type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> =
  Expected extends readonly JsonValue[] ? Actual :
  Expected extends JsonObject
    ? Actual & Record<Exclude<keyof Actual, keyof Expected>, never>
    : Actual;

type NonTurnKindDefinition<I extends JsonValue, C extends TaskCheckpoint,
                           R extends JsonValue, F extends JsonValue, A extends JsonValue> =
  Omit<TaskKind<I, C, R, F, A, false>, "turn" | typeof taskKindBrand> & { readonly turn?: false };

type TurnKindDefinition<I extends JsonValue, C extends TaskCheckpoint,
                        R extends JsonValue, F extends JsonValue, A extends JsonValue> =
  Omit<TaskKind<I, C, R, F, A, true>, typeof taskKindBrand>;

interface TaskKindFactory<I extends JsonValue, C extends TaskCheckpoint,
                          R extends JsonValue, F extends JsonValue, A extends JsonValue> {
  <D extends NonTurnKindDefinition<I, C, R, F, A>>(
    definition: NoExtra<NonTurnKindDefinition<I, C, R, F, A>, D>,
  ): D & TaskKind<I, C, R, F, A, false>;
  <D extends TurnKindDefinition<I, C, R, F, A>>(
    definition: NoExtra<TurnKindDefinition<I, C, R, F, A>, D>,
  ): D & TaskKind<I, C, R, F, A, true>;
}

declare function defineTaskKind<I extends JsonValue, C extends TaskCheckpoint,
                                R extends JsonValue, F extends JsonValue,
                                A extends JsonValue>(): TaskKindFactory<I, C, R, F, A>;
```

Only `defineTaskKind` constructs the private brand and installs a module-private erased invocation adapter;
registries store `TaskKindBase` tokens and resolve that adapter rather than invoking methods through an
existential generic type. The public adapter bridge uses `unknown` plus validated records internally, never
exported `any`. The helper preserves all payload witnesses and literal turn capability; omitted `turn` is
returned as `false`. `tx.task`, checkpoint writes and closures infer from that token. `NoExtra` is also applied to the
actual inferred task spec type, so visible extra top-level fields in literals, variables and spreads reject.
Deep structural exactness, casts and erased fields remain normal TypeScript limits. Wire/plugin RPC
boundaries validate strict JSON and optional schemas before calling trusted local APIs.

`turn:true` is a trusted advanced declaration. It grants direct model-affecting entry authority and puts
live instances in the turn barrier. It does not prove membership in the built-in graph. Third-party kinds
may replace built-ins or construct custom turn graphs and are responsible for assistant/tool/input-group
semantics. The runtime still enforces generic entry, head, edit, ownership and transaction invariants.
`background` is independent: speculative manual collapse is `background + turn`; automatic collapse is
foreground + turn.

Task-kind replacement while live tasks exist requires the replacement's materialized `turn` to equal every
live task's stored `turn`. Incompatible capability replacement rejects. With no live instance, a future
replacement may change capability for newly created tasks. Terminal history is not rewritten. Payload and
checkpoint compatibility beyond this runtime-checkable property is the replacement author's responsibility.

## 6. Mutation algebra and storage

### 6.1 Mutations

```ts
type StateMutation =
  | { readonly type: "value.set"; readonly address: Address; readonly value: JsonValue }
  | { readonly type: "value.delete"; readonly address: Address }
  | { readonly type: "list.append"; readonly address: Address; readonly element: Element }
  | { readonly type: "list.remove"; readonly address: Address; readonly elementId: Id }
  | { readonly type: "list.clear"; readonly address: Address };

type MainMutation = StateMutation |
  { readonly type: "conversation.create"; readonly conversation: Conversation } |
  { readonly type: "entry.append"; readonly entry: Entry } |
  { readonly type: "task.create"; readonly task: Task } |
  { readonly type: "task.running"; readonly taskId: Id } |
  { readonly type: "task.checkpoint"; readonly taskId: Id; readonly checkpoint: TaskCheckpoint } |
  { readonly type: "task.own"; readonly taskId: Id; readonly conversationId: Id } |
  { readonly type: "task.abort"; readonly taskId: Id } |
  { readonly type: "task.terminal"; readonly taskId: Id; readonly outcome: TaskOutcome<JsonValue, JsonValue, JsonValue> };

type CommitBatch =
  | { readonly kind: "main"; readonly writes: readonly MainMutation[] }
  | { readonly kind: "scratch"; readonly taskId: Id; readonly writes: readonly StateMutation[] };

interface CommitReceipt { readonly first: Seq; readonly last: Seq }
```

Each mutation consumes one sequence. `conversation.create`, `entry.append`, `task.create` and
`list.append` carry the ID assigned to that mutation. `task.terminal` atomically retires all scratch for
the task; no separate retirement mutation can be forgotten. A scratch batch contains only scratch-scope
state mutations for exactly its declared task. Main batches contain no scratch address. Empty batches are
not passed to storage, do not advance `lastSeq` and publish no event.

Storage applies a batch atomically or not at all. It checks expected object IDs against assigned sequences,
scope/batch consistency and references, but it does not execute kind code or validate application payload
schemas. An uncertain commit failure poisons the storage handle; the harness fail-stops and never retries
that closure on the same handle.

### 6.2 Queries

```ts
interface Cursor { readonly after?: Id; readonly before?: Id; readonly limit: number }
interface Page<T> { readonly items: readonly T[]; readonly next?: Id; readonly readAt: Seq }

interface ConversationQuery extends Cursor {
  readonly parent?: Id;
  readonly owner?: Id;
}
interface EntryQuery extends Cursor {
  readonly conversationId: Id;
  readonly kind?: string;
  readonly key?: string;
  readonly from?: Id;
  readonly through?: Id;
}
interface TaskQuery extends Cursor {
  readonly conversationIds?: readonly Id[];
  readonly live?: boolean;
  readonly status?: "pending" | "running" | "terminal";
  readonly kind?: string;
  readonly abort?: boolean;
}
interface ListQuery extends Cursor { readonly at?: Id }
interface Storage {
  readonly lastSeq: Seq;
  claim(call: Call): Promise<void>;
  commit(batch: CommitBatch, call: Call): Promise<CommitReceipt>;
  getConversations(ids: readonly Id[], call: Call): Promise<ReadonlyMap<Id, Conversation>>;
  scanConversations(query: ConversationQuery, call: Call): Promise<Page<Conversation>>;
  getEntryKindNames(call: Call): Promise<ReadonlySet<string>>;
  getEntries(ids: readonly Id[], call: Call): Promise<ReadonlyMap<Id, Entry>>;
  scanEntries(query: EntryQuery, call: Call): Promise<Page<Entry>>;
  newestHead(conversationId: Id, at: Id, call: Call): Promise<Entry | undefined>;
  getTasks(ids: readonly Id[], call: Call): Promise<ReadonlyMap<Id, Task>>;
  scanTasks(query: TaskQuery, call: Call): Promise<Page<Task>>;
  getValue<T extends JsonValue>(address: Value<T>, at: Id | undefined, call: Call): Promise<Version<T> | undefined>;
  readList<T extends JsonValue>(address: List<T>, query: ListQuery, call: Call): Promise<Page<Element<T>>>;
  close(call: Call): Promise<void>; // also releases the claim
}
```

Cursor rules:

- `after` and `before` are exclusive and mutually exclusive.
- `limit` is a positive bounded integer.
- Filters and fork caps apply before the limit and before decoding payloads where the backend can avoid it.
- Forward (`after` or neither) selects ascending IDs and returns ascending items; `next` is the final item ID
  when more exist.
- Backward (`before`) selects the nearest preceding items and still returns them in ascending transcript
  order; `next` is the first item ID when more precede it.
- `from` and `through` are inclusive logical-transcript bounds.
- `readAt` is the storage `lastSeq` observed by the coherent read.
- Conversation `parent` and `owner` filters are exact IDs and mutually composable.
- `live:true` means pending/running. `live:false` means terminal. Omitted means all.

`scanEntries` and `newestHead` are fork-aware. Tasks are never inherited. Named owner-task reads may return
terminal tasks. Latest value/head queries are indexed descending limit-one operations, not load-and-tail.

Storage validates the structural state columns in this table against committed state plus prior batch
writes. Before storage is called, transaction/driver validation separately proves current invocation,
normal-versus-abort method, open-reconciliation authority, mark and session phase.

| mutation | structural current state | structural result |
|---|---|---|
| create | absent | pending, no checkpoint/outcome/abort, empty owns |
| running | pending | normal reservation requires terminal dependencies; marked abort reservation ignores dependencies |
| checkpoint | running | complete replacement with phase |
| own | running | newly created child names this owner; append once in same batch |
| abort | pending or running | set mark; repeated helper call is idempotent |
| completed/failed terminal | running and unmarked | terminal, matching outcome required, scratch retired |
| aborted terminal | running and marked | terminal, aborted outcome required, scratch retired |
| orphaned terminal | pending or running | terminal, orphaned outcome required, scratch retired |
| any mutation of terminal | terminal | reject |

Every owned `conversation.create` has exactly one matching `task.own` in the same batch. Reject an unpaired
side, ownership of an existing conversation, duplicate ownership or mismatched owner IDs. Conversation
ownership and the corresponding task `owns` element are immutable after creation.

List removal rejects an element ID that never existed or belongs to another list. It is idempotent only for
an existing same-list element already hidden/removed, and still consumes its buffered sequence. Clear is valid on an empty list and
consumes a sequence. Reading any task-scope address after its task is terminal rejects `ScratchRetired` in
all backends; it never returns an accidentally retained sidecar value.

Transaction reads run while the line is exclusively held and see committed state only. Generic reads do
not see buffered writes. Builder helpers and whole-batch validation maintain a private overlay of prior
buffered writes so they can validate references to newly created objects and deduplicate a request key
created earlier in the same batch. Authors carry values they just wrote rather than read them back.

## 7. Transaction and capability surfaces

### 7.1 Common readers and state builders

```ts
interface TxReaders {
  getConversation(id: Id): Promise<Conversation | undefined>;
  getEntry(id: Id): Promise<Entry | undefined>;
  getEntry<E extends Entry>(kind: EntryKind<E>, id: Id): Promise<E | undefined>;
  getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
  getTask(id: Id): Promise<Task | undefined>;
  getTask<K extends AnyTaskKind>(kind: K, id: Id): Promise<TaskOf<K> | undefined>;
  getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
}

interface TxValue<T extends JsonValue> {
  get(at?: Id): Promise<T | undefined>;
  set(value: T): void;
  delete(): void;
}
interface TxList<T extends JsonValue> {
  read(query: ListQuery): Promise<Page<Element<T>>>;
  append(value: T): Id;
  remove(id: Id): void;
  clear(): void;
}
```

The aliases are:

```ts
type AnyTaskKind = TaskKindBase;
type PayloadsOf<K> = K extends TaskTypes<infer I, infer C, infer R, infer F, infer A>
  ? { input: I; checkpoint: C; result: R; failure: F; aborted: A }
  : never;
type InputOf<K> = PayloadsOf<K>["input"];
type CheckpointOf<K> = PayloadsOf<K>["checkpoint"];
type ResultOf<K> = PayloadsOf<K>["result"];
type FailureOf<K> = PayloadsOf<K>["failure"];
type AbortedOf<K> = PayloadsOf<K>["aborted"];
type TurnOf<K extends TaskKindBase> = K["turn"];
type TaskOf<K extends TaskKindBase> = Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>;
```

The implementation may use distributive helper aliases to satisfy TypeScript variance without weakening
these public results. None may use `any`. Task-bound checkpoint methods exist only for the current kind.

### 7.2 Admission-capable base transaction

```ts
interface Acceptance { readonly requestId?: string; readonly conversationId: Id; readonly inputId: Id }

interface TaskSpec<I extends JsonValue> {
  readonly conversationId?: Id;
  readonly input: I;
  readonly after?: readonly Id[];
  readonly background?: true;
}

interface ConversationCreateSpec {
  readonly parent?: { readonly conversationId: Id; readonly at: Id };
}

interface BaseTaskTx<C extends TaskCheckpoint> extends TxReaders {
  checkpoint(value: C): void;
  task<K extends TaskKindBase, S extends TaskSpec<InputOf<K>>>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>>, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
  createConversation(spec: ConversationCreateSpec): Id;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
  record<D extends JsonValue>(kind: string, conversationId: Id, input: DataEntryInput<D>): Id;
  accept(conversationId: Id, options: AcceptOptions): Promise<Acceptance>;
  queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}

interface TurnTaskTx<C extends TaskCheckpoint> extends BaseTaskTx<C> {
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
}
```

A conversation-bound variant omits explicit `conversationId`. In a task transaction, omitted task target
conversation means the current task's conversation. Explicit targets must be that conversation or a
conversation in its ownership subtree, including one created earlier in the batch. `createConversation`
automatically records `owner=current task` plus `task.own`; a host transaction creates an independent
conversation unless an internal owner authority is supplied. Its optional parent must be the current
conversation or one in the current task's owned subtree; a task cannot inherit transcript/state from an
unrelated tree. A parent may be combined with ownership.
`record` accepts an explicit data-only shape and a kind string; it cannot address protected kind strings.
Typed readers may independently use an `EntryKind` with the same string. `accept`, `queueInput` and `write`
are asynchronous because request-key lookup is
a committed storage read; after that read they synchronously buffer all writes. They do not reenter the
line and may operate on a conversation created earlier in the same transaction. This permits one atomic
batch to create an owned child, copy state, accept its first input, create its first generation and
checkpoint the child/input IDs.

Direct entry authorization and admission helpers are distinct. A non-turn helper may buffer an authorized
model-visible append after validating placement; casting to `TurnTaskTx` and calling direct `entry` fails
runtime authorization. Every builder records private provenance for validation; storage sees only the
resulting mutation algebra.

A task may create another declared `turn:true` kind. That child kind owns the advanced contract. Generic
task creation does not transfer direct-entry capability to the caller.

### 7.3 Runtime and restricted conversation handle

```ts
interface PublicValue<T extends JsonValue> {
  get(at: Id | undefined, call: Call): Promise<T | undefined>;
  set(value: T, call: Call): Promise<void>;
  delete(call: Call): Promise<void>;
}
interface PublicList<T extends JsonValue> {
  read(query: ListQuery, call: Call): Promise<Page<Element<T>>>;
  append(value: T, call: Call): Promise<Id>;
  remove(id: Id, call: Call): Promise<void>;
  clear(call: Call): Promise<void>;
}
interface ScratchTx {
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
}
interface ScratchReader {
  value<T extends JsonValue>(address: Value<T>): Pick<TxValue<T>, "get">;
  list<T extends JsonValue>(address: List<T>): Pick<TxList<T>, "read">;
}

interface TaskConversation {
  readonly id: Id;
  snapshot(call: Call): Promise<Conversation>;
  accept(options: AcceptOptions, call: Call): Promise<Acceptance>;
  queueInput(input: QueuedInput, call: Call): Promise<Acceptance>;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, requestId: string | undefined, call: Call): Promise<Acceptance>;
  result(inputId: Id, call: Call): Promise<InputResult | undefined>;
  waitForInput(inputId: Id, call: Call): Promise<TerminalInputResult>;
  abortInput(inputId: Id, call: Call): Promise<"aborted" | "already_placed" | "not_found">;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface AbortTaskConversation {
  readonly id: Id;
  snapshot(call: Call): Promise<Conversation>;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, requestId: string | undefined, call: Call): Promise<Acceptance>;
  result(inputId: Id, call: Call): Promise<InputResult | undefined>;
  waitForInput(inputId: Id, call: Call): Promise<TerminalInputResult>;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface BaseTaskRuntime<I extends JsonValue, C extends TaskCheckpoint> {
  readonly taskId: Id;
  commit<T>(build: (tx: BaseTaskTx<C>, current: RunningTask<I, C>) => T | Promise<T>, call: Call): Promise<T>;
  scratch<T>(build: (tx: ScratchTx) => T | Promise<T>, call: Call): Promise<T>;
  conversation(id: Id, call: Call): Promise<TaskConversation | undefined>;
  waitForTask(id: Id, call: Call): Promise<Task>;
  abortTask(id: Id, call: Call): Promise<"marked" | "terminal">;
  now(): number;
  sleep(untilMs: number, call: Call): Promise<void>;
}
interface TurnTaskRuntime<I extends JsonValue, C extends TaskCheckpoint>
  extends Omit<BaseTaskRuntime<I, C>, "commit"> {
  commit<T>(build: (tx: TurnTaskTx<C>, current: RunningTask<I, C>) => T | Promise<T>, call: Call): Promise<T>;
}
type RuntimeFor<I extends JsonValue, C extends TaskCheckpoint, T extends Turn> =
  T extends true ? TurnTaskRuntime<I, C> : BaseTaskRuntime<I, C>;
```

`runtime.conversation`, `waitForTask` and `abortTask` accept only targets in the current task's ownership
tree: its own conversation, its owned descendants, their tasks, and the task's own dependencies. An
unrelated target rejects `ScopeViolation`. Host operations are unrestricted except for protected data and
normal lifecycle validation.

`TaskConversation` has no raw commit, direct entry, drive, close, shutdown, delete or host-wide registry
methods. Task operations capture the expected invocation when the runtime/handle is constructed. Every
supplied Call must contain that exact current invocation object. An absent, foreign or stale identity
rejects; task methods never fall back to host authority.

### 7.4 Terminal and abort transactions

```ts
interface TerminalTx<C extends TaskCheckpoint> extends BaseTaskTx<C> {}
interface TurnTerminalTx<C extends TaskCheckpoint> extends TurnTaskTx<C> {}

type FinalTx<C extends TaskCheckpoint, T extends Turn> =
  T extends true ? TurnTerminalTx<C> : TerminalTx<C>;

type TerminalClosure<I extends JsonValue, C extends TaskCheckpoint,
                     R extends JsonValue, F extends JsonValue, T extends Turn> =
  (tx: FinalTx<C, T>, current: RunningTask<I, C>) =>
    Completion<R, F> | Promise<Completion<R, F>>;

interface AbortTx<C extends TaskCheckpoint> extends TxReaders {
  checkpoint(value: C): void;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
  record<D extends JsonValue>(kind: string, conversationId: Id, input: DataEntryInput<D>): Id;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
  markTask(id: Id): Promise<"marked" | "terminal">;
}
interface TurnAbortTx<C extends TaskCheckpoint> extends AbortTx<C> {
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
}
type AbortFinalTx<C extends TaskCheckpoint, T extends Turn> = T extends true ? TurnAbortTx<C> : AbortTx<C>;

type AbortClosure<I extends JsonValue, C extends TaskCheckpoint,
                  A extends JsonValue, T extends Turn> =
  (tx: AbortFinalTx<C, T>, current: RunningTask<I, C>) => A | Promise<A>;

interface BaseAbortRuntime<I extends JsonValue, C extends TaskCheckpoint> {
  readonly taskId: Id;
  commit<T>(build: (tx: AbortTx<C>, current: RunningTask<I, C>) => T | Promise<T>, call: Call): Promise<T>;
  scratch<T>(read: (scratch: ScratchReader) => T | Promise<T>, call: Call): Promise<T>;
  conversation(id: Id, call: Call): Promise<AbortTaskConversation | undefined>;
  waitForTask(id: Id, call: Call): Promise<Task>;
  abortTask(id: Id, call: Call): Promise<"marked" | "terminal">;
  now(): number;
}
interface TurnAbortRuntime<I extends JsonValue, C extends TaskCheckpoint>
  extends Omit<BaseAbortRuntime<I, C>, "commit"> {
  commit<T>(build: (tx: TurnAbortTx<C>, current: RunningTask<I, C>) => T | Promise<T>, call: Call): Promise<T>;
}
type AbortRuntimeFor<I extends JsonValue, C extends TaskCheckpoint, T extends Turn> =
  T extends true ? TurnAbortRuntime<I, C> : BaseAbortRuntime<I, C>;
```

Abort runtime exposes repeated restricted commits with the same surface as `AbortTx`, plus scratch reads
but no scratch writes. It cannot create tasks/conversations, delete conversations, call `accept`, queue
steer/followUp/nextRun, or drive. `write` in abort is restricted to passive `mode:"write"`; it may append
immediately only when safe and otherwise remains queued. Turn abort keeps direct entry authority so a tool
can atomically publish its aborted tool result. Checkpoint replacement is allowed during lengthy fresh
cleanup; a crash reruns abort from the newest checkpoint because the durable mark remains.

Terminal closures run on the line after all effects and producer joins. They may await transaction storage
reads and mint same-batch IDs, but may not perform external effects, hooks, sleeps, waits or nested runtime
operations. The harness then adds `task.terminal` with the returned outcome. A throwing closure persists
nothing and faults the session. Abort/close/fault may discard a normal closure without invoking it.
Uncertain persistence fail-stops and does not retry the closure on that handle.

### 7.5 Host transactions and foundation handles

Host transactions are not task invocations. They may append model-affecting entries directly only when
`inTurn` is empty; otherwise direct append rejects and `write` is required.

```ts
interface HostTx extends TxReaders {
  task<K extends TaskKindBase, S extends TaskSpec<InputOf<K>> & { readonly conversationId: Id }>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>> & { readonly conversationId: Id }, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
  createConversation(spec: ConversationCreateSpec): Id;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
  record<D extends JsonValue>(kind: string, conversationId: Id, input: DataEntryInput<D>): Id;
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
  accept(conversationId: Id, options: AcceptOptions): Promise<Acceptance>;
  queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}

interface ConversationTx extends Omit<HostTx, "task" | "record" | "entry" | "accept" | "queueInput" | "write"> {
  task<K extends TaskKindBase, S extends Omit<TaskSpec<InputOf<K>>, "conversationId">>(
    kind: K,
    spec: NoExtra<Omit<TaskSpec<InputOf<K>>, "conversationId">, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
  record<D extends JsonValue>(kind: string, input: DataEntryInput<D>): Id;
  entry<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Id;
  accept(options: AcceptOptions): Promise<Acceptance>;
  queueInput(input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}

interface ConversationHandle {
  readonly id: Id;
  snapshot(call: Call): Promise<Conversation>;
  commit<T>(build: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
  accept(options: AcceptOptions, call: Call): Promise<Acceptance>;
  queueInput(input: QueuedInput, call: Call): Promise<Acceptance>;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, requestId: string | undefined, call: Call): Promise<Acceptance>;
  result(inputId: Id, call: Call): Promise<InputResult | undefined>;
  waitForInput(inputId: Id, call: Call): Promise<TerminalInputResult>;
  abortInput(inputId: Id, call: Call): Promise<"aborted" | "already_placed" | "not_found">;
  drive(call: Call): Promise<"idle" | "closed">;
  abort(call: Call): Promise<void>;
  fork(options: { readonly at: Id | "start"; readonly abort?: boolean }, call: Call): Promise<ConversationHandle>;
  collapse(options: { readonly instructions?: string } | undefined, call: Call): Promise<Id>;
  reset(options: { readonly handoff?: string } | undefined, call: Call): Promise<void>;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface Harness {
  root(call: Call): Promise<ConversationHandle>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  commit<T>(build: (tx: HostTx) => T | Promise<T>, call: Call): Promise<T>;
  acceptance(requestId: string, call: Call): Promise<Acceptance | undefined>;
  getEntry(id: Id, call: Call): Promise<Entry | undefined>;
  getTask(id: Id, call: Call): Promise<Task | undefined>;
  abortTask(id: Id, call: Call): Promise<"marked" | "terminal">;
  drive(call: Call): Promise<"idle" | "closed">;
  close(call: Call): Promise<void>;
  shutdown(call: Call): Promise<void>;
}
```

There is no partial public harness or feature-not-installed facade. Leaf packages are tested directly.
The single `Harness` is exported only when its required built-in dependencies are implemented.

## 8. Input admission and boundaries

### 8.1 Records

```ts
type UserInput = string | readonly (TextContent | ImageContent)[];

interface StoredEntryDraft {
  readonly kind: string;
  readonly key?: string;
  readonly data?: JsonValue;
  readonly model?: readonly Message[];
  readonly head?: Id | "self";
  readonly edits?: readonly ContextEdit[];
}

type QueuedInput =
  | { readonly mode: "steer" | "followUp" | "nextRun"; readonly input: UserInput; readonly requestId?: string }
  | { readonly mode: "write"; readonly entry: StoredEntryDraft; readonly requestId?: string };

type InputResult =
  | { readonly status: "queued"; readonly requestId?: string }
  | { readonly status: "placed"; readonly requestId?: string; readonly entry: Id }
  | { readonly status: "done"; readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
  | { readonly status: "unanswered"; readonly requestId?: string; readonly entry?: Id;
      readonly reason: "terminated" | "aborted" | "failed" | "stale"; readonly detail?: string };

type TerminalInputResult = Extract<InputResult, { status: "done" | "unanswered" }>;

interface AcceptOptions {
  readonly input: UserInput;
  readonly requestId?: string;
  readonly whenBusy?: "followUp" | "steer" | "reject";
}
```

The protected sticky list `pi.inbox` stores `QueuedInput`; its element ID is `inputId`. Protected sticky
values store `InputResult` by input ID and `Acceptance` by session-wide request key. A request key names the
first acceptance for the session lifetime. Request-key lookup occurs before conversation, busy, payload or
mode comparison. Duplicate `accept`, `queueInput` or `write` returns the original receipt and buffers
nothing, even when the retry supplied different data.

Only protected admission/boundary helpers write input results, using this transition table:

```text
absent                    -> queued
queued                    -> placed
queued write              -> done
queued                    -> unanswered(aborted | stale)
placed                    -> done
placed                    -> unanswered(terminated | aborted | failed)
done | unanswered         -> immutable
```

An idle accepted input may write `absent -> placed` in its one batch; an idle write may write
`absent -> done`. These are the only collapsed transitions and still create/remove the inbox element so
`inputId` is its list-element ID.

Enqueue validation checks the stored entry draft as far as current state allows. At placement it is fully
revalidated. If a queued head no longer satisfies visibility, monotonicity or exchange-boundary rules, the
placement atomically removes it and writes `unanswered/stale`; ordinary staleness never faults the session.
Queued edits whose targets have moved outside context remain valid no-ops; protected managed-system edits
remain forbidden.

### 8.2 Generation admission strategy

The foundation does not guess a provider generation payload. Input placement receives one strategy:

```ts
interface InternalBoundaryTx extends TxReaders {
  task<K extends TaskKindBase, S extends TaskSpec<InputOf<K>> & { readonly conversationId: Id }>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>> & { readonly conversationId: Id }, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
}
interface InternalGenerationAdmission<K extends TaskKindBase = TaskKindBase> {
  readonly kind: K;
  create(
    tx: InternalBoundaryTx,
    conversationId: Id,
    inputs: readonly Id[],
  ): Id | Promise<Id>;
}
```

This is a private admission-module/test seam, not a public Harness option. The callback runs inside the
current transaction and may perform transaction reads plus one task creation;
it cannot append entries, mutate state, perform effects or enter the line. Validation requires exactly one
new task in the registered core generation slot, in `conversationId`, with materialized `turn:true`, and
requires its returned ID to be that task. The expected token/name is `strategy.kind`; production wiring
supplies the registered generation-slot token. Accounting for exactly the supplied input IDs is the trusted
strategy's typed obligation; the erased kernel cannot inspect an arbitrary generation input to prove it.
WP5 tests supply a minimal typed generation kind; the provider package supplies the production strategy.

### 8.3 Busy and placement predicates

`inTurn(conversation)` means at least one live task in that conversation has stored `turn:true`, regardless
of foreground/background. This is transcript admission busy, not drive idleness and not proof of input
ownership.

- `accept` when `inTurn` is empty performs an idle admission transaction: drain older queued writes; combine
  older queued steer/followUp/nextRun in admission order with the new input; append their user entries;
  create one built-in generation owning those input IDs; mark each placed. The newly accepted input is last
  among older queued items. `whenBusy` is irrelevant.
- `accept` when `inTurn` is nonempty queues `followUp` by default, queues `steer` when requested, or throws
  `ConversationBusy` and writes no request receipt when `reject` is requested.
- `write` appends and completes immediately when `inTurn` is empty; otherwise it queues.
- Explicit `nextRun` is never placed merely because turn activity ends; it joins the next explicit idle
  `accept`.

Boundary operations are transaction helpers, not nested commits:

- **post-tools boundary:** place queued writes, then steering in admission order; steering joins the active
  input group. FollowUp and nextRun remain queued.
- **final-answer boundary:** resolve the active group to the answer; place writes; place steer then followUp
  in admission order into a new group and create its generation. nextRun remains queued.
- **idle-turn boundary:** when a normal terminal batch changes `inTurn` from nonempty to empty and creates
  no turn successor, Pico automatically places writes and places steer/followUp into a new generation.
  nextRun remains queued. This covers a solitary speculative collapse and a well-behaved custom turn.
- **abort boundary:** no automatic generation or queue drain. Conversation abort separately withdraws
  queued steer/followUp; task abort preserves queues. A later idle accept can consume preserved items.

Normal terminal finalization uses this exact order:

```text
invoke returned closure and buffer its writes
obtain its completed/failed outcome
buffer task.terminal
compute prospective inTurn from committed live tasks plus the whole buffered batch
when eligible, append idle-boundary inbox/result/entry/generation mutations
validate and persist the complete batch
```

The terminal mutation and automatic boundary are one atomic main batch. Abort, orphan reconciliation,
close and fault never run automatic idle-boundary augmentation. WP5 implements the pure prospective planner;
WP6 integrates it with normal closure finalization.

If a speculative collapse completes while a generation/tool/post_tools task remains live, no idle boundary
runs; the built-in owner processes the inbox later. If collapse is the sole turn task, its normal terminal
commit triggers the idle boundary, so listener input cannot starve. A third-party turn author may explicitly
use post-tools/final helpers when it owns an input group. If it simply ends as the last turn task, the idle
boundary is the least-footgun fallback. Pico never infers or resolves a custom kind's private input group.

Input ownership for built-in turns is explicit `inputs: readonly Id[]` in generation/post_tools input or
checkpoint. Exactly one live built-in generation or post_tools owns each placed active group, and ownership
transfers in the same terminal batch. Generic scheduling never scans arbitrary checkpoints for ownership.

### 8.4 Withdrawing input

`abortInput(id)` serializes with placement. If the queued item belongs to this conversation, it atomically
removes it and writes terminal `unanswered/aborted`, then returns `aborted`. If placement or any terminal
result already won, it returns `already_placed` and changes nothing. A missing input or one belonging to
another conversation returns `not_found`. If a queued result exists but its inbox element is missing, Pico
faults the session as corrupted state.

### 8.5 Waiting for input

`result(id)` is a point read. `waitForInput(id, call)`:

- validates that the input exists and belongs to the target conversation, otherwise rejects `InputNotFound`;
- returns only `done` or `unanswered`;
- registers/checks/removes its waiter on the line without polling;
- temporarily serves the target conversation's ownership scope until the result, caller cancellation,
  close or fault; an existing stable attachment is unaffected;
- removes its signal listener and temporary serving reference exactly once;
- rejects caller cancellation, close and fault; shutdown eventually closes and rejects unresolved queued
  waits rather than deleting their durable input;
- does not mark or cancel durable work when its caller cancels.

Known self-progress cycles use a conservative generic rule evaluated at waiter registration and whenever
the live/dependency graph changes:

- A live turn invocation waiting for any nonterminal input in its own conversation rejects `SelfWait`,
  whether that result is queued or placed and including `nextRun`.
- For a non-turn caller, every current live turn task in the target conversation is a possible placer. If
  any such task has an unresolved dependency path to the caller, reject `SelfWait`.
- A foreground non-turn task that accepts into an idle conversation creates an independent generation and
  may wait; its own liveness alone is not a cycle.
- A non-turn wait on `nextRun` simply waits for a later explicit idle accept unless the dependency rule
  above proves a cycle.

No blocker set is stored at enqueue. Provider built-ins may later supply a more precise explicit boundary
owner; the generic scheduler never infers one from task payloads. Hidden plugin-promise cycles remain the
author's responsibility.

## 9. Commit line and runtime authorization

One FIFO async line serializes commits, reservations, marks, lifecycle transitions, registry mutations,
waiter registration/removal and watch capture. A transaction callback may await storage reads while holding
the line. It must not await effects, hooks, task/input/drive waits, sleeps or nested line operations. Every
intermediate, terminal and abort builder receives a fresh immutable current task read on the line after all
committed checkpoint/mark changes; it never receives only the method's older snapshot.

Caller cancellation is checked while waiting to enter the line and again before the builder begins. Once
the builder is admitted, caller cancellation cannot abandon builder completion or persistence. Storage
receives an internal non-abandoning Call that preserves telemetry but not the caller's abort signal. Task
invocation identity, lifecycle and durable mark are still revalidated on the line before invoking its
builder.

Commit sequence:

```text
enter line
validate session phase and caller/invocation authority
construct capability-bound transaction
run builder against stable committed storage; buffer writes
validate buffered sequence/order/references/capabilities using committed state + overlay
persist complete batch
apply complete batch to all process indexes and views
reserve newly eligible work and resolve affected waiters
leave line
dispatch task methods, signals and listeners outside line
resolve outer commit promise
```

Publication never precedes persistence. Every index observes a full batch before scheduling or idleness,
so terminal task + successor has no visible idle gap.

Private invocation identity contains task ID, method (`execute`, `recover`, `abort`) and a unique object.
The driver installs that exact object in a derived Call and binds every task runtime/handle to it. Runtime
admission compares object identity with the invocation slot. Metadata/RPC transport never confers authority.

Authorization table:

| phase/method | normal commit | scratch write | terminal closure | abort restricted commit/closure | host admission |
|---|---:|---:|---:|---:|---:|
| open, execute/recover, unmarked | yes | yes | yes | no | yes |
| open, execute/recover, marked | reject before builder | reject before builder | discard without invoke | no | yes |
| open, abort invocation | no | read only | no | yes | yes |
| stopping | no | no | discard | existing/new abort only | reject |
| closing/faulted/closed | no | no | discard | no; close/fault signal it | reject |

Safe `accept`/`write` authorization and raw direct-entry authorization are separate. Protected built-in
state and entry operations require internal helpers. Main and scratch writes from absent/foreign/stale task
identity reject; task-provided handles never treat them as host calls.

## 10. Scheduling, ownership and waits

Process indexes after open:

- complete live task map;
- one invocation slot per running task ID;
- tasks by conversation and live turn/foreground subsets;
- reverse dependency edges;
- conversation parent/owner ancestry needed by live tasks, invocations and attachments;
- stable conversation/session attachments;
- temporary drive/task/input waiters;
- session phase.

Dependencies are immutable, acyclic IDs in the same ownership tree. They may reference tasks created
earlier in the same batch, including the current task from its terminal closure. A task becomes eligible
when every dependency is terminal, regardless of outcome. Missing from the complete live map means terminal
after existence was validated. A foreground task depending on endless background work intentionally keeps
its scope busy.

Reservation on the line:

```text
marked live task                    -> fresh abort, ignoring dependencies
unmarked pending with terminal deps -> commit task.running, reserve execute
unmarked running loaded at open     -> reserve recover
```

A pending task marked before reservation never becomes running for effects; the harness writes the running
intent only as part of reserving fresh abort so `abort` receives `RunningTask`. A task created and marked in
one batch is likewise cleaned by abort without execute. Open itself starts nothing; recovery reservation
occurs only when a drive/attachment serves the task.

There is at most one invocation per task ID in a process. Its slot remains held through method return,
producer/progress joins and terminal-closure acceptance or discard. Different task IDs run concurrently.
Callbacks, methods and signals never execute on the line.

Serving follows ownership, not fork history. A stable conversation attachment serves tasks in that
conversation and every recursively owned descendant, including descendants whose owner task is terminal.
A session attachment serves all conversations. Terminal owner records needed for ancestry are fetched by
ID and only their immutable links are retained. Historical child lists are never traversed.

Foreground cancellation reach is narrower: start with live foreground tasks directly in the requested
conversation; recursively enter conversations owned by those live foreground tasks and repeat. A background
or terminal owner breaks cancellation reach. Queued input is not a task.

Conversation drive resolves when its served root has no live foreground task in that foreground ownership
closure. Session drive resolves when no foreground task exists anywhere. Stable attachment remains after a
waiter resolves/cancels, so attached background recurrence continues. Each drive call adds only a temporary
waiter. Cancelling it removes that waiter/listener and never cancels work.

`waitForTask` rejects `TaskNotFound` for a missing target, returns a terminal task immediately, or installs
one cancellable point waiter plus a temporary serving reference for a live target. It returns the terminal
task and follows the same cancellation cleanup rules. Direct self-wait and a wait on a
task whose unresolved dependency path reaches the caller reject. A task cannot drive its own foreground
scope. Cycle checks occur before an admission that would create known work blocked by its caller.

## 11. Cancellation, close, shutdown and fault

### 11.1 Task and conversation abort

`abortTask(id)` and abort-transaction `markTask(id)` reject `TaskNotFound` for a nonexistent ID, return
`terminal` for an existing terminal task, and return `marked` for either an unmarked or already-marked live
task. Marking does not attach an unrelated scope; cleanup starts when the task is served. Repeated marks are
idempotent and never cancel an already-running fresh abort invocation.

Conversation abort commits the mark/queue-withdrawal batch and records those task IDs as its tracked set.
It temporarily serves the affected ownership scope. Any mark issued by an abort invocation whose own task
is in that tracked set is added transitively to the same set. The operation resolves when every tracked task
is terminal and no tracked invocation remains. Unrelated background work is excluded. Caller cancellation
cannot abandon cleanup after the mark batch is admitted.

The mark transaction:

1. Compute the current foreground cancellation closure from the pre-commit live/ownership snapshot.
2. Mark every live task in it.
3. Remove queued steer/followUp in affected conversations and write terminal `unanswered/aborted` results.
4. Preserve queued write and nextRun.

When a mark wins:

```text
commit abort:true
revoke execute/recover main and scratch writes immediately
leave line; signal old invocation
wait for method, effects and owned progress producers to return
on line discard any normal terminal closure and release old invocation
reserve fresh abort with new identity/controller/Call
abort may perform restricted checkpointed cleanup
abort returns closure
apply passive/direct turn writes + aborted outcome + scratch retirement atomically
release abort invocation
```

Fresh built-in cleanup marks live foreground tasks in owned child conversations and recorded non-detached
jobs, using atomic mark-if-live; an already-terminal target counts as cleaned. It never invokes public child
conversation abort and therefore preserves child queues. Local deadlines are not durable marks: their
in-band errors remain kind-specific domain outcomes. Cancellation classification uses Pico's identity and
known reason, never error name alone.

An uncooperative effect can delay abort indefinitely. Forced isolation is outside v1.

### 11.2 Close

Close is a nonpersistent line transition that stops admission and reservation. Earlier admitted line work
finishes; later operations reject except invocation completion. Outside the line, signal and join every outstanding invocation, then close storage. A durably terminal task
has no outstanding invocation because terminal publication follows method return and producer joins. It writes no outcomes or marks.
Caller cancellation cannot abandon close. Repeated close calls share completion.

### 11.3 Shutdown

Shutdown enters `stopping` and commits marks for every live task in one batch. It preserves every queued
input/result. It serves abort cleanup session-wide until live tasks and invocation slots are empty, then
closes. Fresh abort handlers may commit; all normal work/admission rejects. A failing abort faults shutdown.
Caller cancellation cannot abandon an admitted shutdown. Explicit close may interrupt it; shutdown rejects
and durable marks recover later. Repeated shutdown calls share completion.

### 11.4 Fault

Unexpected persistence, invariant, capability, closure or task-contract errors fail-stop the session:
reject waiters immediately, stop admission/reservation, signal and join invocations, close storage, and
preserve durable unfinished tasks. Do not manufacture outcomes. Domain provider/tool failures must be
returned as typed outcomes by their kinds.

## 12. Scratch

Scratch uses the state vocabulary under `{type:"task", taskId}`. One scratch transaction writes one
live task only. It has value/list get/set/delete/append/remove/clear; reads are async, writes buffered.
Scratch is never rewindable, inherited or part of context.

Execute/recover may read and write its own scratch while unmarked. Abort may read but not write scratch;
it persists cleanup progress in the task checkpoint or permitted main state. A crash before terminal
outcome retains scratch. `task.terminal` retires it atomically. Every later scratch write rejects, even if a
sidecar unlink failed.

A retry under one task ID clears attempt-specific lists before new output. Generation stores compact
assistant frames, not cumulative provider snapshots. Generic output packages store compact append/replace/
truncate operations, not growing whole-value copies.

Harness-owned producers own every pending scratch promise, cancel on early exit, suppress only expected
mark/close rejection, report persistence faults and join before the invocation may finalize. Iterator exit
alone is not provider/process completion. Plugin code must await or catch every raw scratch write.

## 13. Harness open and registries

The final Harness has one construction API:

```ts
interface CoreTaskKinds {
  readonly generation: TaskKindBase;
  readonly tool: TaskKindBase;
  readonly postTools: TaskKindBase;
  readonly collapse: TaskKindBase;
  readonly job: TaskKindBase;
}
interface RootValueWrite<T extends JsonValue = JsonValue> {
  readonly address: Value<T>;
  readonly value: T;
}
interface HarnessOpenOptions {
  readonly taskKinds?: readonly TaskKindBase[];
  readonly entryKinds?: readonly EntryKind[];
  readonly replace?: Partial<CoreTaskKinds>;
  readonly rootValues?: readonly RootValueWrite[];
}
interface OpenInspection {
  readonly pending: readonly Task[];
  readonly running: readonly Task[];
  readonly orphaned: readonly Task[];
  readonly unknownEntryKinds: readonly string[];
}
interface MutableRegistry<D extends { readonly kind: string }> {
  get(kind: string, call: Call): Promise<D | undefined>;
  register<T extends D>(definition: T, call: Call): Promise<void>;
  replace<T extends D>(definition: T, call: Call): Promise<void>;
  remove(kind: string, call: Call): Promise<void>;
}
interface Harness {
  readonly kinds: CoreTaskKinds;
  readonly entryKinds: MutableRegistry<EntryKind>;
  readonly taskKinds: MutableRegistry<TaskKindBase>;
  inspect(call: Call): Promise<OpenInspection>;
}
interface HarnessFactory {
  open(storage: Storage, options: HarnessOpenOptions, call: Call): Promise<Harness>;
}
```

The two `Harness` declarations in this specification merge into one TypeScript interface.
`register`, `replace`, `remove` and `get` serialize on the line. Register rejects an existing name; replace
requires an existing name. Task removal rejects when live instances exist. Core kind removal always rejects.

Stable core names and capabilities are:

```text
generation  pi.generation   turn=true
tool        pi.tool         turn=true
postTools   pi.post_tools   turn=true
collapse    pi.collapse     turn=true
job         pi.job          turn=false
```

Harness installs the production core kinds. `replace` substitutes only named core slots and must preserve
the required turn capability. Additional `taskKinds` cannot use a core name. The internal admission strategy
is bound to the resulting generation slot.

Empty storage means exactly `lastSeq === 0`. The root conversation is the first mutation, has ID `1`, has no
parent/owner, and can never be deleted. Every `rootValues` address must be a value bound to conversation 1
(or an authorized built-in address bound there); duplicate addresses reject. Root creation and all root
values commit atomically. Nonempty storage ignores `rootValues`.

A storage handle is exclusively owned. Its first `claim` succeeds; another claim before `close` rejects.
Every commit/query requires an active claim. `close` makes later operations reject and releases the claim;
repeated close is harmless. `MemoryStorage` retains its data and permits a later claim after close for
recovery tests. Closed JSONL/SQLite objects are not reusable and must be reopened through their factories.
If driver/Harness initialization fails after claim, it closes/releases before rejecting. JSONL/SQLite also
hold a cross-process session lock from backend open through close. Two writers must fail rather than race.

Open order:

1. Finish backend replay/recovery and establish `lastSeq`.
2. Install required built-in entry kinds and task slots, then options and explicit replacements.
3. If storage is empty, create root conversation and apply `rootValues` in one commit. Reopen ignores
   `rootValues`.
4. Load the complete live-task seed and required ownership ancestry. Load recorded entry-kind names.
5. Validate live replacement capability compatibility.
6. Reconcile every live task whose kind is absent in one main commit.
7. Build all indexes and return inspection/read handles without starting work.

Core slots `generation`, `tool`, `post_tools`, `collapse` and `job` always have an implementation. They may
be explicitly replaced but not removed. This ensures accept/boundary processing and unavailable-tool
results remain available. Additional task kinds may be removed only when no live instance exists. Entry and
section definitions may be removed without deleting durable records. In-flight invocations/preparations
retain captured definitions; later operations use the new registry.

Missing-kind reconciliation uses one pre-reconciliation snapshot:

- Find every pending/running task whose kind is absent, foreground or background.
- For each missing task's owned conversations, recursively mark every registered live foreground descendant
  reachable through ownership. Preserve all queued input.
- Missing descendants are themselves orphaned rather than marked for code that does not exist.
- Terminalize each missing task as `orphaned`, retain input/checkpoint/history, remove live/dependency indexes
  and retire scratch atomically.
- Dependents observe a terminal dependency and interpret `orphaned`.
- Keep ancestry links so a later root drive serves registered marked descendants even though the owner is
  now terminal.
- Report orphaned IDs from `inspect`.

If validation, root creation, index loading or reconciliation fails, open closes/releases the supplied
storage binding before rejecting and returns no handle. Registration never resurrects orphaned tasks.

## 14. Built-in contracts retained for later packages

These contracts are normative behavior. Packages explicitly gated in section 18 wait for their unsettled
author APIs.

### 14.1 Generation and post_tools

Generation owns explicit input IDs and captured durable configuration. It checkpoints preparation cutoff,
attempt, retry wait, deferred handle and any request-specific validation data needed for recovery. A
request snapshot is immutable. `before_request` may transform a private messages-only request; actual
offered tools after transformation are the validation basis and must be recoverable when needed.

Assistant frames live in scratch. Retry and deferred polling loop cooperatively under one stable task ID.
`on_yield` receives the prospective assistant message/draft plus stable task ID, not an entry ID that does
not exist. The returned terminal closure atomically appends assistant/usage, resolves or transfers inputs,
and creates tools/post_tools/continuation.

For calls, generation creates every tool task and one post_tools depending on them in its closure. Each tool
writes exactly one result. Post_tools reads terminal outcomes in call order, handles completed/failed/
aborted/orphaned, places the post-tools boundary, and either terminates/handoffs or creates a continuation
while transferring inputs atomically.

Threshold or overflow creates collapse `C` and replacement generation `G` with `after:[C]`, carrying the
active inputs, in one closure. No invocation waits on collapse. `G` handles every terminal collapse outcome.

### 14.2 Collapse

Collapse captures reason, target prefix ending at a complete exchange, first retained boundary, newest head
and settings. It runs speculatively and may be background/manual or foreground/automatic. It checkpoints a
prepared candidate. Its terminal closure reads the current newest head on the line. A newer head returns
ordinary typed stale failure; intervening edits do not stale. Success appends summary head and completes in
one batch. Abort publishes no summary. One live collapse per conversation; simultaneous creation is
serialized and duplicate creation declines or reuses the existing ID according to the calling built-in.

### 14.3 Tools, jobs and owned conversations

Tool input includes immutable call and assistant entry ID. Missing implementation, invalid arguments, hook
block and ordinary throw become model-visible error results, not session faults. Recovery retries only with
a durable safe replay policy; otherwise it returns interrupted. Abort publishes an aborted tool result via
turn abort authority. A missing executable tool is handled by the built-in tool kind; it is not a missing
task kind.

A subagent is an owned conversation. Creation, selected initial values, accepted input, first generation,
ownership links and parent checkpoint IDs commit atomically. Recovery reuses the child/input IDs. `send`
uses a stable request key; `wait` uses an explicit input ID, never transcript-tail inference. Parent cleanup
marks child foreground tasks only and preserves queues.

Jobs are job-first: the durable job owns execution/output from the first effect. Tool and job sharing or
handoff of scratch/output must preserve one writer, bounded capture, cancellation join and terminal scratch
retirement. Arbitrary unfinished promise adoption is not a v1 feature. A non-adoptable interrupted process
is lost unless durable policy explicitly permits rerun. Recurring schedules use one task ID and phased
checkpoint; no backlog is inferred after downtime. Terminal notices are passive writes and work in either
notification-before-completion order.

### 14.4 System sections

Pico sends pi-ai `{messages}` only; top-level `systemPrompt` and `tools` are absent. A typed
`SystemSection<T>` has stable key and synchronous pure renderer. Preparation seeds one ordered draft from
durable payload/rendered state. Handlers run sequentially outer-to-inner and mutate get/set/delete/wrap;
failed skipped handler rolls back only its mutations. Missing contributors do not delete stored sections.

Baseline records contain complete ordered state; deltas contain set/remove changes. Canonical data folding
is independent of model heads/edits. Payload-only change may have `model:[]`. Tool definitions exist only in
SystemMessage fields; removals precede additions and same-name additions upsert. A fresh post-head baseline
atomically omits retained superseded managed entries. Preparation captures section/registry snapshots,
retries managed-state staleness, and commits system entry plus request cutoff atomically.

### 14.5 Hooks and external events

Hooks are the preferred extension point inside built-in operations. They run outside the line, receive and
forward Call, may run again after crash, and return typed decisions that the built-in commits. A hook may
start and await ordinary durable side work while the built-in retains exchange ownership. Approval/question
policy and durable answer reuse belong to workspace/plugins. Exact namespaced hook scratch access remains a
gated API decision.

A long-lived non-turn background listener injects external events through request-keyed `accept`/`write`.
It may await `waitForInput` when no self-progress cycle exists. It never mutates an already snapshotted
provider request; steering affects the next safe request boundary.

## 15. Watch and backend contracts

### 15.1 Watch

The ready watch foundation deliberately excludes previews and `task_output`; their source/API is gated.

```ts
interface WatchedValue { readonly address: Address; readonly value?: JsonValue }
interface ConversationView {
  readonly conversation: Conversation;
  readonly tail: number;
  readonly entries: readonly Entry[];
  readonly context: readonly Id[];
  readonly tasks: readonly Task[];
  readonly inbox: readonly Element<QueuedInput>[];
  readonly values: readonly WatchedValue[];
  readonly readAt: Seq;
}
interface SessionView {
  readonly conversations: readonly Conversation[];
  readonly values: readonly WatchedValue[];
  readonly readAt: Seq;
}
type InboxOp =
  | { readonly type: "append"; readonly item: Element<QueuedInput> }
  | { readonly type: "remove"; readonly id: Id }
  | { readonly type: "clear" };
type ConversationEvent =
  | { readonly type: "entry"; readonly entry: Entry }
  | { readonly type: "task_start"; readonly task: Task }
  | { readonly type: "task_update"; readonly task: Task; readonly previous: Task }
  | { readonly type: "task_end"; readonly task: Task & { readonly status: "terminal" } }
  | { readonly type: "value"; readonly value: WatchedValue }
  | { readonly type: "inbox"; readonly ops: readonly InboxOp[] }
  | { readonly type: "context"; readonly ids: readonly Id[] };
type SessionEvent =
  | { readonly type: "conversation"; readonly conversation: Conversation; readonly change: "created" }
  | { readonly type: "value"; readonly value: WatchedValue };
interface CommitEnvelope<E> {
  readonly first: Seq;
  readonly last: Seq;
  readonly events: readonly E[];
}
type WatchDelivery<E> =
  | { readonly type: "commit"; readonly commit: CommitEnvelope<E> }
  | { readonly type: "lag" }
  | { readonly type: "closed" };
interface WatchOptions {
  readonly capacity?: number;
  readonly onError?: (error: unknown) => void;
}
interface ConversationWatchOptions extends WatchOptions {
  readonly tail: number;
  readonly values?: readonly Address[];
}
interface SessionWatchOptions extends WatchOptions {
  readonly values?: readonly Address[];
}
interface WatchHandle<V, E> {
  readonly view: V;
  start(listener: (delivery: WatchDelivery<E>) => void): void;
  resnapshot(call: Call): Promise<V>;
  unsubscribe(): void;
}
declare function applyConversationCommit(
  view: ConversationView,
  commit: CommitEnvelope<ConversationEvent>,
): ConversationView;
declare function applySessionCommit(
  view: SessionView,
  commit: CommitEnvelope<SessionEvent>,
): SessionView;
interface WatchService {
  watchConversation(
    conversationId: Id,
    options: ConversationWatchOptions,
    call: Call,
  ): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watchSession(
    options: SessionWatchOptions,
    call: Call,
  ): Promise<WatchHandle<SessionView, SessionEvent>>;
}
```

`tail` is an integer from 0 through 10,000. A conversation capture contains its last `tail` logical
fork-visible entries, live tasks directly belonging to that conversation, current inbox and exactly the
requested values. Conversation watch values may be session addresses or addresses bound to that
conversation; foreign-conversation/task addresses reject. A session watch accepts session addresses only.
A later source-conversation write emits no event for an existing fork. The pure reducer uses `view.tail` to
retain only the newest logical transcript entries. A session capture contains all current conversations and
exactly its requested session values.

Capture and subscription registration occur in one line operation. Default capacity is 256 complete commit
envelopes; an explicit capacity must be a positive integer. `start` is synchronous and may be called once.
It delivers commits after the captured `readAt`, then live commits, in sequence order. The view is folded
through a whole envelope before its listener runs. Events from one commit are never split. Same-commit inbox append/remove cancels and emits no inbox event. A commit producing no events after this
subscription's filters is not delivered and consumes no buffer capacity, while the in-process
`handle.view.readAt` still advances. Emit a full `context` event whenever the derived context-ID array
changes, including ordinary entry appends.

When capacity would be exceeded, discard queued commit deliveries, emit one `lag` delivery, and pause that
subscription. The in-process `handle.view` continues folding every commit while delivery is paused, but the
consumer must not use it as a resumption barrier. `resnapshot` enters the line, captures a fresh view and
sequence barrier, discards deliveries
through that barrier, resumes after it, mutates `handle.view` to the new view before resolving, and returns
that same view. Calling it in response to a listener delivery does not run on the commit line and cannot
deadlock. `unsubscribe` is idempotent, discards buffered deliveries and prevents future callbacks. If a listener throws, unsubscribe only that watch and invoke `options.onError` outside the line when
provided; never fault the session. An error thrown by `onError` is ignored by Pico. Close emits `closed` once unless unsubscribed.

`task_start` is task creation at pending. Reservation is `task_update` to running. Checkpoint/abort/ownership
changes are task updates. Terminal is `task_end` and always includes an outcome. Reducers are kind-free and
pure. Conversation values are only the explicitly requested addresses; session values are explicitly
configured by the session watch caller in the final Harness API.

### 15.2 Backend construction and durability

```ts
interface MemoryStorageFactory { create(): Storage }
interface JsonlStorageFactory { open(path: string, call: Call): Promise<Storage> }
interface SqliteStorageFactory {
  open(path: string, options: { readonly session: string }, call: Call): Promise<Storage>;
}
```

JSONL/SQLite `open` acquires the cross-process session lock and finishes replay before returning. Storage
`claim` separately binds one driver to the returned object. `close` releases both and is idempotent. Memory
has no cross-process lock but enforces one claim.

Every JSONL main and live-scratch commit is fsynced before in-memory publication or commit resolution.
Creating the main file, a scratch file or a containing directory requires fsync of the created file and
each affected parent directory before publication. Scratch unlink need not be directory-durable because
the fsynced terminal main record is authoritative. No weaker durability mode exists in v1.

JSONL uses one main file and one file per live task scope, all sharing the sequence. Each newline-terminated
record is:

```ts
interface JsonlRecord {
  readonly first: Seq;
  readonly last: Seq;
  readonly batch: CommitBatch;
}
```

`last - first + 1` equals `batch.writes.length`; each create/element ID matches its derived sequence.
Replay main first, then scratch only for surviving live tasks. Retired scratch is ignored even if malformed.
Retained ranges increase within each file and never overlap across retained files; gaps are valid. Validate
batch kind against file, scratch task/address references, object IDs and lifecycle/scope structure.
`lastSeq` is the maximum complete retained endpoint including clear/remove.

A torn suffix is bytes after the final newline. Truncate those bytes and fsync before append. A
newline-terminated record that is malformed JSON or structurally invalid fails open. Persist and fsync the
record before applying it to memory.

SQLite uses indexed conversations, full immutable entry facets, current tasks, values plus rewindable
versions, list elements/clear markers, scratch and commit boundaries. Index task status/abort/conversation/
kind and entry conversation/head/kind/key. Terminal transaction deletes scratch rows atomically. Reopen
loads live tasks and named owner records, not terminal history into residency. Version mismatch rejects.
Use durable SQLite transactions with `PRAGMA synchronous=FULL` or an explicitly documented equivalent at
least as strong. Journal mode is backend-private if locking, atomic scratch retirement and conformance hold.
There is no migration API until the gated migration package is specified.

## 16. Complete foundation race matrix

Every race is tested in both orders with fake clocks/effects and storage barriers:

- Persistence paused after construction: readers see old complete state.
- Commit callback throws: no writes and no IDs consumed.
- Accept durable but reply lost: request-key retry and lookup return the original receipt.
- Duplicate request key in one transaction: first receipt wins without payload comparison.
- Main plus scratch in one batch: reject all.
- Effect returns versus abort mark: one invocation; fresh abort only after old return.
- Post-mark main/scratch builder: reject before callback.
- Normal closure versus mark/close/fault: commit before mark wins; otherwise closure is not invoked.
- Closure throws: no closure writes/outcome; session faults.
- Terminal persistence uncertain: fail-stop; closure not retried on handle.
- Pending task marked before reservation: execute never runs; fresh abort does.
- Repeated abort mark while abort runs: abort Call remains active.
- Close versus commit: admitted earlier commit finishes; later mutation rejects; completion messages admitted.
- Shutdown versus accept: accept commits before mark batch or rejects; queues preserved.
- Shutdown crash before child cleanup: reopen abort marks child tasks only and preserves queues.
- Broken abort handler: drives/shutdown reject; invocations join; session closes with task durable.
- Two overlapping drives: one invocation per task.
- Cancelled drive/task/input waiter: only that waiter/listener/temporary serving reference is removed.
- Dependency terminal versus dependent reservation: dependent starts once.
- Direct/dependency/input self-waits: reject before durable deadlock.
- Solitary background collapse plus listener accept: input queues, collapse terminal triggers idle boundary.
- Collapse concurrent with generation plus listener accept: collapse terminal does not drain; generation boundary does.
- Collapse abort with queued input: no successor; queue remains for later idle accept.
- Queued head versus newer head: placement writes unanswered/stale, not session fault.
- Parallel tool completion either order: post_tools starts once and projects call order.
- Abort versus post_tools closure: no unmarked successor and every active input resolves once.
- Withdraw versus place input: one terminal result.
- Several inputs in one group: all done results name the same answer.
- Overflow chain: collapse and replacement atomic; no invocation waits on collapse.
- Competing summary head: stale failure; intervening edits do not stale.
- Watch capture versus commit: base includes commit or stream delivers it, never gap/duplicate.
- JSONL main 100/live scratch 150: reopen lastSeq 150.
- Terminal 151/unlink failure: ignore scratch even malformed; lastSeq 151.
- JSONL torn final suffix versus malformed complete line: truncate only former.
- 100,000 terminal children/two live tasks: open reads live seed and required ancestry only.
- Missing owner kind with registered descendants: owner orphaned and scratch retired; descendants marked,
  queues retained, root drive later runs their fresh abort.
- Capability replacement with live mismatch: reject before invocation.
- Cast non-turn runtime to turn and direct append: reject, no writes.

## 17. Ready implementation packages

Every package is a separate commit. Before each commit run its focused test and `npm run check`; do not run
the full credential-sensitive suite. Each package may use an internal kernel with supplied test kinds and
memory storage; it need not expose incomplete production Harness behavior.

### WP1 — Core types and kind witnesses

Prerequisites: none.

Deliver:
- strict JSON, ID, entry, conversation, task/checkpoint/outcome and address types;
- `EntryKind`, `TaskKind`, payload extractors and literal turn capability;
- capability-selected runtime/closure declaration types, with method bodies deferred;
- no imports from existing harness implementation.

Accept:
- compile tests for exact task input, full checkpoint with phase, kind-specific outcomes and literal turn
  runtime/terminal/abort surfaces;
- non-turn has no direct entry; turn does; turn abort does;
- incompatible checkpoint shape rejects; structurally identical shape is documented assignable;
- Pico declarations introduce and explicitly spell no `any`; imported pi-ai types are exempt;
- compile-only focused test and repository check green.

### WP2 — Mutation algebra and MemoryStorage

Prerequisites: WP1.

Deliver:
- exact main/scratch mutations and storage interface;
- immutable snapshotting;
- sequence allocation/validation, atomic memory commit and empty-batch behavior;
- conversations, entries, task lifecycle/checkpoint/ownership/abort/terminal retirement;
- current and rewindable values/lists including tombstones/clear/remove;
- fork-aware pages, newest head, task scans and all cursor/filter ordering.

Accept:
- hand-built batch conformance for every query and mutation;
- rejected batch leaves state/lastSeq unchanged;
- terminal mutation makes scratch unreadable atomically;
- fork/history/deep-cap tests; committed reads return no mutable aliases;
- focused test and repository check green.

### WP3 — Commit line and raw transaction kernel

Prerequisites: WP2.

Deliver:
- FIFO async line;
- transaction overlay, synchronous buffered writes, async committed reads;
- ID minting/rollback; rewindable-before-entry rule;
- base/turn/abort transaction capability construction and runtime validation;
- protected namespace/kind checks;
- no public accept/write/runtime handles yet.

Accept:
- concurrent commits serialize; async read holds line;
- callback failure consumes no ID;
- same-batch references validate from overlay;
- non-turn cast direct entry rejects; data-only record works;
- managed/protected generic writes reject;
- runtime strict-JSON validation rejects invalid entry/task/state payloads before persistence, including
  payloads carried by imported pi-ai types;
- no callback/signal dispatch on line.

### WP4 — Entries, context and forks

Prerequisites: WP3.

Deliver:
- typed entry builders and built-in entry witnesses;
- direct append structural validation, head/self/edit/exchange rules;
- exact fork-aware context derivation and disposable cache/snapshot rules;
- missing-result and call-order normalization adapter boundary using faux messages.

Accept:
- facet combinations, unknown kinds, heads monotonic and exchange-safe;
- summary-under-running-turn trace; repeated heads; edit winner/no-op/protected targets;
- arbitrary fork cutoff and incomplete exchange repair without tasks;
- error/aborted assistant exclusion; immutable request snapshot.

### WP5 — Input/admission kernel

Prerequisites: WP4.

Deliver:
- queued/input-result/acceptance schemas and protected addresses;
- async in-transaction accept/queue/write with request-key overlay dedupe;
- safe enqueue and placement revalidation;
- post-tools/final/idle boundary transaction helpers;
- pure prospective last-turn idle-boundary planner, without provider execution or a public factory API.

Accept:
- complete mode table; idle same-batch append/remove; duplicate keys including same batch;
- create conversation + accept through the private generation strategy + parent checkpoint atomically;
- solitary and concurrent collapse traces;
- stale queued head terminal result; no fault;
- queued ownership never inferred from arbitrary checkpoints.

### WP6 — Terminal-closure task kernel and scratch

Prerequisites: WP5.

Deliver:
- pending creation and durable running reservation;
- capability-specific execute/recover runtime and normal terminal closures;
- invocation identity/slot; atomic completed/failed outcome plus scratch retirement;
- scratch transactions and normal closure seal/disposition behavior;
- focused driver fixtures using typed test kinds and explicit task serving.

Accept:
- running intent precedes effect; reopen chooses recover including no checkpoint;
- repeated recovery from newer checkpoint under stable ID;
- one closure outcome, same-batch minted result ID, throwing closure rollback/fault;
- normal closure commits exactly once when still authorized; WP8 adds mark/close/fault discard races;
- scratch crash retention/terminal retirement/post-retirement rejection.

### WP7 — Dependencies, serving and waits

Prerequisites: WP6.

Deliver:
- live/dependency/conversation/ownership indexes;
- stable conversation/session attachment and temporary drive/task/input waiters;
- foreground idle and background continued serving;
- self/dependency/input-cycle checks and temporary target serving.

Accept:
- dependencies mean terminal and wake once;
- distinct task IDs concurrent, same ID one invocation;
- repeated/cancelled drives retain one attachment and no waiter leak;
- terminal-owner descendants served without history traversal;
- waitForInput result/missing/terminal-fast-path/caller-cancel and safe non-turn self-conversation case;
- close/fault/shutdown waiter behavior is tested in WP8.

### WP8 — Cancellation and lifecycle

Prerequisites: WP7.

Deliver:
- mark/revoke/signal/join/fresh-abort sequence and abort runtime construction;
- restricted repeated abort commits, turn abort closure, and mark/close/fault normal-closure discard;
- conversation abort operation, completion wait and queue policy;
- close, shutdown and fault phase machines with shared repeated completions;
- driver initialization that claims storage, loads live tasks/required ancestry, captures the task registry,
  and performs missing-kind orphan reconciliation; any loading/validation/reconciliation failure closes and
  releases storage before rejecting.

Accept:
- every cancellation/lifecycle row in section 16 applicable to memory;
- fresh abort checkpoint/reopen; repeated mark does not cancel abort;
- passive abort writes but no future work; tool-like direct abort result for turn kind;
- close writes no outcomes; shutdown marks all and preserves queues; fault preserves unfinished state;
- initialization starts nothing; every missing live kind orphans, retires scratch and marks descendants;
- failed reconciliation yields no usable driver; no history scan beyond live seed/required ancestry.

### WP9 — Watch foundation

Prerequisites: WP8.

Deliver the kind-free commit-derived view/event reducer, atomic capture/subscription, bounded lag and
resnapshot. Preview and task-output delivery are excluded until their gated API is settled.

Accept the watch races and task lifecycle event meanings in sections 15–16.

### WP10 — JSONL backend

Prerequisites: WP8; WP9 only for cross-backend watch tests.

Deliver the backend and all recovery rules in section 15. Run the same storage/admission/task conformance
stream as memory, including real process-kill recovery for running/checkpoint/scratch/terminal cases.

### WP11 — SQLite backend

Prerequisites: WP8; WP9 only for cross-backend watch tests.

Deliver indexed persistence/residency and conformance in section 15. Update the session-backend package only
through a reviewed adapter boundary; no import from existing harness runtime/session implementations.

## 18. Gated packages and explicit decisions

Do not implement these until their listed decision is settled and appended to this specification:

- **Harness open/public handles/core registries:** wire the single final `Harness` only when the required
  built-in kinds are implemented. It owns root/rootValues, public mutable registries, core replacements and
  the production generation-admission strategy. There is no temporary foundation harness.
- **Provider generation/system integration:** verify landed pi-ai messages-only behavior and define complete
  generation input/checkpoint/result/failure/abort schemas, retry/usage dedupe and deferred recovery table.
- **Tool/post_tools/output/preview:** define one coherent author API, tool/job scratch-output sharing,
  bounded/spill operations and preview reconstruction. Job-first only; no arbitrary promise adoption.
- **Hooks:** define task identity and namespaced scratch capability, then confirm hook points/typed decisions.
- **Collapse provider implementation:** define summarizer request/checkpoint/result schemas and retry budgets;
  the context/head/chain foundation above is ready.
- **Jobs/subagents:** define exact job and child task payload schemas plus terminal notification protocol on
  the settled output API; ownership/admission/wait foundation above is ready.
- **Typed system sections:** define the concrete draft/persistence API and preparation staleness retry code
  after pi-ai verification; section 14.4 fixes required semantics.
- **Full preview/client integration:** settle tracker/sink API; delivery coalescing remains deferred.
- **Conversation deletion, runtime schema bundle, renderer registry/layouts and migration:** later milestones,
  not foundation. Root deletion is always forbidden; descendant/fork-reference deletion policy must be
  specified before adding a delete API.

## 19. Repository and process rules

Implementation location: `packages/agent/src/harness/pico/`. Do not import from
`packages/agent/src/harness/runtime`, `packages/agent/src/harness/session`, `agent-harness.ts`, Pico, Pico2
or DOM. Read reusable leaf implementations before copying, then own the copy under Pico. Allowed package
boundaries include Chord and pi-ai.

Use erasable TypeScript syntax. Pico declarations must not introduce or explicitly spell `any`; imported
pi-ai declarations are exempt and their durable values receive strict-JSON boundary validation. Check
external API types in `node_modules`; do not guess. Test
with package-specific Vitest commands and `npm run check`; never run the credential-sensitive full suite.
Commit only files changed by the current work package, using explicit paths. One reviewed commit per work
package; do not begin the next until the user has reviewed the previous commit.
