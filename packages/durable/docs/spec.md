# Pico5 specification

Pico5 is a durable, extensible agent harness. This document is normative.
Pico5 uses existing package types as follows:

```ts
import type {
  AttachedReplicatedState,
  Context,
  Draft,
  JsonRepresentation,
  JsonValue,
  ReplicatedState,
} from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type {
  AssistantMessage,
  CacheRetention,
  DeferredHandle,
  Message,
  Models,
  ModelThinkingLevel,
  TextContent,
  Tool,
  ToolCall,
  ToolReference,
  ToolResultMessage,
  Transport,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

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
- A **turn** is one assistant response and the tool calls it makes. A **run**
  is the sequence of turns from an admitted input to the final answer; turn
  boundaries (section 6) sit between its turns. A conversation is busy while a
  run is active.

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
   adoption. Commit/close observers run synchronously only to capture immutable
   state; document-state and watch user callbacks run later, off the line.
8. An uncertain storage failure is fatal to the open Session. It publishes
   nothing and must be reopened. Preparation and checkpoint failures occur before
   storage admission and roll back normally.

## 2. Core records

The concrete JSON representations may add bookkeeping fields, but must preserve
these contracts.

```ts
declare const idBrand: unique symbol;
type Id<Kind extends string, Type = unknown> = number & {
  readonly [idBrand]: {
    readonly kind: Kind;
    readonly type: Type;
  };
};
type ConversationId = Id<"conversation">;
type EntryId = Id<"entry">;
type TaskId<Result = unknown> = Id<"task", Result>;
type SubmissionId = Id<"submission">;
type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;
/** Strictly increases between commits; gaps are permitted. */
type Seq = number & { readonly [seqBrand]: "sequence" };
const ROOT_CONVERSATION_ID = 1 as ConversationId;

type ConversationOwnership =
  | { readonly kind: "ownerless" }
  | { readonly kind: "task"; readonly taskId: TaskId };

type ConversationRecord = {
  readonly id: ConversationId;
  readonly parent?: {
    readonly conversationId: ConversationId;
    readonly at: EntryId;
  };
  readonly owner?: {
    readonly conversationId: ConversationId;
    readonly taskId: TaskId;
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

In pi-ai, `content` is the base prompt on the leading message and additional
instruction text on later messages. `sections` is an ordered named patch: a
string adds or replaces a section, while `null` removes it. `toolsRemoved` is
applied before `toolsAdded` within one message. Replaying every system message
in transcript order yields the effective prompt and tool set.

Pico always writes `content: ""`. Every prompt part, including the preamble, is
a named section resolved from the conversation's agent (section 7.4).

```ts
type ContextEdit = {
  readonly target: EntryId;
} & (
  | { readonly action: "omit"; readonly messages?: never }
  | { readonly action: "replace"; readonly messages: readonly Message[] }
);

type EntryRecord = {
  readonly id: EntryId;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly model?: readonly Message[];
  readonly data?: JsonValue;
  readonly head?: EntryId;
  readonly edits?: readonly ContextEdit[];
  readonly byTaskId?: TaskId;
};

type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
  readonly head?: EntryId | "self";
};

type SubmissionRecordBase = {
  readonly id: SubmissionId;
  readonly conversationId: ConversationId;
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
          readonly entry: EntryId;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: EntryId;
          readonly answer: EntryId;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: EntryId;
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
          readonly entry: EntryId;
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

type SubmissionSettlement =
  | { readonly status: "done"; readonly answer: EntryId }
  | { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

type SubmissionCreate = SubmissionRecord extends infer Record
  ? Record extends SubmissionRecord
    ? Omit<Record, "id">
    : never
  : never;
```

ID brands are compile-time only. IDs and sequences remain ordinary numbers in
memory, JSON, JSONL, and SQLite. Code applies a brand only at a trusted creation
or decoding boundary. The distinct sequence brand prevents an entity ID from
being used as a document commit point.

Conversation history parenting and task ownership are separate:

- `parent` controls inherited entries and historical documents.
- `owner` records task attribution and connects scopes for subtree abort and idle traversal. It is not an access-control capability.
- Creation always supplies `ConversationOwnership` explicitly. The Session
  derives the persisted owner's conversation from the named task; callers never
  construct the persisted owner pair.

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
7. Move each assistant's tool results, found before the next assistant message,
   directly after it in tool-call order, ahead of any intervening user or system
   message. The provider protocol requires results to follow their call.
8. Synthesize an error result for every call without one, for example after a
   fork cut or at an interrupted tail. Drop tool results with no preceding call.
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

/** Runs inside the creating commit, after the creation hook and the `agent` change. */
type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

type ConversationCreateOptions = {
  readonly ownership: ConversationOwnership;
  /** Applied in the creating commit after the creation hook's copy, before `init`. */
  readonly agent?: AgentChange;
  readonly init?: ConversationInit;
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

type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
  readonly models: Models; // the pi-ai Models interface
  readonly registry: RegistryReader<Tool>; // section 7.1
  readonly settings?: HarnessSettings;
  /** Builds a conversation's environment. Never called on the Session line; may be async. */
  readonly env?: (
    target: { readonly conversationId: ConversationId; readonly cwd?: string; readonly read: DocumentReader },
    context: Context,
  ) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  /** Runs in every commit that creates or forks a conversation, after the built-in creation hook (below). */
  readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

/** Curated pi-ai request options; absent fields use pi-ai defaults. */
type ConversationStreamOptions = {
  transport?: Transport;
  timeoutMs?: number;
  /** Provider/SDK retries inside one request attempt. */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  headers?: Record<string, string>;
  metadata?: JsonObject;
  cacheRetention?: CacheRetention;
  deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};

/** Durable generation attempt retries; the JSON shape of pi-ai `RetryPolicy`. */
type ConversationRetryPolicy = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs?: number;
};

/** Automatic compaction thresholds (section 8.7); manual compaction ignores `enabled`. */
type CompactionPolicy = {
  /** Threshold and overflow compaction. */
  enabled: boolean;
  /** Room kept free for the answer: generation blocks to compact above `contextWindow - reserveTokens`. */
  reserveTokens: number;
  /** Approximate size of the recent context a summary keeps verbatim. */
  keepRecentTokens: number;
  /** Background compaction starts `backgroundTokens` below the blocking threshold; `0` disables it. */
  backgroundTokens: number;
};

type ToolExecutionMode = "parallel" | "sequential";

/** How many queued items of one mode a boundary selects (section 6). */
type QueueMode = "all" | "one-at-a-time";

/** Read at every resolution and never copied; getters are fine. Synchronous: some readers run on the Session line. */
type HarnessSettings = {
  /** Default extension selection; absent: every installed extension, in install order. */
  readonly extensions?: readonly Extension[];
  readonly stream?: ConversationStreamOptions;
  readonly retry?: Partial<ConversationRetryPolicy>;
  readonly compaction?: Partial<CompactionPolicy>;
  readonly toolExecution?: ToolExecutionMode;
  readonly steeringMode?: QueueMode;
  readonly followUpMode?: QueueMode;
};

/** Resolved: every field over its built-in default, object fields merged. */
type Settings = {
  readonly extensions?: readonly Extension[]; // default: every installed extension, in install order
  readonly stream: ConversationStreamOptions; // default {}
  readonly retry: ConversationRetryPolicy; // { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 }
  readonly compaction: CompactionPolicy; // { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }
  readonly toolExecution: ToolExecutionMode; // "parallel"
  readonly steeringMode: QueueMode; // "one-at-a-time"
  readonly followUpMode: QueueMode; // "one-at-a-time"
};

/** Stored choices of one conversation; names, not objects. Unset fields follow the host. */
type AgentState = {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  /** An array selects exactly these extensions, in order. An object edits the host default selection. */
  extensions?: string[] | { add?: string[]; remove?: string[] };
  /** Filters the selected extensions' tools. An array offers exactly these, in order. */
  tools?: string[] | { remove: string[] };
  /** Rendered after every extension section, as the section `instructions`. */
  instructions?: string;
  /** Directory within the environment's file system, passed to `HarnessOptions.env`. */
  cwd?: string;
};

/** Built-in rewindable agent document; see below. */
declare const AgentDoc: RewindableConversationDocToken<AgentState>;

/** Objects are handles for their names. */
type AgentChange = {
  readonly model?: ModelRef | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  readonly extensions?:
    | readonly Extension[]
    | { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
    | null;
  readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
  readonly instructions?: string | null;
  readonly cwd?: string | null;
};

/** One change in any commit. A given field replaces the stored one; `null` clears it; `undefined` changes nothing. */
function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void>;

/** A conversation's agent resolved against a registry snapshot and the settings (section 7.1). */
type Agent<Tool extends ToolRegistration = ToolRegistration> = {
  readonly model?: ModelRef;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly extensions: readonly Extension<Tool>[];
  readonly tools: readonly Tool[];
  /** Extension sections, then `instructions` when set. */
  readonly sections: readonly PromptSection<Tool>[];
  readonly instructions?: string;
  readonly cwd?: string;
};

/** Entry whose `data` has type `D`; `never` means the kind carries no data. */
type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D });

type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D });

interface Entry<D extends JsonValue = never> {
  readonly kind: string;
  is(entry: EntryRecord | undefined): entry is TypedEntry<D>;
}

function defineEntry<D extends JsonValue = never>(kind: string): Entry<D>;

type ContextView = {
  readonly head: EntryRecord | undefined;
  readonly entries: readonly EntryRecord[];
  /** Per entry of `entries`, its model messages after edits and rule 9, before rules 7 and 8. */
  readonly contributions: readonly (readonly Message[])[];
  readonly messages: readonly Message[];
};

type SettledSubmissionRecord = SubmissionRecord & {
  readonly status: "done" | "unanswered";
};

interface Submission {
  readonly id: SubmissionId;
  status(context: Context): Promise<SubmissionRecord>;
  wait(context: Context): Promise<SettledSubmissionRecord>;
  abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
  readonly state: Extract<TaskState<JsonValue, R>, { status: "terminal" }>;
};

type TaskInspection = {
  readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
  readonly state:
    | { readonly kind: "running" }
    | { readonly kind: "ready"; readonly migrates: boolean }
    | { readonly kind: "waiting"; readonly on: readonly TaskId[] }
    /** Outcome held until its ordinary owned work drains (section 5.5). */
    | { readonly kind: "completing" }
    | {
        readonly kind: "blocked";
        readonly reason: "missing_task" | "task_too_old" | "migration_failed";
        readonly error?: unknown;
      };
};

type HarnessInspection = {
  readonly scheduling: "paused" | "running" | "closing";
  readonly tasks: readonly TaskInspection[];
  /** Queued and placed submissions in ID order. */
  readonly submissions: readonly SubmissionRecord[];
};

type ConversationWatch = WatchHandle<ConversationView>;

type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H>
  ? H
  : never;

interface Conversation {
  readonly id: ConversationId;
  submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
  /** Resolved with the current registry snapshot and settings. */
  agent(context: Context): Promise<Agent>;
  /** `configure()` in its own commit. */
  configure(change: AgentChange, context: Context): Promise<void>;

  commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    context: Context,
  ): Promise<T>;
  context(context: Context): Promise<ContextView>;
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
  fork(
    at: EntryId,
    options: ConversationCreateOptions,
    context: Context,
  ): Promise<Conversation>;
  compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;
  reset(handoff: string | undefined, context: Context): Promise<void>;
  /** `{ background: true }` also aborts background work under the conversation (section 5.4). */
  abort(context: Context, options?: { readonly background?: boolean }): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
  viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
  watch(context: Context): Promise<ConversationWatch>;
}

interface Harness extends Session {
  resume(): void;

  root(
    context: Context,
    options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
  ): Promise<Conversation>;
  conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
  createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  inspect(context: Context): Promise<HarnessInspection>;
  submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
  abortSubmission(
    id: SubmissionId,
    context: Context,
    conversationId?: ConversationId,
  ): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
  abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  waitForIdle(context: Context): Promise<void>;
  /** Session total of every conversation's `pi.usage` (section 8.6). */
  usage(context: Context): Promise<UsageState>;
  /** Live tasks as a structural view (section 9.5). */
  taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
  watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}

declare const Harness: {
  open<Tool extends ToolRegistration>(
    storage: Storage,
    options: HarnessOptions<Tool>,
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

`Harness.open()` binds the Session to one application-owned registry (section
7.1). `createRegistry()` always holds the built-in task definitions (section 8),
and open rejects a registry whose snapshot lacks any of them.
Open changes surviving `running` tasks to `pending`, keeps `waiting` tasks
waiting, and re-evaluates finalization and `failFast` for `completing` and
`waiting` tasks (section 5.5). It never migrates or terminalizes a task because
its definition is missing or unmigratable. Such a task stays `pending` or `waiting` and is **blocked**: the
scheduler skips it and reconsiders it whenever the registry changes (section
5.4). Any built-in document touched by recovery migrates through its ordinary
typed access path. Open does not scan or migrate other documents. No handler
dispatches during open. Applications should install their extensions before
open so recovered work can resume immediately; an install after open also
unblocks it.

The root conversation always has reserved ID `ROOT_CONVERSATION_ID` (`1`).
`root(context, { agent, init })` creates it lazily: when the root is absent, one
commit on the Session line creates the ownerless root, runs the creation hook
(below), applies `agent` with `configure()`, and runs `init(tx, rootId)`. When
the root already exists, `agent` and `init` are ignored and no write occurs.
Reopen finds the same root by its reserved ID. A conversation whose agent has no
model produces a durable `no_model` generation failure.

`resume()` is idempotent while running and only enables scheduling. It does not
repeat open-time reconciliation, and it throws after close. Work that must happen
before any task runs, such as installing extensions or seeding, happens before
`resume()`. Calls that ask for progress also enable scheduling, so they never
wait on a paused Harness: `Conversation.submit()`, `Conversation.compact()`,
`Conversation.abort()`, `Submission.wait()`, `Harness.waitForTask()`,
`Harness.waitForIdle()`, and `Conversation.waitForIdle()`. Recovered work starts
with them. A viewer that only reads never enables scheduling: `inspect()`,
`getTask()`, `submission()`, `Submission.status()`, `usage()`, document reads,
every conversation read, state, and watch, and the task graph.

`createConversation({ ownership, agent, init })` and
`fork(at, { ownership, agent, init })` commit atomically: the conversation, its
explicitly selected ownership, the creation hook's documents, the `agent`
change, and every write made by `init`.
A first input is an ordinary `submit()` afterward. A request ID makes a retried
`submit()` to the same conversation exactly-once; a host that must survive a
crash between the two calls first finds its conversation again, for example
through a key written by `init`. Host callers must choose ownerless or task
ownership; neither the Harness nor a conversation handle infers ownership from
call context.

Every Harness commit that creates or forks a conversation runs the built-in
creation hook in the same commit, whether through the conveniences or through
raw `tx.createConversation()` and `tx.forkConversation()`, for example inside a
tool commit. It runs inside `tx.createConversation()` and
`tx.forkConversation()`, before they return, so a `configure()` later in the
same callback overrides its copy. It creates empty `pi.live`, `pi.inbox`, and
`pi.usage`, creates `pi.provider` with a fresh provider-facing UUIDv7, and handles
`pi.agent`:

- A fork keeps the `asOf` copy of its parent's `pi.agent` (section 3.7),
  whatever its ownership.
- A new task-owned conversation gets a copy of the stored `pi.agent` of the
  owner task's conversation, every field, `instructions` included. A later
  change to the owner does not reach the child. Fields the owner leaves unset
  stay unset and follow the host.
- A new ownerless conversation gets an empty `pi.agent`, `{}`.

`HarnessOptions.conversationCreated`, if given, then runs in the same commit
with the new record, for every creation path, so the host can create the
documents its application needs in every conversation; the record's `parent`
and `owner` tell forks and task-owned conversations apart. Table reads throw
`ReadAfterWrite` there, as in `init`, and a throw fails the creating commit.
The conveniences then apply their `agent` change and run `init`. Extensions
have no creation hook, so their hooks and sections treat an absent document of
their own as its default. A conversation created by a plain Session has no
built-in documents.

```ts
// In a tool's commit. The child starts as a copy of this conversation's agent: model, extensions, tools, cwd.
const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
// A cheaper model, only the read tool, and its own worktree; everything else stays as copied.
await configure(tx, child.id, { model: haiku, tools: [readTool], cwd: worktree });
```

`init` runs after the conversation creation, which is a table write, so table
reads inside it throw `ReadAfterWrite` (section 4). Document access remains
available.

The built-in agent document is final at version 1:

| field | value |
|---|---|
| kind | `pi.agent` |
| version | `1` (no migration) |
| scope/history/fork | conversation, `rewindable`, `asOf` |
| schema | `AgentState` |
| `initial()` | `{}` |
| checkpoint | complete base on every change |
| view mount | `docs["pi.agent"]` |

It stores only what someone chose for the conversation: extension and tool
names, never code, and no prompt text other than `instructions`. Code comes
from the registry by name when the agent is resolved (section 7.1).
`configure(tx, id, change)` edits it in any commit, including the one that
creates or forks the conversation; `Conversation.configure()` does so in its own
commit. `Conversation.agent()` resolves it with the current registry snapshot
and settings, reading an absent document as `{}`; it never writes.

`configure()` replaces whole fields: a given field replaces the stored one,
`null` clears it, and `undefined` leaves it. Extension and tool objects stand
for their names, so an old object of an extension that was installed again
still selects it.

```ts
await root.configure({ tools: { remove: [editTool] } }, context);
await root.configure({ tools: { remove: [bashTool] } }, context); // edit is offered again
await root.configure({ tools: null }, context); // every tool of the selected extensions again
```

A UI toggle therefore reads the current value and writes the new one. An
`extensions` object `{ add, remove }` always edits the host default selection
(section 7.1), never a copied selection, whether that is an array or an
`{ add, remove }` object; to edit a copied selection, write an array computed
from the resolved agent's `extensions`.

Nothing checks that a stored extension or tool name is installed. The document
records choices; the registry records what this process can execute now. A
stored name may therefore be uninstalled, for example during extension reload,
after restart before installation, or in a fork opened by a process that lacks
an extension. Resolution skips it, the document is never rewritten because of
registry movement, and the name takes effect again when it is installed again.

A change neither starts generation nor appends a system entry. Request
preparation later compares the desired prompt and tools with transcript history
and appends the required positional system baseline or delta (section 7.4).

The built-in provider document is final at version 1:

| field | value |
|---|---|
| kind | `pi.provider` |
| version | `1` (no migration) |
| scope/history/fork | conversation, `latest`, `initial` |
| schema | `{ sessionId: string }` |
| `initial()` | `{ sessionId: uuidv7() }` |
| checkpoint | complete base on every change |
| view mount | `docs["pi.provider"]` |

The UUID is a provider-facing conversation identity, not the numeric Durable
`ConversationId` and not an enclosing application's Session ID. Every new,
task-owned, raw-created, and forked conversation receives its own UUID in its
creating commit; a fork never copies its parent's UUID. Generation requests and
compaction summarization pass it to pi-ai as `options.sessionId`. Reset,
compaction, model changes, and reopen do not change it. A legacy conversation without the document creates and persists it
on the Session line before its first generation or compaction provider request.
Concurrent callers therefore observe one winner. Provider behavior still
applies: for example, Codex suppresses cache/session identity when
`cacheRetention` is `"none"`.

A missing tool implementation never fails a request. Request preparation offers
only the agent's resolved tools. If the replayed tool state still offers a tool
that no longer resolves, the appended system delta lists it in `toolsRemoved`;
when it resolves again, a later delta adds its current declaration. When the
model calls a tool that its request did not offer, or whose implementation does
not resolve when its tool task runs (section 7.3), an error tool result with
an error diagnostic with code `tool_unavailable` (section 7.3) states that the tool is not available,
and the run continues so the model can react (section 8.3).

`HarnessOptions.settings` holds Harness-wide run policy: the default extension
selection, request options, retry, compaction thresholds, tool execution, and
queue modes. Nothing copies or stores it. Every reader resolves it anew into
`Settings`, each absent field over its built-in default and object fields merged
key by key, and uses that value for one decision (section 7.1 lists the
readers). A settings object with getters therefore follows the user's
preferences without a Session write. Settings are synchronous because queue
modes are read on the Session line. `stream` is forwarded to generation
requests; `stream.maxRetries` are provider retries inside one request, while
`retry` governs durable generation attempts (section 8.3). Settings changes make
no commit and emit no event.

```ts
// The user's settings, read live through getters.
class UserSettings implements HarnessSettings {
  readonly manager: SettingsManager;
  constructor(manager: SettingsManager) {
    this.manager = manager;
  }
  get stream() {
    return { timeoutMs: this.manager.get("timeoutMs") };
  }
  get compaction() {
    return { enabled: this.manager.get("autoCompact") };
  }
}
manager.set("autoCompact", false); // no Session write; every conversation follows at its next threshold check
```

`HarnessOptions.env` builds a conversation's execution environment from its ID,
its agent's `cwd`, and a `DocumentReader` for committed documents. The Harness
never calls it on the Session line and calls it at each use:

- The tool task calls it for each execution and passes the result as `api.env`
  (section 7.3). A rerun after recovery gets the conversation's environment at
  that time, including its current `cwd`. A throw becomes an ordinary error
  result of the call.
- Generation `prepare` calls it once for the section renderers (`input.env`,
  section 7.4). A throw is reported, and the sections render with
  `env: undefined`.
- `runtime.env(context)` calls it for custom tasks and rejects with its error.

Without an `env` option, or when it returns `undefined`, there is no
environment. The host caches what is expensive, such as one environment per
directory. Extensions read the built environment, such as `env.cwd`, never a
descriptor. An application that needs more than a directory per conversation
keeps that in its own document and reads it through `target.read`:

```ts
// Absent: the conversation runs locally. Only conversations with this document run in a container.
// Subagents do not copy it: their creator writes it too when they should run in the container.
const ContainerDoc = defineDoc<{ image: string }>({
  kind: "app.container", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ image: "node:22" }),
});
const harness = await Harness.open(storage, {
  models,
  registry,
  env: async ({ conversationId, cwd, read }, context) => {
    const container = await read.snapshot(ContainerDoc, conversationId, context);
    return container !== undefined
      ? containers.env(container.image, cwd ?? "/work", context)
      : localEnv(cwd ?? process.cwd()); // cached NodeExecutionEnv per directory
  },
}, context);
```

Agent and settings changes take effect when their readers resolve them (section
7.1). Generation preparation resolves the agent once per request and fixes that
turn's prompt, offered tools, model, and request options. A change made while
the turn runs applies at the next preparation. A tool the model already called
is resolved when its tool task runs; when its name is no longer among the
agent's tools, because the filter, the selection, or the registry changed, the
call produces `tool_unavailable` (section 7.3). The retry
policy is read when generation classifies an attempt's result, because it
governs the next attempt (section 8.3).

A `Conversation.commit()` is a Session commit bound to that conversation.
`tx.createTask()` defaults `TaskOptions.conversationId` to the bound conversation.
`Conversation.entries()` binds the query to that conversation and paginates its
fork-aware stored history; callers cannot substitute another conversation ID.
Generic Session-wide document operations remain available directly on `Harness`
because `Harness extends Session`.

`fork()` requires a concrete visible parent entry and explicit ownership, then
applies section 3.7.
`compact()` admits a manual compaction task in one commit and returns its ID,
not its future summary entry. The task is conversation-owned and not background,
so `Conversation.abort()` cancels it and idle waits include it. It does not take
run control, so it does not make the conversation busy: the conversation keeps
working while it summarizes, and its summary is placed through a write
submission, at once when idle, otherwise at the next boundary (section 8.7). `reset()` durably admits a write submission of a
`pi.reset` entry (section 8.1) with `head: "self"`, carrying the handoff text as
a user message when given, and then resolves; while busy, placement follows
section 6 and may occur later. Observe its placement through the conversation
watch. An idle wait does not guarantee placement of queued passive writes.

`abortTask()` commits `abortRequested`, then signals and joins the active run;
the scheduler then starts the abort invocation and marks the foreground-owned
subtree in its next reconcile commit (section 5.4). `Conversation.abort()` withdraws queued
input submissions, marks non-background tasks selected by ordinary ownership
traversal, signals them, and resolves only after that scope is ordinarily idle.
Passive writes and background subtrees survive. Conversation idle means no live
non-background task selected from that conversation. Harness idle applies the
same traversal from every ownerless conversation root. Waiting,
deadline-blocked, and `completing` work is still live and therefore not idle. Cancelling an idle
wait aborts only that waiter.

Conversation handles are stateless; compare them by `id`. Hosts discover
conversations through lookups and scans. There is no creation listener; the task
graph view (section 9.5), `inspect()`, and the idle waits report live work.

`submit()` returns after durable admission, not settlement. An input submission
creates a user message with the Harness clock's timestamp at placement, which is
admission when it is placed at once; `whenBusy` defaults to
`followUp`. A write submission uses the ordered passive path in section 6 and
never starts generation. `Submission.wait()` settles an input only after its
answer or terminal failure; it settles a write when the entry is placed or the
write becomes terminally unplaceable. Cancelling `wait()` only cancels that wait.
It does not withdraw the submission; `Submission.abort()` is the explicit queued
withdrawal operation. `Harness.submission()` reacquires a submission after
reopen; records remain queryable after settlement.

`abortTask()` durably requests cancellation and returns `marked` after the mark
is committed and any active run invocation has joined, or after a blocked task
without live ordinary owned work has been settled as `orphaned` (section 5.4).
The abort invocation starts once the task's ordinary owned work is no longer
live; a `completing` task is only marked, and its final record keeps its held
outcome with `abortRequested: true` (section 5.5). It does not await terminal
settlement. `waitForTask()` observes
the terminal receipt. Aborting an already terminal task returns `terminal`; an
unknown ID rejects. Explicit task abort includes a background task. Cancelling a
task or idle wait does not abort work.

`inspect()` returns live work at one point on the Session line, for recovery
decisions after open, viewers, and diagnostics. It writes nothing, does not
enable scheduling, and runs no task code. Each live task carries its state
under the current registry: `running` with an active invocation; `completing`
for a held outcome; `waiting` with the live tasks it still waits for, the live
part of its `on`, or, when abort-marked, its live ordinary owned work (section
5.5); `ready` when the next scheduling pass would reserve it, with `migrates`
when its definition is newer and has `migrate`; or `blocked` (section 5.4). A migration shows as failed only after the scheduler
tried it, or when the newer definition has no `migrate`; inspection never runs
one to find out. Blocked reasons are derived, never stored. Queued and placed
submissions complete the view. Finished
tasks, settled submissions, transcripts, and documents use their own APIs.

`Conversation.viewState()` returns its current structural mount as a disposable
read-only Chord state. `Conversation.watch()` atomically captures that immutable
revision and registers for later exact complete-commit frames. Its `WatchHandle`
uses the same serialized asynchronous, bounded-buffer contract as `watchDoc()`
in section 9.2. Neither carries semantic events or owns a second persistence
authority.

`close()` seals mutation admission and task reservation, signals invocations,
and ends every document state, view state, and watch at that seal: a commit
that settles during close publishes nothing to them, and a state keeps its last
value. Outside the Session line it lets already-admitted storage commits settle,
joins task, tool, and hook invocations, including code that ignores its signal,
then closes Storage. Once `close()` resolves, no invocation code of this Harness
runs and no handler holds Storage, so a new Harness may open the same Storage.
Already-running watch callbacks remain caller-owned and may finish
independently. Close writes no task outcome. Cancelling a `close()` call cancels
only that wait; shutdown continues, and every later `close()` awaits the same
shutdown.

Handles belong to that open Harness and must be reacquired after reopen. Once
close begins, every new Harness, conversation, and submission operation rejects,
and `resume()` throws. Of the operations already queued on the Session line at
the seal, commits settle (section 4) and reads complete. Waits, states, and
watches reject, except two that need no later commit: `Submission.wait()` of an
already settled submission resolves, and an acquisition of an absent document
resolves `undefined`. An `inspect()` among them reports `scheduling: "closing"`.

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

type CheckpointInfo = {
  /** Deltas already stored after the newest base, excluding this change. */
  readonly deltasSinceBase: number;
};

type CommonDocDefinition<T extends JsonObject> = {
  readonly kind: string;
  readonly version: number;
  initial(): T;
  migrate?(value: JsonObject, fromVersion: number): T;
  checkpointWhen?(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
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
  readonly id: DocumentId;      // unique incarnation
  readonly kind: string;        // stable definition kind
  readonly key?: string;        // families only
  readonly createdAt: Seq;      // stamped by the committing storage
  readonly retiredAt?: Seq;
} & (
  | { readonly scope: { readonly kind: "session" } }
  | ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
      | { readonly history: "latest"; readonly fork: "current" | "initial" }
      | {
          readonly history: "rewindable";
          readonly fork: "asOf" | "current" | "initial";
        }
    ))
  | { readonly scope: { readonly kind: "task"; readonly taskId: TaskId } }
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
  subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void;
  subscribeClose(listener: () => void): () => void;

  snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<Readonly<T> | undefined>;

  snapshotAsOf<T extends JsonObject>(token: RewindableConversationDocToken<T>, conversationId: ConversationId, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;
  snapshotAsOf<T extends JsonObject, I extends JsonValue>(token: RewindableConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;

  documentState<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
}

interface Tx {
  conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
  entry(id: EntryId): Promise<EntryRecord | undefined>;
  /** Undefined when the entry is absent or has another kind. */
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
  task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor): Promise<Page<ConversationRecord, Cursor>>;
  scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
  scanTasks(query: TaskQuery, limit: number, cursor?: Cursor): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
  submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined>;

  createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ): Promise<ConversationRecord>;
  appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
  /** The token supplies `kind` and types `data`. */
  appendEntry<D extends JsonValue>(
    token: Entry<D>, conversationId: ConversationId, value: TypedEntryDraft<D>,
  ): Promise<TypedEntry<D>>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>, input: I, options: TaskOptions,
  ): Promise<TaskId<R>>;
  /** Raw submission record; no admission rules (busy check, inbox, placement). Hosts use `Conversation.submit()`. */
  createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
  /** Settle a queued or placed submission; only a placed input can be answered. A settled one stays unchanged. */
  settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
  /** Newest visible entry of the conversation that carries a `head`. */
  latestHeadMarker(conversationId: ConversationId): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
  /** Record a queued submission's placement at `entry`: an input becomes `placed`, a write `done` (section 6). The caller appends the entry and edits `pi.inbox` and `pi.live`. */
  placeSubmission(id: SubmissionId, entry: EntryId): void;

  doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, seed: I): Promise<Draft<T>>;

  retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
  retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
  retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string): Promise<void>;
}
```

ID-creating transaction methods are asynchronous because remote storage may
allocate globally unique numeric IDs durably. Conversation creation always
requires explicit ownership; no transaction wrapper injects the executing task.
For task ownership, the caller supplies only a typed task ID. The Session derives
the persisted owner conversation from the task's final candidate record.

An owner task may be committed or staged earlier in the same transaction. Before
Storage admission, the Session rejects a missing, `completing`, terminal, or
abort-marked owner of a new task or conversation, judged on the owner's final
candidate record in that transaction. A task therefore cannot create owned work
in the commit that finishes it. A child task whose explicit `conversationId`
differs from its owner's conversation, and a child task with `background: true`,
reject the same way. Existing owner edges remain valid when their owners finish
afterward. Conversation
creation returns an inert record, never an operational handle.
`forkConversation()` additionally validates one visible entry and applies section
3.7. Only public typed `tx.doc()` is get-or-create. Internal fork copying may create
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
- `snapshot()`, `snapshotAsOf()`, `documentState()`, and `watchDoc()` never create
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
- `documentState()` returns a disposable read-only Chord state bound to one committed incarnation.
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
  Storage.commit persists the atomic batch while the Session line remains held
storage succeeds
  adopt every prepared change by pointer swap and enqueue immutable revision/ops publication
  commit listeners, including conversation view mounts (section 9.3), capture it synchronously
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

Preparation, validation, or checkpoint failure occurs before Storage admission
and rolls back normally. The Session performs no
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
let escaped: Draft<LiveState> | undefined;
await session.commit(async tx => {
  escaped = await tx.doc(LiveDoc, conversationId);
}, context);
escaped!.generation = undefined; // throws: the draft was revoked
```

Fire-and-forget work that mutates a draft before the owner callback settles may
silently enter that transaction and is unsupported.

### 3.5 Bases and checkpoints

Creation always stores a complete base.

For an ordinary later mutation, the definition alone decides whether the
storage record is a base:

```ts
const useBase = definition.checkpointWhen?.(candidateValue, ops, { deltasSinceBase }) ?? false;
```

The Session evaluates this predicate exactly once after tracker preparation.
`deltasSinceBase` counts the deltas already stored after the incarnation's newest
base, excluding the change being evaluated. Storage reports it when it
materializes the current value; the Session advances it after each adopted write
and resets it after every base, so evaluation performs no Storage read.
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

A definition can bound replay directly:

```ts
checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31
```

A high-churn live document can checkpoint when it becomes empty:

```ts
checkpointWhen: (value, _ops) =>
  value.generation === undefined &&
  value.tools === undefined
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
access-driven: `tx.doc()`, `snapshot()`, `snapshotAsOf()`, `documentState()`, and
`watchDoc()` reconstruct and migrate through the token supplied to that call.
Harness open does not sweep ordinary documents.

- Read-only access migrates only in memory and never writes. It may cache a
  tracker over that migrated immutable revision together with the older stored
  version marker; the next successful `tx.doc()` access still writes the required
  current-version base. A cached tracker serves only tokens of the version its value was
  materialized for. Access with any other version, such as a token from reloaded
  extension code, drops it and reloads the stored value, so each token migrates
  from the stored version or rejects a newer one. Migration always starts from a detached stored value.
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
| `fork: "current"` | committed parent value selected when the fork commit runs |
| `fork: "initial"` | no copied instance; initializer on first child access |

`current` and `asOf` copy logically present conversation singleton and family
instances, preserving unknown definitions and their stored versions. Copied
values become independent child instances with new IDs and initial bases.
`initial` copies no instance; first access in the child creates it from the
supplied definition. Task documents and tasks are never copied. Session documents
remain shared and are not rewindable.

Fork copying reads committed stored values rather than typed tracker caches. A
transaction that creates a fork therefore rejects if it also writes one of the
parent's `fork: "current"` documents; commit the parent change first so the fork
has one unambiguous stored source revision.

Forks stage backend-side `document.copy` commands carrying the child create
record and an exact source incarnation/point. Storage materializes each source
and persists its stored value/version as the child's independent initial base;
remote Storage performs this server-side. Every copy reads committed pre-batch
source state independent of write-array order. A selected source may not be
created, changed, or retired in the same batch. Copying remains atomic with the
conversation, overrides, registry writes, and other mutations.

An unaccessed copy retains only its descriptor in Session memory. Typed access
inside the creating transaction lazily reads the detached source, migrates when
required, and replaces the copy with one ordinary child create containing the
final prepared value. Definition-free copies publish explicit `document.copy`
metadata rather than a value. That metadata announces Storage-backed initial
state and is never interpreted as a document value. Document states, watches,
and mounted views hydrate by capturing their baseline and subscription
atomically on the Session line: a later commit already present becomes the
baseline, while one committed after registration is delivered. Publications
and watches are convergence mechanisms, not audit streams. A mounted aggregate
must acquire all of its document baselines and commit subscription in one
Session-line operation so it never exposes a mixture from one commit.

## 4. Transactions and storage ownership

A Session commit callback may be asynchronous. It owns the Session mutation
line through callback execution, preparation, storage settlement, committed
baseline adoption, and publication enqueue. Commit observers run on the
line; document-state and watch user callbacks run later.
External model, process, tool, network, and human effects run outside it.
`subscribeCommits()` observes complete immutable publications synchronously on
the line after adoption. `subscribeClose()` observes close synchronously when it
begins, after admission is sealed; the Harness stops watches and signals task
invocations there. Both return idempotent disposers; their listeners must not
throw, block, or call Session APIs. Document-state subscribers and watch
listeners still run later, off the line.

```ts
await session.commit(async tx => {
  const conversation = await tx.conversation(conversationId); // table read
  const live = await tx.doc(LiveDoc, conversationId);

  await tx.appendEntry(conversationId, message);     // first table write
  delete live.generation;                            // document mutation remains valid
  await tx.createTask(Follow, {}, { ownership: { kind: "conversation" }, conversationId }); // further table writes are fine
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

type JoinPolicy = "failFast" | "allSettled";

type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S }
  | { readonly status: "running"; readonly checkpoint: S }
  /** Parked without an invocation until every task in `on` is terminal; then resumes at `checkpoint` (section 5.5). */
  | {
      readonly status: "waiting";
      readonly checkpoint: S;
      readonly on: readonly TaskId[];
      readonly policy: JoinPolicy;
    }
  /** Outcome decided; terminal once no ordinary owned work below is live (section 5.5). Runs no more code. */
  | { readonly status: "completing"; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };

/** Who owns a task: its conversation (a top-level task) or another task of the same conversation. */
type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };

type TaskRecord<I, S, R> = {
  readonly id: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly version: number;
  readonly input: I;
  /** Owning task; absent for a task its conversation owns. Immutable. */
  readonly owner?: TaskId;
  readonly background: boolean;
  readonly abortRequested: boolean;
} & (
  | {
      readonly state: Extract<TaskState<S, R>, { status: "pending" | "running" | "waiting" }>;
      readonly memos?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly state: Extract<TaskState<S, R>, { status: "completing" | "terminal" }>;
      readonly memos?: never;
    }
);

type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
  readonly state: Extract<TaskState<S, R>, { status: "running" }>;
};

/**
 * State a task commits for itself: a replacement checkpoint, a wait, or its outcome. A returned `terminal` state
 * becomes `completing` while ordinary owned work below is live (section 5.5).
 */
type NextTaskState<S, R> = Extract<TaskState<S, R>, { status: "running" | "waiting" | "terminal" }>;

interface HookRunner<H extends object> {
  each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
}

type PhaseHandler<I, P, S, R, H extends object> = (
  task: RunningTask<I, P, R>,
  runtime: TaskRuntime<I, S, R, H>,
  context: Context,
) => Promise<void>;

interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
  readonly taskId: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly signal: AbortSignal;
  /** Registry snapshot of the current phase; refreshed at every phase boundary. */
  readonly registry: RegistrySnapshot;
  /** The task's conversation's agent, resolved once for this phase (section 7.1). */
  agent(context: Context): Promise<Agent>;
  /** `HarnessOptions.settings`, resolved at each access. */
  readonly settings: Settings;
  readonly models: Models;
  readonly hooks: HookRunner<H>;
  /** Calls `HarnessOptions.env` for the task's conversation; rejects with its error. */
  env(context: Context): Promise<ExecutionEnv | undefined>;

  commit(
    change: (
      tx: Tx,
      current: RunningTask<I, S, R>,
    ) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
    context: Context,
  ): Promise<void>;

  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  /** Committed task record. */
  getTask<T>(id: TaskId<T>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
  /** Terminal receipt; rejects when the invocation ends. */
  waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
  /** Outcomes of terminal tasks, in order; rejects when one is not terminal. Used after a wait (section 5.5). */
  outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
  /** Committed entry visible from the task's conversation. */
  entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
  /** Committed raw active transcript and model context, optionally cut off at `at`. */
  context(conversationId: ConversationId, context: Context, at?: EntryId): Promise<ContextView>;
  /** The Harness clock. */
  now(): number;
  /** Forward a non-fatal failure to `HarnessOptions.onReport`. */
  report(error: unknown): void;
  sleep(until: number, context: Context): Promise<void>;
}

type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
  readonly name: string;
  readonly version: number;
  initial(input: I): S;
  readonly phases: {
    [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
  };
  abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): {
    input: I;
    checkpoint: S;
  };
  readonly hooks?: H;
};

interface Task<I, S extends { phase: string }, R, H extends object> {
  readonly definition: TaskDefinition<I, S, R, H>;
}

type TaskOptions = {
  /** Required: a task always names its owner (section 5.5). */
  readonly ownership: TaskOwnership;
  /** Default: the owner task's conversation, or the transaction's bound conversation. */
  readonly conversationId?: ConversationId;
  /** Conversation-owned tasks only: excluded from conversation abort and idle, and from cascades. */
  readonly background?: boolean;
};

function defineTask<I, S extends { phase: string }, R, H extends object = {}>(
  definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H>;
```

`TaskId<R>` is the numeric task ID itself with an erased result-type brand. It
replaces a separate task-reference wrapper: `createTask()` returns `TaskId<R>`,
typed waits infer `R` from that ID, and result-agnostic operations accept
`TaskId<unknown>`. A task's `conversationId` is immutable after creation; a
replacement that moves an existing task to another conversation rejects before
Storage admission so persisted conversation-owner edges cannot become stale.

The phase map is exhaustive and phase-narrowed. A handler may perform several
commits around one effect, but each durable checkpoint is a full replacement.
`TaskRuntime.commit()` rereads and gates the current durable task on the Session
line before invoking its callback. It rejects when the invocation has ended, the
Harness is closing, the task is terminal, or a run invocation's task carries an
abort mark. Its `tx.createTask()` defaults to the task's conversation, and every
entry it appends records the task as `byTaskId`. When the
callback returns a state, the runtime replaces the task's state in the same
commit, so the checkpoint or outcome is atomic with the callback's entries,
documents, and child tasks and is type-checked against the task's checkpoint and
result types. Returning nothing leaves the state unchanged. A terminal or
completing state drops the memos. A `waiting` state ends the invocation even
when its checkpoint is unchanged; it rejects when `on` names a missing task, the
task itself, or a task on its owner chain, which could never finish first, and
an empty `on` resumes at the next scheduling pass. `pending` is never returned;
only reconciliation and handover write it.

`Tx` has no task replacement operation. A task changes only its own state,
through its runtime. The scheduler owns reservation, reconciliation, handover,
faults, and orphaning; `abortTask()` owns abort marks. Other code
stops a task with `abortTask()` and reads its result with `waitForTask()`.

```ts
// Intent, effect, outcome.
prepare: async (task, runtime, context) => {
  await runtime.commit(() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }), context);
},
charge: async (task, runtime, context) => {
  const receipt = await payments.charge(task.state.checkpoint.key); // idempotent by key
  await runtime.commit(async (tx, current) => {
    const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
    return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
  }, context);
},
// The abort handler decides the outcome; returning without one faults the task.
abort: async (task, runtime, context) => {
  await payments.cancel(task.state.checkpoint);
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }), context);
},
```
`memo(name, candidate)` is one gated commit; `memo(name)` reads the committed
record. `sleep(until)` compares against the Harness `now` clock and rejects when
the invocation is signalled or its context is cancelled. Watches acquired through
the runtime stop when the invocation ends. `snapshot()`/`snapshotAsOf()` read
committed documents, for example to supply `PromptInput.read` (section 7.4).
`getTask()` and `entry()` read committed records with one lookup each; `waitForTask()` waits for a terminal receipt,
for example a child task created by a tool.
`context()` captures its bounds on the Session line and derives the view from
immutable entries off the line, like `Conversation.context()`. Like every runtime
operation, these reject after the invocation ends.

Reservation durably changes `pending`, or `waiting` once it may resume, to
`running`. One invocation runs phase
handlers in sequence; checkpoint commits retain `running`. Before every phase,
including the first, the scheduler runs one step callback on the Session line.
It reads the committed task and synchronously applies the first matching rule
below to the phase that just returned. It writes any fault or handover in the
same commit, together with the Harness cleanup for a scheduler-written outcome
(section 5.4), which may await document access inside that callback. It ends
the invocation there when a rule stops it. A runtime commit the
invocation queued earlier therefore either lands before the step and counts, or
reaches the line after it and rejects. Before the first phase only rules 1–3
apply:

1. Terminal, `completing`, or `waiting`: stop.
2. Session closing: stop; preserve the checkpoint and any abort mark for reopen.
3. Run mode with a durable abort mark: end and join the run invocation; a fresh
   abort invocation starts once the task's ordinary owned work is no longer
   live (section 5.5).
4. Uncaught error: write terminal `faulted`.
5. Checkpoint changed, including progress within the same phase: refresh the
   registry snapshot and either hand over (section 5.4) or invoke the phase
   handler in the same task invocation.
6. Checkpoint unchanged: write terminal `faulted` because no durable progress
   was made.

An abort invocation runs its abort handler once. After it settles, a step
applies rules 1, 2, and 4; a handler that returns without a terminal outcome
faults the task. When Storage rejects a step's fault or handover write, the
invocation still ends; the task stays `running` and the next reservation runs it
again.

On open, running-task reconciliation changes surviving `running` tasks back to
`pending`, preserving their checkpoint and abort mark; `waiting` tasks stay
waiting, and `completing` and `waiting` tasks are re-evaluated (section 5.5). Task migration runs at
reservation, atomically with `pending` or `waiting` -> `running`. One callback handles every
supported older version. A task whose definition is missing, older than the
stored version, or fails migration stays `pending` or `waiting` and blocked until a fitting
definition is installed or the task is aborted (section 5.4).
`close()` marks the runtime closing, seals admission and reservation, signals
invocations, and ends states and watches. Outside the Session line it settles admitted
commits and joins invocations before closing storage. Already-running watch callbacks remain
caller-owned. Later runtime commits reject, and close writes no task outcome. Closing
starts no fresh phase or abort invocation. It does not set abort marks,
terminalize tasks, retire task documents, or publish document retirement. The
hosting layer withdraws services and
detaches clients before it closes the Harness, for example by disposing its Chord
facet host (see the Chord usage guide); reconnecting to a reopened Session
hydrates the last committed state and resumes recovery from its durable
checkpoints.

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

### 5.3 Terminal tasks

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

A task whose ordinary owned work is live splits this at a `completing` hold
(section 5.5, rule 4): a task-written outcome's own writes land at hold, and
items 1 and 3 and its waiters follow in the final commit.

The execution checkpoint and memos disappear from the terminal representation.
Terminal records remain queryable for waits, waiters, inspection, and reopen.
There are no free-standing task dependencies: ordering comes from a task waiting
on other tasks (section 5.5). An abort mark lets pending work reach its abort handler,
or its `orphaned` settlement when its definition is unavailable.

### 5.4 Scheduler, abort, and ownership

The scheduler serially reserves eligible tasks, then runs handlers off the
Session line. One in-memory `TaskInvocation` contains mode, abort controller,
and completion promise.

Abort protocol:

```text
commit abortRequested
signal and join active run invocation
wait until ordinary owned work is no longer live (section 5.5)
start a fresh abort invocation
abort handler commits terminal outcome
```

A run invocation may not commit after its durable abort mark appears. Every
runtime operation rejects after its owning invocation ends, even while the
Session remains open, and the invocation's signal and handler context abort when
it ends for any reason. An invocation ends only after its last handler returned,
so this cancels only detached leftovers, such as an unawaited `waitForTask()` or
a fetch started with the handler's context; they could no longer write anything. Returning from one phase handler does not end an invocation
that continues into another phase. Invocation mode is volatile and derived from
the durable mark on reopen. Cancelling one caller's `Context` only cancels
that call or wait; it does not durably abort shared work unless the invoked API
commits an abort mark.

A task may create owned conversations and owned tasks (section 5.5).
Conversations are durable scopes; tasks are the units of live work counted by
idle and marked by abort. History parents are irrelevant to ownership traversal.

Ordinary traversal starts at an explicitly addressed conversation, visits its
conversation-owned tasks, follows the tasks each non-background task owns, and
follows the conversations each non-background task owns. It follows owner edges after the
owner becomes terminal, but a background task is a boundary: ordinary traversal
skips that task and its complete owned subtree.
Direct conversation operations start inside that conversation regardless of its
owner. Directly aborting a live background task includes that task and follows
its ordinary owned subtree; nested background owners remain boundaries.
`close()` stops every invocation, foreground and background, without writing an
outcome, so the work resumes on reopen. A host that must durably cancel
everything aborts each live task that `inspect()` lists.

`Conversation.abort()` withdraws queued inputs and marks live non-background
tasks selected by ordinary traversal. With `{ background: true }` it crosses
background boundaries: it marks every live task that traversal ignoring the
background flag reaches when the operation is admitted and withdraws the queued
inputs of every conversation it reaches. It then waits until every task it
marked is terminal and the conversation is ordinarily idle; background work
created afterwards is neither marked nor awaited. `Conversation.waitForIdle()` waits until
that traversal contains no live non-background task. Harness idle performs the
same traversal from every ownerless conversation root rather than globally
counting tasks, so ordinary work below a background owner does not block it.
Explicit `waitForTask()` waits for its referenced task regardless of the task's
background flag.

An abort mark cascades idempotently to foreground-owned work. The durable
cancellation intent is a live owner's own record: its abort mark, or a held
`completing` outcome other than `completed` (section 5.5). A terminal owner never
cascades: it became terminal only after its ordinary owned work drained, so its
intent is already applied, and work later started in a conversation it owned,
for example a user interrogating a finished subagent, runs normally and is
reached by ordinary traversal from above. Queued inputs in its owned
conversations stay queued, as after a failed run (section 6). The scheduler derives the marks in a
later reconcile commit, and again at open, so a crash in between loses nothing;
work already queued on the Session line may make one more commit first. Every
live non-background task whose owner chain, walking up through owning tasks and
owning conversations, reaches a cancelled live owner, without first crossing a
background task that has no cancellation intent of its own, gets an abort mark, including work
created there after the cascade. Deriving the marks in their own commit
keeps them out of the owner's commit, which may already have written the tasks
involved. Every conversation the cascade reaches is treated like
`Conversation.abort()`: its queued input submissions become `unanswered` with
reason `aborted` and leave its inbox, while queued writes stay. The cascade starts
below the cancelled task, so that task's own conversation keeps its queue.
Held outcomes `failed`, `faulted`, `orphaned`, and `aborted` record the same
durable cancellation intent as an abort mark; `completed` does not. Conversation
records and owner edges are never retired with the task. Active invocations are
signalled after commit. A terminal receipt guarantees that the task's ordinary
owned work drained; background work below it may continue.

Every run invocation start resolves the task's definition by `TaskRecord.kind`
from the scheduler's current registry snapshot:

```text
definition missing                 -> stay pending, blocked: missing_task
stored version newer than it       -> stay pending, blocked: task_too_old
stored version older than it       -> migrate(input, checkpoint, storedVersion)
  failure                           -> stay pending, blocked: migration_failed
  success                           -> commit migrated record + running atomically
equal version                       -> commit running
```

An abort invocation resolves the definition the same way. When the definition
can take the task, its abort handler runs; otherwise the task is orphaned as
described below.

A failed migration is reported once through `onReport` and retried only after
the registry resolves a different definition object for the task's kind.

The Harness never terminalizes a task merely because registry code is missing or
incompatible, neither at open nor later. A blocked task without an abort mark
keeps its durable record unchanged, remains live, still blocks ordinary idle
waits, and is reconsidered whenever the registry changes. The blocked reason is derived
runtime state, not a persisted task status. Document migration remains
access-driven.

Aborting a blocked task cannot run its abort handler, because that code is
missing or cannot take the task. The Harness therefore settles it as terminal
`orphaned` instead of `aborted`: `aborted` means the task's own abort handler
ran and decided the outcome, while `orphaned` means no task code ran, so external
effects the task started may remain uncleaned. The orphaned `reason` is the
blocked reason (`missing_task`, `task_too_old`, or `migration_failed`). When
`abortTask()` finds no active invocation, no live ordinary owned work, and a
current snapshot that cannot take the task, the marking commit settles it
directly; otherwise the scheduler settles it when it would reserve the abort
invocation, which is after the owned work drained (section 5.5), so an orphaned
outcome never holds. Only an abort (direct, by
conversation, or by cascade) orphans a task; a missing definition alone never
does. The orphaning commit performs the cleanup the task's code cannot: affected
input submissions become unanswered with the reason, any matching active run
control is cleared, and task-scoped documents retire. The terminal task record
and unanswered submissions carry the reason; the only transcript entry written
is the conversion of a committed generation partial (below).
Faulting a run task performs the same control/submission cleanup with a
`faulted` outcome; a fault while ordinary owned work is live holds, and its
cleanup runs in the final commit (section 5.5, rule 4).

The scheduler knows nothing about runs or task kinds. The Harness, which owns
submissions, run control, and the built-in tasks, gives it one hook that the
scheduler calls in the commit that makes an outcome it wrote itself (`faulted`
and `orphaned`) terminal, which is the final commit after a hold. The hook ignores tasks whose kind is not a built-in
run, tool, or compaction kind, so it never creates `pi.live` elsewhere. It settles the run when
`pi.live.run` names the task (section 8): a committed generation partial becomes
an aborted `pi.assistant` entry, exactly as the generation abort handler converts
it, so the transcript keeps what the model produced and `pi.usage` counts its
spend (the scheduler's commit has no task scope, so the entry has no
`byTaskId`); its inputs become `unanswered` with reason `faulted` (detail: the error
message) or the blocked reason; and `run`, `generation`, and `tools` are
removed. Faults come from task bugs or malformed provider data, such as a
non-JSON value in a response, or a commit the Storage rejected without effect
(`StorageRejected`). An uncertain storage failure poisons the Session and writes
no outcome. For a `pi.tool` task it marks the task's tool slot `done`
without an entry; the run continues, and context derivation synthesizes the
missing result (section 2.1). For a `pi.compaction` task it removes the task's
compaction status (section 8.7). Outcomes a task commits for itself do their own settlement.
The Harness also supplies the per-phase agent resolution behind `runtime.hooks`
and `runtime.agent()` (section 7.1); the scheduler only passes each phase's
registry snapshot to it.

At every normal phase boundary (section 5.1, rule 5), the step refreshes the
invocation's registry snapshot. If the task definition resolved by name is a different object
than the one the invocation started with and the new definition can reserve the
task (same version, or a higher version with `migrate`), the invocation hands
over: the step commits the task back to `pending` with its checkpoint, memos,
and abort mark and ends the invocation, and the next reservation starts a fresh invocation under the new
definition, applying the reservation rules above. When the definition is missing
or cannot reserve the task, the invocation keeps running under its old
definition, reports once through `onReport` per resolved definition, and
reconsiders at its next boundary. A handler that
never settles never hands over.

### 5.5 Structured concurrency

Tasks and conversations form one ownership tree. Every task names its owner at
creation, `tx.createTask(task, input, { ownership })` with a required
`TaskOwnership`: its conversation (`{ kind: "conversation" }`, a top-level task)
or a task (`{ kind: "task", taskId }`, a child task). Every conversation is
ownerless or owned by a task (section 2.2). A child task always lives in its
owner's conversation; only owned conversations cross conversation boundaries.
Owner edges are immutable.

The **ordinary owned work** of a task `T` is every task that ordinary traversal
reaches below `T`: the tasks `T` owns, the tasks in the conversations `T` owns,
and, transitively, the same for each of those that is not background. A
background task and everything below it are excluded. A conversation-owned task
may be background; a child task may not.

Two rules follow from the tree.

**Abort flows down** (section 5.4). A live owner's cancellation intent (its abort
mark, or a held non-`completed` outcome) marks its ordinary owned work. Background
tasks are boundaries unless aborted directly or by `Conversation.abort(context,
{ background: true })`.

**Owned work does not outlive its owner's finish.** A task finishes only after
its ordinary owned work drained:

1. A terminal state a task commits, or a terminal outcome the scheduler writes
   (`faulted`, `orphaned`), while the task's ordinary owned work is live is
   stored as `{ status: "completing", outcome }` instead. The scheduler writes
   the final `terminal` record in a later commit once no ordinary owned work is
   live, evaluated after every commit, including work created after the hold.
   Whether work is live is judged on the commit's candidate records, so work the
   finishing commit itself creates, for example a task in a conversation the
   task owns, holds it. At open it re-evaluates every `completing` task.
2. A held outcome is final: no phase, runtime commit, or abort handler runs
   again, no definition is needed, the task is never reserved or migrated, and
   `abortTask()` on it only marks it and returns `marked`, which cancels the
   work below. The final record keeps the held outcome and the mark.
3. A held non-`completed` outcome is cancellation intent, so the work below is
   aborted, drains, and then the task becomes terminal. A held `completed`
   outcome waits for the work to finish normally.
4. Writes split at the hold. A task-written terminal commit lands all of its
   other writes, such as a tool's result entry and slot, at hold. Only the
   record's terminal state, task-document retirement, and task waiters are
   deferred to the final commit. A scheduler-written outcome writes only the
   record at hold; its Harness cleanup (section 5.4) runs in the final commit,
   so a faulted run task keeps `pi.live.run` until its tools drained.
5. Waiters, idle waits, inspection, and ordinary traversal see a `completing`
   task as live until its final commit.

New owned work needs a live owner: `createTask` with task ownership and
`createConversation` with task ownership reject an owner that is `completing`,
`terminal`, or abort-marked in the commit's final candidate (section 3.3).
Conversations stay usable after their owner finished: new runs
started there, for example to interrogate a finished subagent, are ordinary work
of that conversation, reached by traversal from above, and not part of any
finish.

**Waiting.** A phase may commit `{ status: "waiting", checkpoint, on, policy }`.
The task stops without an invocation and resumes at `checkpoint` once every task
in `on` is terminal. `on` may name any tasks, including already terminal ones;
tasks the waiting task does not own, whose `owner` is not the waiting task,
require `policy: "allSettled"`. `on` may not name a missing task, the task
itself, or a task on its owner chain (section 5.1). With `failFast`, the first
task in `on` that holds or ends with a non-`completed` outcome gives every other
live task in `on` an abort mark, in the scheduler's next reconcile commit. The waiting task itself is not marked:
it resumes once all of `on` is terminal and reads their outcomes with
`runtime.outcomes()`. A task may create children and keep running phases before
it waits, and may wait on any subset of its children in sequence.

**Abort order is bottom-up.** An abort invocation of a task starts only once its
ordinary owned work is no longer live, so an abort handler sees final outcomes
below it. An abort mark on a waiting task lets it leave the wait early for its
abort handler under this same rule; tasks in its `on` that it does not own are
not awaited. Ordering is judged on committed records: code a child runs after
its terminal commit is not ordered. An abort handler may not return `waiting`
and cannot create owned children, because its task is abort-marked (section
3.3): it compensates inline, or creates background conversation-owned tasks,
which no cascade reaches, and waits for them with `runtime.waitForTask()`,
which holds its invocation.

The cascade of the example `Checkout` task, which waits `failFast` on four
`Payment` children: an expired card fails its payment; the three live payments
get abort marks and refund in their own abort handlers; once all four are
terminal, `Checkout` resumes, reads `[aborted, failed, aborted, aborted]`
through `outcomes()`, and decides its own outcome. `abortTask(Checkout)` instead
marks `Checkout`, the cascade marks the live payments, their abort handlers run
first, then `Checkout.abort` runs and sees their final outcomes.

## 6. Submissions and inbox

Submission records back awaitable host objects. Admission is Harness-internal;
boundaries place queued submissions with `tx.placeSubmission()`, and run tasks
settle the inputs they answer with `tx.settleSubmission()`. Queued submissions
wait in the built-in inbox document, an ordered list of tagged items:

```ts
type InboxItem =
  | { readonly id: SubmissionId; readonly mode: "steer" | "followUp"; readonly content: UserInput }
  /** `entry` is the write's `EntryDraft`, stored as plain JSON. */
  | { readonly id: SubmissionId; readonly mode: "write"; readonly entry: JsonObject };

type InboxState = { items: InboxItem[] };
```

| field | value |
|---|---|
| kind | `pi.inbox` |
| version | `1` |
| scope/history/fork | conversation, `latest`, `initial` |
| `initial()` | `{ items: [] }` |
| checkpoint | complete base whenever `items` is empty |
| view mount | `docs["pi.inbox"]` |
| created | with every Harness conversation (section 2.2) |

Items are in ID order. A queued input stores its content; its `pi.user` entry
gets the Harness clock's timestamp at placement. Queued submissions belong to
their conversation, so a fork starts with an empty inbox.

Run control lives in the built-in live document `pi.live` (section 8). Its
optional `run` value names the task currently responsible for the run and its
placed input-submission IDs. `run !== undefined` defines `busy`; get-or-create
of the idle document does not. The value remains while generation, tools, and
tools hand work to one another: `taskId` names the generation that settles the
inputs, including while its tool round runs, then the next
generation. Tool tasks never own the run; the current round's tool tasks are
listed in `pi.live.tools`. The ID list is mutable state because a
boundary adds placed steering inputs to an active run; every terminal path
settles exactly the listed inputs.

Admission and terminal transitions:

| action | submission state | other writes |
|---|---|---|
| input, idle with empty inbox | `placed`, with user entry | create run and generation |
| write, idle with empty inbox | `done`, with entry | append entry; no run |
| input or write, busy or non-empty inbox | `queued` | append inbox item |
| boundary places user item | `placed`, with entry | add ID to current or successor run |
| boundary places write | `done`, with entry | append entry |
| run answers | input `done`, with required answer entry | remove `run`, or hand it to a successor |
| run fails or its task aborts | input `unanswered`, with reason | remove `run`; inbox unchanged |
| withdraw queued item | `unanswered`, reason `aborted` | remove inbox item |
| stale head write | `unanswered`, reason `stale` | remove inbox item |

`requestId` deduplicates within one conversation before any write; reusing one
for the other submission type rejects. A busy input with `whenBusy: "reject"`
writes no record and reports `ConversationBusy`. An idle input queues with mode
`steer` when `whenBusy` is `steer` and `followUp` otherwise.

An idle conversation with a non-empty inbox, for example after a failed run,
queues every new submission behind the waiting items and runs a final boundary
in the same commit. Order is preserved: a follow-up queued before the failure is
selected before the new input.

A `Submission` waits until `done` or `unanswered`; abort withdraws only a still-
queued submission, reports `already_placed` for a placed input, and reports
`settled` for any terminal submission. Conversation abort withdraws queued
steer/follow-up submissions but keeps writes for later placement.

Boundary selection is deterministic by item ID, with the settings'
`steeringMode` and `followUpMode` (section 2.2), read at each boundary on the
Session line: `one-at-a-time` selects the first item of that mode, `all` every
item of that mode.

| boundary | write | steer | follow-up |
|---|---|---|---|
| `postTools` | all | first/all by mode | none |
| `final` | all | first/all by mode | first/all by mode |

A boundary places its selected writes first, in ID order, and then its selected
user items, in ID order. A user item queued before a reset or compaction summary
therefore lands after it and runs in the new context. Queued user items never
become stale because of a head.

A head write, queued or placed at once, whose target is older than the start of
the active range, the newest head marker's `head`, is stale: placing it would bring back history that
head cut. Heads placed earlier in the same boundary count: after a queued reset,
a queued summary targeting an older entry is stale. A `head: "self"` write is
never stale.

Compaction summaries are head writes (section 8.7), so this rule alone orders
compactions by cut position: a summary cutting before the active range start is
stale, and one cutting at or after it is placed, whenever it was selected.
Example: background compaction B selects at tail 100 and cuts at 70. While it
summarizes, a blocking compaction A cuts at 150 and appends its summary. B's
summary then settles `stale`, because 70 is older than 150. Had A cut at 60
instead, B would be placed after it: B summarized the context at its selection,
the then-newest summary plus the entries before 70, which covers everything A's
summary covers. That holds while the only heads are compaction summaries and
resets, which make older cuts stale; an application edit placed while a
compaction summarizes is lost, and an application head can be undone (section
12).

A `postTools` boundary that selects a `head: "self"` write (a reset) behaves as
`final`: it also selects follow-ups, and the current run ends with its inputs
`unanswered` with reason `reset`, because its context was cut before an answer.
A reset placed at a `final` boundary follows the answer, so the inputs are
already `done`.

At ordinary `postTools`, generation continues even with no queued trigger;
selected steer IDs join that continuation. A terminating or handoff tool round
(section 8.5) uses final behavior instead. At `final`, the current run's placed
input submissions settle first, unless an `onYield` continuation keeps them open
(below); selected user IDs start one successor generation with those IDs as the
new run's inputs. Writes never trigger generation by
themselves. A final boundary without user triggers leaves the conversation idle,
except for an `onYield` continuation (section 8.3), which applies only when the
boundary selected no user item and no reset.

Only successful run ends apply the final boundary: an answer, `terminate`, or
`handoff`. Failure, a run task's abort handler, fault, and orphan settle the
run's inputs `unanswered` and leave the inbox alone (`Conversation.abort()`
separately withdraws queued user items); the queued items stay visible in
`pi.inbox` until the next submission's boundary or their withdrawal.

Selected and stale items are removed positionally while retained item order is
preserved. Chord's Astra operation generator must express scattered removals
without carrying retained values; IDs are not substituted for positional inbox
semantics.

## 7. Extensions, hooks, tools, and system prompt

### 7.1 Extensions, registry, and agent resolution

Extension code reaches the Harness through one application-owned registry of
extensions. An extension is a named bundle of tools, prompt sections, hooks,
tool and section wrappers, and task definitions. The registry is process-local,
may outlive a Harness, and is not persisted; durable state stays in
conversations, entries, tasks, and documents. A conversation selects extensions
by name in its `pi.agent` document (section 2.2).

```ts
type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

type PromptInput<Tool extends ToolRegistration = ToolRegistration> = {
  readonly conversationId: ConversationId;
  /** The request's resolution; `agent.tools` are the tools offered in this request. */
  readonly agent: Agent<Tool>;
  /** Built by `HarnessOptions.env` for this preparation (section 2.2). */
  readonly env: ExecutionEnv | undefined;
  /** Sections already in effect after replaying the active transcript. */
  readonly shown: Readonly<Record<string, string>>;
  /** Committed document reads. */
  readonly read: DocumentReader;
};

type PromptSection<Tool extends ToolRegistration = ToolRegistration> = {
  readonly key: string;
  render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
  /** Default true: wrap the text as `<key>\n...\n</key>`. */
  readonly tag?: boolean;
};

/** Built by `hook()`; matches tasks by name. */
type HookRegistration = { readonly task: string; readonly handlers: object };

/** Built by `wrapTool()` and `wrapSection()`; targets a tool name or a section key. */
type Wrap<Tool extends ToolRegistration = ToolRegistration> =
  | { readonly tool: string; wrap(tool: Tool): Tool }
  | { readonly section: string; wrap(section: PromptSection<Tool>): PromptSection<Tool> };

interface Extension<Tool extends ToolRegistration = ToolRegistration> {
  readonly name: string;
  readonly tools?: readonly Tool[];
  readonly sections?: readonly PromptSection<Tool>[];
  readonly hooks?: readonly HookRegistration[];
  /** Apply where this extension is selected, in order. */
  readonly wraps?: readonly Wrap<Tool>[];
  /** Resolved by name for every task, whichever conversations select this extension. */
  readonly tasks?: readonly AnyTask[];
}

function defineExtension<Tool extends ToolRegistration = ToolRegistration>(extension: Extension<Tool>): Extension<Tool>;
function section<Tool extends ToolRegistration = ToolRegistration>(
  key: string,
  render: PromptSection<Tool>["render"],
  options?: { readonly tag?: boolean },
): PromptSection<Tool>;
function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration;
function wrapTool<Tool extends ToolRegistration>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool>;
function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
  key: string,
  wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool>;

interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
  /** Immutable view of the whole current registry. */
  snapshot(): RegistrySnapshot<Tool>;
  /** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
  subscribe(listener: () => void): () => void;
}

interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
  installed(): readonly Extension<Tool>[];
  extension(name: string): Extension<Tool> | undefined;
  /** Every installed tool with its extension, in install order. Names may repeat across extensions. */
  tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[];
  sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[];
  /** Built-in and installed task definitions. */
  tasks(): readonly AnyTask[];
  task(name: string): AnyTask | undefined;
}

interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
  /** Installs `extension`, or replaces the installed extension with its name in place. Publishes at once. */
  install(extension: Extension<Tool>): void;
  /** Removes the installed extension with `extension.name`, whichever object it is. A later install appends. */
  uninstall(extension: Extension): void;
}

function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool>;
```

The `Tool` parameter lets an application attach metadata, such as prompt
snippets, to its tools and read it typed in its section renderers. The Harness
only relies on `ToolRegistration`; its own surfaces, such as `runtime.agent()`,
use the default. Metadata fields must be optional: the registry does not check
them, and a default-typed extension may be installed. Pi-ai declarations derived from a tool keep only pi-ai `Tool`
fields (`toToolDeclaration`), so application metadata never enters the
transcript.

```ts
type CodingAgentTool = ToolRegistration & { readonly promptSnippet?: string };
// The renderer sees CodingAgentTool: no cast needed to read promptSnippet.
export const ToolList = defineExtension<CodingAgentTool>({
  name: "tool-list",
  sections: [section("tools", ({ agent }) => agent.tools.map((tool) => `- ${tool.name}: ${tool.promptSnippet ?? tool.description}`).join("\n") || undefined)],
});
const registry = createRegistry<CodingAgentTool>();
```

Rules:

- The built-in tasks of section 8 are always present and are not an extension:
  `tasks()` includes them, and nothing uninstalls or replaces them. Any
  extension registers hooks against them.
- Tool names and section keys are unique within one extension; across
  extensions they may repeat. Section keys match `^[a-z][a-z0-9_-]*$`, and the
  key `instructions` is reserved for the agent's instructions (below).
- Task names are unique across the built-in tasks and every installed
  extension. `install()` validates the registry as it would be after the
  replacement, including the rules above, and throws without publishing
  anything when it is invalid. `defineExtension()` and `section()` check
  nothing.
- Publication is synchronous, invokes no extension callback, and notifies
  subscribers. There is no batch: an extension is the unit of reload, and
  installing it again replaces its tools, sections, hooks, wrappers, and tasks
  in one publication at its install position.
- Extensions, tools, and task definitions are immutable, and wrappers are pure:
  a wrapper returns a new object and never mutates its input.
- An extension or tool object passed as a selection or wrapper target stands
  for its name: `settings.extensions` holding an old `Skills` object resolves to
  the installed `skills` extension.

A snapshot is a plain immutable value; nothing is released. The scheduler takes
one per phase-handler invocation and passes it through the runtime; handlers and
hooks read that snapshot and never take their own. At every normal phase
boundary the scheduler takes a fresh one, and task definitions hand over as in
section 5.4. Different phases may observe different registry states; nothing
requires one run to see a single registry state across its generation and tool
tasks.

```ts
export const ContextFiles = defineExtension({ name: "context-files", sections: [section("agents-md", renderAgentsMd)] });
export const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
export const Coding = defineExtension({
  name: "coding",
  sections: [
    section("preamble", () => "You are an expert coding assistant.", { tag: false }),
    // The environment the host built for this conversation, in the conversation's directory.
    section("cwd", (input) => input.env && `Working directory: ${input.env.cwd}`),
  ],
});
export const Permissions = defineExtension({
  name: "permissions",
  hooks: [hook(ToolTask, { beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});
// A role and a review loop, for conversations that select it.
export const Reviewer = defineExtension({
  name: "reviewer",
  sections: [section("role", () => "You review diffs. Report problems as a list. Never edit files.")],
  hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
});

const registry = createRegistry();
for (const extension of [CodingTools, Coding, ContextFiles, Skills, Permissions, Reviewer]) registry.install(extension);
const harness = await Harness.open(storage, {
  models,
  registry,
  // Reviewer is installed but not selected by default: only conversations that select it get its role and hooks.
  settings: { extensions: [CodingTools, Coding, ContextFiles, Skills, Permissions] },
  env: ({ cwd }) => localEnv(cwd ?? process.cwd()), // cached NodeExecutionEnv per directory
}, context);
// The conversation remembers its model and directory; a restart elsewhere keeps both.
const root = await harness.root(context, { agent: { model: sonnet, cwd: process.cwd() } });
```

The registry does not track which running work still uses a replaced or
uninstalled extension. Work that already started keeps using the code it took,
so an extension that frees resources right after `uninstall()` can make a
still-running call fail with an ordinary error result. Extensions that need
graceful disposal manage their resources' lifetime themselves, for example by
reference counting.

**Resolution.** A conversation's `Agent` is resolved from its stored `pi.agent`
(absent: every field unset), a registry snapshot, and the resolved settings:

```text
extensions  base = settings.extensions ?? every installed extension; in that order
            array: exactly these, in array order; { add, remove }: base, then add appended, minus remove
            duplicates keep their first position; names not installed are skipped
tools       the selected extensions' tools in extension order; a later same-name tool replaces an earlier one in place
            then every selected extension's tool wrappers, in extension order, then in each extension's order
            then the filter: an array keeps exactly these names in its order, a repeated name at its first position;
            { remove } drops these names
sections    the selected extensions' sections, same-key replacement in place, then their section wrappers,
            then `instructions` when set
hooks       the selected extensions' hooks for the task's name, in extension order
model       stored, else none: the request fails no_model
thinking    stored, else "off"
cwd         stored, else undefined
```

A wrapper that throws or returns a tool or section with a different name drops
its target for that resolution: the tool is not offered, and calls to it produce
`tool_unavailable`; the failure is reported through `onReport`. A wrapper that
finds no target does nothing, so `Timing` below may be selected where no `bash`
is. When `instructions` is set, `Agent.sections` ends
with the tagged section `instructions` rendering that text; wrappers do not
apply to it.

A later extension's same-name tool overrides an earlier one for the
conversations that select both, and wrappers apply to whichever tool won:

```ts
export const Timing = defineExtension({
  name: "timing",
  wraps: [wrapTool(bashTool, (tool) => ({
    ...tool,
    execute: async (args, api, context) => {
      const start = Date.now();
      try {
        return await tool.execute(args, api, context);
      } finally {
        metrics.record("bash", Date.now() - start);
      }
    },
  }))],
});
// A bash inside a Python virtualenv for one conversation: it replaces CodingTools' bash in place,
// and Timing, if selected, wraps it.
export const Venv = defineExtension({
  name: "venv",
  tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});
registry.install(Venv); // installed, but not in the default selection
await conversation.configure({ extensions: { add: [Venv] } }, context);
```

**Who resolves what, and when.** Each reader resolves once per decision:

| reader | resolves | when |
|---|---|---|
| generation `prepare` | agent (tools, sections, model, thinking level), stream options, compaction thresholds | once per request; model, stream options, and offered tools are fixed in the request checkpoint (section 8.3) |
| every task phase | extension selection for hooks; `runtime.agent()` | at most once per phase handler, at its first hook dispatch or `agent()` call, from that phase's snapshot and the committed `pi.agent`, off the Session line, with the invocation's context; fixed for the rest of the phase |
| tool task | the implementation of an accepted call | at `call` and `execute`: the name among the phase agent's `tools`, the current selection after the tools filter; no such tool, for example one removed after preparation: `tool_unavailable`. Replay policy on reopen uses the same lookup (section 7.3) |
| generation, when a tool round starts | tool execution mode | once per round (section 8.3) |
| generation, compaction | retry policy | at each attempt's classification |
| compaction `select` | model, thinking level, stream options, compaction thresholds | once; the summary request stays pinned across its retries (section 8.7) |
| boundaries and idle admission, on the Session line | queue modes | per boundary (section 6) |
| tool task, `prepare`, `runtime.env()` | environment | at each call (section 2.2) |

Registry installs and settings changes make no commit, so they emit nothing
(section 9.4). A conversation on the default selection changes when the
settings or the installed extensions change; its next preparation appends the
system delta (section 7.4). A UI showing resolved tools or a resolved model
resolves again through `Conversation.agent()`.

### 7.2 Hooks

A hook is a typed question asked by a task before it commits a decision. Hooks
are declared by task definition and come with an extension, built by
`hook(task, handlers)` (section 7.1). A task asks the hooks of the extensions
its conversation selects. `hook()` is typed by the task token, but dispatch
matches the task's name, so hooks survive a reload of their task; keeping hook
signatures compatible across task versions is the task author's
responsibility. Hooks run in extension order off the line; a crash before the
consuming commit may rerun them. Abort errors always propagate.

| hook | composition | ordinary throw |
|---|---|---|
| `beforeRequest` | replacement chain | report, continue |
| `afterResponse` | all observers | report, continue |
| `onYield` | first continuation wins | report, continue |
| `beforeTool` | argument replacement chain; first block wins | block tool with error text |
| `afterTool` | result replacement chain | report, continue |
| `afterTools` | all observers | report, continue |
| `beforeCompact` | first decision wins | report, continue |

Hooks use task memos for durable first-writer-wins decisions. There is no public
semantic event channel; current UI status is document state.

```ts
type HookResult<T> = T | undefined | Promise<T | undefined>;

/** What a hook may use: committed reads and the asking task's memos. */
interface HookApi extends DocumentReader {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}

interface GenerationHooks {
  /** Before every request attempt, including recovery; the result is used for that request only. */
  beforeRequest(
    request: { readonly messages: readonly Message[] },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly messages: readonly Message[] }>;
  /** Every terminal provider message, before classification. */
  afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
  /** A final answer; `continue` appends a user message and continues the run. */
  onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
  /** After every tool of the round is terminal; `results` are the round's result entries in call order. */
  afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
}

interface ToolHooks {
  /** Before intent; replaces the arguments or blocks the call with error text. */
  beforeTool(
    call: ToolCall,
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
  /** After execution, before the result entry; replaces the result. */
  afterTool(
    call: ToolCall,
    result: ToolExecutionResult,
    api: HookApi,
    context: Context,
  ): HookResult<ToolExecutionResult>;
}

interface CompactionHooks {
  /**
   * After range selection, before summarizing; the first decision wins. `entries` are the active entries the summary
   * replaces, the head marker first, and `messages` their model context, the summarizer's source; `firstKept` is the
   * first entry kept verbatim.
   */
  beforeCompact(
    compaction: {
      readonly reason: CompactionReason;
      readonly entries: readonly EntryRecord[];
      readonly messages: readonly Message[];
      readonly firstKept: EntryId;
      readonly instructions?: string;
    },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}
```

`GenerationTask`, `ToolTask`, and `CompactionTask` are the exported built-in task
tokens whose `H` parameters are these interfaces. `runtime.hooks.each(name,
invoke)` calls `invoke` with every handler under `name` among the phase's
resolved hooks: those of the extensions the task's conversation selects, for the
task's name, in extension order (section 7.1). An ordinary throw from
`invoke` is reported through `onReport` and `each` continues with the next
handler; once the invocation is signalled, the error propagates. A task that
composes differently, such as `beforeTool` turning a throw into a block, or stops
after a first decision, does so inside its own `invoke`. Hooks receive the task's
runtime as their `HookApi`; hook memos and the task's own memos share one
namespace, so hook authors prefix their memo names.

Selection decides which behavior a conversation has; the extension's own
document holds that behavior's state:

```ts
const PlanModeDoc = defineDoc<{ enabled: boolean }>({
  kind: "app.plan-mode", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ enabled: false }),
});
export const PlanMode = defineExtension({
  name: "plan-mode",
  hooks: [hook(ToolTask, {
    // An absent document means plan mode is off.
    beforeTool: async (call, api, context) =>
      (await api.snapshot(PlanModeDoc, api.conversationId, context))?.enabled && writes(call)
        ? { block: "Plan mode: read-only" }
        : undefined,
  })],
});
// PlanMode is in the default selection; /plan toggles this conversation's state.
await root.commit(async (tx) => {
  (await tx.doc(PlanModeDoc, root.id)).enabled = true;
}, context);
```

### 7.3 Tools

```ts
type ToolControl = {
  readonly addTools?: readonly string[];
  readonly terminate?: true;
  readonly handoff?: string;
};

/** Remark about a call for the model and the UI; never part of the tool's data. */
type ToolDiagnostic = {
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly code?: string;
};

type ToolExecutionResult<TDetails extends JsonValue = JsonValue> = {
  readonly content?: ToolResultMessage["content"];
  readonly isError?: boolean;
  readonly details?: TDetails;
  readonly diagnostics?: readonly ToolDiagnostic[];
  /** Spend of the execution itself, such as a model call; stored on the result and in `pi.usage.tools`. */
  readonly usage?: Usage;
  readonly control?: ToolControl;
};

interface ConversationHandle {
  readonly id: ConversationId;
  submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
}

interface ToolExecutionApi<TDetails extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly callId: string;
  /** The tool task's phase snapshot. */
  readonly registry: RegistrySnapshot;
  /** The calling conversation's agent, as the tool task's phase resolved it. */
  agent(context: Context): Promise<Agent>;
  /** Built by `HarnessOptions.env` for this call. */
  readonly env: ExecutionEnv | undefined;
  output(chunk: string | Uint8Array): void;
  diagnostic(diagnostic: ToolDiagnostic): void;
  details(value: TDetails, context: Context): Promise<void>;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
    input: I,
    options: Omit<TaskOptions, "conversationId">,
    context: Context,
  ): Promise<TaskId<R>>;
  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
}

type ToolRegistration<TParameters extends TSchema = TSchema, TDetails extends JsonValue = JsonValue> =
  Tool<TParameters> & {
  readonly replay?: "safe" | "unsafe";
  readonly executionMode?: ToolExecutionMode;
  /** Pure repair of commonly malformed arguments; runs before validation, which still checks its result. */
  prepareArguments?(args: unknown): Static<TParameters>;
  readonly outputLimits?: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly retain?: "head" | "tail";
  };
  execute(
    args: Static<TParameters>,
    api: ToolExecutionApi<TDetails>,
    context: Context,
  ): Promise<ToolExecutionResult<TDetails>>;
};

/** Identity function that infers `TParameters` from `parameters` and `TDetails` from the reported details. */
function defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
  tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails>;
```

`execute()` receives `args` typed by `parameters`: the Harness validates the
call's arguments against that schema before it runs. `defineTool()` makes an
inline tool literal infer its types, as in `tools: [defineTool({ ... })]`.
`execute` is a method, so differently typed tools share one `tools` array.

Omitted `replay` is `unsafe`. Omitted `outputLimits` are 50 KiB, 2,000 lines,
and `retain: "head"`. Omitted `executionMode` follows the settings'
`toolExecution`; one `sequential` call makes its whole round sequential
(section 8.3).

Tools reach files and processes only through `api.env`, never through an
environment captured when the tool was built. The tool task builds it for each
call with `HarnessOptions.env` from the conversation's ID and `cwd` (section
2.2), so a conversation's directory or sandbox needs no wrapper. A throw from
`env` becomes an ordinary error result of the call. A rerun after recovery gets
the conversation's environment at that time. `api` is a plain object so
wrappers can spread it. A tool that needs an environment and receives none
throws, which produces an ordinary error result.

A running tool reports output and details to the UI, mirroring the two halves of
its final result, plus diagnostics (below):

- `output(chunk)` appends running text output, like stdout. If `execute()` omits
  `content`, the final retained output becomes one text content item; no output
  becomes an empty content list. Retained output is an exact slice of whole lines
  of the stream (the first lines for `head`, the last for `tail`), trailing
  newline included; a single line longer than `maxBytes` is cut at the byte limit
  on a character boundary. Control characters other than tab and newline are
  removed from the retained text; accepting a chunk does no per-chunk sanitizing.
- `details(value)` replaces the running details with a complete JSON value; it
  does not merge keys. If `execute()` omits `details`, the last value becomes the
  final `details`, so a renderer handles one details shape from the first
  update through the final result.

Neither is sent to the model while the tool runs. `output()` synchronously
accepts UTF-8 output into that invocation-owned bounded buffer and throws after
invocation end. Throttled commits publish the retained output, dropped
byte/line counts, and the current details and diagnostics in its `pi.live.tools`
slot. The throttle is adaptive, like the environment's shell output capture: the
first change after an idle period commits at once; each commit then delays the
next by at least `settings.progress.outputIntervalMs` (default 100 ms) and by
its written size at 100 KiB/s, so a large rewrite buys a proportionally longer
pause. Changes made during the delay
coalesce into the next commit. The throttle is Harness policy, not part of
`outputLimits`, which only bounds what is retained. Explicit
text in explicit result content is bounded by the same limits before transcript
persistence; non-text content is retained as declared by its pi-ai type. When
bounding drops text, the Harness adds a `warn` diagnostic with code `truncated`
stating the dropped lines and bytes.

Diagnostics are a channel, not text. Remarks about a call, such as truncated
output, a spill path, a corrected path, a file changed on disk, or a capped
search, go through `api.diagnostic()` or `ToolExecutionResult.diagnostics`,
never into the content the model reads as the tool's data. The Harness adds the
ones it owns, and a tool adds only what it alone knows. Every diagnostic is
model-visible; information only for UIs belongs in `details`. `diagnostic()`
synchronously records the diagnostic in the tool's slot with the next throttled
commit and throws after invocation end. At settlement the result's diagnostics
are those recorded through `api`, then those in the result, then the Harness's.
When there are any, the result content ends with one text item:

```text
<harness>
[warn] output truncated: 51,204 lines, 2,301,112 bytes dropped
</harness>
```

with one `[severity] message` line per diagnostic, and the `pi.tool-result`
entry stores the structured list, possibly empty, as `data: { diagnostics }`
(section 8.1). The
stored message is exactly what the model saw, while UIs and code read the list.
A `warn` diagnostic does not set `isError`.

`output()` never spills complete output to a file because spilling requires a
filesystem, which may be remote or unavailable. A tool that must preserve
complete output spills through the `ExecutionEnv` or `FileSystem` it was given,
and reports the resulting path in a diagnostic, and in its details when a
renderer needs it. The environment's shell streams raw output chunks and spills
the complete output to a file once it crosses byte or line thresholds; it keeps
no bounded view of its own, so `output()` is the one place output is bounded,
sanitized, and throttled. The `bash` tool pipes those chunks into `output()`,
reports the spill path as a diagnostic, and throws on a nonzero exit or timeout;
the error result still carries the retained output and diagnostics.

An environment that moves output over a slow link, such as one on another host,
need not move all of it. `api.outputWindow` names the tail a tail-retaining
call keeps and the pace of its progress commits; the `bash` tool passes it as
`ShellExecOptions.window`. The environment may then omit output and report
the omission as `info.skipped` on the chunk that follows: the decoded byte
count, the newline count, and whether the omitted text ended with a newline.
It may omit only output followed by more than the window, by at least one byte
or one line, and delivers all of that following output in the same chunk, so
the omitted text can never be part of the kept tail and no progress commit sees
a gap. `output(chunk, skipped)` adds the omission to the dropped counts, so
the retained tail, the dropped counts, and the `truncated` diagnostic are the
same as if every byte had arrived; only the moments at which progress is
sampled differ. The environment should deliver no faster than the pace, since
progress commits sample no faster. A head-retaining call has no window. A
wrapper that replaces `output` to transform text sets `outputWindow` to
`undefined`, so no omitted text bypasses its transform.

`exec` takes a string or an argv array. A string runs through the
environment's shell. An array runs its first element directly with the rest as
arguments, without a shell, so a host that builds a command from data, such as
a file name, never quotes it for a particular shell. Each `onOutput` chunk names
the stream it came from; the `bash` tool ignores it, while a host that needs
stdout and stderr apart collects them separately, bounds them itself, and
aborts the call when it has enough. `openBinaryReader` opens one regular file
for positional reads, so a host reads a bounded range instead of the whole
file, and every read sees the file it opened even if the path is renamed;
`noFollow` refuses a symbolic link as the final path component. Its
`scanLines` makes one pass over the file inside the environment and reports
the newline count, the byte range of a span of lines, and the decoded sizes of
that span and its first line, so a caller can count and locate lines without
moving the file. `openDirReader`
pages a directory in file-system order, reading metadata only for the entries
it returns and skipping entries removed meanwhile. All operations stop when
their context is aborted, and only that call's work stops: a timeout or abort
kills only that command's processes. `cleanup()` kills every command the
environment still runs and belongs to its owner's shutdown, never to a single
request. `watch` reports changes to files and directories for hosts that load
resources, such as instructions or skills, from the environment; Durable
itself never calls it. A target may be missing, and creating it is a change; a
recursive target covers its subtree except excluded entries, without following
symbolic links below it. When `watch` resolves, coverage is established, so a
host that watches before it loads cannot lose a change made during the load. A
change arrives as reported paths (each covering its subtree; calls may be
spurious), as `overflow` when coverage was uncertain for a while and everything
must be rescanned, or as a final `error`. A `native` watcher reports changes
within about two seconds; a `polling` one compares snapshots because its file
system, for example a network or FUSE file system, does not report changes made
elsewhere, and can miss a change undone between two snapshots. `NodeExecutionEnv`
uses events only to trigger rescans and reports differences between snapshots,
so replaced files, renamed parents, and directories created with their contents
are reported whatever events the platform sends. An environment is trusted, not
a confinement boundary: checking a
canonical path before opening it does not prevent a concurrent rename or
symlink swap, so callers that restrict paths do so for hygiene, not security.

The `details()` promise resolves after the corresponding or coalesced document
commit. During normal settlement the tool task stops its throttle and awaits the
commit in flight; the terminal commit, which appends the result entry, is the
final flush and settles any `details()` promise still pending. Abort and close obey
invocation and Session admission gates: uncommitted buffered updates may be
discarded, while admitted commits settle. Cancellation, callback, tracker
preparation, and checkpoint failures occur before Storage admission and do not
poison the Session. An uncertain Storage failure follows the fatal Session rule.

Tools come with extensions (section 7.1) and have a name, description, JSON
schema, replay policy, and execute function. `wrapTool(tool, wrapper)` decorates
a tool without replacing it. Each resolution composes the winning tool of that
name with the selected extensions' wrappers (section 7.1); a wrapper never
captures a base, so reloading the base keeps its wrappers. The composite
supplies the declaration, argument validation, replay policy, and execution.

A tool call is accepted only if its request offered the tool. Generation checks
this against the tool set replayed from the committed model context through the
request's `cutoff`; `beforeRequest` replacements do not change it. It answers a
call to a tool it did not offer with the `tool_unavailable` result described in
section 2.2, without a tool task. An agent change after preparation does not
affect this check (section 2.2). The tool task resolves the called name among
the `tools` of the phase's agent resolution, the tools filter applied. It uses
that implementation
until execution settles: one phase handler resolves, validates, runs
`beforeTool`, records intent, executes, and commits the result, so no phase
boundary separates resolution from settlement. A name that does not resolve, for
example because its extension was uninstalled or deselected, or the tools filter
dropped it after the request was prepared, produces `tool_unavailable`.
The implementation's `prepareArguments`, if any, first repairs the call's
arguments, for example `edits` sent as a JSON string; the stored call keeps what
the model sent. Arguments are validated against the resolved implementation's
schema before and after `beforeTool`; a failure, or a throwing repair, produces an
`invalid_arguments` error result.

After hooks and validation, the tool task durably records the final arguments and
resolved replay policy before execution. Recovery does not rerun `beforeTool`
and passes the same stored arguments to `execute()`. A replay-safe tool may
reconstruct a submission from those arguments when that transformation is pure.
Random values, timestamps, mutable document/configuration reads, or other derived
inputs that must remain stable are first captured in a durable memo, checkpoint,
or task input. A background reporter task receives the final message in its own
durable input so it can finish independently. Recovery does not let a
changed registry declaration alter the stored replay policy.

A tool-acquired conversation handle accepts only input submissions; tools use
ordinary transaction writes for passive entries.

A tool executes in a durable task. It may:

- publish bounded running output and details to its `pi.live.tools` slot;
- commit memos;
- create and wait for tasks;
- atomically create or fork explicitly owned conversations through `commit()`;
- observe documents for which it has a token/reference;
- mutate authorized documents through `commit()`;
- return bounded model content and separate diagnostic details.

Tool operations use the invoking task's admission and invocation-lifetime gates.
Task creation defaults to that task's conversation. Trusted document and
conversation access follows sections 3.3 and 9.2; there is no additional subtree
authorization layer. Possession of a Session-global typed ID is sufficient in
trusted code.

Tools have no conversation-creation convenience method. They create or fork a
conversation inside `commit()`, state its ownership explicitly, atomically stage
any related document/task writes, and receive only the inert record. After that
commit settles, `conversation(id)` acquires an invocation-bound operational
handle for submission, explicit abort, and idle waits without changing
ownership. A commit callback must not call `conversation()` or use a previously
acquired handle: nested Session operations and external effects are forbidden
while the mutation line is held. A handle's operations reject after the
invocation ends. A `Submission` returned by its `submit()` is invocation-bound in
the same way; the admitted submission remains durable after those methods reject.
Invocation-owned document watches stop when the invocation ends.

A foreground subagent conversation is explicitly owned by its tool task. One
transaction creates or forks the child; the owner edge is its durable record, so
a replay-safe rerun finds the child with `scanConversations({ ownerTaskId })`
before creating one. After settlement the tool reacquires the child, submits
with a request ID derived from its task ID, which a rerun keeps, and waits for
that submission's result. Provider call IDs are not unique across a Session and
must not serve as request IDs. Aborting or abnormally
terminalizing the tool task cascades through the owned scope. The tool reports
the child in its running details, for example `api.details({ conversationId })`,
so a UI that sees the call can attach to the child's view or events.

```ts
export const Subagent = defineExtension({
  name: "subagent",
  tools: [defineTool({
    name: "subagent",
    description: "Delegate a self-contained task to a subagent and get its answer back.",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { task } = args;
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        // Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        // Without this extension, the child is not offered this tool.
        await configure(tx, created.id, { extensions: { remove: [Subagent] } });
        return created.id;
      }, context);
      await api.details({ conversationId: child }, context);
      const handle = (await api.conversation(child, context))!;
      const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, context)).wait(context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent failed: ${settled.status}`);
      return { content: [{ type: "text", text: await answerText(api, settled.answer, context) }] };
    },
  })],
});
```

`{ remove: [Subagent] }` edits the host default selection (section 2.2). The
main conversation here leaves its selection unset, so that is its selection
too. A parent with any stored selection, an array or an `{ add, remove }`
object, computes the child's array from `(await api.agent(context)).extensions`
instead, before the commit.

A persistent background subagent outlives the parent's turns and can be
messaged, steered, stopped, and listed later. One transaction, after
deduplicating by the subagent's name in an application registry document,
creates a background conversation-owned anchor task `A` in the parent, a child
conversation `C` owned by `A`, and the registry mapping from the name to `C`.
`A` completes at once; it holds `completing` while `C` has ordinary work
(section 5.5) and then stays terminal. Its record keeps `background`, so the
parent's ordinary abort and idle traversal stop at it, while
`Conversation.abort(context, { background: true })` still reaches `C`'s work
through it, and `Harness.waitForIdle()` does not wait for it. Later runs in `C`
are ordinary work of `C`; a terminal owner never cascades.

Each message to a subagent is delivered by a background conversation-owned
reporter task in the parent, created in the tool's transaction and keyed there
by the tool task ID so a rerun of the call does not create another. The
reporter submits to `C` with a request ID derived from its own task ID, waits
for that submission's settlement, and posts the answer to the parent as an
input with `whenBusy: "followUp"`, under another request ID derived from its
task ID. A crash before either admission retries it; a crash after returns the
existing `Submission`, so the child gets the message once and the parent gets
the answer once. The reporter therefore needs no transaction-level admission;
`tx.createSubmission()` writes a raw record without admission rules. The
application's name document uses
`fork: "initial"` so forks of the parent do not inherit it. A UI lists
subagents from that document; a child is working while its `pi.live.run` is
set. Owner edges alone drive abort and idle traversal. The anchor and reporter
task definitions come with the subagent extension, so pending reporters resume
after a restart once the host installs it again:

```ts
export const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

// In subagentTool's spawn commit, after the name checks:
const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
// Owned by a task of the parent: starts as a copy of the parent's agent.
const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
await configure(tx, child.id, {
  extensions: { remove: [SubagentTools] },
  instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
});
```

A tool result may request `addTools`, `terminate`, or `handoff`. The
generation's `tools` phase (section 8.5) adds the named tools to the
conversation's stored tools filter; they take effect at the next preparation. The round
terminates only when every result of the round requests `terminate`, as in the
pi agent loop; the `tools` phase then uses a final boundary. Any
`handoff` in the round, the last one in call order when several ask, ends the
run the same way after appending a `pi.reset` entry with `head: "self"` and the
handoff text as a user message (section 8.1), exactly what `reset(handoff)`
writes.

A result's `usage` is stored on the tool-result message and added to the
conversation's `pi.usage.tools[toolName]` in the result commit (section 8.6). A
tool that runs an owned conversation must not report that conversation's spend
again: the child's own `pi.usage` already counts it (section 12).

On reopen, a tool reruns only when both its stored intent policy and the current
declaration, resolved as at `call`, say `safe`. A current `unsafe` declaration
may veto a stored-safe replay; a current-safe declaration never upgrades stored
unsafe. A tool that no longer resolves is treated as `unsafe`. Every other orphaned
effect produces an interrupted result containing the
durable partial output. Completed, failed, and aborted tool terminal outcomes
retain their tool-result entry ID for the generation's `tools` phase.

Error results the Harness writes itself set `isError` and carry an `error`
diagnostic with one of the codes `tool_unavailable`, `invalid_arguments`,
`blocked`, `interrupted`, `aborted`, or `tool_error` (a throw from `execute()`)
and the error text as its message. Their content is the durable partial output,
if any, and `details` is the tool's last reported value, if any.

`@earendil-works/pi-durable/tools` provides `read`, `write`, `edit`, and `bash`
factories, ported from the agent harness tools, and the `CodingTools` extension
with all four. They use only `api.env`; nothing
installs them automatically. `read` does not return images yet. It reads a
file through `openBinaryReader`: image detection reads the header (and a PNG's
chunk headers), `scanLines` counts and locates the selected lines, and only the
shown head is read and decoded, so its cost and transfer are bounded by the
output limits plus one pass over the file inside the environment. Its result is
exactly that of decoding the whole file, splitting it into lines, and
truncating the selection. A file that changes while it is read is read again
once, then fails. `edit` and
`write` serialize their read-modify-write of one file within the process, keyed
by the environment's `FileSystem.id` (equal ids see the same files at the same
paths) and the canonical path, so two calls with fresh environment objects for
one file system still queue, and other files and file systems never wait. It
is not a lock against `bash` or other processes.

### 7.4 System prompt and dynamic tools

Pico has no durable prompt sections. The conversation's resolved agent produces
the desired sections for each request; the transcript's `pi.system` entries are
the only durable record of what the model saw. Pico stores prompt and tool
changes directly as PR #9548 `SystemMessage` values at their transcript
positions, always with empty `content`:

```ts
type SystemEntry = EntryRecord & {
  readonly kind: "pi.system";
  readonly model: readonly [SystemMessage];
};

const baseline: SystemMessage = {
  role: "system",
  content: "",
  sections: { preamble: renderedPreamble, cwd: renderedCwd },
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

Generation preparation takes these steps against its phase snapshot:

1. Resolve the conversation's agent (section 7.1) and replay the active
   transcript's system messages into the shown sections and offered tools.
2. The desired tools are the agent's `tools`, in order.
3. Build the environment with `HarnessOptions.env` (section 2.2) and render the
   agent's `sections`, in order, with `PromptInput`: the conversation, the
   agent, the environment, the shown sections, and a `DocumentReader` for
   committed documents (the task runtime). The results are the desired
   sections.
4. Compare desired sections and tool declarations with the replayed state and
   append one positional `pi.system` entry when they differ.

Preparation does not recheck the transcript before appending: only the Harness
writes to a busy conversation, through submissions, run tasks, boundaries, and a
blocking compaction, which appends only while its generation waits for it
(section 8.7), so the transcript it read is still current (section 12).

Model and thinking level are request options, not prompt state.

The selected extensions' sections and the agent's `instructions` are the only
source of prompt text; there is no separate builder. `section(key, render,
{ tag })` builds a section, and `wrapSection(key, wrapper)` decorates one,
composed per resolution like tool wrappers. Sections render in the agent's
order: extension order, a later extension's same-key section replacing the
earlier one in place, and `instructions` last (section 7.1). A section whose
`render` returns `undefined` is omitted. With `tag` omitted or true, text is
wrapped as `<key>\n...\n</key>`. A section that throws keeps its shown text, if
any, and is reported; the request is still sent. Errors thrown after the
generation invocation is cancelled propagate; an abort error of the section's
own, such as its fetch timing out, is an ordinary failure. With no sections, the
desired section set is empty.

A minimal prompt is one untagged section:

```ts
const Chat = defineExtension({
  name: "chat",
  sections: [section("preamble", () => "You are a helpful assistant.", { tag: false })],
});
registry.install(Chat);
```

A conversation's prompt varies through its extension selection, its
`instructions`, `input.env`, and `input.read`. A subagent that should not see
skills does not select the skills extension, and a cwd section renders
`input.env.cwd`; no section checks whether it runs in a subagent.
Renderers must be deterministic for equal inputs: any change in rendered text,
such as an embedded timestamp, appends a system delta and invalidates provider
prompt caches.

Replay applies messages in transcript order. Non-empty `content` appends
instructions. A section string adds or replaces that name without moving an
existing section; `null` removes it, and a later re-addition appends it to the
ordered section map. Within one message, tool removals happen before additions,
so a same-name replacement gets the new declaration and position.

Preparation compares both values and order. If values can be patched without
changing order, it emits the minimal patch. If shown and desired section order
differ, one commit appends two `pi.system` entries: the first removes every
shown section with `null`, and the second re-adds every desired section in
desired order. This makes order-only changes and deletion/re-addition between
requests replay exactly; merely restating equal values is insufficient.

A PR #9548 `SystemMessage` is always a patch, not a reset: it cannot remove
previous `content` or restore section order merely by restating current values.
Therefore, when a head removes the previous request-visible baseline, which is
the case when the active context has a head marker and no `pi.system` entry
was appended after that marker (has a higher ID), the new
`pi.system` entry adds `ContextEdit` omissions for every earlier `pi.system`
entry still retained after the cut. Its own message is then a complete baseline
containing every desired section in order and every effective tool declaration.
Model-context replay sees the new baseline instead of the omitted retained
deltas. Preparation writes this baseline even when it restates the replayed
values, so every later preparation finds a `pi.system` entry after the marker.
Head rebaselining takes precedence over ordinary order/value patching.
Without a head cut, an order mismatch uses the two-entry remove/re-add sequence
above; only when order already matches does preparation emit the minimal changed
values and `null` removals.

Tool changes are planned separately and ride on the last planned entry, or on
one entry of their own when sections are unchanged. Declarations are compared
with pi-ai `declarationsEqual()` and written with `toToolDeclaration()`, so
application metadata never enters the transcript. A changed declaration is
removed and re-added in the same message. Replay keeps retained tools in place
and appends additions; when that would not yield the desired order, the message
removes every offered tool and re-adds the desired tools in order. A head
rebaseline adds every desired tool.

The rendered strings stored in historical `SystemMessage.sections` remain
authoritative even if the current renderer changes. Pi-ai decides whether to
send the messages positionally to a capable provider or fold them into one
leading system message; Pico does not rewrite its stored transcript for provider
compatibility.

### 7.5 Extension reload

Extension code is reloaded in process through the registry. The host installs
the new extension object under the installed name, which replaces the old one
in place in one publication. The Harness keeps running; no close or reopen is
required.

```ts
registry.install(SkillsV2); // same name: conversations selecting skills render v2 at their next request
registry.uninstall(Skills); // selecting conversations get a system delta removing its section; nothing is rewritten
// Restart: the host installs its extensions again; stored names resolve against them.
```

- New phase invocations and tool tasks use the new extension immediately;
  running invocations see it at their next phase boundary.
- Work already running keeps its snapshot until its phase handler settles, and a
  pinned tool keeps its implementation until its execution settles. Replacement
  never signals or interrupts it. Resources the old code uses are the
  extension's responsibility (section 7.1).
- A task definition replaced by name hands over at its next normal phase boundary
  (section 5.4). A task definition must increase its version when the meaning
  of persisted input or checkpoint state changes and migrate supported older
  state; a failed migration blocks the task rather than terminalizing it.
- A replaced extension keeps its install position, so a reload does not move
  its hooks, tools, and sections relative to other extensions; within the
  extension, the new object's order applies. Moving a task definition from one extension to
  another leaves a gap between the two installs in which its pending tasks are
  blocked.
- Document definitions are passed explicitly to typed access and need no
  registration; changed tokens take effect on their next access.

If old extension code ignores cancellation and never settles, new work already
uses the replacement. Harness close still joins every invocation. Safe forced termination of arbitrary
non-cooperative JavaScript requires worker/process isolation; that host
terminates the process and reopens the Session from durable state. Old and new
Harness instances must never own the same Session concurrently: open the new one
after the old one's `close()` resolved, when none of its invocation code runs
any more (section 2.2).

## 8. Built-in tasks

The initial implementation provides:

| kind | responsibility |
|---|---|
| `pi.generation` | prepare system prompt and tools, request or poll model, retry, classify response |
| `pi.tool` | validate, hook, execute, persist output and details, append result |
| `pi.compaction` | select a transcript range, summarize, place a headed summary |

Generation uses `HarnessOptions.models` without a Pico-specific model adapter. It
resolves `models.getModel(ref.provider, ref.modelId)`, builds a pi-ai `Context`
from the prepared prompt/messages/tools, and calls `models.streamSimple()` with
the task invocation's abort signal, the agent's thinking level, and the
settings' stream options. Deferred
continuation calls `models.fetchDeferred()` and `models.cancelDeferred()` with
that same model and signal. Missing models and synchronous/streamed pi-ai errors
are classified into the durable generation outcomes below.

Generation and tool progress are throttled durable document commits. A crash may
lose only the uncommitted throttle window. Recovery converts committed partials
to normal interrupted/aborted transcript entries, clears presentation state,
and then retries or terminates according to the task phase. Retry deadlines,
attempts, compaction, and tool progress are current document state for late
joiners; completed-attempt usage/accounting is an entry or terminal detail.
Truncation and spill paths are tool diagnostics (section 7.3).

Compaction changes model context by appending a summary entry with a head. It
does not delete transcript history.

### 8.1 Built-in entries

Built-in entry kinds carry no `data`, except `pi.tool-result`, whose token is
`Entry<{ diagnostics: ToolDiagnostic[] }>`; every tool result carries `data`,
with an empty list when it has no diagnostics (section 7.3), and
`pi.compaction`, whose token is `Entry<{ reason: CompactionReason }>`. Each kind
is exported as an `Entry` token.

| kind | `model` | written by |
|---|---|---|
| `pi.user` | `[UserMessage]`, timestamp from the Harness clock at admission or placement | submissions, `onYield` continuations |
| `pi.assistant` | `[AssistantMessage]` with any stop reason | generation |
| `pi.system` | `[SystemMessage]` with `content: ""` (section 7.4) | generation preparation |
| `pi.tool-result` | `[ToolResultMessage]` | tool tasks; generation for calls to tools its request did not offer |
| `pi.reset` | absent, or `[UserMessage]` with the handoff text; always `head: "self"` | `reset()`, generation `tools` phase for `handoff` |
| `pi.compaction` | `[UserMessage]` with the wrapped summary; `head` is the first kept entry | compaction tasks (section 8.7) |

Every generation response becomes a `pi.assistant` entry: answers, failed attempts
with their error text and usage, and converted partials with stop reason
`aborted`. Context derivation (section 2.1, rule 9) keeps failed and aborted
messages out of later requests, so no separate usage or notice kind exists.

### 8.2 Live document

```ts
type LiveState = {
  /** Run control (section 6); present exactly while the conversation is busy. */
  run?: { taskId: TaskId; inputs: SubmissionId[] };
  /** Presentation of the current generation attempt. */
  generation?: {
    attempt: number;
    /** Committed throttled partial of the in-flight response. */
    message?: JsonRepresentation<AssistantMessage>;
    /** Durable backoff before the next attempt. */
    retry?: { at: number; error: string };
    /** Provider-side deferred response being polled. */
    deferred?: { pollAt: number };
  };
  /** The current tool round in call order, from the tool-calling answer until the generation's `tools` phase ends it. */
  tools?: {
    callId: string;
    name: string;
    /**
     * Absent for a call not started yet (sequential round, `pending`) and for a call its request did not offer,
     * which starts `done` with the `entry` generation wrote.
     */
    taskId?: TaskId;
    status: "pending" | "running" | "done";
    /** Retained running output and what the bounds dropped. */
    output?: string;
    droppedBytes?: number;
    droppedLines?: number;
    /** Last `details()` value. */
    details?: JsonValue;
    /** Diagnostics recorded through `api.diagnostic()`. */
    diagnostics?: ToolDiagnostic[];
    /** Result entry once done; absent when the tool task faulted or was orphaned. */
    entry?: EntryId;
  }[];
  /** Live compaction tasks in task ID order; absent when none (section 8.7). */
  compactions?: CompactionStatus[];
};

type CompactionStatus = {
  taskId: TaskId<CompactionResult>;
  reason: CompactionReason;
  /** Whether a generation waits for it: a compaction the generation owns. */
  blocking: boolean;
  attempt: number;
  /** Durable backoff before the next summarization attempt. */
  retry?: { at: number; error: string };
};
```

| field | value |
|---|---|
| kind | `pi.live` |
| version | `1` |
| scope/history/fork | conversation, `latest`, `initial` |
| `initial()` | `{}` |
| checkpoint | complete base whenever nothing runs: `generation` absent and no `running` tool slot |
| view mount | `docs["pi.live"]` |
| created | with every Harness conversation (section 2.2) |

Nothing runs while idle, at a final boundary, in the commit where generation
hands over to its tool round (every slot is still `pending` or `done`), between
the tools of a sequential round, and whenever no tool of a parallel round is
`running`. A slot holds output only while `running`, so every base is small, and
the stored delta chain spans at most one generation, including its retries and
deferred polls, or the overlapping execution of one round's tools. Retained head output grows by Chord string appends. A sliding tail
usually becomes a front trim plus an append; when Chord's bounded overlap search
finds no shared part, as with highly repetitive output or a window larger than
its 64 KiB scan, the commit writes the retained window as one set. Either way
each commit writes at most one window, and the throttle bounds the rate.

Generation creates `tools` with one `pending` slot per call in the commit that
appends the tool-calling answer; a call its request did not offer starts `done`
with its result entry. A tool task sets its slot `running` in its intent commit,
publishes throttled output and details into it, and in its terminal commit sets
`done` and `entry` and removes `output`, `droppedBytes`, `droppedLines`,
`details`, and `diagnostics`, which the result entry now carries (section 7.3).
The generation's `tools` phase removes `tools`. Slot updates apply only while a slot with the task's
`taskId` exists; without one, the durable partial output, details, and
diagnostics are empty.

A compaction's status is added in the commit that creates the task and removed
in the commit that decides its outcome: the task's own outcome commit, even when
that outcome holds as `completing` (section 5.5), or the scheduler's cleanup
(section 5.4).
It stays small: the summary text lives in the task's placement, never here. Partials are
normalized to strict JSON before assignment. Every terminal path of a run task
removes `run`, `generation`, and `tools` in the commit that settles the run's
inputs. `tx.settleSubmission()` stages each input's new status
and resolves the transaction's latest candidate submission record, falling back
to committed state, during assembly, like task-document validation (section 3.3),
so it is not a caller table read and works after the commit's first table write.

### 8.3 Generation

```ts
type GenerationInput = {};
type GenerationCheckpoint =
  | {
      phase: "prepare";
      attempt: number;
      /** The blocking compaction this generation waited for; it starts no other compaction. */
      compacted?: TaskId<CompactionResult>;
      /** Error text of the overflow that started `compacted`; checked once when `prepare` resumes. */
      overflow?: string;
    }
  | {
      phase: "request";
      attempt: number;
      compacted?: TaskId<CompactionResult>;
      model: ModelRef;
      thinkingLevel: ModelThinkingLevel;
      streamOptions: ConversationStreamOptions;
      /** Newest entry included in the request. */
      cutoff: EntryId;
    }
  | { phase: "retry"; attempt: number; compacted?: TaskId<CompactionResult>; until: number }
  | {
      phase: "poll";
      attempt: number;
      compacted?: TaskId<CompactionResult>;
      model: ModelRef;
      cutoff: EntryId;
      handle: DeferredHandle;
      pollAt: number;
    }
  | {
      /** Waiting on the round's tool tasks; `waiting` holds this checkpoint (section 8.5). */
      phase: "tools";
      assistant: EntryId;
      tools: TaskId<ToolTaskResult>[];
      /** Calls of a sequential round not started yet, in call order. */
      pending: string[];
    };
type GenerationResult = { entryId: EntryId };
```

`pi.generation` is version 1 and starts at `{ phase: "prepare", attempt: 1 }`.
The run's inputs live in `pi.live.run`, not in the task input.

- `prepare` runs section 7.4 with the phase's agent resolution and resolves
  the settings once. When the agent has no model or `models.getModel()` does
  not know it, the task fails with `no_model`. When it resumes with `overflow`
  and its compaction did not complete with an `entryId`, the run fails with
  `model_error` and the overflow text as detail. Otherwise one commit appends
  the planned `pi.system` entries and moves to `request` with the new tail as
  `cutoff`, the agent's model and thinking level, and the settings' stream
  options. These stay fixed for this request attempt; a retry prepares again. `compacted` carries over to
  `request`, `retry`, `poll`, and the next `prepare`.
- Before that commit, `prepare` checks the compaction thresholds (section 8.7)
  when the settings' compaction policy is enabled, the model's
  `contextWindow` is positive, and `compacted` is absent. The estimate starts at
  the newest assistant message in the committed model context whose entry was
  appended after the head marker (all qualify without one) and whose usage is
  nonzero: pi-ai `calculateContextTokens()` of its usage, plus pi-ai
  `estimateMessageTokens()` of every context message after it and of the planned
  system messages. Its request included the marker, because a head is placed
  only while no request is in flight. Without such a message, every message is
  estimated. Both thresholds apply only when range selection finds a cut.
  - Above `contextWindow - reserveTokens`, the blocking threshold: instead of
    appending, one commit creates a compaction owned by the generation with reason
    `threshold`, adds its status, and commits `waiting` on it with `allSettled`
    and checkpoint `{ phase: "prepare", attempt, compacted }`. Whatever its
    outcome, `prepare` then runs again and sends the request.
  - Above `contextWindow - reserveTokens - backgroundTokens` with
    `backgroundTokens > 0` and no compaction status in `pi.live`: the commit that
    moves to `request` also creates a background compaction, owned by the
    conversation, with reason `threshold`, and adds its status. The generation
    does not wait for it. The settings' retry policy is read when the
  attempt's result is classified, because it governs the next attempt (section
  7.1).
- `request` and `poll` resolve the checkpoint's model through
  `models.getModel()`; an unknown model fails the task with `no_model`, like
  `prepare`. `request` converts a leftover partial (below) before it resolves
  the model.
- `request` first converts a committed partial left in `pi.live` by an
  interrupted attempt into an aborted `pi.assistant` entry. It then streams the
  model context through `cutoff` with the invocation signal, the thinking level
  as `reasoning` (omitted for `off`), the conversation's persisted provider
  `sessionId`, and the pinned `streamOptions`, committing throttled partials at
  most every `settings.progress.partialIntervalMs` (default 100 ms).
  Before streaming, the `beforeRequest` chain may
  replace the messages for this request only. Recovery resends the same
  committed messages with the same pinned model, thinking level, and stream
  options, and reruns `beforeRequest`.
- `afterResponse` observes every terminal message, from `request` or `poll`,
  before classification; a still deferred result is not terminal.
- Before classifying, the handler stops the partial throttle and awaits any
  partial commit in flight, so no stale partial lands after the outcome. The
  terminal message is classified in one commit that also clears the partial:
  - `stop`/`length`: before the commit, the `onYield` chain runs; the first
    `{ continue }` wins. The commit appends the answer and applies the final
    boundary (section 6). With a continuation and no selected user item or
    reset, it appends a `pi.user` entry with the continuation content, creates a
    successor generation, and hands it `pi.live.run`, keeping the inputs open.
    Otherwise it settles the run's inputs `done`, removes `run` and
    `generation`, and starts a successor run for the selected user items, if
    any; a dropped continuation is not retried. Both complete with
    `{ entryId }`.
  - `toolUse` with at least one tool call: the commit appends the assistant
    entry and starts the tool round described below, moving to `waiting` in the
    `tools` phase. A `toolUse` message without calls is classified like `stop`.
  - `error` that pi-ai `isContextOverflow()` recognizes, while the settings'
    compaction policy is enabled, `compacted` is absent, and range selection finds a cut:
    the commit appends the error entry, removes `generation`, creates a
    compaction owned by the generation with reason `overflow`, adds its status,
    and commits `waiting` on it with `allSettled` and checkpoint `{ phase:
    "prepare", attempt, compacted, overflow }`; the recovery request does not
    count against the retry policy. Any other overflow,
    including a second one, is never retried and fails like the non-retryable
    errors below. A `stop` or `length` response is never classified as overflow;
    the next threshold check handles silent overflow.
  - `error` that `isRetryableAssistantError()` accepts while the settings'
    retry policy allows another attempt (`enabled` and `attempt <= maxRetries`,
    so `maxRetries` counts retries after the first attempt): append the error entry and move to
    `retry` with `until = now + retryDelayMs(policy, attempt)`.
  - any other `error`, or `aborted` without an abort mark: append the error
    entry, settle the inputs `unanswered` with `model_error`, remove `run` and
    `generation`, and fail.
  - `deferred`: move to `poll` with `pollAt = now + (handle.pollAfterMs ?? 5000)`.
- `retry` sleeps until `until`, then returns to `prepare` with the next attempt,
  so agent and settings changes made during the backoff apply.
- `poll` sleeps until `pollAt` and calls `models.fetchDeferred()`. A still
  deferred result moves `pollAt` strictly later; any other result is classified
  as above.
- The abort handler calls `models.cancelDeferred()` in `poll` when the model is
  known (a failure is reported), converts a committed partial, settles the inputs `unanswered` with
  `aborted`, removes `run` and `generation`, and ends `aborted`.

A tool round starts in the commit that appends the tool-calling answer:

1. The offered tools are replayed with pi-ai `getCurrentTools()` from the
   committed model context through `cutoff`: `request` already holds it, and
   `poll` derives it again. A call to a tool not offered gets its
   `tool_unavailable` result entry here, without a task.
2. Every other call gets a `pi.tool` task owned by the generation, with input
   `{ assistant, callId }`. The round is sequential when the settings'
   `toolExecution`, read as the round starts, is `sequential` or any called
   tool, resolved from the phase's agent as the tool task resolves it (section
   7.3), has `executionMode: "sequential"`: then only the first call gets its
   task now and the rest wait in `pending`. Otherwise every call gets its task at
   once and they run in parallel. The checkpoint's `tools` lists the tasks
   created so far and grows by one per started sequential call, while
   `pending` shrinks.
3. The generation commits `waiting` on its tool tasks with `allSettled` and the
   `tools` checkpoint (section 8.5); `pi.live.run` stays with it.
4. `pi.live.tools` receives the round's slots (section 8.2), and `generation` is
   removed.

Input submissions settle `unanswered` with one of these reasons: `no_model`,
`model_error` (detail: provider error text), `aborted`, `faulted` (detail: error
message), or an orphaning blocked reason (section 5.4). Fault and orphan
settlement convert a committed partial into an aborted `pi.assistant` entry,
like the abort handler.

### 8.4 Tool

```ts
type ToolTaskInput = { assistant: EntryId; callId: string };
type ToolTaskCheckpoint =
  | { phase: "call" }
  | { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
type ToolTaskResult = { entryId: EntryId; control?: ToolControl };
```

`pi.tool` is version 1 and starts at `{ phase: "call" }`. The input stays small
because the terminal record keeps it; the call is read from the assistant entry.

- `call` reads the call with `runtime.entry()`, resolves the tool among the
  phase's agent `tools` (section 7.3), validates
  the arguments with pi-ai
  `validateToolArguments()`, runs the `beforeTool` chain, and validates again
  (section 7.3). One commit then records intent: it moves to `execute` with the
  final arguments and the tool's replay policy and sets the slot `running`. The
  same handler executes the tool, runs the `afterTool` chain, and commits the
  result; it builds `api.env` with `HarnessOptions.env` right before executing
  (section 2.2). A tool that does not resolve, invalid arguments, or a block
  commits the corresponding error result instead, without intent.
- `execute` is reached only by recovery. When both the stored and the current
  policy, resolved as in `call`, are `safe`, it executes again with the stored arguments,
  without `beforeTool`, and settles like `call`. Otherwise it commits an
  `interrupted` error result from the slot's durable partial output, details, and
  diagnostics, and ends `failed` with `{ entryId }`.
- The result commit bounds the content, appends the diagnostics block (section
  7.3), appends one `pi.tool-result` entry with `model: [{ role: "toolResult",
  toolCallId, toolName, content, details, isError, timestamp }]` and
  `data: { diagnostics }`, marks the slot `done`, and
  completes with `{ entryId, control }`. An `isError` result still completes.
- A throw from `execute()`, or from `HarnessOptions.env` building its
  environment, becomes a `tool_error` result and the task ends
  `failed` with `{ entryId }`; once the invocation is signalled it propagates
  instead. Ending `failed`, like `aborted`, records cancellation intent (section
  5.4), so conversations the call owns, which nothing supervises any more, are
  aborted. A returned `isError` result still completes, and its call's owned work
  survives. Either way the run continues with the result entry. A tool task whose
  owned conversations still have ordinary work when it commits its result holds
  `completing` with the result entry already written (section 5.5); the
  generation resumes only when the tool task is terminal.
- The abort handler commits an `aborted` error result from the slot's durable
  partial output, details, and diagnostics and ends `aborted` with `{ entryId }`.

### 8.5 Tool rounds

The generation resumes in its `tools` phase once every tool task it waits on is
terminal. In a sequential round with calls left in `pending`, one commit creates
the next call's owned tool task and waits on it again with the shorter `pending`.
Otherwise it reads the tool records with `runtime.getTask()` and the round's
result entries from the `pi.live.tools` slots, runs the `afterTools` observers,
and then commits once:

- It edits the conversation's stored `pi.agent` `tools` for every `addTools`
  name: an array gets the name appended unless it holds it already, and
  `{ remove }` loses the name. With `tools` unset, every tool is already
  offered, and nothing is written. The next preparation offers the tool when it
  resolves.
- When every result of the round requests `terminate`, or any requests
  `handoff`, it appends the handoff's `pi.reset` entry, if any, settles the
  run's inputs `done` with the tool-calling answer, removes `run` and `tools`,
  and applies the final boundary.
- Otherwise it removes `tools` and applies the `postTools` boundary. When that
  boundary placed a reset, the run's inputs settle `unanswered` with `reset` and
  selected user items start a successor run (section 6). Otherwise selected
  steer IDs join `pi.live.run`, and it creates the next generation, owned by the
  conversation, and hands it the run.

It completes with `{ entryId }` of the tool-calling answer. Its abort handler
runs only after its tool tasks are terminal (section 5.5). For every call still
in `pending`, which never started, it appends an `aborted` error result; a
started call whose task faulted or was orphaned keeps
its `done` slot without an entry (section 8.2). It then settles the inputs
`unanswered` with `aborted`, removes `run`, `generation`, and `tools`, and ends
`aborted`. `abortTask()` on the generation therefore aborts its whole round.

### 8.6 Usage

```ts
type UsageState = {
  /** Assistant entries and compaction summarization attempts, keyed `provider/modelId`. */
  models: Record<string, Usage>;
  /** Tool results, keyed by tool name; their usage has no model identity. */
  tools: Record<string, Usage>;
};
```

| field | value |
|---|---|
| kind | `pi.usage` |
| version | `1` |
| scope/history/fork | conversation, `latest`, `initial` |
| `initial()` | `{ models: {}, tools: {} }` |
| checkpoint | complete base on every change |
| view mount | `docs["pi.usage"]` |
| created | with every Harness conversation (section 2.2) |

`pi.usage` is the ledger of the conversation's own spend. Every built-in writer
of a `pi.assistant` entry adds its message's `usage` to `models` under the
message's own `provider/model`, and every writer of
a `pi.tool-result` entry with `usage` adds it to `tools`, in the same commit.
Every summarization attempt of a compaction task adds its response's `usage` to
`models` in the commit that classifies it (section 8.7); that spend has no entry,
whether the summary is placed, fails, or ends stale. Failed and aborted attempts
count. A fork starts at zero, so no spend is counted
twice. `Harness.usage()` sums every conversation's document into the Session
total; other totals, such as an ownership subtree, are application sums over
`scanConversations()`. Nothing stores a total across conversations.

### 8.7 Compaction

```ts
type CompactionReason = "manual" | "threshold" | "overflow";
type CompactionInput = { reason: CompactionReason; instructions?: string };
/** The pinned summarization request. */
type SummaryRequest = {
  attempt: number;
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  streamOptions: ConversationStreamOptions;
  maxTokens: number;
  /** Newest entry of the context the range was selected from. */
  tail: EntryId;
  /** First entry kept verbatim; the summary's `head`. */
  firstKept: EntryId;
};
type CompactionCheckpoint =
  | { phase: "select" }
  | ({ phase: "summarize" } & SummaryRequest)
  | ({ phase: "retry"; until: number } & SummaryRequest);
/**
 * `entryId` of a blocking compaction's summary, or the `submissionId` of a conversation-owned compaction's summary
 * write; both absent when nothing was compacted.
 */
type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId };
```

`pi.compaction` is version 1 and starts at `{ phase: "select" }`. Compaction
replaces an old prefix of the model context with a summary entry whose `head` is
the first kept entry (section 2.1). Raw history stays in storage. There are three
ways to start one; the task is the same, only ownership and placement differ:

| started by | owner | background | generation waits | placement |
|---|---|---|---|---|
| `Conversation.compact()` | conversation | no | no | write submission |
| generation above the background threshold | conversation | yes | no | write submission |
| generation above the blocking threshold, or on overflow | the generation | no | yes | direct append |

Only a blocking compaction runs while the conversation's run waits for it. The
others never take run control: the conversation keeps working while they
summarize, and their summary is placed like any passive write. Compactions do
not coordinate with each other; several may run at once, and section 6 decides
between their summaries.

**Range selection** is a pure function of a `ContextView`, whose
`contributions` give each active entry's model messages after every edit in the
range (section 2.1, rules 4 and 9), including edits carried by older in-range
markers, and the settings' `keepRecentTokens`.

1. Cut candidates are the non-marker entries whose contribution begins with a
   user or assistant message. Tool results and system entries are never
   candidates, so a kept assistant message keeps its tool results. A user entry
   is not a candidate either while a result for a call of the assistant before
   it follows it, before the next assistant (section 2.1, rule 7).
2. Walk the non-marker entries from newest to oldest, adding pi-ai
   `estimateMessageTokens()` of each contribution. At the first entry where the
   sum reaches `keepRecentTokens`, the cut is the first candidate at or after
   that entry in transcript order, or the newest candidate when none follows.
3. There is nothing to compact when the sum never reaches `keepRecentTokens`, or
   when no non-marker entry before the cut contributes a model message.

The summarized entries are the head marker, if any, followed by the non-marker
entries before the cut. Their messages are their contributions, ordered as in
section 2.1, rules 7 and 8, so an earlier summary is summarized again together
with the history after it. Nothing is compacted while the context is smaller
than `keepRecentTokens`, so with a window where `contextWindow - reserveTokens`
is below it, overflow may come before any threshold compaction.

```text
1 user   2 assistant (read)   3 tool result, 30k tokens   4 assistant   5 user   6 assistant
keepRecentTokens 20k: the walk from 6 reaches 20k at 3; the first candidate at or after 3 is 4.
The summary covers 1-3; the model context becomes [summary, 4, 5, 6].
```

Phases:

- `select` takes the phase's agent resolution, resolves the settings once, and
  captures the committed context. When the agent has no model or
  `models.getModel()` does not know it,
  the task fails with `no_model`. With nothing to compact it completes with
  `{}`. Otherwise the `beforeCompact` hooks (section 7.2) run with the
  summarized entries and messages; the first decision wins. `{ decline: true }` completes
  with `{}`, and `{ summary }` is placed as below in the same commit. Without a
  decision, one commit moves to `summarize` with attempt 1, the agent's model
  and thinking level, the settings' stream options, `maxTokens` = `min(floor(0.8 *
  reserveTokens), model.maxTokens)` (the model's value only when positive), the
  captured tail, and the cut as `firstKept`.
- `summarize` derives the summarized messages again from the context at `tail`,
  which is immutable, and serializes them to text: `[User]: ...`,
  `[Assistant thinking]: ...`, `[Assistant]: ...`,
  `[Assistant tool calls]: name(key=json, ...)`, and `[Tool result]: ...`
  truncated to 2000 characters; system messages are omitted. The request has no
  tools and two messages: a system message with the built-in summarization
  system prompt, and a user message with the serialized text in
  `<conversation>` tags followed by the built-in summarization prompt, and
  `Additional focus: <instructions>` when the input has instructions. It uses the
  pinned thinking level as `reasoning`, the conversation's persisted provider
  `sessionId`, and the pinned stream options without `deferred`, with
  `cacheRetention: "none"` and the pinned `maxTokens`. Providers such as Codex
  may suppress that identity when caching is disabled. Recovery resends the same
  request. The response is classified in one commit
  that adds its usage to `pi.usage` (section 8.6):
  - `stop` with non-empty text and no tool call: the text is the summary, placed
    as below.
  - `error` that `isRetryableAssistantError()` accepts while the settings'
    retry policy, read at classification, allows another attempt: move to `retry` with `until = now +
    retryDelayMs(policy, attempt)`, and set the status's `attempt` and `retry`.
  - anything else, including a `length` stop, which leaves the summary
    incomplete: fail with `model_error`.
- `retry` sleeps until `until`, then returns to `summarize` with the next attempt
  and the same pinned request.

The built-in prompts are the coding agent's structured checkpoint format. The
prompt also asks the model to carry forward an earlier summary at the start of
the conversation.

**Placement.** The summary entry is

```ts
{
  kind: "pi.compaction",
  head: firstKept,
  model: [{ role: "user", content: [{ type: "text", text: wrapped }], timestamp: now }],
  data: { reason },
}
```

where `wrapped` is `"The conversation history before this point was compacted
into the following summary:\n\n<summary>\n"`, the summary, and
`"\n</summary>"`. The commit that places it also removes the task's status and
commits the task's `completed` outcome:

- A blocking compaction appends the entry directly and completes with
  `{ entryId }`. Its generation holds the run and waits, so nothing else writes
  the conversation.
- A conversation-owned compaction admits the entry as a write submission with
  request ID `compaction:<taskId>`, following section 6 exactly: in an idle
  conversation with an empty inbox it is appended at once or settles `stale`;
  in an idle conversation with queued items it queues and a final boundary runs;
  in a busy one it queues for the next boundary. It completes with
  `{ submissionId }` and never waits for a queued placement;
  `Harness.submission()` observes the placement.

The next generation's preparation finds a head marker without a later
`pi.system` entry and writes a complete system baseline (section 7.4).

**Cancellation.** The abort handler removes the task's status and ends
`aborted`; it writes no entry. An attempt cut short by abort or a crash has no
committed response, so its usage is not counted. A manual compaction is
ordinary work of its conversation: `Conversation.abort()` aborts it. A
background compaction survives it and stops only through `abortTask()` or
`Conversation.abort(context, { background: true })`. A blocking compaction is
aborted with its generation, before the generation's abort handler runs
(section 5.5). A summary that is already queued is a write submission:
conversation abort keeps it, and `Submission.abort()` withdraws it.

When a blocking compaction ends without an `entryId`, because it found nothing
to compact, was declined, failed, faulted, or was aborted directly, a threshold
generation sends its request anyway and an overflow generation fails with
`model_error` (section 8.3).


## 9. Document observation and Chord

### 9.1 Document state

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

type DocumentState<T extends JsonObject> =
  AttachedReplicatedState<Readonly<T> | null>;

type WatchEnd =
  | { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
  | { readonly reason: "listener_error"; readonly error: Error };

interface WatchHandle<T> {
  /** Acquisition revision before start; latest delivered immutable revision afterward. */
  readonly value: T;
  /** Installs the sole serialized asynchronous listener. */
  start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void;
  /** Idempotently stops future callbacks and returns this watch's terminal result. */
  stop(): Promise<WatchEnd>;
  /** Settles when the watch terminates; an already-running callback remains caller-owned. */
  readonly closed: Promise<WatchEnd>;
}

type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

interface DocumentObserver {
  watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
}
```

`documentState()` attaches Pico's committed document stream to Chord before
returning. The returned state is already hydrated with the exact shareable
immutable revision, has no mutation methods, and publishes every later exact
committed revision and operation batch without another tracker, value copy, or
re-diff. Disposing it unregisters only that observation; Pico remains the sole
document mutator.

State and watch acquisition never create; absent lookup returns `undefined`.
Successful acquisition binds one concrete incarnation. Retirement publishes a
JSON `null` root replacement and ends that incarnation's stream. If the state
remains exposed, consumers see `null`, never stale state. A later recreation
requires acquiring a new state or watch.

Session close ends every state at its seal: the state keeps its last value and
receives no frame from a commit that settles during close.

Each document state assigns its own in-memory contiguous Chord delivery sequence.
Pico does not persist or expose that sequence through `WatchHandle`. States and watches retain immutable revisions independently of the loaded tracker
cache. Reopen creates a new state lifetime and hydration.

Internally, state attachment uses Chord's synchronous atomic snapshot-and-register
boundary: the snapshot includes every commit before attachment, and every later
exact frame is buffered until activation. This prevents a snapshot from being
paired with operations based on a newer unseen revision.

### 9.2 `watchDoc`

Tasks, hooks, and tools may observe any existing document for which their code
has a token and owner/key. There is no additional subtree permission system inside trusted
Session code.

On the Session line, `watchDoc()` resolves one existing concrete incarnation,
captures its current immutable tracker revision in O(1), and registers for every
later exact committed revision and operation batch. It returns `undefined` when
absent. Before `start()`, `watch.value` remains the acquisition revision while
later frames buffer.

```ts
const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
if (watch === undefined) return;
try {
  await initializeConsumer(watch.value, context);
  watch.start(async (value, ops, deliveryContext) => {
    await consume(value, ops, deliveryContext);
  });
} catch (error) {
  await watch.stop();
  throw error;
}
```

`start()` installs the sole listener and schedules delivery; it never invokes
user code inline. Each callback receives the exact immutable committed value and
the exact operation batch that produced it. Immediately before invocation,
`watch.value` advances to that value. The watch awaits the listener before
starting its next callback, but Session commits never wait for callback
settlement.

A watch retains at most 100 pending committed frames, excluding the frame already
being delivered. Adding frame 101 replaces the complete undelivered suffix with
one self-contained root replacement `[["r", newestValue]]`, using the newest
exact immutable revision and that commit's Context. Later exact frames follow
that replacement normally. Another overflow replaces the pending suffix again.
No serialized-byte measurement, value copy, operation replay, or re-diff occurs.
This is convergent observation, not an audit stream; consumers requiring every
transition must persist those facts separately.

`watch.value` and every previously returned revision remain stable forever under
the trusted immutability contract. Consumers must not mutate them or retained
descendants. The selected commit Context's values are preserved without inheriting the
producer's cancellation. A callback owns its own asynchronous work.

A watch remains bound to its original incarnation. Retirement queues the exact
terminal `[["r", null]]` frame, or folds it into an overflow replacement with
value `null`. After that callback settles, the watch closes as `retired` and never
follows a replacement incarnation.

`stop()` is idempotent. It synchronously unregisters, discards pending frames,
prevents another callback from starting, and returns the common terminal promise.
An already-running callback is not aborted or joined and remains caller-owned.
The acquisition `Context` governs watch lifetime. Cancellation during acquisition
cleans up before rejecting; later cancellation and Session close stop future
delivery similarly. Listener failure discards pending work and closes only that
watch as `listener_error`. The first termination reason wins, and every late
rejection is observed.

### 9.3 Conversation view

The public view is a fixed structural mount of the conversation's active
transcript and its built-in documents:

```ts
type ConversationView = {
  readonly conversation: ConversationRecord;
  /** Raw active entries, as `ContextView.entries` (section 2.1): the head marker, then the non-head entries from its head. */
  readonly entries: readonly EntryRecord[];
  /** `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, and `pi.usage`, keyed by kind; absent documents are absent. */
  readonly docs: Readonly<Record<string, JsonObject>>;
};
```

These kinds and their fields are public protocol. Third-party documents are
exposed through their own Chord services, not mounted.

The Harness keeps at most one mount per conversation. The first `viewState()`,
`watch()`, or event attachment builds its revision on the Session line from the
committed active transcript and documents; the mount is dropped when its last
observer detaches. A mount derives each next revision from the Session's
`subscribeCommits()` publications, like `watchDoc()`: every publication is
already durable, so the view shows only committed state. One publication that
touches the conversation yields one Chord batch:

```text
document op ["s", ["generation", "message"], value]
-> view op ["s", ["docs", "pi.live", "generation", "message"], value]
```

An appended entry without a head is a splice at the end of `entries`. An
appended head marker `H` makes the entries `H` followed by the current non-head
entries at or after `H.head`: the kept entries stay, and splices remove the
others and insert `H` at the front. Every kept entry is already mounted because
Harness writers never target a head before the current range: resets and
handoffs head themselves, compaction summaries target a kept entry of the
current range, and head writes that reach further back are stale (section 6). A raw head write that targets further back shows only the
mounted entries (section 12).
Document creation and retirement set and delete the `docs` key. Parent entries
through `parent.at` are immutable, so a child's mount follows only its own
conversation. A publication that touches nothing mounted creates no revision; a
redundant nonempty batch remains a real publication. Mounted document revisions
are structurally shared under the trusted immutability contract. The mount
performs no semantic projection and owns no persistence.

`Conversation.viewState()` exposes the mount as a disposable read-only Chord
state. `Conversation.watch()` exposes the same mount through the serialized
exact-frame watch of section 9.2, with bounded pending frames and full-value
overflow replacements.

### 9.4 Agent events (experimental)

`watchEvents(harness, conversationId, context): Promise<AgentEventStream>`,
exported from the package root, is an experimental adapter that
translates one conversation's committed publications into agent events shaped
like the coding agent's `AgentSessionEvent`s. It owns no tracker or persistence,
covers exactly one conversation (not its owned subtree), and emits an event only
after the commit that makes it true. Its protocol may change without notice.

```ts
type AgentEvent =
  | {
      type: "snapshot";
      entries: readonly EntryRecord[];
      run?: { inputs: readonly SubmissionId[] };
      /** Current generation attempt: its in-flight partial, retry backoff, or deferred poll. */
      generation?: { attempt: number; message?: AssistantMessage; retry?: { at: number; error: string }; deferred?: { pollAt: number } };
      tools: readonly ToolSlot[];
      /** `pi.live.compactions` (section 8.2). */
      compactions: readonly CompactionStatus[];
      inbox: readonly { id: SubmissionId; mode: InboxItem["mode"] }[];
      /** `pi.agent`; `{}` when absent. */
      agent: AgentState;
      usage: UsageState;
    }
  | { type: "run_start"; inputs: readonly SubmissionId[] }
  | { type: "run_end"; inputs: readonly SubmissionId[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      /** A front trim and then an append of the retained window, or its replacement. */
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: JsonValue;
      diagnostics?: readonly ToolDiagnostic[];
    }
  /** `entry` is absent when the tool task faulted or was orphaned. */
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "inbox_update"; items: readonly { id: SubmissionId; mode: InboxItem["mode"] }[] }
  | { type: "submission"; record: SubmissionRecord }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "agent_changed"; agent: AgentState }
  | { type: "usage_changed"; usage: UsageState }
  | { type: "task_failed"; taskId: TaskId; kind: string; message: string }
  | { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
  /** The task's receipt tells whether it produced a summary; the summary entry has its own events. */
  | { type: "compaction_end"; taskId: TaskId; reason: CompactionReason };

/** One change to the in-flight assistant message, relative to that message. */
type MessageChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: AssistantMessage["content"][number] }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
  | { type: "block"; contentIndex: number; block: AssistantMessage["content"][number] }
  | { type: "message"; message: AssistantMessage };

interface AgentEventStream {
  /** The `snapshot` event at attachment. */
  readonly snapshot: Extract<AgentEvent, { type: "snapshot" }>;
  start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
  stop(): Promise<WatchEnd>;
  readonly closed: Promise<WatchEnd>;
}
```

Every event is relative to the `snapshot` and the events before it, never to
Pico's document layout. `snapshot` replaces everything a consumer holds; every
other event applies on top of it. Attachment captures the snapshot and
registers for later publications atomically on the Session line.

Events derive from committed changes:

- `run_start`/`run_end`: `pi.live.run` appears, is removed, or is replaced by a
  successor run whose first input differs. Steers joining the current run and
  handovers between its tasks are not run events. The inputs' outcomes are
  `submission` events.
- `turn_start`: a `pi.generation` task is created. `turn_end`: a generation's
  outcome is committed, when it holds `completing` or becomes terminal,
  whichever comes first, so a successor created at hold starts after it.
- `message_start`: the first committed partial of an attempt, or, for a message
  entry without a committed partial, the entry itself; `message_end` follows for
  every entry with `model` messages. Generation commits a partial only once it has
  content, and every built-in path that clears one appends its entry, so each
  started message ends with its entry. Entries without messages are
  `entry_appended`.
- `message_update`: the Chord operations on the committed partial, translated:
  an insertion into `content` starts blocks, an append to a block's `text` or
  `thinking` is a delta, an append to a string inside a tool call's `arguments`
  is a `toolcall_delta` with the path relative to `arguments`, any other change
  inside a block sends that `block`, which already holds the batch's later
  changes to it, and any other change to `content` sends the whole `message`.
  Each update carries the partial's current `usage`, as the coding agent's JSON
  mode does; a change of only `usage` sends no changes. Only deltas travel, so throttled
  partials cause no write amplification on the wire.
- `tool_execution_start`: a slot becomes `running`; `args` come from the tool
  task's intent checkpoint in the same commit. A slot that becomes `done`
  without running (a call not offered, invalid arguments, a block, a fault
  before intent) gets only `tool_execution_end`. `tool_execution_update`: output
  appends, front trims, and replacements of the slot's retained window, and the
  slot's current `details` and `diagnostics` when they change; removed ones, as
  when a safe replay restarts the tool, send `null` and `[]`.
  `tool_execution_end`: the slot becomes `done`, with its `pi.tool-result`
  entry, which carries the diagnostics, or without one after a fault or
  orphan. An unfinished slot that disappears because its run ended ends with the
  result entry appended in the same commit, as for the unstarted calls of an
  aborted round, directly before its `message_start`, or without an entry.
- `inbox_update`, `agent_changed`, `usage_changed`: the document changed; a
  retired one reads as its initial value, as in a snapshot. Registry installs
  and settings changes make no commit and emit nothing; a UI showing resolved
  tools or a resolved model resolves again through `Conversation.agent()`.
- `auto_retry_start`/`auto_retry_end`, `deferred_poll`: `pi.live.generation`
  gains or drops `retry`, or gains `deferred` or moves its `pollAt`.
- `task_failed`: a task of the conversation settles `faulted` or `orphaned`.
- `compaction_start`/`compaction_end`: a status appears in or disappears from
  `pi.live.compactions`. A retry backoff shows only in the snapshot's
  `compactions`. A queued summary is placed later with its own
  `message_start`/`message_end` and `submission` events.

One commit produces one batch, in this order: `tool_execution_start`,
`message_start` of a first partial, `message_update`, `tool_execution_update`,
and retry/deferred events; then entries in append order with their
`message_start`/`message_end` or `entry_appended`, where a tool result's
`tool_execution_end` directly precedes its `message_start`, as in the coding
agent; then the `tool_execution_end` of tools ending without an entry;
then `compaction_end`, `task_failed`, `turn_end`, `run_end`; then `submission`
events in ID order; then `inbox_update`, `agent_changed`, and `usage_changed`;
and last `compaction_start`, `run_start`, and `turn_start`. A stream buffers at most 100 undelivered
batches; adding another replaces every undelivered batch with one `snapshot` of
the newest committed state. The stream therefore converges but does not promise
every transition; `Submission.wait()` reports exact outcomes. A reconnecting
consumer attaches again and starts from its `snapshot`; nothing is replayed.
Transport backpressure and disconnect policy belong to the consumer.

Print mode awaits its own input `Submission` and prints its answer. A TUI
renders `ConversationView`; events may drive transient animation.

### 9.5 Task graph view

The task graph view shows every live task of the Session as one structural
value, for UIs and debugging: what runs, what waits for what, and which
conversations each task owns. It is to the Session's tasks what the
conversation view (section 9.3) is to one conversation.

```ts
type TaskGraphState =
  | { readonly status: "pending" | "running"; readonly phase: string }
  | {
      readonly status: "waiting";
      readonly phase: string;
      readonly on: readonly TaskId[];
      readonly policy: JoinPolicy;
    }
  /** Outcome held until its ordinary owned work drains (section 5.5). */
  | { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };

type TaskGraphNode = {
  readonly id: TaskId;
  readonly kind: string;
  readonly conversationId: ConversationId;
  /** Owner task; absent for a conversation-owned task. */
  readonly owner?: TaskId;
  readonly background: boolean;
  readonly abortRequested: boolean;
  readonly state: TaskGraphState;
  /** Conversations this task owns, in ID order. */
  readonly conversations: readonly ConversationId[];
};

type TaskGraph = {
  /** Every live task, keyed by its decimal ID. */
  readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

type TaskGraphWatch = WatchHandle<TaskGraph>;

interface Harness {
  taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
  watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}
```

A node holds the committed task record without its input, checkpoint payload,
outcome payload, and memos: `phase` is the checkpoint's phase, `on` and
`policy` are the stored wait, and `outcome` is the held outcome's status.
`running` is the durable status: open changes surviving `running` tasks to
`pending` (section 5.4), so they show as `pending` until the scheduler reserves
them again, while `waiting` and `completing` tasks keep their status. Whether a
pending task is blocked, and which of the tasks in `on` are still live, depend
on the registry and the rest of the graph; `inspect()` derives them. A node is
present from the commit that creates its task until the commit that makes the
task terminal. Owner edges are immutable, so a node's `conversations` only grow
while it lives.

The graph holds live tasks only. A conversation whose owner task is terminal,
such as a background subagent's conversation after its anchor finished, has no
node that lists it; a later task there is a top-level node of that conversation.
A UI that places it under its parent reads the conversation's owner edge from
`ConversationRecord.owner`, which `ConversationView.conversation` also carries.

The Harness keeps at most one graph mount. The first `taskGraph()` or
`watchTaskGraph()` builds its revision on the Session line from the committed
live tasks and the conversations they own, one owner scan per live task, and
holds the line while it does; the mount is dropped when its last observer
detaches. It advances from `subscribeCommits()` publications like the
conversation view: one publication that changes a node yields one Chord batch
that sets or deletes `tasks[id]`, or sets a node's `conversations`. A
publication that changes no node creates no revision. Task and conversation
records are immutable values; a node shares nothing with them.

`taskGraph()` returns the mount as a disposable read-only Chord state.
`watchTaskGraph()` returns it through the serialized exact-frame watch of
section 9.2. Both read only: neither enables scheduling. Close ends them at its
seal like every other state and watch (section 2.2).

```ts
const graph = await harness.taskGraph(context);
graph.subscribe((value) => {
  for (const node of Object.values(value.tasks)) {
    const where = node.owner === undefined ? `conversation ${node.conversationId}` : `task ${node.owner}`;
    render(`${node.id} ${node.kind} ${node.state.status} under ${where}`);
  }
});
```

## 10. Storage contract

Ordered scans are cursor-based. Exact identity lookups are keyed.

```ts
type Page<T, C> = {
  readonly items: readonly T[];
  readonly next?: C;
};

type Cursor = Readonly<Record<string, JsonValue>>;

type ConversationQuery = {
  readonly ownerConversationId?: ConversationId;
  readonly ownerTaskId?: TaskId;
};

type EntryQuery = {
  readonly conversationId: ConversationId;
  readonly minEntryId?: EntryId; // inclusive
  readonly maxEntryId?: EntryId; // inclusive
};

type TaskQuery = {
  readonly conversationId?: ConversationId;
  readonly kind?: string;
  readonly status?: "pending" | "running" | "waiting" | "completing" | "terminal";
  readonly abortRequested?: boolean;
  readonly background?: boolean;
};

type SubmissionQuery = {
  readonly conversationId?: ConversationId;
  readonly status?: SubmissionRecord["status"];
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
  /** Deltas replayed after the selected base to materialize `value`. */
  readonly deltasSinceBase: number;
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
      readonly type: "document.copy";
      readonly record: DocumentCreate;
      readonly source: { readonly id: DocumentId; readonly at: DocumentPoint };
    }
  | {
      readonly type: "document.change";
      readonly id: DocumentId;
      readonly content: DocumentContent;
    }
  | { readonly type: "document.retire"; readonly id: DocumentId };

/**
 * Trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Enforces atomicity, global ID ownership, immutable
 * conversation/entry creation, document record consistency, and detached
 * values; Session serializes commits. Sequences strictly increase but may have
 * gaps. Once commit() resolves, later reads through that Storage observe it.
 */
interface Storage {
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  /** Allocate from the one global numeric namespace; the generic brand is compile-time only. */
  mintId<I extends Id<string>>(): Promise<I>;

  conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<ConversationRecord, Cursor>>;

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<EntryRecord, Cursor>>;

  task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;
  scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<SubmissionRecord, Cursor>>;
  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context): Promise<SubmissionRecord | undefined>;

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;
  document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocumentRecord, Cursor>>;

  close(context: Context): Promise<void>;
}
```

`StorageRejected` means a batch was rejected before any durable effect and is
guaranteed not to have committed. Session rolls such a batch back normally;
unknown failures after Storage admission remain fatal because their commit state
is uncertain. Backends use `StorageRejected` for deterministic `document.copy`
source, replay, and consistency failures only when rollback is guaranteed.

A `document.copy` reads committed pre-batch source state independent of command
order. The source must be an alive conversation document at the selected point,
and kind/key/history/fork must match the child create record. Storage persists
one independent complete child base at the source's stored version. A batch may
not create, change, or retire a selected source. Later source changes,
reclamation, retirement, or backend reopen cannot affect the child.

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
Conversation owner filters are indexed and conjunctive. They support ownership
traversal without an all-conversation scan; application-maintained registries
are not a substitute for these kernel indexes.

`entry(id)` combines exact global lookup with the commit sequence required by
historical document reads. `entry(conversationId, id)` returns that pair only
when the entry is visible through the requested conversation's ancestry. `limit`
is always the maximum page size.
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
newest applicable base, applies its ordered Chord delta tail, and returns the detached materialized value, stored
definition version, and number of replayed deltas after that base. Base/delta records are backend-private. The lookup never
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
- **Writing to a busy conversation:** only the Harness appends to a conversation
  with an active run. Raw entries appended by `Harness.commit()` or a custom
  task while a generation prepares its request can misplace its system prompt entries;
  use a write submission.
- **Queued items after a failed run:** failure and task abort leave the inbox alone.
  Queued follow-ups wait in `pi.inbox`, and their `wait()` does not settle, until
  the next submission's boundary places them or the host withdraws them. A
  compaction summary is such a submission: when a manual or background
  compaction finishes in that idle conversation, its final boundary places the
  waiting follow-ups and starts a run.
- **Compaction spend:** every manual and background compaction pays for one
  summarization request per attempt, also when its summary ends stale because a
  later compaction cut further.
- **Heads and edits during compaction:** a summary reflects the context when its
  compaction selected the range. An application edit placed while it
  summarizes, such as a write replacing entry 20, is lost when the summary cuts
  past its target: the summary still describes the old entry 20, and the edit's
  target leaves the range. An application head placed meanwhile, for example
  one cutting at 85 to forget entries 10-84, is undone by a summary cutting at 90:
  that summary still describes 10-84. Place such writes before compacting.
- **Summary timestamps:** a queued summary's user message carries the time its
  compaction finished, not its placement. Code that judges usage staleness by
  message timestamps, such as pi-ai `estimateContextTokens()` over view
  messages, can misjudge; the Harness estimate uses entry order (section 8.3).
- **Raw head writes into the past:** a head written directly with `tx.appendEntry()`
  that targets an entry before the conversation's active range changes model
  context, but a mounted view keeps only the entries it already holds until the
  mount is rebuilt. Use a write submission, whose stale check rejects it.
- **Double-counted subagent spend:** a tool that runs an owned conversation must
  not report that conversation's usage in its result; the child's `pi.usage`
  already counts it, and subtree sums would count it twice.
- **Owned work holds its owner:** a task that owns live ordinary work stays
  `completing` until that work ends (section 5.5). Foreground work an extension
  starts in a subagent's conversation holds the calling tool, and with it the
  run; interrogating a subagent while its tool is completing extends the hold.
  Esc or a host timeout ends it; work that should not hold its owner is created
  conversation-owned and `background`.
- **Work created by hooks:** hooks run inside the asking task's invocation, so
  work they create owned by that task holds it. Work that must delay a task's
  finish has to be created before the task commits its outcome; a listener
  reacting to published events afterwards cannot extend it. A run task's owned
  work must not write the transcript after the run was released.
- **Compensation in abort handlers:** an abort handler cannot create owned
  children, because its task is abort-marked. Compensate at the level
  that did the effect, in that task's own abort handler, or inline, or through
  background conversation-owned tasks awaited with `waitForTask()`; a
  non-background one would be aborted by any cascade that reaches its
  conversation.
- **Hook memo names:** hooks share the asking task's memo namespace with the
  task and other hooks. Prefix memo names.
- **Long transactions:** an async commit callback holds the Session mutation
  line. Never await models, tools, processes, network calls, humans, a nested
  Session commit, or a Session waiter inside it. Use methods on the current `Tx`.
- **Explicit creation:** only typed `tx.doc()` creates an absent document. Snapshot,
  state, and watch lookup return `undefined` instead.
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
- **Trusted immutable revisions:** `snapshot()`, state values, watch values, and
  their descendants may share tracker-owned containers. Never mutate them; copy
  first when mutable ownership is required. Runtime freezing is not provided.
- **Watch activation:** before `start()`, `watch.value` remains the immutable
  acquisition revision. Initialize the consumer from it first. After start, the
  property advances to each delivered immutable revision before its callback;
  every earlier reference remains stable.
- **Buffered watches:** slow or unstarted watches retain up to 100 exact committed
  frames. Overflow replaces the undelivered suffix with one full-value root
  replacement, so intermediate committed states may be omitted. A consumer that
  must audit every transition must persist each fact in an immutable entry or
  journal and scan that history explicitly.
- **Watch stop:** a listener may call and await `stop()`; it prevents future
  callbacks but neither aborts nor joins the callback already running.
- **Durable progress cadence:** clients see only committed progress. A crash may
  lose the current uncommitted throttle window.
- **Large terminal results:** terminal task records remain queryable. Put large
  results in entries or longer-lived documents and retain only their IDs in the
  outcome. Never reference a task-scoped document retired by that same outcome.
- **Raw transcript:** view entries are not model context. Rendering edits,
  display-only entries, and model filtering require the appropriate reducer.
- **Reserved `pi.` names:** task names, document kinds, and entry kinds starting
  with `pi.` belong to built-ins by convention. Nothing enforces it; reusing one
  collides with Harness behavior, such as `pi.system` entries being replayed as
  system messages.
- **Early resource disposal:** uninstalling or replacing an extension only stops
  new use. Freeing resources immediately can fail calls that are still running.
- **Guards left out of a selection:** a conversation with an array selection
  that omits a guard extension, such as a permissions hook, runs without it.
  Extensions are selected whole; there is no registry-wide hook or wrapper.
- **Selection edits and copies:** `{ add, remove }` always edits the host default
  selection. Written to a child that copied any selection from its owner, an
  array or an `{ add, remove }` object, it replaces that selection, so the child
  gets the host default with the edit, not the owner's selection. Compute the child's array from the resolved agent
  instead (section 7.3).
- **Copies are one-time:** a new task-owned conversation copies its owner's
  `pi.agent` at creation; later owner changes do not reach it. A fork keeps its
  `asOf` copy instead (section 2.2).
- **Environment on recovery:** a tool rerun after recovery builds its
  environment again, with the conversation's current `cwd`, which may differ
  from the first attempt's.
- **Moving default selections:** a conversation on the default selection changes
  whenever the settings or the installed extensions change; each change appends
  `pi.system` entries and misses the provider prompt cache.
- **Unstable prompt text:** a section renderer whose output changes without a
  real content change, for example by embedding the time, appends system deltas
  and defeats provider prompt caching.
- **Non-cooperative code at close:** close joins every invocation. A task
  handler, tool, or hook that ignores its signal keeps `close()` pending and
  Storage open until it returns; cancelling the close wait does not end it.
- **Services outliving the Harness:** withdraw Chord services and detach clients
  before closing the Harness. A state ended by close keeps its last value and
  never updates again.
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
- forced termination of non-cooperative extension code inside one process.
