# Pico handoff v2

Pico is a durable agent harness. This document is the complete implementation specification for
`packages/agent/src/harness/pico/`. Everything is specified except one intentional gap: the exact ordinary
tool API in section 11.1 (how a `ToolDefinition` executes, what facade it receives, how it reaches its output,
memos and children). Its requirements are fixed; its public shape is not, and must not be guessed. Each rule
that is not obvious carries its reason.
Rules that exist only to catch Pico's own bugs are marked as assertions.

Size is a design constraint: production Pico code (everything under `src/harness/pico/` except the memory,
JSONL and SQLite storage implementations and tests) targets 3k–4k lines. The line and the kernel are small by
intent; if an implementation grows materially past 4k, the response is to simplify the design, not to add
caches, index abstractions or helper layers. Storage backends are excluded because their correctness
(fsync, replay, locking) is not compressible.

Read order: glossary, sections 1–4 (data), 5 (commit line), 6–8 (tasks, scheduler, cancellation), 9 (input),
10–12 (core kinds, tools and hooks, system prompt), 13–15 (harness, watch, backends), 16 (state adapter),
17 (tests), 18 (work packages), appendix A (type index), appendix B (changes from v1).

## 0. Glossary

- **Session**: one open storage plus the process-local kernel over it. One process owns a session
  at a time.
- **Harness**: the public object a host uses. One Harness per Session.
- **Conversation**: an ordered transcript. The root conversation has ID 1. A fork has a `parent` pointer
  into its source. A subagent has an `owner` task and may independently choose whether to inherit any
  transcript (`parent`) or start empty.
- **Entry**: one immutable transcript record. Never edited, reordered or deleted.
- **Context**: the message list sent to the model, derived from entries.
- **Task**: one recoverable async operation with durable status `pending | running | terminal`.
- **Kind**: the code for a task (`execute`, `recover`, `abort`) or the type witness for an entry.
- **Core kind**: one of Pico's four privileged built-in task kinds (`pi.generation`, `pi.tool`,
  `pi.post_tools`, `pi.collapse`). Core kinds have direct append and boundary authority; ordinary kinds have
  only the boundary-safe passive `write`.
- **Turn task**: a live `pi.generation`, `pi.tool` or `pi.post_tools`. A conversation with a live turn task
  is *busy* for input admission.
- **Line**: the single FIFO async mutex through which every commit passes.
- **Commit**: one callback that buffers a `Write[]`, followed by exactly one atomic `Storage.commit`.
- **Kick**: a coalesced "look for eligible tasks" signal to the scheduler.
- **Mark**: durable `abort: true` on a task. Marking starts cancellation.
- **Fresh abort**: the new invocation of `kind.abort` that runs after the old invocation has returned.
- **Scratch**: private per-task state, deleted when the task terminates.
- **Output**: shared live state of a task (streaming assistant text, tool progress), kept as Chord deltas.
- **Sticky**: conversation state with only a current value. **Rewindable**: conversation state whose value at
  any historical entry can be read.
- **Inbox**: the per-conversation queue of input that arrived while the conversation was busy.
- **Boundary**: a point in a turn where queued input may be placed into the transcript.
- **Managed entry**: a `pi.system` entry written by system preparation (section 12).
- **Ctx**: Chord's `Context` (cancellation signal, telemetry, invocation identity). Every async operation takes
  it last.

## 1. Data model

All durable payloads are strict JSON:

```ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
interface JsonObject { readonly [key: string]: JsonValue }
type Id = number;   // stable object identity; positive safe integer
type Seq = number;  // storage write order; positive safe integer

import type { JsonRepresentation } from "@earendil-works/chord";
type Stored<T> = JsonRepresentation<T>;   // the durable form of any imported pi-ai type, including unions with primitive arms (UserInput)
```

pi-ai's `AssistantMessage`, `ToolCall`, `Usage`, `DeferredHandle` and friends are interfaces: they have no
index signature and `ToolCall.arguments` is `any`, so they are not assignable to `JsonValue` and cannot be
used directly as task payloads, checkpoints, output state or entry `data`. Pico stores them as `Stored<T>`,
Chord's structural strict-JSON representation (`any`/`unknown` become `JsonValue`, methods disappear,
optional keys stay optional). Mapped and literal object types with optional properties are assignable to the
strict `{ readonly [key: string]: JsonValue }` index signature (verified under strict TypeScript, including
optional, nested and `Record<string, any>` fields), so `JsonObject` stays strict and `{ value: undefined }`
remains a compile error. Strict JSON is validated once at provider/tool ingress; ordinary Pico writes do not
normalize or strip anything. Nothing is duplicated: `Stored<AssistantMessage>` is derived, not redeclared. Public *hydrated* surfaces
(`InputOutcome.answer.message`, hook payloads) hand out the pi-ai type; only durable positions use `Stored<T>`.
Every durable position that carries a pi-ai type uses `Stored<T>`: `Entry.model` and the entry witnesses
(`Stored<UserMessage>`, `Stored<AssistantMessage>`, `Stored<ToolResultMessage>`, `Stored<SystemMessage>`),
`ContextEdit.replace.messages`, `QueuedInput.input` and `StoredEntryDraft` (`Stored<UserInput>`,
`Stored<Message>`), `ToolInput.call`, `GenerationOutput.message`, the deferred handle, `UsageEntryData.usage`,
`Prep.retry`/`Base.retry`, and the `retry` config token. Public surfaces stay pi-ai typed (`SendInput.content:
UserInput`, `InputOutcome.answer.message: AssistantMessage`, hook payloads) and are converted and validated at
admission or hydration. Compile assertions required in WP1, one per durable position: `Stored<UserMessage>`,
`Stored<AssistantMessage>`, `Stored<ToolResultMessage>`, `Stored<SystemMessage>`, `Stored<ToolCall>`,
`Stored<Usage>`, `Stored<DeferredHandle>`, `Stored<RetryPolicy>` each `extends JsonObject`; `Stored<UserInput>
extends JsonValue`; `{ phase: "deferred"; handle: Stored<DeferredHandle> } extends TaskCheckpoint`;
`GenerationOutput extends OutputState`; `ToolInput`, `UsageEntryData`, `QueuedInput`, `StoredEntryDraft`,
`SystemEntryData`, `AssistantEntryData`, `ToolResultData`, `Acceptance`, `SectionRecord`, `ToolControl`,
`ToolDiagnostic` each `extends JsonValue`; `ToolOutputState extends OutputState`, `JobOutput extends OutputState` and `o.stdout = s.stdout` compiles inside a `JobOutput` mutate; every `Task` checkpoint union
in section 10 `extends TaskCheckpoint`; and every entry witness `extends Entry`. In addition, every declaration block in this document is represented in the WP1 compile-only test
(`test/harness/pico/types.compile.ts`, or a dedicated `state-task.compile.ts` for section 16); the compact
payload listings in section 10 are transcribed exactly into named aliases. They must type-check under the
repository `tsconfig` with no `any`: prose that claims exact TypeScript compiles or is wrong. The compile matrix also includes the usage-guide entry example as written (`tx.write(noteKind, { data:
{ text } })` with no `kind`, `tx.write(pinnedKind, { data, model })`, and a `head: "self"` input for a head
witness) and asserts that supplying `kind` or `id` in an `EntryInput` is a compile error. Scope: `defineValue({
type: "shared", id: 1 }, "x")` and `defineList({ type: "shared", id: 1 }, "x")` are `@ts-expect-error` fixtures.
Task creation: `tx.task(kind, { input: { prompt, extra: 1 } })`, `const spec = { input: {...}, extra: 1 };
tx.task(kind, spec)`, `tx.task(kind, { ...spec })` and an `input` with a nested extra top-level field are all
`@ts-expect-error`; the exact literal, variable and spread each compile; `tx.task(coreKind, …)` on a
`BaseTaskTx` is an error while the same call on `CoreTaskTx` compiles. Runtime output:
`TaskRuntime<I,C,never>` has no `output` key (`rt.output` is a compile error) and
`TaskRuntime<I,C,{ text: string }>["output"]` is `TaskOutput<{ text: string }>`; same for the abort runtime with
`ReadonlyTaskOutput`, and for `FinalTx`/`RunningTask`. Negative fixtures
(`// @ts-expect-error`) for the bundle guards: a fake kind map with two kinds sharing a config key, one with a
config key named `set` or `get`, and two kinds sharing a hook point name, each making the corresponding
`Assert<DisjointBundles<FakeConfigs, ReservedConfigKeys>>` or
`Assert<DisjointBundles<FakeHooks>>` fail; plus positive fixtures over the real `CoreConfigs` and `CoreHooks`.

`Id` and `Seq` are separate positive safe-integer domains. IDs are minted by `Storage.nextId()` on the line
before a commit and become valid object identities only when the containing commit succeeds; an ID minted in a
callback that throws must not escape that callback. `Storage.commit` returns exactly one `Seq` per submitted
write, contiguous and ascending, positionally aligned with the `Write[]`, and strictly greater than every
sequence of every earlier commit. Reason: a callback that fails after minting IDs must not leave holes
in the sequence, and a state-only write consumes a sequence without creating an object. Storage keeps a
durable **committed-ID high-water**: after every successful `commit` it raises it to the greatest object ID
(conversation, entry, task, list element) in that batch, and persists it with the batch. On reopen the
allocator starts after the high-water; IDs minted but never committed never reached `commit` and may be
reused, committed IDs never are, including IDs whose only record was in a sidecar that has since been retired
(section 15).

Values passed into Pico are treated as immutable and are not cloned. External boundaries (RPC, plugins)
validate strict JSON before calling Pico.

### 1.1 Conversations

```ts
interface Conversation {
  readonly id: Id;
  readonly parent?: { readonly conversationId: Id; readonly at: Id };  // fork point
  readonly owner?: Id;  // task that created it (subagent); absent for host-created
}
// storage record = Conversation & { readonly sectionSeed?: readonly SectionRecord[] }: private immutable creation metadata
// (rendered section seed, section 8.1) carried by the `conversation.create` write; not part of the public projection.
```

A conversation's logical transcript is its parent's transcript up to and including `parent.at`, recursively,
followed by its own entries. Later parent entries are invisible. A seed with `parent.at: "start"` stores no
`parent` at all: the child has no inherited entries and no fork link (ownership, if any, is `owner`). Tasks,
inbox and scratch are never inherited. `owner` is a capability and cancellation link (section
8), not an execution link.

### 1.2 Entries

```ts
type ContextEdit =
  | { readonly target: Id; readonly action: "omit" }
  | { readonly target: Id; readonly action: "replace"; readonly messages: readonly Stored<Message>[] };

interface Entry {
  readonly id: Id;
  readonly conversationId: Id;
  readonly kind: string;
  readonly byTaskId?: Id;                  // set by Pico when a task appended it
  readonly data?: JsonValue;               // kind-specific payload
  readonly model?: readonly Stored<Message>[];   // pi-ai messages this entry contributes, in durable form
  readonly head?: Id;                      // context starts here (see 1.3)
  readonly edits?: readonly ContextEdit[]; // changes to earlier entries' projection
}

interface EntryKind<E extends Entry = Entry> { readonly kind: string; is(e: Entry | undefined): e is E }
type EntryIdentity = Pick<Entry, "id" | "conversationId" | "kind" | "byTaskId">;   // supplied by Pico and the witness, never by the caller
type EntryInput<E extends Entry> = Omit<E, keyof EntryIdentity | "head"> &
  (E extends { head: Id } ? { readonly head: Id | "self" } : { readonly head?: never });   // `kind` comes from the EntryKind argument
```

The four facets `data`, `model`, `head`, `edits` are materialized. Reason: context derivation must never call
kind code, so an entry of an unknown kind still projects correctly.

```ts
declare function defineEntry<E extends Entry>(kind: string): EntryKind<E>;   // typed witness; `is` narrows by kind string
type EntryBase = EntryIdentity;
// facet aliases for composing witnesses (as in the current WP1 code)
interface EntryData<D extends JsonValue = JsonValue> { readonly data: D }
interface ModelProjection<M extends Message = Message> { readonly model: readonly Stored<M>[] }
interface ContextHead { readonly head: Id }
interface ContextEdits { readonly edits: readonly ContextEdit[] }
type UserEntry       = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly data?: { readonly continuation: true; readonly from: Id } };   // data only on yield continuations
type AssistantEntry  = EntryBase & { readonly model: readonly [Stored<AssistantMessage>]; readonly data?: AssistantEntryData };
type ToolResultEntry = EntryBase & { readonly model: readonly [Stored<ToolResultMessage>]; readonly data: ToolResultData };
type SystemEntry     = EntryBase & { readonly model: readonly [] | readonly [Stored<SystemMessage>]; readonly data: SystemEntryData; readonly edits?: readonly ContextEdit[] };
type NoticeEntry     = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly data?: JsonValue };
type SummaryEntry    = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly data: { readonly through: Id }; readonly head: Id };
type HandoffEntry    = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly head: Id };
type ResetEntry      = EntryBase & { readonly head: Id };
```

Built-in kinds:

| kind | model | head | data |
|---|---|---|---|
| `pi.user` | `[UserMessage]` | | `{ continuation: true; from: Id }` on yield continuations only |
| `pi.assistant` | `[AssistantMessage]` | | `AssistantEntryData` (attempt count; usage lives on the message) |
| `pi.tool_result` | `[ToolResultMessage]` | | `ToolResultData` |
| `pi.system` | `[SystemMessage]` or `[]` | | `SystemEntryData` (section 12) |
| `pi.notice` | `[UserMessage]` | | optional |
| `pi.usage` | `[]` | | `UsageEntryData = { attempt: number; usage?: Stored<Usage>; error: string }` (failed generation attempt) |
| `pi.summary` | `[UserMessage]` | yes | `{ through: Id }` |
| `pi.handoff` | `[UserMessage]` | yes | |
| `pi.reset` | `[]` | yes | |

Assistant entries with `stopReason` `"error"` or `"aborted"` may be stored for display but never enter a
model request and never create tool work. `"pending"`/`"deferred"` are never stored as entries.

### 1.3 Context derivation

For conversation `c` and inclusive target `T`:

```text
H       = newest fork-visible entry at or before T with a head
from    = H ? H.head : transcript start
range   = fork-visible entries from `from` through T
edits   = per target, newest edit in range wins
entries = H ? [H, ...range without any head entries] : range
model   = concat(entries.map(e => edits[e.id] ? apply : e.model)), then reorder tool results
request = { messages: model }        // no top-level systemPrompt or tools; see section 12
```

`head: "self"` on append means "context starts at this entry" (reset, handoff). A summary's head points at
the first retained entry after the summarized prefix, so the summary appears, then the tail.

Tool-result ordering: results are appended as tools finish, so transcript chronology may not match the
assistant's call order. Projection reorders results into call order. If a fork cut an exchange before all
results landed, projection synthesizes `ToolResultMessage { isError: true, text: "Tool result unavailable:
history ends before this call completed.", details: { reason: "missing_after_fork" } }` per missing call.
Synthesized results are never stored.

A model request captures the entry ID list and effective messages at a durable cutoff and does not change
afterward. Reason: a generation must know exactly what it sent for recovery and for hooks. A current-context
cache is disposable derived state; historical derivations for older cutoffs read storage and never rewind the
live cache.

### 1.4 Who appends, and where

Only core task kinds append entries directly (`CoreTaskTx.entry`). Everyone else, host and ordinary tasks
included, goes through `write` (section 9): the entry is appended immediately if the conversation is not
busy, otherwise it is queued and placed at the next boundary. There is no host `entry()`.

Reason: every boundary sits between complete exchanges, so an entry placed at a boundary can never split an
assistant/tool-result block. Removing direct host appends removes the only path by which that could happen.

Transcript invariants, maintained by core kinds and asserted before persistence (section 5.2):

- Heads only move forward: a new head never points before the previous head's target. Otherwise context
  could grow back after a collapse.
- A head never splits an exchange: it keeps an assistant with all its results or omits both. Collapse
  guarantees this by choosing `through` at an exchange end.
- Edits target earlier visible entries. Edits never target managed `pi.system` entries, except the omission
  edits a fresh baseline carries for superseded managed entries (section 12.4).
- Tool-call IDs within one assistant are unique; at most one result per call, in the same conversation.

The one runtime check on non-core data is on a queued `write` that carries a `head` (reset, handoff): at
placement, the head target must still be visible and not before the current newest head. A collapse
committed while the write was queued can violate that. The write is then dropped with result
`unanswered/stale`. Edits whose targets have left the context are no-ops and do not stale.

## 2. Scoped state

```ts
type Scope =
  | { readonly type: "session" }
  | { readonly type: "conversation"; readonly conversationId: Id }
  | { readonly type: "task"; readonly taskId: Id }      // scratch
  | { readonly type: "shared"; readonly id: Id };       // task output

declare const addressType: unique symbol;   // compile-only payload witness; never present at runtime, never serialized
interface Address<T extends JsonValue = JsonValue> {
  readonly scope: Scope; readonly namespace: string; readonly key?: string;
  readonly kind: "value" | "list"; readonly rewind: boolean;
  readonly [addressType]?: T;                           // makes Value<string> and Value<number> distinct types
}
interface Value<T extends JsonValue> extends Address<T> { readonly kind: "value"; readonly default?: T }
interface List<T extends JsonValue> extends Address<T> { readonly kind: "list" }
interface Element<T extends JsonValue> { readonly id: Id; readonly value: T }

type PublicScope = Exclude<Scope, { type: "shared" }>;                    // exported constructors never accept shared scope
type StickyScope = Extract<PublicScope, { type: "session" | "task" }>;
type ConversationScope = Extract<PublicScope, { type: "conversation" }>;
// `defineValue({ type: "shared", id }, ...)` is a compile error and runtime rejection; the task-output list is built by an internal constructor
// external constructors reject every `pi.*` namespace at runtime
type DefaultedUnboundValue<T extends JsonValue, R extends boolean> = Omit<UnboundValue<T, R>, "bind" | "default"> & { readonly default: T; bind(conversationId: Id): Value<T> & { readonly default: T } };
declare function defineValue<T extends JsonValue>(scope: StickyScope, namespace: string, options: { readonly key?: string; readonly default: T }): Value<T> & { readonly default: T };
declare function defineValue<T extends JsonValue>(scope: StickyScope, namespace: string, options?: { readonly key?: string }): Value<T>;
declare function defineValue<T extends JsonValue>(scope: ConversationScope, namespace: string, options: { readonly key?: string; readonly rewind: boolean; readonly default: T }): Value<T> & { readonly default: T };
declare function defineValue<T extends JsonValue>(scope: ConversationScope, namespace: string, options: { readonly key?: string; readonly rewind: boolean }): Value<T>;
declare function defineList<T extends JsonValue>(scope: StickyScope, namespace: string, options?: { readonly key?: string }): List<T>;
declare function defineList<T extends JsonValue>(scope: ConversationScope, namespace: string, options: { readonly key?: string; readonly rewind: boolean }): List<T>;
// one public type argument (T); rewind is a literal picked by overload, so `conversationValue<boolean>("x", { rewind: true })` infers UnboundValue<boolean, true>
declare function conversationValue<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: true;  readonly default: T }): DefaultedUnboundValue<T, true>;
declare function conversationValue<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: false; readonly default: T }): DefaultedUnboundValue<T, false>;
declare function conversationValue<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: true }): UnboundValue<T, true>;
declare function conversationValue<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: false }): UnboundValue<T, false>;
declare function conversationList<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: true }): UnboundList<T, true>;
declare function conversationList<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly rewind: false }): UnboundList<T, false>;
declare function sessionValue<T extends JsonValue>(namespace: string, options: { readonly key?: string; readonly default: T }): Value<T> & { readonly default: T };
declare function sessionValue<T extends JsonValue>(namespace: string, options?: { readonly key?: string }): Value<T>;
```

`default` is resolution metadata, not identity: every reader that resolves this definition (`c.value`,
`c.config.<x>`, `view.config`, core kinds) returns `default` when no value is stored or the value was
deleted. It lives on the token, so there is exactly one place a default is spelled.

Storage and every `Write` carry fully bound addresses; the unbound form exists only at the public surface.
`ConversationHandle.value`/`list`, `ConversationTx.value`/`list`, `TaskConversation.value`/`list`,
`SeedWrite` in `rootValues`/`ConversationSeed.values`, and `ConversationWatchOptions.values` accept a
bound address or an unbound one, which they bind to their own or target conversation before anything reaches
the kernel. A bound address naming a different conversation than the handle's is a `ScopeViolation`. Reason:
plugins and core kinds declare one token and use it against any conversation; `generationKind.config.model` is
one definition, not one per conversation.

Identity is `[scope.type, scope id, kind, rewind, namespace, key ?? null]`. Omitted `key` and `key: undefined`
are the same unkeyed singleton; `key: ""` is a distinct keyed member. Only conversation scope may be
`rewind: true`. Public constructors create session, conversation and (for a task's own runtime) task-scope
addresses only; shared scope is internal to `TaskOutput` in v1 and has no public constructor.

The namespace prefix `pi.` is reserved for built-ins: external constructors reject it, so a plugin cannot
define `pi.anything`. Within it there are exactly two sets: (1) the fixed kinds' config bundle definitions
(`generationKind.config.*` and the other core bundles, section 2.1) are exported tokens usable through every
generic handle and automatically part of `view.config`; they are rejected in requested watch `values` because
they already have their own field and event. (2) The internals `pi.inbox`, `pi.input_result`, `pi.request`,
and `pi.output` are protected: generic read/write/watch/`rootValues` reject them and they surface only through
`view.inbox`, `InputHandle` and `view.taskOutputs`. Plugin and
application definitions (any non-`pi.` namespace) are public and appear in a watch only when requested. There
is no access metadata on definitions and no access registry.

Values: set / delete. Lists: append / remove / clear. Rewindable state records every write with its `Seq`.
`get(address, at)` with an entry ID resolves `at` to that entry's `Seq` and returns the newest write at or
before it, recursing into the parent capped at `min(at, parent.at)`. Sticky state has only a current value;
historical reads of sticky/session/task/shared state reject `InvalidHistoryPosition`. Forks inherit
rewindable state through the parent walk; sticky *values* are inherited only by an explicit copy at creation
(`copySticky`, section 8.1); sticky lists are never copied in v1.

**Rewindable writes precede entry appends within one commit.** Reason: a fork at that entry must see the
state written "with" it and not state written after it. The builder throws on violation.

Who may write which scope:

| writer | session | own conversation subtree | other conversation | own scratch | shared |
|---|---|---|---|---|---|
| host | yes | yes (all) | yes | no | no |
| task (execute/recover) | yes | yes | no | yes | via `output` only |
| task (abort) | yes | yes | no | read only | read only |

### 2.1 Typed configuration bundles

There is no untyped settings object. Each core kind exports a typed bundle of unbound conversation addresses.
The public `conversation.config` facade is assembled from those bundles mechanically, so core tasks and the
public API read and write identical addresses and nothing is declared twice.

```ts
// the bundles the fixed kinds attach as `<kind>.config` (definition objects; the internal constructor is allowed to use pi.* names)
const generationConfig = {
  model:         conversationValue<ModelRef>("pi.model", { rewind: true }),                    // no default -> no_model
  thinkingLevel: conversationValue<ThinkingLevel>("pi.thinking", { rewind: true, default: "off" }),
  selectedTools: conversationValue<readonly string[]>("pi.tools.selected", { rewind: true, default: [] }),
  profile:       conversationValue<string>("pi.prompt.profile", { rewind: true, default: "default" }),
  retry:         conversationValue<Stored<RetryPolicy>>("pi.generation.retry", { rewind: false,
                   default: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 } }),   // pi-ai RetryPolicy; coding-agent defaults
} satisfies ConfigBundle;
const postToolsConfig = {
  steeringMode:  conversationValue<"all" | "one-at-a-time">("pi.queue.steering", { rewind: false, default: "one-at-a-time" }),
  followUpMode:  conversationValue<"all" | "one-at-a-time">("pi.queue.follow_up", { rewind: false, default: "one-at-a-time" }),
} satisfies ConfigBundle;
const toolConfig = {} satisfies ConfigBundle;   // the tool time budget belongs to the gated ordinary tool API (11.1); nothing in v1
const collapseConfig = {
  threshold:     conversationValue<number>("pi.collapse.threshold", { rewind: true, default: 0 }),   // context tokens; 0 = never
  keepRecent:    conversationValue<number>("pi.collapse.keep_recent", { rewind: true, default: 20_000 }),   // tokens retained after `through`
} satisfies ConfigBundle;
// generationKind.config === generationConfig, etc. (section 10 kinds are defined with these as `config`)

// derived from the fixed bundle map, not declared. The map is over the bundle constants, not the kind tokens:
// hook payloads mention `Settings`, so deriving Settings from `typeof generationKind` (which carries hooks) would be circular.
interface CoreConfigs { readonly generation: typeof generationConfig; readonly tool: typeof toolConfig; readonly postTools: typeof postToolsConfig; readonly collapse: typeof collapseConfig; readonly job: {} }
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type CoreConfigBundle = UnionToIntersection<CoreConfigs[keyof CoreConfigs]>;
type _ConfigsMatchKinds = Assert<{ [K in keyof CoreConfigs]: CoreTaskKinds[K]["config"] extends CoreConfigs[K] ? true : false }[keyof CoreConfigs]>;   // the kinds attach exactly these bundles

type BundleValues<B> = { [K in keyof B]: B[K] extends ConversationValueDefinition<infer T, boolean> ? T : never };   // payload types (for set patches)
type ResolvedValue<D> = D extends { readonly default: infer V } ? V : PayloadOf<D> | undefined;   // bound or unbound; defaulted members never undefined
type ResolvedValues<B> = { readonly [K in keyof B]: ResolvedValue<B[K]> };
type Settings = BundleValues<CoreConfigBundle>;

// compile-time guards, checked where CoreTaskKinds is assembled:
type ReservedConfigKeys = "set" | "get";
type Assert<T extends true> = T;   // the only way to make a type-level check a compile error
// M is a map of bundles (CoreConfigs or CoreHooks); each member is one kind's bundle
type KeysOf<U> = U extends unknown ? keyof U : never;   // distribute over the other bundles; `keyof (A | B)` alone is only their common keys
type Collides<M, N extends keyof M, Reserved extends PropertyKey> =   // true iff bundle N shares a key with another bundle (or uses a reserved name)
  [Extract<keyof M[N], KeysOf<M[Exclude<keyof M, N>]> | Reserved>] extends [never] ? false : true;
type AnyCollision<M, Reserved extends PropertyKey> = true extends { [N in keyof M]: Collides<M, N, Reserved> }[keyof M] ? true : false;
type DisjointBundles<M, Reserved extends PropertyKey = never> = AnyCollision<M, Reserved> extends false ? true : false;   // boolean, never `never`
type _AssertDisjointConfig = Assert<DisjointBundles<CoreConfigs, ReservedConfigKeys>>;   // compile error on any duplicate or set/get; also asserted at install time

type ConfigFacade<B> = {
  readonly [K in Exclude<keyof B, ReservedConfigKeys>]: B[K] extends ConversationValueDefinition<infer T, infer R>
    ? (R extends true ? PublicValue<T, ResolvedValue<B[K]>> : StickyPublicValue<T, ResolvedValue<B[K]>>)   // bound to this conversation; get() returns the resolved type
    : never;
} & {
  set<P extends Partial<BundleValues<B>>>(patch: NoExtra<Partial<BundleValues<B>>, P>, ctx: Context): Promise<void>;  // one commit
  get(ctx: Context): Promise<ResolvedValues<Omit<B, ReservedConfigKeys>>>;                                        // one batched read, current, defaults resolved
};

// ConversationHandle.config: ConfigFacade<CoreConfigBundle>. Usage:
//   c.config.model.get(ctx)                     current
//   c.config.model.get(entryId, ctx)            historical: rewindable members only, typed
//   c.config.followUpMode.get(ctx)              sticky: no historical form
//   c.config.model.set(ref, ctx)                one value, one commit
//   c.config.set({ model, thinkingLevel, followUpMode }, ctx)   exact typed partial, one commit
```

Each property of `c.config` is the conversation-bound public value for that address, identical to
`c.value(generationKind.config.model)`; core kind code reads the same definitions through `tx.value(
generationKind.config.model)` in its own conversation. Bundle members are reusable
`ConversationValueDefinition<T, R>` tokens (namespace, key, rewind, payload type; no conversation ID); the
handle or transaction binds them, and storage only ever sees bound addresses. Flattened property names must be
unique across the fixed kinds and must not be `set` or `get`; both are compile errors (`Assert<DisjointBundles<…>>`
resolves to `false`, which does not satisfy `extends true`) and are re-asserted when the core kinds are installed
at open. Plugin configuration is not merged into `c.config`;
plugins keep their own bundles and use `c.value(token)`. `ConversationSeed.values` (section 8.1) accepts the
same tokens, so an owned child is seeded with exactly these definitions before its first input.

Model, thinking level, selected tools, profile and collapse thresholds are rewindable: a fork at yesterday's
answer gets yesterday's model. Queue modes and the retry policy are sticky: they describe how the UI wants
the present handled, not history. Defaults are on the tokens above and are what `get`, `view.config` and the
core kinds observe when nothing is stored; queue modes default to `"one-at-a-time"` (matching the current
`Agent`/coding-agent defaults). `model` has no default: a missing model is a typed `no_model` generation
failure, not a fault.

Generation tasks never copy configuration into their input; they read it at preparation and record in their
checkpoint only what recovery needs to resend the same request (`Prep`, 10.1: model, thinking level, offered
tool names, retry policy, cutoff, system entry, attempt).

## 3. Tasks

### 3.1 Records

```ts
interface TaskCheckpoint extends JsonObject { readonly phase: string }

type TaskOutcome<R extends JsonValue = JsonValue, F extends JsonValue = JsonValue, A extends JsonValue = JsonValue> =
  | { readonly status: "completed"; readonly result: R } | { readonly status: "failed"; readonly failure: F }
  | { readonly status: "aborted"; readonly result: A }   | { readonly status: "orphaned" };

interface StoredTaskOutputRef { readonly id: Id; readonly kind: string }
interface TaskBase<I extends JsonValue = JsonValue, C extends TaskCheckpoint = TaskCheckpoint> {
  readonly id: Id; readonly conversationId: Id; readonly kind: string;
  readonly input: I;                    // immutable
  readonly checkpoint?: C;              // full replacement each time
  readonly after: readonly Id[];        // dependencies, immutable, acyclic
  readonly background?: true;           // excluded from idle and foreground cancellation
  readonly owns: readonly Id[];         // conversations this task created
  readonly output?: StoredTaskOutputRef;
  readonly abort?: true;                // the mark
}
type Task<I extends JsonValue = JsonValue, C extends TaskCheckpoint = TaskCheckpoint,
          R extends JsonValue = JsonValue, F extends JsonValue = JsonValue, A extends JsonValue = JsonValue> =
  TaskBase<I, C> & (
    | { readonly status: "pending" | "running"; readonly outcome?: never }   // live: never carries an outcome
    | { readonly status: "terminal"; readonly outcome: TaskOutcome<R, F, A> }  // terminal: always carries one
  );
```

Bare `Task` (all defaults) is the erased form used by storage, scans, the watch view and host inspection;
status and outcome are correlated by the union, so a pending task cannot carry an outcome and a terminal task
cannot omit one.

A checkpoint is the *entire* recovery state; each update replaces it whole. `phase` is a kind-defined tag the
kernel never interprets. There is no event log or replay: only the latest checkpoint is durable. Reason: a
full snapshot is trivially recoverable and inspectable; partial patches need a merge algorithm and break on
shape changes.

### 3.2 Lifecycle

```text
1. create      task.create {status: pending}                       durable
2. reserve     task.set {status: running}                           durable, before any effect
3. run         kind.execute(task, runtime, ctx)  -- or kind.recover if step 2 was found on reopen
               may commit checkpoints, scratch, output deltas, child tasks
4. close       execute returns a closure; kernel runs it on the line; it buffers writes and returns
               completed|failed; kernel appends the terminal task.set; one atomic commit
5. cancel      mark -> revoke old writes -> signal ctx -> join old invocation -> reserve fresh abort
               kind.abort(task, abortRuntime, ctx) returns a closure; aborted outcome; one atomic commit
```

Recoverability means: a `running` task found at reopen gets `recover`, with or without a checkpoint. It does
not mean exactly-once external effects. A crash after an unkeyed external call but before recording its
result is uncertain; kinds that need certainty record a request key in a checkpoint *before* the call
(`phase` naming an in-flight effect) and reconcile in `recover`.

### 3.3 Kinds

```ts
type OutputState = JsonObject | JsonValue[];   // mutable JSON container; Chord tracks it, storage persists its deltas
type ConfigBundle = Record<string, ConversationValueDefinition<JsonValue>>;
declare const taskKindBrand: unique symbol;

interface TaskKindMethods<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue,
                          A extends JsonValue, O extends OutputState, H extends HookPoints> {
  readonly kind: string;
  readonly hooks?: H;                                    // typed hook points this kind invokes (section 11.2)
  readonly config?: ConfigBundle;                        // conversation-value definitions this kind reads (section 2.1)
  execute(task: RunningTask<I,C,O>, rt: TaskRuntime<I,C,O,H>, ctx: Context): Promise<TerminalClosure<I,C,R,F,O>>;
  recover(task: RunningTask<I,C,O>, rt: TaskRuntime<I,C,O,H>, ctx: Context): Promise<TerminalClosure<I,C,R,F,O>>;
  abort  (task: RunningTask<I,C,O>, rt: AbortTaskRuntime<I,C,O,H>, ctx: Context): Promise<AbortClosure<I,C,A,O>>;
}
interface CoreTaskKindMethods<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue,
                              A extends JsonValue, O extends OutputState, H extends HookPoints> {
  readonly kind: string; readonly hooks?: H; readonly config?: ConfigBundle;
  execute(task: RunningTask<I,C,O>, rt: CoreTaskRuntime<I,C,O,H>, ctx: Context): Promise<CoreTerminalClosure<I,C,R,F,O>>;
  recover(task: RunningTask<I,C,O>, rt: CoreTaskRuntime<I,C,O,H>, ctx: Context): Promise<CoreTerminalClosure<I,C,R,F,O>>;
  abort  (task: RunningTask<I,C,O>, rt: CoreAbortTaskRuntime<I,C,O,H>, ctx: Context): Promise<CoreAbortClosure<I,C,A,O>>;
}

type TaskKind<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
              O extends OutputState = never, H extends HookPoints = {}> =
  TaskKindMethods<I,C,R,F,A,O,H> & TaskOutputDefinition<I,O> & { readonly [taskKindBrand]: "ordinary" };
type CoreTaskKind<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
                  O extends OutputState = never, H extends HookPoints = {}> =
  CoreTaskKindMethods<I,C,R,F,A,O,H> & TaskOutputDefinition<I,O> & { readonly [taskKindBrand]: "core" };

// shared constraint list, used verbatim by every task-typed alias below and in sections 16 and appendix A:
//   I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
//   O extends OutputState, H extends HookPoints
type TaskKindDefinition<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
                        O extends OutputState, H extends HookPoints> = Omit<TaskKind<I,C,R,F,A,O,H>, typeof taskKindBrand>;
type CoreTaskKindDefinition<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
                            O extends OutputState, H extends HookPoints> = Omit<CoreTaskKind<I,C,R,F,A,O,H>, typeof taskKindBrand>;

declare function defineTask<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue,
                            A extends JsonValue, O extends OutputState = never>():
  <H extends HookPoints, D extends TaskKindDefinition<I,C,R,F,A,O,H>>(definition: NoExtra<TaskKindDefinition<I,C,R,F,A,O,H>, D>)
    => D & TaskKind<I,C,R,F,A,O,H>;                       // H and D["config"] inferred from the literal; brand added
declare function defineCoreTask<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue,
                                A extends JsonValue, O extends OutputState = never>():
  <H extends HookPoints, D extends CoreTaskKindDefinition<I,C,R,F,A,O,H>>(definition: NoExtra<CoreTaskKindDefinition<I,C,R,F,A,O,H>, D>)
    => D & CoreTaskKind<I,C,R,F,A,O,H>;                   // internal; not a plugin API
```

`defineTask` returns an ordinary kind, `defineCoreTask` a core kind; the returned type is `D & TaskKind<...>`,
so `kind.hooks` and `kind.config` keep the exact literal bundle types (that exactness is what `c.config`,
`c.hook`, `ConfigEvent` and `CoreTaskKinds` derive from). Only the fixed core bundles flatten onto
`c.config`/`view.config`; a plugin kind's bundle is accessed through `c.value(kind.config.x)`. Core kinds
receive `CoreTaskTx` (direct entry append, core child creation, admission and boundary helpers); ordinary kinds
receive `BaseTaskTx` (passive `write` only). The private `taskKindBrand` symbol makes the two non-interchangeable.
Reason for the split: plugins must not be able to append mid-exchange, resolve input groups or create turn
tasks; a type-level brand plus separate runtime constructors makes that unforgeable without runtime checks. The
passive `write` is safe to hand out because it only ever lands at a boundary.

`TaskOutputDefinition<I,O>` (appendix A) makes `output` required when `O` is declared and forbidden otherwise.
Task creation goes through `TaskCreator` (5.3): `NoExtra` on the spec and `ExactJsonInput` on `input` reject
visible extra fields whether the argument is a literal, a variable or a spread. Excess-property checking on task specs and inputs (`NoExtra`, `ExactJsonInput`)
is applied so that visible extra fields reject at compile time. Deep exactness, casts and erased fields remain
ordinary TypeScript limits.

### 3.4 Output

Output is the live, shared, observable state of a task: the assistant message being streamed, a tool's
progress, a job's stdout tail. It is one Chord tracker per output ID; every nonempty flush is appended as one
delta to the protected shared list built by Pico's internal address constructor (`pi.output`).

- A kind declares `output: { kind, initial(input) }` with `O extends OutputState` (a plain JSON object or
  array; no `Date`, `Map`, class instances or functions, because the durable form is Chord deltas over strict
  JSON). On creation with no `output` ref, the task's output ID is its own ID and the first list element is
  `track(initial(input)).flush()`, committed with `task.create`. `initial` is pure and synchronous; its return
  value is transferred to the tracker and must not be retained. One boundary assertion: the kernel asserts that
  `initial`'s result and every `replace` value are strict JSON before handing them to the tracker; a violation
  faults the session (kind contract error).
- A task may be created with another live task's `output` ref (same `kind` string). Both write the same
  tracker. Use: a tool times out, creates a background job with its own ref, and the job keeps writing where
  the tool left off.
- The output lives while any live task references it and is deleted in the same commit that terminalizes the
  last reference. The terminal closure of that last task receives the final value as `tx.output` so it can
  materialize it (e.g. into the assistant entry) atomically. A retired output ID is never resurrected.
- Runtime facade: `output.read(ctx)`, `output.mutate(state => { ... }, ctx)`, `output.replace(value, ctx)`.
  `read` and terminal `tx.output` return immutable snapshots, never the tracker target or a proxy. `mutate`
  runs the callback synchronously on the line against the tracker proxy; the callback must not be
  async, retain the proxy, or call other runtime methods. If it throws, or if flushing/strict-JSON validation
  of the mutated state fails, the session faults: the tracker is now in an unknown state and the only safe
  recovery is reopen from durable deltas. These are task-contract faults, not domain failures. Only a **nonempty** tracker
  flush creates a `pi.output` list element, consumes a `Seq` and emits a `task_output` event; a `mutate` whose
  callback changes nothing tracked yields an empty flush and returns normally with no storage commit and no
  event: an empty `Write[]` is never passed to storage and an empty `Op[]` is never persisted. `replace(value)`
  is an explicit replacement: after strict-JSON validation it always persists Chord's full base flush (`["r",
  value]`), even if the value is structurally equal to the current state; Pico does no deep-equality check.
- After a task is marked, its `output` facade rejects. Fresh abort gets `read` only.
- Replay: fold list elements with `applyImmutable()`, hydrate one tracker, consume its synthetic first flush
  locally (do not persist it).
- Each protected append emits one `task_output` watch event with that exact decoded delta. An output may be
  referenced by tasks in different conversations (a tool in A hands its output to a job it created in owned
  conversation B). A conversation watch tracks outputs by *local* reference: when a `task_start`/`task_update`
  introduces an output ID that no live task in this conversation referenced before, the envelope carries a
  synthetic full-base `task_output` (`[["r", currentValue]]`) for that ID before the task event, so the
  reducer can populate `view.taskOutputs` without a persisted append; when the last local reference ends the
  reducer drops the output even if another conversation still holds it. The synthetic base is derived on the
  line from the live tracker and is never stored.

Reason for deltas over snapshots: a long assistant message would otherwise be rewritten in full on every
token. V1 does not compact or rebase an active output log; measure first, and reclaim the whole log only when
its final live reference retires.

## 4. Storage

Storage is mechanical. It applies a `Write[]` atomically, assigns sequences, maintains indexes, and answers
queries. It never runs kind code and never validates application payloads.

```ts
type Write =
  | { type: "conversation.create"; conversation: Conversation & { readonly sectionSeed?: readonly SectionRecord[] } }   // private metadata, see 1.1
  | { type: "entry.append"; entry: Entry }
  | { type: "task.create"; task: NewTask }
  | { type: "task.set"; task: Task }                       // complete replacement
  | { type: "value.set"; address: Value<JsonValue>; value: JsonValue }
  | { type: "value.delete"; address: Value<JsonValue> }
  | { type: "list.append"; address: List<JsonValue>; element: Element<JsonValue> }
  | { type: "list.remove"; address: List<JsonValue>; elementId: Id }
  | { type: "list.clear"; address: List<JsonValue> };

interface Storage {
  nextId(): Id;
  commit(writes: readonly Write[], ctx: Context): Promise<readonly Seq[]>;  // one Seq per write, aligned
  getConversations(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Conversation>>;
  scanConversations(query: ConversationScan, ctx: Context): Promise<Page<Conversation>>;
  getEntries(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Entry>>;
  scanEntries(query: EntryScan, ctx: Context): Promise<Page<Entry>>;
  newestHead(conversationId: Id, at: Id, ctx: Context): Promise<Entry | undefined>;
  getTasks(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Task>>;
  scanTasks(query: TaskScan, ctx: Context): Promise<Page<Task>>;
  getValue<T extends JsonValue>(address: Value<T>, at: Id | undefined, ctx: Context): Promise<T | undefined>;
  readList<T extends JsonValue>(address: List<T>, at: Id | undefined, ctx: Context): Promise<readonly Element<T>[]>;
  close(ctx: Context): Promise<void>;   // releases files/locks; idempotent; called by the Session on close/fault, never by hosts directly
}
```

Query rules:

- Conversation and task scans ascend by ID; `cursor` is an exclusive lower bound.
- Entry scans are fork-aware and newest-first; `through` is an inclusive upper bound, `cursor` an exclusive
  upper bound; `kind` filters before `limit`. `through`, `cursor`, and `newestHead`'s `at` must name a
  fork-visible entry of the scanned conversation or the read rejects `InvalidHistoryPosition`. `newestHead`
  is the dedicated "newest entry with a head at or before `at`" query so context derivation never tails a scan.
- `readList` returns the complete logical list ascending by element ID. No paging.
- Pages carry no snapshot sequence. Reason: reads happen on the line or against immutable history; a
  multi-page snapshot protocol is unnecessary.
- List removal targets an element of the *logical* list at the write position: an element appended locally or
  inherited from a fork parent within that list's lineage (same definition, ancestor conversation, at or before
  the fork cap). Removing a visible inherited element is valid and records a local removal (the parent is
  untouched); removing an element already removed in this lineage is idempotent and still consumes a sequence.
  An ID that never existed, or that belongs to a different definition or an unrelated conversation's list,
  rejects. Clear on an empty list is valid.

Storage side effects on `task.set` to terminal: delete the task's scratch scope; delete each shared output
that no live task references after this batch. Reading retired scratch rejects `ScratchRetired`; reading a
retired output rejects `OutputRetired`, in every backend.

Empty `Write[]` is never passed to storage. An uncertain commit failure (storage threw after possibly
writing) poisons the session: fail-stop, never retry the callback.

## 5. The commit line

One FIFO async mutex serializes every commit, every `nextId()` call, every reservation, mark, registry change,
watch capture and waiter registration. Only explicit transaction builders run while the line is held; kind
methods, hooks, signals/listeners and other application callbacks never do.

```text
enter line (caller ctx checked before entering and again before the callback)
build a capability-bound tx with an empty Write[]
run callback
  explicit reads (tx.getTask, tx.value().get, ...) await committed storage — allowed only before the first write
  writes buffer synchronously; creations call Storage.nextId() synchronously
  on throw: discard Write[], minted IDs stay burned, rethrow
validate and assert (section 5.2)
Storage.commit(Write[], internalCtx)  -- exactly once, non-cancellable
apply to in-memory indexes; kick scheduler; resolve waiters
leave line
dispatch signals/listeners; resolve caller
```

### 5.1 Read before write

A transaction may read committed state only until its first buffered write; a later explicit read rejects
`ReadAfterWrite`. Reason: there is no read-your-writes overlay. Allowing reads after writes would either
require the kernel to merge the pending `Write[]` into every query (a second storage engine) or return stale
answers that silently disagree with what the callback just wrote. Authors read first, decide, then write,
carrying the values they wrote in local variables. A builder validation failure poisons that transaction:
catching `ReadAfterWrite`, a pending-read write, or a rewindable-after-entry error does not permit earlier
buffered writes to commit. The builder does remember its own same-batch creations for validation (a task
created earlier in the batch is a valid `after` target), but does not expose them as reads.

Reads while holding the line block every other commit. Keep them small and few. Entering any Session line
from inside an active Session callback rejects `NestedLineOperation` immediately; use only the supplied `tx`.

### 5.2 What the Session checks

**Validation** (capability or lifecycle; a failure rejects the commit, the session continues):

| check | why |
|---|---|
| tx capability: ordinary tx has no `entry`/admission/core creation, only passive `write`; abort tx has no task creation or `write` | plugin isolation (by construction, not a check) |
| address scope: conversation address must be in writer's subtree; task address must be writer's own; protected `pi.*` internals rejected for non-internal writers | capability |
| invocation identity: task tx/runtime ctx carries the current invocation object; stale or foreign rejects | cancellation correctness (section 7) |
| task marked: normal commit/scratch/output from a marked invocation rejects | cancellation correctness |
| rewindable writes before entry appends | fork visibility (section 2) |
| queued `write` head still valid at placement, else `unanswered/stale` | a collapse may have moved the head meanwhile |
| `after` targets exist and form no cycle; task self-wait and dependency-path waits reject | deadlock prevention |
| output ref names a live output of the same kind | writes to nothing otherwise |
| token identity: the kind object passed to `tx.task(kind, …)` / `tx.write(entryKind, …)` / `hooks.on(kind, …)` is the object currently registered for that name (or the fixed built-in witness), compared by identity, else `StaleDefinition` | a redeclared or replaced token must not create durable input/facets under a different current implementation |
| `createConversation` parent is in the writer's subtree | a task cannot inherit an unrelated tree |
| session phase (open/stopping/closing) permits this operation | lifecycle |

**Pre-persistence assertions** (invariants of kernel- and core-constructed writes; a failure faults the
session because persisting them would be durable corruption):

- Task transitions: `task.create` only for an absent ID, pending, no checkpoint/outcome/abort, empty `owns`;
  running only from pending with every `after` terminal (or marked, ignoring `after`); terminal only from
  running and carrying an outcome, with one narrow exception: open-time orphan reconciliation (section 13 step
  5) may terminalize a `pending` *or* `running` task directly as `orphaned`, and only it may; marked snapshots
  keep their lifecycle state; terminal is never replaced.
- Every owned `conversation.create` has a same-batch `task.set` whose `owns` gains exactly that ID; `owner`
  matches; ownership is never changed later.
- One `pi.output` append per tracker flush, with provenance from a live task referencing that output.
- Transcript invariants of section 1.4 for core appends.

### 5.3 Transaction surfaces

```ts
interface TxReaders {
  getConversation(id: Id): Promise<Conversation | undefined>;
  getEntry(id: Id): Promise<Entry | undefined>;
  getEntry<E extends Entry>(kind: EntryKind<E>, id: Id): Promise<E | undefined>;
  getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
  getTask(id: Id): Promise<Task | undefined>;
  getTask<K extends AnyDefinedKind>(kind: K, id: Id): Promise<TaskOf<K> | undefined>;
  getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
}
interface TxValue<T extends JsonValue, Read = T | undefined> { get(at?: Id): Promise<Read>; set(v: T): void; delete(): void }
interface TxList<T extends JsonValue>  { read(at?: Id): Promise<readonly Element<T>[]>; append(v: T): Id; remove(id: Id): void; clear(): void }
interface TxState {                                        // bound addresses only (host scope is unbound)
  value<D extends Value<JsonValue>>(a: D): TxValue<PayloadOf<D>, ResolvedValue<D>>;
  list<T extends JsonValue>(a: List<T>): TxList<T>;
}
interface BoundTxState {                                   // binds unbound definitions to own conversation
  value<D extends Value<JsonValue> | UnboundValue<JsonValue>>(a: D): TxValue<PayloadOf<D>, ResolvedValue<D>>;
  list<T extends JsonValue>(a: List<T> | UnboundList<T>): TxList<T>;
}

// exact task creation: visible extra fields in the spec or in `input` reject, for literals, variables and spreads alike
interface TaskCreator<Kinds extends AnyDefinedKind, Extra = {}> {
  task<K extends Kinds, S extends TaskSpec<K> & Extra>(
    kind: K,
    spec: NoExtra<TaskSpec<K> & Extra, S> & { readonly input: ExactJsonInput<InputOf<K>, S["input"]> },
  ): Id;
}

interface HostTx extends TxReaders, TxState, TaskCreator<OrdinaryKind, { readonly conversationId: Id }> {   // host must name the conversation
  createConversation(spec: ConversationCreateSpec): Id;   // sync; no first input (section 8.1)
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;   // passive; returns the input id; no request key
}
interface ConversationTx extends TxReaders, BoundTxState, TaskCreator<OrdinaryKind> {     // HostTx bound to one conversation
  createConversation(spec: ConversationCreateSpec): Id;
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;
}
interface BaseTaskTx<C extends TaskCheckpoint> extends TxReaders, BoundTxState, TaskCreator<OrdinaryKind> {   // conversationId defaults to own
  checkpoint(c: C): void;                          // buffers a full task.set with this checkpoint
  createConversation(spec: ConversationCreateSpec): Id;   // owner = this task; parent must be in subtree; no first input
  write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;   // own conversation; passive, boundary-safe; no request key
}
type CoreTaskTx<C extends TaskCheckpoint> = Omit<BaseTaskTx<C>, "task" | "write"> & TaskCreator<AnyDefinedKind> & {   // composed, not extended: `write` changes arity; creator accepts ordinary or fixed core children
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
  accept(conversationId: Id, options: InternalAcceptOptions): Promise<Acceptance>;   // section 9
  queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;   // private admission helper; request-keyed receipts are kind "write"
};
interface AbortTx<C extends TaskCheckpoint> extends TxReaders, BoundTxState {   // same own-conversation binding as BaseTaskTx; scratch stays task-bound via ScratchReader
  checkpoint(c: C): void;
  markTask(id: Id): Promise<"marked" | "terminal">;
}
interface CoreAbortTx<C extends TaskCheckpoint> extends AbortTx<C> {
  entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;    // publish aborted result
  write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>, requestId?: string): Promise<Acceptance>;
}
type FinalTx<C extends TaskCheckpoint, O extends OutputState>          = BaseTaskTx<C> & FinalOutput<O>;
type CoreFinalTx<C extends TaskCheckpoint, O extends OutputState>      = CoreTaskTx<C> & FinalOutput<O>;
type AbortFinalTx<C extends TaskCheckpoint, O extends OutputState>     = AbortTx<C> & FinalOutput<O>;
type CoreAbortFinalTx<C extends TaskCheckpoint, O extends OutputState> = CoreAbortTx<C> & FinalOutput<O>;
```

`accept`/`queueInput`/`write` are async because a request-key lookup and the busy check are committed reads;
called before any write they read then buffer, called after a write they use only their same-batch memory
and reject if a committed read would be needed. `write` is the only way for non-core code to add to the
transcript (section 1.4); it is available to ordinary task kinds in normal commits and terminal closures
(`FinalTx`), so a task can queue its completion notice atomically with its own terminalization. The busy check
is prospective over the whole batch: an ordinary task never makes a conversation busy, and a core task's own
terminal `task.set` in the same batch counts as gone, so a `write` in a terminal closure is appended
immediately unless some *other* turn task is still live after the batch. Public and ordinary `write` take no
request key and return only the input ID: a terminal-closure notice is already exactly-once because closure
settlement is atomic, and a host write that must be idempotent can be keyed by the caller in its own state.
Only the core admission helper `CoreTaskTx.write`/`CoreAbortTx.write` accepts a `requestId`, and receipts it
creates are tagged `kind: "write"`. `Harness.input(requestId)` returns a handle only for receipts tagged
`kind: "send"`, so a passive write can never be retrieved as an `InputHandle`; `InputHandle` is exclusively
admitted user input. The placed entry of a write is observed through the watch (`entry` event); passive writes
have no public handle. Ordinary kinds never get direct `entry`, `accept`/`queueInput`, boundary helpers,
input-group resolution or core creation. `AbortTx` has no `write`.

### 5.4 Runtime surfaces

```ts
interface TaskRuntimeBase<H extends HookPoints> {
  readonly taskId: Id;
  scratch<T>(build: (tx: TxState) => T | Promise<T>, ctx: Context): Promise<T>;   // own task scope only
  readonly hooks: HookRunner<H>;                                                 // section 11.2; runs outside the line
  conversation(id: Id, ctx: Context): Promise<TaskConversation | undefined>;     // own subtree only
  waitForTask(id: Id, ctx: Context): Promise<Task>;                               // own subtree or own deps only
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  now(): number;  sleep(untilMs: number, ctx: Context): Promise<void>;
}
interface CommitRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, Tx> {
  commit<T>(build: (tx: Tx, current: RunningTask<I,C,O>) => T | Promise<T>, ctx: Context): Promise<T>;
}
type RuntimeOutput<O extends OutputState>      = [O] extends [never] ? Record<never, never> : { readonly output: TaskOutput<O> };
type AbortRuntimeOutput<O extends OutputState> = [O] extends [never] ? Record<never, never> : { readonly output: ReadonlyTaskOutput<O> };

type TaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never, H extends HookPoints = {}> =
  TaskRuntimeBase<H> & CommitRuntime<I,C,O,BaseTaskTx<C>> & RuntimeOutput<O>;
type CoreTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never, H extends HookPoints = {}> =
  TaskRuntimeBase<H> & CommitRuntime<I,C,O,CoreTaskTx<C>> & RuntimeOutput<O>;

interface AbortRuntimeBase<H extends HookPoints> {
  readonly taskId: Id;
  scratch<T>(read: (s: ScratchReader) => T | Promise<T>, ctx: Context): Promise<T>;   // read only
  readonly hooks: HookRunner<H>;
  conversation(id: Id, ctx: Context): Promise<AbortTaskConversation | undefined>;
  waitForTask(id: Id, ctx: Context): Promise<Task>;
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  now(): number;  sleep(untilMs: number, ctx: Context): Promise<void>;           // cancellable wait for graceful cleanup; still no write/create/mutate authority
}
type AbortTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never, H extends HookPoints = {}> =
  AbortRuntimeBase<H> & CommitRuntime<I,C,O,AbortTx<C>> & AbortRuntimeOutput<O>;
type CoreAbortTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never, H extends HookPoints = {}> =
  AbortRuntimeBase<H> & CommitRuntime<I,C,O,CoreAbortTx<C>> & AbortRuntimeOutput<O>;

interface BoundPublicState {                               // shared by every conversation-bound public handle
  value<D extends Value<JsonValue> | UnboundValue<JsonValue>>(a: D): PublicValue<PayloadOf<D>, ResolvedValue<D>>;
  list<T extends JsonValue>(a: List<T> | UnboundList<T>): PublicList<T>;
}
interface TaskConversation extends BoundPublicState {   // restricted; no commit, no entry
  readonly id: Id;
  send(input: SendInput, ctx: Context): Promise<InputHandle>;
}
interface AbortTaskConversation extends BoundPublicState { readonly id: Id }
```

`current` passed to every `commit`/closure callback is a fresh read of the task on the line, not the stale
method argument. Reason: checkpoints and marks committed since the method started must be visible.

Invocation identity: the scheduler installs a private `{ taskId, method, token: object }` in a derived ctx
through a Chord context key. Every runtime method and `TaskConversation`/`InputHandle` returned to a task
captures that object and compares it by identity. Metadata or RPC transport never confers authority; a task
that uses an unrelated host ctx is an in-process escape no type can prevent.

Line reentry (calling `runtime.commit` inside a commit callback) rejects `NestedLineOperation` immediately
rather than deadlocking.

## 6. Scheduler

One scheduler per Session covers every conversation. Open constructs the indexes and leaves it inert;
`resume(ctx)` enables it. Indexes: all live tasks; reverse dependency edges; tasks per conversation with
turn/foreground subsets; conversation owner/parent ancestry; one invocation slot per running task; waiters.

```text
kick: if disabled -> nothing (resume rescans everything); else dirty = true, ensure one drain runner
drain: while dirty { dirty = false; on line: reserve every eligible task; off line: dispatch each }
eligible: live, and (marked  ->  fresh abort, ignoring dependencies)
                 or (pending, unmarked, every `after` terminal  ->  task.set running, dispatch execute)
                 or (running, unmarked, loaded at open with no invocation  ->  dispatch recover)
```

Every successful main commit kicks after in-memory application. Scratch and output-only commits do not kick
(they cannot change eligibility). A commit racing with drain exit sets dirty; the drain loops. No polling.

"Dependency terminal" includes failed, aborted and orphaned; the dependent reads the outcome and decides.
Reason: a failed dependency should not strand the dependent as pending forever.

One invocation per task ID at a time. The slot is held from dispatch through method return, producer joins
(pending scratch/output writes) and closure acceptance or discard. The scheduler never awaits one task
before dispatching another; tasks in the root, forks and subagents run concurrently.

`background: true` only affects idle observation and foreground cancellation. It does not affect
eligibility or execution. A foreground task depending on endless background work keeps foreground idle false
intentionally.

Waits (`waitForTask`, `InputHandle.wait`, `waitForIdle`) ensure `resume`, return immediately if already
satisfied, else register one cancellable waiter on the line. A waiter observes; it never owns execution.
Cancelling a wait removes only that waiter. Deadlock guards: direct self-wait rejects; waiting on a task whose
unresolved dependency path reaches the caller rejects; `after` cycles reject at creation.

## 7. Cancellation and lifecycle

### 7.1 Task abort

```text
commit task.set {abort: true}         -- the mark; idempotent
revoke: old invocation's commit/scratch/output now reject before the callback
signal old invocation's ctx           -- off line
await old method return + producer joins
on line: discard any normal closure it returned; release slot
reserve fresh abort: new invocation object, new ctx; kind.abort(task, abortRuntime, ctx)
abort may checkpoint (cleanup progress) and read scratch/output; may not create work
abort returns closure -> aborted outcome + scratch/output retirement, one commit
```

Why mark-then-fresh-abort rather than "let the old invocation handle its own cancellation"? The old
invocation may be mid-await on an external effect and may never return cleanly; its partial writes must not
be trusted. A durable mark survives a crash, so reopen runs `abort` (not `recover`) for a marked task even if
the old process died. Revoking before signaling guarantees no write from the old invocation lands after the
mark.

A pending task that is marked before reservation never executes; the kernel writes `running` only as part of
reserving fresh abort so `abort` receives a `RunningTask`. A repeated mark on a task whose abort is already
running is a no-op and does not cancel the abort. An uncooperative effect (ignores ctx) delays abort
indefinitely; no forced isolation in v1.

Cancellation is classified by Pico's own identity and known reason, never by error name alone. Local tool
deadlines are not marks; their errors are domain outcomes.

### 7.2 Conversation abort

`conversation.abort(ctx)`:

1. Compute the foreground cancellation set: every live task directly in this conversation that is not
   `background: true`, whatever its kind (turn tasks, threshold collapse, ordinary plugin tasks); for each, the
   conversations it owns; recurse into their live non-background tasks. A background or terminal owner stops
   the walk, so manual collapse, jobs and other background work survive. Fork parentage is not ownership and
   grants no reach.
2. One commit: mark every task in the set; remove queued `steer`/`followUp` items in affected conversations
   and write `unanswered/aborted` results; keep queued `write` items.
3. Track the set (plus any task marked transitively by those aborts). Resolve when all are terminal.

Task abort (`abortTask`) preserves queues; conversation abort withdraws steer/followUp. Reason: aborting one
tool should not throw away the user's typed follow-up; aborting the whole turn should.

### 7.3 Close, shutdown, fault

- **close**: stop admission and reservation; let admitted line work finish; signal and join every
  invocation; close the storage. Writes no marks or outcomes. Running tasks stay `running` durably and get
  `recover` next open.
- **shutdown**: enter `stopping`; one commit marks every live task; only abort commits are accepted; wait
  until no live tasks and no invocation slots; close. Queues are preserved. A failing abort faults. Explicit
  `close` may interrupt shutdown, which then rejects; durable marks recover later.
- **fault**: on invariant/persistence/closure/contract error: reject all waiters, stop admission, signal and
  join invocations, close storage. Never manufacture outcomes. Domain failures (provider errors, tool throws)
  are typed outcomes, not faults.

Repeated close/shutdown calls share one completion. Caller cancellation cannot abandon an admitted close or
shutdown.

Phase machine and exact sequence:

```text
open --close-->    closing --> closed
open --shutdown--> stopping --(all live tasks terminal, no invocation slots)--> closing --> closed
any  --fault-->    faulted   (terminal; storage closed after joins)

closing:  1 close() queues on the line like any operation; the callback already admitted owns the line and
            finishes and persists normally; close enters after it
          2 on line: phase = closing; every waiter (task/input/idle) rejects Closed; every watch is detached and
            gets {type:"closed", reason:"session"} once; operations queued behind close reject Closed
          3 off line: signal every invocation ctx; await method returns and producer joins;
            returned closures are discarded (nothing written); invocation commits reject Closed
          4 storage.close(ctx); phase = closed
faulted:  the faulting operation holds the line; on line: phase = faulted; waiters reject Faulted; watches are
          detached and get {type:"closed", reason:"session"}; then off line: signal and join invocations,
          storage.close(ctx). Nothing is written after the fault.
closed/faulted: permanent for this Harness object; every method rejects Closed/Faulted except `close()` and
          `shutdown()`, which are idempotent and return the shared completion; a new Harness.open on the
          same storage path is the only way forward
```

| phase / method | normal commit | scratch write | terminal closure | abort commit/closure | host admission |
|---|---|---|---|---|---|
| open, execute/recover, unmarked | yes | yes | yes | no | yes |
| open, execute/recover, marked | reject | reject | discard | no | yes |
| open, abort invocation | no | read only | no | yes | yes |
| stopping | no | no | discard | yes | reject |
| closing / faulted / closed | no | no | discard | no | reject |

## 8. Ownership

A task that calls `tx.createConversation` becomes the conversation's `owner` and the conversation ID is added
to its `owns` in the same commit. Ownership grants:

- capability: `runtime.conversation(id)`, `waitForTask`, `abortTask` accept targets in the owner's subtree;
- cancellation reach: conversation abort and `pi.tool` abort follow `owns`;
- foreground idle: a conversation is idle when its foreground cancellation set is empty.

Ownership does not affect scheduling. A terminal owner's owned conversations keep running. A subagent is an
owned conversation; there is no "subagent task". One task cannot resolve a conversation owned by a sibling
task; the only exception is the `pi.tool` descendant resolver of section 11.1 for later sibling tool calls.

### 8.1 Seeding owned conversations

All model, system and tool configuration is conversation-scoped. An owned conversation does **not** copy its
parent's current configuration implicitly; it gets exactly what its creator seeds. Reason: a subagent with a
different model, a smaller tool set and its own identity is the normal case, and an implicit copy of a
parent's mutable settings would be a hidden dependency that changes under the child.

```ts
type SeedWrite =
  | { readonly address: Value<JsonValue> | UnboundValue<JsonValue>; readonly value: JsonValue }   // set
  | { readonly address: Value<JsonValue> | UnboundValue<JsonValue>; readonly delete: true };      // durable absence (cuts an inherited rewindable value)

interface ConversationSeed {
  readonly parent?: { readonly conversationId: Id; readonly at: Id | "start" };   // transcript inheritance; default none
  readonly values?: readonly SeedWrite[];             // conversation-bound values: generationKind.config.*, postToolsKind.config.*, plugin state
  readonly copySticky?: readonly UnboundValue<JsonValue>[];   // copy parent sticky values at creation (async surfaces only: needs a parent read)
  readonly sections?: readonly SectionSeed[];         // sectionSeed(section, value) to set; removeSection(key) to cut an inherited section (host forks)
  readonly input?: UserInput;                         // first input; creates the first generation. Omit to create inert (path 1 below)
  readonly requestId?: string;
}
type ConversationCreateSpec = Omit<ConversationSeed, "input" | "requestId" | "copySticky">;   // the synchronous tx form
type ForkOptions = { readonly at: Id | "start"; readonly abort?: boolean } & Omit<ConversationSeed, "parent">;   // parent is the handle's conversation
```

Creation is one transaction: `createConversation` (for a task creator: owner = current task, `owns` updated),
every `values` set/delete and sticky copy, the section seed (below), for owned children the configuration
isolation writes (below), and, when `input` is present, `accept` of the first input through the fixed
generation strategy plus the creator's own checkpoint recording the child conversation ID, input ID and
request key. Either all of it commits or none does.

Which surface can do which part: `HostTx.createConversation(spec)` and `BaseTaskTx.createConversation(spec)`
are synchronous and take `ConversationCreateSpec`: no `input` (accepting one needs a committed request-key
read, which a builder cannot do after its first write) and no `copySticky` (copying needs a parent read; a
caller that wants it reads first and passes explicit `values`). The asynchronous conveniences
`Harness.createConversation(seed, ctx)` and `ConversationHandle.fork(options: ForkOptions, ctx)` (host; one
commit each) and the core-owned mediated path of section 11.1 (tools; internal `CoreTaskTx` performing the
request-key/busy/parent reads before its first write) accept the full seed. There is no other way to create a
conversation with a first input.

Request key on creation: a seed with `input` and `requestId` cannot use first-key-wins, because the original
acceptance (if any) belongs to some other conversation and returning that handle would break fork/creation
semantics, while creating an empty conversation anyway would leave garbage. Rule: the async creation planner
checks `pi.request` on the line before minting anything; if a receipt for that key exists (of either kind),
creation rejects `RequestKindMismatch` and writes nothing, and the caller recovers the original through
`h.input(requestId)`. A fresh key, or no key, creates conversation and input atomically.

Two planners, one seed shape:

| | host fork / host `createConversation` with `parent` | task-owned child (subagent) |
|---|---|---|
| built-in rewindable config (`model`, `thinkingLevel`, `selectedTools`, `profile`, `threshold`, `keepRecent`) | inherited at the fork point, then seed overrides | **isolated**: never inherited (below) |
| built-in sticky config (`retry`, `steeringMode`, `followUpMode`) | absent (reads default) unless `copySticky`/`values` | absent (reads default) unless `copySticky`/`values` |
| system sections | desired state starts from inherited canonical state | desired state starts **empty** (below) |
| plugin rewindable values | inherited unless seed sets/deletes | inherited unless seed sets/deletes |
| `owner` | none | the creating task |

A fork is the same agent continuing from an earlier point; an owned conversation is a different agent.

**The seed must be sufficient on its own.** If `input` is present, the child's first generation may be
reserved by the scheduler in the same drain that follows the creation commit, so nothing registered
afterwards can be assumed to exist. Every child-specific configuration and system-section value must
therefore be durable in the creation transaction, either literally (`values`, `sections`) or through a durable
profile value (`generationKind.config.profile`) that already-registered handlers expand deterministically.

**Hooks are code, not data.** A hook handler is a process-local callback; it cannot be serialized, persisted
or made part of an atomic commit, and there is no durable identity for a callback. `ConversationSeed`
therefore has no `hooks` field. Child-specific behaviour that lives in hooks reaches the child by exactly one
of two paths:

1. **Inert creation, then activate.** The host creates the child without `input` (`tx.createConversation`,
   `h.createConversation`, `c.fork`), obtains its `ConversationHandle`, registers child-scoped hooks with
   `c.hook.*` / `c.hooks.on` and adjusts `c.config`, and only then calls `send`. Nothing runs before `send`, so
   there is no race. This is the host path.
2. **Atomic creation with a durable profile.** A tool-mediated (or host) creation that includes `input` seeds
   `generationKind.config.profile` (and any other selection values) in the same transaction. Hook
   implementations for every profile were registered before `resume`, harness-wide or on the parent with
   `subtree: true`, and dispatch on the child's profile value read from `info.conversationId`. No
   post-creation registration is needed, so no race exists. This is the subagent path.

On reopen, the host reinstalls hook code before `resume`; durable profile/config values select behaviour. A
child whose profile has no registered implementation gets the generic handlers, which must treat an unknown
profile as a plain default, never as an error.

**Owned conversations never inherit built-in configuration.** For a task-owned child, even with `parent`
set (transcript inheritance), the creation transaction writes each seeded rewindable member of the full
`CoreConfigBundle` locally and a durable `value.delete` for each unseeded rewindable member (`model`,
`thinkingLevel`, `selectedTools`, `profile`, `threshold`, `keepRecent`; the set is derived from the bundle, so
a new rewindable built-in is covered automatically). Rewindable lookup therefore finds a local write for every
member and never walks into the parent for configuration. Sticky members cannot inherit by construction and
follow `copySticky` or `values` only. Absent `model` yields a typed `no_model` failure on the child's first
generation; every other absent member reads its default. Plugin rewindable values are *not* isolated: Pico
cannot know which unknown definitions should be cut, so they follow ordinary parent history at the fork point
unless the seed sets or deletes them (`SeedWrite` with `delete: true`). Host forks skip this block entirely.

Section seed: set entries are rendered with the registered definitions at creation time (an unregistered
section rejects); removals (`removeSection(key)`) need no definition. The resulting `SectionRecord[]` (`set`
with value+rendered, or `remove`) is persisted as private immutable metadata on the `conversation.create`
storage record itself (section 1.1), not as an address: it is atomic with creation, survives inert setup and
reopen, is invisible to the public `Conversation` projection and to every generic handle, and needs no new
protected namespace. Preparation applies it while this conversation has no *local* managed `pi.system` entry
(inherited managed history from a fork parent does not count): for a host fork it is folded over the inherited
canonical state, for an owned child over the empty desired state (below). After the first local managed entry
is appended it is inert. The root uses the same metadata for `root.sections`.

**First preparation, two planners.** The *comparison base* is always the inherited canonical section state
(fork-visible managed history if `parent` is set, empty otherwise); the delta or baseline is computed against
it (section 12.5). What differs is where the *desired* state starts:

- Host fork / host `parent`: desired = inherited canonical state, then seed `set`/`remove`, then
  `systemInstructions` handlers. Tools = the fork's inherited-then-overridden `selectedTools`.
- Task-owned child: desired = **empty**, then seed `set`, then `systemInstructions` handlers (subtree
  handlers on ancestors provide defaults; child-local and profile-dispatched handlers run last). Tools = the
  child's isolated `selectedTools`. Diffing desired against the inherited base therefore emits a `remove` for
  every inherited section the child did not seed or re-set, and `toolsRemoved` for every inherited tool not in
  the child's loadout.

Inheriting the parent's `pi.system` entries and then sending without that delta would present the main agent's
identity and tool loadout to the child's model; that is a defect, not a configuration choice. The requirement
holds regardless of how the mediated `conversation()` API of section 11.1 is eventually shaped. Whichever path
created it, a child's system sections, configuration and profile are in place before its first generation
prepares; that is the invariant both paths exist to guarantee.

## 9. Input admission

### 9.1 Records

```ts
type UserInput = string | readonly (TextContent | ImageContent)[];

type QueuedInput =
  | { mode: "steer" | "followUp"; input: Stored<UserInput>; requestId?: string }   // durable form; SendInput.content is converted at admission
  | { mode: "write"; entry: StoredEntryDraft; requestId?: string };   // passive entry, e.g. a notice

// durable, protected, ID-only
type StoredInputResult =
  | { status: "queued";     requestId?: string }
  | { status: "placed";     requestId?: string; entry: Id }
  | { status: "done";       requestId?: string; entry: Id; answer?: Id }
  | { status: "unanswered"; requestId?: string; entry?: Id; reason: "terminated"|"aborted"|"failed"|"stale"; detail?: string };

// public, hydrated by the handle before it resolves
type InputOutcome =
  | { readonly status: "queued";     readonly requestId?: string }
  | { readonly status: "placed";     readonly requestId?: string; readonly input: UserEntry }
  | { readonly status: "done";       readonly requestId?: string; readonly input: UserEntry;
      readonly answer?: { readonly entry: AssistantEntry; readonly message: AssistantMessage } }
  | { readonly status: "unanswered"; readonly requestId?: string; readonly input?: UserEntry;
      readonly reason: "terminated" | "aborted" | "failed" | "stale"; readonly detail?: string };
type TerminalInputOutcome = Extract<InputOutcome, { status: "done" | "unanswered" }>;

interface SendInput { requestId?: string; content: UserInput; whenBusy?: "followUp" | "steer" | "reject" }
interface InputHandle {
  readonly id: Id; readonly conversationId: Id;
  result(ctx: Context): Promise<InputOutcome | undefined>;      // point read plus entry hydration, no activation
  wait(ctx: Context): Promise<TerminalInputOutcome>;
  abort(ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
}
```

`StoredInputResult` is what admission writes, for user input and passive writes alike; `InputOutcome` is
what callers see, and only for admitted user input (`send`). The handle reads the stored record, then fetches
the referenced entries (`getEntries`, one round trip) and resolves with them attached. Reason: every caller of
`wait` wants the answer text, and entries are immutable, so hydration is a pure convenience with no staleness.
`answer.message` is `answer.entry.model[0]` handed out as the pi-ai `AssistantMessage` type (the stored
form is structurally identical after ingress validation), not the current edited context projection. Passive writes have stored results (for placement bookkeeping and `unanswered/stale`) but no public
handle; `Harness.input(requestId)` returns `undefined` for a `kind: "write"` receipt.

Protected state (written only by admission helpers):

- `pi.inbox`: sticky conversation list of `QueuedInput`. The element ID is the input ID; ascending IDs are
  admission order. Not inherited by forks. Reads return one complete current collection; no backend replays
  history per read.
- `pi.input_result`: sticky session value keyed by input ID → `StoredInputResult`.
- `pi.request`: sticky session value keyed by `requestId` → `Acceptance` (tagged `kind`; `Harness.input` ignores `"write"`).

Result and receipt lookups are point reads, never list scans.

### 9.2 Request keys

A `requestId` names the first acceptance for the session's lifetime. Lookup happens before anything else. A
duplicate `send` returns a handle to the original acceptance and writes nothing, even through another
conversation with different content. Reason: a client that sent, lost the reply and retried must get the same
input, not a second one. `accept`/`queueInput`/`write` obey the same rule within their own `Acceptance.kind`.
Across kinds a key collision is internal misuse: a `send` whose key names a `"write"` receipt (or a core `write`
whose key names a `"send"` receipt) rejects `RequestKindMismatch` and writes nothing; there is no cross-kind
return.

### 9.3 Busy

`busy(c)` = at least one live `pi.generation`, `pi.tool` or `pi.post_tools` directly in conversation `c`,
foreground or background. Evaluated against committed live tasks plus the current batch's `Write[]`.
Ordinary tasks and `pi.collapse` never make a conversation busy. Reason: collapse runs speculatively next
to a turn; an idle `send` must not be blocked by it.

### 9.4 Send

```text
send when not busy:
  one commit: place older queued writes; place older queued steer/followUp per queue mode plus the new
  input as pi.user entries; create one pi.generation { inputs: [...placed ids] }; results -> placed;
  receipt if requestId. `whenBusy` ignored.
send when busy:
  followUp (default) or steer: one commit: inbox append; result queued; receipt.  No task.
  reject: throw ConversationBusy; write nothing.
write when not busy: append entry, result done (no task).  When busy: queue.
```

After the commit, `send` ensures `resume` and returns the handle. It never waits for generation.

Result transitions (only admission/boundary helpers write them):

```text
absent -> queued -> placed -> done | unanswered(terminated|aborted|failed)
          queued -> unanswered(aborted|stale)
          queued write -> done
idle send collapses absent -> placed; idle write collapses absent -> done (still creates+removes inbox element)
```

### 9.5 Boundaries and queue modes

Boundaries are helper calls inside a core task's terminal closure, not separate commits. Which queued items a
boundary selects is governed by `postToolsKind.config.steeringMode`/`followUpMode` (section 2.1): `"all"` takes
every queued item of that mode, `"one-at-a-time"` takes the oldest. All queued writes are always selected.
Selected items, whatever their mode, are placed in one pass strictly by ascending input ID (inbox element ID,
i.e. admission order); no mode has priority over another. Unselected items keep their relative order.

- **post-tools** (in `pi.post_tools` closure): selected = all queued writes + steer per `steeringMode`; place
  them by ID. Steer joins the active input group (the continuation generation owns them). FollowUp stays
  queued. Reason: steer means "interrupt the current line of work"; followUp means "after you're done".
- **final answer** (in `pi.generation` closure when no tool calls): the closure has already appended the
  assistant entry; then resolve the active group → `done(answer: assistant)`; selected = all queued writes +
  steer per `steeringMode` + followUp per `followUpMode`; place them by ID after the assistant; if any
  steer/followUp was placed, they form a new group and its generation is created.
- **yield continuation** (section 10.1): when an `onYield` hook asks to continue and no steer/followUp is
  queued, the closure, in this order: appends the assistant entry (the exchange is now complete); places
  selected queued writes in global inbox order (they land at the post-answer boundary, never inside the
  exchange); appends a `pi.user` entry `{ model: [{ role: "user", content: <continue text>, timestamp }], data:
  { continuation: true, from: <assistant id> } }` that has **no** input result (it is not admitted input); and
  creates the successor generation carrying the **same** `inputs`; the active group's results stay `placed`.
  If one of the placed writes is a self-head (reset/handoff), the continuation is invalidated: the caller just
  cleared the state the hook wanted to continue. The closure then behaves as a plain final answer: assistant
  appended, writes placed, active inputs `done(answer)`, no continuation entry and no successor.
- **idle turn** (kernel, after any normal core closure): if this commit takes the conversation from busy to
  not busy and creates no turn task, place queued items as at a final-answer boundary. Covers post_tools
  ending the turn without a continuation.
- **abort**: no automatic drain. Conversation abort withdrew steer/followUp; task abort left them. A later
  idle `send` consumes them.

A queued `write` carrying a `head` is revalidated at placement (section 1.4). If the head is no longer valid,
the item is removed and its result set to `unanswered/stale`. Never a fault.

Heads placed at a boundary interact with the group the boundary forms. Placement is still strictly by ID, but
after placing the selected items the boundary applies two rules so that no generation ever owns an input that
its own request cannot see:

- Every steer/followUp admitted *before* a self-head write placed in this batch (a queued reset/handoff with
  `head: "self"`) is now outside the context the caller asked for, whether or not the mode selected it: a
  selected one whose entry now lies before the head is excluded from the successor group, an unselected one is
  removed from the inbox, and both resolve `unanswered/stale`. Otherwise an unselected `one-at-a-time` leftover
  would resurrect the cleared state on a later send. Items admitted after the final self-head keep their order
  and are selected normally. Example: queued followUp B1, B2, then queued reset R with `one-at-a-time`: B1 is
  placed then made invisible by R, B2 was never selected; both resolve `unanswered/stale` and no generation is
  created for either. The same rule runs when a self-head `write` is admitted while the conversation is idle
  (for example `abortTask` left followUps queued and the host then calls `c.reset`): the immediate append also
  removes every older queued steer/followUp as `unanswered/stale`, in the same commit. Otherwise they would
  resurrect on the next send into a context the reset just cleared.
- At a post-tools boundary, a placed self-head also ends the *old* active group: its inputs resolve
  `unanswered/terminated` (the model can no longer see them), no ordinary continuation is created, and only
  visible triggers placed after the final head (steer or followUp with entries after `R`) may form a fresh group
  and start a generation. Example: queued reset R, then queued followUp B; placement gives `reset R; user B`; the
  old group is terminated, B starts a fresh generation whose request begins at `R`.

Both use existing result reasons; nothing new is stored.

Trace:

```text
idle send A          TX[user A; generation G1{inputs:[A]}; A=placed; receipt]         kick -> G1
G1 calls X,Y         TX[assistant; tool X; tool Y; post_tools P1{after:[X,Y], inputs:[A]}; G1 terminal]
                                                                                       kick -> X, Y
busy send B          TX[inbox B; B=queued]
busy send S (steer)  TX[inbox S; S=queued]
busy write W         TX[inbox W; W=queued]
X done               TX[tool_result X; X terminal]
Y done               TX[tool_result Y; Y terminal]                                     kick -> P1
P1 closure           TX[user S; S=placed; entry W; W=done; generation G2{inputs:[A,S]}; P1 terminal]   (S admitted before W)
G2 final answer E2   TX[assistant E2; A,S=done(answer:E2); user B; B=placed; generation G3{inputs:[B]}; G2 terminal]
```

There is no fourth inbox mode (no `nextRun`): the modes are `steer`, `followUp` and `write`, and Pico does not
buffer non-triggering context for a later turn. An application that accumulates such context (notes, events,
partial instructions) keeps it in its own value or list and folds it into one later `UserInput` when it
actually wants a turn; `write` is only for content that should become a passive transcript entry now.

Input ownership is explicit: `inputs: Id[]` in generation/post_tools input. Exactly one live turn task owns
each placed group; ownership transfers in the same commit that creates the successor. The kernel never
inspects a checkpoint to find owners.

### 9.6 Withdraw and wait

`InputHandle.abort`: on the line, if still queued: remove inbox element, result `unanswered/aborted`, return
`aborted`. If placed or terminal: return `already_placed`, change nothing. If unknown: `not_found`. A queued
result whose inbox element is missing is a corrupted-state fault.

`InputHandle.wait`: reject `InputNotFound` if no result exists; ensure `resume`; return an existing terminal
result; else register one waiter, cleaned up exactly once on result, caller cancel, close or fault. Caller
cancellation never marks or removes the durable input. In both paths the handle hydrates the referenced
entries after observing the terminal stored record and before resolving; hydration is off the line and reads
immutable entries, so it cannot observe a different state than the record names.

## 10. Core task kinds

All five are installed at open and cannot be replaced or removed. Generation, tool, post_tools and collapse
use `defineCoreTask`; job uses ordinary `defineTask`. Payloads below are normative compact syntax; the code
uses named `type` aliases with exactly these shapes. Hook points are declared per kind (section 11.2).

### 10.1 `pi.generation`

```ts
input:  { inputs: Id[] }
checkpoint:   // `Prep` is captured once at `prepared`; every later phase carries it unchanged except `attempt` (see steps 2-3) and `tools` (step 2)
  Prep = { cutoff: Id; system: Id | null; model: ModelRef; thinkingLevel: ThinkingLevel; tools: string[]; retry: Stored<RetryPolicy>; attempt: number }
  | { phase: "prepared" } & Prep
  | { phase: "requesting"; requestKey: string } & Prep                          // effect in flight
  | { phase: "retrying";   untilMs: number; lastError: string } & Prep
  | { phase: "deferred";   handle: Stored<DeferredHandle> } & Prep               // provider-side async
result:  { assistant: Id; tools: Id[]; postTools?: Id; successor?: Id }
failure: { reason: "provider" | "overflow" | "retries_exhausted" | "no_model"; detail: string; assistant?: Id }
aborted: { assistant?: Id }
output:  GenerationOutput = { message?: Stored<AssistantMessage> }   // absent until the provider's `start` frame; reset to {} on retry
```

The task is created by admission before model, provider, API, timestamp or usage are known, so `initial(input)`
is `{}`. pi-ai's `event.partial` is one shared object the provider keeps mutating after `start`, so it must
never be inserted into or retained by the tracker. Generation runs every provider event through pi-ai's
`AssistantMessageFrameEncoder`, whose `start` frame carries a *clone* of the partial and whose later frames are
compact per-block deltas. Generation keeps only the small process-local per-block reducer state (which block
index is text/thinking/tool call, whether it has ended, the tool-call JSON so far) and applies each encoded frame
directly inside one `output.mutate` on the tracker's own `message`, using the same switch and invariants as
pi-ai's frame reducer. It never buffers prior frames, never re-reduces the sequence, never keeps a second
`AssistantMessage`, and never `replace`s the whole message per token: one frame, one incremental `mutate`, one
Chord delta. pi-ai's `reduceAssistantMessageFrames` is a test oracle only (the final tracker value must equal
its reduction of the same frames), not a runtime dependency. `output.replace({})` when a retry begins. The
terminal `AssistantMessage` from `done`/`error` or a deferred fetch is cloned and strict-JSON validated before
the closure stores it as the assistant entry; a terminal path that requires an entry but has no message is a
kind-contract fault. Watchers treat an absent `message` as "no response yet".
One task output, no second frame log.

Execute:

1. Read `generationKind.config` at the current position (`model` absent → `failed/no_model`). Run system
   preparation (section 12), which may append a managed `pi.system` entry and returns its ID. Commit
   `prepared` with `Prep`: the cutoff (newest visible entry ID after preparation), the system entry ID, the
   resolved model, thinking level, the loadout's tool names and the retry policy as read now. Reason: the
   cutoff fixes what is sent; the copied config makes recovery send the same request under the same cutoff and
   attempt even if `c.config` changed meanwhile; later phases read `Prep`, never `c.config`.
2. Derive the immutable request snapshot from the cutoff. Run `beforeRequest` hooks on a private copy
   (messages only). The transformed request is **not** persisted; a recovery or retry that re-enters this step
   reruns the hooks (never step 1: `prepared` and system preparation run once per generation), so handlers must
   be deterministic for a given (cutoff, config) or accept that a retried request may differ. Then, on the
   *final* transformed request: (a) overflow check, `estimate(final) > model.contextWindow - model.maxTokens` →
   the overflow path below, without calling the provider; (b) derive `tools` = the tool names actually declared
   by the final request's `SystemMessage`s (added minus removed), whatever the hooks did; no subset rule is
   enforced, and a model call naming a tool with no registered executor is already a missing-tool result in
   `pi.tool`. Commit `requesting` with a fresh `requestKey`, that `tools`, and `attempt` (1 on the first pass;
   `retrying.attempt + 1` when entered from step 3 or from recovery of `retrying`). Call the provider outside
   the line with a derived ctx. Encode each event with `AssistantMessageFrameEncoder`; on the
   `start` frame `output.mutate(o => { o.message = frame.partial })` (the encoder's clone, never the provider's
   `partial`); apply every later frame inside `output.mutate` to `o.message`.
3. Every terminal provider `AssistantMessage` (stop, length, toolUse, error, aborted, or the result of a
   deferred fetch) first goes to `afterResponse` outside the line with `{ message, usage, attempt }`, before
   any classification; it observes, it does not decide. Then, on a provider error (`stopReason: "error"`): let
   `policy = checkpoint.retry`. Classify with pi-ai's
   `isRetryableAssistantError(message)`; if retryable, `policy.enabled` and `attempt <= policy.maxRetries`:
   one commit buffers a data-only `pi.usage` entry `{ attempt, usage, error }` (no `model`; records the failed
   attempt's usage) together with the `retrying` checkpoint (`attempt` = the attempt that just failed,
   `untilMs = now + retryDelayMs(policy, attempt)`); then `sleep`, `output.replace({})`, go to 2, which commits
   `requesting` with `attempt + 1`. Otherwise
   `failed/provider` (not retryable or disabled) or `failed/retries_exhausted`. Provider returned `deferred`:
   commit `deferred` with `Stored<DeferredHandle>`; wait `handle.pollAfterMs` (fallback 5 s when absent), then
   `models.fetchDeferred(model, handle)`; a message → step 4; another deferred handle → commit `deferred` with
   the new handle and repeat; an error → step 3 as a provider error. Deferred polling is not the retry backoff.
3b. Terminal non-retryable outcome: a provider `stopReason: "aborted"` without a Pico mark (the provider ended
   the stream on its own) and a final `"error"` (not retryable, retry disabled, or attempts exhausted) take the
   same path: the closure appends the error/aborted `AssistantMessage` once as a display-only `pi.assistant`
   entry (never in context, never creating tools), resolves the active inputs `unanswered/failed`, and
   terminalizes `failed/provider` or `failed/retries_exhausted`. A Pico mark on the ctx does not reach here: it
   unwinds the invocation and fresh abort runs (below).
4. Successful response (`stop`, `length`, `toolUse`): `afterResponse` has already run (step 3; the assistant
   *entry* does not exist yet, hooks never run inside or after the closure). For a final answer (no tool
   calls): run `onYield` outside the line **only if** no steer/followUp is queued at that moment. Closure then rechecks the inbox and cancellation on the line. If a trigger arrived meanwhile,
   the yield decision is stale and discarded; normal final-answer boundary. Otherwise `{ continue }` → yield
   continuation boundary (section 9.5) with a `pi.user` entry carrying the returned text; the successor
   generation keeps the same `inputs`. No `continue` → final-answer boundary.
5. Tool calls: closure buffers the assistant entry, one `pi.tool` per call and one
   `pi.post_tools{after: tools, inputs, assistant, tools}`. Every call gets a `pi.tool`, including one naming a
   tool that was not offered; `pi.tool` decides (10.2) using the generation's own terminal checkpoint as the
   evidence, so `ToolInput` carries no duplicate offered list.

Recover: `prepared` → step 2 (hooks rerun; request built from `Prep`, not from current config; step 1 never
reruns). `requesting`
→ the effect may have happened and there is no result lookup: treat the interruption as a retryable failed
attempt with usage absent, evaluated against the persisted `checkpoint.retry` and `checkpoint.attempt` exactly
like step 3: if `retry.enabled` and `attempt <= retry.maxRetries`, one commit appends `pi.usage{ attempt, error:
"interrupted" }` and the `retrying` checkpoint, then sleep and step 2 with `attempt + 1`; otherwise terminalize
`failed/provider` (disabled) or `failed/retries_exhausted` with **no** assistant entry (there is no message to
display) and resolve inputs `unanswered/failed`. Never a silent increment, never an unconditional `retrying`.
`retrying` → sleep out `untilMs`, then step 2. `deferred` →
resume polling with the stored handle. Usage accounting: each failed attempt's usage is one `pi.usage` entry committed with its
`retrying` checkpoint; the successful attempt's usage lives once, on the final `pi.assistant` entry's
`AssistantMessage.usage`. Nothing is counted twice. Missing usage is unknown, not zero.

Size estimation: `estimate(messages) = estimateContextTokens(messages).tokens` from pi-ai, applied to the
projected request messages (including the messages-only system/tool declarations once the pi-ai PR lands).
The same estimator is used for overflow, threshold and `through` selection.

Overflow (request too large): detected in step 2(a) on the final transformed request, never on the pre-hook
snapshot, and always before `requesting` is committed or the provider is called (pi-ai `Model` fields; no
separate cap in v1): compute `through` (below). If a collapsible prefix exists, the
closure creates a **foreground** `pi.collapse C{reason: "overflow", through}` and a replacement
`pi.generation G{after: [C], inputs}`, transfers input ownership to `G`, and terminalizes `failed/overflow`
without resolving inputs. `G` reads `C`'s outcome first: completed → normal execution against the new head;
failed/declined/aborted/orphaned → `G`'s closure `write`s a `pi.notice` ("context too large; compaction
failed: <reason>"), resolves the inputs `unanswered/failed` and terminalizes `failed/overflow`. If no
collapsible prefix exists (the retained suffix is the whole context), there is no `C` and no `G`: the closure
`write`s the same notice, resolves inputs `unanswered/failed` and terminalizes `failed/overflow` directly.

Input ownership, all generation outcomes: success → inputs `done` (final answer) or transferred to
`pi.post_tools` (tool calls); `no_model`, terminal provider error/abort, and interrupted `requesting` with no
retry left → `unanswered/failed`; overflow with
collapse → transferred to the replacement; replacement after failed collapse → `unanswered/failed`; Pico abort
→ `unanswered/aborted`.

Threshold (context large but the request succeeded): if `collapseKind.config.threshold > 0` and
`max(usage.input + usage.output, estimate(request))` exceeds it, the normal closure additionally creates a
**foreground** `pi.collapse C{reason: "threshold", through}`; the generation completes normally. Automatic
collapse is foreground because it is part of the turn's work: conversation abort reaches it and `waitForIdle`
waits for it. Manual `c.collapse` is background and speculative. Neither makes the conversation busy (9.3).

Choosing `through` (all cases, including manual): let the context be the sequence of complete exchanges
(user/notice entries count as their own one-message exchanges). Walk from the newest exchange backwards,
accumulating `estimate` of the retained suffix; keep extending the suffix while its estimate is ≤
`collapseKind.config.keepRecent`. `through` is the last entry of the exchange immediately before the retained
suffix. If the whole context fits in `keepRecent`, there is nothing to collapse and no task is created (manual
`c.collapse` then rejects `NothingToCollapse`). If even the newest exchange exceeds `keepRecent`, the suffix is
that single exchange. The summary's `head` is the first entry after `through`.

Abort: if the checkpoint is `deferred`, fresh abort first calls `models.cancelDeferred(model, handle)` best
effort (errors ignored); the closure stores the partial message as an `aborted` assistant entry if any content
exists (display only) and resolves inputs `unanswered/aborted`.

### 10.2 `pi.tool`

```ts
input:  ToolInput = { assistant: Id; call: Stored<ToolCall> }
checkpoint:
  | { phase: "started"; replay: "safe" | "unsafe"; call: Stored<ToolCall> }   // final identity-preserving, schema-validated call
  | { phase: "children"; replay; call: Stored<ToolCall>; ... }     // keyed child/owned-conversation records; exact remaining schema gated (11.1)
result:  { entry: Id; control?: ToolControl }
failure: never   // tool errors are model-visible results, not task failures
aborted: { entry: Id }
output:  ToolOutputState
```

Execute: first the offered-set check. Read the assistant entry (`input.assistant`), follow its `byTaskId` to the
generation task, and read `tools` from that task's retained checkpoint (terminal records keep their last
checkpoint). The task must be a completed `pi.generation` whose result names this assistant entry, and its last
checkpoint phase must be `requesting` or `deferred` (both carry `Prep.tools` as actually offered; a deferred
response can end with tool calls). Anything else (no `byTaskId`, task absent, not completed, different assistant,
or a `prepared`/`retrying` checkpoint) is corruption and faults: Pico itself wrote those records. `call.name` absent from that list → synthetic
`pi.tool_result` `isError: true, "tool not offered"` without consulting the registry. Then look up the tool by
`call.name` in the registry and validate the original arguments. A missing tool or invalid arguments produces
the corresponding synthetic error result. Otherwise run `beforeTool` outside the line, before any `started`
checkpoint; a block (including a hook throw under this point's policy) produces a synthetic error result.
Validate the final rewritten arguments again. Only the invocation branch commits `started` with the tool's
`replay` policy and the complete final call, immediately before invoking outside the line through the gated
execution API (section 11.1); in WP10 that is an internal test executor. A tool throw becomes an error result.
Run `afterTool`. Closure: re-read any children on the line (never trust a
stale `Promise.race`); buffer exactly one `pi.tool_result` entry whose `model` message is the bounded output
followed by diagnostics, and whose `data` carries details, usage, control and truncation metadata; return
completed with `control`.

Recover: no checkpoint → the crash happened between reservation and the `started` commit, and since `started`
is always committed before the tool is invoked, no external effect can have occurred: repeat lookup, argument
validation, `beforeTool`, final validation and then start normally. A `started` checkpoint never reruns
`beforeTool`: its stored final call is the effect evidence. Resolve the current executor by name and replay
only when both the persisted and current declarations say `replay: "safe"` and the persisted arguments validate
against the current schema. Missing/current-unsafe/schema-incompatible → a model-visible interrupted or
unavailable error result, never a fault; safe/current-safe/valid → invoke the persisted call. This avoids
running old evidence under an incompatible deployment without adding definition fingerprints. In-process
invocations retain the definition they started with. `children` resumes the recorded children and retains the
same final call.

Abort: mark each child with `abortWithTool: true` and every live foreground task in each subagent with
`abortWithTool: true`, atomically mark-if-live; an already terminal target counts as cleaned. Do not withdraw
subagent queues. Closure appends an aborted `pi.tool_result` through `CoreAbortTx.entry`.

### 10.3 `pi.post_tools`

```ts
input:  { inputs: Id[]; assistant: Id; tools: Id[] }
checkpoint: never
result:  { successor?: Id; ended?: "terminate" | "handoff" }
failure: never
aborted: null
```

Runs after every tool is terminal. Execute: through one read-only `runtime.commit` (reads only, no writes)
take an immutable snapshot of the terminal tool tasks and their result entries; terminal records never change,
so the snapshot cannot go stale. Run `afterTools` outside the line on that snapshot. Closure, one commit, in
this exact order (rewindable writes must precede every entry append, section 2):

1. Reads: `generationKind.config.selectedTools` fresh (so a config change made while `afterTools` ran is not
   lost); the snapshot is already in hand.
2. Fold `control` from the snapshot **in the assistant's call order**: `addTools` is additive (current list
   followed by every requested name not already present, first occurrence wins, nothing dropped); `handoff` wins
   over `terminate` (a handoff also ends the turn) and among several `handoff` messages the last in call order
   wins.
3. Buffer the single `selectedTools` set, if `addTools` produced a change. This is the only rewindable write and
   it comes before any entry.
4. For every tool outcome that is `orphaned` or `aborted` without a result entry, append a synthesized error
   result, in call order, so the exchange is complete.
5. If `handoff`: append `pi.handoff{ head: "self", model: [user handoff message] }` **directly** through
   `CoreTaskTx.entry` (not `write`), so the head exists before anything else placed in this batch.
6. If `handoff` or `terminate`: resolve the active group `done` (answer: assistant) and run the final-answer
   boundary, whose follow-up placement and successor generation now come after the head and therefore start the
   fresh context. Otherwise: post-tools boundary and `pi.generation{ inputs }` as the continuation with the group
   plus placed steer.
7. Terminal snapshot.

Reason for 5 before 6: a `write` would evaluate prospective busy after the successor generation was buffered and
queue the handoff behind it, so the next request would still see the old context. This direct control handoff
is not an inbox-ordered self-head write: queued steer/followUp items, even if admitted earlier, are placed after
the new head by step 6 and may start in its fresh context rather than being staled.

Abort: `pi.post_tools` owns the active input group while it is live, so its fresh abort closure resolves every
ID in `input.inputs` as `unanswered/aborted` (writing the internal input-result state directly through core
authority; no public helper exists) and terminalizes `aborted: null`. Otherwise a marked post_tools would
strand placed inputs forever. Queued items are untouched here: task abort leaves them for a later idle send;
conversation abort has already withdrawn steer/followUp in its own mark batch.

### 10.4 `pi.collapse`

```ts
input:  { reason: "threshold" | "manual" | "overflow"; through: Id; instructions?: string }
checkpoint:   // `Base` is captured once, before `beforeCollapse`, and carried unchanged except `attempt` (retrying records the failed attempt; the next summarizing uses attempt + 1)
  Base = { expectedHead: Id | null; instructions?: string; model: ModelRef; thinkingLevel: ThinkingLevel; retry: Stored<RetryPolicy>; attempt: number }
  | { phase: "summarizing" } & Base
  | { phase: "retrying"; untilMs: number; lastError: string } & Base
  | { phase: "prepared"; summary: string } & Base   // candidate text is durable; only finalization remains
result:  { summary: Id }
failure: { reason: "stale" | "declined" | "provider" | "no_model"; detail: string }
aborted: null
```

`through` is the last entry of a complete exchange (chosen by the creator, section 10.1 for automatic
collapse; `c.collapse` uses the same `keepRecent` rule). Execute: through one read-only `runtime.commit`
capture `Base` (`expectedHead` = current newest head, `generationKind.config` model/thinking/retry at this
position, `attempt: 1`) together with the entries to summarize; if `model` is unset, terminalize
`failed/no_model` immediately (before `beforeCollapse` and before any checkpoint), for manual, threshold and
overflow alike; run `beforeCollapse` (fold `first`) outside
the line on that snapshot. Then one commit: re-read `newestHead`; if it differs from `Base.expectedHead`, the
hook's decision was made against a superseded context → terminalize `failed/stale` (never pair old entries
with a new head). Otherwise: no handler answer → proceed with `input.instructions`; `{ decline: true }` →
`failed/declined` for every reason (manual, threshold, overflow), no summary, no fault; `{ instructions }` →
replaces `Base.instructions`; `{ summary }` → commit `prepared` with that text and skip the provider; else
commit `summarizing`. Call the summarizer outside the line. Provider error: classify with
`isRetryableAssistantError`; retryable, `retry.enabled` and `attempt <= retry.maxRetries` → commit
`retrying{ untilMs = now + retryDelayMs(retry, attempt), lastError }` (recording the attempt that failed),
sleep, commit `summarizing` with `attempt + 1`, call again; otherwise `failed/provider`. The
summarizer request is request-local and **tool-free**: every tool definition effective in the projected
historical request (the fold of `toolsAdded`/`toolsRemoved` across its `SystemMessage`s, which is authoritative
regardless of the current registry) is removed by a request-local `toolsRemoved` on the private copy, and no
new tools are offered; a summarizer response containing tool calls is treated as a provider
failure (`failed/provider`, "summarizer returned tool calls") and retried under the policy. On a successful response commit `prepared`
with the summary text. Closure: `newestHead` read first; if it differs from `expectedHead`, `failed/stale`
(someone else collapsed). Else append `pi.summary { data: {through}, model: [user summary], head: first entry
after through }` and return completed. Edits appended in between do not stale. Recover: `summarizing` → the
call may have happened; count it as that attempt's failure exactly like generation's `requesting` recovery:
if `retry.enabled` and `attempt <= retry.maxRetries`, commit `retrying{ untilMs: now + retryDelayMs(retry,
attempt), lastError: "interrupted" }`, sleep, then `summarizing` with `attempt + 1`; otherwise `failed/provider`. Never replay the same attempt number.
`retrying` → sleep out `untilMs`, then `summarizing` with `attempt + 1`; `prepared` → finalize only, no
provider call. One live collapse per conversation; a second creation returns the existing ID. Collapse
never blocks generation or input. Manual `c.collapse` returns the task ID; the caller reads its outcome.

### 10.5 `pi.job`

A job is a long-running external process owned by a task from its first effect. It is an ordinary kind: its
notices are passive `write`s, which `BaseTaskTx` provides, so it needs no core authority. Jobs are created by
hosts through `HostTx.task`, by other ordinary tasks through `BaseTaskTx.task`, and by tools through the gated
mediated task operation of section 11.1.

```ts
input:  JobInput   (declared with ProcessHost below)
checkpoint:
  | { phase: "waiting";  untilMs: number; occurrence: number }
  | { phase: "spawning"; key: string; occurrence: number }                       // inflight: the host may have started it
  | { phase: "running";  key: string; occurrence: number }
result:  { exitCode: number; occurrences: number }
failure: { reason: "spawn" | "interrupted"; detail: string }
aborted: { killed: boolean }
output:  JobOutput   (declared with ProcessHost below; mutable, unlike the readonly host snapshots)
```

Jobs run through an injected **process host**, the only code that touches the OS. The host, not Pico, owns
whatever durability it can honestly provide:

```ts
type JobInput = { readonly command: string; readonly args: readonly string[]; readonly cwd: string;
                  readonly env?: { readonly [name: string]: string };
                  readonly notify: boolean; readonly rerun: boolean; readonly every?: number; readonly notBefore?: number };
type ProcessSpec = Pick<JobInput, "command" | "args" | "cwd" | "env">;
type ProcessOutput = { readonly stdout: string; readonly stderr: string; readonly droppedStdout: number; readonly droppedStderr: number };   // bounded tails; readonly host snapshot
type JobOutput = { -readonly [K in keyof ProcessOutput]: ProcessOutput[K] } & { exitCode?: number; occurrence: number };   // the task's mutable OutputState, mirrored from status() inside output.mutate
type ProcessStatus =
  | ({ readonly status: "running" } & ProcessOutput)
  | ({ readonly status: "exited"; readonly exitCode: number } & ProcessOutput)
  | { readonly status: "unknown" };                                              // host has no durable record of this key
interface ProcessHost {                                                          // implemented by hosts; copy this verbatim
  start(key: string, spec: ProcessSpec, ctx: Context): Promise<void>;          // idempotent per key: a second start for a key the host knows is a no-op.
                                                                                 // Rejects only when it knows no process started (ENOENT, EACCES, bad cwd); if the outcome is
                                                                                 // uncertain it must resolve and report through status(). A rejection is a domain outcome, not a fault.
  status(key: string, ctx: Context): Promise<ProcessStatus>;
  kill(key: string, signal: "SIGTERM" | "SIGKILL", ctx: Context): Promise<void>;   // idempotent if key already exited or is unknown
}
```

Pico polls `status` (same backoff schedule as retries, capped at 1 s) and copies the bounded output into the
task output; it never holds a stream and never reads a PID. The bundled `nodeProcessHost()` keeps runs in process memory
only: after a restart every key is `unknown`. A host that redirects output to files and supervises the child
(or a remote executor) may return `running`/`exited` across restarts; that is the host's contract to keep, and
Pico does not specify how. The host is injected through `HarnessOpenOptions.processHost`; when absent, a job's
execute terminalizes `failed/spawn` ("no process host") before any checkpoint. Memory-storage tests use a fake
host.

Execute, per occurrence `n`: if `notBefore`/`every` says wait, commit `waiting` and `sleep`. Commit
`spawning{ key: `${taskId}:${n}`, occurrence: n }` **before** any OS effect (the inflight checkpoint). Call
`host.start(key, ...)`, commit `running{ key, occurrence }`, then poll `status` until `exited`, mirroring
output into `output.mutate`. On exit: if `notify`, `tx.write` a `pi.notice` for this occurrence in the same
commit as the next checkpoint (`waiting` for a schedule, or the terminal snapshot for a one-shot); if `every`,
`output.replace` a fresh state for `n + 1` and loop under the same task ID (no backlog is inferred after
downtime); else return completed.

`start` rejecting → the closure terminalizes `failed/spawn` with the host's message (and `write`s the notice
if `notify`); nothing escapes the task method. `status` rejecting (the host itself is broken or unreachable)
→ the closure terminalizes `failed/interrupted` with the host's message: the process outcome is unknown *and*
unknowable, so `rerun` does not apply (rerun is for `unknown`, where the host answered). A `kill` rejection
during fresh abort is the documented failing-abort case (7.3) and faults. `status` returning `unknown` at any point, during the ordinary
poll or on recover, means the process may or may not have started or finished and Pico cannot know: if
`rerun`, `start` again with the same key (a possible duplicate external effect, exactly the uncertainty the
recoverability disclaimer in 3.2 allows), else `failed/interrupted`.

Recover: `waiting` → sleep until the stored `untilMs`, then continue that occurrence (commit `spawning`, ...).
`spawning` or `running` → `host.status(key)`; `running`/`exited` → continue as above; `unknown` → the rule
just stated. Abort, by checkpoint: none or `waiting` → no process exists, no host call, closure returns
`{ killed: false }`; `spawning`/`running` → `kill(key, "SIGTERM")`, `rt.sleep(now + 5000)`, then
`kill(key, "SIGKILL")`, and return `{ killed: true }` if both host calls resolve. Here `killed` means the host
accepted the cleanup sequence for a possibly started key, not proof that the process was still alive; `kill`
must be idempotent for an exited or unknown key. A rejection is the failing-abort fault described above. A
schedule ends wherever it is. Notices are passive writes: a notice about occurrence `n` is admitted with `n`'s
checkpoint and placed at the next boundary if the conversation is busy; `result` carries no entry ID because
placement may happen after the job terminalized.

## 11. Tools and hooks

### 11.1 Tools: normative behaviour, gated API

The behaviour of the built-in `pi.tool` kind (10.2) and of every tool *result* is normative. The exact
programming interface an ordinary tool author writes against is **gated**: this is the one intentional gap in
this document. Nothing below the "Gated" heading may be implemented until its final shape is appended here.

Normative (settled), independent of the gated shape:

```ts
// what a tool declares, minus its execution signature
interface ToolDeclaration<P extends TSchema = TSchema> {
  readonly name: string; readonly description: string; readonly parameters: P;
  readonly replay?: "safe" | "unsafe";                          // default unsafe
  readonly output?: { maxBytes?: number; maxLines?: number; retain?: "head" | "tail" };  // default 64k / 200 / head
}
// what a tool produces (public, pi-ai typed content)
interface ToolResult<D extends JsonValue = JsonValue> {
  content: readonly (TextContent | ImageContent)[];
  details?: D;                               // typed, for UIs; stored in entry data
  isError?: boolean;
  usage?: ToolUsage;
  diagnostics?: readonly ToolDiagnostic[];   // about the call, rendered after the output
  control?: ToolControl;
}
// durable payload pieces are exact type aliases (interfaces have no implicit index signature and would not satisfy JsonObject)
type ToolControl = {
  readonly terminate?: true;      // end the turn after this exchange
  readonly handoff?: string;      // end the turn and reset context with this message
  readonly addTools?: readonly string[];   // additive: appended to selectedTools by post_tools before its continuation, so the next model request offers them; never removes
};
type ToolDiagnostic = { readonly severity: "info" | "warn" | "error"; readonly message: string; readonly code?: string };
```

Ordinary tool code never receives `commit`, `entry`, `write`, task lifecycle methods or any admission helper.
Reason: a tool is plugin code; the transcript and the task are Pico's. The `pi.tool` kind owns the tool's
task: it enforces `output` bounds on `content`, emits the truncation diagnostics it owns, stores the exact model
message in entry `model` and the rest (`ToolResultData`) in entry `data`, and streams the tool's live progress
as its own `TaskOutput<ToolOutputState>` (10.2). `h.tools` registers `ToolDeclaration`s plus the gated execution
part.

**Gated: the ordinary tool execution API.** Not settled, not to be inferred from the generic task runtime:
the `execute` signature, the facade a tool receives (previously sketched as a `ToolApi`; that sketch is
withdrawn), how the tool reaches the `pi.tool` task's `TaskOutput` for streaming progress, durable memos, the
keyed child-task and subagent operations, and the owned-descendant resolver. The settled requirements the
final shape must satisfy are:

- It is a small `pi.tool`-mediated surface over the current invocation: the tool's identity is the stable
  `pi.tool` task ID, its output is that task's `TaskOutput`, and durable strict-JSON memos are protected
  state scoped to that task, retired with it.
- A keyed child-task operation, if included, uses one internal `pi.tool` transaction to create the child and
  record its ID, kind, `abortWithTool: boolean` and optional shared-output ref in the complete parent
  checkpoint before returning. Jobs remain tasks created this way; there is no `startShell` verb and no
  adoption of an unfinished promise.
- A keyed subagent operation, if included, applies a `ConversationSeed` (section 8.1) in one internal
  `pi.tool` transaction: `createConversation` (owner = the tool task), the seeded config/sticky/section
  values, the internal `accept` of the first input through the fixed generation strategy, and the complete
  parent checkpoint recording conversation ID, input ID, request key and `abortWithTool`. It then resolves the
  existing restricted `TaskConversation` and waits outside the line. A subagent is an owned conversation,
  never a subagent task or a spawn operation with its own lifecycle.
- A repeated creation key is either explicitly first-key-wins or compares a persisted canonical spec
  (normalized parent position, input, request key, initial values, seed profile/version, `abortWithTool`);
  never mutable current values. The choice is part of the gated decision.
- Returned task handles expose wait/abort, never commit. A local wait timeout is observation only: it returns
  "timed out" without marking the child. The `pi.tool` terminal closure rereads the child on the line: a
  terminal child yields the normal final result; a live child yields the continues-in-background result while
  the child retains any shared output. No design may trust stale `Promise.race` state.
- Returned conversation handles are capped at the existing `TaskConversation`: scoped `send` plus the returned
  input's result/wait/abort; no commit, direct entry, admission helpers, close, shutdown or unrelated state.
  Any model-facing status/tail projection must be specified before it is added.
- `abortWithTool: false` means only that enclosing `pi.tool` abort does not mark that child; it is not a
  generic detachment abstraction. Parent normal completion cancels neither.
- Later sibling tool calls need one narrow built-in resolver for strict owned descendants of their current
  parent conversation, including ownership through terminal sibling tasks. Fork-only ancestry and unrelated
  roots reject. It must not broaden `runtime.conversation` or `TaskConversation`.

Until this decision is appended here, no ordinary tool can be executed: `pi.tool` (10.2) is implemented and
tested against an internal test executor that returns `ToolResult`s, and every built-in tool (including `bash`
and `subagent`) waits for the API. WP10 delivers `pi.tool` to that boundary and no further.

### 11.2 Hooks

Hooks are declared by the task kind that invokes them. There is no global hook interface. A kind declares
typed points; its implementation calls `runtime.hooks.run(kind.hooks.point, input, ctx)` at the moments it chooses; the
scheduler and kernel never interpret point names. Core kinds ship predefined points; ordinary kinds declare
their own the same way.

```ts
type Fold = "collect" | "first" | "chain";
interface HookPoint<In, Out, F extends Fold = Fold> {
  readonly fold: F;                                // how several handlers' outputs combine
  readonly onThrow: "skip" | "abort";              // skip: report, drop this handler's output, continue
                                                   // abort: stop, kind receives { threw: error }
  readonly [hookIn]?: In; readonly [hookOut]?: Out;   // compile-only
}
declare function defineHookPoint<In, Out = void>(options: { readonly fold: "collect"; readonly onThrow: "skip" | "abort" }): HookPoint<In, Out, "collect">;
declare function defineHookPoint<In, Out = void>(options: { readonly fold: "first"; readonly onThrow: "skip" | "abort" }): HookPoint<In, Out, "first">;
declare function defineHookPoint<In extends object, Out extends Partial<In>>(options: { readonly fold: "chain"; readonly onThrow: "skip" | "abort" }): HookPoint<In, Out, "chain">;   // chain: object input, output is a patch of In
type HookPoints = Record<string, HookPoint<unknown, unknown>>;

type HookHandler<P> = (input: HookIn<P>, info: HookInfo, ctx: Context) => HookOut<P> | void | Promise<HookOut<P> | void>;
interface HookInfo { readonly kind: string; readonly taskId: Id; readonly conversationId: Id }

interface HookRunner<H extends HookPoints> {
  run<P extends H[keyof H]>(point: P, input: HookIn<P>, ctx: Context): Promise<HookResult<P>>;   // point token from this kind's bundle
}
type HookResult<P> =
  P extends { fold: "collect" } ? { outputs: readonly HookOut<P>[]; threw?: unknown } :
  P extends { fold: "first" }   ? { output?: HookOut<P>; threw?: unknown } :
                                  { output: HookIn<P> /* chained */; threw?: unknown };

interface HarnessHookRegistry {
  on<K extends { hooks?: HookPoints }, P extends NonNullable<K["hooks"]>[keyof NonNullable<K["hooks"]>]>(
    kind: K, point: P, handler: HookHandler<P>,
  ): () => void;   // unregister; harness-wide has no scope option
}
interface ConversationHookRegistry {
  on<K extends { hooks?: HookPoints }, P extends NonNullable<K["hooks"]>[keyof NonNullable<K["hooks"]>]>(
    kind: K, point: P, handler: HookHandler<P>, options?: { readonly subtree?: boolean },
  ): () => void;   // this conversation; subtree: also conversations it owns, recursively
}
// h.hooks: HarnessHookRegistry        h.hooks.on(myKind, myKind.hooks.somePoint, handler)
// c.hooks: ConversationHookRegistry   c.hooks.on(myKind, myKind.hooks.somePoint, handler, { subtree })
```

Points are passed as tokens (`kind.hooks.somePoint`), not strings. Reason: plugin kinds may reuse point names,
and a token carries its owning kind, input/output types, fold and failure policy, so nothing is looked up by
name and nothing can collide.

Fold semantics: `collect` runs every handler and returns all non-void outputs in order; `first` stops at the
first non-void output; `chain` is legal only for object `In` and requires `Out extends Partial<In>`: handlers run
sequentially, each output is shallow-merged over the current input, a void return passes it through, and the
final current input is the result. The generic rule has no terminal predicate. One built-in point adds an
explicit short-circuit, stated on that point only: `beforeTool` stops the chain as soon as an output sets
`block`. Handler order: harness-wide in registration
order, then outermost conversation to innermost. Handlers run outside the line, receive and must forward
`ctx`, may take as long as they like (a human approval is a hook that waits), and may run again after a crash
because the kind re-enters the phase that ran them; external side effects need their own keys. The runner
awaits each handler's actual return, never a raced promise. Cancellation errors always propagate and unwind
the invocation; `onThrow` governs other errors only. Handlers hold no task, transaction or transcript
authority; they receive `HookInfo` for identity and use ordinary public handles for state.

A decision a hook returns is revalidated in the commit that applies it (section 10); the hook itself commits
nothing. Hooks never run on the line, inside a closure, or after it; a kind that needs committed data for a hook
takes an immutable snapshot through a read-only `runtime.commit` first. Timing of every core point:
`systemInstructions` during preparation, before `prepared`; `beforeRequest` after `prepared`, before
`requesting`; `afterResponse` after every terminal provider message, before retry/failure classification and
before the generation closure; `onYield` after `afterResponse`, only on success and when no trigger is queued;
`beforeTool` after lookup and initial validation but before the `started` checkpoint; `started` is committed
immediately before invocation. `afterTool` runs after the tool returns, before the tool closure; `afterTools` after the read-only
snapshot, before the post_tools closure; `beforeCollapse` before the `summarizing` checkpoint.

Core points (declared on the respective kind; `fold`/`onThrow` shown):

| kind | point | input | output | fold / onThrow |
|---|---|---|---|---|
| generation | `systemInstructions` | `{ sections: SystemSectionDraft; config: Settings; tools: readonly ToolDeclaration[] }` | `{ tools?: ToolDeclaration[] }` (override only) | collect / skip; a skipped handler's draft edits are rolled back |
| generation | `beforeRequest` | `{ request: { messages: Message[] }; cutoff: Id }` | `{ request?: { messages: Message[] } }` | chain / skip |
| generation | `onYield` | `{ answer: AssistantMessage }` | `{ continue: string }` | first / skip |
| generation | `afterResponse` | `{ message: AssistantMessage; usage?: Usage; attempt: number }` (every terminal provider message: success, error, aborted, deferred fetch) | void | collect / skip |
| tool | `beforeTool` | `{ call: ToolCall; block?: { reason: string } }` | `{ call?: ToolCall; block?: { reason: string } }` | chain, stops on `block` / abort → block |
| tool | `afterTool` | `{ call: ToolCall; result: ToolResult }` | `{ result?: ToolResult }` | chain / skip |
| post_tools | `afterTools` | `{ assistant: Id; results: Id[] }` | void | collect / skip |
| collapse | `beforeCollapse` | `{ reason; through: Id; entries: Entry[] }` | `{ decline: true } \| { instructions?: string; summary?: string }` | first / skip |

`beforeTool` is the one point with a short-circuit: an output that sets `block` ends the chain; the tool is not
invoked and the result is an error result with `block.reason`. Otherwise the final `call` is what runs, and only
its `arguments` may differ from the original: `id`, `name` and every other identity field (type, signature,
namespace, provider metadata) must equal the model's original call; a fold whose `call` changed any of them is
treated as `block` with reason "call identity changed" (a hook may narrow or normalize a call, never redirect it
to a different executor). The final `arguments` are then schema-validated exactly like the original call's: a
hook that rewrites them into something invalid produces the same synthetic `isError` result, never an invocation
with bad arguments. `onThrow: "abort"` there means a throwing handler sets `block` with the
error message. `beforeRequest`'s input is `{ request, cutoff }` and only `request` is patchable; `afterTool`'s is
`{ call, result }` and only `result` is patchable; `cutoff` and `call` are read-only context.

This is the same derivation principle as configuration (section 2.1): a kind exposes two typed bundles,
`kind.config` and `kind.hooks`; `c.config` is assembled from the first, `c.hook` (section 13.1) from the
second. `c.hooks.on(kind, kind.hooks.point, handler, scope)` and `h.hooks.on(...)` are the generic forms for
any kind. Each point's metadata is owned by the kind that declares it; the flattened `c.hook.<name>` methods
are wrappers and introduce no second schema.

## 12. System prompt and tool loadout

Pico sends pi-ai `{ messages }` only. System instructions and the tool loadout are `SystemMessage`s inside
`messages` at their historical positions. pi-ai owns native translation and best-effort cache preservation.
This depends on the pi-ai system-message API (`SystemMessage` with `toolsAdded`/`toolsRemoved`, messages-only
adapters, PR #9116), which is a hard dependency of WP9 and WP10: those packages wait for it and import its
types and adapters; Pico never ships a stand-in `SystemMessage` or its own provider-side translation.

```ts
// pi-ai (PR #9116); reproduced here for reading only, imported in code. After the PR, pi-ai's `Message` union includes it,
// which `Entry.model: readonly Stored<Message>[]` and `SystemEntry extends Entry` rely on: the WP1 compile matrix passes only
// against a pi-ai that has landed it (a hard dependency, section 18).
interface SystemMessage {
  role: "system"; content: string; toolsAdded?: Tool[]; toolsRemoved?: Tool[]; timestamp: number;
}
```

### 12.1 Sections

```ts
interface SystemSection<T extends JsonValue = JsonValue> { readonly key: string; render(value: T): string }   // default generic is the erased registry form
declare function defineSystemSection<T extends JsonValue>(definition: { readonly key: string; render(value: T): string }): SystemSection<T>;
declare const systemSections: { readonly identity: SystemSection<string>; readonly environment: SystemSection<EnvironmentInfo>; readonly skills: SystemSection<SkillInfo[]> };
// h.sections: MutableRegistry<SystemSection>   erased default generic; register rejects duplicate key; replace requires same key; remove keeps stored data
```

Tokens carry a stable key and a pure synchronous renderer. Only keys, payloads and rendered text are stored;
never renderers. Payloads are JSON; changing a registered payload type needs a compatible replacement.

### 12.2 Draft

```ts
interface SystemSectionDraft {
  get<T extends JsonValue>(s: SystemSection<T>): T | undefined;          // owned copy
  set<T extends JsonValue>(s: SystemSection<T>, value: T): void;         // existing key keeps position; new key appends
  delete(s: { readonly key: string }): void;                             // explicit; every section token satisfies this; null is a valid payload
  wrap<T extends JsonValue>(s: SystemSection<T>, transform: (rendered: string) => string): void;   // preparation-local
}
```

Preparation seeds one draft from the canonical section state (12.4). `systemInstructions` handlers run in
order (section 11.2) editing that draft. A handler that throws has its own mutations and wrappers discarded;
earlier handlers' changes stay. After all handlers: touched sections are rendered, wrappers apply in
registration order after rendering, and the result is frozen. The tool loadout defaults to
`generationKind.config.selectedTools` resolved against `h.tools` (unknown names are dropped and reported through
`onReport`, section 13);
handlers do not need to return tools. A handler that returns `tools` overrides the loadout for this
preparation with that complete list; the last such handler wins.

Handlers must be replay-safe as a set: a handler that appends to a persisted seed accumulates unless an
earlier handler resets that section's base each time. Wrappers are not stored; untouched sections keep their
previously rendered text including old wrapper output.

### 12.3 Managed entries

```ts
type SectionRecord =
  | { key: string; action: "set"; value: JsonValue; rendered: string }
  | { key: string; action: "remove" };
type SystemEntryData = { readonly baseline?: true; readonly sections: readonly SectionRecord[] };
```

- **Baseline**: `baseline: true`, complete ordered state of every section. Its `SystemMessage.content` is every
  section formatted as `## ${key}\n${rendered}`, in canonical order, joined by one blank line; `toolsAdded` is the
  complete loadout; `timestamp` is the commit time.
- **Delta**: only changed sections (`set`) and explicit deletions (`remove`). Its `SystemMessage.content` states
  each change: `The ${key} section now reads:\n${rendered}` for a set, `The ${key} section no longer applies.`
  for a removal, joined by one blank line. `toolsRemoved`
  lists previous complete definitions no longer wanted; `toolsAdded` lists new or changed complete
  definitions. Removals apply before additions; same-name additions upsert. Tool definitions live only in
  `SystemMessage` fields, never duplicated in `data`.
- A delta whose data changed but whose rendering and tools did not has `model: []` (metadata-only).
- Tool-only changes may have empty `content`.

The frozen draft is diffed against the canonical state: unchanged data and rendering → no entry; else a
delta, or a baseline when 12.4 requires one.

### 12.4 Canonical state, heads, forks, restarts

Canonical section state = fold the fork-visible managed entries from the newest `baseline` forward through
its deltas. This uses the indexed `pi.system` kind scan and never depends on model heads or edits; a
collapse or reset does not erase section payloads. An optional prepared-state cache may shortcut the fold.

A usable model baseline must follow the newest head. If the newest head is after the newest baseline, the
next preparation appends a fresh full baseline at the tail carrying omission edits for every retained
superseded managed entry (baselines and deltas between the head and the tail). This atomic supersession is
the only permitted edit of managed entries; any other omit/replace targeting them rejects. Already superseded
entries omitted by the current baseline do not cause another baseline.

```text
10 user; 11 baseline; 20 assistant; 30 user; 31 delta; 35 notice; 40 assistant; 50 user
60 summary, head=30
context at 60: [60, 30, 31, 35, 40, 50]
70 assistant; 80 user
81 baseline, edits:[{target:31, action:omit}]
context at 81: [60, 30, 35, 40, 50, 70, 80, 81]
```

Forks and owned conversations created with `parent` see the managed entries visible at their fork point.
Their first preparation compares desired state against that inherited canonical state and appends the delta
(or baseline, if a head intervened): for a host fork the desired state starts from the inherited sections; for
a task-owned child it starts empty, so every unseeded inherited section is removed and every inherited tool
not in the child's isolated loadout is in `toolsRemoved` (section 8.1). Inherited messages are never
rewritten. A conversation created without `parent` has no managed history; its first preparation appends a
full baseline from the seed plus handlers. Restart without a plugin keeps its payload and rendered text; re-registering a compatible
definition restores typed editing; only explicit `delete` removes a section.

### 12.5 Preparation and staleness

```text
on line: take the preparation snapshot S = { newestManaged: Id | null,
                                             newestHead: Id | null,          // decides baseline vs delta (12.4)
                                             config: current generationKind.config values,
                                             sectionsRev, toolsRev: registry revisions (h.sections, h.tools) }
         and copy the canonical section fold and definitions
off line: run systemInstructions handlers on the draft; render; collect tools
on line, in the `prepared` commit:
  re-take S'; if S' != S (any field) -> discard, repeat preparation (until one snapshot commits or the task is cancelled)
  compute delta/baseline; if any -> buffer entry.append (managed; omission edits if baseline)
  buffer checkpoint prepared{cutoff = newest visible entry after this append, system = entry id or null, ...}
```

Every mutable registry carries a monotonically increasing revision, bumped by `register`/`replace`/`remove`.
Reason for snapshotting config and registry revisions, not just the newest managed entry: a `c.config.set`, a
`replace` of a section renderer or a tool registration that commits while handlers run would otherwise pair the
managed entry at its historical position with instructions or a loadout computed from stale inputs. `newestHead`
is in the snapshot because a speculative collapse can append a summary head while handlers run; without it the
commit could append a delta against a baseline that now lies before the head, violating the fresh-baseline rule
of 12.4. A miss is ordinary churn, not a fault: preparation simply repeats and the next pass chooses baseline
versus delta against the new head; cancellation is the only exit. Whether an
offered tool's *executable* is still compatible when the model later calls it is a property of the gated
ordinary tool API (section 11.1); tool names in the checkpoint identify what was offered, nothing more.

The request snapshot is captured after that commit and is immutable; a summary landing afterwards changes
the live context, not the request. A crash after the managed append but before the request preserves the
prepared instructions; the next preparation finds no change and appends nothing.

`beforeRequest` runs after this commit on a private messages-only copy (section 10.1 step 2); the tool names
offered after transformation are recorded in the `requesting` checkpoint as the validation basis for the
model's calls. Transformed requests themselves are not stored.

## 13. Harness

```ts
interface HarnessOpenOptions<R extends Partial<Settings> = {}> {
  readonly models: Models;                        // pi-ai; generationKind.config.model resolves against it
  readonly tools?: readonly ToolDeclaration[];   // execution part gated (11.1)
  readonly taskKinds?: readonly OrdinaryKind[];
  readonly entryKinds?: readonly EntryKind[];
  readonly sections?: readonly SystemSection[];
  readonly root?: RootSeed<R>;                       // fresh root only; ignored on reopen
  readonly rootValues?: readonly SeedWrite[];        // advanced alias for root.values
  readonly onReport?: (report: Report, ctx: Context) => void;   // non-fatal diagnostics (hook skipped, unknown tool name, unknown entry kind); off line; throws ignored
  readonly processHost?: ProcessHost;             // section 10.5; absent -> every pi.job fails { reason: "spawn", detail: "no process host" } at execute
}
type Report =
  | { readonly type: "hook_skipped"; readonly kind: string; readonly point: string; readonly conversationId: Id; readonly error: unknown }
  | { readonly type: "unknown_tool"; readonly conversationId: Id; readonly name: string }
  | { readonly type: "unknown_entry_kind"; readonly kind: string };
interface RootSeed<R extends Partial<Settings>> {
  readonly config?: NoExtra<Partial<Settings>, R>;   // same shape and exactness as c.config.set
  readonly values?: readonly SeedWrite[];            // any other conversation or session values (set or delete)
  readonly sections?: readonly SectionSeed[];        // build with sectionSeed(section, value)
}
// Harness.open<R extends Partial<Settings>>(storage: Storage, options: HarnessOpenOptions<R>, ctx); R is inferred from root.config
interface Harness {
  root(ctx: Context): Promise<ConversationHandle>;
  conversation(id: Id, ctx: Context): Promise<ConversationHandle | undefined>;
  createConversation(seed: ConversationSeed, ctx: Context): Promise<ConversationHandle>;   // independent (no owner); may include first input; one commit
  conversations(query: ConversationScan, ctx: Context): Promise<Page<Conversation>>;   // explicit query; `limit` is required by PageQuery
  entries(query: EntryScan, ctx: Context): Promise<Page<Entry>>;                       // fork-aware, newest-first; pre-head history lives here
  tasks(query: TaskScan, ctx: Context): Promise<Page<Task>>;                           // hosts never touch Storage directly
  commit<T>(build: (tx: HostTx) => T | Promise<T>, ctx: Context): Promise<T>;
  input(requestId: string, ctx: Context): Promise<InputHandle | undefined>;
  getEntry(id: Id, ctx: Context): Promise<Entry | undefined>;
  getEntry<E extends Entry>(kind: EntryKind<E>, id: Id, ctx: Context): Promise<E | undefined>;
  getTask(id: Id, ctx: Context): Promise<Task | undefined>;
  getTask<K extends AnyDefinedKind>(kind: K, id: Id, ctx: Context): Promise<TaskOf<K> | undefined>;
  value<D extends Value<JsonValue>>(a: D): PublicValue<PayloadOf<D>, ResolvedValue<D>>;   // session scope; bound only
  list<T extends JsonValue>(a: List<T>): PublicList<T>;
  waitForIdle(ctx: Context): Promise<void>;                  // all foreground tasks in the session; rejects Closed/Faulted
  abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
  resume(ctx: Context): Promise<void>;  close(ctx: Context): Promise<void>;  shutdown(ctx: Context): Promise<void>;
  inspect(ctx: Context): Promise<OpenInspection>;
  readonly kinds: CoreTaskKinds;
  readonly taskKinds: MutableRegistry<OrdinaryKind>;
  readonly entryKinds: MutableRegistry<EntryKind>;
  readonly tools: MutableRegistry<ToolDeclaration>;
  readonly sections: MutableRegistry<SystemSection>;
  readonly hooks: HarnessHookRegistry;
  watchConversation(id: Id, options: ConversationWatchOptions, ctx: Context): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watchSession(ctx: Context): Promise<WatchHandle<SessionView, SessionEvent>>;
  watchSession(options: SessionWatchOptions, ctx: Context): Promise<WatchHandle<SessionView, SessionEvent>>;
}
interface ConversationHandle extends BoundPublicState {   // value/list bind unbound definitions; a defaulted definition reads as T, others as T | undefined
  readonly id: Id;
  commit<T>(build: (tx: ConversationTx) => T | Promise<T>, ctx: Context): Promise<T>;
  send(input: SendInput, ctx: Context): Promise<InputHandle>;
  waitForIdle(ctx: Context): Promise<void>;                  // this conversation's foreground set; rejects Closed/Faulted
  abort(ctx: Context): Promise<void>;
  fork(options: ForkOptions, ctx: Context): Promise<ConversationHandle>;   // section 8.1; parent is this conversation
  collapse(ctx: Context): Promise<Id>;  collapse(options: { readonly instructions?: string }, ctx: Context): Promise<Id>;
  reset(ctx: Context): Promise<void>;   reset(options: { readonly handoff?: string }, ctx: Context): Promise<void>;   // see below
  readonly config: ConfigFacade<CoreConfigBundle>;   // section 2.1: model, thinkingLevel, selectedTools, profile, retry, steeringMode, followUpMode, threshold, keepRecent
  readonly hook: HookFacade<CoreHookBundle>;         // section 13.1: systemInstructions, beforeRequest, afterResponse, onYield, beforeTool, afterTool, afterTools, beforeCollapse
  readonly hooks: ConversationHookRegistry;           // generic: on(kind, kind.hooks.point, handler, { subtree })
  watch(ctx: Context): Promise<WatchHandle<ConversationView, ConversationEvent>>;
  watch(options: ConversationWatchOptions, ctx: Context): Promise<WatchHandle<ConversationView, ConversationEvent>>;   // === h.watchConversation(id, ...)
}
```

`reset` is a `write` of `pi.reset` or `pi.handoff{head: "self"}`: appended immediately when idle, queued when
busy. It resolves once the write is durably admitted (appended or queued), not when placed; placement is
observed through the watch (`entry` event with `head`). A `head: "self"` write can never go stale (its boundary
is itself). Cancelling `ctx` before admission cancels nothing durable; after admission the write stays. There is
no public handle for passive writes, and `InputHandle` is reserved for admitted user input.

`fork({ abort: true })` aborts the source conversation's foreground set first ("go back"). `fork` inherits
rewindable state and managed system history through the parent walk; the seed fields override locally
(section 8.1). `h.createConversation(seed, ctx)` creates an independent conversation (no owner) and, unlike the
synchronous `tx.createConversation`, may carry the first input.

Registries supply implementations, not selections: registering a tool does not offer it to the model;
`generationKind.config.selectedTools` does. `h.kinds` exposes the fixed core kinds as typed witnesses for
`config`/`hooks` derivation and `TaskOf` narrowing; possession of a witness confers no creation authority.

Registries (`h.taskKinds`, `h.entryKinds`, `h.tools`, `h.sections`) are asynchronous and serialize on the line.
`register` rejects an existing name and any `pi.*` name; `replace` requires an existing ordinary name;
task-kind `replace`/`remove` reject while live instances exist; entry/section/tool removal keeps durable
records. In-flight invocations and preparations keep the definitions they started with; but any *new* creation
they attempt with the old token (`tx.task(oldKind, …)`, `tx.write(oldEntryKind, …)`) rejects `StaleDefinition`
(section 5.2), because the current registration is a different object. Hook registration
(`h.hooks.on`, `c.hooks.on`, `c.hook.*`) is different in kind: synchronous, process-local, returns an
unsubscribe function, touches no durable state and does not enter the line.

Open order:

1. Backend replay; initialize `nextId` after the highest committed ID; construct the disabled scheduler.
2. Install core kinds and built-in sections, then options.
3. Empty storage: create root conversation (ID 1) and apply `root` (`config` → the corresponding
   `generationKind.config`/... definitions, `values` set/delete, `sections` → the root record's section-seed metadata) plus
   `rootValues`, all bound to conversation 1, no duplicate addresses, in one commit. Nonempty: ignore both.
4. Load live tasks and the ownership ancestry they need. Do not load terminal history. Discover stored
   entry-kind names through the kind index for `unknownEntryKinds`.
4a. Validate every live fixed built-in task (`pi.generation`, `pi.tool`, `pi.post_tools`, `pi.collapse` and
   the ordinary-authority but fixed `pi.job`) against its fixed input/checkpoint schema. Any mismatch fails
   open: built-in state that Pico itself cannot read is corruption, never an orphan. The five are always
   installed, cannot be replaced, and never reach step 5.
5. Orphan reconciliation, one commit: every live task whose kind is not registered → `terminal/orphaned`,
   scratch retired; every registered live foreground task in conversations it owns → marked. Queues kept.
   Dependents see `orphaned` and decide. Registration never resurrects an orphaned task.
6. Return. Nothing runs until `resume`.

Any failure in 1–5 (including 4a) closes the storage and rejects; there is no partially open Harness.

### 13.1 Conversation config and hooks facades

Both facades are assembled from the core kinds' `config` and `hooks` bundles. They add no schema and no
authority; every member is the generic operation with the kind or address bound.

```ts
// config: one property per core config address, plus batched set/get (section 2.1). Usage:
//   c.config.model                      PublicValue<ModelRef, ModelRef | undefined>: get(ctx) | get(at, ctx), set, delete
//   c.config.thinkingLevel              PublicValue<ThinkingLevel, ThinkingLevel>      (defaulted: never undefined)
//   c.config.selectedTools              PublicValue<readonly string[], readonly string[]>
//   c.config.steeringMode               StickyPublicValue<"all" | "one-at-a-time", "all" | "one-at-a-time">: get(ctx), set, delete
//   c.config.followUpMode               same sticky queue-mode facade
//   c.config.retry                     StickyPublicValue<Stored<RetryPolicy>, Stored<RetryPolicy>>
//   c.config.threshold / keepRecent    PublicValue<number, number>
//   c.config.set({ model, thinkingLevel, selectedTools, steeringMode, followUpMode, retry }, ctx)   exact partial, one commit
//   c.config.get(ctx)                   all current values, one read

// hook: one method per built-in point, flattened across the fixed kinds exactly like config
interface CoreHooks { readonly generation: typeof generationHooks; readonly tool: typeof toolHooks; readonly postTools: typeof postToolsHooks; readonly collapse: typeof collapseHooks; readonly job: {} }
type CoreHookBundle = UnionToIntersection<CoreHooks[keyof CoreHooks]>;
type HookFacade<H extends HookPoints> = {
  readonly [N in keyof H]: (handler: HookHandler<H[N]>, options?: { readonly subtree?: boolean }) => () => void;
};
type _AssertDisjointHooks = Assert<DisjointBundles<CoreHooks>>;   // compile error on a duplicate flattened point name; re-asserted at install
type _HooksMatchKinds = Assert<{ [K in keyof CoreHooks]: NonNullable<CoreTaskKinds[K]["hooks"]> extends CoreHooks[K] ? true : false }[keyof CoreHooks]>;

// the bundles the fixed kinds attach as `<kind>.hooks` (the points' In/Out types are the table in 11.2)
const generationHooks = {
  systemInstructions: defineHookPoint<{ readonly sections: SystemSectionDraft; readonly config: Settings; readonly tools: readonly ToolDeclaration[] }, { readonly tools?: readonly ToolDeclaration[] }>({ fold: "collect", onThrow: "skip" }),
  beforeRequest:      defineHookPoint<{ readonly request: { readonly messages: readonly Message[] }; readonly cutoff: Id }, { readonly request?: { readonly messages: readonly Message[] } }>({ fold: "chain", onThrow: "skip" }),
  onYield:            defineHookPoint<{ readonly answer: AssistantMessage }, { readonly continue: string }>({ fold: "first", onThrow: "skip" }),
  afterResponse:      defineHookPoint<{ readonly message: AssistantMessage; readonly usage?: Usage; readonly attempt: number }>({ fold: "collect", onThrow: "skip" }),
} satisfies HookPoints;
const toolHooks = {
  beforeTool: defineHookPoint<{ readonly call: ToolCall; readonly block?: { readonly reason: string } }, { readonly call?: ToolCall; readonly block?: { readonly reason: string } }>({ fold: "chain", onThrow: "abort" }),
  afterTool:  defineHookPoint<{ readonly call: ToolCall; readonly result: ToolResult }, { readonly result?: ToolResult }>({ fold: "chain", onThrow: "skip" }),
} satisfies HookPoints;
const postToolsHooks = {
  afterTools: defineHookPoint<{ readonly assistant: Id; readonly results: readonly Id[] }>({ fold: "collect", onThrow: "skip" }),
} satisfies HookPoints;
const collapseHooks = {
  beforeCollapse: defineHookPoint<{ readonly reason: "threshold" | "manual" | "overflow"; readonly through: Id; readonly entries: readonly Entry[] }, { readonly decline: true } | { readonly instructions?: string; readonly summary?: string }>({ fold: "first", onThrow: "skip" }),
} satisfies HookPoints;

// Usage:
//   c.hook.systemInstructions(h, { subtree: true })   === c.hooks.on(generationKind, generationKind.hooks.systemInstructions, h, { subtree: true })
//   c.hook.beforeTool(h)                              === c.hooks.on(toolKind, toolKind.hooks.beforeTool, h)
//   c.hooks.on(myPluginKind, myPluginKind.hooks.myPoint, h)   plugin kinds: generic registry, token-addressed
```

Singular `c.hook` is the flattened built-in convenience; plural `c.hooks` is the generic registry. Built-in
point names are unique across the fixed kinds by construction (`Assert<DisjointBundles<CoreHooks>>`) and re-checked when core kinds are installed. Plugin points are never flattened because plugin names can collide; they are
addressed by token.

`c.watch(ctx)` / `c.watch(options, ctx)` is `h.watchConversation(c.id, options ?? {}, ctx)`.

The Harness has neither facade. It keeps process-wide definition registries (`h.taskKinds`, `h.entryKinds`,
`h.tools`, `h.sections`), the typed witnesses `h.kinds`, and generic harness-wide `h.hooks.on(kind,
kind.hooks.point, ...)`. Configuration is conversation state, so it lives on the conversation.

Advanced forms remain: `generationKind.config.model` tokens with `c.value(...)`, `c.hooks.on(kind,
kind.hooks.point, ...)`, `h.watchConversation(id, ...)`, `rootValues`. The primary surface is `root.config`,
`c.config.<name>`, `c.hook.<name>(...)`, `c.watch(...)`.

### 13.2 Cloudflare Durable Objects

One Durable Object hosts one Session, one Harness and one scheduler covering the root and every fork and
subagent. The Node implementation uses `AsyncLocalStorage` to reject line entry from inside any active Session
callback; a Cloudflare deployment therefore enables `nodejs_compat`. A request wake opens Pico, `send` durably
admits and ensures `resume`. An alarm or one logical
Cloudflare Task wake opens Pico and calls `resume`, which recovers all eligible work in all conversations.
Platform wake-up is not effect recovery: do not create one lane or scheduler per conversation, and do not use
platform replay as a second authority for provider/tool effects. If admission and the platform wake cannot
share a transaction, an adapter adds an ordered handoff or idempotent retry so acknowledged work always
causes another wake. Checkpoints and `recover` remain authoritative across invocation limits.

## 14. Watch

```ts
interface WatchOptions { readonly capacity?: number; readonly onError?: (error: unknown) => void }   // default capacity 256
interface ConversationWatchOptions extends WatchOptions {
  readonly values?: readonly (Value<JsonValue> | UnboundValue<JsonValue>)[];   // plugin/application values; `pi.*` rejects (built-in config has view.config; internals are protected)
  readonly lists?:  readonly (List<JsonValue>  | UnboundList<JsonValue>)[];    // plugin/application lists; same rule
}
interface SessionWatchOptions extends WatchOptions { readonly values?: readonly Value<JsonValue>[]; readonly lists?: readonly List<JsonValue>[] }   // session scope only

interface WatchedValue { readonly address: Value<JsonValue>; readonly value?: JsonValue }
interface WatchedList  { readonly address: List<JsonValue>;  readonly elements: readonly Element<JsonValue>[] }   // complete current list at capture; bound address
interface WatchedTaskOutput { readonly id: Id; readonly kind: string; readonly value: OutputState }
interface ConversationView {
  readonly conversation: Conversation;
  readonly entries: readonly Entry[];        // the active transcript in transcript order: every entry with id >= the newest head's boundary (the head entry sits at its own position)
  readonly context: readonly Id[];           // model-visible IDs derived from `entries` (edits folded, omissions applied)
  readonly tasks: readonly Task[]; readonly taskOutputs: readonly WatchedTaskOutput[];
  readonly inbox: readonly Element<QueuedInput>[];
  readonly config: ConfigSnapshot<CoreConfigBundle>;   // every built-in config value, always captured
  readonly values: readonly WatchedValue[];            // only the explicitly requested plugin/application values
  readonly lists: readonly WatchedList[];              // only the explicitly requested plugin/application lists
  readonly readAt: Seq;
}
type ConfigSnapshot<B> = ResolvedValues<Omit<B, ReservedConfigKeys>>;   // same definitions as c.config; only `model` (no default) is `| undefined`
interface SessionView { readonly conversations: readonly Conversation[]; readonly values: readonly WatchedValue[]; readonly lists: readonly WatchedList[]; readonly readAt: Seq }
// Session-level usage totals and fault/report feeds are intentionally not part of v1 (not gated, not planned
// here). `HarnessOpenOptions.onReport` is the complete v1 non-fatal report channel; faults surface as `Faulted`
// rejections and `closed/session` watch deliveries.

type ListOp<T extends JsonValue = JsonValue> = { type: "append"; element: Element<T> } | { type: "remove"; id: Id } | { type: "clear" };
type ConversationEvent =
  | { type: "entry"; entry: Entry } | { type: "task_start"; task: Task } | { type: "task_update"; task: Task; previous: Task }
  | { type: "task_end"; task: Task & { status: "terminal" } } | { type: "task_output"; id: Id; kind: string; delta: readonly Op[] }
  | ConfigEvent<CoreConfigBundle>                                      // built-in config, typed by key
  | { type: "value"; value: WatchedValue }                             // requested plugin/application values only
  | { type: "list"; address: List<JsonValue>; ops: readonly ListOp[] } // requested plugin/application lists; ops for one address in one commit, in write order
  | { type: "inbox"; ops: readonly ListOp<QueuedInput>[] } | { type: "context"; ids: readonly Id[] };
type ConfigEvent<B> = {
  [K in Exclude<keyof B, ReservedConfigKeys>]: {
    readonly type: "config";
    readonly key: K;
    readonly value: ResolvedValue<B[K]>;      // after a delete, the default, never undefined for defaulted members
    readonly previous: ResolvedValue<B[K]>;
  };
}[Exclude<keyof B, ReservedConfigKeys>];   // flat and discriminated on `key`: e.key === "model" narrows e.value to ModelRef | undefined
type SessionEvent =
  | { type: "conversation"; conversation: Conversation; change: "created" } | { type: "value"; value: WatchedValue }
  | { type: "list"; address: List<JsonValue>; ops: readonly ListOp[] };

interface CommitEnvelope<E> { readonly first: Seq; readonly last: Seq; readonly events: readonly E[] }
type WatchDelivery<E> = ({ readonly type: "commit" } & CommitEnvelope<E>) | { readonly type: "closed"; readonly reason: "overflow" | "session" };   // d.events, d.first, d.last
interface WatchHandle<V, E> { readonly view: V; start(listener: (d: WatchDelivery<E>) => void): void; unsubscribe(): void }
declare function applyConversationCommit(view: ConversationView, commit: CommitEnvelope<ConversationEvent>): ConversationView;
declare function applySessionCommit(view: SessionView, commit: CommitEnvelope<SessionEvent>): SessionView;
```

Capture and subscribe happen in one line operation, so the view plus the stream after `readAt` is gapless
and duplicate-free. A conversation view holds the **active transcript** in transcript order: every fork-visible
entry whose ID is ≥ the newest head entry's boundary, through the current tail; the head entry itself sits at
its own chronological position (after the boundary), not first; with no head, the whole transcript. Placing
the summary before the retained tail is context projection (1.3), not the view. It also holds live tasks
directly in that conversation, every distinct output they reference, the current inbox, every built-in
configuration value as `config`, exactly the requested custom values as `values` and requested lists as
`lists` (session addresses or addresses bound to this conversation; others reject `ScopeViolation`; built-in
config and protected `pi.*` reject). A later source-conversation write emits nothing for an existing fork.

`view.config` is derived from the same `CoreConfigBundle` as `c.config` (section 2.1): one property per
built-in definition (`model`, `thinkingLevel`, `selectedTools`, `profile`, `retry`, `steeringMode`, `followUpMode`,
`threshold`, `keepRecent`), current value or `undefined`, with the same default resolution the core tasks use.
A watch always captures these; `values` is for plugin and application addresses only, and a built-in config
definition listed there rejects (it has its own field and event; it is never silently folded into `config`),
as does any protected internal. Duplicate requested `values`/`lists` entries are deduplicated by address
identity (the tuple in section 2), keeping the position of the first request: each address appears once in
`view.values`/`view.lists` and produces one event per commit. Reason: every renderer shows the model and tool loadout; making
each client know the address list would duplicate the schema. A built-in config write emits a dedicated
flat `config` event: `{ type: "config", key, value, previous }`, typed by key. Reason: a generic `value` event with an address is mechanically sufficient but forces every UI to match
addresses back to names; the discriminated `key` gives `e.key === "model"` → `e.value: ModelRef | undefined` for free,
derived from the same bundle as `c.config`. A batched `c.config.set({...})` produces one
`config` event per changed key in one envelope; the reducer folds all of them into `view.config` before the
listener runs. Built-in definitions never appear as `value` events; requested plugin/application addresses
never appear as `config` events. Initial state is read from `view.config`. Protected state (`pi.inbox`,
`pi.input_result`, `pi.request`, `pi.output`, scratch, conversation-record seed metadata) is never exposed through `config` or
`values`; inbox and task outputs have their own fields.

There is no `tail` count or other window option in v1. Reason: the head already defines what the model and
the user are working with; a numeric window would cut it arbitrarily.

Entry reducer, exactly:

```text
capture:            entries = active transcript in transcript order (ids >= newest head's boundary; or all if no head)
entry event, no head:  entries.push(entry)
entry event with head: boundary = entry.head                      (head:"self" was materialized to entry.id at append)
                       entries = entries.filter(e => e.id >= boundary)   // drop everything before the retained boundary
                       entries.push(entry)                              // the new head entry itself comes last
```

So a summary with `head = firstRetained` keeps `firstRetained..current` and appends the summary; a reset or
handoff with `head = its own id` drops every prior active entry and appends itself. The truncation and the
append happen inside the fold of the same commit envelope, so no intermediate view shows both prefixes and no
separate truncate event exists: the `entry` event already carries `head`. The capture is the only time the
full active list is materialized; afterwards the view is maintained incrementally. `context` remains its own
full-ID event because edits and heads change the derived projection non-locally. Entries before the active
head are history, read through `h.entries({ conversationId, cursor, limit })`/`h.getEntry`, not through the live watch.

Events of one commit arrive in one envelope, folded into `view` before the listener runs. A boundary commit
therefore shows inbox removal, entry append, result and successor task together, with no transient duplicate
or idle gap. Same-commit inbox append+remove emits no inbox event. A commit with no events after filtering is
not delivered and uses no capacity, while `view.readAt` still advances. A `context` event is emitted whenever
the derived context ID list changes.

Reducers are pure and free of plugin kinds: `applyConversationCommit` needs no registry because every event
carries what it applies (`config` events carry `key`/`value` over the statically fixed `CoreConfigBundle`; `list`
events carry the bound address and ops). `task_start` on create; `task_update` on any non-terminal replacement;
`task_end` on terminal (always with outcome). `task_output` carries a decoded delta applied with
`applyImmutable()`; when the last referencing task ends in the same envelope, output events precede
`task_end` and the reducer then drops the output. `list` ops for one address within one commit are grouped
into one event in committed write order and folded onto `view.lists[address].elements` before the listener:
`append` pushes the element (stable ID), `remove` deletes by ID, `clear` empties. The inbox uses the same op
shape on its own field. No replay, cursor or acknowledgement protocol exists for lists; overflow closes the
watch like everything else.

Overflow closes the watch with `overflow` after discarding queued deliveries; the consumer opens a new watch
and gets a fresh authoritative capture. No resume protocol. A listener throw closes only that watch and calls
`onError` off the line; an `onError` throw is ignored; the session never faults. Session close delivers
`closed/session` once. `unsubscribe` is idempotent and stops all callbacks.

### 14.1 Plugins and remote clients

Pico does not publish plugin state to UIs and has no plugin-config publication API. The integration pattern is
the existing Chord facet split, already used by `packages/coding-agent/examples/plugins/pi-example-plugin`
(`contract.ts`, `session.ts`, `tui.ts`) and the experimental services in
`packages/coding-agent/src/experimental/services/` (`models-provider.ts`, `transcript-provider.ts`) and
`src/experimental/mini/worker/`:

- **contract**: `defineService<S>(id)` with typed methods and `ReplicatedState<DTO>` fields. The DTO is what the
  plugin chooses to expose; it is not the plugin's Pico addresses.
- **session facet**: runs in the process that owns the Harness. It stores its durable state in its own Pico
  definitions (`conversationValue`/`sessionValue`/lists) through `c.value`/`h.commit`, reconstructs a
  presentation-safe `MutableReplicatedState` from those values on activation and reopen, and updates it from
  Pico commits (its own `commit` results, or a watch on the values it cares about). It `env.provide`s the
  service.
- **presentation facet** (TUI, web): `env.use(Service)`, subscribes to the replicated state, renders, calls
  the typed methods. It never receives a Harness, an address, or a `ConversationView` of another plugin's
  values.

Pico is the durable authority; Chord `ReplicatedState` is a live snapshot/delta projection over RPC, never
storage. Built-in config stays special: `view.config` and the `config` event are automatic because every UI
needs them. Everything a plugin wants a UI to see goes through its own service DTO. This is guidance about how
to compose the existing pieces, not a Pico API; nothing in sections 1–14 changes for it.

## 15. Backends

```ts
MemoryStorage.create(): Storage
JsonlStorage.open(path: string, ctx): Promise<Storage>
SqliteStorage.open(path: string, options: { readonly session: string }, ctx): Promise<Storage>
```

A `Storage` is opened by its backend and handed to `Harness.open`. One Session owns a `Storage` while open;
that exclusivity and the `close` lifecycle are internal Session/backend concerns, not a separate public
concept. JSONL/SQLite hold a cross-process lock from open to close; two writers fail rather than race. Memory
has no lock but still rejects a second concurrent Session; the same `MemoryStorage` may be reopened by a later
Session after close for recovery tests.

Persisted output deltas are decoded Chord `Op[]`; `Op` is strict JSON by construction (tuples of tag, path
segments and Chord `JsonValue` payloads), so it needs no codec. Replay validates every `Op` tuple shape before
applying. The JSONL file and the SQLite schema each carry their one existing format version; nothing is added
for `Op`.

**JSONL**: one main file; one sidecar per live task scratch scope; one sidecar per live output with
post-creation deltas (task creation and the initial output base are in main). Record: `{ first: Seq, last:
Seq, maxId: Id, writes: Write[] }`, newline-terminated, `last - first + 1 === writes.length`. `maxId` is the
committed-ID high-water *after* this batch, written into every record of every file, main and sidecar alike.
Reason: sidecar appends (scratch list elements, output deltas) mint IDs; once that task or output retires its
sidecar is ignored, so the IDs would be lost if reopen only scanned retained writes. Because the retiring main
record carries the high-water forward, reopen takes `max(maxId)` over retained records only and is still
correct. fsync every record before
publication; fsync new files and their directories. Replay main first, derive live scratch/output IDs from
live tasks, replay only those sidecars. Retired sidecars are ignored even if malformed (a stale file cannot
resurrect state). Sequence ranges increase within a file and never overlap across retained files; gaps are
valid. Bytes after the last newline are a torn write: truncate, fsync, continue. A complete but malformed
line fails open. Sidecar unlink failure is harmless because the main record proves retirement. Reopen
initializes `nextId` to `max(maxId over retained records) + 1` and the applied `Seq` from the greatest retained
endpoint.

```text
main   seq 1..10   maxId 12   (task 12 created; its scratch sidecar opens)
scratch seq 11..15 maxId 40   (list elements 13..40 appended in the sidecar)
main   seq 16      maxId 40   (task 12 terminal; sidecar retired, may be unlinked or left malformed)
reopen: retained = main only -> nextId = 41; no ID in 13..40 is ever reused
failed callback minted 41..43 without commit -> nothing persisted -> next open still starts at 41
```

**SQLite**: tables for conversations, entries (facets as columns), tasks (current snapshot), values +
rewindable versions, list elements + clear markers, scratch, output deltas, commit boundaries, and one
`meta(max_id)` row updated in every commit transaction (the same high-water rule as JSONL). Index task
status/abort/conversation/kind/output and entry conversation/head/kind. `PRAGMA synchronous=FULL` or a
documented equivalent. Terminal `task.set` deletes scratch rows in the same transaction. Reopen loads live
tasks and named owner records, not terminal history. Schema version mismatch rejects; no migration in v1.

Both run the same conformance suite as memory.

## 16. State-indexed task authoring (`defineStateTask`)

An optional public adapter for ordinary kinds with several durable phases. It compiles to an ordinary
`TaskKind`; the scheduler and kernel are unchanged. It makes one kind's checkpoint dispatch exhaustive at
compile time.

```ts
// constraints abbreviated: <I,C,R,F,A,O,H> always mean I,R,F,A extends JsonValue; C extends TaskCheckpoint;
// O extends OutputState; H extends HookPoints (section 3.3). Written out in full here because this block must compile literally.
type PhaseOf<C extends TaskCheckpoint> = C["phase"];
type CheckpointAt<C extends TaskCheckpoint, P extends PhaseOf<C>> = Extract<C, { readonly phase: P }>;
type PhasePayload<C extends TaskCheckpoint, P extends PhaseOf<C>> = Omit<CheckpointAt<C, P>, "phase">;
type PhaseTask<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, P extends PhaseOf<C>> =
  Omit<RunningTask<I,C,O>, "checkpoint"> & { readonly checkpoint: CheckpointAt<C,P> };
type InitialTask<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState> =
  Omit<RunningTask<I,C,O>, "checkpoint"> & { readonly checkpoint?: never };

type StateTransitionTx<C extends TaskCheckpoint> = Omit<BaseTaskTx<C>, "checkpoint">;
type StatePhaseTx<C extends TaskCheckpoint, P extends PhaseOf<C>> = StateTransitionTx<C> & { checkpoint(value: CheckpointAt<C,P>): void };
type InitialStateRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, H extends HookPoints> =
  Omit<TaskRuntime<I,C,O,H>, "commit">;   // no commit before the first checkpoint
type StateRuntimeFor<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, P extends PhaseOf<C>, H extends HookPoints> =
  Omit<TaskRuntime<I,C,O,H>, "commit"> & {
    commit<V>(build: (tx: StatePhaseTx<C,P>, current: PhaseTask<I,C,O,P>) => V | Promise<V>, ctx: Context): Promise<V>;
  };

interface PhaseTransition<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, P extends PhaseOf<C>> {
  readonly type: "transition"; readonly phase: P;
  readonly commit: (tx: StateTransitionTx<C>, current: RunningTask<I,C,O>) => PhasePayload<C,P> | Promise<PhasePayload<C,P>>;
}
interface StateTerminal<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState> {
  readonly type: "terminal"; readonly closure: TerminalClosure<I,C,R,F,O>;
}
type StateTransitions<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState> =
  { [P in PhaseOf<C>]: PhaseTransition<I,C,O,P> }[PhaseOf<C>];   // distributed: each member pairs one literal phase with exactly its payload
type StateResult<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState> =
  StateTransitions<I,C,O> | StateTerminal<I,C,R,F,O>;

interface StateActions<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState> {
  transition<P extends PhaseOf<C>, Actual extends PhasePayload<C,P>>(
    phase: P,
    commit: (tx: StateTransitionTx<C>, current: RunningTask<I,C,O>) => NoExtra<PhasePayload<C,P>, Actual> | Promise<NoExtra<PhasePayload<C,P>, Actual>>,
  ): PhaseTransition<I,C,O,P>;
  terminal(closure: TerminalClosure<I,C,R,F,O>): StateTerminal<I,C,R,F,O>;
}

type PhaseHandler<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState,
                  P extends PhaseOf<C>, H extends HookPoints> =
  | { readonly role: "start"; readonly recover?: never;
      run(task: PhaseTask<I,C,O,P>, rt: StateRuntimeFor<I,C,O,P,H>, actions: StateActions<I,C,R,F,O>, ctx: Context): Promise<StateResult<I,C,R,F,O>> }
  | { readonly role: "inflight";
      run(task: PhaseTask<I,C,O,P>, rt: StateRuntimeFor<I,C,O,P,H>, actions: StateActions<I,C,R,F,O>, ctx: Context): Promise<StateResult<I,C,R,F,O>>;
      recover(task: PhaseTask<I,C,O,P>, rt: StateRuntimeFor<I,C,O,P,H>, actions: StateActions<I,C,R,F,O>, ctx: Context): Promise<StateResult<I,C,R,F,O>> };
type PhaseMap<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState, H extends HookPoints> =
  { readonly [P in PhaseOf<C>]: PhaseHandler<I,C,R,F,O,P,H> };

type StateTaskDefinition<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, A extends JsonValue,
                         O extends OutputState, H extends HookPoints> = {
  readonly kind: string;
  readonly hooks?: H;                                       // kind-owned hook points, as on defineTask
  readonly config?: ConfigBundle;
  readonly initial: { readonly role: "start";
    run(task: InitialTask<I,C,O>, rt: InitialStateRuntime<I,C,O,H>, actions: StateActions<I,C,R,F,O>, ctx: Context): Promise<StateResult<I,C,R,F,O>> };
  readonly phases: PhaseMap<I,C,R,F,O,H>;                 // handlers receive StateRuntimeFor<..., H>
  abort(task: RunningTask<I,C,O>, rt: AbortTaskRuntime<I,C,O,H>, ctx: Context): Promise<AbortClosure<I,C,A,O>>;
} & TaskOutputDefinition<I,O>;

declare function defineStateTask<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue,
                                 A extends JsonValue, O extends OutputState = never>():
  <H extends HookPoints, D extends StateTaskDefinition<I,C,R,F,A,O,H>>(
    definition: string extends PhaseOf<C> ? never : ExactStateTaskDefinition<StateTaskDefinition<I,C,R,F,A,O,H>, D>,
  ) => D & TaskKind<I,C,R,F,A,O,H>;   // H and D["config"] inferred from the literal exactly as in defineTask; lifecycle unchanged
```

Compile contract: `C` is a finite union with literal `phase`s (broad `string` rejects); every phase has
exactly one handler and no extra key exists; each handler receives its complete narrowed checkpoint; `start`
has `run` only, `inflight` has `run` and `recover`; `initial` has no checkpoint and no `commit`; transition
payloads reject missing or visible extra fields for literals, variables and spreads; the returned
`StateResult` itself preserves the phase/payload correlation (`StateTransitions` distributes over the phases,
so a hand-built `{ type: "transition", phase: "a", commit: () => payloadForB }` is a compile error, not only
through `actions.transition`); `terminal` preserves the typed `TerminalClosure`. `ExactStateTaskDefinition`/`ExactPhaseMap`/`ExactPhaseHandler` are the
`NoExtra` helpers that enforce this; they are spelled in appendix A.

Generated `execute`/`recover`:

```text
execute: no checkpoint -> fence; initial.run
         transition(P, commit) -> module-private commitStateTransition: on the line, check invocation and
             expected source phase, run commit(tx, fresh current), buffer full task.set with {phase:P, ...payload},
             persist, return the applied PhaseTask<P> (checkpoint and owns from the live projection)
         fence; phases[P].run ... repeat until terminal(closure) -> return closure to the normal terminal path
recover: no checkpoint -> fence; initial.run
         start checkpoint P -> fence; phases[P].run
         inflight checkpoint P -> fence; phases[P].recover
         after any committed transition the loop continues with run
```

The scheduler calls the generated method once per invocation. `commitStateTransition` is a module-private
symbol on the runtime; it is not exported and grants no author capability. Transition callbacks run on the
line: reads before the first write, then compose same-commit entries/tasks/state; no effects, waits, hooks or
nested commits.

Why `initial` cannot commit: with no durable phase, a crash would rerun `initial` and duplicate any child it
created. Children are created in the first transition callback, atomically with the first checkpoint.
Checkpoint-backed handlers keep `commit` for same-phase bookkeeping (e.g. create a child and record its ID in
the current phase before waiting); phase changes only through returned transitions.

`start` means the checkpoint represents no uncertain external effect, so reopen reruns `run`. `inflight`
means an effect may have started, so reopen requires `recover`.

Fence: immediately before every handler call the adapter synchronously checks the exact invocation object,
ctx, session phase, durable mark and abort signal. If a mark landed first, the handler is never invoked; the
ordinary cancellation unwind returns from the outer method and fresh abort follows. If the transition
persisted first, the handler is admitted and a later mark signals it normally.

## 17. Test matrix

Each item is a test, run in both orders where a race is named.

**Storage / line**
- IDs vs sequences: failed callback burns IDs; reopen reuses uncommitted IDs, never committed ones;
  state-only writes advance `Seq` without `nextId`; IDs minted only in a since-retired sidecar are not reused
  after reopen (high-water carried by the retiring main record).
- Read before write ok; read after write → `ReadAfterWrite`, nothing persisted.
- Rewindable write after entry in one batch → reject.
- Protected internals: external `conversationValue("pi.inbox")` rejects at construction; a hand-built `pi.inbox`
  address rejects `ScopeViolation` on generic read/write/watch/`rootValues`; imported `generationKind.config.model`
  works through `c.value`/`c.config`/`rootValues`.
- Concurrent commits serialize; an awaited read holds the line.
- Uncertain storage failure → fail-stop; callback not retried.
- Terminal `task.set` retires scratch and unreferenced output atomically; retired reads reject in all backends.
- Rewind through fork caps; tombstones; list remove/clear at historical positions; nested forks; unrelated
  position → `InvalidHistoryPosition`.
- Scan cursors, `through`, `newestHead`, filters; list remove of a foreign element (other definition or
  unrelated conversation) rejects; a fork removes an inherited parent element through its own bound address
  (local removal, parent unchanged, historical reads before the removal still show it); removing it twice is
  idempotent.
- Pre-persistence assertion failures fault: invalid transition, unpaired ownership, output ref to retired output.

**Admission**
- Idle send: one batch places, creates one generation, records result + receipt.
- Busy send: followUp/steer queue, no task; reject throws and writes nothing.
- Duplicate requestId: same batch, later, other conversation → original handle, nothing written.
- `h.input(requestId)` for a core request-keyed write receipt → `undefined`; a `send` reusing that key →
  `RequestKindMismatch`; public `tx.write` has no request key and returns the input id only.
- `h.createConversation({ input, requestId })` / `c.fork({ at, input, requestId })` with an existing receipt for
  that key → `RequestKindMismatch`, no conversation and no input created; `h.input(requestId)` still finds the
  original; a fresh key creates both atomically.
- No `processHost` → `pi.job` fails `spawn` before any checkpoint.
- Withdraw vs place: exactly one terminal result.
- Hydration: `wait`/`result` return `input: UserEntry` and `answer.{entry, message}` where `message ===
  entry.model[0]`; a later edit targeting the assistant entry does not change a previously or subsequently
  hydrated `message`. Passive writes have no public input outcome.
- Steer vs post_tools; followUp vs final answer: consumed exactly once. `all` vs `one-at-a-time` per mode.
  Placement order is by input ID across modes: a steer admitted before a write precedes it at the boundary.
- Queued write with head vs collapse committed meanwhile → `unanswered/stale`, no fault.
- Queued write placed at post-tools boundary lands after the complete exchange.
- Reset before followUp in the inbox (`R` then `B`) at post-tools: old group `unanswered/terminated`, no
  continuation, `B` placed after `R` starts a fresh generation whose cutoff context starts at `R`. FollowUp before
  reset (`B` then `R`): `B` placed then made invisible by `R` → `unanswered/stale`, no generation for `B`; with
  `one-at-a-time` and `B1, B2, R` queued, the unselected `B2` is also removed and `unanswered/stale`, so a later
  idle send does not resurrect it; same cases at a final-answer boundary and an idle send; idle `c.reset` with
  followUps left queued by a task abort → they resolve `unanswered/stale` in the reset's commit and a later send
  starts from the reset alone.
- Several inputs in one group all resolve to the same answer.
- Task abort keeps queue; conversation abort withdraws steer/followUp, keeps write.
- Idle-turn boundary after post_tools with no continuation.
- Owned conversation seed: create + config values + isolation deletes + section seed + first accept + owner
  checkpoint in one commit; crash before commit leaves nothing; with `parent`, child reads no rewindable
  `CoreConfigBundle` member from the parent; first preparation removes every unseeded inherited section and
  every inherited tool outside the isolated loadout; a host fork with `parent` keeps inherited sections and
  config and only applies overrides; sync `tx.createConversation` rejects `input`/`copySticky` at the type
  level; `SeedWrite` delete cuts an inherited plugin value; first generation reserved in the same drain still
  sees the seed; missing seeded model → `no_model` failure, no fault.
- Child hooks: inert creation then `c.hooks.on` then `send` runs child handlers on the first request; atomic
  creation with `profile` dispatches pre-registered subtree handlers by profile on the first request; reopen
  with code reinstalled before `resume` restores both; unknown profile falls to defaults.
- Collapse does not make busy: idle send during collapse starts generation.
- Yield continuation: same `inputs` carried, results stay `placed`; transcript order is assistant, then placed
  writes, then the `pi.user` continuation; queued trigger arriving between hook and closure wins and the yield
  decision is discarded; a queued reset/handoff placed at the boundary also discards it: inputs `done(answer)`,
  no continuation, no successor.

**Tasks / scheduler**
- Reserve before effect; reopen runs `recover` with and without checkpoint.
- Closure commits once; throwing closure → nothing persisted, session faults.
- Dependency terminal (any outcome) wakes dependent exactly once.
- Resume vs commit both orders: nothing missed, nothing double-dispatched; drain-exit race.
- Tasks across conversations run concurrently; background continues after foreground idle.
- Self-wait and dependency-path wait reject; `after` cycle rejects.
- Cancelled waiter removes only itself.
- Output: a `mutate` with no tracked change persists nothing and emits nothing (no `Seq` consumed); a `replace`
  with a structurally equal value still persists one base flush and emits one event; two tasks write one output
  in line order; shared ref keeps output live past first task's terminal;
  `initial` not called for a shared ref; final closure gets `tx.output`; `mutate` throw faults; sidecar after
  retirement ignored on reopen.
- Output across conversations: task in B adopts A's output → B's watch envelope carries a synthetic full base
  before `task_start` and later deltas apply; last local ref ends in B → B drops it while A keeps it; the
  adjacent serialized commits in either order stay gapless: delta-before-adoption (the synthetic base already
  includes it) and adoption-before-delta (the next `task_output` applies it).

**Cancellation / lifecycle**
- Mark vs effect return: one invocation; fresh abort after old return.
- Post-mark commit/scratch/output → reject before callback.
- Closure vs mark: committed-first wins; otherwise closure discarded.
- Pending marked before reservation: no execute, abort runs.
- Repeated mark during abort: no effect.
- Close writes nothing; shutdown marks all, preserves queues; crash during shutdown → reopen + resume finishes.
- Close sequence: `close` waits behind the admitted commit, which persists; then phase `closing` on the line,
  waiters reject, watches get `closed/session`, queued operations reject `Closed`; invocations joined before
  `storage.close`; the Harness object is permanently unusable. Fault: waiters reject `Faulted`, watches get
  `closed/session`, nothing written afterwards.
- Conversation abort reaches foreground ordinary tasks and threshold collapse in the subtree; background jobs
  and manual collapse survive.
- Broken abort handler: shutdown rejects, task stays durable.
- Orphan reconciliation: missing kind → orphaned, scratch retired, registered descendants marked, queues kept.
- `pi.tool` abort marks children with `abortWithTool: true` only; subagent queues preserved.
- Registry: replace/remove of a kind with live instances rejects.
- Token identity: `tx.task(unregisteredKind)` and `tx.write(unregisteredEntryKind)` reject `StaleDefinition`; after
  `h.entryKinds.replace(newNote)`, `tx.write(oldNote, …)` rejects and `tx.write(newNote, …)` works; a task
  method that captured the old definition keeps running to completion with it; a structurally identical
  redeclared token with the same `kind` string rejects.
- Hooks: `c.hook.<name>` methods exist for exactly the fixed kinds' points and dispatch to the same registry
  as `c.hooks.on(kind, kind.hooks.point, ...)`; a duplicate flattened built-in name fails install; two plugin
  kinds with same-named points register independently by token.
- Hooks: ordinary kind declares a custom point; `collect`/`first`/`chain` folds; `skip` vs `abort` on throw;
  cancellation propagates regardless; harness-wide then outer→inner order; `subtree` reaches owned
  conversations only; handler rerun after crash re-enters the phase.

**Core kinds** (faux provider, faux tools)
- Generation: tool calls → N tools + one post_tools atomically; final answer → boundary + successor.
- Retry sequence: `retrying{attempt: n}` → `requesting{attempt: n+1}` with identical cutoff/system/model/thinking;
  step 1 does not rerun; overflow measured on the post-hook request; a hook that adds a tool declaration makes
  that name appear in `requesting.tools`.
- Streaming: provider `partial` is never inserted into the tracker (mutating it after `start` changes nothing
  in the output); each encoded frame yields exactly one incremental Chord delta (no whole-message replace per
  token); after the stream the tracker value equals `reduceAssistantMessageFrames(frames)`; the stored assistant
  entry is a validated clone.
- Recover from each generation phase; failed attempts produce `pi.usage` entries, the final attempt's usage is
  on `pi.assistant` only; recovery from `requesting` with retries left records `pi.usage{ error: "interrupted" }`
  and retries; with retries exhausted or disabled it terminalizes `failed/*` with no assistant entry and inputs
  `unanswered/failed`;
  `c.config.model` changed between crash and recover → recovered request still uses `Prep.model`; `beforeRequest`
  reruns on recovery from `prepared`; `requesting` checkpoint carries post-hook tool names; `retry` policy
  honoured (`maxRetries`, `retryDelayMs`, `enabled: false` → no retry); `afterResponse` runs once per attempt
  including error/aborted responses and deferred fetch results; deferred: `pollAfterMs` respected,
  re-deferred handle refreshes the checkpoint, abort calls `cancelDeferred`.
- Generation terminal error: non-retryable/exhausted error and provider-side `aborted` → one display-only
  assistant entry, inputs `unanswered/failed`; overflow with no collapsible prefix → notice + `failed/overflow`,
  no collapse task; replacement generation after failed collapse → notice + inputs `unanswered/failed`.
- Threshold: estimate over `threshold` → foreground collapse created, generation completes, conversation abort
  reaches it; `through` = boundary before the largest suffix within `keepRecent`; whole context fits → no task
  and manual collapse rejects `NothingToCollapse`; overflow via `estimateContextTokens` → `failed/overflow` +
  replacement generation.
- Overflow → collapse + replacement generation atomically; replacement handles collapse failure/decline.
- Tool: `beforeTool` output changing `call.name`/`id` → blocked "call identity changed", not invoked; call naming a
  tool absent from the originating generation's offered `tools` → "tool not offered" error result, registry not
  consulted; a deferred generation that completed with tool calls (last checkpoint `deferred`) passes the evidence
  check and proceeds to normal registry lookup; generation record missing → fault; missing tool / bad args (original or after a
  `beforeTool` rewrite) / `block` / throw → error result, not fault; `beforeTool` chain merges `call`
  rewrites and stops at the first `block` (later handlers not run); crash after reservation but before
  `started` → recover reruns validation/hooks and starts (no interruption result), for `safe` and `unsafe`
  alike; crash after `started` persists the final rewritten call and never reruns `beforeTool`: current
  missing/unsafe/schema-incompatible definition yields an interrupted/unavailable result, while current safe
  and valid replays the persisted arguments; parallel completion order vs projection order; output bounds and
  truncation diagnostics.
- Tool child (once the mediated capability is settled): keyed creation is idempotent after safe replay;
  wait timeout → background result without marking; closure reread finds terminal child → normal result;
  `abortWithTool: false` child survives tool abort; sibling resolver rejects fork-only ancestry.
- Tool control: `terminate` ends the turn; `handoff` ends it and appends `pi.handoff` *before* the final
  boundary so a queued follow-up's generation starts in the fresh context; `handoff` beats `terminate`; several
  `addTools` append to the existing `selectedTools` in call order with stable dedupe (nothing previously
  selected is dropped) in one write, and the next baseline/delta shows the change; `addTools` reads
  `selectedTools` fresh in the closure, so a config change made during `afterTools` is not lost.
- Post_tools synthesizes results for orphaned/aborted tools; mixed batch (one orphaned tool, another with
  `addTools`): the `selectedTools` write precedes the synthesized result entry in the `Write[]`, the fork
  invariant holds, and both effects land in one commit.
- Post_tools aborted (task abort and conversation abort): every input in `inputs` resolves `unanswered/aborted`;
  `InputHandle.wait` on them settles; no successor generation; queued followUp survives task abort.
- Collapse: stale head → `failed/stale`; edits in between do not stale; summary head placement; `decline` →
  `failed/declined`; hook `summary` goes to `prepared` without a provider call; crash in `summarizing` reruns
  the summarizer as a failed attempt (`retrying` then `attempt + 1`, or `failed/provider` when exhausted/disabled,
  never the same attempt twice); crash in `prepared` finalizes without a call; unset model → `failed/no_model`
  before any hook or checkpoint; summarizer request offers
  no tools; a summarizer response with tool calls is a provider failure; head moves while `beforeCollapse`
  waits → `failed/stale`, hook decision discarded; retry passes through `retrying` with `untilMs`.
- Job: `spawning` before OS effect; fake host `status` → `running`/`exited` continues; `unknown` (on recover or
  mid-poll) → `interrupted` unless `rerun`, which calls `start` again with the same key; `start` for a known
  key is a no-op; `start` rejecting (ENOENT) → `failed/spawn`, no fault; `status` rejecting → `failed/interrupted`
  without rerun, no fault; `kill` rejecting in abort → fault; recover from `waiting` sleeps the stored deadline
  then spawns; abort with no key → `{ killed: false }` and no host call; abort with a spawning/running key →
  TERM, 5 s, KILL (idempotent if already exited); each schedule
  occurrence writes its notice with the next `waiting` checkpoint; dropped byte counts copied from `status`;
  abort ends the schedule.
- System: preparation reruns when config, `h.sections`, `h.tools` or the newest head change while handlers run (a collapse landing mid-preparation yields a baseline, not a stale delta); baseline content is `## key\nrendered` blocks joined by blank lines; delta content is `The key section
  now reads:` / `no longer applies.` blocks; unchanged draft appends nothing; delta on change with `toolsRemoved` before `toolsAdded`; data-only
  change → `model: []`; baseline after a head with omission edits for superseded managed entries; no repeated
  baseline; fork sees inherited managed entries; restart without plugin keeps payload and rendered text;
  staleness retry when a managed entry lands during preparation; throwing handler's edits rolled back only.

**Watch**
- Capture vs commit: no gap, no duplicate.
- One boundary commit → one envelope.
- Overflow closes; new watch has fresh base. Listener throw closes only that watch.
- Output delta ordering vs `task_end`; output removed when last reference ends.
- Session watch: conversation created, session values and lists; `closed/session` on close.
- Lists: requested list captured with complete elements; append/remove/clear in one commit → one `list` event
  with ops in write order, folded before the listener; element IDs stable; `pi.inbox` and built-in config
  rejected in `values`/`lists`; session watch rejects conversation lists.
- Reset: idle → entry appended before `reset` resolves; busy → queued and `reset` resolves on admission, entry
  placed at the boundary and visible via watch; never stale.
- Defaults: unset `followUpMode` reads `"one-at-a-time"` via `c.config`, `view.config` and the post_tools
  boundary; `delete` restores the default and the `config` event carries the default as `value`, never
  `undefined`; initial watch capture has every defaulted key present; unset `model` reads `undefined` and
  generation fails `no_model`; historical `c.config.thinkingLevel.get(entryId)` at a position with no write
  resolves the default. Compile: `ConfigSnapshot<CoreConfigBundle>["followUpMode"]` is exactly
  `"all" | "one-at-a-time"` and `["model"]` is `ModelRef | undefined`; `c.value(plainToken).get` is `T |
  undefined`, `c.value(defaultedToken).get` is `T`; `conversationValue<boolean>("plan.mode", { rewind: true })` is
  `UnboundValue<boolean, true>` and with `default: false` it is `& { default: boolean }`; `sessionValue<string>("n",
  { default: "x" })` reads as `string`.
- Watch options: the same plugin address requested twice appears once in the view and yields one `value`
  event; a built-in config token or `pi.inbox` in `values` rejects rather than deduplicating into `config`.
- `view.config` captured without requesting; `c.config.model.set` → one `config` event `{ type: "config", key:
  "model", value, previous }` folded into `view.config.model`; `c.config.set({ model, followUpMode })` → two `config` events in
  one envelope, both folded before the listener; a requested plugin value lands in `view.values` via `value`;
  built-in definitions never emit `value`; protected addresses cannot be requested.
- Active transcript: capture with no head returns all entries; with a head returns, in transcript order, every
  entry from the boundary through current with the head entry at its actual position.
  Reducer: plain entry appends; summary entry with `head = k` drops entries with id < k then appends the
  summary; reset/handoff (`head = self`) drops all prior active entries then appends itself; both in the same
  fold as the rest of that commit; `context` event updates in the same envelope; pre-head entries remain
  readable through entry scans; capture after a head equals the incrementally reduced view.

**State adapter**
- Live transitions through several phases: one scheduler `execute`; each handler gets the applied projection.
- Initial child creation vs crash: no transition → initial reruns with no child; transition → next phase, no
  duplicate.
- Reopen dispatch: absent → initial; start → run; inflight → recover.
- Same-phase commit vs abort: both or neither; post-mark commit rejects.
- Transition vs mark both orders: mark-first prevents the next handler.
- Compile: broad string phase rejects; missing/extra phase key rejects; extra transition field rejects;
  inflight without recover rejects; a hand-built transition object mixing phase `"a"` with phase `"b"`'s payload
  is rejected as a `StateResult` (negative fixture), while `actions.transition("a", ...)` with the right payload
  is accepted.

**Backends**
- JSONL: main through Seq 100, scratch through 150 → reopen at 150; terminal at 151 with unlink failure →
  sidecar ignored; torn suffix truncated; malformed complete line fails open; kill -9 during each phase.
- SQLite: same conformance; lock contention fails fast.
- 100k terminal tasks, 2 live: open touches only live seed + ancestry.

## 18. Work packages

One commit per package, reviewed before the next starts. Run the package's tests and `npm run check` before
each commit. Any package test exercising providers or tool execution uses faux implementations; no real API.

| # | package | delivers |
|---|---|---|
| 1 | types | sections 1–3 and 11.2 declarations (`HookPoint`/`defineHookPoint` are referenced by `TaskKind`), `Stored<T>` and its compile assertions (section 1), `defineTask`/`defineCoreTask`/`defineEntry`/address helpers; compile tests |
| 2 | storage | `Write`, `Storage`, `MemoryStorage`, conformance tests |
| 3 | line | Session line, transactions, read-before-write, validation and assertions (5.2), capability-bound builders |
| 4 | context | context derivation, forks, tool-result repair, transcript invariant assertions |
| 5 | admission | inbox/results/receipts, send, boundaries and queue modes, withdraw, wait; test generation kind |
| 6 | task kernel | reservation, runtimes, closures, scratch, output tracker, invocation identity |
| 7 | scheduler | resume/kick/drain, dependencies, waiters, idle |
| 8 | cancellation | mark/revoke/join/fresh abort, conversation abort, close/shutdown/fault, open + orphan reconciliation, Harness object over the test generation kind, registries, hooks registry |
| 9 | system | sections, draft, managed entries, canonical fold, baseline/delta, staleness retry (section 12); depends on pi-ai `SystemMessage` having landed |
| 10 | generation + tool + post_tools | 10.1–10.3, `ToolResult`/`ToolDeclaration`, hooks of 11.2; `pi.tool` runs an internal test executor, no ordinary tool API; faux provider only. Uses pi-ai's landed `SystemMessage`/messages-only adapters; no parallel representation |
| 10a | ordinary tool API | section 11.1 gated block (execution signature, facade, output access, memos, children, resolver), after its shape is decided and appended; then the built-in tools |
| 11 | collapse + job | 10.4, 10.5 |
| 12 | watch | section 14 |
| 13 | jsonl | section 15 |
| 14 | sqlite | section 15 |
| 15 | state adapter | section 16 |

Package 10 is the design validation point: if generation/tool/post_tools do not fit the kernel from 6–9,
change the kernel before building 12–15. Its acceptance also includes the size check: count production lines
under `src/harness/pico/` excluding `memory-storage`, `jsonl-storage`, `sqlite-storage` and tests; materially
over 4k means stop and simplify before continuing, never add caching or indexing layers to compensate.

## 19. Repository rules

- Location: `packages/agent/src/harness/pico/`. No imports from `harness/runtime`, `harness/session`,
  `agent-harness.ts` or earlier Pico prototypes. Chord and pi-ai are allowed. Read reusable leaf code before
  copying, then own the copy.
- Erasable TypeScript only. No `any` in Pico declarations (imported pi-ai types exempt).
- Check external types in `node_modules`; do not guess.
- Test with `node .../vitest/dist/cli.js --run test/harness/pico/<file>.test.ts` and `npm run check`. Never
  the full suite.
- Commit only files of the current package, by explicit path.
- Production size target 3k–4k lines excluding storage backends and tests (intro, WP10); report the count in
  each package's commit message from WP6 onward.
- Public exports: `pico/index.ts` exports only the public surface. `defineCoreTask`, `CoreTaskTx`,
  `CoreAbortTx`, `CoreTaskRuntime`, `CoreAbortTaskRuntime`, the internal admission helpers (`accept`,
  `queueInput`, request-keyed `write`), the core runtime/builder constructors and `commitStateTransition` are
  module-internal and never re-exported; no `export *` from a module that declares them. The fixed kind tokens
  (`generationKind`, `toolKind`, `postToolsKind`, `collapseKind`, `jobKind`) with their `config` and `hooks`
  witnesses, `defineTask`, `defineStateTask`, `defineEntry`, `defineHookPoint`, `defineSystemSection`, address
  helpers, `Harness`, storages and all public types are exported. A compile test asserts that
  `import { defineCoreTask } from ".../pico"` fails.

## Appendix A. Type index

Every identifier used above that is not declared inline. Imported: `Context`, `Op`, `applyImmutable`, `track`
from Chord; `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ImageContent`,
`ToolCall`, `Tool`, `Models`, `Usage`, `DeferredHandle`, `RetryPolicy`, `isRetryableAssistantError`, `retryDelayMs`, `estimateContextTokens`, `AssistantMessageFrameEncoder` from pi-ai (`reduceAssistantMessageFrames` only in tests, as the oracle); `JsonRepresentation` from Chord (as `Stored<T>`, section 1); `ThinkingLevel`
re-exported from `packages/agent/src/types.ts` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" |
"max"`; never redeclared in Pico); `TSchema`, `Static` from TypeBox.

```ts
declare const taskOutputType: unique symbol;   // taskKindBrand is declared in 3.3

// identity and payloads
type ModelRef = { readonly provider: string; readonly modelId: string };   // field names match the existing models-provider service
// durable payloads below are exact `type` aliases so they satisfy JsonObject; public non-durable shapes stay interfaces
type AssistantEntryData = { readonly attempt: number };   // usage is already on AssistantMessage.usage; not duplicated
type UsageEntryData = { readonly attempt: number; readonly usage?: Stored<Usage>; readonly error: string };
type UsageEntry = EntryBase & { readonly data: UsageEntryData };   // pi.usage, data-only
interface UnboundValue<T extends JsonValue, R extends boolean = boolean> { readonly namespace: string; readonly key?: string; readonly rewind: R; readonly default?: T; readonly [addressType]?: T; bind(conversationId: Id): Value<T> }
// DefaultedUnboundValue: section 2; its bind result retains required default metadata.
type PayloadOf<D> = D extends Address<infer T> | UnboundValue<infer T, boolean> ? T : never;
interface UnboundList<T extends JsonValue, R extends boolean = boolean>  { readonly namespace: string; readonly key?: string; readonly rewind: R; readonly [addressType]?: T; bind(conversationId: Id): List<T> }
// `addressType` is declared in section 2; bound and unbound definitions both carry the witness so inference survives binding
type ConversationValueDefinition<T extends JsonValue, R extends boolean = boolean> = UnboundValue<T, R>;   // the name used for config bundle members
type ConversationListDefinition<T extends JsonValue, R extends boolean = boolean> = UnboundList<T, R>;
// SeedWrite (set | delete): section 8.1. Unbound addresses are bound to the target conversation (root = 1, or the created child). `RootValueWrite` is the set form: { address, value }.
type RootValueWrite = Extract<SeedWrite, { readonly value: JsonValue }>;
// conversationValue<T>(ns, { rewind: true }) -> UnboundValue<T, true>; { rewind: false } -> UnboundValue<T, false>
interface StickyPublicValue<T extends JsonValue, Read = T | undefined> { get(ctx: Context): Promise<Read>; set(value: T, ctx: Context): Promise<void>; delete(ctx: Context): Promise<void> }   // Read is the resolved type (default applied) for defaulted definitions
// CoreConfigs, CoreConfigBundle, BundleValues, Settings, ConfigFacade, DisjointBundles: section 2.1. CoreHooks, CoreHookBundle, HookFacade: section 13.1.
type Acceptance = { readonly kind: "send" | "write"; readonly requestId?: string; readonly conversationId: Id; readonly inputId: Id };   // durable receipt; `kind` keeps write receipts out of Harness.input
interface InternalAcceptOptions { readonly input: UserInput; readonly requestId?: string; readonly whenBusy?: "followUp" | "steer" | "reject" }   // public-typed; the helper validates and stores Stored<UserInput>
type StoredEntryDraft = { readonly kind: string; readonly data?: JsonValue; readonly model?: readonly Stored<Message>[]; readonly head?: Id | "self"; readonly edits?: readonly ContextEdit[] };
// StoredInputResult, InputOutcome, TerminalInputOutcome: section 9.1
// ConversationSeed, ConversationCreateSpec: section 8.1. Report: section 13.
type ToolResultData = { readonly details?: JsonValue; readonly usage?: ToolUsage; readonly diagnostics?: readonly ToolDiagnostic[]; readonly control?: ToolControl; readonly truncated?: { readonly bytes: number; readonly lines: number } };
type ToolUsage = { readonly [key: string]: number };
type ToolOutputState = { progress?: string; log: string[]; details?: JsonValue };   // mutable OutputState
type EnvironmentInfo = { readonly cwd: string };                            // exact alias; the established minimal built-in; richer environment data is an application section
type SkillInfo = { readonly name: string; readonly description: string };   // exact alias; systemSections.skills renders the list
// Registries and open arrays take the erased default `SystemSection` (= SystemSection<JsonValue>): `render(value: T)` is method
// syntax, so every SystemSection<T> is assignable under method bivariance. Seeds pair a section with a value, which the erased
// form cannot check, so seeds are built only through the checked helper:
type SectionSeed =
  | { readonly section: SystemSection; readonly value: JsonValue }   // erased set pair
  | { readonly key: string; readonly remove: true };                 // remove an inherited section by stable key (host forks)
declare function sectionSeed<T extends JsonValue>(section: SystemSection<T>, value: T): SectionSeed;   // checked set
declare function removeSection(key: string): SectionSeed;                                              // removal

// tasks
type NewTask = Omit<TaskBase, "abort" | "checkpoint" | "owns"> & { readonly status: "pending"; readonly owns: readonly []; readonly abort?: never; readonly checkpoint?: never; readonly outcome?: never };
type RunningTask<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never> = Omit<TaskBase<I,C>, "output"> & TaskOutputField<O> & { readonly status: "running"; readonly outcome?: never };
type Completion<R extends JsonValue, F extends JsonValue> = { readonly status: "completed"; readonly result: R } | { readonly status: "failed"; readonly failure: F };
type TerminalClosure<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState> = (tx: FinalTx<C,O>, current: RunningTask<I,C,O>) => Completion<R,F> | Promise<Completion<R,F>>;
type CoreTerminalClosure<I extends JsonValue, C extends TaskCheckpoint, R extends JsonValue, F extends JsonValue, O extends OutputState> = (tx: CoreFinalTx<C,O>, current: RunningTask<I,C,O>) => Completion<R,F> | Promise<Completion<R,F>>;
type AbortClosure<I extends JsonValue, C extends TaskCheckpoint, A extends JsonValue, O extends OutputState> = (tx: AbortFinalTx<C,O>, current: RunningTask<I,C,O>) => A | Promise<A>;
type CoreAbortClosure<I extends JsonValue, C extends TaskCheckpoint, A extends JsonValue, O extends OutputState> = (tx: CoreAbortFinalTx<C,O>, current: RunningTask<I,C,O>) => A | Promise<A>;
interface TaskOutputKind<O extends OutputState> { readonly kind: string; readonly [taskOutputType]?: O }
declare function defineTaskOutput<O extends OutputState>(kind: string): TaskOutputKind<O>;
interface TaskOutputRef<O extends OutputState> { readonly id: Id; readonly kind: string; readonly [taskOutputType]?: O }
type TaskOutputField<O extends OutputState> = [O] extends [never] ? Record<never, never> : { readonly output: TaskOutputRef<O> };   // no-output tasks have no output key
type TaskOutputDefinition<I extends JsonValue, O extends OutputState> = [O] extends [never] ? { readonly output?: never } : { readonly output: { readonly kind: TaskOutputKind<O>; initial(input: I): O } };
type FinalOutput<O extends OutputState> = [O] extends [never] ? Record<never, never> : { readonly output: O };
// RuntimeOutput, AbortRuntimeOutput, TaskRuntimeBase, CommitRuntime, AbortRuntimeBase: section 5.4
interface TaskOutput<O extends OutputState> { readonly ref: TaskOutputRef<O>; read(ctx: Context): Promise<O>; mutate(m: (state: O) => undefined, ctx: Context): Promise<void>; replace(value: O, ctx: Context): Promise<void> }
interface ReadonlyTaskOutput<O extends OutputState> { readonly ref: TaskOutputRef<O>; read(ctx: Context): Promise<O> }
type TaskSpec<K extends AnyDefinedKind> = { readonly conversationId?: Id; readonly input: InputOf<K>; readonly after?: readonly Id[]; readonly background?: true } & ([OutputOf<K>] extends [never] ? { readonly output?: never } : { readonly output?: TaskOutputRef<OutputOf<K>> });
type OrdinaryKind = { readonly kind: string; readonly [taskKindBrand]: "ordinary"; readonly hooks?: HookPoints; readonly config?: ConfigBundle };
type CoreKind = { readonly kind: string; readonly [taskKindBrand]: "core"; readonly hooks?: HookPoints; readonly config?: ConfigBundle };
type AnyDefinedKind = OrdinaryKind | CoreKind;
type PayloadsOf<K> =
  K extends TaskKind<infer I, infer C, infer R, infer F, infer A, infer O, infer H>     ? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O; hooks: H } :
  K extends CoreTaskKind<infer I, infer C, infer R, infer F, infer A, infer O, infer H> ? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O; hooks: H } : never;
type InputOf<K> = PayloadsOf<K>["input"]; type CheckpointOf<K> = PayloadsOf<K>["checkpoint"]; type ResultOf<K> = PayloadsOf<K>["result"];
type FailureOf<K> = PayloadsOf<K>["failure"]; type AbortedOf<K> = PayloadsOf<K>["aborted"]; type OutputOf<K> = PayloadsOf<K>["output"];
type TaskOf<K> = DistributiveOmit<Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>, "output"> & TaskOutputField<OutputOf<K>>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NoExtra<Expected, Actual extends Expected> = Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;
type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> = Expected extends readonly JsonValue[] ? Actual : Expected extends JsonObject ? NoExtra<Expected, Actual> : Actual;
// CoreTaskKinds carries the exact fixed-kind token types, not the erased CoreKind, so CoreConfigBundle/CoreHookBundle/ConfigEvent/HookFacade derive exact keys:
interface CoreTaskKinds {
  readonly generation: typeof generationKind;   // CoreTaskKind<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationFailure, GenerationAborted, GenerationOutput, typeof generationKind.hooks> & { config: typeof generationKind.config }
  readonly tool:       typeof toolKind;
  readonly postTools:  typeof postToolsKind;
  readonly collapse:   typeof collapseKind;
  readonly job:        typeof jobKind;          // ordinary; config {} and hooks {}
}
interface OpenInspection { readonly pending: readonly Task[]; readonly running: readonly Task[]; readonly orphaned: readonly Task[]; readonly unknownEntryKinds: readonly string[] }

// state adapter exactness helpers
type ExactPhaseHandler<Expected, Actual extends Expected> = Actual extends { readonly role: infer Role } ? Actual extends Extract<Expected, { readonly role: Role }> ? NoExtra<Extract<Expected, { readonly role: Role }>, Actual> : never : never;
type ExactPhaseMap<Expected, Actual extends Expected> = Actual & Record<Exclude<keyof Actual, keyof Expected>, never> & { readonly [P in keyof Expected]: ExactPhaseHandler<Expected[P], Actual[P]> };
type ExactStateTaskDefinition<Expected, Actual extends Expected> = NoExtra<Expected, Actual> & { readonly phases: ExactPhaseMap<Expected extends { readonly phases: infer P } ? P : never, Actual extends { readonly phases: infer P } ? P : never> };

// state facades
interface PublicValue<T extends JsonValue, Read = T | undefined> { get(ctx: Context): Promise<Read>; get(at: Id, ctx: Context): Promise<Read>; set(value: T, ctx: Context): Promise<void>; delete(ctx: Context): Promise<void> }   // Read = resolved type; both current and historical get apply the definition's default when nothing is stored at that position
interface PublicList<T extends JsonValue> { read(ctx: Context): Promise<readonly Element<T>[]>; read(at: Id, ctx: Context): Promise<readonly Element<T>[]>; append(value: T, ctx: Context): Promise<Id>; remove(id: Id, ctx: Context): Promise<void>; clear(ctx: Context): Promise<void> }
interface ScratchReader { value<D extends Value<JsonValue>>(a: D): Pick<TxValue<PayloadOf<D>, ResolvedValue<D>>, "get">; list<T extends JsonValue>(a: List<T>): Pick<TxList<T>, "read"> }

// registries and hooks
interface MutableRegistry<D extends { readonly kind: string } | { readonly key: string } | { readonly name: string }> {   // async, on the line
  get(name: string, ctx: Context): Promise<D | undefined>; register(d: D, ctx: Context): Promise<void>; replace(d: D, ctx: Context): Promise<void>; remove(name: string, ctx: Context): Promise<void>;
  readonly revision: number;   // monotonically increasing; bumped by register/replace/remove; read by preparation snapshots (12.5)
}
// hooks: HookPoint, HookPoints, HookHandler, HookInfo, HookRunner, HookResult, HarnessHookRegistry, ConversationHookRegistry are declared in 11.2
type HookIn<P>  = P extends HookPoint<infer In, unknown> ? In : never;
type HookOut<P> = P extends HookPoint<unknown, infer Out> ? Out : never;
declare const hookIn: unique symbol; declare const hookOut: unique symbol;

// storage queries
interface PageQuery { readonly cursor?: Id; readonly limit: number }
interface Page<T> { readonly items: readonly T[]; readonly next?: Id }
interface ConversationScan extends PageQuery { readonly parent?: Id; readonly owner?: Id }
interface EntryScan extends PageQuery { readonly conversationId: Id; readonly kind?: string; readonly through?: Id }
interface TaskScan extends PageQuery { readonly conversationIds?: readonly Id[]; readonly statuses?: readonly Task["status"][]; readonly kind?: string; readonly abort?: boolean; readonly outputId?: Id }

// errors (all extend Error; constructor arguments shown)
declare class ReadAfterWrite extends Error {}
declare class ScratchRetired extends Error { readonly taskId: Id; constructor(taskId: Id) }
declare class OutputRetired extends Error { readonly outputId: Id; constructor(outputId: Id) }
declare class InvalidHistoryPosition extends Error { readonly at: Id; constructor(at: Id) }
declare class ConversationBusy extends Error {}
declare class InputNotFound extends Error {}
declare class TaskNotFound extends Error {}
declare class ScopeViolation extends Error {}
declare class NestedLineOperation extends Error {}
declare class Closed extends Error {}
declare class Faulted extends Error {}
declare class NothingToCollapse extends Error {}
declare class RequestKindMismatch extends Error {}
declare class StaleDefinition extends Error {}
```

## Appendix B. Changes from v1 (`pico-simple-handoff.md`)

| v1 | v2 | why |
|---|---|---|
| gated packages (harness, provider, tool, hooks, collapse, jobs, sections, client) | all specified except the exact ordinary tool API (execution signature, facade, output access, memos, children, resolver), which stays gated with fixed requirements | user decision: describe the full harness; the tool API is the one allowed gap |
| host `HostTx.entry` with structural append validation | removed; hosts use `write` | queued writes only land at boundaries, so exchange splitting cannot happen; validation became assertions |
| `write` helper restricted to trusted built-ins | `write` on `BaseTaskTx` and `FinalTx` | user decision: passive queued writes are boundary-safe; ordinary kinds gain exactly that and nothing else |
| `pi.job` ordinary "unless a requirement proves otherwise" | stays ordinary | its notice is a `write` from the terminal closure, which ordinary kinds now have |
| queue batching rule "unsettled" | `steeringMode`/`followUpMode` sticky in `postToolsKind.config`, default `one-at-a-time` | matches current Agent/coding-agent defaults (the old "matching the lane harness" claim was wrong: the lane harness defaults to `all`) |
| watch `values` only | `values` and `lists`; `WatchedList` + `list` event with grouped append/remove/clear ops | user decision: direct watched-list support |
| `reset` returns `InputHandle` | `reset(): Promise<void>` resolves on durable admission; passive writes have no public handle | `InputHandle` is for admitted user input only; matches the old normative API |
| defaults implied in prose | `default?` on the definition token, resolved by every reader | one place for a default |
| protected = four names (`pi.inbox`, `pi.input_result`, `pi.request`, `pi.output`) | unchanged; all `pi.*` reserved for built-ins; config tokens exported; section seeds live on the `conversation.create` record, not an address | restore the v1 rule; no new protected address |
| `generationKind.config` bundle + `c.config(kind)`/`c.settings` facades | `c.config.<property>` per core address plus `c.config.set(patch)`, assembled from all core bundles; no `c.settings`, no `c.config(kind)`, no `c.core` | user decision: direct properties, one schema, plugin config stays in plugin bundles |
| `onYield` and `before_collapse` semantics in historical docs | specified in 10.1, 10.4, 9.5; continuation entry kind is `pi.user` | decision, not inherited |
| `defineStateTask` in section 5.1 | section 16, package 15 | unchanged contract, moved and condensed |
| section 14.4 system sections + usage-guide contract | section 12, unchanged design | user decision: the settled design stands, pi-ai PR will land |
| hook points as a fixed table on built-ins | declared per task kind via `defineHookPoint`; core kinds ship predefined points | user decision: hooks are kind-specific generically; ordinary kinds may declare their own |
| string point names (`system_instructions`, `before_tool`, ...) and a fixed hook table | camelCase `HookPoint` tokens on `kind.hooks` (`systemInstructions`, `beforeTool`, ...); `c.hook.<name>` flattened across fixed kinds like `c.config`; plugins use `c.hooks.on(kind, kind.hooks.point, ...)` | user decision: derive like config, tokens avoid plugin name collisions |
| `systemInstructions` handler returns the loadout | loadout defaults to `selectedTools` resolved against `h.tools`; returned `tools` is an explicit override | common hook no longer needs `h.tools.select(...)` |
| `rootValues` only | `root: { config, values, sections }` primary, `rootValues` advanced alias | quick start does not import kind tokens |
| `WatchDelivery.commit.events` | `WatchDelivery` is the envelope: `d.events`, `d.first`, `d.last` | one less level |
| conversation watch `tail: 0..10000` window | removed; view holds the active transcript selected by the newest head; older entries via paged scans | user decision: the head defines the working set; no arbitrary window |
| built-in config visible in a watch only if listed in `values` | `view.config` always captured from `CoreConfigBundle`; `values` is custom-only; dedicated flat typed `config` event (`key`, `value`, `previous`) | user decision: renderers always need it; key-discriminated typing beats address matching |
| validation prose per write type | 5.2 split into validation (reject) and assertions (fault) | same behaviour; clearer which is a public contract |
| exclusion lists, repeated trace prose, undefined vocabulary | glossary, one statement per rule with reason | readability |
