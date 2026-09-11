# pico v3

A design for the agent harness: how a session is stored, how work is scheduled, and how the
built-in agent behaviour is composed from that. Code in this document illustrates the model; it is
not a package export. In snippets, `call` is the current `Call` (Chord Context, §6.5), required on
asynchronous public/runtime operations; `runtime` is the task/tool capability object. Transaction
builders do not take another Call.

## 1. Goals

**Few concepts, replaceable behaviour.** A session is conversations, immutable entries, durable
tasks, and scoped state. Agent behaviour (generate, run tools, compact, delegate) is written as
task kinds. The scheduler understands task lifecycle, dependencies and cancellation, nothing
about prompts or summaries. Storage understands objects and atomic batches, nothing about tasks.
Replace a task kind and you change the behaviour; the scheduler and storage stay.

**One writer per session.** Execution is concurrent; writing is not. Every mutation, including
working-state writes, goes through one owner that runs commits one at a time. A commit reads
committed state, constructs its writes and their ids, commits them as one batch, then publishes.
Different sessions can have different owners and share a SQLite file. After a crash a new owner
resumes from durable state; it must never run alongside the old one.

**Durable work, explicit recovery.** Accepted work survives a crash, including work that hasn't
started. Opening a session starts nothing. A task records its intent before doing anything external
and commits the outcome together with whatever should happen next. A crash in the middle leaves
uncertainty, not proof that nothing happened; each task kind decides how to recover: retry,
adopt, or report interruption. Nothing promises exactly-once external effects.

**Long sessions without a residency layer.** Old entries and finished tasks are queryable but never
retained because they were once seen. Routine execution reads the current context and the live
tasks; it never scans accumulated history. What memory a backend uses is a backend choice: memory
and JSONL keep everything loaded; SQLite keeps only what queries return.

**Measure.** Same workload on each harness and backend: CPU, process memory, bytes on disk
including sidecars. Small writes, indexed reads, batched lookups. A faster prototype is a reason to
look, not proof that its shortcuts belong here.

## 2. Conversations

A session holds conversations. A conversation has three things:

- a **transcript**: an append-only list of immutable entries (messages, tool results, summaries,
  plugin-defined entries), which is what happened;
- **tasks**: the durable units of work that act on it, such as a generation or a tool call, each
  with a status that changes as it runs (§5);
- **state**: keyed values and lists that plugins and the harness read and write, such as the model
  in use or a plan-mode flag (§4).

What the model sees, the context, is derived from the transcript by a fixed rule. Tasks and state
are never model input by themselves.

### 2.1 Entries and their kinds

```ts
type Id = number;                  // a session sequence number; one alias so the representation can change

type ContextEdit =
  | { readonly target: Id; readonly action: "omit" }
  | { readonly target: Id; readonly action: "replace"; readonly messages: readonly Message[] };

interface EntryIdentity {
  readonly id: Id;                 // its sequence number
  readonly conversationId: Id;
  readonly kind: string;
  readonly byTaskId?: Id;          // which task wrote it
}

interface EntryBase extends EntryIdentity {
  readonly key?: string;           // optional indexed key, e.g. the tool call a result answers
}

interface EntryData<Data extends JsonValue = JsonValue> {
  readonly data: Data;             // kind-specific durable data; never model input by itself
}

interface ModelProjection<Model extends Message = Message> {
  readonly model: readonly Model[]; // provider-neutral messages materialized at append
}

interface ContextHead {
  readonly head: Id;               // first retained transcript entry, inclusive
}

interface ContextEdits {
  readonly edits: readonly ContextEdit[];
}

type Entry = EntryBase & Partial<
  EntryData & ModelProjection & ContextHead & ContextEdits
>;

type UserEntry = EntryBase & ModelProjection<UserMessage>;
type AssistantEntry = EntryBase & ModelProjection<AssistantMessage>;

interface SummaryData { readonly summarizedThrough: Id }
type SummaryEntry = EntryBase & EntryData<SummaryData> & ModelProjection<UserMessage> & ContextHead;
```

The facets combine. A user entry may be only `EntryBase & ModelProjection<UserMessage>`; a tool
result may also carry non-message `EntryData<ToolResultData>` for its renderer; a summary has data,
a model projection and a head; a reset needs only a head. Entries append and are never patched,
reordered or renumbered. Ids increase in transcript order but need not be consecutive.

`model` is the exact provider-neutral message projection chosen by the writer. It is not the final
provider request: context selection, edit folding, tool-exchange normalization and provider
conversion still happen per request. `data` is optional arbitrary kind-specific JSON for typed
logic and rendering. Nothing implicitly derives one from the other, so storing both never requires
duplicating a message.

An entry kind is only a name and type witness:

```ts
interface EntryKind<E extends Entry = Entry> {
  readonly kind: string;
  is(entry: Entry): entry is E;
}
```

A plugin normally keeps append-time construction in a typed helper. It may compute `model`, `head`
and `edits` from its data before calling `Tx.entry`, but no such computation is registered on the
kind or run while reading. Asynchronous inputs are prepared before entering the commit line.

A stored `head` is the inclusive first retained entry id. Presence of the column marks and indexes
the entry as a head. `Tx.entry` accepts `"self"` for reset and handoff drafts and stores the minted
entry id. Every new head must satisfy:

```text
newHead.head >= previousVisibleHead.head
```

The commit line validates this directly from stored entries. A head cannot move context backwards.
Its boundary must also not split an exchange, whoever appends it: the same rule compaction follows
(§2.3), applied to plugin heads so a head can never leave tool results without their call.
Older heads are controls, not retained context entries: the newest head replaces them and carries
any predecessor summary information it still needs.

Stored `edits` omit or replace the model projection of earlier visible entries. Arbitrary edits may
not target managed `system` entries: they could make model instructions disagree with canonical
prepared section state (§8.2), so the commit rejects. The sole exception is generation preparation
appending a complete fresh baseline with omission edits for superseded managed baselines/deltas.
Those controls and their replacement instructions commit together (§8.2). Edits are folded in
transcript order; the newest applicable edit for a target wins. The target entry is never changed,
and an edit whose target is outside the selected range is a no-op. Retained edit entries apply again
on later turns. Tool-result pruning and shortening are edits. Dynamic policies such as "always keep
only the last N exchanges" are unsupported; code appends a new head or edit when context should
change. There is no `compose` callback or read-time entry-kind behavior.

The built-ins are `user`, `assistant`, `tool_result`, `system`, `notice`, `summary`, `handoff` and
`reset`. Their writers materialize model messages when they append. `reset` stores no model;
`handoff` stores its message and starts a context; managed `system` entries store the exact pi-ai
`SystemMessage` prepared at their transcript position. They record canonical prepared instructions,
not proof that a provider received them. Pi-ai owns provider translation and best-effort cache
preservation; immutable entries alone do not guarantee an unchanged wire prefix:

```ts
type SectionChange =
  | { readonly key: string; readonly action: "set"; readonly value: JsonValue; readonly rendered: string }
  | { readonly key: string; readonly action: "remove" };

interface SystemData {
  readonly baseline?: true;              // complete prepared section state (§8.2)
  readonly sections?: readonly SectionChange[];
}

type SystemEntry = EntryBase & EntryData<SystemData> & ModelProjection<SystemMessage>
  & Partial<ContextEdits>;               // fresh baseline may omit superseded managed entries
```

A baseline stores the complete ordered section state as set records. A delta stores changed sets
and explicit removals. Payloads are JSON; null is a valid payload, not deletion. `rendered` is the
final section text, so a missing renderer never prevents replay or construction of a fresh baseline.
Diff by key, payload and rendered text; reordering alone emits nothing. A payload-only change still
persists a section-state delta but needs no instruction message (`model: []`). Rendered changes and
removals produce materialized system messages. Never parse prose to reconstruct section state.

Complete tool definitions are stored only in the SystemMessage `toolsAdded`/`toolsRemoved` fields,
not duplicated in `data`. Added definitions are upserts by name, including same-name schema changes;
removals contain the previous complete definitions. Apply removals before additions. Section and tool
names are unique within their respective change lists; structural comparison ignores incidental JSON
object-key order. Plugin-defined entries omit `model` when the model should not see them. The kind
types reads and writes; stored objects are trusted after wire validation (§7.3), and a kind that changes
its data shape ships a migration.

```ts
type ToolResultEntry = EntryBase & EntryData<ToolResultData> & ModelProjection<ToolResultMessage>;
const toolResultKind = defineEntryKind<ToolResultEntry>("tool_result");

tx.entry(toolResultKind, conversationId, { data: resultData, model: [message], key: callId });
const e = await harness.getEntry(summaryKind, id, call);                  // SummaryEntry | undefined
const any = await harness.getEntry(id, call);                             // Entry | undefined
if (summaryKind.is(any)) any.data.summarizedThrough;                // narrowed
```

Without a kind, a read returns the untyped entry. A typed read of another kind returns `undefined`,
the same as a missing entry; batched reads omit it. The session records the distinct kind strings
without scanning entries. Open reports an unregistered entry kind but does not reject: stored
`model`, `head` and `edits` preserve context, while only kind-specific typing and rendering are
unavailable.

### 2.2 Context is derived, not stored

The generation derives context from the transcript:

```text
H       = newest entry with stored `head` visible at the request/fork target
from    = no H → transcript start; otherwise H.head
range   = fork-aware transcript entries from `from` through target, inclusive
controls= fold stored `edits` in transcript order
context = no H → eligible range entries
          H exists → H, then eligible range entries excluding every head
          omitted targets disappear; replaced targets keep their id and use replacement messages
messages= concatenate stored `model` arrays; normalize tool exchanges for the selected model
```

An entry without `model` contributes no messages. An edit entry may independently have a model
projection. Existing tool results are placed with their calls in call order. For a successful
assistant cut before all its results, request-local pi-ai transformation supplies missing results;
results beyond the fork cutoff and source tasks are never inherited. Error/aborted assistant
outputs are excluded from subsequent requests and never create tool tasks/results.

No context list is stored, so nothing can drift from the transcript. A conversation handle keeps an
optional process-local cache of the current derived entries, candidate membership and winning edits.
`contextEntries(through)` loads it once, catches it up with entries after its cursor, slices it from
the stored boundary when a new head arrives and folds stored edits. Generation tasks receive that
handle; `ConversationView` exposes the resulting context ids. A historical target older than the
cache is derived separately and does not rewind it. Each request receives an immutable snapshot.

On a cold handle, cost is the fork-aware candidate range plus edit folding and fork depth, not
necessarily the final projected-message count. Memory and JSONL answer from their in-memory indexes;
SQLite performs indexed head/range reads. Warm handles process only appended entries. The cache is a
convenience owned by the handle and may be garbage-collected with it; the transcript is the truth.
Generation preparation persists `state.requestThrough` and captures its effective context snapshot
on the line after the complete batch is durable (§8.2). The snapshot copies the selected reference
array, not immutable entry bodies. Later cache updates never mutate that array or its effective
replacement projections; request-local normalization/hooks copy what they change. Historical cutoff
reconstruction does not rewind the live cache, and request-only references are released after use.

### 2.3 Compaction and reset

**Compaction** appends one summary with a stored model projection and head boundary:

```text
transcript  [10 user, 20 asst, 30 user, 40 asst]         context [10, 20, 30, 40]
append      50 summary { model:[summary], head:30 }
scan        [30 user, 40 asst, 50 summary]
context     [50 summary, 30 user, 40 asst]
```

The summary is newer than 30 and 40 but projects before them. The summarized prefix must end on a
complete exchange, lie inside the current context and include the previous head's information.
Managed system entries retained across a head are explicitly superseded by the next prepared baseline
(§8.2); this does not split the retained tool exchange or add hidden filtering to generic projection.
A summary prepared against an old context
may still land later: ordinary entries appended while it runs are at or after its prepared retained
boundary and remain in the range. Only a competing head invalidates it; intervening context edits
do not (§8.4).

**Reset** appends a `handoff` head with `model` or a `reset` head without it. Both pass
`head: "self"` to `Tx.entry`, which stores the new entry id as the boundary. The transcript keeps
everything. Reset by itself neither cancels tasks nor requests a response.

### 2.4 Forks share history, not future changes

A fork is a new conversation whose transcript starts as a prefix of its source, shared by
reference: entries 10 and 20 below keep their ids and their owning conversation; nothing is copied.

```text
A: 10 ─ 20 ─ 30 ─ 40 ─ 50 ─ 70
          └──────────── 90 ─ 100     B, forked at 20
B transcript: [10, 20, 90, 100]
```

Because context is derived from the transcript, B's context is what A's context was at the fork
point: the newest head among `[10, 20, ...]` is the one that existed then, and none that A added
later can be seen. Later appends, compaction and resets in A cannot affect B. Live tasks are not inherited;
continuing B is new work.

### 2.5 History and ownership are different relationships

```ts
interface Conversation {
  readonly id: Id;
  readonly parent?: { readonly conversationId: Id; readonly at: Id };   // forked from, at entry
  readonly owner?: Id;                                                       // task that created it
}
```

```text
history:    A ── fork at P ──> B         B: parent = A at P, no owner; independent
ownership:  A ── task T ── owns ──> C    C: owner = T; a child, e.g. a subagent's conversation
```

A fork never enters its source's drive or cancellation scope. An owned conversation does, through
the task that owns it. A child can start with fresh or inherited context; that is separate from
which state it is initialized with (§4.3).

## 3. Identity and commits

### 3.1 Ids are minted while building the commit

One session-wide sequence orders every mutation. A creation's sequence number is the object's id.

```ts
// last committed: 99
const entryId = await conv.commit(tx => {
  tx.value(planMode).set(true);                                             // 100
  const id = tx.entry(userKind, { model: [message] });                      // 101
  tx.task(generationKind, { state: { status: "pending", input: id } });     // 102
  return id;
}, call);
// one batch [100–102] persisted and published; entryId === 101 here
```

A commit can reference ids it just minted. It cannot hand them to an external service or return
them to a caller before the batch is durable. A rejected commit consumes nothing: the next one
starts at 100 again. Numbers are positive safe integers; no uuids, no reserved ranges.

### 3.2 Rewindable conversation state before entries

A commit can write rewindable conversation state and an entry together (a tool that turns on plan
mode and writes its result), and a fork at that entry must include the state. It must not include
state committed later: a `/model` change made after an answer belongs to a fork made after it, not
to a fork at the answer. So the boundary is exactly the entry's commit, and the way to know it
without a field, a stamp or a lookup is write order: **in one commit, rewindable conversation value
and list writes come before entries.** Sequence order is call order, so the state is numbered below
the entries, and a fork at entry X selects the fork-visible transcript and rewindable conversation
history through X:

```ts
// tool settlement, one commit
await runtime.commit(tx => {
  tx.value(planMode).set(true);                             // 300
  const result = tx.entry(toolResultKind, { data: resultData, model: [message] }); // 301
  tx.settle(task, "done", { call: task.state.call, assistant: task.state.assistant, output, result });   // 302
}, call);

await conv.value(model).set("claude-opus-5", call);               // 303, a later commit

const b = await conv.fork({ at: 301 }, call);      // has the result and plan mode; does not have the new model
```

The builder throws if a rewindable conversation value/list write follows an entry; the plan fails
before persistence and consumes no ids. Session state and sticky conversation state may appear
anywhere because forks do not reconstruct their history, so they may reference ids minted earlier
in the same commit. Tasks also go anywhere; they are not inherited by forks and usually come after
the entries they name. Historical reads (§4) take an entry as their position; "before the first
entry" is the empty position. Any transcript entry is a valid fork point, including an assistant call
or one of several tool results. Projection repairs the resulting successful incomplete exchange for
the request only; it never inherits or executes the source tasks.

### 3.3 Failure before and after admission

Validation failure: no writes, no ids consumed, the session keeps working. Uncertain persistence:
stop using this handle, reopen, recover the last complete batch and its `lastSeq`, continue
from that. No observer ever sees half a commit. An effect must not treat an uncertain write as
permission to redo the same external action with new ids.

### 3.4 Request keys name acceptances

Every accepted input has an `inputId`, the id of its `pi.inbox` list element (§8.1). A caller may
also supply an opaque request id. Acceptance atomically stores a session value from that key to the
new identity:

```text
400  append pi.inbox item                         inputId = 400
401  inputResult[400] = queued or placed
402  request["req-42"] = { conversationId, inputId:400 }
```

`harness.acceptance(requestId, call)` returns that receipt, for a caller whose accept response may
have been lost. A request key names one acceptance for the life of the session: a second `accept`
or `queueInput` with the same key writes nothing and returns the stored `inputId`, whatever its
payload or mode. Nothing is compared, so no content or digest is kept for that purpose; a client
that reuses a key for different input gets the first acceptance back, and `result(inputId, call)`
says what became of it. Without a request id, no mapping is written. The mapping is session state,
so it may follow and reference the newly minted inbox element.

## 4. State

State is addressed independently of the transcript. Its writes share the sequence, so one
position (an entry, §3.2) selects context and rewindable state together.

### 4.1 Scopes

| Scope | Rewind | Lifetime |
|---|---|---|
| Session | Sticky: one current value | The session |
| Conversation | Rewindable or sticky, chosen per address | The conversation and its fork history |
| Scratch | Never rewound, never inherited | One live execution, until settlement |

```ts
const sessionName = sessionValue<string>("pi.session.name");
const plan        = conversationValue<boolean>("plugin.plan", { rewind: true });
const expanded    = conversationValue<boolean>("ui.expanded", { rewind: false });
const moves       = conversationList<Move>("game.moves", { rewind: true });
```

```ts
type Scope   = { session: true } | { conversation: number } | { scratch: number /* task id */ };
interface Address { readonly scope: Scope; readonly namespace: string; readonly key?: string; readonly rewind: boolean }
interface Value<T> extends Address { readonly __value?: T }     // phantom: the payload type
interface List<T>  extends Address { readonly __list?: T }
```

An address binds namespace, key, scope and rewind policy, and carries its payload type. The
constructors above make `Value<T>`/`List<T>` for a scope; a conversation handle binds
`conversation: id` itself, so plugin code writes `conversationValue("plugin.plan")` and never the id.
Values are strict JSON; reads return copies. A conversation address cannot be used as a session address.
Storage persists scope and policy; nothing depends on the address object surviving a restart.

### 4.2 Vocabulary

```text
value:  tx.value(addr).get(), .set(v), .delete()
list:   tx.list(addr).append(v) → element id, .remove(id), .clear(), .read(cursor, limit)
```

A rewindable history reads as of an entry (§3.2): a list appended at 40 and 50, cleared at 60 and
appended at 70 reads `[A, B]` at entry 55, `[]` at 65, `[C]` at 75. A remove hides one element the
same way a clear hides all of them. Clear hides; it doesn't erase
what an earlier fork needs. Deleting a rewindable value records absence. Sticky state exposes only
its current contents, so a removed sticky list element may be discarded physically.

### 4.3 Initialization is explicit; forks inherit

A new child conversation (a subagent) chooses its initial state independently of its context:

```ts
spawn({ prompt, context: "inherit",
        values: { inherit: [generationKind.config.model, generationKind.config.thinking],
                  set: [[generationKind.config.selectedTools, ["read", "grep"]]] } })
```

One commit creates the child, copies the selected current values, applies overrides, appends the
user prompt, creates the first generation; that generation writes the child's first `system`
entry from `system_instructions` (§8.2). Unselected values are absent in the child. Lists are not
copied unless a policy says so.

A historical fork inherits differently: all rewindable history as of the fork position, no sticky
state unless selected, the same session state, no scratch.

### 4.4 Capped-source lookup

A fork stores no copies. Reading a rewindable address in fork B, forked from A at an entry:

```text
read(B, addr, at):                             // at = an entry id
  local version ≤ at?  set → value; delete → absent
  no parent? absent
  read(B.parent.conversationId, addr, min(at, B.parent.at))
```

Lists combine inherited ranges with local appends the same way, honouring clears at every level.
Cost is fork depth, never unrelated history. A child initialized by copying (§4.3) has an owner but no `parent`, so lookup stops there.

### 4.5 Structured plugin state

Plugins with structured state build it on values and lists: a checkpoint value `{ through, state }`
plus a delta list; hydrate by reading the checkpoint visible at a position and the deltas after it.
The plugin owns its delta vocabulary and reducer; storage runs nothing.

### 4.6 Scratch

Scratch is a task's working state while it runs: streamed frames, a checkpoint, a memo. One scope
per task, any number of addresses in it, durable across a restart, gone when the task settles.

```ts
import { AssistantMessageFrameEncoder, type AssistantMessageFrame } from "@earendil-works/pi-ai";

const frames     = scratchList<AssistantMessageFrame>("frames");
const checkpoint = scratchValue<Checkpoint>("checkpoint");

// a new attempt starts clean; then each frame is one small scratch commit
await runtime.scratch(sc => { sc.list(frames).clear(); }, call);
const { context: streamCall, cancel } = withCancel(call);
const stream = runtime.models.stream(model, request, streamCall);
const encoder = new AssistantMessageFrameEncoder();
try {
  for await (const event of stream) {
    const frame = encoder.encode(event);
    if (frame !== undefined) {
      await runtime.scratch(sc => { sc.list(frames).append(frame); }, streamCall);
    }
  }
} finally {
  cancel();                    // stop this producer on any early exit, not only a task abort
  await stream.result();       // join it; iterator exit alone is not provider completion
}

// after a restart, recover reads what made it to disk
const partial = await runtime.scratch(sc => sc.list(frames).read(), call);

// settlement: the result becomes an entry; settle retires the scope in the same commit
await runtime.commit(tx => {
  const id = tx.entry(assistantKind, { model: [assemble(partial)] });
  tx.settle(task, "done", { inputs: task.state.inputs, assistant: id });
}, call);
```

Persist compact frames, not raw provider events with a growing `partial` snapshot on every token.
The encoder stores content deltas and necessary start/end metadata; terminal outcome/usage is recorded
separately. Tool/job scratch similarly appends explicit output operations or bounded checkpoints.
These are application records in ordinary lists, not a Chord storage codec.

Three rules:

- A scratch commit writes one task's scratch and nothing else; a main commit never writes scratch.
  On JSONL that makes every commit one file (§7.4).
- `settle` deletes the task's scratch in the same commit. Crash before settle: task and scratch are
  both there for recovery. After: both gone.
- A task stops writing scratch before it settles. A frame that arrives late can't recreate what
  settle deleted.

A retry is the same task (§5.3), so an attempt clears the scratch before it starts streaming;
what is on disk is always the current attempt's. Scratch is never inherited, never rewound, never in the transcript; a task that wants to keep
something writes an entry or a value at settlement.

## 5. Tasks

A task is durable work belonging to one conversation. Its kind supplies behaviour; its record
supplies the inputs, progress and outcome that must survive a process.

### 5.1 The record

```ts
type TaskRole = "start" | "inflight" | "terminal";

type TaskStateBase = JsonObject & { readonly status: string };   // state is strict JSON with a status
type TaskRoles<S extends TaskStateBase> = Readonly<Record<S["status"], TaskRole>>;

interface Task<State extends TaskStateBase = TaskStateBase> {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly role: TaskRole;              // materialized from the kind's roles map on every write
  readonly state: State;                // a tagged union; the status is its discriminant
  readonly after: readonly Id[];        // dependencies, fixed at creation
  readonly background?: true;           // fixed at creation; absent = foreground (§5.6)
  readonly turn?: true;                 // materialized from the kind; this task drives a turn (§5.8)
  readonly owns?: readonly Id[];        // conversations this task created (§5.7)
  readonly abort?: true;                // durable cancellation mark (§6.3)
}
```

**State is a tagged union over status.** A kind declares one variant per status, carrying exactly
the fields that exist in it, so nothing is an optional that a reader has to guess about and a
dependent narrows instead of probing:

```ts
type ToolStates =
  | { status: "planned";  call: ToolCall; assistant: Id }
  | { status: "running";  call: ToolCall; assistant: Id; args: JsonObject; replay: "safe" | "never";
                          jobId?: Id; cancelJobOnAbort?: boolean }
  | { status: "done";     call: ToolCall; assistant: Id; output: ToolOutputState; result: Id }
  | { status: "aborted";  call: ToolCall; assistant: Id; output: ToolOutputState; result: Id };
```

The status lives only in `state.status`. Storage extracts it into an indexed column when it writes
the record, so a scan never decodes state, and `role` is on the record because a reader of an
unregistered kind cannot compute it from the kind's map. `Tx` derives the role on every write.
Fields common to every variant must have the same type in each.

A kind maps its statuses to three roles:

```text
start      the driver may call execute        generation: pending, retry_wait, deferred
inflight   intent was committed; call recover  generation: streaming;  job: running
terminal   done; never patched again           generation: done, failed, aborted
```

`Tx.task`, `patch` and `settle` derive the role from the registered kind's status map and persist it
on every write. Storage selects live rows using the role index without inspecting task state or
running kind code. Loading their full records may decode state; terminal history is not decoded.
Callers cannot edit the role independently.

**`orphaned` is derived, not declared.** A kind never writes it and never lists it. The harness adds
one terminal variant to every state union, carrying the fields common to all of the kind's own
variants:

```ts
type CommonPayload<S extends TaskStateBase> = Pick<S, Exclude<keyof S, "status">>;
type Orphaned<S extends TaskStateBase> = CommonPayload<S> & { readonly status: "orphaned" };
type ToolState = ToolStates | Orphaned<ToolStates>; // orphaned carries only call and assistant
```

`keyof S` selects the keys present in every union member; `Pick` keeps their types and optionality.
This is the intersection of field names, not a TypeScript intersection of the variants (which would
intersect incompatible status literals into `never`). Kind definition rejects inconsistent types or
optionality for common fields, and rejects a user-declared `orphaned` status. A field optional in every
variant remains optional on orphaned; a variant-specific field is not exposed.

It is written in one situation only: at open, for a live foreground task whose kind is not
registered in this process (§6.4). The stored record keeps whatever fields it had; the type
promises only the common ones, which is all a dependent may rely on, because the kind never ran its
cleanup. Background tasks of unregistered kinds are parked instead, and resume through `recover`
when their kind returns. This is the only case in which the harness settles a task it does not own.

### 5.2 Kinds

```ts
declare const taskType: unique symbol; // compiler-only witness; never populated or serialized
interface TaskType<S extends TaskStateBase, R extends TaskRoles<S>> {
  readonly [taskType]?: { readonly state: (state: S) => S; readonly roles: R };
}
type TypedTask<S extends TaskStateBase, R extends TaskRoles<S>> = Task<S> & TaskType<S, R>;
interface TaskDefinition<S extends TaskStateBase, R extends TaskRoles<S>> extends TaskType<S, R> {
  readonly kind: string;
  readonly roles: R;
}

interface TaskKind<States extends TaskStateBase, Hooks extends HookPoints = {}, Config extends ConfigSpec = {},
                   Preview = never, R extends TaskRoles<States> = TaskRoles<States>> extends TaskDefinition<States, R> {
  readonly initialStatus: StatesWithRole<States, R, "start">["status"]; // helper in §9.2
  is(task: Task | undefined): task is ReadTask<States, R>;
  readonly turn?: true;                             // this kind drives a turn (§5.8)
  readonly hooks?: HookSpecs<Hooks>;                // the points this kind runs (§8.7)
  readonly config?: Config;                         // the values this kind reads (below)
  preview?: {                                       // what UIs see while the task runs (§9.4)
    init(scratch: ScratchReader): Preview;          //   built once, on attach or reopen, from durable scratch
  };                                                //   afterwards the kind mutates runtime.preview.state in place
  execute(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
  recover(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
  abort(task: TypedTask<States, R>, runtime: TaskRuntime, call: Call): Promise<void>;
}

type ReadTask<S extends TaskStateBase, R extends TaskRoles<S>> =
  TypedTask<S | Orphaned<S>, R & { readonly orphaned: "terminal" }>;
type TaskState<K> = K extends TaskDefinition<infer S, infer R> ? S | Orphaned<S> : never;
```

`Task` remains the raw stored record. `TypedTask` adds only a compile-time witness for the complete
state union and literal role map, so narrowing `task.state` does not lose the other transition targets.
Typed reads include `orphaned`; execute/recover/abort receive only the kind's declared variants.
The witness is not a runtime capability: invocation identity and current durable state still decide
write authority on the line.

Use `defineTaskKind<States>()({ ... })`: the first call binds the declared union (and optional hook,
config and preview types); the second infers the literal roles from the definition. It checks an exact
role-map entry for each declared status, a start-role initial status and common-field compatibility.
Its return type retains `TaskDefinition<States, R>`, including the compiler-only state witness;
otherwise kind-witnessed reads could infer statuses from roles but lose their payload types.
Do not widen the result to a generic `TaskKind<States>` or its roles to `TaskRoles<States>` when using
typed mutations: that would discard the information needed to distinguish patch from settle.

A kind that reads config declares it, so the values it depends on are on the kind and nowhere
else, typed, and usable by callers that initialize a conversation:

```ts
type ConfigSpec = Record<string, Value<any>>;

const generationKind = defineTaskKind<GenerationState>()({
  kind: "generation",
  config: {
    model:         conversationValue<ModelId>("pi.model", { rewind: true }),
    thinking:      conversationValue<ThinkingLevel>("pi.thinking", { rewind: true }),
    selectedTools: conversationValue<string[]>("pi.tools.selected", { rewind: true }),
    profile:       conversationValue<string>("pi.prompt.profile", { rewind: true }),
    budgetMs:      conversationValue<number>("pi.tool.budget", { rewind: false }),
  },
  ...
});

await c.config(generationKind).set({ model: "claude-opus-5" }, call);     // or c.settings.set(...) for the generation
const cfg = await runtime.config(generationKind, call);                         // { model, thinking, ... } typed, read on the line
await c.spawn({ prompt, values: { inherit: [generationKind.config.model],
                                  set: [[generationKind.config.selectedTools, ["read", "grep"]]] } }, call);
```

`runtime.config(kind, call)` reads every declared value in one batched read. A UI can list what a
conversation is configured with by walking the registered kinds' `config`. Values a plugin defines
for itself are declared on the plugin's own kind the same way.

`TaskRuntime` is what an execution gets from the driver:

```ts
interface TaskRuntime {
  readonly taskId: Id;
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
  scratch<T>(plan: (sc: ScratchTx) => T | Promise<T>, call: Call): Promise<T>;
  readonly preview: Tracker<Preview>;              // flushed after successful scratch commits
  now(): number;                                  // injected clock, not Date.now() in task code
  sleep(untilMs: number, call: Call): Promise<void>;
  config<C extends ConfigSpec>(kind: { readonly kind: string; readonly config?: C }, call: Call): Promise<ConfigValues<C>>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  abortTask(id: Id, call: Call): Promise<void>;
  waitForTask(id: Id, options: { budgetMs?: number } | undefined, call: Call): Promise<boolean>;
  getTask(id: Id, call: Call): Promise<Task | undefined>; // typed/batched reads also available
  getEntry(id: Id, call: Call): Promise<Entry | undefined>;
  value(addr) / list(addr)                         // session state handles; async methods take Call
  readonly models: ModelRegistry;                  // stream/deferred operations take Call
  readonly tools: ToolRegistry;
  hooks<H extends HookPoints>(kind: { readonly kind: string; readonly hooks?: HookSpecs<H> }): HookRunner<H>; // run(point, input, call)
  readonly env: ExecutionEnv;                      // existing Context-final methods; no wrappers
}
```

The registry maps kind names to kinds; a replacement must understand the persisted statuses and
state of its live tasks. Open reads the live tasks anyway (`inspect`), so an unregistered live kind
is handled there rather than rejecting the session (§5.1, §6.4); terminal tasks of a forgotten kind
are only a problem when read typed.

Typed access uses the kind as witness. Public/runtime reads are asynchronous and require Call;
transaction reads use the transaction view without another Call:

```ts
// public/runtime
getTask<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, id: Id, call: Call): Promise<ReadTask<S, R> | undefined>;
getTasks<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, ids: readonly Id[], call: Call): Promise<ReadonlyMap<Id, ReadTask<S, R>>>;
// inside Tx: same asynchronous typed reads, but no additional Call
getTask<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, id: Id): Promise<ReadTask<S, R> | undefined>;
getTasks<S extends TaskStateBase, R extends TaskRoles<S>>(
  kind: TaskDefinition<S, R>, ids: readonly Id[]): Promise<ReadonlyMap<Id, ReadTask<S, R>>>;
```

The getter returns `ReadTask<S, R>` without casts, or `undefined` when the task is missing or of another
kind; without the kind it returns the untyped task. `kind.is(task)` narrows to the same read type.
A bare numeric id supplies no state/role witness for typed mutation; read it with its kind first.

### 5.3 What an execution may do

Four rules, and they are the whole contract:

1. Commit an inflight status before any external effect. A crash before that point re-runs
   execute from the top; a crash after it goes through recover.
2. You may block on the world: a provider stream, a process, a human inside a hook, a conversation
   you created. The driver runs executions concurrently; a blocked one holds up nothing.
3. Make a durable status transition or settle before returning, except when cancellation/close
   unwinds the invocation. The driver checks a status epoch (§6.1), not final-status equality.
4. Prefer fixed `after` dependencies for prerequisite work. Child conversations use `drive(call)`;
   separately running jobs may use the bounded `waitForTask` API (§8.3). Known self/dependency waits
   reject (§6.2); never abandon an unfinished effect to release an invocation slot.

Timing is the task's business: a retry stores `notBefore` in its state and sleeps in its own
execute (`runtime.sleep`, which observes Call cancellation). Not everything on the signal throws:
pi-ai may return `stopReason: "aborted"`. The kind handles its domain outcome normally; if a durable
abort mark won, its attempted commit rejects and the driver runs the fresh abort handler (§6.3).
A recurring job sets its next `notBefore` and returns in a start status. The scheduler has no timers.

A task is one logical operation, not one attempt. Its declared status graph may contain cycles: a
generation revisits `streaming` across retries and deferred polls, and a schedule loops from
`planned` through `running` back to `planned` under one stable id. Recovery uses only the current
status, state, role and scratch; it does not reconstruct the path taken. Returning to the starting
status after intermediate committed transitions is valid. Returning without any transition is a
contract violation; transitions are not a generic proof of progress or a diagnosis of bad cycles.

### 5.4 Dependencies mean terminal, not successful

`after` lists tasks that must be terminal before this one starts. Terminal, not done: a task whose
dependency failed or was aborted still starts and decides for itself what that means. Dependencies
are set at creation, reference existing tasks in the same ownership tree, form no cycles, and are
never edited. A task may create a successor whose `after` includes itself in its settlement commit;
it cannot add new dependencies to itself. A dependency outside an attached subtree may require
another explicit drive; attaching one scope never implicitly executes a sibling scope.

A foreground task may depend on a background one, and it is live while it waits, so its conversation
stays busy and `drive` does not resolve until the dependency settles. That is what the overflow
chain wants (`G' after: [C]`). It is a trap for work that may never settle: a foreground task
depending on a recurring schedule keeps its conversation busy forever. Depend on work that ends, or
wait inside the task's own execute instead.

### 5.5 post_tools joins an exchange

The generation's settlement publishes the exchange atomically:

```ts
await runtime.commit(tx => {
  const assistant = tx.entry(assistantKind, { model: [message] });    // calls [A, B]
  const tools = message.calls.map(call =>
    tx.task(toolKind, { state: { status: "planned", call, assistant } }));
  tx.task(postToolsKind, {
    after: tools,
    state: { status: "waiting", assistant, tools, inputs: task.state.inputs },
  });
  tx.settle(task, "done", { inputs: task.state.inputs, assistant });
}, call);
```

Each tool executes and settles itself: hooks, execution, result entry, terminal variant. It does not
look at siblings, queues or context. post_tools starts when both are terminal, reads them with the
typed getter, narrows on their status, and decides what happens next:

```ts
async execute(task, runtime, call) {
  await runtime.commit(async tx => {
    const tools = await tx.getTasks(toolKind, task.state.tools);            // Map<id, ReadTask<ToolStates, typeof toolKind.roles>>
    const outcomes: ToolOutputState[] = [];
    for (const t of tools.values()) {
      switch (t.state.status) {
        case "done": case "aborted": outcomes.push(t.state.output); break;   // both wrote their result entry
        case "orphaned":                                                     // kind unregistered at open (§5.1)
          tx.entry(toolResultKind, unavailableResult(t.state.call)); break;
        default: throw new Error(`tool ${t.id} still live in post_tools`);
      }
    }
    if (outcomes.some(o => o.terminate)) {
      for (const inputId of task.state.inputs) {
        const r = await tx.value(inputResult(inputId)).get();
        if (r?.status !== "placed") throw new Error(`Invalid active input ${inputId}`);
        tx.value(inputResult(inputId)).set({ status: "unanswered", requestId: r.requestId, entry: r.entry,
                                             reason: "terminated" });
      }
      return tx.settle(task, "stopped", { assistant: task.state.assistant, tools: task.state.tools });   // no successor
    }
    const added = outcomes.flatMap(o => o.addedTools ?? []);
    const selectedTools = added.length ? [...current, ...added] : current;
    if (added.length) tx.value(generationKind.config.selectedTools).set(selectedTools);
    const handoff = outcomes.find(o => o.handoff);
    if (handoff) tx.entry(handoffKind, {
      data: { text: handoff.handoff }, model: [handoffMessage(handoff.handoff)], head: "self",
    });
    const inputs = await landPostToolsInbox(tx, task.conversationId, task.state.inputs); // writes + steer (§8.1)
    tx.task(generationKind, { state: { status: "pending", ...nextGeneration(task, { selectedTools, inputs }) } });
    tx.settle(task, "done", { assistant: task.state.assistant, tools: task.state.tools, inputs });
  }, call);
}
```

`inputResult(id)` above is the sticky conversation value address for that input (§8.1), not a
driver operation. The abort handler resolves the same owned inputs as `unanswered` with reason
`aborted` and settles in one commit. The runtime rejects a marked execute commit before its closure runs; no branch is needed
in the normal settlement. Inbox-placement helpers above implement exactly the mode table in §8.1.

Sequential tools are the same mechanism with `B after: [A]`.

```text
crash before generation settles → generation live; recover
crash after it settles          → assistant, tools and post_tools exist; nothing to repair
crash after the last tool       → post_tools exists and is startable; nothing to infer
```

### 5.6 Foreground and background

A task is foreground unless created with `background: true`; the flag is fixed at creation. Generations, tools, post_tools and automatic collapses are
foreground; jobs, schedules, spawned subagents and manual collapses are not. The
foreground set of a conversation is its live foreground tasks, plus, through any live foreground
task that owns a conversation, that conversation's foreground set. Abort and "is this conversation
busy" are defined on that set. Detached work is cancelled by its own handle.

### 5.7 Ownership

A task that creates a conversation adds it to `owns`; the conversation records `owner`. Both are
written in the creation commit. A task may own several (a fan-out tool driving three children);
a conversation has one owner. Ownership defines drive scope and cancellation reach. Fork
provenance is a different link (§2.5) and creates no ownership.

### 5.8 Turn tasks and appending entries

A kind that drives a turn declares `turn: true`; `Tx` materializes it onto the task like `role`, and
storage indexes it. The built-in generation, tool, post_tools and collapse kinds declare it; a
plugin kind that drives its own turn declares it too. That gives one predicate, computed from the
index without decoding state or knowing any kind name:

```text
inTurn(conversation) = live tasks in it with turn: true
```

It exists because of one hazard. An entry with a `model` appended between an assistant's tool calls
and their results changes the prefix the next request replays: providers that validate message order
reject it, and Anthropic thinking signatures are invalidated. The lane harness holds the same
invariant by deferring custom messages while streaming; pico holds it with `inTurn`.

`tx.entry` appends immediately and returns the id, which is what a turn task needs (the generation's
assistant entry, a tool's result, a head with `"self"`). It rejects in exactly one case:

```text
reject if  the entry has a `model`
       and the committing task is not turn: true, or there is no committing task
       and inTurn(entry's conversation) is not empty
```

So an entry without a `model` is never blocked, a turn task writing its own exchange records is
never blocked, and nothing is blocked in a conversation with no live turn task. The rejection names
`tx.write`.

`tx.write(kind, draft)` is the door for model-visible entries from outside a turn: it appends
immediately when `inTurn` is empty, and otherwise queues as the `write` mode (§8.1), landing at the
next post_tools or final-answer boundary. It returns an `inputId`, not an entry id, because the entry
may not exist yet. `ConversationHandle.write` is the same wrapped in a commit.

`inTurn` is also the honest definition of "busy" for a UI: a foreground subagent tool is in it
because it is a tool, a background job is not.

## 6. Scheduling and cancellation

### 6.1 The commit line is the scheduler

Every driver decision runs on the same serialized line as commits. Only task methods, signal
listeners, watcher callbacks and telemetry callbacks run outside it. There is no polling loop,
`Wake`, effect-admission gate, worker pool or second scheduler.

Process state consists of:

| State | Purpose |
|---|---|
| `live: Map<Id, { task, statusEpoch }>` | current non-terminal tasks only |
| `running: Map<Id, Invocation>` | one execute/recover/abort call per task id |
| `byConversation`, `dependents` | live-task membership and reverse live dependency edges |
| ownership links | immutable ancestry needed by live tasks, outstanding calls and attached roots |
| attached roots | stable conversation ids or one session-wide flag |
| waiters | temporary drive/task waiters, indexed by their scope or target |
| phase | open, stopping, closing, faulted, closed |

Open seeds the complete live map before building readiness indexes, but starts no task. After a
successful batch, the line applies every task change to these indexes before scheduling or testing
idle. A settlement removes the task and its dependency edges; creating a successor in the same
batch never exposes an idle gap. `statusEpoch` advances on each actual committed status change,
including intermediate changes in a batch whose final status equals its initial status. State-only
patches, abort marks, same-status patches and failed commits do not advance it.

Normal execution does not scan storage after every task returns:

```text
task commit on line:
  persist whole batch
  update live/dependency/conversation indexes
  reconsider changed tasks, affected dependents and waiters
  reserve eligible calls in running
  publish complete state; leave line
  dispatch calls/signals/listeners outside line

invocation completion on line:
  validate the invocation object matches running[taskId]
  inspect that task in live (absence means it already settled)
  check outcome and statusEpoch; remove its running slot
  reconsider that task and affected waiters
  reserve eligible calls; leave line
  dispatch outside line
```

Only the current invocation may change its owned task's state/status or settle it. Host cancellation
may set the abort mark, but host or sibling status writes cannot mask a broken invocation's progress
guard. Task code receives a snapshot; later authority is checked against the line's live record and
invocation identity, not that snapshot. No extra storage read is needed for this check.

A task can be reserved only when it is served, live and not already in `running`:

```text
marked                    → abort, irrespective of after
unmarked, role=start      → execute when every dependency is terminal
unmarked, role=inflight   → recover
```

Existing dependency ids are validated on creation. Once the complete live map is seeded, a valid
dependency absent from it is terminal. Dependency settlement wakes only its live dependents.
New attachments may inspect the current live map once; ordinary completions do not scan all tasks.
An outstanding invocation retains its slot even after it commits terminal status, until its method
actually returns. Different task ids execute concurrently. Retaining the slot is the abort join:
there is no separate invocation that waits for, or overwrites, its current owner.

A normally returning execute/recover must have settled or advanced its captured `statusEpoch`.
`planned → running → planned` is valid; returning without any committed status transition is not.
Cancellation/close unwind is the exception. An abort handler must settle before returning. The driver
does not diagnose arbitrary changing-but-buggy cycles.

Unexpected task-contract errors fail-stop the session, rather than poisoning individual tasks and
leaving their dependents waiting forever. Reject all pending drives and shutdown with the fault
immediately; stop admission and claims, signal owned calls outside the line, join them and close.
Do not manufacture terminal outcomes. The report includes task id, kind, method and error. Reopen
starts nothing: the host can inspect and mark a task before driving, or replace a broken kind with
one that understands and settles its stored state. Ordinary provider/tool failures are domain
outcomes handled by their kinds, not driver faults.

### 6.2 Attachments and waiters

`conversation.drive(call)` attaches one stable conversation id; `harness.drive(call)` attaches the
session. Each call registers an independent temporary waiter. Repeating a drive never retains another
scope object. Resolving or cancelling a waiter removes it and its signal listener, but keeps the
attachment, so background and recurring work continue. Session attachment subsumes serving filters;
separate conversation waiters still retain their own idle predicate.

Serving follows ownership, never fork provenance. A conversation attachment serves all its owned
descendants, even when their owner task has settled. Discover membership starting from conversations
with live tasks, walking `conversation.owner → owner task's conversationId` upward. Batch named
ancestor reads through `getConversations` and `getTasks` and cache only the extracted immutable links;
never enumerate historical children or retain terminal owner payloads.
Owner liveness always comes from `live`, not the ancestry cache. Release unused ancestry when no
live task, outstanding invocation or explicit attachment needs it.

```text
100,000 completed children; 2 live tasks
→ open reads 2 live tasks and only their required ancestry
→ later task completions use current indexes
→ no traversal of the 100,000 historical children
```

Idleness is decided on the line against current indexes:

- Conversation: no direct live foreground task in that conversation. Reaching foreground descendants
  requires a live foreground owner in the root, so this is equivalent to an empty foreground set.
- Session: no live foreground task anywhere, including foreground tasks in detached children.

Both resolve `"idle"`, or `"closed"` when close wins. Session faults reject, not resolve idle.
A full-quiescence wait, if exposed separately, may never complete with a recurring task.

Drive uses `call.abortSignal` to cancel only the actual registered waiter, not durable work. Register
and check cancellation on the line; a signal listener enqueues removal. Every outcome removes the
waiter and listener exactly once. Do not race an uncancellable drive promise with an outer promise.
Cancelling `prompt` after acceptance also leaves its accepted input durable.

Task-bearing calls reject known self-waits: a foreground task cannot drive its own foreground scope,
nor wait for a task whose unresolved dependency path leads back to it. The latter also catches a
background task T driving a foreground D with `after:[T]`. Apply the checks before prompt acceptance
and reject new work that would introduce such an indexed wait cycle. A foreground ancestor reached
through a settled/background owner is not automatically the caller's foreground scope. Arbitrary
cycles hidden in plugin promises remain the task author's responsibility. Dependencies elsewhere
in an ownership tree may require another explicit attachment; never silently widen a drive scope.

### 6.3 Cancellation is a request, then an abort invocation

```text
abortTask(id, call)  mark one live task; reject terminal
conversation.abort(call)
  one commit: mark its current foreground ownership closure;
  withdraw queued steer/followUp in affected conversations; keep write/nextRun
```

`abort: true` is a durable request, not terminal status. When that mark commits, the current
execute/recover invocation loses mutation authority immediately. Its later main and scratch writes
reject `TaskCancelled` on the line, before running their builders. This is normal control flow, not
a kind bug. The signal is dispatched after leaving the line; standard effects and waits observe it
cooperatively. No new admission gate is required. An effect may start in the interval before signal
delivery and then be cancelled; cancellation neither rolls it back nor promises exactly-once I/O.

```text
100 task streaming; execute invocation A owns it
110 abort=true commits; A's mutation authority revoked
    line releases; A's signal fires
    stream returns/throws; execute finishes local finally cleanup and returns
    A's completion enters line; remove A, reserve fresh abort invocation B
    line releases; kind.abort(task, runtime, callB) runs
120 partial/error outcome and unanswered(aborted) input results, if the kind needs them
121 task terminal aborted; scratch retired in the same commit
    abort method returns; remove B
```

Normal execute/recover settlement needs no mark check and no `tx.origin` branch. If its settlement
wins first, the task is already terminal and a later abort rejects. If the mark wins first, the whole
normal settlement rejects and the driver runs `abort`. A provider's in-band `stopReason: "aborted"`
is not itself a durable mark: without a mark, the kind must commit its failure/retry outcome; with
a mark, its attempted domain commit rejects `TaskCancelled` and cleanup runs in the fresh invocation.
An invocation cancelled only by a task-local deadline may still commit its domain result.

The driver recognizes its own `TaskCancelled` and the invocation's known cancellation reason,
including supported cancellation errors correlated with the mark/close. An arbitrary exception does
not become harmless merely because a signal fired. Hooks propagate cancellation rather than treating
it as an ordinary fail-open/fail-closed decision. Expected close/stale callback rejections are handled
at their boundary; uncertain persistence still faults the session.

`abort()` receives a new identity, telemetry span and initially active controller. Repeated marks
never cancel an already-running abort handler. Only close/fault cancels it. Abort ignores `after`,
may perform cleanup effects and write outcomes, but cannot create successor tasks/conversations or
queue future work via accept/nextRun. A target with no owned call and no attached scope remains
marked until driven; marking it does not implicitly attach unrelated work.

Fresh cleanup can use only durable records. A tool that creates a cancellable background job records
the job id and its cancellation policy on its own task in that same commit. Its abort handler uses
those references, never locals from execute or a post-mark catch that tries another mutation. Child
conversation ownership is already durable. Built-in cleanup marks only the child's live foreground
tasks; it does not call the public conversation abort operation that also withdraws queued inputs.
This task-only cleanup policy applies on every abort invocation, including after crash/reopen, so
shutdown cannot accidentally discard preserved queues during recovery. Cleanup's cancellation request treats an already-terminal
target as finished, using an atomic mark-if-live operation internally or handling that specific public
terminal result; a read-then-mark does not close the race.

Scratch before the mark is authoritative. Harness-owned sinks/progress bridges own and handle their
pending scratch promises, drop late cancelled output and drain callbacks before invocation completion.
Task code must await/catch its own scratch writes; no `void runtime.scratch(...)` without error handling.
Do not turn rejected scratch into a successful no-op or race away an unfinished tool/hook. If code
ignores the signal and never returns or reaches a rejecting harness operation, abort/close can wait
forever. An isolate kill boundary is future work; RPC cancellation alone is not forced termination.

### 6.4 Open, close, shutdown, delete

**Open** reports unregistered entry kinds, seeds live/ownership indexes, exposes inspection/queries,
and starts nothing. A live task whose kind is not registered cannot run: a background one is parked
(not started, not recovered, not counted for idleness) and resumes through `recover` when its kind
returns; a foreground one would keep its conversation busy forever, so open settles it in the
derived `orphaned` variant (§5.1) and reports it. `inspect` returns those separately. Unknown entries preserve context through stored facets.

**Close** runs one nonpersistent line operation that enters `closing` and stops admission and claims.
All earlier line operations have already finished. Later storage operations reject; internal invocation
completion messages remain admitted. Outside the line, signal and join every owned call, including
terminal tasks whose methods are still unwinding, then close storage. No new abort marks or outcomes
are written. Never hold the line while awaiting a task that may itself be awaiting a line operation.

**Shutdown** runs one line operation: enter `stopping` and commit one batch marking all live tasks.
Queued inputs and their queued result records remain untouched, including in idle conversations.
There is no inbox sweep or special storage query. After this batch, only abort cleanup mutations are
admitted; an abort handler already running remains authorized. Cancelled execute/recover mutations
reject. Abort handlers resolve their already-running input groups, but built-in child cleanup only
marks tasks and never drains queues (§6.3), including after restart. Serve cancellation session-wide;
once both live tasks and running invocation slots are empty, close. A failed abort handler faults
and rejects shutdown rather than leaving an eternal drain. Preserved queues create no work by
inference on reopen/drive; a later acceptance places eligible queued input at the defined boundary.

Repeated lifecycle calls share completion. Task-token-bearing close/shutdown/session-wide drive reject
rather than waiting on their own invocation. Close joins regardless of its caller's signal; once
shutdown is admitted, caller cancellation cannot abandon marking, joining or closing. Explicit close
may interrupt shutdown; shutdown then rejects and remaining marked tasks recover later. Lifecycle
entry points are exceptions to ordinary admission so repeated close works while already closing.

**Delete** rejects while either live tasks or outstanding invocation slots remain in the subtree,
then rejects new work. Entries inherited by independent forks are never erased.

### 6.5 Call, telemetry and storage version

`Call` is an alias of Chord `Context`, not a second context implementation. The driver installs a
private typed identity alongside its signal; span/budget derivation preserves it without casts:

```ts
import type { Context } from "@earendil-works/chord";
import { createContextKey, withAbortSignal, withContextValue } from "@earendil-works/chord/context";

export type Call = Context;

interface Invocation {
  readonly taskId: Id;
  readonly method: "execute" | "recover" | "abort";
  readonly controller: AbortController;
  readonly initialStatusEpoch: number;
}

const invocationKey = createContextKey<Invocation>("pico.invocation"); // private

// parentWithoutCallerCancellation retains the host telemetry parent, not the drive waiter's signal.
const call: Call = withContextValue(invocationKey, invocation, withAbortSignal(
  invocation.controller.signal, parentWithoutCallerCancellation,
));
const identity = call.value(invocationKey); // Invocation | undefined, no assertion
```

The line compares object identity with `running.get(identity.taskId)`. `TaskRuntime` is bound to its
expected invocation and rejects absent/foreign/stale identities; public host calls may have no token
while the session is open. Returned ordinary conversation handles also receive Call on every async
operation, so they preserve attribution without a task-specific facade. Capturing a public handle and
deliberately supplying `BACKGROUND_CONTEXT` remains an in-process cooperative escape, not isolation.

Every async Harness/Conversation/TaskRuntime method takes a required final `call: Call`, including
reads, waits and mutations. Options before it are passed as `undefined` when unused. Pure accessors,
synchronous registration/disposal and operations inside Tx do not require a Call. `TaskRuntime` and
`ToolRuntime` name capabilities; `call` names cancellation/telemetry/identity; model context keeps its
existing meaning. There is no `TaskContext`, `CallContext`, admission helper or signal-injecting facade.

The driver starts one telemetry span per execute/recover/abort invocation, independent of the drive
caller's cancellation. Commits use the supplied Call's current telemetry parent; nested provider/tool/
hook spans derive and forward a Call. Existing Context-taking env, provider and hook boundaries
interpret the signal rather than merely carrying it. Node operations without interruptible APIs may
only check before/after; hooks and plugin code must cooperate. Commit admission uses lifecycle, mark,
method and identity, not a blanket signal check: cancellation never abandons admitted persistence.

RPC transports cancellation and selected telemetry metadata, never the invocation object. A trusted
host-side binding reattaches the local identity for remote task calls. A cancelled RPC waiter does not
prove remote code stopped; no slot is released until completion or a real kill boundary confirms it.

Telemetry schema names/attributes are a separate implementation package; the host supplies the tracer
and no spans are stored in session data. Storage metadata carries a version; mismatches reject and a
backend exposes migration before open. None of these mechanisms require a renewable session lease.

## 7. Storage

One interface: point reads, batched reads, bounded indexed scans, one atomic commit. No journal
reader, no second transaction layer, no residency API.

### 7.1 What is stored

Conversations (`parent` for forks, `owner` for owned children), entries, tasks
(with indexed role and scheduling fields), values and their rewindable versions, list elements and
clear markers, scratch scopes. Context is not stored (§2.2).

### 7.2 Queries, from the callers' side

| Caller | Reads | Never |
|---|---|---|
| Driver open/attach | complete live-task seed and named owner records; then committed-batch index updates | repeated full scans after calls, historical child traversal |
| Shutdown | current live-task index | inbox sweep, historical conversation traversal |
| Context | newest head at a target; fork-aware range from its returned boundary | unrelated transcript history |
| post_tools | tool tasks by id | sibling scans |
| UI | a transcript page before/after an id, with a limit | the whole conversation |
| Validation | named task/conversation records and full entries by id | unrelated records |
| Fork | transcript and rewindable conversation history ≤ the entry id | today's state filtered |
| State consumer | latest version by index; a bounded list range | a replay of unrelated records |
| Reopen (SQLite) | live tasks and the conversations they need | every historical transition |

"Latest" is an indexed descending query with limit 1, never load-and-take-last. Filters apply
before limits and decoding. Entries are immutable and read whole; there is no separate header or
projection API. Named owner-task lookups use existing batched `getTasks`, even for terminal owners.

```ts
interface Page<T> { readonly items: readonly T[]; readonly next?: Id; readonly readAt: Id }

interface Cursor { readonly after?: Id; readonly before?: Id; readonly limit: number }
interface ConversationQuery extends Cursor { readonly parent?: Id; readonly ownedFrom?: Id }
interface EntryQuery        extends Cursor { readonly conversationId: Id; readonly kind?: string; readonly key?: string;
                                             readonly from?: Id; readonly through?: Id } // inclusive logical range
interface TaskQuery         extends Cursor { readonly conversationIds?: readonly Id[]; readonly live?: boolean;
                                             readonly role?: TaskRole; readonly kind?: string; readonly abort?: boolean }
interface ListQuery         extends Cursor { readonly at?: Id }                   // at = an entry id (§3.2)
interface ValueQuery        { readonly scope: Scope; readonly namespace: string; readonly after?: string; readonly limit: number }  // keys, ordered

interface Version<T>  { readonly seq: Id; readonly value: T }
interface Element<T>  { readonly id: Id; readonly value: T }

interface Storage {
  readonly lastSeq: Id;                                   // last committed sequence
  commit(batch: CommitBatch): Promise<{ first: number; last: number }>;

  getConversations(ids: readonly Id[]): Promise<ReadonlyMap<Id, Conversation>>;
  scanConversations(q: ConversationQuery): Promise<Page<Conversation>>;

  getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
  scanEntries(q: EntryQuery): Promise<Page<Entry>>;                            // full entries, fork-aware
  newestHead(conversationId: Id, at: Id): Promise<Entry | undefined>;             // full entry, target-capped, fork-aware

  getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
  scanTasks(q: TaskQuery): Promise<Page<Task>>; // omitted conversationIds: entire session

  getValue<T>(addr: Value<T>, at?: Id): Promise<Version<T> | undefined>;         // at = an entry id
  scanValues(q: ValueQuery): Promise<Page<{ key: string; version: Version<JsonValue> }>>;
  readList<T>(addr: List<T>, q: ListQuery): Promise<Page<Element<T>>>;

  close(): Promise<void>;
}
```

`Value<T>`, `List<T>`, `Address` and `Scope` (session / conversation / scratch) are the address types
of §4.1;
`Conversation`, `Entry`, `Task` and `TaskRole` are the records of §§2 and 5; `CommitBatch` is §7.3.

Pages carry a cursor and the sequence they were read at. Transcript reads are logical conversation
reads: they combine each fork's capped source prefix with local entries, carrying every ancestor
cutoff recursively. `from` and `through` are inclusive entry positions in that logical transcript;
source entries after a fork point never appear. `newestHead(conversationId, at)` applies the same
cutoffs and returns the newest visible entry with `head` at or before `at`. Rewindable conversation
state follows the same ancestor cutoffs. Session state stays current; sticky conversation state is
copied from current state only when the fork explicitly selects it. Tasks are never inherited.
Historical reads on sticky or scratch addresses reject. Coherent multi-read operations run on the
line; a cursor alone doesn't freeze mutable state.

### 7.3 Batches

```ts
type StateWrite =
  | { type: "value.set"; addr: Address; value: JsonValue }
  | { type: "value.delete"; addr: Address }
  | { type: "list.append"; addr: Address; value: JsonValue }
  | { type: "list.remove"; addr: Address; element: number }
  | { type: "list.clear";  addr: Address };

type MainWrite =
  | StateWrite
  | { type: "createConversation"; conversation: Conversation }
  | { type: "deleteConversation"; id: number }
  | { type: "entry";   entry: Entry }
  | { type: "task";    task: Task }
  | { type: "patch";   id: Id; role: TaskRole; state: TaskStateBase; abort?: true }
  | { type: "settle";  id: Id; role: "terminal"; state: TaskStateBase };  // also retires scratch

type CommitBatch =
  | { readonly kind: "main";    readonly writes: readonly MainWrite[] }
  | { readonly kind: "scratch"; readonly task: number; readonly writes: readonly StateWrite[] };
```

A scratch batch can only carry state writes, by type; `ScratchTx` (§4.6) only exposes those. Write
*i* gets sequence `lastSeq + 1 + i`.

The Tx read `lastSeq` when it started and numbered its writes
from there; the line guarantees nothing landed in between, so storage numbering from its own
`lastSeq + 1` yields the same ids. Records that carry an id (`entry`, `task`, a list element) let
storage check that for free. The harness validates against
committed state plus earlier writes in the batch (kinds validate status transitions; the harness
enforces ownership, dependencies, exchange rules and admission; nobody validates payload shapes:
stored objects are trusted, and schema validation belongs at wire boundaries). For an entry with
`head`, validation requires the stored id to be visible and at or after the previous fork-visible
head's stored boundary. Stored edit targets must be earlier visible entries; managed-system targets
are restricted to baseline supersession (§2.1). Input-result transitions
are validated, terminal results cannot change, and consuming/cancelling an inbox element writes its
result in the same batch. No entry-kind code runs. Storage checks scope, sequences and structure,
prepares only touched data, persists atomically, publishes. A commit with no writes writes nothing.

### 7.4 Memory and JSONL

The memory backend holds current maps (conversations, tasks, values), ordered entries per
conversation, version histories, and lookup indexes (ids, addresses, live-task membership, parent
and owner links). Indexes reference the same immutable payloads. JSONL is the memory backend plus
one line per batch:

```json
{"first":100,"writes":[
  {"type":"value.set","conversationId":1,"namespace":"plugin.plan","value":true},
  {"type":"entry","conversationId":1,"kind":"user","model":[{"role":"user","content":"Inspect","timestamp":0}]},
  {"type":"task","conversationId":1,"kind":"generation","state":{"status":"pending"}}]}
```

Write all bytes, then publish in-memory changes, never before. Durability against process crash is
required; fsync policy is a backend option.

**Whole values, ordinary list operations.** Every `value.set` stores the complete supplied value,
just like the lane harness. There is no automatic diff, Chord encoding or hidden replay chain for a
value. Lists store append/remove/clear operations. Repeatedly setting a growing whole value can write
quadratic bytes; use compact appended frames/output operations or bounded checkpoints for streaming.
Chord deltas are used only for preview/watch delivery (§9.4), not storage serialization.

**Scratch** goes to `session.scratch/<task id>`, one file per task, with the same plain batch format.
Retirement in the main file is authoritative; unlink happens afterwards. Task ids are never reused.
A retry keeps its task and clears its scratch through a persisted list operation, not by deleting
the only record of its latest sequence.

**Recovery across files.** Main and scratch commits share one session sequence, so gaps inside any
one file are normal:

```text
main:       100 create generation
scratch:    101–150 frame appends
crash before settlement
reopen:     main says generation live; replay its scratch; lastSeq=150; next write=151

alternatively:
main:       151 settle generation, retire scratch
crash before unlink
reopen:     generation terminal; ignore old scratch; lastSeq=151
```

On open:

1. Replay complete main batches, reconstructing task liveness and scratch retirement.
2. Replay scratch files only for surviving live tasks. Ignore retired scratch entirely, even if
   malformed; it cannot affect state or the sequence high-water mark.
3. Validate increasing, nonoverlapping retained batch ranges and task/scope references. Per-file gaps
   are valid; do not require the main log to contain discarded scratch positions.
4. Set `lastSeq` to the maximum complete batch endpoint across main and surviving scratch files,
   including scratch clear/remove writes. A retired scratch file's sequences are already below its
   later main settlement, so deleting it loses no high-water information.
5. Discard only unterminated final lines in replayed files and physically remove those torn suffixes
   before appending again. Any malformed complete main or surviving scratch batch makes open fail.

No new index, journal or cross-file transaction is required: each commit still writes exactly one file.

### 7.5 SQLite

Tables: conversations, entries, tasks (current records including terminal), values and
value_versions, list_elements and clear_markers, scratch, commit_boundaries, kinds (one row per
distinct entry kind), session_metadata (storage version, §6.5). An entry row has nullable JSON
columns for `data`, `model` and `edits`, plus a nullable integer `head`; storage understands those
core fields but never a plugin's data shape. Keys start with the session id. Indexes follow the query
table: entries by (conversation, id), (conversation, kind, key, id) and a partial index
(conversation, id) where head is not null; tasks by (role, id) and (conversation, role, id) with a
partial index on non-terminal roles; value_versions by (conversation, namespace, key, seq);
conversations by parent and by owner. One commit is one transaction: number the writes from
`lastSeq + 1`, insert rows, record the boundary, advance `lastSeq`. No full rewrite of anything per
append; no shutdown-specific inbox index.

Values are stored whole, current and historical: a point read must not become a replay chain, and
disk is cheaper than that. Scratch is rows in the `scratch` table keyed by (task, address), written
in the task's own small transactions, and retired by `DELETE ... WHERE task = ?` inside the
settlement transaction: atomic with the result and the terminal status, nothing to unlink. Reopen
reads live tasks and named records they reference (including terminal owners), not accumulated
history. Once ownership links are extracted, terminal owner payloads need not remain resident.

## 8. Built-in flows

Task kinds, not scheduler special cases. Braces group one commit. Every
attempt records its usage; every settlement retires its scratch. Hooks and external calls run
outside the line, and their decisions are re-validated inside it.

### 8.1 Accepting input

Queued input is a conversation-scoped sticky list, `pi.inbox`. Its list element id is the stable
`inputId`; its value carries the complete entry draft, so a UI can render queued text or images
without another read:

```ts
type UserInput = string | readonly (TextContent | ImageContent)[];

type QueuedInput =
  | { readonly mode: "steer" | "followUp" | "nextRun"; readonly input: UserInput; readonly requestId?: string }
  | { readonly mode: "write"; readonly kind: EntryKind<E>; readonly entry: EntryInput<E>; readonly requestId?: string };

type InputResult =
  | { readonly status: "queued";     readonly requestId?: string }
  | { readonly status: "placed";     readonly requestId?: string; readonly entry: Id }
  | { readonly status: "done";       readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
  | { readonly status: "unanswered"; readonly requestId?: string; readonly entry?: Id;
      readonly reason: "terminated" | "aborted" | "failed"; readonly detail?: string };
```

The three modes that ask for a turn carry user content; a `write` carries its own entry kind and
the same `EntryInput<E>` (§9.2) `Tx.entry` takes, and asks for nothing. `inputResult(id)` denotes the sticky conversation Value address with
namespace `pi.inputResult` and key `String(id)`, typed as `InputResult`. It is ordinary stored
state, not a driver callback.

`accept({ input, requestId?, whenBusy? }, call)` is "the user hit enter": when the conversation is
idle it places the entry and creates a generation in one commit; when it is busy it queues,
`followUp` by default, `steer` or `reject` if the caller says so. Either way it returns an
`inputId`, and `result(inputId, call)` says which happened. `queueInput(input, call)` is the
explicit form for a specific mode, and `abortInput(inputId, call)` withdraws a queued one.

| Mode | Placement | Effect on the answer group |
|---|---|---|
| write | next post_tools or final boundary | none; its result is `done` with no `answer` (§5.8) |
| steer | next post_tools or final boundary | joins the active group at post_tools; starts the next group after a final answer |
| followUp | final-answer boundary | starts the next group |
| nextRun | next explicit idle `accept` | joins the group started by that acceptance |

A generation and its `post_tools` carry `inputs: Id[]`. Generation-with-calls creates the tools and
exactly one `post_tools` with the same group in its settlement commit. `post_tools` places writes,
places selected steering in admission order, extends the group with those steer ids, creates the
continuation generation and settles. At a final answer, the generation resolves every current
input to that answer, places writes, then places selected steer/followUp items into a new group and
creates its generation. An `on_yield` continuation retains the current group. No tail scan
attributes results.

Placement appends the entry, removes the list element and writes `placed` in one commit; a `write`
is placed and `done` in that same commit, so `placed` is never observable for it. Only the
generation and `post_tools` transition a group: a final answer records `done` with the answer's
entry id; the harness giving up records `unanswered` with reason `failed`; a tool's `terminate`
records `terminated`; an abort of the run, or `abortInput` on a queued item, records `aborted`.
Foreground abort withdraws queued steer and followUp while preserving write and nextRun. Failure
and terminate may place safe writes but do not consume queued inputs that require a successor.
Exactly one live generation or `post_tools` owns an active group, and ownership transfers in the
same commit that settles the previous owner.

The list is stored as append/remove/clear operations, not as a rewritten array. Inbox watch events
carry the same operations; an idle same-commit append/remove emits none. Memory and SQLite may
discard a removed sticky element; JSONL retains its append record, so any payload later copied into
a transcript entry appears twice on disk, including an idle acceptance. Once an unplaced item is
withdrawn, its draft is no longer queryable; `inputResult` retains only its terminal status and
optional request id.

### 8.2 Generation

```text
create:      capture inputs, the kind's declared config (model, thinking, selected tools, profile;
             §5.2, rewindable values), provider options and retry policy, so a retry uses what the
             attempt used
execute:     if a collapse is needed by threshold: { create collapse C; create generation G' after:[C]; settle }
             desired = seed typed section draft from durable prepared values/rendered text;
                       run system_instructions handlers, then touched renderers/wrappers outside line;
                       capture complete desired tool definitions; no discovery/cache callbacks in storage
             { inspect current head and effective managed system entries;
               if no valid current-epoch baseline: append full baseline plus stored omission edits;
               else if prepared state differs from desired: append materialized section/tool delta;
               capture requestThrough = exact resulting transcript tip; status streaming }
             project at requestThrough, not the later tail; before_request with Call on a request copy
             validate messages-only mode and capture actually offered tools; stream; frames to scratch
outcome:
  calls        { assistant; tools; post_tools carrying inputs; settle done }
  final        { assistant; resolve every current input; place next-group inbox items and successor if any;
                 settle done }
  deferred     { status deferred, handle }         → execute again: poll with sleeps until final
  retryable    { status retry_wait, attempt+1, notBefore } → execute again: sleep, then stream
  overflow     { settle failed(overflow); create collapse C; C's settlement creates G' }
  failure      { retain partial/error outcome for display if useful; resolve inputs unanswered(failed);
                 settle failed; no tools/results }
  aborted      provider returns in-band: attempt domain failure/retry commit;
                 durable mark present → TaskCancelled; execute unwinds; driver calls abort below
```

**Durable configuration, prepared instructions.** Config changes persist immediately as ordinary
scoped value writes: model/thinking/selected tools/profile rewind with forks, while each other address
keeps its declared policy. Host files and catalogue implementations are not stored as configuration.
The `system_instructions` hook uses the generation's captured config to produce desired sections and
complete selected tool definitions. Its answer is prepared outside the line. A system entry records
canonical instructions prepared for a request, not proof of delivery or an external acknowledgement.

**Typed section definitions and one mutable draft.** A token identifies a JSON payload type and an
append-time renderer. It is not an entry kind, discovery callback or read-time projection hook:

```ts
interface SystemSection<T> {
  readonly key: string;
  render(value: T): string;
}

interface SystemSectionDraft {
  get<T>(section: SystemSection<T>): T | undefined; // owned copy; call set to change the draft
  set<T>(section: SystemSection<T>, value: T): void;
  delete(section: string | { readonly key: string }): void;
  wrap<T>(section: SystemSection<T>, transform: (text: string) => string): void;
}

interface SkillInfo { name: string; description: string }
const skillsSection = defineSystemSection<SkillInfo[]>({
  key: "pi.skills",
  render: skills => skills.map(skill => `- ${skill.name}: ${skill.description}`).join("\n"),
});
```

Built-in definitions are exported through `systemSections`: identity carries a string, environment
carries structured data such as `{ cwd: string }`, and skills carries typed skill descriptions.
Plugins may define others. Payloads must be JSON-representable. Typed getters use the registered definition's
payload contract; plugins need no casts. Registration rejects duplicate keys; replacing a definition
must preserve the persisted payload shape or migrate it. Payload shape validation belongs at wire
boundaries, as for other typed stored values, not to arbitrary renderer casts.

Every preparation seeds a private ordered draft from durable section values and rendered text. Hooks
edit that same draft in registration order, harness-wide first and innermost scope last. Under the
skip-failed-handler policy, discard that handler's mutations/wrappers while retaining earlier changes;
a failed refresh must not publish a partial deletion. `set` replaces
an existing payload in place; a new key appends. `delete` explicitly removes a key (even by string when
its renderer is unavailable). `get`/`set`/`wrap` require a registered compatible definition. Thus a later
plugin can filter or append typed skills by get-and-set, rather than parsing rendered prose. Hooks
return only optional complete desired `tools`; the last supplied list wins, omission preserves an
earlier handler's list, and no supplied list means no desired tools.

After hooks, render touched sections outside the line. `wrap` composes text transforms in registration
order after the section renderer, without mutating the shared token. Wrappers live only in this draft;
only their final text is stored. Untouched seeded sections retain their stored rendered text, including
when their contributor or renderer is absent. An explicit set/wrap or compatible renderer replacement
recomputes that text. Refreshing a base intentionally rebuilds its wrappers; preserving a missing
wrapper across such a refresh is not promised. Freeze/discard the draft after preparation; later leaked
callbacks cannot alter the committed snapshot.

**No accidental accumulation.** Host hooks should set complete authoritative base payloads each time
before transformation plugins run. Otherwise the composed transformation chain must reach a fixed
point when applied to its own previous output; each handler being individually idempotent is not enough.
Blindly appending to a seeded array/text each preparation would accumulate duplicates. Registration
order provides composition, not automatic deduplication of arbitrary payloads.

Diff final JSON payloads and rendered text by key, ignoring incidental object-key order. Persist changed
payloads even if rendering is identical; those changes can be data-only system entries (`model: []`).
Changed rendering with identical payload also emits an instruction update, including renderer/wrapper
changes. Baselines and simultaneous changes use draft order; pure reordering is a no-op. There is no
separate order option, order-change message or generic source-renderer framework.

**Durable seed, independent of model retention.** Reconstruct canonical section state through the
fork-visible target by reading managed `system` entries back to the latest baseline, then folding their
section records forward. Use existing indexed kind scans and an optional per-handle prepared-state
cache. A fresh baseline checkpoints the complete state. This fold is independent of model heads and
projection edits: an omitted historical model message does not erase its persisted section payload.
That is how an unavailable plugin's instructions survive a compaction that dropped its old baseline.
No extra full-state value, blob store or storage API is required.

Separately inspect the effective model projection to decide whether it has a usable current-epoch
baseline. Arbitrary edits targeting managed system entries reject (§2.1); changing instructions uses
the section draft instead. Supersession omissions written by the current baseline do not trigger
another rebaseline. A fresh baseline uses the canonical payload/rendered seed plus this preparation's
changes, even when the previous model baseline fell outside the retained range.

Hook-private discovery/cache state stays in closures or host services, not in section records.
Refresh skills through filesystem events or bounded polling, not remote scans per hook call. A failed
refresh is not a deletion: retain the last successful snapshot; seed first use before claiming a base.
Missing hook registration also is not deletion; use the draft's explicit delete operation.

Fold effective pi-ai system-message tool fields from all projected messages, including declarations
outside managed entries. Diff complete definitions structurally by name. Additions and same-name
replacements emit `toolsAdded`; removals emit the previous stored definition in `toolsRemoved`.
Tools-only changes may use empty content. The adapter, not pico, renders compatibility notices.

```text
100 user
110 system baseline: identity + plan_mode; toolsAdded=[read, write]
120 assistant
125 config commit: plan_mode=true; selectedTools=[read, grep]       (not a transcript entry)
130 user
140 system delta: replace plan_mode; toolsRemoved=[write]; toolsAdded=[grep]
150 assistant
```

A crash between 125 and 140 preserves the config; the next generation prepares the missing change.
A crash after 140 but before the provider call also preserves that entry. An unchanged hook answer
produces no duplicate delta. Neither event proves the provider saw the instructions. A fork uses its
visible prefix and inherited rewindable config; changed host sources on restart may cause a new delta,
but cannot rewrite old messages.

**Head changes and fresh baselines.** A current-epoch baseline is a managed baseline after the newest
visible head entry in transcript order (not after its retained boundary). With none, append a complete
baseline carrying ordinary omission edits for superseded retained managed system entries. Include old
baselines as well as deltas, but never unrelated system notices. Store the omissions on that same
baseline entry, not on the head, so arbitrary head writers remain generic and a fork cannot land
between replacement instructions and their omission controls.

```text
10 user; 11 baseline; 20 assistant; 30 user; 31 system delta; 35 job notice; 40 assistant; 50 user
60 summary, head=30
context at 60: [60 summary, 30 user, 31 delta, 35 notice, 40 assistant, 50 user]
70 assistant
80 user
81 system { baseline:true, full sections, full desired toolsAdded,
            edits:[{ target:31, action:omit }] }
context at 81: [60 summary, 30 user, 35 notice, 40 assistant, 50 user, 70 assistant, 80 user, 81 baseline]
```

The baseline stays at its appended position after the retained tail. Before preparation, old retained
system entries remain visible; generic context derivation never secretly suppresses them. Every
request goes through preparation first. Repeated heads use the same rule. Reset/handoff often leave
no old managed entries inside the retained range, so the new baseline needs no omission targets.
Compute the remaining tool fold after planned omissions: a baseline adds the complete desired tool
set and explicitly removes unwanted declarations that remain from other effective system messages.
`baseline:true` is pico metadata, not a magic reset understood by pi-ai.

**Frozen request cutoff and cache.** The generation stores the following request-specific field:

```ts
// Request fields on the streaming variant; other generation variants/fields are omitted.
interface GenerationStreamingState {
  readonly status: "streaming";
  readonly inputs: readonly Id[];
  readonly requestThrough: Id; // inclusive transcript entry cutoff, required after preparation
}
```

Capture the durable section-state cursor and registered definitions before running hooks/renderers
outside the line. Preparation retains that definition snapshot; later registrations affect subsequent
preparations. On the line, verify that no concurrent managed section-state write changed the seed;
if one did, rerun preparation outside the line. A head-only change does not stale the section seed.
Then inspect the current head and effective model state, choose baseline versus delta, and persist
the new system entry if needed and the generation's inflight intent with `requestThrough`.
The cutoff is the resulting transcript tip, even when no system entry was needed. Deferred variants
retain the cutoff for their prepared request; an unprepared pending variant has none. After persistence,
while still on the line, catch up the handle's context cache and capture a separate immutable array
of the selected entry references and effective replacement projections. This is the request snapshot;
entry bodies are immutable and can be shared. Never hand out mutable cache bookkeeping or mutate a
published replacement. Request-local normalization/hooks copy the objects they modify.

```text
prepare through 51 → requestThrough=51, snapshot captured
head 60 lands     → live cache advances; request snapshot stays unchanged
request streams   → uses snapshot through 51
next preparation  → sees head 60; writes a fresh baseline if required
```

If a head lands while the hook is running, preparation sees the new head and chooses a baseline.
If it lands after preparation, the captured request is unaffected. Historical/recovery reads through
`requestThrough` derive independently from storage when the live cache has advanced; they do not rewind
it. Release request-only references after use; no registry of historical cache versions is retained.
The cutoff identifies canonical transcript input, not arbitrary request-local hook changes.

**Pi-ai owns provider translation.** Pico passes only `{ messages }`, with neither top-level
`systemPrompt` nor `tools`, even when there are no selected tools. Both fields absent selects the
agreed pi-ai system-message mode; explicit empty strings/arrays are not absence. Adapters translate
the stored message history for their provider/model, preserving cache prefixes where possible.
Unsupported mid-conversation instruction/tool changes fall back to `<system>`-bracketed user messages
at their historical positions and adapter-derived bulk wire tool declarations. Pico never hoists a
baseline, flattens historical changes into a rewritten prompt, or sends a parallel top-level tool list.
Fallback user messages do not have native system priority; cache reuse is best-effort, not universal.

The pi-ai `SystemMessage` shape comes from [PR #9116](https://github.com/earendil-works/pi/pull/9116);
[PR #9117](https://github.com/earendil-works/pi/pull/9117) covers coding-agent prompt/tool deltas. These
were open when this contract was reviewed. Messages-only mode and its adapter fixtures are an external
integration requirement, not a claim that the current main branch already implements them.

**Request-local overrides.** `before_request` receives a private request copy and may transform it.
Validate afterward that it remains messages-only. Such transformations neither mutate stored entries
nor alter the canonical section fold for the next generation. Exact transformed-request audit requires
separate optional capture; the transcript alone records only canonical preparation. Validate returned
tool calls against the definitions actually offered after transformation, plus implementation and
permission checks—not today's catalogue or the untransformed tool set.

One task lives through retries and deferral; retries share a budget carried in state. Overflow
does not keep the generation alive: it settles and hands the retry to the collapse's settlement,
carrying the attempt count, so nothing live ever waits on the collapse.

```text
recover streaming:  frames in scratch → retain/publish the partial for display; settle without tools/results
                    no frames → retry within budget, else fail
recover deferred:   execute again; the handle is in state
abort:              fresh invocation after execute/recover returned:
                    read committed scratch; optionally retain partial for display, excluded from requests;
                    in one commit resolve owned inputs unanswered(aborted), record known usage, settle aborted;
                    no tool tasks/results; settlement retires scratch
```

Usage is recorded for failed, deferred and discarded attempts too; a missing report is unknown cost,
not zero. A report received only after the cancellation cutoff may not have reached scratch and is
therefore unknown to fresh abort cleanup. The record is a session list, `pi.usage`, one element per
attempt (conversation, task, model, tokens, cost), appended in the settlement commit together with an update of the session
value `pi.usage.totals`, so stats are a point read and never a fold. Tools and jobs append the same
way through the sink's `usage`. Persistence and invariant failures are not provider errors: they fault the session.

### 8.3 Tools and post_tools

```text
tool execute:
  resolve the tool in the registry (the loadout may have changed since the turn started);
  validate the model's arguments against its schema
  before_tool → allow(args) | block(reason, terminate?)     (a human approval waits inside the hook)
  block / invalid / unknown tool → own error result, no invocation
  { status running; effective args; replay policy }
  invoke tool(callId, params, out, runtime, call); the sink owns its scratch promises (§9.3)
  after_tool outside the line
  { result entry from the folded sink; usage; settle done with result id and ToolOutputState }
```

The tool never touches context, siblings or queues. A throwing `before_tool` blocks the tool. An
ordinary tool throw is an error result, not a cancellation.

```text
recover:  replay only if the stored policy allows; else an interrupted result from the checkpoint
abort:    previous invocation already returned; read durable scratch and cleanup references;
          mark owned child foreground tasks/non-detached jobs, without touching child queues;
          write aborted error result; settle
```

post_tools is the code in §5.5: read the tool tasks, stop on terminate, write the handoff if one
was requested, place writes and steering, carry the extended input group into the next generation,
and settle. Its abort resolves its input group as `unanswered` with reason `aborted` and settles
with no successor.

**Blocking budget.** A tool call may not block a turn indefinitely. Tools that run processes or
child conversations create a job (or a conversation) first and wait on it with the budget; if the
budget runs out, the call settles now with what it has, `out.delegate(job)` and a diag, and the
work continues as the job:

```ts
const job = await runtime.commit(async tx => {
  const task = await tx.getTask(toolKind, runtime.taskId);
  if (task?.state.status !== "running") throw new Error("Expected a running tool");
  const { status, ...payload } = task.state;
  const id = tx.task(jobKind, { background: true,
    state: { status: "planned", cmd, cwd, origin: { tool: "bash", task: runtime.taskId, callId: toolCallId } } });
  tx.patch(task, status, { ...payload, jobId: id, cancelJobOnAbort: true }); // complete running payload
  return id;
}, call);
const done = await runtime.waitForTask(job, { budgetMs: runtime.budgetMs }, call);
const output = await runtime.jobOutput(job, call);
out.replace(output.text); out.capture(output.truncation);
if (!done) {
  out.delegate(job);
  out.diag("info", `still running as job ${job}; use job wait / status / stop`, "budget");
}
```

The budget is the generation's config (`budgetMs`, default a few minutes); the tool kind passes it
as `runtime.budgetMs`. `waitForTask` observes Call cancellation and unregisters its waiter. A marked
tool cannot mutate from its execute catch; its fresh abort handler reads the stored job reference and
cancels non-detached work. Explicit backgrounding records a different cancellation policy. Successful
delegation settlement atomically records that the job is detached and requests its completion notice;
if the job has already finished, that transaction places the notice itself. Use a separate sticky
notification record rather than patching the state of a running job from its former owner.

**Remaining budget integration question:** adopting arbitrary non-delegating tool work after timeout
requires an explicit transfer of effect and sink ownership before the source invocation releases its
slot. Racing and abandoning the tool promise is not a correct implementation. Preserve this capability
for a separate ownership design; crash recovery remains `lost`. The job-first path above needs no
promise adoption and is the initial implementation path.

`new_context` is a tool that calls `out.handoff(message)`; the reset happens here, after the exchange
is complete, never inside the tool, because a head landing mid-exchange would cut it in half. Conflicting handoffs reject rather than pick an order.

A final answer's continuation is decided in the generation's settlement. `on_yield` may request an
explicit continuation that keeps the current input group. Otherwise the answer resolves that group,
then eligible steer/followUp items are placed into a new group and its generation. An owned
conversation's final answer still resolves its own inputs; its owner tool observes that result while
driving it (§8.5). An idle conversation whose tail is a user entry creates no work by inference.

### 8.4 Collapse

```text
create:   capture the prefix to replace (ending on a complete exchange), its first retained entry,
          the newest head id, context and settings; one live collapse per conversation
execute:  { status summarizing }
          before_collapse (may decline or supply the summary); call the summarizer; candidate to scratch
          { if no head newer than the captured one:
              append summary { model:[summary], head:firstRetained }; settle done
            else: settle failed(stale) }
```

Entries that land while it runs remain at or after the prepared retained boundary, so they stay in
context without anyone doing anything. Context edits that land meanwhile affect active projection
but do not invalidate or recompute the summary. A summary may land while a generation streams,
since the stream already projected its context and the replaced prefix is old. Automatic collapses
(threshold, overflow) are foreground; manual ones are background. A collapse never creates a
generation except through the settlement chain in §8.2. Abort records usage and settles without
publishing. Prefix pruning/windowing appends another entry with a stored head; pruning or replacing
individual retained entries uses edit entries (§2.1). Dynamic `compose` policies are unsupported.

### 8.5 Subagents

A subagent is a conversation. There is no subagent task, and there is one tool, `subagent`, whose
argument is a command:

```ts
type SubagentCommand =
  | { command: "run";    prompt: string; context?: "fresh" | "inherit"; tools?: string[] }   // foreground
  | { command: "spawn";  prompt: string; context?: "fresh" | "inherit"; tools?: string[] }   // background
  | { command: "send";   id: Id; text: string }
  | { command: "status"; id: Id }
  | { command: "wait";   id: Id }
  | { command: "stop";   id: Id };
```

```text
run:     { create child conversation (this task owns it); initial values; accept prompt → inputId; first generation }
         await child.drive(call)                   // cancels this waiter, not the child
         child.result(inputId, call); { result entry; settle }
         recover: the child exists; drive it again with the fresh Call
         abort: mark child's foreground tasks only, preserve its queues; write own error result and settle

spawn:   the same creation commit; settle at once with the child's id
send:    child.accept({ input: text }, call) → queued if the child is busy
status:  the child's tail and live tasks
wait:    await child.drive(call); child.result(lastInputId, call); settle    (recover: drive again)
stop:    child.abort(call)
```

`id` is whatever `spawn` returned, passed back by the model; the tool resolves it with
`runtime.conversation(id, call)`. There is no separate subagent registry to rebuild after a restart.
Between `spawn` and `wait`, whatever drives the parent's tree drives the child. A spawned child is owned by a task that
is already terminal, so it is not in the parent's foreground set and aborting the parent leaves it
alone; `stop` is the way to cancel it. Inherited context for a child is the parent's context at the
last complete exchange before the launching one.

### 8.6 Jobs and schedules

A job is a background task that runs a process. Its state:

```ts
type JobInput = {
  cmd: string; cwd: string; limits?: ShellOutputLimits;
  origin?: { tool: string; task: Id; callId: string }; // originating call, for UIs
  every?: number; notBefore?: number; rerun?: "safe"; // recurrence and recovery policy
};
type JobState = JobInput & (
  | { status: "planned" }
  | { status: "running"; startedAt: number }
  | { status: "exited"; output: ToolOutputState; exitCode: number }
  | { status: "killed"; output: ToolOutputState }
  | { status: "lost" }
);
```

Starting one is creating the task; a tool does it in its execute (§8.3), a UI in a commit:

```ts
const jobId = await conv.commit(tx =>
  tx.task(jobKind, { background: true, state: { status: "planned", cmd: "npm test", cwd, every: 6 * 3600_000 } }), call);
```

```text
states:  planned { cmd, cwd, every?, notBefore? } | running { …, startedAt } |
         exited { …, output, exitCode } | killed { …, output } | lost { … }
roles:   planned=start; running=inflight; exited/killed/lost=terminal
execute: sleep until notBefore with Call; { status running; startedAt = runtime.now() }
         env.exec(command, options, call), with bounded capture and spill
         harness progress bridge owns scratch writes, handles cancellation and drains callbacks
         after process and progress bridge return:
           { if notification requested: append notice and consume notification request;
             if recurring: status planned, notBefore = runtime.now() + every;
             otherwise: settle exited with bounded output and exitCode }
         a post-mark write rejects TaskCancelled; no in-band killed settlement
recover: safe rerun policy → execute again with the fresh Call
         otherwise { consume pending notice request; append lost notice if requested; settle lost }
abort:   previous invocation and its process/progress callbacks have returned
         read committed output from scratch;
         { consume pending notice request; append killed notice if requested; settle killed }
```

The progress bridge is harness-owned sink plumbing (§6.3), not a plugin-created detached promise.
It observes every scratch result, suppresses only expected cancellation/close rejections, reports
persistence faults, and is joined with process execution. Notification requests are current sticky
state keyed by job id; consuming them and publishing the notice is atomic on every terminal path,
including exited, lost and killed. If delegation follows settlement, delegation publishes that same
outcome instead. The two orderings must not change notification behavior.

`runtime.env` is the harness's `ExecutionEnv` (`FileSystem & Shell`); `exec` runs the command, captures
output through `onUpdate` (here into scratch, so a watcher can show it live) and returns when it
exits or the signal fires. `running` is inflight, so a restart goes through `recover`; since the
shell doesn't hand out an adoptable process, recover reruns if the job declared that safe and
otherwise settles `lost`. A recurring job is the same task looping `planned → running → planned`;
`abortTask(id)` ends it wherever it is. Output stays in scratch while it runs and in the terminal state
after, where `jobOutput`, the `job` tool and UIs read it; there is no result entry, since a call that
waited already carries the output. A job whose call returned early appends a `notice` entry with a stored `SystemMessage` when it
finishes, so the next generation learns of it without
polling. Interval and catch-up policy are in state,
so a restart never launches a backlog.

### 8.7 Hooks

Hooks belong to kinds. A kind declares its points and their types; plugins register handlers per
kind and point; the harness only routes:

```ts
type HookPoints = Record<string, { input: unknown; output: unknown }>;

interface GenerationHooks extends HookPoints {
  system_instructions: { input: { conversationId: number; config: GenerationConfig; sections: SystemSectionDraft };
                         output: void | { tools?: readonly Tool[] } }; // sections mutate one shared preparation draft
                         // handlers run sequentially; new keys append; set replaces; delete is explicit
  before_request: { input: { request: ProviderRequest }; output: { request?: ProviderRequest } };
  after_response: { input: { response: AssistantMessage; usage: Usage }; output: void };
  on_yield:       { input: { answer: AssistantEntry }; output: { continue?: string } };
}
interface ToolHooks extends HookPoints {
  before_tool: { input: { toolCallId: string; toolName: string; args: JsonObject };
                 output: { args?: JsonObject; block?: { reason: string; terminate?: boolean } } };
  after_tool:  { input: { toolCallId: string; output: ToolOutputState }; output: void };
}
interface CollapseHooks extends HookPoints {
  before_collapse: { input: { reason: "manual" | "threshold" | "overflow"; entries: readonly Entry[] };
                     output: { decline?: boolean; instructions?: string; summary?: string } };
}

const generationKind = defineTaskKind<GenerationState, GenerationHooks>()({ ..., hooks: { before_request: {}, after_response: {}, on_yield: { failClosed: false } } });
const toolKind = defineTaskKind<ToolStates, ToolHooks>()({ ..., hooks: { before_tool: { failClosed: true }, after_tool: {} } });

// a plugin registers a handler
harness.hooks.on(toolKind, "before_tool", async ({ toolName, args }, call) => {
  if (toolName === "bash" && !(await ui.approve(args, { signal: call.abortSignal }))) return { block: { reason: "denied" } };   // may wait for a human
});

// the kind runs it
const decision = await runtime.hooks(toolKind).run("before_tool", { toolCallId, toolName, args }, call);
```

A handler can be scoped to a conversation instead of the whole harness; for `system_instructions`
that is the normal case, since a subagent is a different agent:

```ts
root.hooks.on(generationKind, "system_instructions", hostInstructions, { subtree: true });  // root and what it owns
child.hooks.on(generationKind, "system_instructions", investigatorInstructions);           // this child only; overrides for it
```

Scoped handlers run after harness-wide ones for the same point, innermost conversation last, so a
child's sections win by key. Registration is process state, not durable; a presentation registers
when it attaches.

Handlers run in registration order, each seeing the merged output so far; the kind decides what
to do with the result. A handler runs outside the line and its decision is applied inside a commit
whose runtime validates current invocation authority. Handlers receive a required final Call,
forward it to waits/effects, and must return before their parent task invocation releases ownership.
Cancellation control errors bypass ordinary hook failure policies. Handlers may run again after a
crash, so their external side effects need their own idempotence. `failClosed` says what a throw means: for `before_tool`
a throw blocks the tool; for the others a throw is reported and skipped. `before_tool` may wait as
long as it likes (a human approval is a hook that waits); the task is still `planned` meanwhile
and a crash simply asks again. A plugin kind declares its own points the same way, and a plugin
that replaces a built-in kind keeps its hook names so existing handlers keep working. Commit
listeners are not hooks: they observe, never decide, and never await a commit on the same line.

## 9. API

### 9.1 Handles

```ts
interface ConversationHandle {
  readonly id: Id;
  snapshot(call: Call): Promise<Conversation>;
  accept(options: { input: UserInput; requestId?: string;
                    whenBusy?: "followUp" | "steer" | "reject" }, call: Call): Promise<{ inputId: Id }>;
  prompt(options: { input: UserInput; requestId?: string;
                    whenBusy?: "followUp" | "steer" | "reject" }, call: Call): Promise<AssistantEntry | undefined>;
  result(inputId: Id, call: Call): Promise<InputResult | undefined>;
  drive(call: Call): Promise<"idle" | "closed">;
  queueInput(input: QueuedInput, call: Call): Promise<{ inputId: Id }>;      // §8.1
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>, call: Call): Promise<{ inputId: Id }>;   // §5.8
  abortInput(inputId: Id, call: Call): Promise<"aborted" | "not_found">;
  abort(call: Call): Promise<void>;
  collapse(options: { instructions?: string } | undefined, call: Call): Promise<Id>;
  reset(options: { handoff?: string } | undefined, call: Call): Promise<void>;
  fork(options: { at: Id | "start"; abort?: boolean; values? }, call: Call): Promise<ConversationHandle>;
  spawn(options, call: Call): Promise<Id>;
  value(addr) / list(addr) // async reads/writes take a final Call
  config<C extends ConfigSpec>(kind: { readonly kind: string; readonly config?: C }): { get(call: Call): Promise<ConfigValues<C>>; set(partial: Partial<ConfigValues<C>>, call: Call): Promise<void> };
  readonly hooks: { on(kind, point, handler, o?: { subtree?: boolean }): () => void };   // scoped to this conversation (§8.7)
  readonly settings: ConfigHandle<GenerationConfig>;   // sugar: config(generationKind)
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
}

interface Harness {
  readonly entryKinds: EntryKindRegistry; // mutable registration (§9.6)
  readonly taskKinds: TaskKindRegistry;
  readonly sections: SystemSectionRegistry;
  root(call: Call): Promise<ConversationHandle>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  conversations(query, call: Call): Promise<Page<Conversation>>;
  acceptance(requestId: string, call: Call): Promise<{ requestId: string; conversationId: Id; inputId: Id } | undefined>;
  inspect(call: Call): Promise<{ start: Task[]; inflight: Task[]; orphaned: Task[]; parked: Task[] }>;
  drive(call: Call): Promise<"idle" | "closed">;
  getEntry(id, call); getEntry(kind, id, call); getEntries(ids, call); getEntries(kind, ids, call);
  entries(conversationId, page, call);
  getTask(id, call); getTask(kind, id, call); getTasks(ids, call); getTasks(kind, ids, call);
  abortTask(id: Id, call: Call): Promise<void>;
  value(addr) / list(addr) // session state handles; async methods take Call
  commit<T>(plan: (tx: Tx) => T | Promise<T>, call: Call): Promise<T>;
  watch(conversationId: Id, options: { tail: number; values?: Address[]; raw?: boolean }, call: Call): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watch(call: Call): Promise<WatchHandle<SessionView, SessionEvent>>;
  deleteConversation(id: Id, call: Call): Promise<void>;
  shutdown(call: Call): Promise<void>;
  close(call: Call): Promise<void>;
}
```

`Call` is defined in §6.5. `call.abortSignal` cancels the drive caller's wait, not the work.
`fork({ at, abort: true }, call)` marks the source's foreground set in the same commit that creates the fork, for "go back to that point"; which
conversation a UI treats as current is the UI's business. `prompt` returns the answer entry only
when its input's result is `done` with an `answer`; `unanswered`, or input still `placed` when the
drive returned, gives `undefined`. `result(inputId, call)` is one sticky-value point read, never a
transcript scan. After an uncertain remote response, `acceptance(requestId, call)` recovers the
conversation and input identity, or the caller simply retries with the same request key and gets
the same `inputId` back (§3.4).

### 9.2 Commits

```ts
const entryId = await harness.commit(tx => {
  tx.value(planMode).set(true);                              // state first (§3.2)
  const id = tx.entry(noteKind, conversationId, {
    data: { text: "plan accepted" },
    model: [{ role: "user", content: "<note>plan accepted</note>", timestamp: 0 }],
  });                                                       // final id, inside the closure
  tx.task(reminderKind, { background: true, state: { status: "scheduled", about: id } });
  return id;                                                // any value; resolved after commit
}, call);
```

```ts
type EntryInput<E extends Entry> =
  Omit<E, keyof EntryIdentity | "head"> &
  (E extends ContextHead ? { readonly head: Id | "self" } : { readonly head?: never });

interface EntryDraft {
  readonly key?: string;
  readonly data?: JsonValue;
  readonly model?: readonly Message[];
  readonly head?: Id | "self";
  readonly edits?: readonly ContextEdit[];
}

// Distribute over the declared variants; orphaned is never a public write target.
type StatesWithRole<S extends TaskStateBase, R extends TaskRoles<S>, Role extends TaskRole> =
  S extends TaskStateBase
    ? S["status"] extends "orphaned" ? never : R[S["status"]] extends Role ? S : never
    : never;

// Keep status and payload correlated, even when callers pass unions.
type WriteArgs<S extends TaskStateBase> = S extends TaskStateBase
  ? [status: S["status"], payload: Omit<S, "status">]
  : never;
type ExactWrite<S extends TaskStateBase, A extends WriteArgs<S>> = A & [
  status: A[0],
  payload: Record<Exclude<keyof A[1], keyof Omit<Extract<S, { status: A[0] }>, "status">>, never>,
];

interface Tx {
  // reads (committed state)
  getEntry(id) / getEntry(kind, id) / getEntries(...) / getTask(id) / getTask(kind, id) / getTasks(...)
  value<T>(addr: Value<T>): { get(at?): Promise<T | undefined>; set(v: T): void; delete(): void };
  list<T>(addr: List<T>): { append(v: T): Id; remove(id: Id): void; clear(): void; read(q): Promise<Page<Element<T>>> };
  // writes; rewindable conversation state before entries (§3.2)
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;   // §5.8
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Id;   // inputId; appends now or queues (§5.8)
  queueInput(input: QueuedInput): Id;                                     // inputId (§8.1)
  task<S extends TaskStateBase, R extends TaskRoles<S>>(kind: TaskDefinition<S, R>,
    spec: { state: S; after?: Id[]; background?: true; owns?: Id[] }): Id;
  patch<S extends TaskStateBase, R extends TaskRoles<S>,
        A extends NoInfer<WriteArgs<StatesWithRole<S, R, "start" | "inflight">>>>(
    task: TypedTask<S, R>, ...args: A & NoInfer<ExactWrite<StatesWithRole<S, R, "start" | "inflight">, A>>): void;
  settle<S extends TaskStateBase, R extends TaskRoles<S>,
         A extends NoInfer<WriteArgs<StatesWithRole<S, R, "terminal">>>>(
    task: TypedTask<S, R>, ...args: A & NoInfer<ExactWrite<StatesWithRole<S, R, "terminal">, A>>): void;
  createConversation(spec): Id;  deleteConversation(id: Id): void;
}
```

Both operations take an explicit target status and its **complete payload without status**:

```ts
tx.patch(task, "running", { call, assistant, args, replay });
tx.settle(task, "done", { call, assistant, output, result });

// Same-status update: narrow, remove the tag, then supply the full replacement.
if (task.state.status === "running") {
  const { status, ...payload } = task.state;
  tx.patch(task, status, { ...payload, jobId });
}
```

There is no status-free or partial-merge overload. Both writes replace the stored state with
`{ ...payload, status }`; fields from the previous variant are not retained implicitly. `patch`
accepts start/inflight targets, `settle` terminal targets and retires scratch. Neither permits
`orphaned`; only open's internal orphan handling writes it. Same-status replacement remains valid
but does not advance `statusEpoch`. Creation still receives the complete initial tagged state.
An invocation's task snapshot does not change after patch; read again when a later replacement
needs state committed since that snapshot, or carry the explicitly constructed next payload.

`WriteArgs` is a union of status/payload tuples: a union-valued status and an unrelated payload do
not prove a valid pair. `NoInfer` prevents arguments from widening the task's known union/role map.
`ExactWrite` rejects extra top-level keys visible in a variable or spread, not just object literals,
including a duplicated status. These are static checks, not runtime schema validation: casts, erased
extra fields and nested structural typing still follow TypeScript's limits. Wire boundaries validate
untrusted payloads; line validation checks current liveness, invocation ownership and allowed roles.

The implementation below shows erased runtime signatures; the public signatures are above. It
numbers as it goes, keeps the one ordering rule, and hands storage a batch; storage numbers from its own `lastSeq` and gets the same ids (§7.3).

```ts
class Tx {
  private writes: MainWrite[] = [];
  private seq: number;
  private sawEntry = false;
  constructor(private storage: Storage, private kinds: Kinds) { this.seq = storage.lastSeq; }

  private push(w: MainWrite): number { this.writes.push(w); return ++this.seq; }
  private state(w: StateWrite): void {
    if (this.sawEntry && "conversation" in w.addr.scope && w.addr.rewind)
      throw new Error("rewindable conversation state must precede entries (§3.2)");
    this.push(w);
  }

  value<T>(addr: Value<T>) {
    return {
      get: (at?: number) => this.storage.getValue(addr, at).then(v => v?.value),   // committed state
      set: (value: T) => this.state({ type: "value.set", addr, value }),
      delete: () => this.state({ type: "value.delete", addr }),
    };
  }
  list<T>(addr: List<T>) {
    return {
      append: (value: T) => { this.state({ type: "list.append", addr, value }); return this.seq; },
      remove: (element: number) => this.state({ type: "list.remove", addr, element }),
      clear: () => this.state({ type: "list.clear", addr }),
      read: (q: ListQuery) => this.storage.readList(addr, q),
    };
  }

  entry(kind: EntryKind, conversationId: number, draft: EntryDraft): number {
    this.sawEntry = true;
    const id = this.seq + 1;
    const { head, ...fields } = draft;
    const entry: Entry = {
      id, conversationId, kind: kind.kind, ...fields,
      ...(head === "self" ? { head: id } : head === undefined ? {} : { head }),
    };
    this.push({ type: "entry", entry });
    return id;
  }
  task<S extends TaskStateBase, R extends TaskRoles<S>>(
    kind: TaskDefinition<S, R> & { readonly initialStatus: S["status"]; readonly turn?: true }, spec: {
    conversationId: Id; state: S; after?: Id[]; background?: true; owns?: Id[];
  }): Id {
    const id = this.seq + 1;
    if (spec.state.status !== kind.initialStatus) throw new Error(`initial status must be ${kind.initialStatus}`);
    const role = getOrThrow(kind.roles[spec.state.status]);
    this.push({ type: "task", task: { id, kind: kind.kind, role, turn: kind.turn, ...spec } });
    return id;
  }
  patch(task: Task, status: string, payload: JsonObject) {
    if (Object.hasOwn(payload, "status")) throw new Error("payload must not include status");
    const role = this.roleFor(task.id, status);
    if (role === "terminal") throw new Error(`${status} requires settle`);
    this.push({ type: "patch", id: task.id, role, state: { ...payload, status } });
  }
  settle(task: Task, status: string, payload: JsonObject) {
    if (Object.hasOwn(payload, "status")) throw new Error("payload must not include status");
    if (this.roleFor(task.id, status) !== "terminal") throw new Error(`${status} is not terminal`);
    this.push({ type: "settle", id: task.id, role: "terminal", state: { ...payload, status } });
  }
  private roleFor(id: Id, status: string): TaskRole {
    /* kind from transaction view; reject unknown status and reserved orphaned */
  }

  getTask = this.storage.getTask; getTasks = this.storage.getTasks;   // reads: committed state
  getEntry = this.storage.getEntry; getEntries = this.storage.getEntries;

  batch(): CommitBatch { return { kind: "main", writes: this.writes }; }
}

// The line owns admission, persistence, indexes and decisions; callbacks run afterward.
async commit<T>(plan: (tx: Tx) => T | Promise<T>, call: Call): Promise<T> {
  const completed = await this.line.run(async () => {
    const invocation = call.value(invocationKey);
    this.checkAdmission(invocation);               // phase, exact running identity, method and mark (§6.3)
    const tx = new Tx(this.storage, this.kinds);
    const result = await plan(tx);
    const batch = tx.batch();
    this.validate(batch, invocation);              // whole-batch authority and structural invariants
    if (batch.writes.length === 0) return { result, actions: [] };
    await this.storage.commit(batch);
    const actions = this.driver.applyBatch(batch); // apply ALL writes; then reserve affected work/waiters
    this.publishState(batch, actions);             // fold views, enqueue delivery; no listener execution
    return { result, actions };
  });
  this.dispatch(completed.actions);                // start effects, signal controllers, deliver callbacks
  return completed.result;
}
```

`ConversationTx` is the same with `conversationId` bound. `ScratchTx` is the `value`/`list` half
with the batch tagged `scratch`. Builders may be async to await storage reads on the line; no other
line operation can interleave. Reads (including Tx/ScratchTx value/list/entry/task reads) return
Promises; writes are synchronous, buffered and validated in order. Never await an external effect,
a driver waiter or another line operation inside the builder. Ids are final when returned, and a
throw discards everything. The outer promise resolves
with the closure's value after persistence and publication, which is when ids may escape.
`ConversationHandle.commit` binds the conversation; `TaskRuntime.commit` is the same for task
code.

### 9.3 Task and tool integration

```ts
interface Tool<TParams, TDetails extends JsonValue> {
  readonly name: string; readonly description: string; readonly parameters: JsonSchema<TParams>;
  readonly output?: ShellOutputLimits;               // retained window for text output
  readonly replay?: "safe" | "never";
  execute(toolCallId: string, params: TParams,
          out: ToolOutput<TDetails>, runtime: ToolRuntime, call: Call): Promise<void>;
}

// the sink; everything a tool produces goes through it (mobile-handoff/01-harness/04-tool-output)
interface ToolOutput<TDetails extends JsonValue> {
  write(text: string): void;                         // append to the text block
  image(image: ImageContent): void;                  // images are never windowed
  replace(text: string): void;                       // replace the retained text wholesale
  capture(metadata: ShellOutputMetadata): void;      // truncation totals / spill path, no text resent
  readonly details: TDetails;                        // the tool's own details object; mutate it
  usage(usage: Usage): void;                         // accumulates
  addTools(names: string[]): void;                   // replaces; post_tools updates selected tools (§5.5)
  terminate(value: boolean): void;                   // replaces; orthogonal to how execution ended
  handoff(message: string): void;                    // replaces; new_context asks for a reset (§8.3)
  delegate(job: Id): void;                           // this call's work continues as that job (§8.6); generic, so UIs can follow it
  diag(severity: "info" | "warn" | "error", message: string, code?: string): void;   // commentary, see below
}

interface ToolRuntime {
  readonly taskId: Id;                               // the tool task; identity for origin/for links
  readonly budgetMs: number;                         // blocking budget (§8.3)
  readonly env: ExecutionEnv;                        // FileSystem & Shell
  commit<T>(plan: (tx: ConversationTx) => T | Promise<T>, call: Call): Promise<T>;
  conversation(id: Id, call: Call): Promise<ConversationHandle | undefined>;
  abortTask(id: Id, call: Call): Promise<void>;
  waitForTask(id: Id, options: { budgetMs?: number } | undefined, call: Call): Promise<boolean>;
  jobOutput(id: Id, call: Call): Promise<ShellOutputView & { exitCode?: number }>;
}

// what the live sink folds to; recorded on the tool task and used to build the result entry
interface ToolOutputState {
  content: (TextContent | ImageContent)[];
  details: JsonValue;
  usage?: Usage;
  addedTools?: string[];
  terminate: boolean;
  handoff?: string;
  delegated?: Id;
  diags: readonly { severity: "info" | "warn" | "error"; message: string; code?: string }[];
  truncation: ShellOutputTruncation;                 // totals over everything ever written
}

type ToolResultData = Omit<ToolOutputState, "content">;
```

`execute` returns nothing and reports failure by throwing; the harness sets `isError` when it
rejects, and a tool may throw anything. `terminate` is orthogonal to how execution ended, so a
failing tool can still stop the turn (`out.terminate(true); throw error`). Usage and `addTools` go
through the sink rather than a return value so that a replayed tool can seed from durable state.
The sink owns its scratch promises: it handles expected post-mark/close rejections, reports real
persistence errors and drains pending callbacks before the invocation returns. Raw plugin scratch
writes must be awaited/caught. The sink's text ops (`write`, `replace`, and the `slide` the env emits
for a moving tail) are what scratch and the watch stream carry, so a UI shows output live without the tool doing anything.

**Diagnostics are a channel, not text.** Commentary about a call (it was truncated, the output
spilled to a file, the path was resolved differently, the file changed on disk since it was read,
the search stopped at 500 matches) goes through `out.diag`, never into the text the model reads as
the tool's data. The harness emits the ones it owns: the sink calls `diag` itself when it truncates
or spills, the path resolver when it corrects a path, the blocking budget when a call continues as
a job. A tool adds only what it alone knows. Tool settlement renders the data first and the
diagnostics after it, delimited, and stores that message on the result entry:

```text
…last line of the file
<harness>
[warn] output truncated: 2,000 of 51,204 lines shown; full output at /tmp/pi/out-4421.log
</harness>
```

so the model can parse tool output as data, a plugin can post-process it without stripping notices
it doesn't know, and a UI renders diagnostics as callouts by severity. `isError` says whether the
call failed; a `warn` diag does not change it. Tool settlement stores the exact rendered result as
entry `model`; the non-message fields of `ToolOutputState` become `ToolResultData` for typed logic
and rendering. The transcript therefore records exactly the commentary the model saw without
copying the message into `data`.

### 9.4 Watch

The transport is the commit stream, gap-free and replayable. The interface is typed events derived
from it by the harness, and a view the harness keeps current, so a client renders and never parses
commits:

```ts
interface WatchHandle<View, Event> {
  readonly view: View;                     // captured on the line at watch(); folded before each event is delivered
  start(listener: (event: Event) => void): void;   // delivers everything since the capture, then live
  resnapshot(call: Call): Promise<View>;   // fresh capture, same subscription (when lagging)
  unsubscribe(): void;
}

interface ConversationView {
  readonly conversation: Conversation;
  readonly entries: readonly Entry[];      // the last `tail` entries; older ones via entries(id, { before })
  readonly context: readonly Id[];         // the derived context, as ids
  readonly tasks: readonly Task[];         // live tasks, typed by kind (retry attempt, deferred handle, ToolOutputState ... in state)
  readonly inbox: readonly Element<QueuedInput>[];
  readonly values: ReadonlyMap<Address, JsonValue>;   // every value the registered kinds declare in config, plus any asked for
  readonly previews: ReadonlyMap<Id, JsonValue>;      // per live task: the kind's tracked preview (§5.2)
  readonly faulted: boolean;
  readonly readAt: Id;
}

type InboxOp =
  | { readonly type: "append"; readonly item: Element<QueuedInput> }
  | { readonly type: "remove"; readonly id: Id }
  | { readonly type: "clear" };

type ConversationEvent =
  | { type: "entry";        entry: Entry }
  | { type: "task_start";   task: Task }
  | { type: "task_update";  task: Task; previous: Task }
  | { type: "task_end";     task: Task }
  | { type: "task_output";  task: Id; ops: readonly DeltaOp[] }           // ops on the task's preview; applied to view.previews
  | { type: "value";        addr: Address; value: JsonValue | undefined }
  | { type: "inbox";        ops: readonly InboxOp[] }
  | { type: "context";      ids: readonly Id[] }                  // a head or edit changed derived context
  | { type: "fault";        error: unknown } | { type: "closed" };

const w = await h.watch(c.id, { tail: 100, values: [myPlugin.config.mode] }, call);
render(w.view);
w.start(event => render(w.view, event));    // w.view is already folded when the listener runs
```

The view is authoritative and the events are wake-ups: a renderer is `apply(view)`, diffing against
what it last drew (entries keyed by id, tool components keyed by task id), and it may ignore an
event's payload and still be correct. The payload is for skipping work on a hot path (`task_output`:
redraw one component from its preview) and for logs and tests.

Because every piece of work is a task of a known kind, the four task events carry what the lane
harness needed a name per case for, and cover plugin kinds without anyone adding one:

| lane event | v3 |
|---|---|
| run_start / run_end | task_start / task_end where `generationKind.is(task)` |
| retry_scheduled, run_suspend | task_update with status `retry_wait` (attempt, notBefore) / `deferred` (handle) in state |
| message_update | task_output on the generation; `view.previews` holds the partial assistant message |
| tool_start / tool_update / tool_end | task_start / task_output / task_end on the tool task; `ToolOutputState` in state |
| compaction_start / compaction_end | task_start / task_end where `collapseKind.is(task)`; reason and summary id in state |
| navigation_start / end | a conversation created (session watch); with `abort`, task_end aborted on the source |
| config_update, value_update | value |
| queue_update | inbox |
| entry_added, message_end | entry |

Events are delivered per commit, in commit order, all events of one commit before any of the
next, so a terminal task and its successor never show as an idle gap. `watch` captures the view
and registers the subscription in one serialized step on the line, so nothing falls between them.
Task-output watch events travel as Chord delta ops only; durable scratch uses ordinary records (§7.4).
For watch delivery, the folded preview lives in the view, never in the event. `resnapshot` marks a
barrier on the delivery tail while the line holds the new capture, so calling it from inside the
listener neither deadlocks nor refolds stale state. Buffering is bounded; a lagging client gets a
`fault` and calls `resnapshot`. A listener never awaits a commit on the same line.

Events are proportional to their change, and the view fold is a generic reducer,
`applyEvent(view, event)`, exported by the harness package and needing no kinds: append the entry,
upsert the task, apply task-output ops to `previews[task]`, apply inbox ops, set the value. Inbox
operations are folded across one commit before delivery, so an idle acceptance's same-commit append
and remove emits no inbox event. The harness maintains `w.view`
with it, and a UI in another process runs the same reducer on the same events; nothing is
re-diffed for the wire:

```ts
// worker                                                    // ui process
const w = await h.watch(c.id, { tail: 100 }, call);                on("view",  m => { view = m.view; ui.apply(view); });
send({ type: "view", view: w.view });
w.start(e => send({ type: "event", event: e }));             on("event", m => { applyEvent(view, m.event); ui.apply(view, m.event); });
```

The replication contract, so a reducer in another language can't drift: events of one commit
travel as one message; an `Address` serializes to one canonical string key; and preview ops are
Chord delta ops (`packages/chord/src/delta`, mobile-handoff `01-delta`): `r` replace, `s` set, `d`
delete, `a` append, `t` truncate, `p` splice, with the wire codec's interning optional for thin
clients. That applier is already the mobile port; the reducer adds its ten cases on top and the
harness package's implementation is the reference, tested by porting `delta.test.ts` first.

`task_output.ops` are ops on the task's *preview*, which is a Chord delta tracker the kind mutates
in place (`runtime.preview.state`): the generation applies each stream event to a tracked partial
message, the tool's preview is the sink's tracked state, a job's is the same. The harness flushes
the tracker after each scratch commit; a streamed token is one `["a", path, delta]`, computed from
dirty paths and a memcmp, never a recomputed object (a reassigned preview would flush as a full
replace). On attach or reopen the harness builds the preview once with `preview.init(scratch)`
and the first flush is the base. Fan-out to several in-process watchers uses `applyImmutable` or
copies the batch, since `apply` adopts `r` payloads.

The lane-shaped
snapshot (`operation`, `runningTools`, `retry`, `deferred`, `streamingMessage`) is a pure function
of `view.tasks` and `view.previews`; a renderer that wants it computes it. `h.watch(c.id, { raw:
true })` delivers the commits themselves, for a receiver that has a harness and runs the fold.

There is a session-level watch for what isn't one conversation's:

```ts
interface SessionView {
  readonly conversations: readonly Conversation[];
  readonly values: ReadonlyMap<Address, JsonValue>;     // session-scoped: pi.usage.totals, pi.session.name, ...
  readonly faulted: boolean;
  readonly readAt: Id;
}
type SessionEvent =
  | { type: "conversation"; conversation: Conversation; change: "created" | "deleted" }
  | { type: "value";  addr: Address; value: JsonValue | undefined }
  | { type: "usage";  row: UsageRow; totals: Usage }
  | { type: "report"; task?: Id; kind?: string; method?: string; error: unknown } // hook/task errors
  | { type: "fault";  error: unknown } | { type: "closed" };
harness.watch(call: Call): Promise<WatchHandle<SessionView, SessionEvent>>;
```

### 9.5 End to end

```ts
const h = await Harness.open(storage, options, call);
const c = await h.root(call);
const w = await h.watch(c.id, { tail: 100 }, call);  render(w.view);  w.start(e => render(w.view, e));

const answer = await c.prompt({ input: "Inspect the parser" }, call);

const driving = c.drive(call);  await c.abort(call);  await driving;      // durable intent, then cleanup

const child = await c.spawn({ prompt: "Inspect only tests", context: "fresh",
                              values: { inherit: [model] } }, call);
await h.drive(call);                                                  // drives the child too
console.log(await h.conversation(child, call));

const alt = await c.fork({ at: answer.id }, call);
await alt.prompt({ input: "Try a different implementation" }, call);        // source remains untouched

w.unsubscribe(); await h.close(call);
```

```ts
const h = await Harness.open(storage, {
  models,
  tools: [readTool, writeTool, bashTool, ...pluginTools],     // subagent and job tools are built in
  kinds: { entry: pluginEntryKinds, task: pluginTaskKinds },  // added to the built-ins
  replace: { generation: myGenerationKind },                  // swap a built-in by name; same statuses, hook names
  rootValues,
}, call);
h.kinds.generation;  h.kinds.tool;  h.kinds.postTools;  h.kinds.collapse;  h.kinds.job;   // whatever is registered under the name
```

The built-in entry kinds (`user`, `assistant`, `tool_result`, `system`, `notice`, `summary`,
`handoff`, `reset`) and task kinds (`generation`, `tool`, `post_tools`, `collapse`, `job`) are
registered by `open` itself, because `accept`, `prompt`, `queueInput` and `collapse` need them to write
and type new records. Reading context does not need entry kinds. A task-kind replacement is
registered under the built-in's name and must understand its persisted statuses and keep its hook
names, so existing handlers keep working; a wrapper that delegates to the original is the usual
shape. `h.kinds.<name>` is how handles and plugins refer to whatever is currently registered, so
`c.settings` is the config of the generation kind in use, not of a specific import.

`Harness.open` takes storage, models, tools, additional kinds, replacements, section definitions and
initial root values. It creates the root only for empty storage and initializes `rootValues` in that
same commit; on reopen it ignores those initial values and preserves durable configuration. Tool
registration never implicitly selects tools. The host explicitly supplies model/thinking/selectedTools
for a fresh root or configures it before generation; missing required configuration reports an error.
Children inherit only the values selected by their spawn policy; historical forks inherit rewindable
values at their entry cutoff. Reopen never creates work by inference.

### 9.6 Mutable kind and section registration

Construction accepts initial `kinds: { entry: [...], task: [...] }` and `sections: [...]` collections.
Built-in section tokens are registered initially; their content is supplied by host hooks. These are
initial values, not immutable registries:

```ts
await h.entryKinds.register(noteKind, call);
await h.entryKinds.replace(noteKindV2, call);
await h.entryKinds.remove(noteKind.kind, call);

await h.taskKinds.register(reminderKind, call);
await h.taskKinds.replace(reminderKindV2, call);
await h.taskKinds.remove(reminderKind.kind, call);

await h.sections.register(policySection, call);
await h.sections.replace(policySectionV2, call);
await h.sections.remove(policySection.key, call);
```

The registry methods retain the supplied kind/section generics. `register` rejects an existing name;
`replace` requires an existing compatible definition (otherwise migrate); `remove` removes code,
not stored entries/tasks/section values. All changes serialize on the line. Existing task calls and
section preparations retain their captured implementation; future ones use current registrations.
Explicit section-renderer replacement marks that section for recomputation in a later preparation;
never rewrite old entries or clear a newer replacement's pending work from an older preparation.

Removing a section definition does not remove its instructions. Historical reads and untouched seeded
sections use stored rendered text without the renderer. Registering it again restores typed editing.
Only `sections.delete(tokenOrKey)` on the preparation draft requests durable section removal. Stable
string keys cross restarts; function objects and token identity do not get serialized. The mutable
draft is a local hook API, not a JSON wire DTO; an eventual remote-plugin adapter must provide an
explicit contribution/edit protocol rather than serializing token renderers or draft callbacks.

Task-kind removal rejects while live tasks of that kind exist. At open, absent task kinds follow
§6.4: foreground tasks become terminal `orphaned`; background tasks remain parked until registration
restores their recovery implementation. Registration does not resurrect orphaned or other terminal
tasks and does not implicitly attach a drive scope.

## 10. Validation

### 10.1 Backend conformance

One validated mutation stream replayed into memory, JSONL (close, reopen) and SQLite (close,
reopen), compared on: current objects and live-task metadata, transcript pages and inherited
prefixes, derived contexts at several boundaries, value tombstones and list clears, request keys,
scratch lifetimes, next allocated sequence. Randomized small histories plus explicit deep-fork
cases: fork before and after a delete, before and after a clear, before a later summary, nested
source cutoffs, sticky state untouched by historical reads.

### 10.2 Failure and concurrency

| Scenario | Required |
|---|---|
| Persistence paused after construction | readers see the old complete state |
| Accept commit durable, reply lost | `acceptance(requestId)` returns the original conversation/input id |
| Main and scratch writes in one batch | reject, nothing written |
| Torn final JSONL line | only that line discarded |
| Malformed complete line | open fails; no silent truncation |
| Retirement committed, unlink fails | old scratch invisible |
| Effect returns as abort starts | one invocation per task; fresh abort only after return |
| Post-mark main/scratch write | reject before builder; sinks handle cancellation and drain callbacks |
| Status cycle returns to initial status | epoch counts intermediate committed changes; no false fault |
| Host patches an owned task | reject lifecycle/state mutation; abort marks remain allowed |
| 100,000 historical children, two live tasks | query only live seed/needed ancestry, no history traversal |
| Repeated drive and cancelled waiter | one attachment; remove waiter/listener exactly once |
| Known dependency self-drive | reject before acceptance or cycle-creating admission |
| Close vs task commit | earlier commit completes; later mutation rejects; completion still admitted |
| Shutdown vs accept / idle nextRun inbox | accept before mark batch or reject; queued items/results preserved |
| Shutdown crash before child cleanup | reopened abort marks tasks only; child queues remain unchanged |
| Main 100, live scratch through 150, crash | reopen recovers lastSeq=150; next write=151 |
| Retired scratch still on disk | ignore it even if malformed; later main settlement covers its sequences |
| Parent cleanup vs already-terminal job | already finished is successful cleanup |
| Broken abort handler | reject drives/shutdown, signal/join and close; replace kind before recovery |
| Parallel tools settle in either order | post_tools starts once |
| Abort vs post_tools settlement | no unmarked successor |
| Child finishes while its owning tool is marked | tool settles aborted, not done |
| Two overlapping drives | one execution per task |
| A drive caller cancels its wait | other callers and tasks unaffected |
| Summary lands after a competing head/reset | rejected as stale; intervening edits do not stale it |
| Withdraw vs land of the same inbox item | one wins on the line; one terminal input result |
| Abort vs generation/post_tools group transfer | every active input resolves once; no unmarked owner escapes |
| Several inputs share one generation | every result points to the same final answer entry |
| Overflow retry while collapse runs | no live task waits on the collapse |
| Watch registration races a commit | base includes it or the stream delivers it |

Faux providers, fake processes and clocks, storage barriers; both orders of every race; failed
commits consume no ids; old task ids remain queryable after compaction.

### 10.3 Performance

Workloads: many short turns with and without tools; frequent compaction plus cold reopen; parallel
and sequential tools; large streaming output; deep forks with repeated historical reads; many
finished child conversations with few live tasks; many live background tasks; queued input and
cancellation. Measure CPU, wall latency, RSS and heap, bytes on disk including scratch and WAL,
query counts and rows decoded. Report backend-owned memory separately from live execution data;
JSONL growth with history is expected, SQLite must not keep a full-history copy.

The pico2 prototype's 9.7 s against 35.9 s on 2,000 faux turns is a reason to measure this design
the same way, not a result for it. Its lessons are the ones above: cheap live queries, batched
reads, small writes, no history scans on the hot path.
