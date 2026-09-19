# Pico v1 implementation specification

This file is the sole normative implementation specification for the clean-room Pico harness under
`packages/agent/src/harness/pico/`. Other Pico documents and prototypes are historical inputs and test
inspiration only. An implementer must not need them to implement the work packages
marked ready here.

The specification intentionally gates provider, built-in tool schemas, hook-scratch and renderer/client
integration where their APIs are not settled. Task output is part of the ready foundation; there is no
separate preview subsystem. A gated package must not be implemented by guessing. The storage,
entry/context, task, transaction, admission, scheduling, recovery and cancellation foundation is fully
specified here.

## 1. Required behavior

Pico stores sessions containing conversations, immutable transcript entries, durable tasks and scoped
state. One process owns a session at a time. A writable Harness owns one scheduler for the whole Session.
Once resumed, it considers eligible tasks in every conversation; foreground and background task effects both
run concurrently. Foreground affects idle and ordinary cancellation reach, never execution eligibility.
Every mutation and scheduler decision serializes on one commit line. Each conversation has at most one
active turn graph: the live tasks among the fixed `pi.generation`, `pi.tool` and `pi.post_tools` kinds. Other
tasks still run concurrently but never participate in that graph or block input admission.

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
lease, effect gate, per-conversation scheduler, stable or temporary serving attachment, public drive method,
replaceable core task kinds, public custom-turn task capability, kernel-interpreted global author lifecycle
graph, `patch`, `settle`, status epoch, workflow replay, generator DSL, one-plan-at-end restriction or
specialized core verbs such as `startShell`.
The optional per-kind state-indexed authoring adapter in section 5 is explicitly allowed; it compiles to an
ordinary `TaskKind` and changes no kernel lifecycle or scheduler behavior.

## 2. Core data and identifiers

All durable application payloads are strict JSON.

```ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
interface JsonObject { readonly [key: string]: JsonValue }

type Id = number;
type Seq = number;
```

`Id` and `Seq` are distinct positive safe-integer domains. IDs are stable committed-object identity. Storage
synchronously mints process-local ascending IDs through `nextId()` while the Session FIFO line is held;
conversation, entry, task and list-append builders immediately carry the returned ID in their canonical
write. A callback or validation failure discards its writes but burns those IDs in the current open binding.
They become valid object identities only if the containing commit succeeds. Reopen derives the allocator
high-water from committed creation/list-append writes, so it may reuse IDs that were minted but never
committed by an earlier process; committed IDs are never reused. `commit` receives no separate allocator
value. IDs may be used for same-batch references before commit, but must not escape a failed callback.

`Seq` is storage-assigned write order. Storage assigns one ascending sequence to each committed write and
returns the sequences in write order. Sequences order all main, scratch and shared writes but are not object
IDs; a creation's ID never has to equal its sequence.

Local transaction and Storage APIs accept trusted typed values without defensive cloning or redundant
strict-JSON decoding. Durable values are readonly by contract; callers must not mutate values after passing
them to Pico. External wire/plugin boundaries validate before entering this layer.

Use Chord's `Context` directly:

```ts
import type { Context } from "@earendil-works/chord";
```

Every asynchronous public, runtime, storage-adapter, provider, environment, hook and wait operation takes
a required final `ctx: Context`. Synchronous transaction builder methods take no context.

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

type EntryBase = EntryIdentity;
interface EntryData<D extends JsonValue = JsonValue> { readonly data: D }
interface ModelProjection<M extends Message = Message> { readonly model: readonly M[] }
interface ContextHead { readonly head: Id }
interface ContextEdits { readonly edits: readonly ContextEdit[] }

type Entry = EntryBase & Partial<EntryData & ModelProjection & ContextHead & ContextEdits>;

type EntryInput<E extends Entry> =
  Omit<E, keyof EntryIdentity | "head"> &
  (E extends ContextHead ? { readonly head: Id | "self" } : { readonly head?: never });

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
type SummaryEntry = EntryBase & EntryData<{ readonly through: Id }> &
  { readonly model: readonly [UserMessage] } & ContextHead;
type HandoffEntry = EntryBase & { readonly model: readonly [UserMessage] } & ContextHead;
type ResetEntry = EntryBase & ContextHead;
```

Each user, assistant, tool-result, notice, summary and handoff entry contains exactly one corresponding
message. Reset has no model. `pi.system` is reserved but has no ready typed model witness. Stored entry-kind
names remain directly scannable from materialized entry facets; backends may index them so open need not
decode payload history.

### 3.2 Direct append validation

A direct append validates against committed state plus the builder's narrow pending-reference indexes:

- The conversation exists, including one created earlier in the batch.
- `head: "self"` becomes the Storage-minted entry ID.
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
- A successful assistant's tool-call IDs are unique. A tool-result entry's single message names one visible
  call ID/name, has one result at most for that call, and belongs to the same conversation.
  Fixed core task implementations remain responsible for creating the right tasks and input ownership.

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
  | { readonly type: "task"; readonly taskId: Id }
  | { readonly type: "shared"; readonly id: Id };

declare const addressType: unique symbol;

interface Address<T extends JsonValue = JsonValue> {
  readonly scope: Scope;
  readonly namespace: string;
  readonly key?: string;
  readonly kind: "value" | "list";
  readonly rewind: boolean;
  readonly [addressType]?: T;
}

interface Value<T extends JsonValue> extends Address<T> { readonly kind: "value" }
interface List<T extends JsonValue> extends Address<T> { readonly kind: "list" }
interface Element<T extends JsonValue> { readonly id: Id; readonly value: T }

type StickyOptions = { readonly key?: string; readonly rewind?: false };
type ConversationOptions = { readonly key?: string; readonly rewind: boolean };
declare function defineValue<T extends JsonValue>(
  scope: Extract<Scope, { type: "session" | "task" | "shared" }>, namespace: string,
  options?: StickyOptions,
): Value<T>;
declare function defineValue<T extends JsonValue>(
  scope: Extract<Scope, { type: "conversation" }>, namespace: string,
  options: ConversationOptions,
): Value<T>;
declare function defineList<T extends JsonValue>(
  scope: Extract<Scope, { type: "session" | "task" | "shared" }>, namespace: string,
  options?: StickyOptions,
): List<T>;
declare function defineList<T extends JsonValue>(
  scope: Extract<Scope, { type: "conversation" }>, namespace: string,
  options: ConversationOptions,
): List<T>;
```

Addresses are fully bound. Session constructors require no ID; conversation constructors require a
conversation ID; task-scratch constructors require a task ID; shared constructors require a shared-scope
ID. Handles validate the bound ID and never silently replace it. Session, task and shared addresses are
non-rewindable; conversation addresses explicitly select `rewind:true` or `false`. Task scope is private
scratch retired with that task. Shared scope is capability-referenced and retires when a committed batch
leaves no live task reference. Ready packages compare addresses structurally by the tuple
`[scope type, scope id or null, kind, rewind, namespace, key or null]`. `key` participates in address identity
by selecting an optional member of a keyed family. Only property presence is non-identity: omitted `key` and
`key:undefined` are the same unkeyed singleton, while the empty string is a distinct key. Backends represent
the unkeyed slot directly, for example with a null sentinel. String wire encoding is deferred to client integration.

Values use complete replacement and deletion. Lists use intrinsic append/remove/clear operations. For a
rewindable value, deletion records durable absence. For a rewindable list, remove and clear hide elements
only at and after their own write sequence, preserving earlier historical reads. Sticky state exposes current
contents; a backend may physically discard removed sticky elements.

Historical `at` is an entry ID. Storage resolves it to that entry's creation sequence. Rewindable
conversation lookup chooses the newest local write at or before that sequence. If none exists and the
conversation has a parent, recurse into the parent capped at the earlier of the requested entry position and
`parent.at`. Lists combine inherited and local operations under the same caps. Scratch and sticky historical
reads reject. Forks inherit no scratch and inherit sticky conversation state only through an explicit copy
policy at creation.

A rewindable conversation `getValue(..., at)` or `readList(..., at)` requires `at` to be a fork-visible entry
of that address's conversation; an unrelated/missing position rejects `InvalidHistoryPosition`. `undefined`
selects current state.

Within one main transaction, every rewindable conversation value/list write must precede every entry
append. This makes state in the same `Write[]` visible at a fork through that entry while excluding later
state. Sticky/session state and task writes may occur anywhere. A violating builder throws and the
whole transaction rolls back.

Namespaces beginning `pi.` are protected. Public/plugin constructors reject them unless created with an
internal built-in authority. Managed system records and input/result/receipt state cannot be written via generic entry, value or list
handles.

Ready generic transactions reject shared addresses; the protected central task-output writer is their only
mutation authority. Host transactions may use any nonprotected session/conversation address. Normal and
abort task transactions may use session addresses and conversation addresses in the current task's conversation/owned subtree. A task
address is accepted only by that same task's `scratch` API; it is rejected by main transactions and by
another task. `TaskConversation.value/list` accepts session addresses and addresses bound to that handle's
conversation, and rejects every other conversation/task address.

## 5. Task records and kinds

```ts
interface TaskCheckpoint extends JsonObject { readonly phase: string }
type NoCheckpoint = never;

declare const taskOutputType: unique symbol; // compile-only; durable identity is `kind`
interface TaskOutputKind<O extends object> {
  readonly kind: string;
  readonly [taskOutputType]?: O;
}
declare function defineTaskOutput<O extends object>(kind: string): TaskOutputKind<O>;
interface TaskOutputSpec<I extends JsonValue, O extends object> {
  readonly kind: TaskOutputKind<O>;
  initial(input: I): O;
}
interface StoredTaskOutputRef { readonly id: Id; readonly kind: string }
interface TaskOutputRef<O extends object> extends StoredTaskOutputRef {
  readonly [taskOutputType]?: O;
}
type TaskOutputField<O extends object> = [O] extends [never]
  ? unknown
  : { readonly output: TaskOutputRef<O> };
type TaskOutputDefinition<I extends JsonValue, O extends object> = [O] extends [never]
  ? { readonly output?: never }
  : { readonly output: TaskOutputSpec<I, O> };

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
  readonly owns: readonly Id[];
  readonly output?: StoredTaskOutputRef;
  readonly abort?: true;
}

type Task<I extends JsonValue = JsonValue, C extends TaskCheckpoint = TaskCheckpoint,
          R extends JsonValue = JsonValue, F extends JsonValue = JsonValue,
          A extends JsonValue = JsonValue> = TaskBase<I, C> & (
  | { readonly status: "pending" | "running"; readonly outcome?: never }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R, F, A> }
);

type RunningTask<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> =
  Omit<TaskBase<I, C>, "output"> & TaskOutputField<O> &
  { readonly status: "running"; readonly outcome?: never };

type Completion<R extends JsonValue, F extends JsonValue> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly failure: F };
```

Kind, conversation, input, dependencies, background and output reference are immutable after creation. A
checkpoint is optional; each checkpoint update constructs a full `task.set` snapshot containing the complete
checkpoint. Its `phase` is a kind-defined tag that the generic scheduler never interprets. Result, failure and
abort payloads are kind-specific strict JSON. Structurally identical checkpoint types are intentionally
assignable in TypeScript; kind attribution is supplied by the current runtime, not a nominal durable brand.
Differently shaped checkpoints, partial checkpoints and another kind's incompatible shape reject.

A task kind has five durable payload types and a sixth task-output state type (`never` means no output).
Output state is a mutable object/array accepted by Chord `track`. `TaskOutputKind` contains only durable
string identity plus a compile-only output witness. `TaskOutputSpec.initial(input)` is synchronous and pure.
It runs only when task creation omits a shared ref; its returned object is transferred to the tracker and
must not be retained or mutated by the author. Its base commits atomically with task creation, and it never
runs when sharing.

Ordinary extension tasks and Pico's fixed privileged core tasks use separate authoring factories. The
separate brands make their tokens non-interchangeable. `defineTask` is public. `defineCoreTask` is an internal
Pico authoring helper and is not a plugin extension point.

```ts
declare const taskKindBrand: unique symbol;
interface TaskKindBase {
  readonly kind: string;
  readonly [taskKindBrand]: "ordinary";
}
interface CoreTaskKindBase {
  readonly kind: string;
  readonly [taskKindBrand]: "core";
}

interface TaskKindMethods<I extends JsonValue, C extends TaskCheckpoint,
                          R extends JsonValue, F extends JsonValue, A extends JsonValue,
                          O extends object> extends TaskKindBase {
  execute(task: RunningTask<I, C, O>, runtime: TaskRuntime<I, C, O>, ctx: Context):
    Promise<TerminalClosure<I, C, R, F, O>>;
  recover(task: RunningTask<I, C, O>, runtime: TaskRuntime<I, C, O>, ctx: Context):
    Promise<TerminalClosure<I, C, R, F, O>>;
  abort(task: RunningTask<I, C, O>, runtime: AbortTaskRuntime<I, C, O>, ctx: Context):
    Promise<AbortClosure<I, C, A, O>>;
}
interface CoreTaskKindMethods<I extends JsonValue, C extends TaskCheckpoint,
                              R extends JsonValue, F extends JsonValue, A extends JsonValue,
                              O extends object> extends CoreTaskKindBase {
  execute(task: RunningTask<I, C, O>, runtime: CoreTaskRuntime<I, C, O>, ctx: Context):
    Promise<CoreTerminalClosure<I, C, R, F, O>>;
  recover(task: RunningTask<I, C, O>, runtime: CoreTaskRuntime<I, C, O>, ctx: Context):
    Promise<CoreTerminalClosure<I, C, R, F, O>>;
  abort(task: RunningTask<I, C, O>, runtime: CoreAbortTaskRuntime<I, C, O>, ctx: Context):
    Promise<CoreAbortClosure<I, C, A, O>>;
}
type TaskKind<I extends JsonValue, C extends TaskCheckpoint,
              R extends JsonValue, F extends JsonValue, A extends JsonValue,
              O extends object = never> =
  TaskKindMethods<I, C, R, F, A, O> & TaskOutputDefinition<I, O>;
type CoreTaskKind<I extends JsonValue, C extends TaskCheckpoint,
                  R extends JsonValue, F extends JsonValue, A extends JsonValue,
                  O extends object = never> =
  CoreTaskKindMethods<I, C, R, F, A, O> & TaskOutputDefinition<I, O>;

type NoExtra<Expected, Actual extends Expected> =
  Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;
type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> =
  Expected extends readonly JsonValue[] ? Actual :
  Expected extends JsonObject
    ? Actual & Record<Exclude<keyof Actual, keyof Expected>, never>
    : Actual;

type KindDefinition<K> = Omit<K, typeof taskKindBrand>;
type KindFactory<K> =
  <D extends KindDefinition<K>>(definition: NoExtra<KindDefinition<K>, D>) => D & K;

type TaskKindFactory<I extends JsonValue, C extends TaskCheckpoint,
                     R extends JsonValue, F extends JsonValue, A extends JsonValue,
                     O extends object> =
  KindFactory<TaskKind<I, C, R, F, A, O>>;
type CoreTaskKindFactory<I extends JsonValue, C extends TaskCheckpoint,
                         R extends JsonValue, F extends JsonValue, A extends JsonValue,
                         O extends object> =
  KindFactory<CoreTaskKind<I, C, R, F, A, O>>;

declare function defineTask<I extends JsonValue, C extends TaskCheckpoint,
                            R extends JsonValue, F extends JsonValue,
                            A extends JsonValue, O extends object = never>():
  TaskKindFactory<I, C, R, F, A, O>;
declare function defineCoreTask<I extends JsonValue, C extends TaskCheckpoint,
                                R extends JsonValue, F extends JsonValue,
                                A extends JsonValue, O extends object = never>():
  CoreTaskKindFactory<I, C, R, F, A, O>;
```

The factories preserve all payloads and output inference. `tx.task`, checkpoint methods and closures infer
from the token. `NoExtra` is also applied to the actual inferred task spec type, so visible extra top-level
fields in literals, variables and spreads reject. Deep structural exactness, casts and erased fields remain
normal TypeScript limits. Wire/plugin RPC boundaries validate strict JSON and optional schemas before calling
trusted local APIs.

The fixed `pi.generation`, `pi.tool`, `pi.post_tools` and `pi.collapse` definitions use `defineCoreTask`.
`pi.job` uses ordinary `defineTask` unless a later concrete requirement proves it needs a narrow privileged
surface. Core definitions are installed internally and cannot be registered, replaced or removed. Ordinary
plugin definitions cannot use a protected `pi.*` name and never receive transcript/admission authority.
Generation, tool and post_tools are the fixed turn-task set; collapse has core transcript authority but is
not a turn task. The kernel identifies these roles only by their fixed registered slots/names and never
interprets their payload or checkpoint schemas.

### 5.1 Optional state-indexed task authoring

`defineStateTask` is an optional authoring adapter for kinds with several durable recovery phases. It
returns an ordinary `TaskKind`; `defineTask` remains available for simple ordinary kinds. Core kinds use the
separate internal `defineCoreTask` factory rather than this adapter in v1. The adapter makes one kind's
checkpoint dispatch exhaustive without adding author phases to stored `Task.status` or to the scheduler.

```ts
type PhaseOf<C extends TaskCheckpoint> = C["phase"];
type CheckpointAt<C extends TaskCheckpoint, P extends PhaseOf<C>> =
  Extract<C, { readonly phase: P }>;
type PhasePayload<C extends TaskCheckpoint, P extends PhaseOf<C>> =
  Omit<CheckpointAt<C, P>, "phase">;

type PhaseTask<I extends JsonValue, C extends TaskCheckpoint,
               O extends object, P extends PhaseOf<C>> =
  Omit<RunningTask<I, C, O>, "checkpoint"> & {
    readonly checkpoint: CheckpointAt<C, P>;
  };

type InitialTask<I extends JsonValue, C extends TaskCheckpoint, O extends object> =
  Omit<RunningTask<I, C, O>, "checkpoint"> & {
    readonly checkpoint?: never;
  };

type StateTransitionTx<C extends TaskCheckpoint> =
  Omit<BaseTaskTx<C>, "checkpoint">;
type StatePhaseTx<C extends TaskCheckpoint, P extends PhaseOf<C>> =
  StateTransitionTx<C> & {
    checkpoint(value: CheckpointAt<C, P>): void;
  };
type InitialStateRuntime<I extends JsonValue, C extends TaskCheckpoint,
                         O extends object> =
  Omit<TaskRuntime<I, C, O>, "commit">;
type StateRuntimeFor<I extends JsonValue, C extends TaskCheckpoint,
                     O extends object, P extends PhaseOf<C>> =
  Omit<TaskRuntime<I, C, O>, "commit"> & {
    commit<V>(
      build: (tx: StatePhaseTx<C, P>, current: PhaseTask<I, C, O, P>) => V | Promise<V>,
      ctx: Context,
    ): Promise<V>;
  };

interface PhaseTransition<I extends JsonValue, C extends TaskCheckpoint,
                          O extends object, P extends PhaseOf<C>> {
  readonly type: "transition";
  readonly phase: P;
  readonly commit: (
    tx: StateTransitionTx<C>,
    current: RunningTask<I, C, O>,
  ) => PhasePayload<C, P> | Promise<PhasePayload<C, P>>;
}
interface StateTerminal<I extends JsonValue, C extends TaskCheckpoint,
                        R extends JsonValue, F extends JsonValue,
                        O extends object> {
  readonly type: "terminal";
  readonly closure: TerminalClosure<I, C, R, F, O>;
}
type StateResult<I extends JsonValue, C extends TaskCheckpoint,
                 R extends JsonValue, F extends JsonValue,
                 O extends object> =
  | PhaseTransition<I, C, O, PhaseOf<C>>
  | StateTerminal<I, C, R, F, O>;

type ExactPhasePayload<C extends TaskCheckpoint, P extends PhaseOf<C>,
                       Actual extends PhasePayload<C, P>> =
  NoExtra<PhasePayload<C, P>, Actual>;
interface StateActions<I extends JsonValue, C extends TaskCheckpoint,
                       R extends JsonValue, F extends JsonValue,
                       O extends object> {
  transition<P extends PhaseOf<C>, Actual extends PhasePayload<C, P>>(
    phase: P,
    commit: (
      tx: StateTransitionTx<C>,
      current: RunningTask<I, C, O>,
    ) => ExactPhasePayload<C, P, Actual> | Promise<ExactPhasePayload<C, P, Actual>>,
  ): PhaseTransition<I, C, O, P>;
  terminal(
    closure: TerminalClosure<I, C, R, F, O>,
  ): StateTerminal<I, C, R, F, O>;
}

type PhaseHandler<I extends JsonValue, C extends TaskCheckpoint,
                  R extends JsonValue, F extends JsonValue,
                  O extends object, P extends PhaseOf<C>> =
  | {
      readonly role: "start";
      readonly recover?: never;
      run(
        task: PhaseTask<I, C, O, P>,
        runtime: StateRuntimeFor<I, C, O, P>,
        actions: StateActions<I, C, R, F, O>,
        ctx: Context,
      ): Promise<StateResult<I, C, R, F, O>>;
    }
  | {
      readonly role: "inflight";
      run(
        task: PhaseTask<I, C, O, P>,
        runtime: StateRuntimeFor<I, C, O, P>,
        actions: StateActions<I, C, R, F, O>,
        ctx: Context,
      ): Promise<StateResult<I, C, R, F, O>>;
      recover(
        task: PhaseTask<I, C, O, P>,
        runtime: StateRuntimeFor<I, C, O, P>,
        actions: StateActions<I, C, R, F, O>,
        ctx: Context,
      ): Promise<StateResult<I, C, R, F, O>>;
    };

type PhaseMap<I extends JsonValue, C extends TaskCheckpoint,
              R extends JsonValue, F extends JsonValue,
              O extends object> = {
  readonly [P in PhaseOf<C>]: PhaseHandler<I, C, R, F, O, P>;
};
type ExactPhaseHandler<Expected, Actual extends Expected> =
  Actual extends { readonly role: infer Role }
    ? Actual extends Extract<Expected, { readonly role: Role }>
      ? NoExtra<Extract<Expected, { readonly role: Role }>, Actual>
      : never
    : never;
type ExactPhaseMap<Expected, Actual extends Expected> =
  Actual & Record<Exclude<keyof Actual, keyof Expected>, never> & {
    readonly [P in keyof Expected]: ExactPhaseHandler<Expected[P], Actual[P]>;
  };
type LiteralCheckpoint<C extends TaskCheckpoint> =
  string extends PhaseOf<C> ? never : C;

type StateTaskDefinition<I extends JsonValue, C extends TaskCheckpoint,
                         R extends JsonValue, F extends JsonValue,
                         A extends JsonValue, O extends object> = {
  readonly kind: string;
  readonly initial: {
    readonly role: "start";
    run(
      task: InitialTask<I, C, O>,
      runtime: InitialStateRuntime<I, C, O>,
      actions: StateActions<I, C, R, F, O>,
      ctx: Context,
    ): Promise<StateResult<I, C, R, F, O>>;
  };
  readonly phases: PhaseMap<I, C, R, F, O>;
  abort(
    task: RunningTask<I, C, O>,
    runtime: AbortTaskRuntime<I, C, O>,
    ctx: Context,
  ): Promise<AbortClosure<I, C, A, O>>;
} & TaskOutputDefinition<I, O>;

type ExactStateTaskDefinition<Expected, Actual extends Expected> =
  NoExtra<Expected, Actual> & {
    readonly phases: ExactPhaseMap<Expected extends { readonly phases: infer P } ? P : never,
                                   Actual extends { readonly phases: infer P } ? P : never>;
  };

interface StateTaskFactory<I extends JsonValue, C extends TaskCheckpoint,
                           R extends JsonValue, F extends JsonValue,
                           A extends JsonValue, O extends object> {
  <D extends StateTaskDefinition<I, C, R, F, A, O>>(
    definition: [LiteralCheckpoint<C>] extends [never]
      ? never
      : ExactStateTaskDefinition<StateTaskDefinition<I, C, R, F, A, O>, D>,
  ): D & TaskKind<I, C, R, F, A, O>;
}

declare const commitStateTransition: unique symbol;
interface StateAdapterRuntime<I extends JsonValue, C extends TaskCheckpoint,
                              O extends object> {
  [commitStateTransition]<P extends PhaseOf<C>>(
    expectedSource: PhaseOf<C> | undefined,
    phase: P,
    build: (
      tx: StateTransitionTx<C>,
      current: RunningTask<I, C, O>,
    ) => PhasePayload<C, P> | Promise<PhasePayload<C, P>>,
    ctx: Context,
  ): Promise<PhaseTask<I, C, O, P>>;
}

// Curried generics and output inference mirror defineTask.
declare function defineStateTask<I extends JsonValue, C extends TaskCheckpoint,
                                 R extends JsonValue, F extends JsonValue,
                                 A extends JsonValue, O extends object = never>():
  StateTaskFactory<I, C, R, F, A, O>;
```

`StateActions` is passed immediately before the final `ctx`; authors call `actions.transition(...)` and
`actions.terminal(...)`. The factory's outer and nested exact helpers capture actual phase handlers and
transition callback payloads. This declaration pattern was prototyped under the repository TypeScript
compiler with the positive and negative cases below; WP8A moves those cases into maintained compile tests.
Its compile contract is exact:

- `C` is a finite discriminated union whose `phase` values are string literals; broad `string` rejects.
- Every `C["phase"]` has exactly one handler and no extra phase key exists.
- A handler's task contains the complete checkpoint variant for its phase.
- `initial` receives a running task with no checkpoint. Task creation remains checkpoint-free.
- A `start` phase has `run` and no `recover`; an `inflight` phase requires both.
- The target passed to `transition` determines the complete target payload. Missing or visible extra fields
  reject for literals, variables and spreads.
- `terminal(closure)` preserves the existing typed `TerminalClosure`; terminal author phases do not exist.
- Output inference and fresh kind-level abort match `defineTask` exactly.

The factory generates `TaskKind.execute` and `TaskKind.recover` around this internal loop:

```text
scheduler reserves pending -> running and calls generated execute once
  no checkpoint -> assert current unmarked invocation; initial.run
  handler returns actions.transition(P, commit)
  call the module-private commitStateTransition capability
  on the line: validate expected source and invocation, run commit(tx, fresh current),
               buffer a full task.set snapshot with the complete P checkpoint,
               persist/apply, return applied PhaseTask<P>
  assert current unmarked invocation; dispatch P.run within the same outer TaskKind invocation
  repeat until a handler returns terminal(closure)
generated execute returns closure to the existing terminal path

reopen reserves the restored running task and calls generated recover once
  no checkpoint -> fenced initial.run
  start checkpoint P -> fenced P.run
  inflight checkpoint P -> fenced P.recover
  after any committed transition, entry becomes normal and the next fenced handler uses run
```

The scheduler never calls `execute` again for an internal transition. `commitStateTransition` is a
module-private symbol implemented by the task-kernel runtime and consumed only by the generated adapter; it
is not exported and grants no task-author capability. It performs one ordinary line transaction, then reads
the already-applied live-task projection, including checkpoint and `owns`. There is no second empty commit
and the adapter never fabricates a task from the stale handler argument. Transition callbacks run on the
line against fresh current state, may perform explicit committed reads before their first write and then
compose same-commit entries/tasks/state, and cannot perform effects, waits, hooks, sleeps or nested commits.

`InitialStateRuntime` has no commit method. With no durable phase, allowing initial to commit child work would
let a crash rerun initial and duplicate them. Initial child/task/conversation creation therefore occurs in
its first returned transition callback, atomically with the first complete checkpoint. The next phase
resolves handles and waits only after that transition has committed.

Checkpoint-backed handlers retain `runtime.commit` for durable bookkeeping that must precede a wait or
effect. The wrapped transaction may replace only its complete current-phase variant; phase changes use
returned transitions. A same-phase commit may atomically create a child task/conversation and record its
ID/policy in the current checkpoint, then the handler waits after the commit resolves. The handler's later
transition callback still receives fresh current state.

`start` means the checkpoint does not represent an uncertain external effect, so reopen runs it normally.
`inflight` means an effect may have started, so reopen requires its explicit recovery path. This is a small
named state machine per task kind, not positional replay: only the latest complete checkpoint is durable.
There is no workflow history, deterministic replay requirement, generator, returned-plan journal,
one-commit-per-phase rule or global kernel lifecycle graph.

Immediately before every internal handler call, the adapter synchronously validates the exact invocation
object, Context, session phase, durable mark and abort signal. If transition persistence wins first, the next
handler may be admitted and a later mark signals it normally. If the mark wins before the check, the next
handler is never invoked; the ordinary cancellation unwind returns from the outer execute/recover, which is
joined before fresh abort starts. This fence does not forcibly stop already-admitted third-party code;
handlers remain cooperatively cancellable.

## 6. Mutation algebra and storage

### 6.1 Mutations

```ts
type NewTask = Omit<Task, "abort" | "checkpoint" | "outcome" | "owns" | "status"> & {
  readonly status: "pending";
  readonly owns: readonly [];
  readonly abort?: never;
  readonly checkpoint?: never;
  readonly outcome?: never;
};

type StateWrite =
  | { readonly type: "value.set"; readonly address: Value<JsonValue>; readonly value: JsonValue }
  | { readonly type: "value.delete"; readonly address: Value<JsonValue> }
  | { readonly type: "list.append"; readonly address: List<JsonValue>; readonly element: Element<JsonValue> }
  | { readonly type: "list.remove"; readonly address: List<JsonValue>; readonly elementId: Id }
  | { readonly type: "list.clear"; readonly address: List<JsonValue> };

type Write = StateWrite |
  { readonly type: "conversation.create"; readonly conversation: Conversation } |
  { readonly type: "entry.append"; readonly entry: Entry } |
  { readonly type: "task.create"; readonly task: NewTask } |
  { readonly type: "task.set"; readonly task: Task };
```

Each committed `Write` consumes one storage-assigned `Seq`; the returned sequences are contiguous, ascending
and positionally aligned with the submitted `Write[]`. `conversation.create`, `entry.append`, `task.create` and `list.append` carry IDs previously minted by
`Storage.nextId()`; Storage never equates them with sequences.
For a newly owned task output, the output ID defaults to the task ID; task creation and the protected shared
`pi.output` base append occur in the same `Write[]`.

A `task.set` carries the complete replacement task snapshot. The Session/task kernel, not Storage,
constructs running, checkpointed, ownership, abort-marked and terminal snapshots. A terminal snapshot
atomically retires private scratch and, from the prospective complete task set, every shared output with no
live reference. The kind's closure materializes final output into its entry/outcome before retirement. A new
or same-commit task reference keeps the output live; terminal records do not. A retired output ID cannot be
resurrected.

The Session validates scope and capability before persistence. Protected output writes retain private
per-append authorization while buffered; one `Write[]` may contain multiple authorized output appends. Each
append is one exact nonempty central-tracker flush. Scratch transactions contain only writes for their task. Storage remains mechanical: it atomically applies the canonical writes, maintains indexes and retirement,
assigns sequences, and derives/persists its committed ID high-water from creation/list-append IDs in the
canonical writes. It trusts the Session-supplied IDs and complete snapshots. It does not execute kind code, derive partial task transitions or validate application
payload schemas. Empty `Write[]` values are not passed to Storage, consume neither IDs nor sequences and
publish no event. An uncertain commit failure poisons the binding; the Session fail-stops and never retries
that callback on the same binding.

### 6.2 Queries

```ts
interface PageQuery { readonly cursor?: Id; readonly limit: number }
interface Page<T> { readonly items: readonly T[]; readonly next?: Id }

interface ConversationScan extends PageQuery {
  readonly parent?: Id;
  readonly owner?: Id;
}
interface EntryScan extends PageQuery {
  readonly conversationId: Id;
  readonly kind?: string;
  readonly through?: Id;
}
interface TaskScan extends PageQuery {
  readonly conversationIds?: readonly Id[];
  readonly statuses?: readonly ("pending" | "running" | "terminal")[];
  readonly kind?: string;
  readonly abort?: boolean;
  readonly outputId?: Id;
}
interface Storage {
  nextId(): Id;
  commit(writes: readonly Write[], ctx: Context): Promise<readonly Seq[]>;
  getConversations(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Conversation>>;
  scanConversations(query: ConversationScan, ctx: Context): Promise<Page<Conversation>>;
  getEntries(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Entry>>;
  scanEntries(query: EntryScan, ctx: Context): Promise<Page<Entry>>;
  newestHead(conversationId: Id, at: Id, ctx: Context): Promise<Entry | undefined>;
  getTasks(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Task>>;
  scanTasks(query: TaskScan, ctx: Context): Promise<Page<Task>>;
  getValue<T extends JsonValue>(address: Value<T>, at: Id | undefined, ctx: Context): Promise<T | undefined>;
  readList<T extends JsonValue>(address: List<T>, at: Id | undefined, ctx: Context): Promise<readonly Element<T>[]>;
}
```

Scan rules:

- `limit` is a positive integer. A returned `next` is the cursor for the next page.
- Conversation scans are ascending by ID; `cursor` is an exclusive lower bound. `parent` and `owner` are exact,
  composable filters.
- Entry scans are fork-aware and newest-first. `through` is an inclusive fork-visible upper bound; `cursor`
  is an exclusive upper bound, so the next page continues toward older entries. `kind` filters before limit.
- Task scans are ascending by ID; `cursor` is an exclusive lower bound. Tasks are never inherited.
  `conversationIds`, `statuses`, `kind`, `abort` and `outputId` compose as exact filters.
- List reads return the complete logical list ascending by element ID. `at` selects the validated historical
  entry position for rewindable conversation lists; `undefined` selects current state. There is no paged list
  scan in v1.
- `newestHead` is the dedicated fork-aware descending limit-one operation through its required inclusive
  bound. Latest value/head queries must not load and tail.
- Scan filters and fork caps apply before the limit and before payload decoding where the backend can avoid
  it. Pages deliberately contain no storage-sequence snapshot. A complete list read is coherent at one
  committed state and needs no multi-page snapshot protocol.

Before Storage is called, the Session/kernel validates the complete task snapshots against committed state
and prior buffered references. It also proves invocation identity, normal-versus-abort authority, open
reconciliation authority, durable mark and Session phase. Storage trusts the resulting canonical writes and
applies them atomically.

| write | structural current state | required complete snapshot |
|---|---|---|
| `task.create` | absent | pending, no checkpoint/outcome/abort, empty owns; ordinary/core token and output ref/base valid when declared |
| reservation `task.set` | pending | running; normal reservation requires terminal dependencies, marked abort reservation ignores them |
| progress `task.set` | running | running with complete checkpoint and/or complete immutable ownership list replacement |
| mark `task.set` | pending or running | same lifecycle state with `abort:true`; repeated mark helper is idempotent |
| completed/failed `task.set` | running and unmarked | terminal with matching outcome; scratch retirement follows snapshot |
| aborted `task.set` | running and marked | terminal with aborted outcome; scratch retirement follows snapshot |
| orphaned `task.set` | pending or running | terminal with orphaned outcome; scratch retirement follows snapshot |
| any replacement of terminal | terminal | reject |

Task-output creation/reference validation is whole-batch:

- A no-output kind stores no ref and cannot receive one.
- An output-capable task with no supplied ref stores `{ id: task.id, kind: spec.kind.kind }`; its one
  protected initial list element is the same-batch `track(spec.initial(input)).flush()` and starts with one
  `r` base. The initial value is transferred to the tracker; the author must not retain or mutate it.
- A supplied ref names an output with at least one live reference in committed tasks or the builder's private
  pending-task index and matches the durable output-kind string. A task invocation may pass its own ref to a task it is
  authorized to create; host code may share a live ref through its unrestricted task-creation authority.
- Several creations/terminalizations use the prospective post-commit live reference set. No ref may target a
  retired output.
- Every protected `list.append` to `defineList({type:"shared",id}, "pi.output")` is an exact nonempty
  central-tracker flush and has private buffered provenance from a current `writerTaskId` that references
  that output. One commit may contain several independently authorized appends.

Every owned `conversation.create` has one matching complete `task.set` snapshot in the same `Write[]` whose
`owns` includes the new conversation. Reject an unpaired side, ownership of an existing conversation,
duplicate ownership or mismatched owner IDs. Conversation ownership and the corresponding task `owns`
element are immutable after creation.

List removal rejects an element ID that never existed or belongs to another list. It is idempotent only for
an existing same-list element already hidden/removed, and still consumes a write sequence. Clear is valid on
an empty list and consumes a sequence. Reading any task-scope address after its task is terminal rejects
`ScratchRetired` in all backends; it never returns an accidentally retained sidecar value.

Explicit author-facing transaction reads run while the line is exclusively held and see committed state
only. They are allowed only before the first buffered write; any later explicit read rejects
`ReadAfterWrite`. There is no general transaction overlay and no read-your-writes. Semantic builder helpers
may continue after writes by consulting narrow private pending/reference indexes for their own same-callback
creations, request-key deduplication and structural validation. Those indexes are not exposed as readers;
authors carry values they just wrote.

## 7. Transaction and capability surfaces

Every runtime, host or conversation `commit` callback receives a synchronous write builder backed by one
canonical `Write[]`. Creation/list-append builders synchronously call `Storage.nextId()`, validate and buffer;
they never call `Storage.commit`. Explicit readers may await committed Storage only until the first write is buffered. After the
callback succeeds, the Session validates once and invokes `Storage.commit` exactly once. Public one-operation
mutators use the same transaction path.

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
  read(): Promise<readonly Element<T>[]>;
  read(at: Id): Promise<readonly Element<T>[]>;
  append(value: T): Id;
  remove(id: Id): void;
  clear(): void;
}
```

The aliases are:

```ts
type AnyTaskKind = TaskKindBase;
type AnyCoreTaskKind = CoreTaskKindBase;
type AnyDefinedTaskKind = AnyTaskKind | AnyCoreTaskKind;
type PayloadsOf<K> =
  K extends TaskKind<infer I, infer C, infer R, infer F, infer A, infer O>
    ? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O }
    : K extends CoreTaskKind<infer I, infer C, infer R, infer F, infer A, infer O>
      ? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O }
      : never;
type InputOf<K> = PayloadsOf<K>["input"];
type CheckpointOf<K> = PayloadsOf<K>["checkpoint"];
type ResultOf<K> = PayloadsOf<K>["result"];
type FailureOf<K> = PayloadsOf<K>["failure"];
type AbortedOf<K> = PayloadsOf<K>["aborted"];
type OutputOf<K> = PayloadsOf<K>["output"];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type TaskOf<K extends AnyDefinedTaskKind> =
  DistributiveOmit<Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>, "output"> &
  TaskOutputField<OutputOf<K>>;
```

The implementation may use distributive helper aliases to satisfy TypeScript variance without weakening
these public results. None may use `any`. Task-bound checkpoint methods exist only for the current kind.

### 7.2 Internal admission-capable transaction

```ts
interface Acceptance { readonly requestId?: string; readonly conversationId: Id; readonly inputId: Id }

interface SendInput {
  readonly requestId?: string;
  readonly content: UserInput;
  readonly whenBusy?: "followUp" | "steer" | "reject";
}

interface InputHandle {
  readonly id: Id;
  readonly conversationId: Id;
  result(ctx: Context): Promise<InputResult | undefined>;
  wait(ctx: Context): Promise<TerminalInputResult>;
  abort(ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
}

type TaskSpec<I extends JsonValue, O extends object = never> = {
  readonly conversationId?: Id;
  readonly input: I;
  readonly after?: readonly Id[];
  readonly background?: true;
} & ([O] extends [never]
  ? { readonly output?: never }
  : { readonly output?: TaskOutputRef<O> });

interface ConversationCreateSpec {
  readonly parent?: { readonly conversationId: Id; readonly at: Id };
}

interface TaskCreator<Kinds extends AnyDefinedTaskKind> {
  task<K extends Kinds, S extends TaskSpec<InputOf<K>, OutputOf<K>>>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>, OutputOf<K>>, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
}

interface TaskTxBase<C extends TaskCheckpoint> extends TxReaders {
  checkpoint(value: C): void;
  createConversation(spec: ConversationCreateSpec): Id;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
}

type BaseTaskTx<C extends TaskCheckpoint> =
  TaskTxBase<C> & TaskCreator<AnyTaskKind>;

interface InternalAdmissionTx {
  accept(conversationId: Id, options: InternalAcceptOptions): Promise<Acceptance>;
  queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}

type CoreTaskTx<C extends TaskCheckpoint> =
  TaskTxBase<C> & TaskCreator<AnyDefinedTaskKind> & InternalAdmissionTx & {
    entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
  }
```

Ordinary task authors receive `BaseTaskTx` and can instantiate only ordinary `TaskKind` tokens. Fixed
core definitions receive `CoreTaskTx`; its `task` method uses the same spelling but accepts either an
ordinary child token or one of Pico's fixed `CoreTaskKind` tokens. Thus generation can atomically create
tool and post_tools tasks, while plugin tasks cannot instantiate any core kind. `CoreTaskTx` also contains
direct entry and protected admission authority. A conversation-bound
internal variant omits explicit `conversationId`. In a task transaction, omitted task target
conversation means the current task's conversation. Explicit targets must be that conversation or a
conversation in its ownership subtree, including one created earlier in the batch. `createConversation`
automatically records `owner=current task` plus a complete replacement task snapshot containing the new
ownership; a host transaction creates an independent conversation unless an internal owner authority is supplied. Its optional parent must be the current
conversation or one in the current task's owned subtree; a task cannot inherit transcript/state from an
unrelated tree. A parent may be combined with ownership.
Data-only appends use the capability-restricted typed `entry` method with an `EntryKind`; there is no
parallel untyped `record` API. `accept`, `queueInput` and `write` are protected transaction helpers, not
ordinary public conversation methods. They remain available where built-ins must atomically compose child
creation, initial values, first input, first generation and a parent checkpoint. They are asynchronous because request-key lookup
may require a committed storage read; when invoked before any write they perform that read first, then synchronously buffer all
writes. After writes, they may use only their narrow private request/pending indexes and reject any path that
would require a new explicit read. They never reenter the line and may target a conversation created earlier
in the callback through its pending reference. To atomically create an owned child, copy state, accept its
first input, create its first generation and checkpoint the child/input IDs, the author performs every
explicit source read first and then buffers the complete composition.

Direct entry authorization and admission helpers are distinct. Core code may buffer an authorized
model-visible append after validating placement. An ordinary runtime constructs only `BaseTaskTx`; a cast
cannot add the absent `entry` or protected admission methods. Every builder records private provenance for
validation; storage sees only the resulting mutation algebra. No new invocation-authority mode is needed:
the fixed dispatcher chooses the concrete runtime/builder implementation, while the existing invocation
identity continues only to fence stale writes and cancellation.

### 7.3 Runtime and restricted conversation handle

```ts
interface PublicValue<T extends JsonValue> {
  get(at: Id | undefined, ctx: Context): Promise<T | undefined>;
  set(value: T, ctx: Context): Promise<void>;
  delete(ctx: Context): Promise<void>;
}
interface PublicList<T extends JsonValue> {
  read(ctx: Context): Promise<readonly Element<T>[]>;
  read(at: Id, ctx: Context): Promise<readonly Element<T>[]>;
  append(value: T, ctx: Context): Promise<Id>;
  remove(id: Id, ctx: Context): Promise<void>;
  clear(ctx: Context): Promise<void>;
}
interface ScratchTx {
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
}
interface ScratchReader {
  value<T extends JsonValue>(address: Value<T>): Pick<TxValue<T>, "get">;
  list<T extends JsonValue>(address: List<T>): Pick<TxList<T>, "read">;
}
interface TaskOutput<O extends object> {
  readonly ref: TaskOutputRef<O>;
  read(ctx: Context): Promise<O>;
  mutate(mutator: (state: O) => undefined, ctx: Context): Promise<void>;
  replace(value: O, ctx: Context): Promise<void>;
}
interface ReadonlyTaskOutput<O extends object> {
  readonly ref: TaskOutputRef<O>;
  read(ctx: Context): Promise<O>;
}
type RuntimeOutput<O extends object> = [O] extends [never]
  ? unknown : { readonly output: TaskOutput<O> };
type AbortRuntimeOutput<O extends object> = [O] extends [never]
  ? unknown : { readonly output: ReadonlyTaskOutput<O> };
type FinalOutput<O extends object> = [O] extends [never]
  ? unknown : { readonly output: O };

interface TaskConversation {
  readonly id: Id;
  send(input: SendInput, ctx: Context): Promise<InputHandle>;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface AbortTaskConversation {
  readonly id: Id;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface TaskRuntimeBase {
  readonly taskId: Id;
  scratch<T>(build: (tx: ScratchTx) => T | Promise<T>, ctx: Context): Promise<T>;
  conversation(id: Id, ctx: Context): Promise<TaskConversation | undefined>;
  waitForTask(id: Id, ctx: Context): Promise<Task>;
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  now(): number;
  sleep(untilMs: number, ctx: Context): Promise<void>;
}
interface CommitRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object, Tx> {
  commit<T>(build: (tx: Tx, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
}
type TaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> =
  TaskRuntimeBase & CommitRuntime<I, C, O, BaseTaskTx<C>> & RuntimeOutput<O>;
type CoreTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> =
  TaskRuntimeBase & CommitRuntime<I, C, O, CoreTaskTx<C>> & RuntimeOutput<O>;
```

`runtime.conversation`, `waitForTask` and `abortTask` accept only targets in the current task's ownership
tree: its own conversation, its owned descendants, their tasks, and the task's own dependencies. An
unrelated target rejects `ScopeViolation`. Host operations are unrestricted except for protected data and
normal lifecycle validation. This generic rule does not let one task resolve a conversation owned by a
sibling task. The future gated ordinary-tool descendant resolver required by section 14.3 is the narrow
exception; it will not broaden `runtime.conversation` or `TaskConversation`.

`TaskConversation` has no raw commit, direct entry, close, shutdown, delete or host-wide registry methods.
An `InputHandle` returned to a task is likewise invocation-bound. Task operations capture the expected
invocation when the runtime/handle is constructed. Every supplied Context must contain that exact current
invocation object. An absent, foreign or stale identity
rejects; task methods never fall back to host authority.

Exactly one authoritative Chord tracker is hydrated per live output ID. `read` snapshots it without exposing
a retained proxy. `mutate` invokes its callback synchronously on the commit line against the central proxy, flushes one
nonempty delta, and buffers its authorized append in the callback's canonical `Write[]`; the Session commits
that array once before resolving. Requiring an
`undefined` return rejects async callbacks at compile time. The callback cannot retain the proxy, call
another runtime method, or mutate after returning. Objects inserted through the proxy become tracker-owned;
the author must not retain and later mutate their raw references. If the callback throws, returns a thenable,
or causes tracker application to fail, nothing commits or publishes and the session fail-stops before
releasing the line. The poisoned in-memory tracker is never used
again; reopen reconstructs it from durable deltas. This avoids cloning the growing output before every delta.
`replace` uses the same tracker's `state` setter and commit path. Concurrent task writes serialize in global
commit order. Any persistence failure after tracker mutation also fail-stops. No observer sees uncommitted
tracker state. Runtime checks the ref's durable kind string, not JavaScript token
identity or structural TypeScript compatibility.

### 7.4 Terminal and abort transactions

```ts
type TerminalClosureFor<Tx, I extends JsonValue, C extends TaskCheckpoint,
                        R extends JsonValue, F extends JsonValue, O extends object> =
  (tx: Tx & FinalOutput<O>, current: RunningTask<I, C, O>) =>
    Completion<R, F> | Promise<Completion<R, F>>;
type FinalTx<C extends TaskCheckpoint, O extends object> = BaseTaskTx<C> & FinalOutput<O>;
type CoreFinalTx<C extends TaskCheckpoint, O extends object> = CoreTaskTx<C> & FinalOutput<O>;
type TerminalClosure<I extends JsonValue, C extends TaskCheckpoint,
                     R extends JsonValue, F extends JsonValue, O extends object> =
  TerminalClosureFor<BaseTaskTx<C>, I, C, R, F, O>;
type CoreTerminalClosure<I extends JsonValue, C extends TaskCheckpoint,
                         R extends JsonValue, F extends JsonValue, O extends object> =
  TerminalClosureFor<CoreTaskTx<C>, I, C, R, F, O>;

interface AbortTx<C extends TaskCheckpoint> extends TxReaders {
  checkpoint(value: C): void;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
  markTask(id: Id): Promise<"marked" | "terminal">;
}
interface CoreAbortTx<C extends TaskCheckpoint> extends AbortTx<C> {
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}
type AbortClosureFor<Tx, I extends JsonValue, C extends TaskCheckpoint,
                     A extends JsonValue, O extends object> =
  (tx: Tx & FinalOutput<O>, current: RunningTask<I, C, O>) => A | Promise<A>;
type AbortFinalTx<C extends TaskCheckpoint, O extends object> = AbortTx<C> & FinalOutput<O>;
type CoreAbortFinalTx<C extends TaskCheckpoint, O extends object> = CoreAbortTx<C> & FinalOutput<O>;
type AbortClosure<I extends JsonValue, C extends TaskCheckpoint,
                  A extends JsonValue, O extends object> =
  AbortClosureFor<AbortTx<C>, I, C, A, O>;
type CoreAbortClosure<I extends JsonValue, C extends TaskCheckpoint,
                      A extends JsonValue, O extends object> =
  AbortClosureFor<CoreAbortTx<C>, I, C, A, O>;

interface AbortRuntimeBase {
  readonly taskId: Id;
  scratch<T>(read: (scratch: ScratchReader) => T | Promise<T>, ctx: Context): Promise<T>;
  conversation(id: Id, ctx: Context): Promise<AbortTaskConversation | undefined>;
  waitForTask(id: Id, ctx: Context): Promise<Task>;
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  now(): number;
}
type AbortTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> =
  AbortRuntimeBase & CommitRuntime<I, C, O, AbortTx<C>> & AbortRuntimeOutput<O>;
type CoreAbortTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> =
  AbortRuntimeBase & CommitRuntime<I, C, O, CoreAbortTx<C>> & AbortRuntimeOutput<O>;
```

Ordinary abort runtime exposes repeated restricted commits with `AbortTx`, plus scratch reads but no scratch
writes. It cannot create tasks/conversations, append entries, delete conversations, send or queue input.
Fixed core abort receives `CoreAbortTx`, which adds direct entry authority plus only the passive protected
`write` helper; it cannot create future work. This lets the core tool adapter atomically publish an aborted
tool result and lets core cleanup queue a boundary-safe passive write. Marking immediately revokes the normal invocation's
`TaskOutput` mutation authority before signaling its context. Fresh abort receives only
`ReadonlyTaskOutput`: `ref` and `read`, never `mutate`/`replace`. Its final closure receives a detached
`tx.output` snapshot captured on the line so it can persist final output-derived data in the same main batch
as terminalization and possible last-reference retirement. Checkpoint replacement is allowed during lengthy
fresh cleanup; a crash reruns abort from the newest checkpoint because the durable mark remains.

Terminal closures run on the line after all effects and producer joins. They may await explicit committed
reads before buffering their first write and may then mint same-commit IDs, but may not perform external
effects, hooks, sleeps, waits or nested runtime operations. The kernel then buffers one full terminal
`task.set` snapshot with the returned outcome. A throwing closure persists nothing and faults the session.
Abort/close/fault may discard a normal closure without invoking it. Uncertain persistence fail-stops and
does not retry the closure on that handle.

### 7.5 Host transactions and foundation handles

Host transactions are not task invocations. Public host transactions may append model-affecting entries
directly only when no fixed turn task is live; otherwise direct append rejects. Protected built-in
transactions use the internal `write` helper when boundary-safe queuing is required.

```ts
interface HostTx extends TxReaders {
  task<K extends TaskKindBase,
       S extends TaskSpec<InputOf<K>, OutputOf<K>> & { readonly conversationId: Id }>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>, OutputOf<K>> & { readonly conversationId: Id }, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
  createConversation(spec: ConversationCreateSpec): Id;
  value<T extends JsonValue>(address: Value<T>): TxValue<T>;
  list<T extends JsonValue>(address: List<T>): TxList<T>;
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
}

interface ConversationTx extends Omit<HostTx, "task" | "entry"> {
  task<K extends TaskKindBase,
       S extends Omit<TaskSpec<InputOf<K>, OutputOf<K>>, "conversationId">>(
    kind: K,
    spec: NoExtra<Omit<TaskSpec<InputOf<K>, OutputOf<K>>, "conversationId">, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
  entry<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Id;
}

interface InternalConversationAdmissionTx {
  accept(options: InternalAcceptOptions): Promise<Acceptance>;
  queueInput(input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}
type InternalHostTx = HostTx & InternalAdmissionTx;
type InternalConversationTx = ConversationTx & InternalConversationAdmissionTx;

interface ConversationHandle {
  readonly id: Id;
  commit<T>(build: (tx: ConversationTx) => T | Promise<T>, ctx: Context): Promise<T>;
  send(input: SendInput, ctx: Context): Promise<InputHandle>;
  waitForIdle(ctx: Context): Promise<"idle" | "closed">;
  abort(ctx: Context): Promise<void>;
  fork(options: { readonly at: Id | "start"; readonly abort?: boolean }, ctx: Context): Promise<ConversationHandle>;
  collapse(options: { readonly instructions?: string } | undefined, ctx: Context): Promise<Id>;
  reset(options: { readonly handoff?: string } | undefined, ctx: Context): Promise<void>;
  value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
  list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface Harness {
  root(ctx: Context): Promise<ConversationHandle>;
  conversation(id: Id, ctx: Context): Promise<ConversationHandle | undefined>;
  commit<T>(build: (tx: HostTx) => T | Promise<T>, ctx: Context): Promise<T>;
  input(requestId: string, ctx: Context): Promise<InputHandle | undefined>;
  getEntry(id: Id, ctx: Context): Promise<Entry | undefined>;
  getTask(id: Id, ctx: Context): Promise<Task | undefined>;
  waitForIdle(ctx: Context): Promise<"idle" | "closed">;
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  resume(ctx: Context): Promise<void>;
  close(ctx: Context): Promise<void>;
  shutdown(ctx: Context): Promise<void>;
}
```

There is no partial public harness or feature-not-installed facade. Leaf packages are tested directly.
The single `Harness` is exported only when its required built-in dependencies are implemented. `send`
first commits or deduplicates durable admission, then non-abandoningly ensures scheduler activation, and only
then returns; it never waits for generation. Caller cancellation after admission cannot strand the accepted
input, and a request-key retry still returns its original handle. `waitForIdle`, task waits, input waits and
abort operations are observation/progress operations: they idempotently ensure the one session scheduler is
resumed, but a waiter never owns execution.

## 8. Input admission and boundaries

### 8.1 Records

```ts
type UserInput = string | readonly (TextContent | ImageContent)[];

interface StoredEntryDraft {
  readonly kind: string;
  readonly data?: JsonValue;
  readonly model?: readonly Message[];
  readonly head?: Id | "self";
  readonly edits?: readonly ContextEdit[];
}

type QueuedInput =
  | { readonly mode: "steer" | "followUp"; readonly input: UserInput; readonly requestId?: string }
  | { readonly mode: "write"; readonly entry: StoredEntryDraft; readonly requestId?: string };

type InputResult =
  | { readonly status: "queued"; readonly requestId?: string }
  | { readonly status: "placed"; readonly requestId?: string; readonly entry: Id }
  | { readonly status: "done"; readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
  | { readonly status: "unanswered"; readonly requestId?: string; readonly entry?: Id;
      readonly reason: "terminated" | "aborted" | "failed" | "stale"; readonly detail?: string };

type TerminalInputResult = Extract<InputResult, { status: "done" | "unanswered" }>;

type QueueMode = "all" | "one-at-a-time";

interface InternalAcceptOptions {
  readonly input: UserInput;
  readonly requestId?: string;
  readonly whenBusy?: "followUp" | "steer" | "reject";
}

// Public facade: send(input, ctx) returns InputHandle after this internal operation commits.
```

The protected `pi.inbox` address is a conversation-scoped sticky (`rewind:false`) list bound to exactly one
conversation. It is not inherited by forks. It stores `QueuedInput`; each list-element ID is the `inputId`,
and ascending element IDs preserve Session admission order. Protected sticky values store `InputResult`
directly by input ID and `Acceptance` directly by session-wide request key. Result/receipt lookup is always a
point lookup in that protected state, never a transcript or inbox list scan. `Conversation.send` converts
`SendInput.content` to the internal accepted user input and returns an `InputHandle` bound to the accepted
input and its original conversation.

Inbox reads expose one complete current materialized ordered collection. MemoryStorage retains that
collection directly; JSONL replays list operations once at open and then maintains it; SQLite reads all
current indexed rows in element-ID order and may physically delete rows on remove/clear. No backend replays
from the last clear on each inbox read. Historical
rewindable-list operation storage and fork-capped reads are unrelated to this sticky protected list.

A request key names the first acceptance for the Session lifetime. Lookup occurs before conversation, busy
mode or payload comparison. A duplicate `send` returns a handle for the original acceptance and buffers
nothing, even when retried through another conversation with different content. The internal `accept`,
`queueInput` and `write` helpers obey the same first-key-wins rule.

Only protected admission/boundary helpers write input results, using this transition table. Enqueue,
removal, result/receipt changes, entry placement and task creation selected by one admission/boundary decision
remain one main transaction:

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
  task<K extends CoreTaskKindBase,
       S extends TaskSpec<InputOf<K>, OutputOf<K>> & { readonly conversationId: Id }>(
    kind: K,
    spec: NoExtra<TaskSpec<InputOf<K>, OutputOf<K>> & { readonly conversationId: Id }, S> & {
      readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
    },
  ): Id;
}
interface InternalGenerationAdmission<K extends CoreTaskKindBase = CoreTaskKindBase> {
  readonly kind: K;
  create(
    tx: InternalBoundaryTx,
    conversationId: Id,
    inputs: readonly Id[],
  ): Id | Promise<Id>;
}
```

This is a private admission-module/test seam, not a public Harness option. The callback runs inside the
current transaction and may perform committed transaction reads before buffering its one task creation;
it cannot append entries, mutate state, perform effects or enter the line. Validation requires exactly one new task in the fixed core generation slot in `conversationId` and requires
its returned ID to be that task. The expected token/name is `strategy.kind`; production wiring supplies the
fixed generation token. Accounting for exactly the supplied input IDs is the trusted
strategy's typed obligation; the erased kernel cannot inspect an arbitrary generation input to prove it.
WP5 tests supply a minimal `defineCoreTask` generation definition; the provider package supplies the fixed
production strategy.

### 8.3 Busy and placement predicates

`admissionBusy(conversation)` means at least one live task directly in that conversation has kind
`pi.generation`, `pi.tool` or `pi.post_tools`, regardless of foreground/background. The predicate is evaluated
against the prospective complete task set for a transaction. It is transcript-admission state, not scheduler
eligibility, idle observation or proof of input ownership. A speculative collapse has core transcript
authority but is not in the fixed turn-task set. Ordinary plugin tasks never make a conversation admission-busy.

- `send` when `admissionBusy` is empty performs one idle admission transaction: select all older writes, and
  all or the oldest steer/followUp according to their respective `QueueMode`; merge selected items in global
  inbox order, then append the new input last; create one built-in generation owning those input IDs; mark
  each placed; store any request receipt; commit. `whenBusy` is irrelevant. The successful main commit
  kicks the scheduler. After that durable commit resolves, `send` non-abandoningly ensures the scheduler is
  resumed before returning.
- `send` when `admissionBusy` is nonempty queues `followUp` by default, queues `steer` when requested, or
  throws `ConversationBusy` and writes no request receipt when `reject` is requested. It creates no task at
  admission; the harmless main-commit kick still occurs.
- Internal `write` appends and completes immediately when `admissionBusy` is empty; otherwise it queues.

Boundary operations are transaction helpers, not nested commits:

- **post-tools boundary:** select all writes and all or the oldest steer according to `steeringMode`, merge
  selected items in global inbox order, and place them. Steering joins the active input group. FollowUp
  remains queued.
- **final-answer boundary:** resolve the active group to the answer; select all writes plus all or the oldest
  steer/followUp according to `steeringMode`/`followUpMode`; merge selected items in global inbox order, place
  them into a new group and create its generation.
- **idle-turn boundary:** when a normal core terminal batch changes the prospective fixed turn-task set from
  nonempty to empty and creates no fixed turn-task successor, Pico applies the same final-boundary queue-mode
  selection and creates its new generation. Core code remains responsible for resolving its active input group;
  the kernel never interprets a core payload or checkpoint.
- **abort boundary:** no automatic generation or queue drain. Conversation abort separately withdraws
  queued steer/followUp; task abort preserves queues. A later idle send can consume preserved items.

Canonical trace:

```text
idle send A
TX[user A; generation G1(inputs:[A]); result A=placed; receipt]
kick -> G1

G1 calls X,Y
TX[assistant calls; tool X; tool Y; post_tools P1(after:[X,Y],inputs:[A]);
   terminal G1]
kick -> X and Y concurrently

busy send B(default followUp) -> TX[inbox B; result B=queued; receipt]
busy send S(steer)            -> TX[inbox S; result S=queued; receipt]
busy internal write W         -> TX[inbox W; result W=queued]

X and Y finish in either order
TX[tool result X; terminal X]
TX[tool result Y; terminal Y]
model projection orders those result messages by the assistant's call order

P1 boundary
TX[write W; user S; result S=placed;
   generation G2(inputs:[A,S]); terminal P1]
kick -> G2

G2 final answer E2
TX[assistant E2; A/S=done(answer:E2); user B; B=placed;
   generation G3(inputs:[B]); terminal G2]
kick -> G3
```

`steeringMode` and `followUpMode` are independent built-in `QueueMode` settings and default to
`"one-at-a-time"`, matching the old lane harness. `"all"` selects every queued item of that tag;
`"one-at-a-time"` selects only its oldest item. Selection never reorders the one inbox: selected tags are
merged in global element-ID order and unselected items keep their relative order. There is no queue-size or
drain-size bound in v1. An idle internal write appends and becomes `done` without creating work. Applications
that need speculative staged context for a later explicit turn
store it in their own sticky conversation list and fold it into that later `send`. No send creates a giant
turn task or immutable task-per-send dependency chain.

Normal terminal finalization uses this exact order:

```text
invoke returned closure and buffer its writes
obtain its completed/failed outcome
buffer the complete terminal task.set snapshot
compute prospective admissionBusy from committed live tasks plus the whole buffered Write[]
when eligible, append idle-boundary inbox/result/entry/generation mutations
validate and persist the complete batch
```

The terminal snapshot and automatic boundary are one atomic `Write[]` commit. Abort, orphan reconciliation,
close and fault never run automatic idle-boundary augmentation. WP5 implements the pure prospective planner;
WP6 integrates it with normal closure finalization.

A speculative collapse never contributes to `admissionBusy`; an idle `send` may therefore create generation
work while collapse runs. If collapse completes while a generation/tool/post_tools task remains live, no idle
boundary runs; the fixed core owner processes the inbox later. Ordinary third-party tasks cannot own an
input group or participate in the turn-task set. Pico never infers or resolves an ordinary kind's private
payload as an input group.

Input ownership for built-in turns is explicit `inputs: readonly Id[]` in generation/post_tools input or
checkpoint. Exactly one live built-in generation or post_tools owns each placed active group, and ownership
transfers in the same terminal batch. Generic scheduling never scans arbitrary checkpoints for ownership.

### 8.4 Withdrawing input

`InputHandle.abort()` serializes with placement. It first commits withdrawal when the queued item wins, then
non-abandoningly ensures the scheduler is resumed so admitted cleanup can progress. If the queued item wins,
Pico atomically removes only that item and writes terminal
`unanswered/aborted`, then returns `aborted`. If placement or any terminal result wins, it returns
`already_placed` and changes nothing. A missing input returns `not_found`. Later inbox items retain their
relative order; no task dependency is rewired. If a queued result exists but its inbox element is missing,
Pico faults the Session as corrupted state.

### 8.5 Waiting for input

`InputHandle.result()` is a point read and does not activate work. `InputHandle.wait()`:

- validates that the accepted input still exists, otherwise rejects `InputNotFound`;
- idempotently resumes the session scheduler before observing terminal state;
- returns an existing `done` or `unanswered` result immediately;
- otherwise registers/checks/removes one cancellable point waiter on the line without polling;
- removes its signal listener and waiter exactly once on result, caller cancellation, close or fault;
- rejects caller cancellation, close and fault; shutdown eventually closes and rejects unresolved queued
  waits rather than deleting their durable input;
- does not mark or cancel durable work when its caller cancels.

The waiter observes durable state and owns no execution. Several handles or calls may wait for the same
result. There is no serving graph, blocker set or input-specific execution cycle detector. Generic cycle
validation remains limited to acyclic task dependencies, direct task self-wait, and waiting on a task whose
unresolved dependency path reaches the caller. Hidden plugin-promise cycles remain the author's
responsibility.

## 9. Commit line and runtime authorization

One FIFO async line serializes commits, calls to `Storage.nextId()`, reservations, marks, lifecycle
transitions, registry mutations, waiter registration/removal and watch capture. A transaction callback may
await committed storage reads while holding the line only before its first buffered write; a later explicit
read rejects `ReadAfterWrite`. It must not await effects, hooks, task/input/idle waits, sleeps or nested line
operations. Known Pico runtime/handle line reentry rejects `NestedLineOperation` before queueing rather than
silently deadlocking. Every intermediate, terminal and abort builder receives a fresh immutable current task read on
the line after all committed checkpoint/mark changes; it never receives only the method's older snapshot.

Caller cancellation is checked while waiting to enter the line and again before the builder begins. Once
the builder is admitted, caller cancellation cannot abandon builder completion or persistence. Storage
receives an internal non-abandoning Context that preserves telemetry but not the caller's abort signal. Task
invocation identity, lifecycle and durable mark are still revalidated on the line before invoking its
builder.

Commit sequence:

```text
enter line
validate Session phase and caller/invocation authority
construct a capability-bound builder with an empty canonical Write[]
run callback; creation/list-append builders call Storage.nextId() synchronously on the line
explicit reads see committed state and must precede the first buffered write
on throw/rejection, discard Write[]; already-minted IDs remain burned in this binding
validate writes/order/references/capabilities using committed state plus private semantic indexes
if nonempty, call Storage.commit(Write[], internalCtx) exactly once
Storage derives/persists its committed ID high-water from created/list-appended objects in that Write[]
receive one storage-assigned Seq per write; returned created IDs become valid after success
apply the complete writes and sequences to all process indexes and views
unconditionally coalesce one session-scheduler kick for a successful main commit
resolve affected observation waiters
leave line
dispatch signals and listeners outside line; the scheduler drain dispatches its reservations outside line
resolve outer commit promise
```

Publication never precedes persistence. Every index observes a full batch before scheduling or idleness,
so terminal task + successor has no visible idle gap. Every successfully persisted main commit kicks after
application, even when its writes cannot affect eligibility; coalescing makes redundant kicks harmless.
Scratch and task-output-only commits need not kick because they cannot change task eligibility.

Private invocation identity contains task ID, method (`execute`, `recover`, `abort`) and a unique object.
The scheduler installs that exact object in a derived Context and binds every task runtime/handle to it. Runtime
admission compares object identity with the invocation slot. Metadata/RPC transport never confers authority.

Authorization table:

| phase/method | normal commit | scratch write | terminal closure | abort restricted commit/closure | host admission |
|---|---:|---:|---:|---:|---:|
| open, execute/recover, unmarked | yes | yes | yes | no | yes |
| open, execute/recover, marked | reject before builder | reject before builder | discard without invoke | no | yes |
| open, abort invocation | no | read only | no | yes | yes |
| stopping | no | no | discard | existing/new abort only | reject |
| closing/faulted/closed | no | no | discard | no; close/fault signal it | reject |

Internal safe admission/`write` authorization and raw direct-entry authorization are separate. Protected built-in
state and entry operations require internal helpers. Main and scratch writes from absent/foreign/stale task
identity reject; task-provided handles never treat them as host calls.

## 10. Session scheduler, ownership and waits

A writable Harness owns exactly one process-local scheduler for its Session. Process indexes after open are:

- the complete live task map across every conversation;
- one invocation slot per running task ID;
- tasks by conversation plus fixed-turn-task and foreground subsets;
- reverse dependency edges;
- conversation parent/owner ancestry needed for capability and cancellation reach;
- point waiters for task, input and foreground-idle observation;
- scheduler enabled/dirty/runner state and Session phase.

Open constructs these indexes but leaves the scheduler inert. `resume(ctx)` idempotently enables it until
close or fault, installs the drain runner if needed, records an initial coalesced kick, and returns without
waiting for any reservation, task callback or foreground idle. It always covers every conversation. `send`, `InputHandle.wait`,
`waitForTask`, foreground-idle waits, `collapse`, task/input/conversation abort operations, and any other
host/plugin task-creation facade that promises execution ensure resume. Read-only
inspection, view/watch capture, fork creation without input and configuration/state reads do not.

Every successful main commit unconditionally calls the same coalescing kick after persistence and in-memory
application. A kick while disabled records no execution obligation because a later `resume` scans all
eligibility. While enabled, a kick sets dirty and ensures one drain runner. The drain repeatedly clears dirty,
reserves every currently eligible task on the Session line, and dispatches all reservations outside it. If a
commit races with drain exit, dirty causes another pass. There is no polling, per-conversation worker or lost
kick window. Scratch and task-output-only commits need not kick.

Dependencies are immutable, acyclic IDs in the same ownership tree. They may reference tasks created
earlier in the same batch, including the current task from its terminal closure. A task becomes eligible
when every dependency is terminal, regardless of outcome. Missing from the complete live map means terminal
after existence was validated. A foreground task depending on endless background work intentionally keeps
foreground idle false.

Reservation on the line considers all conversations:

```text
marked live task                    -> fresh abort, ignoring dependencies
unmarked pending with terminal deps -> commit full running task.set snapshot, reserve execute
unmarked running loaded at open     -> reserve recover
```

A pending task marked before reservation never becomes running for effects; the kernel writes a complete
running snapshot only as part of reserving fresh abort so `abort` receives `RunningTask`. A task created and
marked in one commit is likewise cleaned by abort without execute. Foreground and background tasks use the
same eligibility rules and both execute. `background:true` only excludes a task from foreground-idle and
ordinary foreground cancellation sets.

There is at most one invocation per task ID in a process. Its slot remains held through method return,
producer/progress joins and terminal-closure acceptance or discard. The scheduler never awaits one task
before dispatching another task ID, so tasks in the root, forks and owned child conversations may run
concurrently. Callbacks, methods and signals never execute on the line.

Ownership remains capability and cancellation structure, not execution structure. Foreground cancellation
reach starts with live foreground tasks directly in the requested conversation, recursively enters
conversations owned by those live foreground tasks, and repeats. A background or terminal owner breaks that
reach. Fork history grants neither ownership nor cancellation reach. Queued input is not a task.

Conversation `waitForIdle` observes that foreground cancellation closure; Harness `waitForIdle` observes all
session foreground tasks. Both ensure resume, return immediately when already idle, or install one
cancellable point waiter. They do not wait for background work and do not alter scheduler scope. Cancelling a
wait removes only that waiter/listener and never cancels durable work.

`waitForTask` ensures resume, rejects `TaskNotFound` for a missing target, returns a terminal task
immediately, or installs one cancellable point waiter for a live target. Direct self-wait and a wait on a
task whose unresolved dependency path reaches the caller reject. Dependency creation rejects cycles. No
waiter owns execution, and no serving-specific cycle or recursive execution scope exists.

## 11. Cancellation, close, shutdown and fault

### 11.1 Task and conversation abort

`abortTask(id)` and abort-transaction `markTask(id)` reject `TaskNotFound` for a nonexistent ID, return
`terminal` for an existing terminal task, and return `marked` for either an unmarked or already-marked live
task. Each public abort operation first commits its mark or withdrawal, then non-abandoningly ensures the session
scheduler is resumed, so cleanup becomes eligible without changing execution scope. Repeated marks are idempotent and never cancel an already-running fresh
abort invocation.

Conversation abort commits the mark/queue-withdrawal batch and records those task IDs as its tracked set.
Any mark issued by an abort invocation whose own task is in that tracked set is added transitively to the
same set. The operation observes until every tracked task is terminal and no tracked invocation remains.
Unrelated background work is excluded from the tracked set, although it continues executing normally.
Caller cancellation cannot abandon cleanup after the mark batch is admitted.

The mark transaction:

1. Compute the current foreground cancellation closure from the pre-commit live/ownership snapshot.
2. Mark every live task in it.
3. Remove queued steer/followUp in affected conversations and write terminal `unanswered/aborted` results.
4. Preserve queued write.

When a mark wins:

```text
commit a full task.set snapshot with abort:true
revoke execute/recover main and scratch writes immediately
leave line; signal old invocation
wait for method, effects and owned progress producers to return
on line discard any normal terminal closure and release old invocation
reserve fresh abort with new identity/controller/Context
abort may perform restricted checkpointed cleanup
abort returns closure
apply passive/direct core writes + full aborted terminal task.set snapshot + scratch retirement atomically
release abort invocation
```

Fresh built-in `pi.tool` cleanup reads its durable child records. It marks each child task with
`abortWithTool:true` and live foreground tasks in each owned child conversation with that flag, using atomic
mark-if-live; an already-terminal target counts as cleaned. Children with `abortWithTool:false` are excluded.
It never invokes public child conversation abort and therefore preserves child queues. Local deadlines are not durable marks: their
in-band errors remain kind-specific domain outcomes. Cancellation classification uses Pico's identity and
known reason, never error name alone.

An uncooperative effect can delay abort indefinitely. Forced isolation is outside v1.

### 11.2 Close

Close is a nonpersistent line transition that stops admission and reservation. Earlier admitted line work
finishes; later operations reject except invocation completion. Outside the line, signal and join every
outstanding invocation, then close the backend binding. A durably terminal task has no outstanding invocation because terminal publication follows method return and producer joins. It writes no outcomes or marks.
Caller cancellation cannot abandon close. Repeated close calls share completion.

### 11.3 Shutdown

Shutdown enters `stopping` and commits full abort-marked snapshots for every live task in one batch. It
preserves every queued input/result. Its mark commit and cleanup path activate the session scheduler; shutdown
observes until live tasks and invocation slots are empty, then closes. Fresh abort handlers may commit; all normal work/admission rejects. A failing abort faults shutdown.
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
Scratch is never rewindable, inherited or part of context. Task scope is private scratch. Shared scope is
separate observable ephemeral state: it may be referenced by several live tasks and is not retained merely
to preserve one task's unrelated scratch.

Execute/recover may read and write its own scratch while unmarked. Abort may read but not write scratch;
it persists cleanup progress in the task checkpoint or permitted main state. A crash before terminal
outcome retains scratch. The terminal `task.set` snapshot retires it atomically. Every later scratch write rejects, even if a
sidecar unlink failed.

A retry under one task ID resets attempt-specific live state through `runtime.output.replace` before new
output. Generation stores no second durable frame stream in task scratch: its task output is the sole
partial assistant representation. Chord persists compact append/replace/truncate deltas, not growing
whole-value copies.

Harness-owned producers own every pending scratch promise, cancel on early exit, suppress only expected
mark/close rejection, report persistence faults and join before the invocation may finalize. Iterator exit
alone is not provider/process completion. Plugin code must await or catch every raw scratch write.

## 13. Harness open and registries

The final Harness has one construction API:

```ts
interface CoreTaskKinds {
  readonly generation: CoreTaskKindBase;
  readonly tool: CoreTaskKindBase;
  readonly postTools: CoreTaskKindBase;
  readonly collapse: CoreTaskKindBase;
  readonly job: TaskKindBase;
}
interface RootValueWrite<T extends JsonValue = JsonValue> {
  readonly address: Value<T>;
  readonly value: T;
}
interface HarnessOpenOptions {
  readonly taskKinds?: readonly TaskKindBase[];
  readonly entryKinds?: readonly EntryKind[];
  readonly rootValues?: readonly RootValueWrite[];
}
interface OpenInspection {
  readonly pending: readonly Task[];
  readonly running: readonly Task[];
  readonly orphaned: readonly Task[];
  readonly unknownEntryKinds: readonly string[];
}
interface MutableRegistry<D extends { readonly kind: string }> {
  get(kind: string, ctx: Context): Promise<D | undefined>;
  register<T extends D>(definition: T, ctx: Context): Promise<void>;
  replace<T extends D>(definition: T, ctx: Context): Promise<void>;
  remove(kind: string, ctx: Context): Promise<void>;
}
interface Harness {
  readonly kinds: CoreTaskKinds;
  readonly entryKinds: MutableRegistry<EntryKind>;
  readonly taskKinds: MutableRegistry<TaskKindBase>;
  inspect(ctx: Context): Promise<OpenInspection>;
}
interface HarnessFactory {
  open(binding: StorageBinding, options: HarnessOpenOptions, ctx: Context): Promise<Harness>;
}
```

The two `Harness` declarations in this specification merge into one TypeScript interface. `register`,
`replace`, `remove` and `get` serialize on the line for ordinary plugin definitions. Register rejects an
existing name; replace requires an existing ordinary name. Replacing or removing an ordinary task kind
rejects while any live task of that kind exists; with no live instance, replacement affects only future
creations and terminal history remains unchanged.
The fixed core definitions are not members of the mutable registry and cannot be registered, replaced or
removed. Ordinary registration rejects every protected `pi.*` task name.

Stable core names and roles are:

```text
generation  pi.generation   defineCoreTask; turn task; transcript/admission authority
tool        pi.tool         defineCoreTask; turn task; transcript/admission authority
postTools   pi.post_tools   defineCoreTask; turn task; transcript/admission authority
collapse    pi.collapse     defineCoreTask; not a turn task; transcript/admission authority
job         pi.job          defineTask;     not a turn task; ordinary task authority
```

Harness installs these exact production definitions. The internal admission strategy is bound to the fixed
generation token. `harness.kinds` exposes readonly typed witnesses for hooks, inspection and internal
composition; possession of a witness does not make it creatable through an ordinary transaction.

Empty storage means its conversation scan is empty. The root conversation is the first committed object from
a fresh backend, has ID `1`,
has no parent/owner, and can never be deleted. Every `rootValues` address must be a value bound to conversation 1
(or an authorized built-in address bound there); duplicate addresses reject. Root creation and all root
values commit atomically. Nonempty storage ignores `rootValues`.

One Session exclusively owns a Storage instance while open; this ownership guard and backend binding
lifecycle sit above the minimal WP2 `Storage` interface, which has no `claim` or `close`. `MemoryStorage`
retains data and may be bound to a later Session after the first closes for recovery tests. JSONL/SQLite
bindings are not reusable and hold a cross-process session lock from backend open through binding close.
Initialization failure releases that binding before rejecting. Two writers fail rather than race.

Open order:

1. Finish backend replay/recovery, initialize `Storage.nextId()` from committed creation/list-append writes,
   and construct the disabled scheduler. Kicks from later open-time main commits are harmless while disabled.
2. Install the fixed core entry/task definitions, then ordinary plugin options.
3. If storage is empty, create root conversation and apply `rootValues` in one commit. Reopen ignores
   `rootValues`.
4. Load the complete live-task seed and required ownership ancestry. Discover stored entry-kind names via
   the agreed scans; a backend may satisfy those scans from an index.
5. Validate every live fixed-core task against its installed fixed definition.
6. Reconcile every live ordinary task whose kind is absent in one commit of full task snapshots.
7. Finalize all indexes used by the disabled session scheduler, then return inspection/read handles without
   starting work. Registry/open reconciliation is complete before `resume` can dispatch anything.

Core slots `generation`, `tool`, `post_tools`, `collapse` and `job` always have their built-in implementation.
This ensures internal admission/boundary processing and unavailable-tool results remain available. Ordinary
task kinds may be removed only when no live instance exists. Entry and section definitions may be removed
without deleting durable records. In-flight ordinary invocations/preparations retain captured definitions;
later operations use the new registry.

Missing-kind reconciliation uses one pre-reconciliation snapshot:

- Find every pending/running task whose kind is absent, foreground or background.
- For each missing task's owned conversations, recursively mark every registered live foreground descendant
  reachable through ownership. Preserve all queued input.
- Missing descendants are themselves orphaned rather than marked for code that does not exist.
- Terminalize each missing task as `orphaned`, retain input/checkpoint/history, remove live/dependency indexes
  and retire scratch atomically.
- Dependents observe a terminal dependency and interpret `orphaned`.
- Keep ancestry links for capability and cancellation policy; after `resume`, registered marked descendants
  are eligible even though the owner is now terminal.
- Report orphaned IDs from `inspect`.

If validation, root creation, index loading or reconciliation fails, open closes/releases the supplied
storage binding before rejecting and returns no handle. Registration never resurrects orphaned tasks.

## 14. Built-in contracts retained for later packages

These contracts are normative behavior. Packages explicitly gated in section 18 wait for their unsettled
author APIs.

### 14.1 Generation and post_tools

Generation owns explicit input IDs and only minimal effect-recovery evidence. Its checkpoint may contain the
preparation/context cutoff, selected built-in model identity, attempt, retry wait, deferred handle and the
specific offered tool-name/version evidence needed for uncertain-response recovery. A request snapshot is
immutable, but it never copies generic plugin configuration or arbitrary conversation state. Built-in model,
thinking, system-prompt and tool selection remain fork-aware conversation state: a fork sees the built-in
configuration at its selected entry and may override it locally. A plugin needing exact recovery persists
its own compact key/version. `before_request` may transform a private messages-only request; actual offered
tools after transformation are the validation basis and must be recoverable only to the extent required by
that hook/effect contract.

Assistant frames mutate the generation task output; scratch contains only unrelated private recovery data.
Retry and deferred polling loop cooperatively under one stable task ID.
`on_yield` receives the prospective assistant message/draft plus stable task ID, not an entry ID that does
not exist. The returned terminal closure atomically appends assistant/usage, resolves or transfers inputs,
and creates tools/post_tools/continuation.

For calls, generation creates every tool task and one post_tools depending on them in its closure. Each tool
atomically appends exactly one result entry while terminalizing. Parallel completion therefore controls
transcript append chronology; request projection reorders tool-result messages into the assistant's call
order. Post_tools reads terminal outcomes in call order, handles completed/failed/aborted/orphaned, places the
post-tools boundary after every result exists, and either terminates/handoffs or creates a continuation while
transferring inputs atomically.

Threshold or overflow creates collapse `C` and replacement generation `G` with `after:[C]`, carrying the
active inputs, in one closure. No invocation waits on collapse. `G` handles every terminal collapse outcome.

Concrete transaction traces:

- **Generation:** reservation is one full-snapshot commit. Preparation/checkpoint commits finish before the
  provider effect, which runs outside the line; streamed output flushes use their own shared commits. After
  the effect and producers finish, the terminal callback performs any committed reads first, then buffers
  assistant/usage entries, tool and post_tools task creations, input transitions and the generation terminal
  snapshot. The Session calls Storage once for that canonical `Write[]`.
- **post_tools:** reservation is one full-snapshot commit. It reads tool outcomes and their already-committed
  result entries before writing. Its terminal callback buffers boundary placement, optional continuation
  creation, input ownership transfer and its terminal snapshot; all persist in one Storage call.

These atomic terminal commits do not absorb external effects. Every durable checkpoint-before-effect or
record-after-effect boundary remains a separate line transaction and Storage commit.

### 14.2 Collapse

Collapse captures reason, target prefix ending at a complete exchange, first retained boundary, newest head
and settings. It runs speculatively and may be background/manual or foreground/automatic. It checkpoints a
prepared candidate. Its terminal closure reads the current newest head on the line. A newer head returns
ordinary typed stale failure; intervening edits do not stale. Success appends summary head and completes in
one commit. Concretely, reservation commits a full running snapshot; summarization runs outside the line and
any prepared-candidate checkpoint is a separate commit. The terminal callback reads `newestHead` before its
first write, then buffers the summary append and terminal collapse snapshot in one `Write[]` and one Storage
call. Abort publishes no summary. One live collapse per conversation; simultaneous creation is
serialized and duplicate creation declines or reuses the existing ID according to the calling built-in.

### 14.3 Tools, jobs and owned conversations

Tool input includes immutable call and assistant entry ID. Missing implementation, invalid arguments, hook
block and ordinary throw become model-visible error results, not session faults. Recovery retries only with
a durable safe replay policy; otherwise it returns interrupted. Abort publishes an aborted tool result
through `CoreAbortTx` entry authority. A missing executable tool is handled by the built-in tool kind; it is
not a missing task kind.

A concrete tool trace is: reserve with one full running-snapshot commit; commit any replay-policy checkpoint
before invoking the external tool; run that effect outside the line; then invoke the terminal closure. The
closure performs committed reads first and buffers its one tool-result append, final output-derived data and
full terminal task snapshot. Those writes are one canonical `Write[]` and one Storage call. Abort uses the
same one-commit final shape after its separately joined external cleanup.

The fixed `pi.tool` `CoreTaskKind` owns `CoreTaskRuntime.commit` and its transaction capabilities. An
ordinary `ToolDefinition` receives neither. Its eventual adapter is a small `pi.tool`-mediated capability over the
current invocation's `TaskOutput`, durable scoped memos and keyed child creation; exact public names and
TypeScript types remain gated in section 18 and must not be inferred from generic task runtime.

The later ordinary-tool bridge must preserve these requirements without exposing general commit:

- Its invocation ID is the stable `pi.tool` task ID. Its output is the task's `TaskOutput`. Durable
  strict-JSON memos are protected state scoped to that task and retire with it.
- A keyed child-task operation, if included, uses one internal parent-tool transaction to create the child
  and write its ID, kind, `abortWithTool: boolean` and optional shared-output ref into the complete parent
  checkpoint before returning. Jobs remain tasks. The exact task-spawn API and checkpoint schema are gated.
- A keyed subagent operation uses one internal parent-tool transaction to call `tx.createConversation`,
  write the selected initial values, call the internal `tx.accept` helper to create the first generation, and record the child
  conversation ID, input ID, request key and `abortWithTool: boolean` in the complete parent checkpoint.
  After commit, the adapter resolves the existing restricted conversation handle and waits outside the
  line. A subagent is an owned conversation, never a subagent task.
- `abortWithTool:false` means only that enclosing `pi.tool` abort does not mark that child. It is not a
  generic detached-ownership abstraction. Parent normal completion cancels neither
  value.
- A repeated creation key must either be explicitly first-key-wins or compare a persisted canonical spec.
  Exact-match replay must persist normalized parent position, input, request key, initial values, protected
  seed profile/version and `abortWithTool`; it must not compare mutable current values. The final choice and
  record types remain gated.
- Returned task handles expose wait/abort, not commit. If local timeout is supported, wait accepts an
  explicit timeout and returns `undefined` when observation times out without marking the child. Terminal,
  timeout, caller cancellation, mark, close and fault races remove waiter/timer/listener state exactly once.
  The exact handle type remains gated.
- Returned conversation handles reuse the existing restricted `TaskConversation` capabilities as the
  ceiling: scoped `send` plus returned input result/wait/abort, and no raw commit/direct entry/internal
  admission helpers/close/shutdown/unrelated state. Any model-facing status/tail projection must be specified before adding it.
- Later sibling tool calls need one narrow built-in resolver for strict owned descendants of their current
  parent conversation, including ownership through terminal sibling tasks. Fork-only ancestry and unrelated
  roots reject. This future resolver must not broaden generic `runtime.conversation`.

The `pi.tool` adapter, not ordinary tool code, resolves timeout/background publication. An ordinary tool may
return a child ID after local observation timeout, but the `pi.tool` terminal closure rereads that child on
the commit line. A terminal child produces the normal final result; a live child produces the
continues-in-background result while its task retains any shared output. No design may trust stale
`Promise.race` state.

Jobs are job-first: the durable job owns execution/output from the first effect. Ordinary tools will create
them through the gated mediated task operation, not a specialized `startShell` verb and not by adopting an
unfinished promise. A non-adoptable interrupted process is lost unless durable policy explicitly permits
rerun. Recurring schedules use one task ID and named checkpoint phases; no backlog is inferred after
downtime. Terminal notices are passive writes and work in either notification-before-completion order.

#### Shared task output

Task output is the only live-output mechanism; there is no separate preview subsystem. The exact declaration,
reference and facade types are in sections 5 and 7. A task kind declares `TaskOutputSpec<I,O>`. Creation either
uses a compatible `TaskOutputRef<O>` or synchronously computes a new base with `initial(input)`. Runtime
compatibility compares `TaskOutputKind.kind`, not token object identity or structural TypeScript compatibility.

Output is a protected list at a fixed shared address:

```ts
type TaskOutputDelta = readonly Op[];
const taskOutputDeltas = defineList<TaskOutputDelta>(
  { type: "shared", id: taskOutputId },
  "pi.output",
);
```

Persist decoded Chord `Op[]`, not `WireOp[]`, in v1. The first list element is exactly the initial tracker
flush and starts with one `r` base. Every later element is exactly one nonempty flush from the single central
tracker, preserved as one atomic append. Replay folds the elements with `applyImmutable()` into a mutable
strict-JSON tree and then hydrates exactly one authoritative tracker. Tasks receive controlled
`TaskOutput`, never trackers, proxies, raw protected addresses, or independent mutable replicas. After
hydrating a tracker from replayed state, the kernel consumes its synthetic initial `flush()` locally to
establish the baseline; it does not persist that synthetic base. The first later mutation therefore remains
incremental unless the author explicitly calls `replace`.

Several live tasks may reference and write the same task output. There is no mutable owner field or transfer
event. Retirement derives from prospective post-batch live `Task.output` references. The output remains while
at least one exists, retires atomically after the final reference terminalizes, and can never be resurrected.
Private task scratch remains independent.

Tool timeout uses one stable task output: tool T creates O and background job B is created with T's
`TaskOutputRef`. B writes progress directly. T's terminal closure rereads B on the line. If B is live, T
materializes the immutable "continues as B" result and terminalizes while B retains O. If B already won, T
takes the normal completed path. B materializes final O before terminalizing as the last reference. Never
trust stale `Promise.race` state. Marking either task revokes that invocation's mutable output facade before
its signal; fresh abort can only read.

Generation uses the same mechanism with an object wrapper around its `AssistantMessage`; frames mutate the
central task output and Chord emits structured deltas for text, thinking, signatures, tool calls/partial
arguments, metadata, usage and diagnostics. Generation materializes the immutable assistant entry before
its final output reference retires. Tool-specific APIs, if useful, are convenience facades over
`TaskOutput<ToolOutputState>`, not a second storage or writer abstraction.

Each protected output-list append mechanically emits one `task_output` event keyed by stable task-output ID
and carrying that exact decoded delta. `ConversationView.taskOutputs` folds deltas with `applyImmutable()`.
In-process fan-out gives each reducer immutable application rather than sharing a mutable decoded batch. If
wire path encoding is added later, each independently hydrated stream owns one encoder/decoder.

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
forward Context, may run again after crash, and return typed decisions that the built-in commits. A hook may
start and await ordinary durable side work while the built-in retains exchange ownership. Approval/question
policy and durable answer reuse belong to workspace/plugins. Exact namespaced hook scratch access remains a
gated API decision.

A long-lived ordinary background listener injects user events through request-keyed `send`; a trusted
built-in may use the internal request-keyed `write` helper for passive transcript events. It may await the
returned `InputHandle` outside a transaction. It never mutates an already snapshotted provider request;
steering affects the next safe request boundary.

## 15. Watch and backend contracts

### 15.1 Watch

```ts
interface WatchedValue { readonly address: Address; readonly value?: JsonValue }
interface WatchedTaskOutput {
  readonly id: Id;
  readonly kind: string;
  readonly value: JsonObject | readonly JsonValue[];
}
interface ConversationView {
  readonly conversation: Conversation;
  readonly tail: number;
  readonly entries: readonly Entry[];
  readonly context: readonly Id[];
  readonly tasks: readonly Task[];
  readonly taskOutputs: readonly WatchedTaskOutput[];
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
  | { readonly type: "task_output"; readonly id: Id; readonly kind: string;
      readonly delta: readonly Op[] }
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
  | { readonly type: "closed"; readonly reason: "overflow" | "session" };
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
    ctx: Context,
  ): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watchSession(
    options: SessionWatchOptions,
    ctx: Context,
  ): Promise<WatchHandle<SessionView, SessionEvent>>;
}
```

`tail` is an integer from 0 through 10,000. A conversation capture contains its last `tail` logical
fork-visible entries, live tasks directly belonging to that conversation, every distinct task output they
reference, current inbox and exactly the requested values. Conversation watch values may be session addresses or addresses bound to that
conversation; foreign-conversation/task addresses reject. A session watch accepts session addresses only.
A later source-conversation write emits no event for an existing fork. The pure reducer uses `view.tail` to
retain only the newest logical transcript entries. A session capture contains all current conversations and
exactly its requested session values. Rendering uses settled entries, live tasks, task outputs, inbox and
selected values from this one view. A boundary commit removes an inbox element, appends its entry, updates
the protected input result and creates any successor task atomically; its visible entry/inbox/task changes
arrive in one envelope, so clients reconcile stable IDs without a transient duplicate or idle gap.

Capture and subscription registration occur in one line operation. Default capacity is 256 complete commit
envelopes; an explicit capacity must be a positive integer. `start` is synchronous and may be called once.
It delivers commits after the captured storage `Seq` in `readAt`, then live commits, in sequence order. The
view is folded through a whole envelope before its listener runs. Events from one commit are never split.
Same-commit inbox append/remove cancels and emits no inbox event. A commit producing no events after this
subscription's filters is not delivered and consumes no buffer capacity, while the in-process
`handle.view.readAt` still advances. Emit a full `context` event whenever the derived context-ID array
changes, including ordinary entry appends.

When capacity would be exceeded, discard queued commits and close that watch with reason `overflow`; it
never pauses or maintains a hidden advancing view. The consumer reconnects by opening a new watch, whose
atomic capture is the new authoritative state and sequence barrier. There is no resnapshot/resumption API.
`unsubscribe` is idempotent, discards buffered deliveries and prevents future callbacks. If a listener
throws, close only that watch without another listener call and invoke `options.onError` outside the line;
never fault the session. An error thrown by `onError` is ignored. Session close delivers `closed/session` once
unless unsubscribed.

`task_start` is `task.create` at pending. Every `task.set` replacement is derived against its previous full
snapshot: reservation and checkpoint/abort/ownership changes emit `task_update`; a terminal replacement emits
`task_end` and always includes an outcome. Each protected shared append
emits one `task_output`; the reducer applies its delta with `applyImmutable()`. Envelope order places output
before a same-batch final `task_end`, after which the reducer removes an output with no remaining live task
reference. Sharing requires no separate event. Reducers are kind-free and pure. Conversation values are only the explicitly requested addresses; session values are explicitly
configured by the session watch caller in the final Harness API.

### 15.2 Backend construction and durability

```ts
interface StorageBinding {
  readonly storage: Storage;
  close(ctx: Context): Promise<void>;
}
interface MemoryStorageFactory { create(): StorageBinding }
interface JsonlStorageFactory { open(path: string, ctx: Context): Promise<StorageBinding> }
interface SqliteStorageFactory {
  open(path: string, options: { readonly session: string }, ctx: Context): Promise<StorageBinding>;
}
```

JSONL/SQLite `open` acquires the cross-process session lock and finishes replay before returning the
exclusive binding. Binding `close` releases resources and the lock and is idempotent. Memory has no
cross-process lock but its binding still enforces one open Session at a time. Binding lifecycle is outside
the minimal mechanical `Storage` interface.

Every JSONL main, live-scratch and live-shared commit is fsynced before in-memory publication or commit
resolution. Creating the main file, a sidecar or a containing directory requires fsync of the created file
and each affected parent directory before publication. Sidecar unlink need not be directory-durable because
the fsynced main record proving retirement is authoritative. No weaker durability mode exists in v1.

JSONL uses one main file, one file per live task scope, and an optional file per live shared task output that
has post-creation deltas, all sharing the sequence. Task creation and its initial output base exist only in
the atomic main record; creating an output does not require a shared sidecar. Each newline-terminated record
is:

```ts
interface JsonlRecord {
  readonly first: Seq;
  readonly last: Seq;
  readonly writes: readonly Write[];
}
```

`last - first + 1` equals `writes.length`. Replay initializes the next-ID allocator after the greatest
conversation, entry, task or list-element ID carried by retained canonical writes. Creation and element IDs
are validated as Storage-minted identities and need not match any sequence.
Replay main first, including each live output's initial protected base append. From its final live tasks,
derive the live scratch IDs and distinct live task-output refs; then replay only their existing sidecars as
later deltas. A missing shared sidecar means no post-creation write. Retired scratch/shared files are ignored
even if malformed, so a stale file cannot resurrect state. Every retained shared record contains only
protected shared-address writes, and replay folds it after the base already recovered from main. Retained sequence ranges increase within each file and never overlap
across retained files; gaps are valid. Validate file scope, task/address references, object IDs, output refs
and lifecycle/scope structure. Reopen derives the next-ID allocator from all complete retained
creation/list-append writes; the Session's last applied `Seq` is the maximum complete retained endpoint
including clear/remove.

A torn suffix is bytes after the final newline. Truncate those bytes and fsync before append. A
newline-terminated record that is malformed JSON or structurally invalid fails open. Persist and fsync the
record before applying it to memory.

SQLite uses indexed conversations, full immutable entry facets, current tasks, values plus rewindable
versions, list elements/clear markers, task scratch, shared task-output refs/deltas and commit boundaries. Index
task status/abort/conversation/kind/output ID and entry conversation/head/kind. Terminal transaction deletes scratch rows atomically. Reopen
loads live tasks and named owner records, not terminal history into residency. Version mismatch rejects.
Use durable SQLite transactions with `PRAGMA synchronous=FULL` or an explicitly documented equivalent at
least as strong. Journal mode is backend-private if locking, atomic scratch retirement and conformance hold.
There is no migration API until the gated migration package is specified.

### 15.3 Cloudflare Durable Object host guidance

Pico scheduling and platform wake-up are separate. One Durable Object should naturally host one Pico
Session, one open Harness and its one scheduler, covering the root and every fork/owned conversation.
Cloudflare alarms or one logical Cloudflare Task may wake an evicted process; they do not become a second
effect-recovery authority and must not create one lane or scheduler per conversation.

```text
request wake -> open Pico -> send() durably admits -> send() ensures resume -> scheduler runs
alarm wake   -> open Pico -> resume() -> all eligible tasks in all conversations run/recover
```

The merged Cloudflare Agents lane example uses explicit per-lane admission/execution passes because that
lane runtime requires them; Pico must not copy that shape. If Pico admission and the platform wake cannot share
one transaction, an adapter needs a small ordered handoff or idempotent retry rule so acknowledged durable
work can always wake another process. Cloudflare's invocation limit still bounds one uninterrupted external
effect; Pico checkpoints and `recover()` remain authoritative across wakes.

## 16. Complete foundation race matrix

Every race is tested in both orders with fake clocks/effects and storage barriers:

- Persistence paused after construction: readers see old complete state.
- Commit callback throws after creating objects: no Storage commit or writes; minted IDs remain burned in
  that open binding but may be reused after reopen because they were never committed.
- Explicit read before first write succeeds against committed state; explicit read after a buffered write
  rejects `ReadAfterWrite` without persistence.
- State-only writes advance `Seq` without calling `nextId`; a later creation proves object ID and write
  sequence are independent. Reopen initializes the next-ID allocator from that committed creation.
- Send durable but reply lost: request-key retry and lookup return the original `InputHandle`.
- Duplicate request key in one transaction or through another conversation: session-wide first receipt wins
  without payload comparison and no second inbox item/task is created.
- Idle send atomically places the input, records result/receipt and creates exactly one generation.
- Busy send atomically queues followUp by default, records result/receipt and creates no task.
- Main plus scratch in one batch: reject all.
- Effect returns versus abort mark: one invocation; fresh abort only after old return.
- Post-mark main/scratch builder: reject before callback.
- Normal closure versus mark/close/fault: commit before mark wins; otherwise closure is not invoked.
- Closure throws: no closure writes/outcome; session faults.
- Terminal persistence uncertain: fail-stop; closure not retried on handle.
- Pending task marked before reservation: execute never runs; fresh abort does.
- Repeated abort mark while abort runs: abort Context remains active.
- Close versus commit: admitted earlier commit finishes; later mutation rejects; completion messages admitted.
- Shutdown versus send: send commits before the mark batch or rejects; queues are preserved.
- Shutdown crash before child cleanup: reopen plus resume runs fresh aborts and preserves child queues.
- Broken abort handler: idle waits/shutdown reject; invocations join; Session closes with the task durable.
- Open invokes no task callback; one resume dispatches all eligible restored tasks in every conversation.
- Resume versus main commit in both orders: no eligible task is missed and no task is invoked twice.
- Main commit while a drain exits: dirty/kick handoff cannot lose work; many commits coalesce safely.
- Send, input wait and abort on an inert open each ensure one session-wide resume.
- Tasks in different conversations run concurrently; foreground and background both run; background
  continues after foreground idle.
- Task abort preserves queued future input unless the explicit conversation policy withdraws it.
- Generation terminalization atomically creates all tool tasks and their one post_tools dependent.
- Each tool terminalization atomically appends its one result entry; parallel completion may determine
  transcript order, while model projection restores assistant call order. Post_tools starts once after every
  tool is terminal and atomically places its boundary and creates its continuation.
- Final-answer terminalization atomically resolves the active input group and creates the selected follow-up
  successor generation.
- Cancelled task/input/idle waiter removes only that waiter/listener and never affects execution.
- Dependency terminal versus dependent reservation: dependent starts once.
- Direct self-wait and dependency cycles reject before durable deadlock.
- Background collapse plus idle send: generation may start concurrently because collapse is not in the fixed turn-task set.
- Collapse concurrent with generation plus listener send: generation boundaries retain inbox authority.
- Collapse abort with queued input: no successor; queue remains for a later idle send.
- FollowUp send versus final answer: queued then consumed, or consumed by the boundary transaction; never
  lost or duplicated. Steering versus post_tools is tested in both orders.
- Queued write versus post_tools preserves the complete assistant/tool-result block.
- Queued head versus newer head: placement writes unanswered/stale, not session fault.
- Parallel tool completion either order: post_tools starts once and projects call order.
- Abort versus post_tools closure: no unmarked successor and every active input resolves once.
- Withdraw versus place input: one terminal result.
- Several inputs in one group: all done results name the same answer.
- Overflow chain: collapse and replacement atomic; no invocation waits on collapse.
- Competing summary head: stale failure; intervening edits do not stale.
- Watch capture versus commit: base includes commit or stream delivers it, never gap/duplicate.
- One boundary envelope contains inbox removal, entry placement, result update and successor creation without
  a transient duplicate or idle gap.
- A fork sees selected historical/config state, inherits no tasks or inbox, and executes independently after
  its first send.
- Watch overflow/listener throw: that watch closes; a newly opened watch captures one fresh authoritative
  base without a resumption protocol.
- JSONL main through Seq 100/live scratch through Seq 150: reopen at applied Seq 150 and initialize
  `nextId()` after the greatest created/list-appended ID in all retained complete records.
- Terminal Seq 151/unlink failure: ignore scratch even malformed; applied sequence remains 151 and IDs are
  never reused.
- JSONL torn final suffix versus malformed complete line: truncate only former.
- 100,000 terminal children/two live tasks: open reads live seed and required ancestry only.
- Missing owner kind with registered descendants: owner orphaned and scratch retired; descendants marked,
  queues retained, later session resume runs their fresh abort.
- Ordinary task-kind replace/remove versus a live instance: reject without registry change; after every
  instance is terminal, replacement affects only future creations.
- Ordinary runtime/transaction has no direct-entry or core-task-creation surface; casts add no implementation.
- New task plus initial task-output base: both persist or neither; `initial` is not called for a supplied ref.
- Two tasks mutate one task output: central tracker commits deltas in line order without a lost update; a
  permitted shared `Write[]` with multiple authorized appends preserves every append atomically.
- Mark versus task-output mutation: commit before mark wins; otherwise mutation rejects before callback.
- Last reference terminal versus same-batch child sharing: prospective references retain output; otherwise
  final materialization and retirement are atomic.
- Task-output delta versus watch capture/overflow: base or exact ordered delta, never gap/duplicate/mutable
  alias.
- Shared sidecar after terminal/unlink failure: reopen ignores it; no resurrection.
- State adapter live transitions through several phases: scheduler calls generated `execute` once; each next
  handler receives the authoritative post-commit checkpoint/owns projection.
- Initial child creation versus crash: no transition commit means initial reruns with no child; committed
  child plus first checkpoint dispatches the next phase without duplication.
- Crash after an inflight checkpoint versus a start checkpoint: generated `recover` dispatches required
  inflight recovery versus normal start run, once per restored invocation.
- Same-phase bookkeeping commit versus abort: child/reference and complete parent checkpoint both commit
  before the wait or neither does; post-mark commit rejects.
- State transition versus abort mark: transition-first may admit the next fenced handler; mark-first prevents
  that handler call and unwinds the outer invocation before fresh abort.
- Known runtime/handle line reentry rejects `NestedLineOperation` before queueing.

## 17. Ready implementation packages

Every package is a separate commit. Before each commit run its focused test and `npm run check`; do not run
the full credential-sensitive suite. Each package may use an internal kernel with supplied test kinds and
memory storage; it need not expose incomplete production Harness behavior.

### WP1 — Core types and kind witnesses

Prerequisites: none.

Deliver:
- strict JSON, distinct `Id`/`Seq`, entry, conversation, task/checkpoint/outcome and address types, including
  background mode and non-rewindable shared scope identity;
- `EntryKind`, ordinary `TaskKind`, fixed-core `CoreTaskKind`, `TaskOutputKind`, typed/erased output refs and
  payload extractors;
- ordinary versus core runtime/transaction/output/closure declaration types, with method bodies deferred;
- no imports from existing harness implementation.

Accept:
- compile tests for exact ordinary/core task input, full checkpoint with phase, kind-specific outcomes and
  no-output/owned-output/compatible-shared-output surfaces;
- ordinary normal/final/abort transactions have no direct entry or core creation; core variants do;
- `CoreTaskTx.task` accepts ordinary and core children through the same method name;
- incompatible checkpoint shape rejects; structurally identical shape is documented assignable;
- Pico declarations introduce and explicitly spell no `any`; imported pi-ai types are exempt;
- compile-only focused test and repository check green.

### WP2 — Mutation algebra and MemoryStorage

Prerequisites: WP1.

Deliver:
- exact canonical `Write` algebra and the minimal Storage interface, with no claim/close/kind-name methods;
- mechanical application of canonical writes and full `task.create`/`task.set` records;
- synchronous `Storage.nextId()`, storage-assigned write sequences, committed next-ID recovery from canonical
  creation/list-append writes, and empty-write behavior;
- conversations, entries, complete task snapshots and terminal scratch/shared retirement;
- current and rewindable values/lists including tombstones/clear/remove;
- ascending conversation scans, fork-aware newest-first entry scans, dedicated newest head, ascending task
  scans, complete ordered list reads and the exact cursor/filter rules in section 6.2.

Accept:
- hand-built `Write[]` conformance for every query and write;
- returned `Seq[]` aligns one-for-one with writes and demonstrably differs from Session object IDs;
- rejected storage commit leaves durable state and internal sequence unchanged while already-minted IDs stay
  burned in the open binding;
- a terminal task snapshot makes scratch unreadable atomically and retires unreferenced shared output;
- fork/history/deep-cap tests; scans have no `readAt`; complete list reads are coherent at one state; callers
  honor the readonly durable-value contract;
- focused test and repository check green.

### WP3 — Commit line and raw transaction kernel

Prerequisites: WP2.

Deliver:
- FIFO async Session line serializing calls to synchronous `Storage.nextId()`;
- synchronous buffering into one canonical `Write[]`; explicit async committed reads only before first write;
- process-local ID burning on failed callbacks and the rewindable-before-entry rule;
- ordinary/core/abort transaction construction and capability separation;
- narrow pending/reference indexes for semantic helpers, with no general overlay or read-your-writes;
- atomic task-output base creation, compatible reference admission and protected namespace/kind checks;
- no public send/InputHandle/runtime handles yet; admission helpers remain internal.

Accept:
- concurrent callbacks serialize; an allowed async read holds the line; read after first write rejects
  `ReadAfterWrite`;
- creation/list-append builders call only synchronous `Storage.nextId`; callback failure burns those IDs in
  the binding, and callback success invokes `Storage.commit` exactly once;
- reopen may reuse never-committed IDs but starts after every committed created/list-appended ID; object IDs
  and returned storage sequences are distinct;
- same-callback references validate only through private semantic indexes and are not author-readable;
- an ordinary transaction cannot instantiate a core token; casting adds no direct-entry implementation;
  typed data-only host entry works;
- managed/protected generic writes reject;
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
- queued/input-result/acceptance schemas and protected addresses, including conversation-scoped sticky inbox
  identity/current materialization and direct protected result/receipt point lookup;
- fixed turn-task classification by the live `pi.generation`/`pi.tool`/`pi.post_tools` set directly in each
  conversation, evaluated prospectively over complete batches; no persisted busy flag or payload inspection;
- protected core-task creation unavailable to ordinary task/host transactions;
- internal async in-transaction accept/queue/write with committed pre-write lookup and private pending-key
  dedupe, moved behind the protected admission capability;
- `SendInput`/`InputHandle` declarations and an internal/test send facade; final public Harness export remains
  gated, and scheduler-backed wait/activation integration belongs to WP7;
- safe enqueue and placement revalidation;
- post-tools/final/idle boundary transaction helpers;
- pure prospective fixed-turn-set idle-boundary planner, without provider execution or payload inspection.

Accept:
- complete followUp/steer/write mode table; idle send same-batch append/remove; busy send queues without task
  creation; duplicate keys including same batch and cross-conversation retry;
- inbox reads one complete current materialized ordered collection without per-read log replay; forks inherit
  no inbox; result/receipt reads perform no list scan;
- independent `steeringMode`/`followUpMode` all-versus-oldest selection, default one-at-a-time, preserves
  global inbox order and unselected relative order; no v1 queue/drain bound;
- ordinary tasks never affect admission busy; core task creation is accepted only from protected admission or
  `CoreTaskTx`, and generation may instantiate fixed tool/post_tools children through `tx.task`;
- create conversation + internal accept through the private fixed-generation strategy + parent checkpoint atomically;
- speculative collapse does not make admission busy; concurrent collapse/generation traces;
- stale queued head terminal result; no fault;
- queued ownership never inferred from arbitrary checkpoints.

### WP6 — Terminal-closure task kernel and scratch

Prerequisites: WP5.

Deliver:
- pending `task.create` and durable full-snapshot running reservation;
- one central Chord tracker per live task output plus controlled read/mutate/replace facade;
- ordinary/core capability-specific execute/recover runtimes and normal terminal closures;
- invocation identity/slot; atomic completed/failed outcome plus scratch retirement;
- scratch transactions and normal closure seal/disposition behavior;
- focused scheduler fixtures using typed test kinds while activation remains deferred to WP7.

Accept:
- running intent precedes effect; reopen chooses recover including no checkpoint;
- repeated recovery from newer checkpoint under stable ID;
- one closure outcome, same-commit Storage-minted result ID, throwing closure rollback/fault;
- normal closure commits exactly once when still authorized; WP8 adds mark/close/fault discard races;
- scratch crash retention/terminal retirement/post-retirement rejection;
- shared output concurrent writes, final closure read/materialization and reference-derived retirement.

### WP7 — Session scheduler, dependencies and waits

Prerequisites: WP6.

Deliver:
- disabled-scheduler bootstrap plus loading of the complete live-task/dependency seed needed by an internal
  reopen/test factory; final binding lifecycle and Harness integration remain in WP8;
- one inert-until-resumed scheduler over that complete Session live/dependency index;
- idempotent `resume`, unconditional coalesced post-main-commit kick and no-lost-dirty drain handoff;
- foreground-idle accounting while foreground and background tasks both execute;
- task/input/idle point waiters that observe only and ensure resume when progress-seeking;
- task dependency-cycle and direct/dependency self-wait checks, with no execution ownership scopes.

Accept:
- open invokes nothing; resume dispatches every eligible task across all conversations;
- dependencies mean terminal and wake once; terminal/dependency commits kick successors;
- distinct task IDs, including root/fork tasks, run concurrently; one task ID has one invocation;
- resume/main-commit and commit/drain-exit races lose no kick and duplicate no invocation;
- many kicks coalesce while all eligible tasks reserve; background continues after foreground idle;
- input result/missing/terminal-fast-path/caller-cancel and task/idle waiter cleanup have no leak;
- send and input wait on an inert reopen resume the Session; abort activation and close/fault/shutdown waiter
  behavior are tested in WP8.

### WP8 — Cancellation and lifecycle

Prerequisites: WP7.

Deliver:
- mark/revoke (including mutable task output)/signal/join/fresh-abort sequence and abort runtime construction;
- restricted repeated ordinary/core abort commits and mark/close/fault normal-closure discard;
- conversation abort operation, completion wait and queue policy;
- close, shutdown and fault phase machines with shared repeated completions;
- integration of the WP7 disabled-scheduler/live-task bootstrap into final Harness initialization, including
  exclusive Storage binding, required ownership ancestry, task-registry capture and missing-kind orphan
  reconciliation; any loading/validation/reconciliation failure closes the binding before rejecting.

Accept:
- every cancellation/lifecycle row in section 16 applicable to memory;
- fresh abort checkpoint/reopen with read-only task output; repeated mark does not cancel abort;
- core passive abort writes but no future work; core tool direct abort result; ordinary abort has neither;
- close writes no outcomes; shutdown marks all and preserves queues; fault preserves unfinished state;
- task/input/conversation abort on an inert Harness commits its durable request, resumes the Session and
  completes the specified cleanup without changing scheduler scope;
- initialization starts nothing; every missing live ordinary kind orphans, retires scratch and marks
  descendants; ordinary task replace/remove rejects while that kind has a live instance;
- failed reconciliation yields no usable Session; no history scan beyond live seed/required ancestry.

### WP8A — State-indexed task authoring adapter

Prerequisites: WP8.

Deliver:
- exact `defineStateTask` declarations, action constructors and compile tests from section 5.1;
- generated ordinary `TaskKind.execute`/`recover` dispatch loop with no scheduler changes;
- module-private transition commit bridge returning the authoritative applied task projection;
- initial/start/inflight role dispatch, same-phase-only checkpoint-backed commits, and a cancellation fence
  before every internal handler call;
- no built-in generation/tool/provider implementation.

Accept:
- broad-string checkpoints reject; phase maps and handlers reject missing/extra literal, variable and spread
  fields; each handler receives its narrowed complete checkpoint variant;
- inflight requires recover; start forbids it; initial has no checkpoint and no commit;
- transition payloads reject missing/extra literal, variable, spread and async-return fields while preserving
  output/terminal-closure typing;
- initial child creation and first checkpoint are one transition batch in crash tests; checkpoint-backed
  same-phase child creation commits before wait; direct intermediate phase change rejects;
- one scheduler execute across multiple live transitions; reopen dispatch matrix for absent/start/inflight;
- transition result includes checkpoint/owns from the applied projection with no fabricated task or empty
  follow-up commit;
- transition-versus-mark passes in both orders: a winning mark prevents the next handler call;
- no workflow history, positional replay, generator, one-plan-at-end rule or specialized effect verbs.

### WP9 — Watch foundation

Prerequisites: WP8.

Deliver the kind-free commit-derived view/event reducer, including `taskOutputs`/`task_output`, atomic
capture/subscription, bounded overflow closure and reconnect-by-new-capture. There is no lag/resnapshot or
preview subsystem.

Accept the watch races and task lifecycle event meanings in sections 15–16.

### WP10 — JSONL backend

Prerequisites: WP8; WP9 only for cross-backend watch tests.

Deliver the backend and all recovery rules in section 15. Run the same storage/admission/task conformance
stream as memory, including real process-kill recovery for running/checkpoint/scratch/shared-output/terminal
cases and no-resurrection sidecar cleanup.

### WP11 — SQLite backend

Prerequisites: WP8; WP9 only for cross-backend watch tests.

Deliver indexed persistence/residency, shared task-output persistence/retirement and conformance in section 15. Update the session-backend package only
through a reviewed adapter boundary; no import from existing harness runtime/session implementations.

## 18. Gated packages and explicit decisions

Do not implement these until their listed decision is settled and appended to this specification:

- **Harness open/public handles/fixed core wiring:** wire the single final `Harness` only when the required
  built-in kinds are implemented. It owns root/rootValues, public ordinary registries, fixed core kinds, the
  one session scheduler, `resume`, `send`/`InputHandle`, idle waits and the production generation-admission
  strategy. There is no temporary foundation harness and no public accept/queue/drive composition.
- **Provider generation/system integration:** verify landed pi-ai messages-only behavior and define complete
  generation input/checkpoint/result/failure/abort schemas, retry/usage dedupe and deferred recovery table.
- **Tool/post_tools:** define the complete built-in payload/checkpoint/outcome schemas, bounded/spill policy
  and model-visible projection on settled `TaskOutput`. Specify and review the small ordinary-tool mediated
  memo/task/conversation capabilities in section 14.3; `ToolDefinition` code never receives task commit
  authority. Job-first only; no arbitrary promise adoption.
- **Hooks:** define task identity and namespaced scratch capability, then confirm hook points/typed decisions.
- **Collapse provider implementation:** define summarizer request/checkpoint/result schemas and retry budgets;
  the context/head/chain foundation above is ready.
- **Jobs/subagents:** define exact job task payloads and terminal notification protocol on the settled output
  API. A subagent is an owned conversation, not a subagent task. Keyed creation, cancellable task waits and
  later sibling-tool resolution remain part of the gated ordinary-tool capability design.
  Ownership/admission/wait foundations are ready.
- **Typed system sections:** define the concrete draft/persistence API and preparation staleness retry code
  after pi-ai verification; section 14.4 fixes required semantics.
- **Client/rendering integration:** expose renderer projections over task-output watch state; delivery
  coalescing remains deferred.
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
