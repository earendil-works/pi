# Pico5 specification

Pico5 is a durable, extensible agent harness. This document is normative.
Pico5 uses existing package types as follows:

```ts
import type { Context, JsonValue } from "@earendil-works/chord";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type {
  Message,
  Models,
  ModelThinkingLevel,
  TextContent,
  Tool,
  ToolReference,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

type JsonObject = { [key: string]: JsonValue };
type StoredError = { message: string; detail?: JsonValue };
```

Pico5 targets the transcript `SystemMessage` contract from pi-ai PR
[#9548](https://github.com/earendil-works/pi/pull/9548). `Message` includes that
type once the PR lands.

The core rule is:

> A Session atomically commits immutable entries, full task records, and
> Chord-tracked documents. Only committed state is observable.

## 1. Terms and invariants

- A **Session** owns one mutation line, conversations, entries, tasks, inputs,
  and documents.
- A **conversation** is a transcript scope. It may fork another conversation.
- An **entry** is an immutable transcript record.
- A **task** is a durable state machine attached to one conversation.
- A **document** is mutable JSON state represented by Chord operations and
  occasional complete bases.
- A **definition** is a typed token describing one document or document family.
- A **source** exposes committed document changes to Chord without exposing a
  mutable object.

Required invariants:

1. One Session commit is atomic across all record and document writes.
2. A document update is published only after its storage commit succeeds.
3. All visible progress is durable. There is no volatile publication path.
4. External effects do not run inside the Session mutation transaction.
5. Entries and IDs are immutable and never reused after a committed write.
6. Document drafts and assigned mutable objects must not escape their
   transaction. This restriction is initially documented, not enforced by a
   membrane.
7. The mutation line remains held through storage settlement and committed-state
   adoption. Listener callbacks run later, off the line.
8. A failure after document flush, including checkpoint or storage failure, is
   fatal to the open Session. It publishes nothing and must be reopened.

## 2. Core records

The concrete JSON representations may add bookkeeping fields, but must preserve
these contracts.

```ts
type Id = number;
type Seq = number;
const ROOT_CONVERSATION_ID: Id = 1;

type ConversationRecord = {
  readonly id: Id;
  readonly parent?: {
    readonly conversationId: Id;
    readonly at: Id;
  };
  readonly owner?: {
    readonly conversationId: Id;
    readonly taskId: Id;
  };
};
```

The referenced pi-ai member is:

```ts
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

`content` is the base prompt on the leading message and additional instruction
text on later messages. `sections` is an ordered named patch: a string adds or
replaces a section, while `null` removes it. `toolsRemoved` is applied before
`toolsAdded` within one message. Replaying every system message in transcript
order yields the effective prompt and tool set.

```ts
type ContextEdit = {
  readonly target: Id;
} & (
  | { readonly action: "omit"; readonly messages?: never }
  | { readonly action: "replace"; readonly messages: readonly Message[] }
);

type EntryRecord = {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly model?: readonly Message[];
  readonly data?: JsonValue;
  readonly head?: Id;
  readonly edits?: readonly ContextEdit[];
  readonly byTaskId?: Id;
};

type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
  readonly head?: Id | "self";
};

type InputBase = {
  readonly id: Id;
  readonly conversationId: Id;
  readonly requestId?: string;
};

type Input = InputBase & (
  | { readonly status: "queued" }
  | { readonly status: "placed"; readonly entry: Id }
  | {
      readonly status: "done";
      readonly entry: Id;
      readonly answer?: Id; // absent for a completed passive write
    }
  | {
      readonly status: "unanswered";
      readonly entry?: Id; // present when placement preceded failure
      readonly reason: string;
      readonly detail?: JsonValue;
    }
);

type InputCreate = Input extends infer Record
  ? Record extends Input
    ? Omit<Record, "id">
    : never
  : never;
```

Conversation history parenting and task ownership are separate:

- `parent` controls inherited entries and historical documents.
- `owner` controls task authorization, subtree abort, and subtree idle waits.

A conversation's owner remains recorded after the owning task becomes terminal.

### 2.1 Entries and context

Entry IDs are Session-global and ordered. `parent.at` is an entry in the parent
history visible to the child.

The active transcript is the raw entry range from the newest applicable `head`
through the tail. A head on an entry changes subsequent context; it does not
remove older entries from storage. Fork traversal is child entries followed by
parent entries through each `parent.at` cap.

Context derivation:

1. Find the newest visible entry `H` at or before the cutoff that has `head`.
2. Let `from = H.head`, or transcript start when `H` is absent.
3. Scan visible entries from `from` through the cutoff.
4. For each target, the newest edit in that range wins. `omit` contributes no
   model messages; `replace` contributes its `messages` instead of the target's.
5. If `H` exists, context entries are `H` followed by non-head entries in the
   range. Otherwise they are the range.
6. Keep every positional system message and its tool/section changes.
7. Order tool results by assistant tool-call order.
8. Synthesize missing tool results after a fork when required by the provider
   message protocol.
9. Exclude model-less entries and assistant messages with `aborted`, `error`, or
   `deferred` stop reasons from future provider requests.

Views carry raw active entries. UI reduction and model-context reduction are
separate consumers. Older stored history is available through the owning
`Conversation` object's cursor-based `entries()` scan.

### 2.2 Public Harness surface

This is the v1 host-facing API. Pico5 is not implemented yet, but implementations
must expose this shape rather than inventing a different facade during package
24.

```ts
type ModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

type UserInput = UserMessage["content"];

type SendInput = {
  readonly content: UserInput;
  readonly requestId?: string;
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

type SectionSeed =
  | { readonly key: string; readonly value: JsonValue }
  | { readonly key: string; readonly remove: true };

type ConversationSpec = {
  readonly parent?: { readonly conversationId: Id; readonly at: Id };
  readonly model?: ModelRef;
  readonly sections?: readonly SectionSeed[];
  readonly activeTools?: readonly string[];
};

type AnyTask = {
  readonly definition: {
    readonly name: string;
    readonly version: number;
    readonly initial: unknown;
    readonly phases: Readonly<Record<string, unknown>>;
    readonly abort: unknown;
    readonly migrate?: unknown;
    readonly hooks?: object;
  };
};

type HarnessOptions = {
  readonly models: Models; // the pi-ai Models interface
  readonly tools?: readonly ToolRegistration[];
  readonly taskKinds?: readonly AnyTask[];
  readonly sections?: readonly SystemSection<JsonValue>[];
  readonly now?: () => number;
  readonly root?: Omit<ConversationSpec, "parent">;
  readonly onReport?: (error: unknown) => void;
};

interface Entry<E extends EntryRecord = EntryRecord> {
  readonly kind: string;
  is(entry: EntryRecord | undefined): entry is E;
}

function defineEntry<E extends EntryRecord>(kind: string): Entry<E>;

type ContextView = {
  readonly head: EntryRecord | undefined;
  readonly entries: readonly EntryRecord[];
  readonly messages: readonly Message[];
};

type SettledInput = Input & {
  readonly status: "done" | "unanswered";
};

interface InputHandle {
  readonly id: Id;
  result(context: Context): Promise<Input | undefined>;
  wait(context: Context): Promise<SettledInput>;
  abort(
    context: Context,
  ): Promise<"aborted" | "already_placed" | "not_found">;
}

type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
  readonly state: Extract<TaskState<JsonValue, R>, { status: "terminal" }>;
};

type ConversationWatch = WatchHandle<ConversationView>;

type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H>
  ? H
  : never;

interface Conversation {
  readonly id: Id;
  send(input: SendInput, context: Context): Promise<InputHandle>;
  write(entry: EntryDraft, context: Context): Promise<InputHandle>;

  getModel(context: Context): Promise<ModelRef | undefined>;
  setModel(model: ModelRef | undefined, context: Context): Promise<void>;
  getThinkingLevel(context: Context): Promise<ModelThinkingLevel>;
  setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void>;
  getActiveTools(context: Context): Promise<readonly string[]>;
  setActiveTools(names: readonly string[], context: Context): Promise<void>;
  getSection<T extends JsonValue>(
    section: SystemSection<T>,
    context: Context,
  ): Promise<T | undefined>;
  setSection<T extends JsonValue>(
    section: SystemSection<T>,
    value: T | undefined,
    context: Context,
  ): Promise<void>;

  commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    context: Context,
  ): Promise<T>;
  context(context: Context): Promise<ContextView>;
  entries(
    query: Omit<EntryQuery, "conversationId">,
    cursor: Cursor | undefined,
    limit: number,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
  fork(
    at: Id,
    spec: Omit<ConversationSpec, "parent">,
    context: Context,
  ): Promise<Conversation>;
  collapse(instructions: string | undefined, context: Context): Promise<Id>;
  reset(handoff: string | undefined, context: Context): Promise<void>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
  hooks<K extends AnyTask>(
    owner: string,
    task: K,
    handlers: Partial<HooksOf<K>>,
    options?: { readonly subtree?: boolean },
  ): () => void;
  watch(context: Context): Promise<ConversationWatch>;
}

interface Harness extends Session {
  resume(): void;
  suspend(context: Context): Promise<void>;
  quiescent(): boolean;
  hold(): () => void;

  registerTaskKind(task: AnyTask): () => void;
  registerTool(tool: ToolRegistration): () => void;
  registerSection(section: SystemSection<JsonValue>): () => void;
  hooks<K extends AnyTask>(
    owner: string,
    task: K,
    handlers: Partial<HooksOf<K>>,
  ): () => void;

  root(context: Context): Promise<Conversation>;
  onConversation(listener: (conversation: Conversation) => void): () => void;
  conversation(id: Id, context: Context): Promise<Conversation | undefined>;
  createConversation(
    spec: ConversationSpec & { readonly input?: UserInput },
    context: Context,
  ): Promise<Conversation>;

  getTask(id: Id, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  abortInput(
    id: Id,
    context: Context,
    conversationId?: Id,
  ): Promise<"aborted" | "already_placed" | "not_found">;
  abortTask(id: Id, context: Context): Promise<"marked" | "terminal">;
  markTask(id: Id, context: Context): Promise<"marked" | "terminal">;
  waitForTask<R>(ref: TaskRef<R>, context: Context): Promise<SettledTask<R>>;
  waitForIdle(context: Context): Promise<void>;
}

declare const Harness: {
  open(
    storage: Storage,
    options: HarnessOptions,
    context: Context,
  ): Promise<Harness>;
};
```

This intentionally retains the useful Pico3 host shape. It removes Pico3's
fixed `rewindable()`/`sticky()` accessors, namespace router, semantic view events,
and manual Chord view bridge. Typed Pico5 documents and the structural
conversation watch replace those surfaces. `write()` now returns an
`InputHandle`, because a busy passive write may remain queued before it receives
an entry ID.

`Harness.open()` installs built-in task, tool, and section definitions followed
by supplied task kinds, tools, and sections. It changes
surviving `running` tasks to `pending`, migrates task records, and settles unknown
or unmigratable live task kinds as `orphaned` before resolving. Any built-in
document touched by that recovery migrates through its ordinary typed access
path. Open does not scan or migrate other documents. IDs and names in registries must be unique. No
handler dispatches during open. Dynamic registration is available after open and
does not resurrect a task already settled by that pass.

The root conversation always has reserved ID `ROOT_CONVERSATION_ID` (`1`). Empty
storage creates that conversation from `options.root`; reopen looks it up by the
reserved ID. `options.root` never overwrites existing state. `root()` returns
that handle. A conversation with no configured model produces a durable
`no_model` generation failure.

`resume()` is idempotent while running and only enables scheduling. It does not
repeat open-time reconciliation. `suspend()` is terminal for that Harness
instance and follows the close semantics below; `resume()` after suspend/close
rejects. `quiescent()` means no task invocation is currently executing; eligible
or delayed durable tasks may still exist. `hold()` is available only while
quiescent and pauses reservation until its idempotent release function runs.

Runtime registration rejects duplicate IDs/names and returns an idempotent
function that unregisters only that exact token. It supports declaration
movement during normal operation, not replacement of executing extension code;
section 7.4 governs code reload.

Conversation creation atomically commits the conversation, built-in
configuration and section/tool seeds, and optional input admission. For a fork,
omitted model, section, and active-tool values follow their document definition's
fork policy; provided values override those forked built-in values in the same
commit. Other documents follow their own definitions without special handling.

The built-in conversation configuration document contains the selected model,
thinking level, section values, and active tool names. Its initial thinking level
is `"off"`. It is rewindable with `fork: "asOf"`, so a child starts from the
configuration visible at its selected entry unless explicit creation seeds
override it. Conversation creation eagerly
creates it, so `getModel()`, `getThinkingLevel()`, `getActiveTools()`, and
`getSection()` return detached committed snapshots without a get-or-create
write. Each setter performs one ordinary Session commit against that document;
`setSection(section, undefined)` removes the value. A setter does not start
generation or append a system entry. Request preparation later compares the
desired committed configuration with transcript history and appends the required
positional system baseline or delta.

Tool declarations and executable functions are process-local Harness registry
entries, supplied through `HarnessOptions.tools` or `registerTool()`. The durable
configuration document stores only active tool names. A new independent
conversation defaults to every tool registered when its creation is admitted;
`ConversationSpec.activeTools` overrides that default. A fork with no explicit
`activeTools` uses the configuration document's `asOf` value.

`registerTool()` changes only the runtime registry. It does not activate the tool
in existing conversations or write a document. `setActiveTools()` is the only
host operation that replaces one existing conversation's durable active set.
Explicit `ConversationSpec.activeTools` and `setActiveTools()` values must contain
unique names that are registered when their commit is admitted; otherwise the
whole operation rejects without a write. Inherited historical names are not
revalidated during a fork and may later be unavailable after registry movement.
Unregistering a tool does not rewrite any conversation.

If request preparation finds unavailable active names, it performs no provider
request. It atomically terminalizes the generation task as `failed` with
`detail: { code: "missing_active_tool", names }`, makes its placed inputs
`unanswered` with reason `missing_active_tool`, clears matching turn control, and
appends a visible model-less diagnostic entry. It does not silently change the
durable loadout. Historical system entries remain replayable because they store
the exact declarations actually offered to prior requests.

A `Conversation.commit()` is a Session commit bound to that conversation.
`tx.createTask()` defaults `TaskOptions.conversationId` to the bound conversation.
`Conversation.entries()` binds the query to that conversation and paginates its
fork-aware stored history; callers cannot substitute another conversation ID.
Generic Session-wide document operations remain available directly on `Harness`
because `Harness extends Session`.

`fork()` requires a concrete visible parent entry and applies section 3.7.
`collapse()` returns the newly admitted background collapse task ID, not its
future summary entry. `reset()` durably admits a passive self-head reset or
handoff write and then resolves; while busy, placement follows section 6 and may
occur later. Observe its placement through the conversation watch. An idle wait
does not guarantee placement of queued passive writes.

`markTask()` only commits `abortRequested`; it neither signals nor joins an
active invocation. The scheduler notices the mark on its next drain.
`abortTask()` also signals and joins an active run before starting the abort
invocation. `Conversation.abort()` withdraws queued non-write inputs, marks
non-background tasks in the conversation and owned subtree, signals them, and
resolves only after that subtree is ordinarily idle. Passive writes and
background tasks survive. Conversation idle means no non-background live task
in that conversation or its ownership subtree; Harness idle applies the same
rule Session-wide. Pending dependency- or deadline-blocked work is still live
and therefore not idle. Cancelling an idle wait aborts only that waiter.

`onConversation()` synchronously visits the currently loaded committed
conversations in ascending ID order, then reports each later creation after its
commit. Listener failures go to `onReport` and do not stop other listeners. Its
idempotent disposer removes the listener; Harness close removes all remaining
listeners.

`send()` and `write()` return after durable admission, not settlement. `send`
creates a user message with the admission timestamp. `whenBusy` defaults to
`followUp`. `write()` uses the ordered passive path in section 6 and never starts
generation. A completed passive write identifies its entry in `Input.entry`; a
completed send identifies the answer in `Input.answer`. Cancelling `wait()` only
cancels that wait. It does not withdraw or abort the input; `InputHandle.abort()`
is the explicit queued-input withdrawal operation.

`abortTask()` durably requests cancellation and returns `marked` after the mark
is committed, any active run invocation has joined, and an abort invocation has
been scheduled; it does not await terminal settlement. `waitForTask()` observes
the terminal receipt. Aborting an already terminal task returns `terminal`; an
unknown ID rejects. Explicit task abort includes a background task. Cancelling a
task or idle wait does not abort work.

`Conversation.watch()` atomically captures an immutable structural view and
registers for later complete Session commits. Its `WatchHandle` uses the same
serialized asynchronous update and reset-compaction contract as `watchDoc()` in
section 9.2. It carries no semantic events and owns no second tracker.

`close()` is equivalent to `suspend()` for v1. It seals mutation admission and
task reservation, signals invocations, and stops watches. Outside the Session
line it lets already-admitted storage commits settle, joins task/tool/hook
invocations and in-flight watch callbacks, then closes sources and storage. It
writes no task outcome. Handles belong to that open Harness and must be
reacquired after reopen. A non-cooperative watch callback can delay graceful
close just like a non-cooperative task invocation.

## 3. Documents

### 3.1 Definitions

Scope directly determines document ownership and lifetime. Only conversation
documents declare history and fork behavior.

```ts
type LatestConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "latest";
  readonly fork: "current" | "initial";
};

type RewindableConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "rewindable";
  readonly fork: "asOf" | "current" | "initial";
};

type DocumentSemantics =
  | { readonly scope: "session" }
  | LatestConversationSemantics
  | RewindableConversationSemantics
  | { readonly scope: "task" };

type CommonDocDefinition<T extends JsonObject> = {
  readonly kind: string;
  readonly version: number;
  initial(): T;
  migrate?(value: JsonObject, fromVersion: number): T;
  checkpointWhen?(value: Readonly<T>, ops: readonly Op[]): boolean;
};

type DocDefinition<T extends JsonObject> =
  CommonDocDefinition<T> & DocumentSemantics;

type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> =
  Omit<CommonDocDefinition<T>, "initial"> & DocumentSemantics & {
    readonly family: true;
    initial(input: I): T;
  };

function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableDocToken<T>;
function defineDoc<T extends JsonObject>(definition: DocDefinition<T>): DocToken<T>;

function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> &
    RewindableConversationSemantics & {
      readonly family: true;
      initial(input: I): T;
    },
): RewindableDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: DocFamilyDefinition<T, I>,
): DocFamilyToken<T, I>;

declare const docType: unique symbol;
interface DocToken<T extends JsonObject> {
  readonly definition: DocDefinition<T>;
  readonly [docType]?: T;
}
interface RewindableDocToken<T extends JsonObject> extends DocToken<T> {
  readonly definition: CommonDocDefinition<T> & RewindableConversationSemantics;
}
interface DocFamilyToken<T extends JsonObject, I extends JsonValue> {
  readonly definition: DocFamilyDefinition<T, I>;
  readonly [docType]?: T;
}
interface RewindableDocFamilyToken<T extends JsonObject, I extends JsonValue>
  extends DocFamilyToken<T, I> {
  readonly definition: Omit<CommonDocDefinition<T>, "initial"> &
    RewindableConversationSemantics & {
      readonly family: true;
      initial(input: I): T;
    };
}
```

Validation rules:

- Versions are positive integers.
- Typed access rejects when the token's scope or conversation history/fork policy
  disagrees with the persisted incarnation. A migration cannot reinterpret those
  lifetime semantics.
- Session documents are current-only and belong to the Session. Closing and
  reopening the Session does not retire them.
- Conversation documents declare `history` and `fork`; `fork: "asOf"` requires
  `history: "rewindable"`.
- Task documents are current-only, are never copied by a conversation fork, and
  retire atomically when their task becomes terminal.
- `initial()` and `migrate()` return JSON objects.

`checkpointWhen()` only selects complete storage bases to bound replay. It does
not change scope, lifetime, history, or fork semantics.

Concrete built-in document grouping and semantics are declared when the built-in
definitions are implemented. The generic document mechanism does not special
case model, tool, inbox, or presentation state.

### 3.2 Records and lifetimes

A persisted document instance has one lifecycle record:

```ts
type DocumentRecord = {
  readonly id: Id;              // unique incarnation
  readonly kind: string;        // stable definition kind
  readonly key?: string;        // families only
  readonly createdAt: Seq;      // stamped by the committing storage
  readonly retiredAt?: Seq;
} & (
  | { readonly scope: { readonly kind: "session" } }
  | ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: Id } } & (
      | { readonly history: "latest"; readonly fork: "current" | "initial" }
      | {
          readonly history: "rewindable";
          readonly fork: "asOf" | "current" | "initial";
        }
    ))
  | { readonly scope: { readonly kind: "task"; readonly taskId: Id } }
);

type DocumentCreate = DocumentRecord extends infer Record
  ? Record extends DocumentRecord
    ? Omit<Record, "createdAt" | "retiredAt">
    : never
  : never;
```

`id` is never reused. Retiring and recreating the same logical kind, scope, and
family key creates a new incarnation. Membership is the half-open interval
`createdAt <= at < retiredAt`; an unretired incarnation has no upper bound. A
creation retired in the same commit has an empty lifetime.

A singleton is identified logically by kind and scope. A family is identified
logically by kind, scope, and `key`. The record preserves scope and conversation
history/fork semantics so unavailable extension code does not make existing data
disappear. Definition versions belong to stored bases and deltas because one
incarnation may contain records written by multiple definition versions.
`DocumentCreate` is not another persisted record; it is the same scoped union
without storage-assigned lifetime fields.

### 3.3 Access and creation

There is no mutable `session.document()` API.

```ts
interface Session extends DocumentObserver {
  commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    context: Context,
  ): Promise<T>;

  close(context: Context): Promise<void>;

  snapshot<T extends JsonObject>(
    token: DocToken<T>,
    target: DocTarget,
    context: Context,
  ): Promise<Readonly<T>>;

  snapshot<T extends JsonObject, I extends JsonValue>(
    token: DocFamilyToken<T, I>,
    target: FamilyTarget<I>,
    context: Context,
  ): Promise<Readonly<T>>;

  snapshotAsOf<T extends JsonObject>(
    token: RewindableDocToken<T>,
    conversationId: Id,
    at: Id,
    context: Context,
  ): Promise<Readonly<T> | undefined>;

  snapshotAsOf<T extends JsonObject, I extends JsonValue>(
    token: RewindableDocFamilyToken<T, I>,
    target: HistoricalFamilyTarget,
    at: Id,
    context: Context,
  ): Promise<Readonly<T> | undefined>;

  documentSource<T extends JsonObject>(
    token: DocToken<T>,
    target: DocTarget,
    context: Context,
  ): Promise<DocumentSource<T>>;

  documentSource<T extends JsonObject, I extends JsonValue>(
    token: DocFamilyToken<T, I>,
    target: FamilyTarget<I>,
    context: Context,
  ): Promise<DocumentSource<T>>;
}

interface Tx {
  conversation(id: Id): Promise<ConversationRecord | undefined>;
  entry(id: Id): Promise<EntryRecord | undefined>;
  input(id: Id): Promise<Input | undefined>;
  task(id: Id): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanEntries(query: EntryQuery): Promise<readonly EntryRecord[]>;
  scanTasks(query: TaskQuery): Promise<readonly TaskRecord<JsonValue, JsonValue, JsonValue>[]>;

  createConversation(value: Omit<ConversationRecord, "id">): ConversationRecord;
  appendEntry(conversationId: Id, value: EntryDraft): EntryRecord;
  createInput(value: InputCreate): Input;
  setInput(value: Input): void;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>, input: I, options?: TaskOptions,
  ): TaskRef<R>;
  setTask(value: TaskRecord<JsonValue, JsonValue, JsonValue>): void;

  doc<T extends JsonObject>(token: DocToken<T>, target: DocTarget): Promise<T>;
  doc<T extends JsonObject, I extends JsonValue>(token: DocFamilyToken<T, I>, target: FamilyTarget<I>): Promise<T>;
  retireDoc<T extends JsonObject>(token: DocToken<T>, target: DocTarget): void;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: DocFamilyToken<T, I>, target: FamilyKey): void;
}

type DocTarget =
  | { readonly scope: "session" }
  | { readonly scope: "conversation"; readonly conversationId: Id }
  | { readonly scope: "task"; readonly taskId: Id };

type FamilyKey = DocTarget & { readonly key: string };

type FamilyTarget<I> = FamilyKey & { readonly initial: I };

type HistoricalFamilyTarget = {
  readonly scope: "conversation";
  readonly conversationId: Id;
  readonly key: string;
};
```

Every normal access is get-or-create and receives the definition token that
supplies its static type, initializer, migration, and checkpoint policy. Ordinary
document definitions are not registered and ordinary documents are not scanned
at open.

- Existing instances are reconstructed and migrated lazily according to section
  3.6. Standalone access may commit a required current-only migration before its
  method returns. `tx.doc()` instead stages that base in its enclosing transaction.
- Missing instances are created in a serialized commit with an initial base.
- Concurrent acquisition initializes once.
- The target scope must match the token's declared scope.
- Task-scoped access validates against the transaction's latest candidate task
  record, falling back to committed state. This internal validation is not a
  caller table read and does not trigger `ReadAfterWrite`. Its conversation is
  derived from the task record rather than repeated in the target.
- A terminal candidate rejects later task-document access. Terminal settlement
  retires both existing task documents and task documents created earlier in the
  same transaction.
- `snapshot()` returns a detached JSON copy.
- `documentSource()` returns an opaque committed source.
- `tx.doc()` returns the transaction's mutable tracked draft.
- Historical reads never create documents in the past.

A family initializer input matters only on first creation. Later accesses must
supply the same logical target; their `initial` value is ignored.

`snapshotAsOf()` is available only for rewindable conversation documents. It
validates that `at` is visible through the requested conversation's ancestry,
selects the ancestor conversation that owns that entry, then finds the logical
singleton/family incarnation whose creation/retirement interval contains the
entry's commit. It never starts from today's incarnation and never creates an
instance. It returns `undefined` when no such instance existed.

After `B` forks `A` at entry `E`, asking for `B`'s state at inherited `E` reads
`A`'s historical instance; `B`'s copied incarnation was created later. If an
instance was retired and recreated, historical lookup selects the incarnation
alive at the target commit.

### 3.4 Mutation ownership

Chord mutates the tracked working object immediately while retaining the
previous baseline until flush.

Transaction behavior:

```text
begin transaction
  acquire document drafts
  mutate ordinary JSON
callback fails
  restore each changed tracker from its unchanged baseline
callback succeeds
  flush each changed tracker -> incremental ops + candidate value
  Session evaluates each ordinary mutation's checkpoint predicate exactly once
  and gives Storage only the selected base or delta representation
  Storage.commit persists it while the Session line remains held
storage succeeds
  materialize each changed immutable published value with applyImmutable(previous, ops)
  adopt committed baselines and enqueue value/ops publication while holding the line
  release the line; invoke listeners later
post-flush or storage failure
  poison Session; publish nothing; close/reopen required
```

The immutable published value is separate from the tracker's mutable working
object and is created once per changed document, not once per watch. Initial
publication similarly applies the complete base operation to `undefined`.
Storage's detached retained copy does not satisfy this Session-side ownership
requirement.

No defensive document copy is required solely for storage failure because the
open Session cannot continue after that failure.

Unsupported:

```ts
let escaped: LiveState;
await session.commit(async tx => {
  escaped = await tx.doc(LiveDoc, { scope: "conversation", conversationId });
});
escaped.message = message; // unsupported
```

The same rule applies to nested proxies and mutable objects assigned into a
document.

### 3.5 Bases and checkpoints

Creation always stores a complete base.

For an ordinary later mutation, the definition alone decides whether the
storage record is a base:

```ts
const useBase = definition.checkpointWhen?.(candidateValue, ops) ?? false;
```

The Session evaluates this predicate exactly once after tracker flush. Creation
and version transitions require bases and do not call it. The Session then gives
Storage only the selected representation:

```text
required or predicate true -> base with complete value
otherwise                  -> delta with incremental ops
```

A predicate failure occurs after flush and therefore poisons the open Session as
described in section 1. Storage executes no definition code and never receives
an unused complete candidate with a selected delta.

- For Session, task, and latest conversation documents, a committed base permits
  physical reclamation of older records.
- For rewindable conversation documents, bases bound replay but never permit
  removal of addressable history.
- A definition that never checkpoints may create an unbounded replay tail. That
  is a definition bug, not a backend heuristic.
- Storage does not count encoded bytes, compare against `initial()`, or invent
  checkpoints.

A high-churn live document can checkpoint when it becomes empty:

```ts
checkpointWhen: (value, _ops) =>
  value.message === undefined &&
  value.tools.length === 0
```

### 3.6 Versions and migrations

One migration callback handles every supported older version.

```text
stored == token -> use value
stored < token  -> call migrate(value, storedVersion)
stored > token  -> reject typed access
no migrate      -> reject older stored version
```

`migrate()` is pure and returns a complete current-version value. Migration is
access-driven: `tx.doc()`, `snapshot()`, `snapshotAsOf()`, `documentSource()`, and
`watchDoc()` reconstruct and migrate through the token supplied to that call.
Harness open does not sweep ordinary documents.

- A standalone current-only acquisition persists the migrated value as a required
  current-version base before its method returns. `tx.doc()` stages the migration
  in the enclosing transaction; callback failure persists nothing, and later
  draft edits coalesce into one final required base.
- Rewindable history is not rewritten. Current and historical reconstructed
  values are migrated after replay.
- The first mutation of a migrated rewindable value stores a required
  current-version base before subsequent current-version deltas.
- A fork copies the selected stored value and version. Typed access in the child
  migrates it later when necessary.
- Unaccessed documents and documents with unavailable definitions preserve their stored instances,
  versions, and bytes.

### 3.7 Forks

A conversation fork points to one concrete visible entry `E`.

The child transcript includes entries through `E`, even if the same commit also
appended later entries. Document state at `E` is the final state of the commit
containing `E`. Different document states require separate commits.

Each conversation document follows the history/fork policy persisted in its
lifecycle record:

| conversation setting | child value |
|---|---|
| `fork: "asOf"` | parent value at `E`'s commit |
| `fork: "current"` | parent value when the fork commit runs |
| `fork: "initial"` | no copied instance; initializer on first child access |

`current` and `asOf` copy logically present conversation singleton and family
instances, preserving unknown definitions and their stored versions. Copied
values become independent child instances with new IDs and initial bases.
`initial` copies no instance; first access in the child creates it from the
supplied definition. Task documents and tasks are never copied. Session documents
remain shared and are not rewindable.

## 4. Transactions and storage ownership

A Session commit callback may be asynchronous. It owns the Session mutation
line through callback execution, preparation, storage settlement, committed
baseline adoption, and publication enqueue. Listener callbacks run later.
External model, process, tool, network, and human effects run outside it.

```ts
await session.commit(async tx => {
  const input = await tx.input(inputId);            // table read
  const live = await tx.doc(LiveDoc, { scope: "conversation", conversationId });

  const entry = tx.appendEntry(conversationId, message); // first table write
  live.message = undefined;                         // document mutation remains valid
  tx.setInput({ ...input, status: "done", answer: entry.id });
}, context);
```

Mutation admission occurs on the Session line before a commit callback or
get-or-create acquisition starts. Closing seals mutation admission and task
reservation. Already-admitted commits settle before storage closes. Once a
commit is admitted, caller cancellation does not interrupt storage settlement or
undo the commit. Cancelling a close wait does not reopen admission.

Table rules:

- Tables are conversations, entries, tasks, and inputs.
- Table reads are allowed before the first table write.
- Any table read after the first table write throws `ReadAfterWrite`.
- Document access and read-your-writes remain available after table writes.
- Creation methods return their created ID/record; callers do not read it back.

Storage ownership:

- Commit arguments are borrowed until `Storage.commit()` settles.
- Anything retained after settlement is detached first.
- Memory storage recursively copies retained JSON containers.
- JSONL and SQLite detach through serialization and decoded indexes.
- Every storage read returns a detached JSON value.
- Immutable strings may be shared; mutable arrays and objects may not.

## 5. Tasks

### 5.1 Definition

```ts
type TaskOutcome<R> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly error: StoredError; readonly result?: R }
  | { readonly status: "aborted"; readonly reason?: string; readonly result?: R }
  | { readonly status: "orphaned"; readonly reason: string }
  | { readonly status: "faulted"; readonly error: StoredError };

type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S }
  | { readonly status: "running"; readonly checkpoint: S }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };

type TaskRecord<I, S, R> = {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly version: number;
  readonly input: I;
  readonly after: readonly Id[];
  readonly background: boolean;
  readonly abortRequested: boolean;
} & (
  | {
      readonly state: Extract<TaskState<S, R>, { status: "pending" | "running" }>;
      readonly memos?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly state: Extract<TaskState<S, R>, { status: "terminal" }>;
      readonly memos?: never;
    }
);

type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
  readonly state: Extract<TaskState<S, R>, { status: "running" }>;
};

interface HookRunner<H extends object> {
  each<K extends keyof H>(name: K, invoke: (handler: H[K]) => void | Promise<void>): Promise<void>;
}

type PhaseHandler<I, P, S, R, H extends object> = (
  task: RunningTask<I, P, R>,
  runtime: TaskRuntime<I, S, R, H>,
  context: Context,
) => Promise<void>;

interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver {
  readonly taskId: Id;
  readonly conversationId: Id;
  readonly signal: AbortSignal;
  readonly hooks: HookRunner<H>;

  commit(
    change: (tx: Tx, current: RunningTask<I, S, R>) => void | Promise<void>,
    context: Context,
  ): Promise<void>;

  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  sleep(until: number, context: Context): Promise<void>;
}

type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
  readonly name: string;
  readonly version: number;
  initial(input: I): S;
  readonly phases: {
    [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
  };
  abort(task: TaskRecord<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): {
    input: I;
    checkpoint: S;
  };
  readonly hooks?: H;
};

interface Task<I, S extends { phase: string }, R, H extends object> {
  readonly definition: TaskDefinition<I, S, R, H>;
}

declare const taskResultType: unique symbol;
type TaskRef<R> = { readonly id: Id; readonly [taskResultType]?: R };
type TaskOptions = {
  readonly conversationId?: Id;
  readonly after?: readonly Id[];
  readonly background?: boolean;
};

function defineTask<I, S extends { phase: string }, R, H extends object = {}>(
  definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H>;
```

The phase map is exhaustive and phase-narrowed. A handler may perform several
commits around one effect, but each durable checkpoint is a full replacement.
`TaskRuntime.commit()` rereads and gates the current durable task on the Session
line before invoking its callback. Transaction methods replace its checkpoint
or write its terminal outcome.

Reservation durably changes `pending` to `running`. One invocation runs phase
handlers in sequence; checkpoint commits retain `running`. After a handler
settles, the scheduler rereads the task and applies the first matching rule:

1. Terminal: stop.
2. Session closing: stop; preserve the checkpoint and any abort mark for reopen.
3. Run mode with a durable abort mark: end and join the run invocation, then
   dispatch a fresh abort invocation.
4. Uncaught error: write terminal `faulted`.
5. Checkpoint changed, including progress within the same phase: invoke its
   phase handler in the same task invocation.
6. Checkpoint unchanged: write terminal `faulted` because no durable progress
   was made.

On open, running-task reconciliation changes surviving `running` tasks back to
`pending`, preserving their checkpoint and abort mark. Task migration then runs
before dispatch. One callback handles every supported older version; newer or
unmigratable live tasks become orphaned.
`close()` marks the runtime closing, seals admission and reservation, signals
invocations, and stops watches. Outside the Session line it settles admitted
commits and joins invocations plus in-flight watch callbacks before closing
storage. Later runtime commits reject, and close writes no task outcome. Closing
starts no fresh phase or abort invocation. It does not set abort marks,
terminalize tasks, retire task documents, or publish document retirement. The
hosting layer withdraws services and
detaches clients; reconnecting to a reopened Session hydrates the last committed
state and resumes recovery from its durable checkpoints.

### 5.2 Effect sandwich

```text
commit intent phase
perform external effect
commit outcome or next phase
```

Reopening in an intent phase means the effect may have happened. The phase
handler retries safely, polls an external handle, or records interruption.
Deferred providers are represented by a durable phase containing their handle
and next poll time.

Runtime-owned memos are small first-writer-wins values stored in the live task
envelope. Candidate insertion and reading the winner are one Session commit, so
concurrent candidates return the same durable winner. Memos survive checkpoints
and disappear in the terminal replacement. Bulk progress belongs in a document.

### 5.3 Terminal tasks and dependencies

The terminal task record is the durable result receipt. Its result may directly
contain a small value or reference an entry:

```ts
{ status: "completed", result: { entryId: toolResultId } }
```

A terminal transition atomically:

1. Writes the terminal task record.
2. Appends any result entries.
3. Retires all documents scoped to that task.
4. Resolves any inputs settled by the task.

The execution checkpoint and memos disappear from the terminal representation.
Terminal records remain queryable for dependencies, waiters, inspection, and
reopen. A normal run becomes eligible when every `after` task is terminal. An abort
mark bypasses dependencies so pending work can always reach its abort handler.

### 5.4 Scheduler, abort, and ownership

The scheduler serially reserves eligible tasks, then runs handlers off the
Session line. One in-memory `TaskInvocation` contains mode, abort controller,
and completion promise.

Abort protocol:

```text
commit abortRequested
signal and join active run invocation
start a fresh abort invocation
abort handler commits terminal outcome
```

A run invocation may not commit after its durable abort mark appears. Every
runtime operation rejects after its owning invocation ends, even while the
Session remains open. Returning from one phase handler does not end an invocation
that continues into another phase. Invocation mode is volatile and derived from
the durable mark on reopen. Cancelling one caller's `Context` only cancels
that call or wait; it does not durably abort shared work unless the invoked API
commits an abort mark.

A task may create owned conversations. Abort and idle operations traverse the
conversation ownership tree. History parents are irrelevant to this traversal.
Background tasks do not block ordinary idle waits and survive ordinary
conversation abort unless explicitly included.

Initial task definitions are registered before open performs live-task migration
and orphan reconciliation. Dynamic registration begins only after that pass.
Document migration remains access-driven. Unknown or unmigratable live task kinds
become terminal `orphaned`;
affected inputs become unanswered, any matching active turn control is cleared,
task-scoped documents retire, and a visible notice entry is appended in one
commit. Faulting a turn task performs the same control/input cleanup with a
`faulted` outcome.

## 6. Inputs and inbox

Input records back awaitable host handles. The inbox itself is an ordered
conversation document containing tagged items:

```ts
type InboxItem =
  | { readonly id: Id; readonly mode: "steer" | "followUp"; readonly input: Message }
  | { readonly id: Id; readonly mode: "write"; readonly entry: EntryDraft };
```

A built-in turn-control document has an optional `active` value naming the task
currently responsible for the turn and its placed input IDs. `active !==
undefined` defines `busy`; get-or-create of the idle document does not. The
value remains active while generation, tools, and post-tools hand work to one
another.

Admission and terminal transitions:

| action | input state | other writes |
|---|---|---|
| idle `send` | `placed`, with user entry | create turn controller/generation |
| busy `send` | `queued` | append steer/follow-up inbox item |
| idle passive `write` | `done`, with entry | append entry; no turn |
| busy passive `write` | `queued` | append write inbox item |
| boundary places user item | `placed`, with entry | add ID to current/successor turn |
| boundary places write | `done`, with entry | append entry |
| turn answers | `done`, with answer entry | clear/hand off turn controller |
| turn fails or aborts | `unanswered`, with reason | clear/hand off turn controller |
| withdraw queued item | `unanswered`, reason `aborted` | remove inbox item |
| stale item | `unanswered`, reason `stale` | remove inbox item |

`requestId` deduplicates within one conversation before any write. Busy send
with `whenBusy: "reject"` writes nothing and reports `ConversationBusy`. Before
an idle send places its own entry, it runs a final boundary to drain any older
eligible queued items. A handle waits until `done` or `unanswered`; abort
withdraws only a still-queued input and otherwise reports that placement already
occurred. Conversation abort withdraws queued steer/follow-up inputs but keeps
passive writes for later placement.

Boundary selection is deterministic by item ID:

| boundary | write | steer | follow-up |
|---|---|---|---|
| `postTools` | all | first/all by mode | none |
| `final` | all | first/all by mode | first/all by mode |

A queued self-head write cuts older pending user items: those inputs become
stale, the write is placed, and the current turn terminates. Other head writes
whose target predates the caller's newest known head are stale.

At ordinary `postTools`, generation continues even with no queued trigger;
selected steer IDs join that continuation. A terminating/handoff post-tools
boundary uses final behavior instead. At `final`, the current turn's placed
inputs settle first; selected user IDs start one successor generation. Writes
never trigger generation by themselves. A final boundary without continuation
or user triggers leaves the conversation idle.

Selected and stale items are removed positionally while retained item order is
preserved.
Chord must encode scattered removals without retransmitting retained payloads.
The exact tracker optimization is implementation work; IDs are not substituted
for positional inbox semantics.

## 7. Hooks, tools, and system sections

### 7.1 Hooks

A hook is a typed question asked by a task before it commits a decision. Hooks
are declared by task kind and registered in registration order Session-wide or
for a conversation and its owned subtree. They run off the line; a crash before
the consuming commit may rerun them. Abort errors always propagate.

| hook | composition | ordinary throw |
|---|---|---|
| system instructions | all; draft changes compose; last tool override wins | roll back that handler, report, continue |
| `beforeRequest` | replacement chain | report, continue |
| `afterResponse` | all observers | report, continue |
| `onYield` | first continuation wins | report, continue |
| `beforeTool` | call replacement chain; first block wins | block tool with error text |
| `afterTool` | result replacement chain | report, continue |
| `afterTools` | all observers | report, continue |
| `beforeCollapse` | first decision wins | report, continue |

Hooks use task memos for durable first-writer-wins decisions. There is no public
semantic event channel; current UI status is document state.

### 7.2 Tools

```ts
type ToolControl = {
  readonly addTools?: readonly string[];
  readonly terminate?: true;
  readonly handoff?: string;
};

type ToolExecutionResult = {
  readonly content?: ToolResultMessage["content"];
  readonly isError?: boolean;
  readonly details?: JsonValue;
  readonly control?: ToolControl;
};

interface OwnedConversation {
  readonly id: Id;
  send(input: SendInput, context: Context): Promise<InputHandle>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
}

interface ToolExecutionApi extends DocumentObserver {
  readonly taskId: Id;
  readonly conversationId: Id;
  readonly callId: string;
  stream(chunk: string | Uint8Array): void;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  progress(value: JsonObject, context: Context): Promise<void>;
  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
    input: I,
    options: Omit<TaskOptions, "conversationId">,
    context: Context,
  ): Promise<TaskRef<R>>;
  getTask<R>(ref: TaskRef<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  waitForTask<R>(ref: TaskRef<R>, context: Context): Promise<SettledTask<R>>;
  createConversation(
    spec: Omit<ConversationSpec, "parent"> & { readonly inherit?: boolean },
    context: Context,
  ): Promise<OwnedConversation>;
}

type ToolRegistration = Tool & {
  readonly replay?: "safe" | "unsafe";
  readonly output?: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly retain?: "head" | "tail";
  };
  execute(
    args: JsonValue,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult>;
};
```

Omitted `replay` is `unsafe`. Omitted output bounds are 64 KiB, 200 lines, and
`retain: "head"`. `stream()` synchronously accepts UTF-8 output into that
invocation-owned bounded buffer and throws after invocation end. Throttled
commits publish the retained output and dropped byte/line counts in the tool
presentation document. If `execute()` omits `content`, the final retained stream
becomes one text content item; no stream becomes an empty content list. Explicit
text in explicit result content is bounded by the same limits before transcript
persistence; non-text content is retained as declared by its pi-ai type.

`progress(value)` replaces the invocation's complete JSON `progress` payload; it
does not merge keys. Its promise resolves after the corresponding or coalesced
document commit. During normal settlement, accepted output updates drain before
the tool-result entry and terminal task record commit. Abort and close obey
invocation and Session admission gates: uncommitted buffered updates may be
discarded, while admitted commits settle. Pre-flush cancellation or callback
failure does not poison the Session. Post-flush, checkpoint, or storage failure
follows the fatal Session rule.

Tools are dynamically registered declarations with name, description, JSON
schema, replay policy, and execute function. A tool call is accepted only if it
was offered in the request's effective system/tool history. Arguments are
validated before and after `beforeTool` hooks.

After hooks and validation, the tool task durably records the final call and
resolved replay policy before execution. Recovery does not rerun `beforeTool`
and does not let a changed registry declaration alter that stored policy.

A tool executes in a durable task. It may:

- write bounded progress/output to a presentation or task-scoped document;
- commit memos;
- create and wait for tasks;
- create owned conversations;
- observe documents for which it has a token/reference;
- mutate authorized documents through `commit()`;
- return bounded model content and separate diagnostic details.

Tool operations use the invoking task's admission and
invocation-lifetime gates. Task creation defaults to that task's conversation.
Trusted document access follows sections 3.3 and 9.2; there is no additional
document subtree authorization layer. `createConversation()` records the
invoking task as owner and returns an invocation-bound handle. `inherit` defaults
to `false`. When true, creation atomically selects the invoking conversation's
newest committed visible entry as `parent.at`; if no entry exists, it creates no
history parent. Conversation documents then apply section 3.7 at that entry, and
explicit model/section seeds override their inherited built-in values. With no
parent, documents initialize normally. That handle's
operations reject after the invocation ends. An `InputHandle` returned by its
`send()` is invocation-bound in the same way; the admitted input itself remains
durable after those methods reject. Invocation-owned document watches stop when
the invocation ends.

A tool result may request `addTools`, `terminate`, or `handoff`. Post-tools
applies added tool names to configured loadout, uses a final boundary for
terminate/handoff, and writes a headed handoff entry when requested.

On reopen, a tool reruns only when both its stored intent policy and the current
registered declaration say `safe`. A current `unsafe` declaration may veto a
stored-safe replay; a current-safe declaration never upgrades stored unsafe.
Every other orphaned effect produces an interrupted result containing the
durable partial output. Completed, failed, and aborted
tool terminal outcomes retain their tool-result entry ID for post-tools.

### 7.3 System sections and dynamic tools

```ts
interface SystemSection<T extends JsonValue = JsonValue> {
  readonly key: string;
  render(value: T): string;
}

function defineSystemSection<T extends JsonValue>(definition: {
  readonly key: string;
  render(value: T): string;
}): SystemSection<T>;
```

Pico stores prompt and tool changes directly as PR #9548 `SystemMessage` values
at their transcript positions:

```ts
type SystemEntry = EntryRecord & {
  readonly kind: "pi.system";
  readonly model: readonly [SystemMessage];
};

const baseline: SystemMessage = {
  role: "system",
  content: basePrompt,
  sections: { persona: renderedPersona, cwd: renderedCwd },
  toolsAdded: allEffectiveTools,
  timestamp: now,
};

const delta: SystemMessage = {
  role: "system",
  content: "",
  sections: { cwd: nextRenderedCwd, legacy: null },
  toolsRemoved: [{ name: "read" }],
  toolsAdded: [nextRead],
  timestamp: now,
};
```

System sections are registered by stable, non-integer-like key. Generation
prepares the desired rendered section values and effective tool roster, compares
them with the state obtained by replaying the active transcript, and appends a
positional `pi.system` baseline or delta.

Replay applies messages in transcript order. Non-empty `content` appends
instructions. A section string adds or replaces that name without moving an
existing section; `null` removes it, and a later re-addition appends it to the
ordered section map. Within one message, tool removals happen before additions,
so a same-name replacement gets the new declaration and position.

The built-in configuration document preserves section insertion order.
`setSection(section, undefined)` removes the key; setting it later appends it at
the end. Preparation compares both values and order. If values can be patched
without changing order, it emits the minimal patch. If effective and desired
section order differ, one commit appends two `pi.system` entries: the first
removes every effective section with `null`, and the second re-adds every desired
section in desired order. This makes order-only changes and deletion/re-addition
between requests replay exactly; merely restating equal values is insufficient.

A PR #9548 `SystemMessage` is always a patch, not a reset: it cannot remove
previous `content` or restore section order merely by restating current values.
Therefore, when a head removes the previous request-visible baseline, the new
`pi.system` entry adds `ContextEdit` omissions for every earlier `pi.system`
entry still retained after the cut. Its own message is then a complete baseline
containing the base `content`, every desired section in order, and every effective
tool declaration. Model-context replay sees the new baseline instead of the
omitted retained deltas. Head rebaselining takes precedence over ordinary
order/value patching. Without a head cut, an order mismatch uses the two-entry
remove/re-add sequence above; only when order already matches does preparation
emit the minimal changed values, `null` removals, and tool additions/removals.
Same-name tool replacements remove before adding. Registry or document changes
while preparation hooks run cause preparation to retry against a new snapshot.

Conversation creation may seed section values or explicit removals. Preparation
uses a mutable section draft with get/set/delete/wrap; each throwing hook loses
only its own draft changes. The rendered strings stored in historical
`SystemMessage.sections` remain authoritative even if the current renderer
changes. Pi-ai decides whether to send the messages positionally to a capable
provider or fold them into one leading system message; Pico does not rewrite its
stored transcript for provider compatibility.

### 7.4 Host extension reload

A host extension generation is the Session-side code implementing its task kinds,
hooks, tools, sections, and document definitions. Registry APIs may
change registered declarations during normal product operation, but they do not
make replacement of that implementation code safe while its callbacks are
running. Document definitions are passed explicitly to typed access rather than
registered.

In v1, changing host extension code is a Harness generation boundary:

1. Stop new admission and task reservation.
2. Close the Harness, signalling and joining its active task, tool, and hook
   invocations plus in-flight watch callbacks without writing abort marks or
   terminal outcomes.
3. Dispose the old facets and registrations.
4. Construct a new Harness over the same storage and new document tokens.
5. Register the complete task definition set before open performs live-task
   migration and orphan reconciliation. Ordinary documents migrate on later
   typed access.
6. Resume scheduling from the durable checkpoints.

A durable task does not need to become terminal before this restart; only its
current invocation must settle. A task definition must increase its version when
the meaning of persisted input or checkpoint state changes and migrate supported
older state. Uncommitted hook work may rerun under the new generation; committed
memos remain part of the live task.

If old extension code ignores cancellation and never settles, graceful in-process
reload cannot complete. The host must terminate that isolated worker/process
before opening the Session under the new generation. Old and new generations
must never own the same Session concurrently.

Generation-pinned registries that drain old callbacks while routing new work to
new code, plus explicit compatible task takeover, are possible future work. Safe
forced takeover of arbitrary non-cooperative JavaScript requires worker/process
isolation and is not a v1 promise.

## 8. Built-in tasks

The initial implementation provides:

| kind | responsibility |
|---|---|
| generation | prepare system/loadout, request or poll model, retry, classify response |
| tool | validate, hook, execute, persist progress, append result |
| post-tools | wait for tools, apply controls, run boundary, continue generation |
| collapse | select a transcript range, summarize, append a headed summary |

Generation uses `HarnessOptions.models` without a Pico-specific model adapter. It
resolves `models.getModel(ref.provider, ref.modelId)`, builds a pi-ai `Context`
from the prepared prompt/messages/tools, and calls `models.streamSimple()` with
the task invocation's abort signal and configured reasoning/options. Deferred
continuation calls `models.fetchDeferred()` and `models.cancelDeferred()` with
that same model and signal. Missing models and synchronous/streamed pi-ai errors
are classified into the durable generation outcomes below.

Generation and tool progress are throttled durable document commits. A crash may
lose only the uncommitted throttle window. Recovery converts committed partials
to normal interrupted/aborted transcript entries, clears presentation state,
and then retries or terminates according to the task phase. Retry deadlines,
attempts, compaction, and tool progress are current document state for late
joiners; completed-attempt usage/accounting is an entry or terminal detail.
Bounded output records whether content was truncated and any retained file path.

Compaction changes model context by appending a summary entry with a head. It
does not delete transcript history.


## 9. Document observation and Chord

### 9.1 Document source

```ts
declare const documentSourceType: unique symbol;
interface DocumentSource<T extends JsonObject> {
  readonly [documentSourceType]: T;
}

type WatchEnd =
  | { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
  | { readonly reason: "listener_error"; readonly error: Error };

interface WatchHandle<T> {
  /** Immutable acquisition snapshot. This reference never changes. */
  readonly value: T;
  /** Installs the sole serialized asynchronous listener. */
  start(listener: (ops: readonly Op[], context: Context) => Promise<void>): void;
  /** Prevents another callback from starting and signals an in-flight callback. */
  stop(): void;
  /** Settles after termination and any in-flight callback. */
  readonly closed: Promise<WatchEnd>;
}

type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

interface DocumentObserver {
  watchDoc<T extends JsonObject>(token: DocToken<T>, target: DocTarget, context: Context): Promise<DocumentWatch<T>>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: DocFamilyToken<T, I>, target: FamilyTarget<I>, context: Context): Promise<DocumentWatch<T>>;
}
```

`DocumentSource` is opaque. Pico5 adds this adapter at the Chord boundary:

```ts
interface ReplicatedDocument<T extends JsonObject> {
  readonly state: ReplicatedState<T | null>;
  dispose(): void;
}

function documentReplicatedState<T extends JsonObject>(
  source: DocumentSource<T>,
  context: Context,
): Promise<ReplicatedDocument<T>>;
```

The adapter registers the source with Chord and exposes it without a second
tracker or re-diff. Normal source and watch acquisition are get-or-create and
bind one concrete incarnation. Retirement publishes a JSON `null` replacement
and ends that incarnation's stream. The service may then withdraw itself; if it
remains exposed, consumers see `null`, never stale state. A later recreation
requires acquiring a new source/watch.

Each Chord adapter assigns its own in-memory contiguous delivery sequence; Pico
does not persist or expose that sequence through `WatchHandle`. Hydration
atomically captures a matching immutable value and adapter sequence before
subsequent source operations are delivered. Reopen creates a new source
lifetime and hydration.

### 9.2 `watchDoc`

Tasks, hooks, and tools may observe any document for which their code has a token
and target. There is no additional subtree permission system inside trusted
Session code.

`watchDoc()` is available on task, hook, and tool APIs. Acquisition performs
normal get-or-create and, on the Session line, binds one concrete incarnation,
captures its immutable committed value, and registers the handle for every later
committed operation batch. `watch.value` is that fixed acquisition snapshot and
never changes.

```ts
const watch = await api.watchDoc(JobOutputDoc, target, context);
let value = watch.value;
try {
  await initializeConsumer(value, context);
  watch.start(async (ops, deliveryContext) => {
    value = applyImmutable(value, ops);
    await consume(value, deliveryContext);
  });
} catch (error) {
  watch.stop();
  await watch.closed;
  throw error;
}
```

The caller initializes from `value` before `start()`. `start()` synchronously
installs the sole listener, changes the prepared handle to active, and schedules
delivery; it never invokes the listener inline. A second `start()`, or `start()`
after stop, throws.

One per-watch delivery line awaits each callback before starting the next, so
callbacks never overlap. Commits never wait for callback settlement: while one
batch is in flight, later batches append to the pending queue. Empty operation
batches are discarded before enqueueing and cannot consume queue bookkeeping. An
update accepted between acquisition and return, or between return and `start()`,
is therefore not lost. The listener's promise covers all work the watch
serializes; fire-and-forget work started by the listener is outside that
guarantee.

The pending queue is bounded only by the total number of operations in its
undelivered batches. It never estimates serialized size or calls
`JSON.stringify()` to make a compaction decision. When the operation-count limit
is exceeded, the handle leaves the in-flight batch untouched and replaces the
entire pending suffix with one newly allocated root replacement batch:

```ts
[["r", latestImmutablePublishedValue]]
```

The reset counts as one pending operation regardless of the document's in-memory
size. Later deltas append behind it. If the operation-count limit is exceeded
again, the whole pending suffix is replaced with a newer reset rather than
accumulating an unbounded operation list. This bounds delta bookkeeping, not the
document value itself. This watch observes convergent committed state, not every
intermediate transition.

The replacement value is the immutable publication value corresponding exactly
to the last batch compacted into it. After storage succeeds, Pico materializes
that value once per changed document with
`applyImmutable(previousPublishedValue, ops)`; it never retains mutable
`Tracker.state`, `Tracker.target`, or a borrowed storage candidate. Watches may
share the immutable publication value and operation payloads. A mutable consumer
must detach them before using mutable `apply()` or `track()`.

A watch remains bound to its original incarnation. Retirement replaces the
pending suffix with `[["r", null]]`. Before start, `value` remains the original
snapshot and the terminal reset becomes the first delivered batch. While active,
the reset follows any in-flight callback. Successful terminal delivery closes as
`retired`; recreation requires another watch.

`stop()` is idempotent, unregisters the handle, discards pending batches,
prevents another callback from starting, and signals the watch delivery context.
An in-flight callback is allowed to settle; `closed` resolves only afterward.
The acquisition `Context` governs the watch lifetime. Cancellation during
acquisition cleans up any registration before rejecting; an already-admitted
get-or-create commit still settles and is not undone. Cancellation immediately
after successful acquisition may therefore return an already-stopped handle,
whose `start()` throws and whose `closed` reports `cancelled`. Invocation
termination and Session close stop owned watches similarly. Listener rejection
is reported, discards pending work, and closes only that watch as
`listener_error`. The first termination reason wins, and every late rejection is
observed.

### 9.3 Conversation view

The public view is a fixed structural mount of selected built-in documents:

```ts
type ConversationView = {
  readonly conversation: ConversationRecord;
  readonly entries: readonly EntryRecord[];
  readonly docs: Readonly<Record<string, JsonObject>>;
};
```

The concrete built-in document IDs and fields are public protocol once their
implementation layer is approved. Third-party documents are initially exposed
through their own Chord services, not automatically mounted.

The mount consumes one complete Session commit and publishes one Chord batch:

```text
document op ["s", ["message"], value]
-> view op ["s", ["docs", "pi.live", "message"], value]
```

Entry appends/head changes and every changed mounted document are included in
the same publication. The mount owns no tracker and performs no semantic
projection. It materializes one immutable published view per batch with
`applyImmutable(previousView, mountedOps)` so every conversation watch can share
that value for reset compaction. A Chord adapter assigns a contiguous in-memory
delivery sequence per view source lifetime.

`Conversation.watch()` exposes that mount through the same immutable acquisition
snapshot, serialized asynchronous listener, and reset-compacted pending queue as
`watchDoc()`. Each non-empty operation batch represents one complete Session
commit; a commit that does not change the mounted view emits no watch batch. Chord
Session facets may forward the captured value and committed operations through
services, but that product wiring is not part of the Harness facade and must not
add another tracker or semantic event envelope.

### 9.4 Agent-mode notifications

The Session kernel and Chord structural sources do not maintain a semantic event
journal. Coding-agent JSON/RPC compatibility uses a thin agent-mode adapter
derived from each uncoalesced committed publication before per-watch queue
compaction. It owns no tracker or persistence and emits notifications only after
the commit that makes them true.

The adapter protocol covers run start/settlement, committed assistant progress,
message entry settlement, tool intent/progress/result, input queue/outcome,
retry/deferred/compaction state, configuration changes, and faults. One commit
may produce an ordered batch. Progress notifications represent Pico's throttled
durable partials, not every raw provider frame. The exact legacy `AgentEvent`
wire format is not preserved.

Notifications have no hydration or replay contract. A consumer requiring a
complete lifecycle subscribes before admitting the input; a late or reconnecting
consumer hydrates structural state and history instead. Product adapters apply
these rules:

- TUI hydrates and renders `ConversationView`, then applies structural updates;
  notifications may drive transient animation but are not its authority.
- Print awaits its submitted `InputHandle` and prints that input's answer.
- JSON/RPC expose correlated commands plus the ordered agent notification
  protocol, with transport backpressure and disconnect policy owned by that
  adapter.

This adapter is allowed even though a public Session-kernel semantic stream is a
non-goal. It must not derive notifications from a lossy, reset-compacted watch
when complete subscribed lifecycle delivery is promised.

## 10. Storage contract

Ordered scans are cursor-based. Exact identity lookups are keyed.

```ts
type Page<T, C> = {
  readonly items: readonly T[];
  readonly next?: C;
};

type Cursor = Readonly<Record<string, JsonValue>>;

type EntryQuery = {
  readonly conversationId: Id;
  readonly minEntryId?: Id; // inclusive
  readonly maxEntryId?: Id; // inclusive
};

type TaskQuery = {
  readonly conversationId?: Id;
  readonly kind?: string;
  readonly status?: "pending" | "running" | "terminal";
  readonly abortRequested?: boolean;
  readonly background?: boolean;
};

type DocumentPoint = Seq | "current";

type DocumentAddress = {
  readonly kind: string;
  readonly scope: DocumentRecord["scope"];
  readonly key?: string;
};

type DocumentQuery = {
  readonly scope: DocumentRecord["scope"];
  readonly at: DocumentPoint;
  readonly kind?: string;
};

type DocumentContent =
  | { readonly version: number; readonly kind: "base"; readonly value: JsonObject }
  | { readonly version: number; readonly kind: "delta"; readonly ops: readonly Op[] };

type StoredDocumentRecord =
  | { readonly seq: Seq; readonly version: number; readonly kind: "base"; readonly value: JsonObject }
  | { readonly seq: Seq; readonly version: number; readonly kind: "delta"; readonly ops: readonly Op[] };

type StoredDocument = {
  readonly record: DocumentRecord;
  readonly records: readonly [
    Extract<StoredDocumentRecord, { kind: "base" }>,
    ...Extract<StoredDocumentRecord, { kind: "delta" }>[],
  ];
};

type StorageWrite =
  | { readonly type: "conversation"; readonly value: ConversationRecord }
  | { readonly type: "entry"; readonly value: EntryRecord }
  | { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
  | { readonly type: "input"; readonly value: Input }
  | {
      readonly type: "document.create";
      readonly record: DocumentCreate;
      readonly content: Extract<DocumentContent, { kind: "base" }>;
    }
  | {
      readonly type: "document.change";
      readonly id: Id;
      readonly content: DocumentContent;
    }
  | { readonly type: "document.retire"; readonly id: Id };

/**
 * Trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Enforces atomicity, global ID ownership, immutable
 * conversation/entry creation, document lifecycle consistency, and detached
 * values; Session serializes commits.
 */
interface Storage {
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  mintId(): Id;

  conversation(id: Id, context: Context): Promise<ConversationRecord | undefined>;
  scanConversations(cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<ConversationRecord, Cursor>>;

  entry(id: Id, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  findLatestHeadMarker(conversationId: Id, atOrBeforeEntryId: Id | undefined, context: Context): Promise<(EntryRecord & { readonly head: Id }) | undefined>;
  scanEntries(query: EntryQuery, cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<EntryRecord, Cursor>>;

  task(id: Id, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanTasks(query: TaskQuery, cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  input(id: Id, context: Context): Promise<Input | undefined>;
  inputByRequest(conversationId: Id, requestId: string, context: Context): Promise<Input | undefined>;

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;
  document(id: Id, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
  scanDocuments(query: DocumentQuery, cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<DocumentRecord, Cursor>>;

  close(context: Context): Promise<void>;
}
```

Cursors are backend-owned JSON objects. Callers only round-trip them to the same
scan on the same storage; cross-storage or cross-query use is unsupported. The
Session owns the mutation line, so storage implementations do not add a second
caller-facing commit mutex. Each backend still makes one admitted batch atomic.

`findLatestHeadMarker()` returns the newest visible entry carrying `head` at or
below its optional inclusive cutoff. The returned entry is the marker; its
`head` value is the actual lower bound for context. `scanEntries()` pages the
inclusive ID range in newest-first order while applying every conversation
ancestry cap. With no bounds it pages complete visible history. To read context
through entry `E`, find the marker at or before `E`, then scan from
`marker?.head` through `E`. For current context the upper bound is omitted.
`entry()` combines exact global lookup with the commit sequence required by
historical document reads. `limit` is always the maximum page size.
`findDocument()` resolves one exact logical kind/scope/key address at current or
historical membership. A missing key means the singleton, not every family
member. `scanDocuments()` enumerates only the incarnations alive in one exact
scope at its selected point and may restrict one family/singleton kind. It uses
ascending incarnation IDs. There is no ordinary open-time all-document scan.
Task queries support conversation, kind, live/terminal status, abort mark, and
background status.

`document(id, at)` returns the newest applicable base plus its ordered delta tail
and never scans unrelated documents. An unknown ID returns `undefined`. At
`"current"`, a retired incarnation returns `undefined`. A numeric lookup of a
rewindable conversation incarnation returns `undefined` outside its half-open
lifetime and reconstructs the selected value inside it. A numeric lookup of a
known current-only incarnation rejects rather than depending on content that
reclamation may have removed. Metadata membership remains queryable historically.
A missing required base inside an addressable rewindable lifetime is storage
corruption, not absence.

One normalized batch contains at most one create/change content command per
incarnation and may also retire that incarnation. Storage applies content before
retirement independent of write-array order. Create plus retire stamps both
lifetime bounds with the batch sequence. Retire plus create at one logical
address makes the new incarnation current at that sequence. Deltas cannot cross
a stored version boundary; a version transition must be a base.

The semantic conformance suite covers memory, SQLite, and JSONL.

## 11. Backends

### 11.1 Memory

Memory storage is the reference semantics. It copies retained write values and
all read results. This deliberately simulates the ownership boundary naturally
created by SQLite encoding/decoding and JSONL serialization; it is not defensive
validation. It preserves rewindable records and reclaims latest records only
after a committed base or retirement.

### 11.2 SQLite

One SQL transaction is one Session commit. SQLite stores:

- conversation, entry, task, and input records;
- document lifecycle records;
- indexed document bases/deltas by document and commit sequence.

Live task transitions replace one row. Terminal tasks remain as small records.
Document reads use indexed base-plus-tail ranges. The first implementation stores
Chord records directly; it does not translate generic operations to SQLite JSON
functions.

Schema shape, WAL checkpoint cadence, and synchronous defaults are backend
implementation choices validated by conformance, reopen, query-plan, and storage
benchmarks.

### 11.3 JSONL

JSONL uses reclaimable sidecars without exposing them to the harness. Persistence
alone does not provide the ownership boundary: any decoded indexes, materialized
values, or caches retained in memory must be detached from commit arguments and
must not be exposed directly by reads. A JSONL backend cannot simply add file
appends around aliasing memory tables.

```text
main.jsonl       table writes, lifecycle, and one marker per commit
doc-<id>.jsonl   one document incarnation
task-<id>.jsonl  live task replacements
```

Publication protocol:

1. Append complete prepared records to every affected sidecar.
2. Append one complete main marker listing those records.
3. Publish in memory only after the marker write succeeds.

Every commit uses this protocol; there is no standalone-sidecar fast path.
Without `fsync`, it guarantees ordinary process-crash consistency, not survival
of power, host, kernel, or filesystem failure. Durable mode flushes sidecars
before the marker.

Recovery:

- Remove torn final lines.
- Ignore and remove unconfirmed sidecar tails.
- Apply confirmed records only.
- Missing required confirmed data is corruption and opening fails.
- A later committed latest base or retirement may prove an earlier physical
  record unnecessary.
- Any uncertain append failure poisons the open backend.

Reclamation starts only after the authorizing base/retirement commits. It writes
a temporary replacement, renames it, and invalidates cached file descriptors so
future appends cannot target an unlinked inode. `main.jsonl` is not compacted in
the initial implementation.

## 12. API footguns

These are contracts, not invitations to add defensive machinery:

- **Draft escape:** `tx.doc()` values, nested proxies, and array methods are valid
  only during that transaction. Retaining them can contaminate a later commit.
- **Inserted aliases:** after assigning an object or array into a draft, do not
  mutate the original value. The tracker owns it.
- **Read after write:** read every required table row before the first table
  write. Document drafts remain usable afterward; table reads do not.
- **Long transactions:** an async commit callback holds the Session mutation
  line. Never await models, tools, processes, network calls, humans, a nested
  Session commit, or a Session waiter inside it. Use methods on the current `Tx`.
- **Get-or-create reads:** `snapshot()` and `documentSource()` can create and
  commit an absent document. They are not historical or side-effect-free reads.
- **Family initialization:** `initial` input is used only for a new incarnation.
  It does not update an existing instance.
- **Checkpoint starvation:** if `checkpointWhen()` never returns true, replay
  and current-only document storage can grow without bound while the document is
  live.
- **Wrong fork setting:** `current`, `initial`, and `asOf` are product semantics,
  not optimizations. Changing one changes child conversation behavior.
- **Schema stability:** document kinds and visible mount paths are
  persisted/public protocol. Value migration cannot rename a kind; a kind
  change requires explicit copy and retirement. Passing incompatible definition
  tokens that claim the same kind is unsupported caller misuse; Session does not
  maintain a document-definition registry to detect it.
- **Watch activation:** `watch.value` is the immutable acquisition snapshot.
  Initialize the consumer from it before `start()`; queued operations are based
  on exactly that value.
- **Coalesced watches:** slow or unstarted watches may replace an undelivered
  suffix with a complete reset, omitting intermediate committed states. A facet
  that must audit every transition must persist each fact as an immutable entry
  or in its own journal and scan that history explicitly.
- **Watch self-join:** a listener may call `stop()`, but must not await its own
  `closed` promise or a Session close that joins that listener.
- **Durable progress cadence:** clients see only committed progress. A crash may
  lose the current uncommitted throttle window.
- **Large terminal results:** terminal task records remain queryable. Put large
  results in entries or longer-lived documents and retain only their IDs in the
  outcome. Never reference a task-scoped document retired by that same outcome.
- **Raw transcript:** view entries are not model context. Rendering edits,
  display-only entries, and model filtering require the appropriate reducer.
- **Fatal storage errors:** after an uncertain storage failure the Session is
  poisoned. Do not catch the error and continue using it.
- **JSONL durability:** default JSONL ordering handles ordinary process crashes;
  without durable mode it does not promise acknowledged commits survive power or
  host failure.

## 13. Non-goals

Pico5 initially has no:

- whole-Session DOM;
- visible-undurable publication;
- Session-kernel semantic event journal or independently maintained event state;
- transaction membrane;
- session-scoped rewindable documents;
- automatic checkpoint heuristic;
- automatic third-party view mounting;
- CRDT/offline multi-writer merge;
- SQL translation of arbitrary Chord operations;
- JSONL global compaction or automatic corruption repair;
- compatibility layer for removed Pico prototypes;
- in-process hot replacement of Session-side extension implementations.
