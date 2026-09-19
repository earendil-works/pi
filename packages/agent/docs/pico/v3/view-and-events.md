# Pico3 view and events

Status: proposal for the hardened V3 (`pico3`) watch protocol. Replaces the
`ConversationView { entries, tasks, rewindable, sticky }` shape and the per-channel
delta of the V3 sketch. Written against `harness-v3.zip` and the Codex app-server
protocol (`codex-rs/app-server-protocol/src/protocol/v2/*`), read in full.
Companion: `plugins.md` (harness extension surface, durability, Chord facets).

## 1. Principles

1. **One snapshot, then one envelope per commit.** A watch captures the view and
   subscribes in one line operation; every later commit that touches the
   conversation produces exactly one envelope, delivered in commit order with a
   contiguous per-watch `revision`. No cursor, replay or acknowledgement: a gap
   means "open a fresh watch".
2. **Ops are the truth, events are annotations.** The envelope carries Chord ops
   that transform the view document, and named events the kernel attaches because
   it produced those ops and knows why. Ops fully determine the replica: a client
   that folds only ops is never wrong. Events annotate cause and outcome and may
   carry transient facts the view deliberately does not retain; a client that
   consumes only events never scans the view.
3. **Path = event.** Every field of the view has a stable path, so an op on that
   path is a typed notification. Nothing in the view is ever discovered by
   diffing.
4. **The view is rendering-shaped, not kernel-shaped.** No task records, no
   checkpoints, no documents. In-progress work is described by the kind that owns
   it, in the shape a renderer wants.
5. **Atomic by construction.** Everything a commit changes lands in one envelope:
   the assistant entry, the cleared streaming slot, the resolved inputs and the
   `turn.ended` event are never observable separately. This is the one property
   Codex's protocol lacks (`item/completed` and `turn/completed` are separate
   messages).

## 2. The view document

One JSON document per conversation. The kernel keeps a Chord tracker for it per
watched conversation, mutates it through the proxy after each commit, and
`flush()`es the ops into the envelope. Clients fold with `applyImmutable`.

```ts
interface ConversationView {
  conversation: { id: Id; parent?: { conversationId: Id; at: Id }; owner?: Id };

  /** Active transcript: newest head H, then every fork-visible entry with id >= H.head,
   *  chronological. All fork-visible entries when there is no head. See §2.1. */
  entries: Entry[];

  /** Resolved configuration, flat: every built-in and registered kind's declared keys,
   *  defaults applied. `model` is the only optional built-in. */
  config: {
    model?: ModelRef; thinkingLevel: ThinkingLevel; selectedTools: string[]; profile: string;
    threshold: number; keepRecent: number;
    retry: RetryPolicy; steeringMode: QueueMode; followUpMode: QueueMode;
    [pluginKindKey: string]: JsonValue;
  };

  /** Queued steer / followUp / passive writes, admission order. */
  inbox: QueuedInput[];

  /** Present while an input group is live (from placement to its end); absent when idle. */
  turn?: TurnView;

  /** Present while a pi.collapse task is live. */
  compaction?: { taskId: Id; reason: "threshold" | "manual" | "overflow"; stage: "summarizing" | "retrying"; attempt: number; retryAt?: number };

  /** Non-turn live tasks (jobs, plugin kinds), described by their kind. Removed on terminal. */
  tasks: { [taskId: string]: { kind: string; background?: true; marked?: true; status: JsonValue } };

  /** Plugin presentation slices, by namespace: the namespace's declared `view` projection, never raw state. */
  plugins: { [namespace: string]: JsonValue };
}

interface TurnView {
  inputs: Id[];                         // the input group
  generation?: GenerationStatus;        // present while a pi.generation is live
  message?: AssistantMessage;           // streaming assistant message (frames applied in place)
  tools: ToolSlot[];                    // tool calls of the newest assistant message in this turn, by call index
}

type GenerationStatus =
  | { stage: "waiting"; on: "compaction" }                                 // replacement generation pending behind a collapse
  | { stage: "preparing" }                                                 // before `prepared`
  | { stage: "requesting"; attempt: number }                               // request sent, no frame yet
  | { stage: "streaming"; attempt: number }                                // first frame applied
  | { stage: "retrying"; attempt: number; retryAt: number; lastError: string }
  | { stage: "deferred"; attempt: number; pollAt: number };

interface ToolSlot {
  callId: string; name: string; args: JsonValue;
  status: "pending" | "running" | "done" | "error" | "aborted";
  waitingOn?: string;                   // namespace of the beforeTool handler that awaited BeforeToolApi.waiting(ctx); cleared when it returns
  output?: string;                      // bounded stream so far (api.stream)
  progress?: string; details?: JsonValue;
  continuedBy?: Id;                     // background task that took over; see tasks[continuedBy]
  entry?: Id;                           // the pi.tool_result entry once landed
}
// Memos and other slot working state are never in the view (plugins.md §2); only the fields above are rendered.
```

### 2.1 Active transcript

- `H` = newest fork-visible entry with a `head`; `from` = `H.head`.
- `entries` = every fork-visible entry with `id >= from`, chronological. Inherited
  parent entries are included when `from` points into a parent.
- Older head entries inside the range stay (a renderer may mark them). Display-only
  entries (`pi.assistant` with `stopReason` `error`/`aborted`, `pi.usage`, model-less
  plugin entries) stay. `edits` are carried verbatim; the view is the transcript,
  not the model projection.
- A new head entry truncates: the kernel emits one splice removing everything
  before `head` and one appending the entry (§4, `entries`).
- No `limit` anywhere on the public surface; the capture pages internally.

### 2.2 What is deliberately not in the view

- `Task` records, checkpoints, outcomes: available through `getTask`/`scanTasks`
  for tooling and tests, never pushed.
- The two storage documents (`rewindable`, `sticky`): their split is a fork/history
  property; the view flattens their keys into `config`, `inbox`, `turn`, `tasks`,
  `plugins`. Which key lives in which document is declared per kind and matters
  only to `stateAt(entry)` / `fork(at)`.
- Section seed metadata on conversations.

## 3. Envelope

```ts
interface Envelope {
  revision: number;         // contiguous per watch: snapshot.revision + 1, +2, …; storage Seq is not exposed
  ops: Op[];                // Chord ops over ConversationView (§4)
  events: ViewEvent[];      // named annotations for this commit (§5); may be empty
}
```

`revision` is per watch, not the storage commit sequence: a conversation watch
sees only commits that touch its conversation, so the global `Seq` would have
legitimate gaps. Storage `Seq` stays internal unless a public commit-correlation
use appears.

Delivery: folded into the kernel's view tracker on the line; the listener is
invoked **synchronously, in order, off the line**, one envelope per commit that
changed anything visible to this conversation. Envelopes arriving before
`start()` are buffered (bounded; overflow closes the watch). Asynchronous
consumers (the Chord bridge, application queues) own their own queue and
backpressure policy (`plugins.md` §6.1). A listener throw closes that watch and
reports through `onError`. `stop` is idempotent; nothing is delivered after
`stop`.

Base flush: after the kernel rebases the view tracker (reopen of a cold watch is a
fresh snapshot instead), an envelope may carry `["r", view]` as its only op.
Clients must handle it as "replace everything". Events in that envelope are
still valid.

## 4. Ops by path

Chord op vocabulary: `["r", v]` replace root, `["s", path, v]` set, `["d", path]`
delete, `["a", path, str]` string append, `["t", path, n]` string truncate,
`["p", path, index, deleteCount, items]` array splice.

| path | ops you will see | meaning |
|---|---|---|
| `["entries"]` | `["p", ["entries"], n, 0, [e…]]` | entries appended (always at the end) |
| `["entries"]` | `["p", ["entries"], 0, k, []]` then `["p", …, n, 0, [head]]` | new head: transcript truncated, head entry appended |
| `["config", key]` | `s` / `d` | config changed; `config.reset(keys)` sets the declared default (only `model`, which has none, is deleted) |
| `["inbox"]` | `p` | queued, placed (removed), aborted (removed) |
| `["turn"]` | `["s", ["turn"], {…}]` / `["d", ["turn"]]` | input group started / ended |
| `["turn","generation"]` | `s` / `d` | generation stage changes / generation ended |
| `["turn","message"]` | `s` (first frame), `a`/`s` on content paths, `d` | streaming assistant message |
| `["turn","message","content",i,"text"]` | `a` | text delta |
| `["turn","message","content",i,"arguments"]` | `s` | tool-call arguments materialized at checkpoint/end |
| `["turn","tools"]` | `s` (whole array, with the assistant entry) | tool slots created for a new assistant message |
| `["turn","tools",i,"status"]` | `s` | pending → running → done/error/aborted |
| `["turn","tools",i,"waitingOn"]` | `s` / `d` | a `beforeTool` handler (namespace = value) is waiting on a human/service; cleared when it returns |
| `["turn","tools",i,"output"]` | `s` | bounded stream flush (whole string; retention may drop the head) |
| `["turn","tools",i,"progress"]`, `[…,"details"]`, `[…,"continuedBy"]` | `s` | `api.progress` |
| `["compaction"]` | `s` / `d` | collapse started / stage changed / ended |
| `["tasks", id]` | `s` / `d` | non-turn task appeared / status changed / terminal |
| `["tasks", id, "status", …]` | any | kind-described status detail (jobs: stdout, exitCode, …) |
| `["plugins", ns, …]` | any | the namespace's `view` projection |

Rule for kernel authors: mutate the tracked view through its proxy so the
tracker records minimal ops; never rebuild subtrees. Streaming applies each
frame to `turn.message` in place (same reducer as pi-ai's frame reducer).

## 5. Events

Events are emitted by core code inside the commit that causes them
(`tx.emit(event)`, core authority). Extensions emit `{ type: "plugin.<ns>.<name>", … }`
through their namespace token from their own commits. Rule: ops fully determine
the replica; events annotate the cause and outcome of the commit and may carry
transient facts the view does not retain (`turn.ended.reason`,
`task.ended.outcome`, `compaction.failed`, `warning`). An event must never be the
only place a late joiner could learn something needed to render steady state.

```ts
type ViewEvent =
  // transcript
  | { type: "entry.added"; entry: Entry }                                  // one per appended entry, in order
  | { type: "head.moved"; entry: Entry }                                   // summary / reset / handoff landed
  // input group
  | { type: "turn.started"; inputs: Id[] }
  | { type: "turn.ended"; inputs: Id[]; status: "done"; answer: Id }
  | { type: "turn.ended"; inputs: Id[]; status: "unanswered"; reason: "terminated" | "aborted" | "failed" | "stale"; detail?: string }
  | { type: "input.queued"; input: Id; mode: "steer" | "followUp" | "write" }
  | { type: "input.placed"; input: Id; entry: Id }
  | { type: "input.aborted"; input: Id }
  // generation
  | { type: "generation.started"; taskId: Id; attempt: number }            // request sent
  | { type: "generation.retrying"; taskId: Id; attempt: number; retryAt: number; error: string }
  | { type: "generation.deferred"; taskId: Id; pollAt: number }
  | { type: "generation.completed"; taskId: Id; entry: Id; toolCalls: number }
  | { type: "generation.failed"; taskId: Id; reason: "provider" | "overflow" | "retries_exhausted" | "no_model"; detail: string; entry?: Id }
  // tools
  | { type: "tool.waiting"; taskId: Id; callId: string; on: string }        // a beforeTool handler is waiting; `on` is its namespace
  | { type: "tool.started"; taskId: Id; callId: string; name: string }
  | { type: "tool.finished"; taskId: Id; callId: string; entry: Id; isError: boolean; control?: ToolControl }
  | { type: "tool.aborted"; taskId: Id; callId: string; entry: Id }
  // compaction
  | { type: "compaction.started"; taskId: Id; reason: "threshold" | "manual" | "overflow"; through: Id }
  | { type: "compaction.retrying"; taskId: Id; attempt: number; retryAt: number; error: string }
  | { type: "compaction.finished"; taskId: Id; summary: Id }
  | { type: "compaction.failed"; taskId: Id; reason: "stale" | "declined" | "provider" | "retries_exhausted" | "no_model"; detail: string }
  // other tasks
  | { type: "task.started"; taskId: Id; kind: string; background?: true }
  | { type: "task.ended"; taskId: Id; kind: string; outcome: "completed" | "failed" | "aborted" | "orphaned" }
  // settings and diagnostics
  | { type: "config.changed"; keys: string[] }
  | { type: "warning"; source: string; message: string }                   // hook skipped, tool output truncated, selected tool missing, …
  | { type: `plugin.${string}`; data: JsonValue };
```

`warning` has no state counterpart at all; it exists for exactly the
occurrences Codex models as `warning` / `error{willRetry}` notifications.

## 6. Commit-by-commit mapping

What each kernel moment writes, the ops it produces, and the events attached.
Ops are abbreviated; every row is one atomic envelope.

### 6.1 Admission

| moment | ops | events |
|---|---|---|
| `send`, idle | `entries +pi.user`; `turn = { inputs, tools: [] }`; (older queued items placed first: `inbox` splice, `entries +…`) | `input.placed`, `entry.added`, `turn.started` |
| `send`, busy (`steer`/`followUp`) | `inbox +item` | `input.queued` |
| `write`, idle | `entries +entry` (+ head truncation if it carries a head) | `entry.added` (+ `head.moved`) |
| `write`, busy | `inbox +item` | `input.queued{mode:"write"}` |
| `InputHandle.abort` while queued | `inbox -item` | `input.aborted` |
| `config.set` | `config.<key>` set/delete | `config.changed{keys}` |

### 6.2 Generation

| moment | ops | events |
|---|---|---|
| task created (successor/replacement) | `turn.generation = { stage: "preparing" }` (turn already present) | `task.started` is **not** emitted for turn kinds |
| `prepared` commit | optional `entries +pi.system`; `turn.tools = []`; `turn.message` deleted; `turn.generation = { stage: "requesting", attempt }` | `entry.added` (system) |
| `requesting` checkpoint | `turn.generation.attempt` | `generation.started` |
| frames (coalesced ≥256 B / 100 ms) | first: `turn.message = partial`, `turn.generation.stage = "streaming"`; then `a`/`s` on content paths | none |
| retry decision | `entries +pi.usage`; `turn.message` deleted; `turn.generation = { stage: "retrying", … }` | `entry.added`, `generation.retrying` |
| deferred | `turn.generation = { stage: "deferred", pollAt }` | `generation.deferred` |
| response with tool calls (closure) | `entries +pi.assistant`; `turn.message` deleted; `turn.generation` deleted; `turn.tools = slots(status:"pending")`; (threshold: `compaction = {…}`) | `entry.added`, `generation.completed{toolCalls:n}`, (`compaction.started`). Slots are `pending`; `tool.started` fires at each tool's `started` checkpoint (§6.3) |
| final answer, no triggers, no continuation (closure) | `entries +pi.assistant`; `turn` deleted; boundary placements (`inbox` splices, `entries +writes`) | `entry.added`, `generation.completed`, `turn.ended{done, answer}`, `input.placed`/`entry.added` for placed writes |
| final answer, `onYield` continuation | `entries +pi.assistant`, `entries +pi.user{continuation}`; `turn.generation = { stage: "preparing" }` | `entry.added`×2, `generation.completed`; **no** `turn.ended` (same group continues) |
| final answer with queued followUp/steer triggers | as "no triggers", then `entries +pi.user`, `turn = { inputs: triggers, tools: [] }`, `turn.generation = { stage:"preparing" }` | `turn.ended{done}`, `input.placed`, `entry.added`, `turn.started` |
| terminal error / aborted-by-provider (closure) | `entries +pi.assistant` (display-only; `model` absent, message in `data`); group resolved `unanswered/failed`; **final boundary runs**: placed writes, selected triggers; `turn` deleted, or replaced by a successor turn for triggers | `entry.added`, `generation.failed{provider|retries_exhausted, entry}`, `turn.ended{unanswered, failed}`, then `input.placed`/`entry.added`/`turn.started` as in "with triggers" |
| `no_model`, overflow with nothing collapsible | as above; overflow additionally `entries +pi.notice` (placed immediately: the closing task counts as gone). `no_model` is not special-cased: a successor for queued triggers fails fast and resolves its own group | `generation.failed`, `turn.ended{unanswered, failed}`, `entry.added`, … |
| overflow with collapse (closure) | `compaction = { reason: "overflow", … }`; `turn.generation = { stage: "waiting", on: "compaction" }` (replacement created `after` collapse) | `generation.failed{overflow}`, `compaction.started`; turn continues |
| abort (fresh abort closure) | optional `entries +pi.assistant` (display-only partial, only if content was streamed); `turn` deleted | (`entry.added`), `turn.ended{unanswered, aborted}` |

### 6.3 Tool

| moment | ops | events |
|---|---|---|
| `beforeTool` handler awaits `api.waiting(ctx)` (`BeforeToolApi`, `plugins.md` §4.2) | `turn.tools[i].waitingOn = ns` (its own commit) | `tool.waiting{callId, on: ns}` |
| `started` checkpoint (after `beforeTool` allowed, before invocation) | `turn.tools[i].waitingOn` deleted; `turn.tools[i].status = "running"` (one commit) | `tool.started` |
| handler blocks/throws | `waitingOn` deleted atomically with the synthetic error result below | |
| handler unwinds on abort/suspend | `waitingOn` deleted in its own commit | none |
| stream flush (≤ every 100 ms) | `turn.tools[i].output = text` | none |
| `api.progress` | `turn.tools[i].{progress,details,continuedBy}` | none |
| result (closure) | `entries +pi.tool_result`; `turn.tools[i].status = done|error`; `turn.tools[i].entry` | `entry.added`, `tool.finished{isError, control}`, (`warning` if truncated) |
| synthetic error before invocation (not offered / missing / invalid / blocked) | same as result with `status: "error"` | `entry.added`, `tool.finished{isError:true}` |
| abort closure | `entries +pi.tool_result(aborted)`; `turn.tools[i].status = "aborted"` | `entry.added`, `tool.aborted` |
| recovery: `started` + unsafe/current-unsafe/schema-invalid | as synthetic error (`interrupted`) | `tool.finished{isError:true}` |

### 6.4 Post-tools

| moment | ops | events |
|---|---|---|
| continuation (default) | boundary placements (`inbox` splices, `entries +pi.user` for steer, `+writes`); `turn.inputs += triggers`; `turn.generation = { stage: "preparing" }` | `input.placed`…, `entry.added`…; no turn event |
| synthesized missing results (orphaned/aborted tool) | `entries +pi.tool_result` per missing call | `entry.added`, `warning{source:"post_tools"}` |
| `addTools` | `config.selectedTools` | `config.changed{["selectedTools"]}` |
| `terminate` | `turn` deleted; boundary(final) placements; successor turn if triggers | `turn.ended{done, answer: assistant}`, then as §6.2 "with triggers" |
| `handoff` | `entries` truncated + `+pi.handoff` (head); `turn` deleted; placements; successor turn | `head.moved`, `entry.added`, `turn.ended{done}`, … |
| queued self-head write ended the group | `entries` truncated + `+reset/handoff`; `turn` deleted; earlier queued steer/followUp removed from `inbox` | `head.moved`, `turn.ended{unanswered, terminated}`, `input.aborted`… (stale) |
| abort closure | `turn` deleted | `turn.ended{unanswered, aborted}` |

### 6.5 Collapse

| moment | ops | events |
|---|---|---|
| task created | `compaction = { taskId, reason, stage: "summarizing", attempt: 1 }` | `compaction.started{through}` |
| retry | `compaction.stage = "retrying"`, `retryAt` | `compaction.retrying` |
| summary lands (closure) | `entries` truncated to `head` + `+pi.summary`; `compaction` deleted | `head.moved`, `entry.added`, `compaction.finished{summary}` |
| stale / declined / failed | `compaction` deleted | `compaction.failed{reason}` |
| hook-supplied summary | same as "summary lands" without a provider stage | same |

Manual collapse (`c.collapse`) is `background`; it appears in `compaction`
exactly the same way. At most one live collapse and exactly one live generation
per conversation are core invariants (rejected before persistence, never
generalized to maps in the view): a manual collapse while one is live rejects
`CollapseInProgress`; a threshold trigger while one is live is skipped;
`NothingToCollapse` rejects the call and produces no envelope. An overflow
replacement generation waits behind its collapse as `turn.generation = { stage:
"waiting", on: "compaction" }`.

### 6.6 Jobs and plugin kinds

| moment | ops | events |
|---|---|---|
| task created | `tasks[id] = { kind, background, status: describe(task) }` | `task.started` |
| checkpoint / slot update | `tasks[id].status…` (job: `stage`, `stdout`, `stderr`, `exitCode`, `occurrence`) | none |
| job notice (`notify: true`) | `entries +pi.notice` (immediately if idle, else via `inbox`) | `entry.added` or `input.queued{write}` |
| terminal | `tasks[id]` deleted | `task.ended{outcome}` |
| marked | `tasks[id].marked = true` | none |

`describe(task)` is declared on the kind next to its checkpoint union; the
kernel calls it whenever the task record changes and writes the result to
`tasks[id].status`. Turn kinds do not use it: their status lives in `turn`.

### 6.7 Conversation-level

| moment | ops | events |
|---|---|---|
| `abort(conversation)` | `inbox` steer/followUp removed; then per-task envelopes as above | `input.aborted`…, then `turn.ended{aborted}` etc. |
| fork created | (new conversation; own watch) | none on the parent |
| owned conversation created by a tool | `turn.tools[i].details` if the tool records it; nothing else on the parent | none |

## 7. Codex mapping

For anyone coming from `codex app-server`.

| Codex | pico3 |
|---|---|
| `Thread` | conversation; `thread/status/changed` ≈ `turn` present/absent (+ `tasks` non-empty for background activity) |
| `Turn { id, items, status, error }` | `turn` (live) + `turn.ended{status}`; items are the entries appended during the group |
| `turn/started`, `turn/completed` | `turn.started`, `turn.ended` (in the same envelope as the last entry, never separate) |
| `ThreadItem::UserMessage` | `pi.user` entry |
| `ThreadItem::AgentMessage` + `item/agentMessage/delta` | `turn.message` (streaming) → `pi.assistant` entry; ops on `["turn","message",…]` |
| `ThreadItem::Reasoning` + deltas | thinking blocks inside `turn.message.content` / the assistant entry |
| `ThreadItem::CommandExecution { status, aggregatedOutput, exitCode }` + `item/commandExecution/outputDelta` | `turn.tools[i]` (`status`, `output`) → `pi.tool_result` entry |
| `ThreadItem::McpToolCall`, `DynamicToolCall`, `FileChange` | same: a tool slot; the tool declaration decides `details` |
| `ThreadItem::SubAgentActivity`, `CollabAgentToolCall` | tool slot with `details`/`continuedBy`; the child is its own conversation/watch |
| `ThreadItem::ContextCompaction` | `compaction` (live) + `pi.summary` entry + `compaction.finished` |
| `error { willRetry: true }` | `generation.retrying` **and** `turn.generation.stage = "retrying"` (visible to late joiners) |
| `error { willRetry: false }` | `generation.failed`, `turn.ended{failed}` |
| `thread/tokenUsage/updated` | `usage` on the assistant entry; `pi.usage` entries for failed attempts |
| `warning`, `deprecationNotice` | `warning` event |
| `thread/queue/changed` | ops on `["inbox"]`, `input.*` events |
| `thread/settings/updated` | ops on `["config",…]`, `config.changed` |
| `thread/resume` (history + `active_turn_snapshot`) | `watch` snapshot: `entries` + `turn` captured atomically with the subscription |
| `thread/items/list`, `thread/turns/list` pagination | `h.entries(scan)` for history beyond the active transcript |
| `process/outputDelta`, `process/exited` | `tasks[id].status` for `pi.job` |
| `item/started` → `item/completed` (same id) | tool: `callId` is stable across the slot and the result entry; assistant: atomic swap, no id needed |

What pico3 has that Codex does not: atomic multi-field envelopes; retry and
compaction state visible in a snapshot; one replica protocol for state-driven and
event-driven clients.

What Codex has that pico3 does not: turn-level unified diff (`turn/diff/updated`),
plans, approvals (`waitingOnApproval`). Approvals are a `beforeTool` hook waiting
on user input; the kernel shows that as `turn.tools[i].waitingOn` and the
`tool.waiting` event (see `plugins.md` §4.2 for the approval plugin).

## 8. Consumption patterns

Event-driven (imperative UI, third-party client):

```ts
w.start(({ ops, events }) => {
  view = applyImmutable(view, ops);           // keep the replica current for lookups
  for (const e of events) switch (e.type) {
    case "entry.added":          transcript.append(e.entry); break;
    case "turn.started":         status.set("working"); break;
    case "turn.ended":           status.set(e.status === "done" ? "idle" : `stopped: ${e.reason}`); break;
    case "generation.retrying":  status.set(`retrying at ${e.retryAt}`); break;
    case "compaction.started":   banner.show("compacting…"); break;
    case "compaction.finished":  banner.hide(); break;
    case "tool.started":         transcript.showRunning(e.callId); break;
    case "tool.finished":        transcript.settle(e.callId, e.entry); break;
  }
});
```

State-driven (React/Solid): `useSelector(v => v.turn?.message)`,
`useSelector(v => v.compaction)`. `applyImmutable` preserves identity of untouched
branches, so selectors are O(1) and no traversal happens.

Path router (when neither fits): dispatch each op on its first one or two path
segments; the table in §4 is the complete list of paths.

Presentation services (Chord RPC): keep a derived tracked document in the shape
the client wants (e.g. Codex-style `turns[]`), update it from envelopes, ship its
own ops. Project image blobs out of `entries[].model` there, not in the kernel.

## 9. Watchers, late joiners, multiple clients

### 9.1 One view per conversation, many watchers

- The kernel keeps **one** tracked view document per conversation that has at
  least one watcher (not one per watch). It is built on the line the first time
  a watch is opened and dropped when the last watch stops.
- After every commit that touches the conversation, the kernel mutates that one
  document through its proxy, `flush()`es once, attaches the commit's events, and
  hands the same `Envelope` to every watcher. Fan-out cost is per conversation;
  the kernel never knows how many clients exist or what they render.
- `watch(ctx)` returns `{ view, revision, start, stop }` where `view` is a
  `structuredClone` of the tracker target taken **on the line**, `revision` is
  this watch's starting revision, and the subscription is installed in the same
  line operation. The first envelope a watcher receives is therefore exactly
  `revision + 1`; there is no window in which a commit can land between snapshot
  and subscription.

### 9.2 Late joiners

A client that attaches mid-flight needs no history and no events: everything
in progress is state and is in the snapshot.

| in flight at attach time | where the late joiner finds it |
|---|---|
| assistant message streaming | `turn.message` (partial), `turn.generation.stage === "streaming"` |
| provider backoff | `turn.generation = { stage: "retrying", retryAt, lastError }` |
| tool running | `turn.tools[i].status === "running"`, `output` so far |
| tool waiting for approval / a question | `turn.tools[i].waitingOn === ns` (+ the plugin's own Chord service instance, `plugins.md` §6) |
| compaction | `compaction` |
| background job | `tasks[id].status` |
| queued follow-ups | `inbox` |

This is the concrete difference from an event protocol: Codex must answer the
same question with `thread/resume` + `active_turn_snapshot()` + `activeFlags`,
and still cannot show "retrying".

### 9.3 Reconnect

A client keeps `lastRevision`. If an envelope arrives with
`revision !== lastRevision + 1` (only possible on a transport drop between a
Chord RPC service and its client; in that transport Chord's own
`ReplicatedStateDelivery.sequence` plays this role), the client discards its
replica and opens a fresh watch. Nothing is client-specific, so there is nothing
to resume, acknowledge or replay.

### 9.4 Concurrent decisions

Any action that answers something the view shows (approve a tool, abort an
input, change config) is a commit on the line. Two clients acting on the same
item are serialized: the first commit records the outcome, the second sees the
recorded outcome inside its own transaction and rejects with a typed error
("already decided", `already_placed`, …). Both then receive the same envelope
and converge. Plugin APIs must therefore do their check-and-record inside one
commit (`plugins.md` §2, `memoOnce`), never check-then-commit.

### 9.5 Owned conversations

A subagent is its own conversation with its own watch. The parent view shows
only what the parent's tool put in its slot (`details`, `continuedBy`); a UI that
wants to render the child watches the child. Presentation services may merge the
two into one derived document if a client wants a tree.

## 10. Plugins

Everything an extension can contribute (tools, hooks, task kinds, entry kinds,
namespaces), where its durable state lives, how it appears in this view, and how
it is packaged as Chord facets is specified in `plugins.md`. The view-facing
rules are:

- an extension's presentation is only what it projects: the namespace's
  declared `view` projection under `plugins[ns]` (nothing by default), the kind's
  `describe()` output under `tasks[id].status`, the core-rendered tool slot fields
  (`status`, `waitingOn`, `output`, `progress`, `details`, `continuedBy`, `entry`),
  and entries. Raw namespace state, memos and other slot working state never
  appear;
- extension events are `plugin.<ns>.*`, emitted with the namespace token from the
  extension's own commits; core events remain core-only;
- nothing about Chord services is visible in the view. A keyed service instance
  (an open approval dialog) is a channel, not state; the corresponding state is
  `waitingOn` on the slot.

## 11. Kernel implementation notes

- One tracked view document per watched conversation (§9.1); the kernel applies
  each commit's effects to it (entries, config keys, inbox, turn, compaction,
  tasks, plugins) through the proxy and flushes.
- Core closures record events with `tx.emit(event)`; the kernel attaches the
  list to the envelope. Events are core authority; extensions emit only through
  a namespace token (`plugins.md` §3).
- `turn.generation`, `compaction` and `tasks[id].status` are derived from task
  records by kind-owned `describe(task)`; the raw records never leave the kernel.
- Display-only assistant entries carry the message in `data.display` and no
  `model`, so context derivation needs no special case.
- Envelope assembly happens on the line; listener dispatch off the line,
  synchronous and in order; a listener throw closes that watch only.
- No `AsyncLocalStorage`: line re-entry is detected through the Chord context
  the Session hands to its callbacks (`hardening-handoff.md` §7).
- Chord bridge (`plugins.md` §6.1): a bounded ordered adapter applies one raw
  envelope's ops to the Chord `MutableReplicatedState` and calls `publish()` in
  the same synchronous block (Chord's `subscribe()` publishes pending mutations
  itself, so apply and publish must not be separated by an await); overflow or
  publish failure closes and respawns that instance; a persisted commit is never
  failed by a listener.
- Tests: for every row in §6, assert the exact ops and events of that commit
  (memory backend, fake provider), plus snapshot-equals-fold after every
  envelope and a head-in-parent capture case.

## 12. Open items

- `warning` payload shape (source enum vs free string).
- Application-level backpressure for slow asynchronous consumers is TBD; the
  raw watch itself is not (synchronous listener, bounded pre-start buffer).
- Whether `turn.tools` should keep finished slots of the previous assistant
  message when the continuation generation prepares (current: cleared at
  `prepared`; Codex keeps all items of the turn). Recommendation: keep them, keyed
  by call index within `turn.exchanges[]` only if a UI needs it; otherwise
  entries already hold the results.
- Whether plugin events need a schema registry for RPC clients (the plugin
  token could carry TypeBox schemas per event name).
- Whether plugin-declared **extra documents** are needed for large plugin state;
  start with slices in the core documents and add shards only with a
  demonstrated cost.
