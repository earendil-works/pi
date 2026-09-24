# Pico5 specification

Pico5 is a durable, extensible agent harness. This document is normative.
Pico5 uses existing package types as follows:

```ts
import type {
  Context,
  Draft,
  JsonValue,
  ReplicatedState,
} from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
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
type TaskOutcomeError = { message: string; detail?: JsonValue };
```

Pico5 targets the transcript `SystemMessage` contract from pi-ai PR
[#9548](https://github.com/earendil-works/pi/pull/9548). `Message` includes that
type once the PR lands.

The core rule is:

> A Session atomically commits immutable entries, full task records, and
> Chord-tracked documents. Only committed state is observable.

## 1. Terms and invariants

- A **Session** owns one mutation line, conversations, entries, tasks,
  submissions, and documents.
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
6. Document drafts are fully revoked when their transaction callback settles:
   the Session synchronously prepares or aborts every open change at that point.
   Values assigned into a draft are copied by value and must be strict JSON.
7. The mutation line remains held through storage settlement and committed-state
   adoption. Listener callbacks run later, off the line.
8. An uncertain storage failure is fatal to the open Session. It publishes
   nothing and must be reopened. Preparation and checkpoint failures occur before
   storage admission and roll back normally.

## 2. Core records

The concrete JSON representations may add bookkeeping fields, but must preserve
these contracts.

```ts
type Id = number;
/** Strictly increases between commits; gaps are permitted. */
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

type SubmissionRecordBase = {
  readonly id: Id;
  readonly conversationId: Id;
  readonly requestId?: string;
};

type SubmissionRecord =
  | (SubmissionRecordBase & {
      readonly type: "input";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "placed";
          readonly entry: Id;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: Id;
          readonly answer: Id;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: Id;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ))
  | (SubmissionRecordBase & {
      readonly type: "write";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: Id;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ));

type SubmissionCreate = SubmissionRecord extends infer Record
  ? Record extends SubmissionRecord
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

type SubmissionDraft = {
  readonly requestId?: string;
} & (
  | {
      readonly type: "input";
      readonly content: UserInput;
      readonly whenBusy?: "steer" | "followUp" | "reject";
      readonly entry?: never;
    }
  | {
      readonly type: "write";
      readonly entry: EntryDraft;
      readonly content?: never;
      readonly whenBusy?: never;
    }
);

type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

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

type SettledSubmissionRecord = SubmissionRecord & {
  readonly status: "done" | "unanswered";
};

interface Submission {
  readonly id: Id;
  status(context: Context): Promise<SubmissionRecord>;
  wait(context: Context): Promise<SettledSubmissionRecord>;
  abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
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
  submit(submission: SubmissionDraft, context: Context): Promise<Submission>;

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
  submission(id: Id, context: Context): Promise<Submission | undefined>;
  abortSubmission(
    id: Id,
    context: Context,
    conversationId?: Id,
  ): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
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
conversation watch replace those surfaces. `submit()` durably admits either a
user input or passive entry write and returns one `Submission` that tracks its
settlement.

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
configuration and section/tool seeds, and an optional input submission. For a fork,
omitted model, section, and active-tool values follow their document definition's
fork policy; provided values override those forked built-in values in the same
commit. Other documents follow their own definitions without special handling.

The built-in conversation configuration document contains the selected model,
thinking level, an ordered array of section key/value records, and active tool
names. Its initial thinking level
is `"off"`. It is rewindable with `fork: "asOf"`, so a child starts from the
configuration visible at its selected entry unless explicit creation seeds
override it. Conversation creation eagerly
creates it, so `getModel()`, `getThinkingLevel()`, `getActiveTools()`, and
`getSection()` return immutable committed snapshots without a get-or-create
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
`detail: { code: "missing_active_tool", names }`, makes its placed input submissions
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
invocation. `Conversation.abort()` withdraws queued input submissions, marks
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

`submit()` returns after durable admission, not settlement. An input submission
creates a user message with the admission timestamp; `whenBusy` defaults to
`followUp`. A write submission uses the ordered passive path in section 6 and
never starts generation. `Submission.wait()` settles an input only after its
answer or terminal failure; it settles a write when the entry is placed or the
write becomes terminally unplaceable. Cancelling `wait()` only cancels that wait.
It does not withdraw the submission; `Submission.abort()` is the explicit queued
withdrawal operation. `Harness.submission()` reacquires a submission after
reopen; records remain queryable after settlement.

`abortTask()` durably requests cancellation and returns `marked` after the mark
is committed, any active run invocation has joined, and an abort invocation has
been scheduled; it does not await terminal settlement. `waitForTask()` observes
the terminal receipt. Aborting an already terminal task returns `terminal`; an
unknown ID rejects. Explicit task abort includes a background task. Cancelling a
task or idle wait does not abort work.

`Conversation.watch()` atomically captures its current immutable structural
revision and registers for later complete Session commits. Its `WatchHandle`
uses the same serialized asynchronous, latest-revision delivery contract as
`watchDoc()` in section 9.2. It carries no semantic events and owns no second
persistence authority.

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
    initial(seed: I): T;
  };

declare const docType: unique symbol;
interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
  readonly definition: D;
  readonly [docType]?: T;
}
interface DocFamilyToken<
  T extends JsonObject,
  I extends JsonValue,
  D extends DocFamilyDefinition<T, I>,
> {
  readonly definition: D;
  readonly [docType]?: T;
}

type SessionDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "session" }
>;
type ConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & RewindableConversationSemantics
>;
type TaskDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "task" }
>;

type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;

function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "session";
    initial(seed: I): T;
  },
): SessionDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & LatestConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): ConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & RewindableConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): RewindableConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "task";
    initial(seed: I): T;
  },
): TaskDocFamilyToken<T, I>;
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

A persisted document instance has one `DocumentRecord`:

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
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  close(context: Context): Promise<void>;

  snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: Id, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: TaskDocToken<T>, taskId: Id, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: Id, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: Id, key: string, context: Context): Promise<Readonly<T> | undefined>;

  snapshotAsOf<T extends JsonObject>(token: RewindableConversationDocToken<T>, conversationId: Id, at: Id, context: Context): Promise<Readonly<T> | undefined>;
  snapshotAsOf<T extends JsonObject, I extends JsonValue>(token: RewindableConversationDocFamilyToken<T, I>, conversationId: Id, key: string, at: Id, context: Context): Promise<Readonly<T> | undefined>;

  documentSource<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentSource<T> | undefined>;
  documentSource<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: Id, context: Context): Promise<DocumentSource<T> | undefined>;
  documentSource<T extends JsonObject>(token: TaskDocToken<T>, taskId: Id, context: Context): Promise<DocumentSource<T> | undefined>;
  documentSource<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentSource<T> | undefined>;
  documentSource<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: Id, key: string, context: Context): Promise<DocumentSource<T> | undefined>;
  documentSource<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: Id, key: string, context: Context): Promise<DocumentSource<T> | undefined>;
}

interface Tx {
  conversation(id: Id): Promise<ConversationRecord | undefined>;
  entry(id: Id): Promise<EntryRecord | undefined>;
  task(id: Id): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanEntries(query: EntryQuery): Promise<readonly EntryRecord[]>;
  scanTasks(query: TaskQuery): Promise<readonly TaskRecord<JsonValue, JsonValue, JsonValue>[]>;

  createConversation(value: Omit<ConversationRecord, "id">): Promise<ConversationRecord>;
  appendEntry(conversationId: Id, value: EntryDraft): Promise<EntryRecord>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>, input: I, options?: TaskOptions,
  ): Promise<TaskRef<R>>;
  setTask(value: TaskRecord<JsonValue, JsonValue, JsonValue>): void;

  doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: Id): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: Id): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: Id, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: Id, key: string, seed: I): Promise<Draft<T>>;

  retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
  retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: Id): Promise<void>;
  retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: Id): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: Id, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: Id, key: string): Promise<void>;
}
```

ID-creating transaction methods are asynchronous because remote storage may allocate globally unique IDs durably. Only public typed `tx.doc()` is get-or-create. Internal fork copying may create
new incarnations directly from stored values without a definition. `tx.doc()`
receives the definition token that supplies
its static type, initializer, migration, and checkpoint policy. Scope-preserving
token overloads require callers to supply only the concrete conversation/task ID
and, for a family, its key and creation seed. Ordinary definitions are not
registered and ordinary documents are not scanned at open.

- Existing instances are reconstructed and migrated lazily according to section
  3.6. A migration reached through `tx.doc()` is staged in its enclosing
  transaction.
- A missing singleton calls the token's `initial()`. A missing family member calls
  `initial(seed)`. Creation stores an initial base.
- The first acquisition of one logical address is memoized before awaiting. Later
  acquisitions in that transaction return the same draft; for a missing family,
  the first call's detached seed wins and later seeds are ignored.
- `snapshot()`, `snapshotAsOf()`, `documentSource()`, and `watchDoc()` never create
  or persist migration. They return `undefined` when the requested incarnation is
  absent and migrate a reconstructed value only in memory.
- Task-scoped `tx.doc()` validates against the transaction's latest candidate task
  record, falling back to committed state. This internal validation is not a
  caller table read and does not trigger `ReadAfterWrite`. Its conversation is
  derived from the task record.
- `retireDoc()` resolves the logical address without creating it. Retirement of
  an acquired draft persists its final content before retirement. A later
  `tx.doc()` at that address in the same transaction creates a new incarnation
  with a new draft and ID.
- A terminal candidate rejects later task-document access. Terminal settlement
  retires both existing task documents and task documents created earlier in the
  same transaction.
- `snapshot()` returns the current shareable immutable revision. Mutation of it
  or any retained descendant is unsupported; callers that need mutable ownership
  must copy it first.
- `documentSource()` returns an opaque source bound to one committed incarnation.
- `tx.doc()` returns one revocable Astra overlay `Draft<T>` for the transaction.
- Historical reads never create documents in the past.

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

Pico uses Chord Delta's Astra-immutable transaction shape directly:

```ts
interface Prepared<T extends object> {
  readonly base: T;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly baseRevision: number;
  abort(): void;
}
interface Change<T extends object> {
  readonly state: Draft<T>;
  prepare(): Prepared<T>;
  abort(): void;
}
interface Tracker<T extends object> {
  readonly value: T;
  readonly revision: number;
  beginChange(): Change<T>;
  prepareReplace(value: T): Prepared<T>;
  adopt(prepared: Prepared<T>): void;
}
```

Each loaded document owns one tracker whose `value` is its current immutable
revision. Immutability is a trusted ownership contract, not runtime freezing:
a revision and its descendants must never be mutated after transfer to the
tracker. `prepare()` revokes the draft, emits detached self-contained
operations, and computes `value` with the optimized immutable applier before
Storage admission. Unchanged subtrees are structurally shared with `base`.
Operation placement payloads may also be shared with `value`; mutating either a
prepared operation or an immutable revision is unsupported. Astra preserves an
empty operation batch for changes it proves are no-ops, but Pico performs no
additional whole-value equality pass for nonempty structural batches.

`abort()` is idempotent. `adopt()` accepts only a prepared result from that
tracker at its current revision, then performs only a synchronous pointer swap
to the already-computed immutable `value`. It performs no diffing, application,
allocation, or callback. The Session line permits at most one open change per
tracker and ensures no result becomes stale between preparation, Storage
settlement, and adoption.

The first `tx.doc()` acquisition calls `tracker.beginChange()` and memoizes that
change's draft for the rest of the possibly async Session callback.

Transaction behavior:

```text
begin transaction
  acquire and memoize document changes by logical address
  mutate revocable Astra overlay drafts
callback settles
  seal Tx; synchronously prepare or abort every open change, revoking every draft
  if any acquisition is pending: abort open changes, reject, then drain and abort it
callback fails with no pending acquisition
  abort every open change; persist and publish nothing
callback succeeds with no pending acquisition
  prepare every open change -> immutable next revision + self-contained Chord Op[]
  Session evaluates each required/ordinary document write exactly once
  prepare every affected loaded conversation mount revision
  Storage.commit persists the atomic batch while the Session line remains held
storage succeeds
  adopt every prepared change by pointer swap and enqueue immutable revision/ops publication
  release the line; invoke listeners later
storage fails
  abort every prepared change, poison Session, and publish nothing
```

A pending acquisition that resolves after sealing never exposes a draft; its
change is aborted and its promise rejects. The Session observes every such
settlement before releasing the line. Initializer, migration, and replacement
roots come from caller code: the Session copies each one into exclusive kernel
ownership, rejecting any value that is not strict JSON, before it becomes an
immutable tracker revision. Loaded and fork-copy roots are already detached
strict JSON from Storage and enter the tracker without another copy. Chord's
`track()` and `prepareReplace()` take ownership in O(1) without traversal, so
every root they receive must come from one of these sources. Migration callbacks
never receive a live tracker revision.

Preparation, validation, checkpoint, or mounted-view preparation failure occurs
before Storage admission and rolls back normally. The Session performs no
strict-JSON walk of prepared operations or selected bases: roots are checked on
entry and Chord checks every draft placement, so every revision, operation
payload, and base is strict JSON by construction. Tracker branding and `baseRevision` enforce ownership and staleness; the
Session never substitutes caller-created prepared values. The prepared immutable
candidate itself becomes the adopted and published value. Storage receives that complete value only when the
Session selects a base; otherwise it receives only the prepared operation batch.
An existing current-version document with an empty batch writes and publishes
nothing. A nonempty structural batch whose final value is deeply equal to its
base remains a valid durable change and publication. Creation and required
version transitions still write a base when their prepared batch is empty; an
equal-value version base does not emit a watch update.

Values assigned into a draft are copied immediately by value. Repeated
placements are independent. Chord checks each placement while copying it and
throws at the offending assignment, before the draft changes, when the value is
not strict JSON: `undefined` array elements or nested object values, non-finite
numbers, functions, symbols, bigints, accessors, symbol keys, sparse arrays, or
objects whose prototype is neither `Object.prototype` nor `null`. Assigning
`undefined` directly to an object property deletes that property. Draft reads, draft writes, and all `Tx` operations
reject after the callback settles. The prepared immutable value remains readable
by Session-owned checkpoint and Storage preparation.

```ts
let escaped: Draft<LiveState>;
await session.commit(async tx => {
  escaped = await tx.doc(LiveDoc, conversationId);
});
escaped.message = message; // throws: the draft was revoked
```

Fire-and-forget work that mutates a draft before the owner callback settles may
silently enter that transaction and is unsupported.

### 3.5 Bases and checkpoints

Creation always stores a complete base.

For an ordinary later mutation, the definition alone decides whether the
storage record is a base:

```ts
const useBase = definition.checkpointWhen?.(candidateValue, ops) ?? false;
```

The Session evaluates this predicate exactly once after tracker preparation.
Creation and version transitions require bases and do not call it. The Session
then gives Storage only the selected representation:

```text
required or predicate true -> base with complete value
otherwise                  -> delta with the prepared Chord operation batch
```

A Chord root-replacement operation remains a delta unless the definition selected
a checkpoint; it does not authorize reclamation. Predicate failure aborts the
prepared transaction before Storage admission. Storage executes no definition
code and never receives an unused complete candidate with a selected delta.

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

- Read-only access migrates only in memory and never writes. It may cache a
  tracker over that migrated immutable revision together with the older stored
  version marker; the next successful `tx.doc()` access still writes the required
  current-version base. Migration always starts from a detached stored value.
  `tx.doc()` stages migration in its enclosing transaction; callback failure
  persists nothing, and later draft edits coalesce into one final required base.
- Rewindable history is not rewritten. Current and historical reconstructed
  values are migrated after replay.
- The first `tx.doc()` transaction after any stored-version migration writes a
  required current-version base, even when the migrated JSON is deeply equal.
- A fork obtains the selected stored value/version from Storage rather than a
  typed migrated tracker cache. The child copies that stored pair and migrates on
  later typed access.
- Unaccessed documents and documents with unavailable definitions preserve their stored instances,
  versions, and bytes.

### 3.7 Forks

A conversation fork points to one concrete visible entry `E`.

The child transcript includes entries through `E`, even if the same commit also
appended later entries. Document state at `E` is the final state of the commit
containing `E`. Different document states require separate commits.

Each conversation document follows the history/fork policy persisted in its
`DocumentRecord`:

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
  const task = await tx.task(taskId);                // table read
  const live = await tx.doc(LiveDoc, conversationId);

  await tx.appendEntry(conversationId, message);     // first table write
  delete live.message;                               // document mutation remains valid
  tx.setTask(nextTask(task));
}, context);
```

Mutation admission occurs on the Session line before a commit callback starts. Closing seals mutation admission and task
reservation. Already-admitted commits settle before storage closes. Once a
commit is admitted, caller cancellation does not interrupt storage settlement or
undo the commit. Cancelling a close wait does not reopen admission.

Table rules:

- Tables are conversations, entries, tasks, and submissions.
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
  | { readonly status: "failed"; readonly error: TaskOutcomeError; readonly result?: R }
  | { readonly status: "aborted"; readonly reason?: string; readonly result?: R }
  | { readonly status: "orphaned"; readonly reason: string }
  | { readonly status: "faulted"; readonly error: TaskOutcomeError };

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
4. Resolves any submissions settled by the task.

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
affected input submissions become unanswered, any matching active turn control is cleared,
task-scoped documents retire, and a visible notice entry is appended in one
commit. Faulting a turn task performs the same control/submission cleanup with a
`faulted` outcome.

## 6. Submissions and inbox

Submission records back awaitable host objects. Their record transitions use
Session-private transaction operations, not the public `Tx` interface. The inbox
itself is an ordered conversation document containing tagged items:

```ts
type InboxItem =
  | { readonly id: Id; readonly mode: "steer" | "followUp"; readonly message: Message }
  | { readonly id: Id; readonly mode: "write"; readonly entry: EntryDraft };
```

A built-in turn-control document has an optional `active` value naming the task
currently responsible for the turn and its placed input-submission IDs. `active !==
undefined` defines `busy`; get-or-create of the idle document does not. The
value remains active while generation, tools, and post-tools hand work to one
another.

Admission and terminal transitions:

| action | submission state | other writes |
|---|---|---|
| idle input submission | `placed`, with user entry | create turn controller/generation |
| busy input submission | `queued` | append steer/follow-up inbox item |
| idle write submission | `done`, with entry | append entry; no turn |
| busy write submission | `queued` | append write inbox item |
| boundary places user item | `placed`, with entry | add ID to current/successor turn |
| boundary places write | `done`, with entry | append entry |
| turn answers | input `done`, with required answer entry | clear/hand off turn controller |
| turn fails or aborts | input `unanswered`, with reason | clear/hand off turn controller |
| withdraw queued item | `unanswered`, reason `aborted` | remove inbox item |
| stale item | `unanswered`, reason `stale` | remove inbox item |

`requestId` deduplicates within one conversation before any write; reusing one
for the other submission type rejects. A busy input with `whenBusy: "reject"`
writes no record and reports `ConversationBusy`. Before an idle input places its
own entry, it runs a final boundary to drain older eligible queued items. A
`Submission` waits until `done` or `unanswered`; abort withdraws only a still-
queued submission, reports `already_placed` for a placed input, and reports
`settled` for any terminal submission. Conversation abort withdraws queued steer/follow-up submissions but keeps writes
for later placement.

Boundary selection is deterministic by item ID:

| boundary | write | steer | follow-up |
|---|---|---|---|
| `postTools` | all | first/all by mode | none |
| `final` | all | first/all by mode | first/all by mode |

A queued self-head write cuts older pending user items: those submissions become
stale, the write is placed, and the current turn terminates. Other head writes
whose target predates the caller's newest known head are stale.

At ordinary `postTools`, generation continues even with no queued trigger;
selected steer IDs join that continuation. A terminating/handoff post-tools
boundary uses final behavior instead. At `final`, the current turn's placed
input submissions settle first; selected user IDs start one successor generation. Writes
never trigger generation by themselves. A final boundary without continuation
or user triggers leaves the conversation idle.

Selected and stale items are removed positionally while retained item order is
preserved. Chord's Astra operation generator must express scattered removals
without carrying retained values; IDs are not substituted for positional inbox
semantics.

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
  submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
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

Omitted `replay` is `unsafe`. Omitted output bounds are 50 KiB, 2,000 lines,
and `retain: "head"`. `stream()` synchronously accepts UTF-8 output into that
invocation-owned bounded buffer and throws after invocation end. Throttled
commits publish the retained output and dropped byte/line counts in the tool
presentation document. If `execute()` omits `content`, the final retained stream
becomes one text content item; no stream becomes an empty content list. Explicit
text in explicit result content is bounded by the same limits before transcript
persistence; non-text content is retained as declared by its pi-ai type.

`stream()` never spills complete output to a file because spilling requires a
filesystem, which may be remote or unavailable. A tool that must preserve
complete output spills through the `ExecutionEnv` or `FileSystem` it was given,
such as shell execution with spill capture, and reports the resulting path in its
result details or progress.

`progress(value)` replaces the invocation's complete JSON `progress` payload; it
does not merge keys. Its promise resolves after the corresponding or coalesced
document commit. During normal settlement, accepted output updates drain before
the tool-result entry and terminal task record commit. Abort and close obey
invocation and Session admission gates: uncommitted buffered updates may be
discarded, while admitted commits settle. Cancellation, callback, tracker
preparation, and checkpoint failures occur before Storage admission and do not
poison the Session. An uncertain Storage failure follows the fatal Session rule.

Tools are dynamically registered declarations with name, description, JSON
schema, replay policy, and execute function. A tool call is accepted only if it
was offered in the request's effective system/tool history. Arguments are
validated before and after `beforeTool` hooks.

After hooks and validation, the tool task durably records the final call and
resolved replay policy before execution. Recovery does not rerun `beforeTool`
and does not let a changed registry declaration alter that stored policy.

An owned conversation accepts only input submissions; tools use ordinary
transaction writes for passive entries.

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
operations reject after the invocation ends. A `Submission` returned by its
`submit()` is invocation-bound in the same way; the admitted submission remains
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

The built-in configuration document stores sections as an ordered array, never
as an object whose key order must be inferred by Delta. `setSection(section,
undefined)` removes the record; setting it later appends it at the end. Preparation compares both values and order. If values can be patched
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

Chord's existing replicated-state layer exposes this source-adoption contract:

```ts
interface ReplicatedStateSourceFrame<T> {
  readonly cursor: number;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly context: Context;
}

interface ReplicatedStateSourceAttachment<T> {
  /** Fixed immutable snapshot captured at the atomic attachment boundary. */
  readonly snapshot: { readonly value: T; readonly cursor: number };
  /** Install the sole listener and synchronously drain every buffered frame. */
  activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
  dispose(): void;
}

interface ReplicatedStateSource<T> {
  /** Atomically capture a snapshot and begin buffering every later commit. */
  attach(): ReplicatedStateSourceAttachment<T>;
}

interface ReplicatedStateSourceOptions {
  readonly onError?: (error: Error) => void;
}

interface AttachedReplicatedState<T> extends ReplicatedState<T> {
  readonly value: T;
  dispose(): void;
}

function replicatedState<T>(
  source: ReplicatedStateSource<T>,
  options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;

declare const documentSourceType: unique symbol;
interface DocumentSource<T extends JsonObject>
  extends ReplicatedStateSource<Readonly<T> | null> {
  readonly [documentSourceType]: T;
}

type WatchEnd =
  | { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
  | { readonly reason: "listener_error" | "diff_error"; readonly error: Error };

interface WatchHandle<T> {
  /** Acquisition revision before start; latest delivered immutable revision afterward. */
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
  watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: Id, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: Id, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: Id, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: Id, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
}
```

`DocumentSource` is an opaque Chord-recognized `ReplicatedStateSource`. A Chord
replicated state adopts Pico's shareable committed immutable revisions directly,
without another tracker or a value copy. `attach()` is one synchronous boundary:
`snapshot.value` includes every commit through `snapshot.cursor`, and the
attachment buffers only later frames. `activate()` installs the sole listener
and synchronously drains those frames in contiguous cursor order before
returning. An operation already covered by the snapshot is never redelivered.
Source-backed state is publication-only and Pico remains its sole mutator.
Source revisions and operation placement payloads may share trusted immutable
containers.

Source and watch acquisition never create; absent lookup returns `undefined`.
Successful acquisition binds one concrete incarnation. Retirement publishes a
JSON `null` replacement and ends that incarnation's stream. The service may then
withdraw itself; if it remains exposed, consumers see `null`, never stale state.
If the incarnation retires before attachment, attachment hydrates terminal
`null`; it never binds a replacement incarnation. A later recreation requires
acquiring a new source/watch.

Each adopted replicated state assigns its own in-memory contiguous delivery
sequence; Pico does not persist or expose that sequence through `WatchHandle`.
A live source or watch pins its incarnation's loaded tracker; eviction begins only
after every attachment ends. Reopen creates a new source lifetime and hydration.

### 9.2 `watchDoc`

Tasks, hooks, and tools may observe any existing document for which their code
has a token and owner/key. There is no additional subtree permission system inside trusted
Session code.

`watchDoc()` is available on task, hook, and tool APIs. On the Session line,
acquisition resolves one existing concrete incarnation, captures its current
immutable tracker revision in O(1), and registers the handle for later current
revisions. It returns `undefined` when absent. Before `start()`,
`watch.value` remains the acquisition revision even when newer revisions commit.

```ts
const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
if (watch === undefined) return;
try {
  await initializeConsumer(watch.value, context);
  watch.start(async (_ops, deliveryContext) => {
    await consume(watch.value, deliveryContext);
  });
} catch (error) {
  watch.stop();
  await watch.closed;
  throw error;
}
```

The caller initializes from the acquisition revision before `start()`.
`start()` synchronously installs the sole listener, changes the prepared handle
to active, and schedules delivery; it never invokes the listener inline. A
second `start()`, or `start()` after stop, throws.

Each watch retains only its last delivered immutable revision and the newest
committed immutable revision. It retains no operation queue and never constructs
reset frames. Before each callback, off the Session line, it computes
`diffRevisions(lastDelivered, newest)` and advances `watch.value` to that exact
newest revision. An empty derived batch advances the value silently without
invoking the listener. A nonempty batch is delivered with a watch-owned Context
that carries values from the newest coalesced commit's Context while its
cancellation lifetime belongs to the watch. If a newer revision arrives while a callback
is in flight, the delivery line repeats after that callback settles. Callbacks
never overlap, and commits never wait for callback settlement.

An update accepted between acquisition and return, or between return and
`start()`, is therefore not lost. Slow or unstarted watches converge directly to
the latest committed state with memory bounded by immutable revision references,
not queued operation count. Intermediate commits and redundant nonempty batches
may be coalesced away when their net revision diff is empty. Code that must audit
every transition must persist each fact as an immutable entry or in its own
journal. The listener's promise covers all work the watch serializes;
fire-and-forget work started by the listener is outside that guarantee.

`watch.value` and every previously returned revision remain stable forever under
the trusted immutability contract. Consumers must not mutate them or any retained
descendant. A consumer needing mutable ownership must copy first.

A watch remains bound to its original incarnation. Retirement sets its newest
revision to `null`. Before start, `value` remains the acquisition revision;
after start, the terminal diff advances `watch.value` to `null`, invokes the
listener, and closes as `retired`. Recreation requires another watch.

`stop()` is idempotent, unregisters the handle, discards its pending latest
revision, prevents another callback from starting, and signals the watch-owned
delivery Context. An in-flight callback is allowed to settle; `closed` resolves only
afterward. The acquisition `Context` governs the watch lifetime. Cancellation
during acquisition cleans up any registration before rejecting. Cancellation
immediately after successful acquisition may return an already-stopped handle,
whose `start()` throws and whose `closed` reports `cancelled`. Invocation
termination and Session close stop owned watches similarly. Diff or listener
failure is reported, discards pending work, and closes only that watch as
`diff_error` or `listener_error`, respectively. The first termination reason wins, and every late rejection is
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
the same publication. Before Storage admission, the Session derives the mounted
operation batch and prepares each affected loaded mount's next immutable revision
with the optimized immutable applier. Failure rolls back normally. After Storage
success, finalization only installs the prepared mount pointers/cursors and
enqueues publication. Mounted document revisions may be structurally shared
because they obey the same trusted immutability contract. The mount performs no
semantic projection and owns no second persistence authority. A Chord adapter
assigns a contiguous in-memory delivery sequence per view source lifetime.

`Conversation.watch()` exposes that mount through the same O(1) immutable
acquisition, serialized asynchronous listener, and latest-revision coalescing as
`watchDoc()`. An empty mounted operation batch creates no revision; a redundant
nonempty batch may create a distinct but deeply equal revision. A slow watch may
skip intermediate revisions and receives a derived diff from its last delivered
revision directly to the newest one. Chord Session facets may
forward the captured revision and committed operations through services, but
that product wiring is not part of the Harness facade and must not add another
tracker or semantic event envelope.

### 9.4 Agent-mode notifications

The Session kernel and Chord structural sources do not maintain a semantic event
journal. Coding-agent JSON/RPC compatibility uses a thin agent-mode adapter
derived from each uncoalesced committed publication before per-watch
latest-revision coalescing. It owns no tracker or persistence and emits notifications only after
the commit that makes them true.

The adapter protocol covers run start/settlement, committed assistant progress,
message entry settlement, tool intent/progress/result, submission queue/outcome,
retry/deferred/compaction state, configuration changes, and faults. One commit
may produce an ordered batch. Progress notifications represent Pico's throttled
durable partials, not every raw provider frame. The exact legacy `AgentEvent`
wire format is not preserved.

Notifications have no hydration or replay contract. A consumer requiring a
complete lifecycle subscribes before admitting the submission; a late or reconnecting
consumer hydrates structural state and history instead. Product adapters apply
these rules:

- TUI hydrates and renders `ConversationView`, then applies structural updates;
  notifications may drive transient animation but are not its authority.
- Print awaits its input `Submission` and prints that submission's answer.
- JSON/RPC expose correlated commands plus the ordered agent notification
  protocol, with transport backpressure and disconnect policy owned by that
  adapter.

This adapter is allowed even though a public Session-kernel semantic stream is a
non-goal. It must not derive notifications from a lossy, latest-revision watch
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

type StoredDocument = {
  readonly record: DocumentRecord;
  readonly version: number;
  readonly value: JsonObject;
};

type StorageWrite =
  | { readonly type: "conversation"; readonly value: ConversationRecord }
  | { readonly type: "entry"; readonly value: EntryRecord }
  | { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
  | { readonly type: "submission"; readonly value: SubmissionRecord }
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
 * conversation/entry creation, document record consistency, and detached
 * values; Session serializes commits. Sequences strictly increase but may have
 * gaps. Once commit() resolves, later reads through that Storage observe it.
 */
interface Storage {
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  mintId(): Promise<Id>;

  conversation(id: Id, context: Context): Promise<ConversationRecord | undefined>;
  scanConversations(cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<ConversationRecord, Cursor>>;

  entry(id: Id, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  findLatestHeadMarker(conversationId: Id, atOrBeforeEntryId: Id | undefined, context: Context): Promise<(EntryRecord & { readonly head: Id }) | undefined>;
  scanEntries(query: EntryQuery, cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<EntryRecord, Cursor>>;

  task(id: Id, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanTasks(query: TaskQuery, cursor: Cursor | undefined, limit: number, context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  submission(id: Id, context: Context): Promise<SubmissionRecord | undefined>;
  submissionByRequest(conversationId: Id, requestId: string, context: Context): Promise<SubmissionRecord | undefined>;

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

`document(id, at)` materializes one specific incarnation and never follows a
replacement at the same logical address. Callers resolve an address with
`findDocument()` when they do not already hold an incarnation ID. It selects the
newest applicable base, applies its ordered Chord delta tail, and returns the detached materialized value plus stored
definition version. Base/delta records are backend-private. The lookup never
scans unrelated documents. An unknown ID returns `undefined`. At `"current"`, a
retired incarnation returns `undefined`. A numeric lookup of a rewindable
conversation incarnation returns `undefined` outside its half-open lifetime and
reconstructs the selected value inside it. A numeric lookup of a known current-
only incarnation rejects rather than depending on reclaimed content. Metadata
membership remains queryable historically. A missing required base, a version
change inside a delta tail, or an operation that cannot be applied inside an
addressable lifetime is storage corruption, not absence.

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

- conversation, entry, task, and submission records;
- document records;
- indexed document bases/deltas by document and commit sequence.

Live task transitions replace one row. Terminal tasks remain as small records.
Document reads use indexed base-plus-tail ranges. The first implementation stores
Chord records directly; it does not translate generic operations to SQLite JSON
functions.

Schema shape, WAL checkpoint cadence, and synchronous defaults are backend
implementation choices validated by conformance, reopen, query-plan, and storage
benchmarks.

### 11.3 JSONL

JSONL depends on the portable `FileSystem` capability, not the broader
`ExecutionEnv`. It uses reclaimable sidecars without exposing them to the
harness. Persistence alone does not provide the ownership boundary: any decoded
indexes, materialized values, or caches retained in memory must be detached from
commit arguments and must not be exposed directly by reads. A JSONL backend
cannot simply add file appends around aliasing memory tables.

```text
main.jsonl       table writes, document records, and one marker per commit
doc-<id>.jsonl   one document incarnation
task-<id>.jsonl  live task replacements
```

Publication protocol:

1. Append complete prepared records to every affected sidecar.
2. Append one complete main marker listing those records.
3. Publish in memory only after the marker write succeeds.

Every commit uses this protocol; there is no standalone-sidecar fast path.
JSONL creation accepts an `fsync` option that defaults to `false`. Without
`fsync`, it guarantees ordinary process-crash consistency, not survival of
power, host, kernel, or filesystem failure. With `fsync: true`, the backend
appends all affected sidecar records, flushes each affected sidecar, and only
then appends the main marker. Ordinary publication does not explicitly flush
`main.jsonl`; an acknowledged tail commit may therefore still disappear, but a
marker that survives should not overtake its sidecar data. A main-only commit has
no sidecars to flush. Before destructive reclamation with `fsync: true`, the
backend flushes `main.jsonl` once so the authorizing marker cannot disappear
while its replacement or removal survives. If that flush fails, the committed
state remains published and reclamation is deferred. A non-empty temporary
replacement is also flushed before rename.

Recovery:

- Remove torn final lines.
- Ignore and remove unconfirmed sidecar tails.
- Apply confirmed records only.
- Missing required confirmed data is corruption and opening fails.
- A later committed latest base or retirement may prove an earlier physical
  record unnecessary.
- Any uncertain append failure poisons the open backend.

Reclamation starts only after the authorizing base/retirement commits. When no
sidecar records remain, it removes the sidecar directly. Otherwise, it writes a
temporary replacement, renames it, and invalidates cached file descriptors so
future appends cannot target an unlinked inode. Flushing `main.jsonl` to
authorize reclamation does not compact it. `main.jsonl` is not compacted in the
initial implementation.

## 12. API footguns

These are contracts, not invitations to add defensive machinery:

- **Detached draft work:** draft reads, draft writes, and all `Tx` operations
  reject after the Session callback settles. Fire-and-forget work that runs
  before callback settlement can still mutate the active transaction and is
  unsupported.
- **Read after write:** read every required table row before the first table
  write. Document drafts remain usable afterward; table reads do not.
- **Long transactions:** an async commit callback holds the Session mutation
  line. Never await models, tools, processes, network calls, humans, a nested
  Session commit, or a Session waiter inside it. Use methods on the current `Tx`.
- **Explicit creation:** only typed `tx.doc()` creates an absent document. Snapshot,
  source, and watch lookup return `undefined` instead.
- **Family initialization:** the first acquisition of an absent family address
  selects its seed. Existing instances and later calls ignore seeds; a seed is
  neither identity nor an update.
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
- **Trusted immutable revisions:** `snapshot()`, source values, watch values, and
  their descendants may share tracker-owned containers. Never mutate them; copy
  first when mutable ownership is required. Runtime freezing is not provided.
- **Watch activation:** before `start()`, `watch.value` remains the immutable
  acquisition revision. Initialize the consumer from it first. After start, the
  property advances to the newest delivered immutable revision before each
  callback; every earlier reference remains stable.
- **Coalesced watches:** slow or unstarted watches retain only their last
  delivered and newest revisions. Intermediate committed states may be omitted.
  A facet that must audit every transition must persist each fact as an immutable
  entry or in its own journal and scan that history explicitly.
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
- session-scoped rewindable documents;
- automatic checkpoint heuristic;
- automatic third-party view mounting;
- CRDT/offline multi-writer merge;
- SQL translation of arbitrary Chord operations;
- JSONL global compaction or automatic corruption repair;
- compatibility layer for removed Pico prototypes;
- in-process hot replacement of Session-side extension implementations.
