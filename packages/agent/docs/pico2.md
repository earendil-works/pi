# pico v2

A harness for running agents. This document is the design under review, not an implementation
claim. Decisions still needed before implementation are listed in §25.

Assumed knowledge: pi-ai (`Models`, `streamSimple`, tool definitions, thinking levels, deferred
handles, `AssistantMessage`/`UserMessage`/`ToolResultMessage`). Everything else is defined here.
Interfaces and examples are proposed TypeScript shapes, not existing package exports or a claim of
implementation completeness. JsonValue/JsonObject mean strict JSON. AssistantMessage, UserMessage,
AssistantMessageFrame, DeferredHandle, Usage and Models reuse pi-ai; AgentMessage/ThinkingLevel and
Context reuse the existing agent harness. Host capabilities and explicitly open contracts are not
silently implemented by these sketches. Normative words: MUST, MUST NOT, SHOULD, MAY.

History: `pico.md` (v1) modelled a session as one resident tree of nodes; `pico-v2-tree-draft.md`
tried to page that tree; `pico-v2-folds-draft.md` replaced the tree with a transcript and used
"folds" to bound the model's context. This version keeps v1's driver, kinds, scratch, line, hooks,
typed values and watch, and replaces both the tree and the folds with three separately-lived things and an
explicit context list.

---

## 0. In one page

A **session** stores conversations, entries, tasks, values and lists. Its committed writes share
one ordered sequence; the backend decides physical representation. JSONL keeps main history and
separate named working scopes (§4). A conversation is three things:

1. a **transcript**: an append-only list of immutable **entries** (a user message, an assistant
   message, a tool result, a summary): what happened;
2. **tasks**: small mutable records with a status and code (a generation in progress, a tool
   executing, a background job, a subagent, an approval waiting): what the driver runs;
3. **typed values and lists**: settings and plugin state with immutable versions at journal
   positions: what forks and rewinds read as of a committed boundary.

Session-scoped values hold metadata such as entry labels and request identities. They do not rewind.
Conversation values and lists follow history, independently of transcript selection (§5).

The model does not read the transcript. It reads the conversation's **context**: a short list of
entry ids, edited by three ops (`append`, `replace`, `reset`), that always has the shape
"one head entry (a summary or a handoff), then selected entries in transcript order".

A **kind** defines what an entry or task is and, for tasks, the code that runs,
recovers and aborts it. Values and lists use typed bound addresses, not kind registration. A **read model** (tables for SQLite; rebuilt in memory for JSONL) answers
"what is live", "what is this task now", "the newest value of key K before position P" and pages
the transcript, without replaying the journal. Memory holds each live conversation's context
entries and its live tasks; everything else is read on demand. A **subagent** is a task that
owns a conversation; the only nesting is `conversation ⊃ task ⊃ conversation`. Clients **watch** a
conversation and receive a transcript page, the context list, live tasks, and then journal records
as they commit.

---

## 1. Definitions

- **seq**: the position of a record in the journal; a session-global positive safe integer minted
  while building a command on the line (§7). Every entry, task and conversation is identified by
  the seq of the journal record that created it. Storage preserves these seqs; it does not assign
  or remap them. Internal identities need no UUIDs or separately allocated ids. An optional external
  request identity maps to the accepted input's numeric id through a session value (§18.1).
- **conversation**: an identity (its creation seq) with a mutable **conversation state** (§4.1), a
  transcript, work, typed values/lists, and a context list. The **root** is the conversation with no parent.
- **entry**: an immutable transcript element (§2). Written once; never patched; never reordered.
- **task**: a mutable element with a lifecycle (§3): a generation, a tool execution, a job, a subagent, a collapse, an approval. Patched by `set`.
- **value**: a scalar at a typed address; session-scoped (latest only) or conversation-scoped
  (versioned, with historical reads). A conversation **list** stores immutable sequenced elements (§5).
- **history boundary**: the last seq of a complete commit, never a position inside one.
- **transcript order**: the order of a conversation's entries by id (seq). There is no other order.
- **context**: the ordered list of entry ids the model reads (§6). Lives in the conversation state.
- **live**: a task whose status role is not `terminal` (§3.2). A conversation is live if it has live
  tasks, a live owner task, or an attached watcher/handle.
- **the line**: the session's single command queue (§7).
- **scratch**: ordinary values/lists in a named working scope, durable until explicit retirement (§3.5).
- **projection**: the messages the model receives, built from the context list (§6.4).
- **canEditContext** (§8.1): no generation request in flight and no unresolved foreground calls.
  A safe context edit is not a request to generate.
- **generation task**: the durable obligation to generate; never inferred from the context tail.

---

## 2. Transcript

### 2.1 Entry

```ts
interface Entry {
  id: number;                 // seq of its journal record; also its transcript order
  conv: number;               // owning conversation
  kind: string;               // "user" | "assistant" | "tool_result" | "summary" | plugin content kinds
  by?: number;                // the task that wrote it, if any
  callIndex?: number;         // tool results: index of the call within the assistant message they answer
  through?: number;           // summaries: the last entry the summary replaced (§6.2)
  key?: string;               // optional indexed content key; not a typed value address
  meta: JsonObject;           // small resident fields: timestamp, preview, sizes
  payload?: JsonValue;
  commitEnd: number;          // containing MAIN commit; supports entry-based historical selection
}
```

Entries are immutable and the transcript is append-only: no journal record targets an existing
entry and nothing is inserted before an existing one. An entry is reconstructed by one addressed
read of its journal record.

### 2.2 Content kinds

```ts
defineContent({ kind, meta: M, payload: P, keyed?: true, context: "select" | "none" },
              { project(entry, ctx): Promise<AgentMessage[] | undefined> })
```
- `context`: whether inserting an entry of this kind also appends its id to the conversation's
  context list (§6.1). Core: `user`, `assistant`, `tool_result` → `select`; `summary`,
  `custom` → `none` (a summary enters the context only through the `ctx_replace` issued by the
  command that creates it; a reset's bootstrap enters through `ctx_reset`). There is no per-entry override.
- `project`: what a selected entry contributes to the model's messages. May read the payload
  (`ctx.payload(id)`) and nothing else. A selected entry MAY project nothing.

---

## 3. Tasks, scheduling and cancellation

### 3.1 Task record

```ts
type TaskRole = "start" | "inflight" | "waiting" | "terminal";
interface Task<S extends string = string, D = JsonObject> {
  id: number;                 // creation-record seq
  conv: number;
  kind: string;
  at?: number;                // originating entry, including an inherited entry
  for?: number;               // spawning task; provenance, not an execution dependency
  after: number[];            // all must be terminal before normal effect starts
  status: S;
  state: D;                   // schema-validated JSON; no promises, closures or mutable aliases
  owns?: number;              // child conversation, reciprocal with conversation.owner
  abort?: true;               // internal durable cancellation target; not a public task-cancel API
}
```

`after` expresses a durable wait. It means **settled**, not succeeded. There is no automatic
failure propagation along edges, no per-edge cancellation policy, and no kind-level concurrency
flag. Ordinary errors are outcomes. Concrete coordinators interpret the outcomes they need.

```text
parallel tools:    T1, T2, T3; P.after = [T1,T2,T3]
sequential tools:  T1; T2.after = [T1]; T3.after = [T2]; P.after = [T1,T2,T3]
collapse:          G.after = [C]
foreground child: tool.finishing.after = [subagent]
```

Dependencies must exist, remain in the same ownership tree, and form an acyclic graph. Check
creation and dependency edits against earlier records in the command. `for` is not a dependency
edge: G may spawn C and then wait for C without creating a cycle. Independent forks never become
implicitly runnable because another scope refers to them.

### 3.2 Roles and lifecycle

| Role | Meaning | Scheduler action when unowned |
|---|---|---|
| `start` | Work or a local continuation is ready once dependencies/time permit | `effect` |
| `inflight` | External work was begun; an unowned task may have been interrupted | `recover` |
| `waiting` | An external observer or owned child will supply the next transition | Re-arm once after open |
| `terminal` | Immutable outcome | None |

A kind declares its statuses and allowed transitions. Status roles are interpreted by the
harness, not by storage. Every nonterminal status must have a recovery/cancellation story.

```text
external work:  commit inflight intent → perform effect → commit outcome
local work:     read/prepare → commit outcome
park:          commit new status/dependencies → RETURN
settle:        output + usage + terminal status + required successors, ONE COMMAND
```

A task MUST NOT await another task's lifetime inside `effect`, `recover` or `abort`. It either
settles and leaves successors, or records a dependency/continuation and returns. A control task
such as `post_tools` needs no fake inflight write when its entire action is a command.

### 3.3 Kind and execution interfaces

These are proposed interface shapes, not existing exported APIs. Schemas validate strict JSON;
concrete status/state fields are specified in §3.9–§3.15.

```ts
interface JsonSchema<T> {
  parse(value: unknown): T;
}
interface TaskDefinition<S extends string, D> {
  kind: string;
  state: JsonSchema<D>;
  initial: S;
  roles: Record<S, TaskRole>;
  transitions: Record<S, readonly S[]>;
  effect(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
  recover(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
  abort(task: Readonly<Task<S, D>>, ctx: TaskContext<S, D>): Promise<void>;
}
interface TaskPatch<S extends string, D> {
  status?: S;
  state?: Partial<D>;
  after?: number[];
}
interface TaskContext<S extends string, D> {
  readonly signal: AbortSignal;
  readonly conv: ConversationView;
  readonly services: TaskServices;
  readonly working: WorkingScope;                       // ordinary values/lists, §5.6
  set(patch: TaskPatch<S, D>): Promise<void>;            // this task only
  settle(status: S, state?: Partial<D>): Promise<void>;
  commit(build: (tx: Command) => void | Promise<void>): Promise<boolean>;
  commit(scope: WorkingScope, build: (tx: WorkingCommand) => void | Promise<void>): Promise<boolean>;
  getValue<T>(address: Value<T>): Promise<T | undefined>;
  readList<T>(address: ValueList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
  payload(entryId: number): Promise<JsonValue | undefined>;
  emit(kind: string, payload: JsonValue): Promise<void>;
  sleep(ms: number): Promise<void>;                    // this effect's timer, interrupted by signal
}
```

`TaskServices` is the typed host service bundle (§12), not another durable object. Provider/tool
exceptions are classified by their kinds. Storage and invariant failures escape and fault the
session; a broad catch around effect plus settlement must not convert them into tool errors.
An unexpected kind exception is reported and faults the session rather than endlessly relaunching
unchanged start-role work. Faulted handles cannot continue cancellation writes.

### 3.4 Foreground, ownership and busy state

```text
local foreground:
  generation, or task whose for names a generation
  // tools, post_tools, and automatic collapse are foreground

required foreground work:
  local foreground plus its unfinished after dependencies
  plus foreground work in conversations owned by those required tasks

background:
  other work; e.g. a detached job/subagent, standalone approval, manual collapse

busy(conv):
  local foreground remains OR cancellation targets remain in its required ownership subtree
```

`post_tools` is foreground even after every tool has settled. This prevents acceptance between
tool completion and continuation from accidentally creating a second generation. Background
work does not request generation. Automatic collapse uses `for: G`; a standalone manual collapse
does not. A waiting foreground tool keeps its required subagent/approval inside cancellation.

```text
conversation.parent = provenance and historical inheritance
conversation.owner  = subagent task that owns this conversation, if any
scope(conv)         = conv + descendants reached through task.owns, not parent links
```

Root and every ownerless fork are independent drive scopes. A foreground wait on a subagent is
represented by the tool's dependency, not inferred from its parent's transcript or tool name.

### 3.5 Scratch and publication

Scratch is a use of ordinary values/lists in a named working scope (§5.6), not a storage subsystem.
Kinds reduce bounded list pages into partial output. Task outcomes reference immutable entries;
control tasks may have no output entry. A task uses `workingScope(String(task.id))` by convention. Keys distinguish attempt/poll identities;
recovery reads only the current request's keys. Superseded attempt data may remain unreachable
until retirement, but cannot be mistaken for the active attempt's frames/candidate.

```text
progress: working-scope-only commit → publish preview
settlement: stop producer/sink admission → drain admitted progress writes
            main commit: output + terminal task + retireScope(working)
cleanup: backend may remove physical working files AFTER that commit
```

Retirement is logically atomic with settlement. Failed unlink is harmless: committed retirement
makes the old contents invisible. Storage never infers retirement from owner absence/status. Close
and fault retire nothing. Invocation fencing rejects late writes; generic scopes allow reuse.

### 3.6 Scheduler and process-local ownership

One scheduler per session services the union of active drive scopes. Multiple callers may overlap;
they never install competing executors. Removing a caller does not cancel durable work.

```ts
interface OwnedRun {
  controller: AbortController;
  promise: Promise<void>;       // current effect/recovery and any joined cancellation cleanup
}
const running = new Map<number, OwnedRun>();
const recovered = new Set<number>(); // inherited waiting tasks already re-armed in this process
const openedAt = committedHead;
```

These structures are process-local. The map is the owned set; no duplicate owned bitmap, durable
lease, or promise registry is needed. Each retry/phase gets a fresh controller. The scheduler owns
any promise replacement/cleanup; effect completion cannot delete a newer ownership claim.

```text
pass:
  scope = union of active drive scopes
  for marked tasks in scope:
    signal EVERY owned affected execution before waiting on any one
    arrange exclusive cancellation reconciliation (§3.7)
  for unmarked, unowned live tasks in scope:
    start:
      if all after tasks terminal, notBefore elapsed, required poll permit present:
        claim synchronously; launch effect; do not await its whole lifetime in this pass
    inflight:
      claim synchronously; launch recover
    waiting:
      if task.id <= openedAt and not recovered:
        mark recovered before launch; claim; launch recover to re-arm and return
  resolve drive observations from committed state
  wait for commit | effect completion | timer | external observer notification
```

External observers for jobs/approvals are disposable subscriptions, not promises held by a task
waiting for another task. Each observer writes through the line and checks the current task's
status/cancellation before publishing. The host retires observers when their task ends/closes.

The scheduler reads task metadata, not transcript payloads or sibling tool outcomes. Terminal
dependency states use indexed point reads and may be cached while referenced by live tasks;
never repeatedly replay history. No global reverse-dependency index is required initially.
No conversation `next()`, tail inference, or open-time successor repair exists.

### 3.7 Conversation cancellation

Public cancellation is `conv.abort()`. **There is no public `abortTask(id)`.** A task's internal
`abort` bit records membership in a conversation cancellation; it is not a second user-facing
cancellation mechanism. `cancelQueued(id)` only withdraws unconsumed input.

```text
abort(conv), ONE COMMAND:
  if this conversation already has outstanding cancellation targets: join; do not drain again
  select current foreground + required dependency/owned-child closure
  mark every selected nonterminal task abort = true
  drain currently queued steer/followUp in affected foreground conversations
  preserve write/nextRun; return drained input identities/content

normal admission/settlement:
  marked work cannot start an external action or create normal successors
  input arriving during cancellation queues; do not consume it during cleanup
  new foreground tasks cannot bypass outstanding cancellation in that conversation
```

Selection is durable in the task marks. Do not recompute a smaller target set when an earlier
parent becomes terminal. Detached background work is not selected by ordinary foreground abort.
Deletion/explicit whole-conversation shutdown selects all live tasks in the ownership subtree;
this is still a conversation operation, not arbitrary graph-node cancellation.

```text
reconcile a marked task:
  retain ONE ownership claim through the entire sequence
  signal its controller if an effect/recovery is owned here
  await that task's own execution returning, whether fulfilled or rejected
  report rejection; storage/invariant faults still prevent further writes
  re-read task; if already terminal, do nothing
  otherwise run kind.abort under the SAME exclusive claim
  release claim only when that invocation finishes
```

That await is allowed: it joins this process's current execution of the SAME task. It prevents
its effect and abort handler from writing concurrently. It is not a wait for dependency tasks.
An uncooperative external effect can delay cancellation; no timeout may silently permit a second
writer. Driver passes can still signal/cancel other independent tasks.

Never-started sequential tools can abort immediately, regardless of their `after` dependencies.
Each writes its required error result. `post_tools.abort` creates no generation and performs no
unsafe context edit; queued writes may remain queued. For a marked conversation owner, defer abort invocation until marked owned descendants are terminal
(§3.13); no effect promise waits for that condition. Normal child completion checks the owner's
marker before settling it, so cancellation cannot become success.

```text
abort before P settlement: P is marked → no G2
P settlement before abort: P + G2 commit together → abort selects G2
crash after marking: open reports marked tasks → next covered drive reconciles them
crash after effect returned: marked inflight task remains → abort reconciliation resumes
```

The host is the sole live writer. Another process may reopen after handoff/crash; concurrent
independent writers are not supported. A remote client sends cancellation through the owning host.

### 3.8 Open, drive, suspension and close

```text
open:
  hydrate storage/residency; validate kinds/statuses/dependencies
  start nothing; write no repair generation; expose inspect()
inspect(): session-wide { start, inflight, waiting }, including cancellation marks
conv.drive(): run only its ownership tree
harness.drive(): run every independent tree in the session
```

A task in `start` can still be blocked by a dependency, retry time or deferred-poll permission.
`inspect()` reports durable roles, not a promise that every start-role task is runnable now.

```text
conv.drive → idle: no foreground or outstanding cancellation in its ownership scope
harness.drive → idle: no live tasks anywhere
suspended: work remains, but progress requires an outside event/permission
closed: harness closed before requested condition
```

While a conversation drive is active it also services background work in that scope, but it does
not keep waiting solely for detached background tasks after foreground quiescence. A host wanting
to supervise all background work keeps a session drive active. Inherited waiting-task recovery is
once per session process, not once per caller or scope.

`close()` seals commands and scratch admission, signals owned executions, detaches observers,
and drains admitted persistence. It writes no cancellation marks and no task settlements. Effects
must release resources/cooperate with close; the current cooperative-wait policy and a possible
bounded-close alternative remain explicit in §25. A caller cancelling its wait is not `abort()`.

### 3.9 Generation

**Responsibility:** one provider generation, including its retries/deferred polls. It publishes a
response and either tool work plus a join, or the normal final-answer boundary. It never awaits tools.

```ts
type GenerationStatus = "pending" | "streaming" | "retry_wait" | "deferred" | "polling"
  | "done" | "failed" | "aborted";
interface GenerationState {
  settings: GenerationSettings;             // captured when this generation is created
  attempt: number;                          // starts at 1
  notBefore?: number;
  requestAsOf?: number;                     // committed context boundary used by current request
  collapse?: { id: number; reason: "threshold" | "overflow" | "manual" };
  overflowRetried?: true;
  deferred?: DeferredHandle;
  poll?: number;
  produced?: number;                        // immutable assistant entry
  calls?: number[];
  postTools?: number;
  error?: string;
}
```

Roles: pending/retry_wait/deferred = start; streaming/polling = inflight; others terminal.
Transitions: pending/retry_wait → streaming or failed/aborted; streaming → retry_wait/deferred or
terminal; deferred → polling or aborted; polling → deferred/retry_wait or terminal. Adding a
collapse dependency can preserve the current start status. Terminal states accept no patches.

```text
creation: idle acceptance, a final-answer continuation, or post_tools settlement
  capture model/thinking/tools/tool order/options/retry policy from current settings
  task pending, attempt = 1

pending/retry_wait effect:
  if captured collapse dependency exists:
    it is terminal (scheduler readiness)
    overflow collapse unsuccessful → fail this generation; no replacement
    threshold/manual failure → proceed using unchanged context
  else if automatic compaction is indicated:
    decide before_collapse outside line
    revalidate context and cancellation inside line
    if approved:
      C = create collapse { for: G, captured prefix/model }
      set G { after: [C], collapse: { id:C, reason:threshold } }
      RETURN; no promise waits for C
  capture conversation's MAIN commitEnd as context boundary; commit streaming intent
  build projection + request; run before_request outside line
  re-check cancellation/close before provider call
  stream provider; scratch receives frames
  classify outcome below
```

A live manual collapse is attached as a dependency before admitting a new request, rather than
creating a competing automatic collapse. A generation always exists while automatic compaction
runs. There is no state where consumed input is represented only by a background collapse.

```text
provider outcome, in precedence order:
  close → leave task recoverable; no terminal write
  marked cancellation → aborted partial + matching error results; no successors
  deferred → reported usage + set deferred(handle, poll, notBefore)
  overflow, not already retried:
    decide collapse; commit usage + existing G.retry_wait + C + G.after=[C]
    declined/impossible → usage + failed G
  other error → reported usage + bounded retry_wait, else failed G
  successful response with calls → settleWithCalls
  successful response without calls → settleFinal
```

```text
settleWithCalls, ONE COMMAND:
  A = assistant entry with call list
  for each call in source order:
    Ti = tool { for:G, at:A, callIndex, captured active-tool authorization }
    parallel: Ti.after = []
    sequential: Ti.after = [previous tool] except first
  P = post_tools { for:G, at:A, after: all Ti }
  usage(G, reportedUsage)
  settle G { done, produced:A, calls:all Ti, postTools:P }
```

The response, all tools, and exactly one P commit together. Stop reasons other than toolUse with
calls create truncated tool tasks: they produce error results but do not execute external tools.
Projection later sorts results by callIndex, regardless of their transcript completion order.

```text
settleFinal:
  prepare on_yield outside line only if eligible queued input is absent
  ONE COMMAND, checking latest cancellation and queue state:
    A = assistant entry; usage; settle G
    select safe writes and eligible steering/followUp (§18)
    if continuing:
      place selected items in admission order; dequeue
      place hook continuation if applicable
      create next generation with freshly captured settings
    else:
      place safe writes only
      finishOwnedConversation(tx, conv, { outcome:done, result:A })
```

Stale hook decisions are discarded/recomputed before committing. A new queued trigger takes
precedence over an old yield decision. `finishOwnedConversation` is ordinary settlement code
(§3.13), not a later scheduler pass. Terminal failure uses the same owner notification with a
failed outcome and no successor. Input-result attribution remains separately open (§18.2).

**Deferred:** admitted only with `pollDeferred`. Commit polling intent and increment poll before
fetching; still-deferred/fetch-error outcomes return to deferred with backoff on the same task.
Abort attempts provider cancellation best-effort, then completes locally. No new generation is
created for a deferred poll or retry. Retry delays use the captured bounded exponential policy.

**Recovery:** polling becomes deferred; streaming with committed frames publishes an interrupted
aborted partial and matching error results; streaming without frames retries within budget or
fails. This preserves the current draft's policy; old-lane interrupted-stream parity is pending
(§25). Recovery must never resurrect a marked generation or create a fresh retry budget.

**Abort:** stop/drain frames, cancel deferred handle if present, write required partial/error
entries and known usage, settle aborted. A never-started generation has no fabricated assistant
response. No tools, join, yield continuation or provider retry follows cancellation.

### 3.10 Tool execution

**Responsibility:** one call. No sibling reads, last-sibling checks, queue draining, context reset,
or next-generation creation. The same handler serves parallel and sequential execution.

```ts
type ToolStatus = "planned" | "truncated" | "running" | "waiting" | "finishing" | "done" | "aborted";
interface ToolState {
  callIndex: number;
  callId: string;                          // provider call identity; task.id is harness invocation identity
  name: string;
  args: JsonObject;
  allowed: boolean;                        // captured from generation's active-tool names
  replay: "safe" | "never";
  approved?: true;
  approval?: number;
  delegated?: number;                      // a subagent/job whose outcome supplies this tool result
  produced?: number;
  terminate?: boolean;
  handoff?: string;                        // requested reset; interpreted by post_tools only
  error?: string;
}
```

Roles: planned/truncated/finishing = start; running = inflight; waiting = waiting; done/aborted =
terminal. Planned can become waiting/running/done/aborted; running can become finishing/done/aborted;
waiting can become planned/done/aborted; finishing becomes done/aborted. Safe recovery can return
running to planned while preserving effective arguments/memos. Tool and sink interfaces: §16.

```text
planned effect:
  unavailable/inactive tool → settle own error result
  validate arguments against tool schema
  before_tool outside line, unless already approved:
    block → settle own error result
    hold → create approval + set this tool waiting, ONE COMMAND; RETURN
  commit running intent with effective args and replay declaration
  execute with own signal, invocation identity, scratch/sink and application context
  drain output; run after_tool outside line
  ONE COMMAND:
    re-check cancellation
    append own result; reported usage; active-tools additions
    settle this tool, retaining terminate/handoff control metadata

truncated effect:
  settle own "not executed" result; never invoke tool
```

A definition merely present in the registry is insufficient authorization: the generation must
have offered it. Arguments and replay declarations are captured before the external invocation.
An ordinary tool throw becomes `isError`; storage errors do not. Unknown addTools names remain
dropped under the existing draft policy. Final text is capped; truncation is explicit (§16).

**Delegation without awaiting another task:** a harness-native tool can return a durable wait action.

```text
ONE COMMAND:
  S = create subagent/job with for = this tool
  set tool { finishing, delegated:S, after:[S] }
RETURN from current execution

S eventually terminal → scheduler can run this SAME tool's finishing phase
finishing effect:
  load S's committed result
  apply after_tool outside line
  commit this tool's own result + terminal outcome
```

This reuses the tool task rather than inventing an operation wrapper. The extra phase is needed
when async after_tool processing must occur outside the child settlement command. No in-process
waitFor(S) exists, either initially or on recovery. Background delegation instead settles the tool
with the task id immediately; it has no dependency on the detached work.

**Recovery:** replay only when both captured and current declarations permit safe replay and no
cancellation won. Preserve task id, effective arguments and memos. Otherwise settle an interrupted
error result from the last checkpoint, without applying uncertain addTools/terminate/handoff effects.
Waiting holds are restored as holds; finishing dependencies survive without re-arming a promise.

**Abort:** after joining its own execution, drain scratch and settle an error tool result with
aborted metadata. Unstarted calls also get results, completing the assistant exchange. No dependency
must finish first. This handler does not inspect siblings or invoke post_tools itself.

### 3.11 Post-tools

**Responsibility:** join one generation's tool results and decide what follows. This is a real
exchange coordinator, not a conversation-level progression loop.

```ts
type PostToolsStatus = "pending" | "done" | "aborted";
interface PostToolsState {
  generation: number;
  produced?: number;                         // optional terminal result reference, never payload
}
```

Created by generation settlement, `for:G`, `after:all calls`. Pending = start; done/aborted =
terminal. It has no external effect and no inflight status. Its effect is one serialized command:

```text
P.effect, ONE COMMAND:
  require all after tasks terminal and P still pending
  read completed call outcomes                         // ONLY this coordinator reads siblings
  if marked cancellation: settle P aborted; RETURN
  select safe writes, mode-selected steering, and any valid handoff
  place selected content in admission order; dequeue consumed items
  apply handoff reset after full exchange completion, if requested
  if exchange was aborted or termination policy says stop:
    do not consume generation-triggering input
    settle P done
    finishOwnedConversation(tx, conv, terminal outcome)
  else:
    G2 = create generation with current model/thinking/tools/options
    settle P done
```

Selection precedes mutation: on a stopping path only safe writes are consumed. Follow-ups wait
for a normal final answer, not this tool boundary. A handoff is an explicit trigger, not tail
inference. Compaction belongs to the already-created G2; it can attach a collapse dependency.

Current draft termination policy is any completed call requesting terminate, with all sibling
results retained. Its difference from the old lane's all-results policy remains listed in §25.
An ordinary error result is not cancellation. Conflicting handoffs require a defined selection
policy before implementation; do not silently pick completion order (§25).

**Recovery:** there is no unknown external action. If the commit did not land, P remains pending;
if it landed, P is terminal and G2 already exists. **Abort:** settle P aborted, create nothing,
perform no context edit. Remaining writes stay queued; other marked tasks finish independently.

```text
T2 settles → P blocked
T3 settles → P blocked
T1 settles → P eligible, already durable
P settles + G2 created → one commit
```

No tool knew which one finished last. One additional task/terminal record per exchange buys a
single owner for the exchange policy and removes orchestration from every tool implementation.

### 3.12 Collapse

**Responsibility:** summarize a captured prefix and publish a validated replacement. It never
creates a generation. A pending generation already represents automatic continuation.

```ts
type CollapseStatus = "pending" | "summarizing" | "retry_wait" | "publishing" | "done" | "failed" | "aborted";
interface CollapseState {
  through: number;
  prefixVersion: number;
  contextAsOf: number;
  settings: GenerationSettings;
  instructions?: string;
  attempt: number;
  notBefore?: number;
  produced?: number;
  error?: string;
}
```

Pending/retry_wait/publishing = start; summarizing = inflight; others terminal. Pending/retry_wait
→ summarizing; summarizing → publishing/retry_wait/done/failed/aborted; publishing → done/failed/
aborted. A publishing task can replace its after list to wait for a current exchange boundary.

```text
creation:
  capture complete-exchange cut, prefixVersion, context boundary and summary settings
  one live collapse per conversation; reuse existing task rather than race duplicate insertion

effect:
  commit summarizing intent
  project captured prefix, including prior summary; call summarizer
  complete candidate → persist in task scratch
  ONE COMMAND:
    usage + outcome
    cancelled/stale prefix → terminal outcome, no context publication
    context editable → summary entry + ctx_replace + settle done
    otherwise → set publishing with after = current request/exchange coordinator
  RETURN

publishing effect, ONE COMMAND:
  re-check cancellation, prefixVersion and canEditContext
  if another exchange is now open: update after to its generation/post_tools; RETURN
  otherwise publish candidate + ctx_replace + settle done
```

The durable publishing phase is needed only when a speculative summary finishes during a busy
exchange. It waits through dependencies, never an effect-held promise. Reported provider usage
commits once with the attempt outcome, not again when publishing. Scratch remains until terminal
settlement. Prefix changes reject publication; appends beyond through survive unchanged.

**Recovery:** reuse a complete persisted candidate when available; otherwise retry interrupted
summarization within budget or fail. Publishing reads its candidate and revalidates. **Abort:**
stop summarizer, drain scratch, record known uncommitted usage and settle aborted, without summary
publication. Automatic G waits on this same task and interprets its terminal outcome (§3.9).
Token-budget/split-turn parity remains an explicit compaction-policy decision (§25).

### 3.13 Subagent

**Responsibility:** own one child conversation and expose its terminal foreground result.

```ts
type SubagentStatus = "planned" | "running" | "done" | "failed" | "aborted";
interface SubagentState {
  prompt: AgentInput;
  context: "fresh" | "inherit";
  values: {
    inherit: { namespace: string; key: string }[];
    set: { namespace: string; key: string; value: JsonValue }[];
  };                                      // serialize selections; resolve them in child creation command
  produced?: number;                       // may reference result in owned conversation
  error?: string;
}
```

Planned = start; running = waiting; others terminal. Planned → running/failed/aborted; running →
terminal. `owns` identifies the child. Scalar initialization is precisely defined in §8.3.

```text
planned effect, ONE COMMAND:
  create child { parent history, owner:S, inheritValues:false }
  write selected initial values + overrides
  append prompt + create child's initial generation
  set S running { owns:child }
RETURN
```

No external action requires a fake inflight status here. The child's final-generation or stopping
post_tools settlement performs `finishOwnedConversation` in the SAME command:

```text
finishOwnedConversation(tx, child, outcome):
  if child.owner is absent: return
  S = read owner; require S owns child and is still running
  settle S with outcome/result entry reference
  // A foreground launching tool already exists in finishing, after:[S].
  // It is now eligible; no lost event or new task is required.
```

**Recovery:** a planned owner creates child once; a running owner starts nothing and returns.
Its child tasks carry all durable continuation. No waitFor or child-completion subscription needs
rebuilding. Completed result payload is not copied merely to settle the owner.

**Abort:** conversation cancellation already marked required child work in the same marking
command. Scheduler defers owner abort invocation until its marked owned descendants are terminal;
it does not hold an effect promise while they finish. Then settle S aborted. If a child is aborted
directly, its live owner is included for cancellation completion; a parent-side finishing tool
can subsequently report the child's aborted outcome when its drive scope runs. Background child
work is untouched by unrelated parent foreground cancellation.

### 3.14 Job

**Responsibility:** run/adopt a process with durable output, without keeping a foreground tool
alive unless that tool explicitly depends on it.

```ts
type JobStatus = "planned" | "spawning" | "running" | "exited" | "killed" | "lost";
interface JobState {
  command: string;
  logPath: string;
  pid?: number;
  processIdentity?: string;                 // host-specific adoption identity, not pid alone
  notBefore?: number;
  produced?: number;
  exitCode?: number;
}
```

Planned = start; spawning = inflight; running = waiting; others terminal. Planned → spawning/killed;
spawning → running/lost/killed; running → exited/lost/killed.

```text
effect:
  commit spawning with durable log/adoption location
  spawn/adopt through host process service
  commit running with process identity
  install exit/output observers; RETURN

exit observer:
  drain bounded output/checkpoints
  commit immutable job-result entry + usage if reported + settle exited
  a dependent tool.finishing becomes eligible through after
```

**Recovery:** spawning reconciles the uncertain launch through the host adoption identity; never
blindly spawn a second process. Running recovery, once after open, reattaches output/exit observers
if the same process is alive, otherwise records lost. A pid by itself is not proof of identity.
Exact durable adoption/exit-status capability is a host contract, pending finalization (§25).

**Abort:** when included by required foreground cancellation or whole-conversation shutdown,
stop the process through its service, drain output, write result and settle killed. A detached job
survives ordinary parent foreground abort and harness close. Explicit background shutdown/deletion
is conversation-scoped. Domain-specific process control is not a generic task-cancel endpoint.

A schedule uses planned/notBefore and, for repeated execution, a successor job created atomically
with the preceding outcome. The schedule definition must supply a finite/bounded recurrence policy;
there is no hidden recurring-work scheduler or task held across another job's lifetime.

### 3.15 Approval

**Responsibility:** hold a durable human decision. The waiting tool, not a promise, blocks its
exchange and sequential followers.

```ts
type ApprovalStatus = "pending" | "waiting" | "granted" | "denied" | "cancelled";
interface ApprovalState {
  tool?: number;
  prompt: string;
  produced?: number;
  decision?: JsonValue;
}
```

Pending = start; waiting = waiting; others terminal. Pending → waiting/cancelled; waiting →
granted/denied/cancelled.

```text
before_tool hold, ONE COMMAND:
  A = approval { for:tool, tool:tool.id, prompt }
  set tool waiting { approval:A, after:[A] }

approval.effect:
  commit waiting; publish human prompt through observation; RETURN

approve(A), ONE COMMAND:
  verify waiting and not marked
  record decision + settle A granted
  set matching waiting tool planned { approved:true }

deny(A), ONE COMMAND:
  record decision + settle A denied
  write matching tool's own blocked result + settle tool done
```

Decision commands identify the existing approval but are not cancellation APIs. If asynchronous
result hooks are required on denial, ready the existing tool's finishing phase with the decision
instead of invoking hooks on the line; that phase settles only that tool. This is the same durable
continuation pattern as subagent results.

**Recovery:** re-announce/reattach the human decision surface once; do not grant or rerun the tool.
**Abort:** record cancelled approval; the independently marked foreground tool writes its aborted
result. Denial/grant versus cancellation is decided on the line. Late/repeated decisions return the
existing outcome or a rejection; they never restart terminal work.

---

## 4. Journal, conversation state, read model

### 4.1 Journal records

```
ins_conv     { parent?: {conv, at?, asOf, inheritValues}, owner?, context: number[] }
set_conv     { id, patch }                                                     // inbox, label, queue modes
del_conv     { id }
ins_entry    { conv, kind, by?, callIndex?, through?, key?, meta, payload? }
ins_task     { conv, kind, at?, for?, after, state }
set          { id, patch }                                                     // tasks only
settle       { id, patch (status terminal) }                                   // tasks only; a task's result is an entry
ctx_append   { conv, ids }
ctx_replace  { conv, through, with, expectPrefixVersion }
ctx_reset    { conv, ids }
value_set    { conv?, workingScope?, namespace, key, value }
value_delete { conv?, workingScope?, namespace, key }                          // conversation deletion = tombstone
list_append  { conv?, workingScope?, namespace, key, value, tag? }
list_delete  { workingScope?, namespace, key }                                 // session/working lists only
scope_retire { workingScope }                                                 // MAIN-scope write
// usage(task, conv, usage) appends to the main session list pi.usage; no special storage verb
```
`parent.asOf` is a committed parent-history boundary; optional `at` records an entry-based selection.
Historical forks set `inheritValues: true`. Subagents set it to false and store selected initial
values as local writes (§8.3). Parent lineage and context inheritance do not imply value inheritance.
Value/list records are journal records, not transcript entries, and never implicitly enter context.

The command supplies final numeric seqs (§7); storage never remaps them. All scopes share one
session-global sequence space. Each admitted batch is contiguous; retained history and individual
physical files may have gaps after working writes/retirement. Backend encoding is private. JSONL
uses one complete line per commit in exactly one file; SQLite uses one transaction. Main-scope
history is retained for historical reads; obsolete working data need not be retained.

**Conversation state** (derived; in memory; in a table for SQLite):
```ts
interface ConversationState {
  id: number;
  commitEnd: number;                                 // last MAIN write affecting this conversation
  parent?: { conv: number; at?: number; asOf: number; inheritValues: boolean };
  // model, thinkingLevel and activeTools are conversation values (§5), not fields here
  inbox: InboxItem[];                                // write | steer | followUp | nextRun; each names stored content
  owner?: number;                                   // owning subagent task, absent on independent forks
  label?: string;
  context: number[];                                 // §6
  prefixVersion: number;                             // bumped by ctx_replace / ctx_reset only
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
}
```

### 4.2 Stored data and indexes

Storage exposes conversations, entries (including conv), tasks, values and lists. Scratch and usage
are uses of values/lists. It does not expose a parallel ReadIndex or a raw journal/payload API.
`Entry` includes its payload and the end seq of its creation commit, so entry-based forks need no
separate commit-boundary lookup. Conversation historical reads include their context list.

```text
current: conversations, tasks, session values/lists, working values/lists
history: entries, conversation versions/context edits, conversation value/list versions
indexes: by conversation/id; live tasks; owner/parent; value/list address + seq
```

Historical scalar/list lookup follows §5.3–§5.4. Index and payload layouts are backend choices;
these queries must use bounded indexed reads, not full-history scans. Main-history indexes may
reference retained records; never retain deleted working payloads just to preserve a dense array.
Shared SQLite containers prefix every key with session id. No closure table or journal prev pointers.

### 4.3 Storage interface and backends

Follow the existing lane Storage: one atomic commit, entity reads/scans, values/lists. No separate
scratch interface, raw-record reader, or public index layer. `Context` is the existing harness
invocation/cancellation context. Types below are proposed interfaces, not current package exports.

```ts
interface CommitResult { firstSeq: number; lastSeq: number }
interface HistoricalRead { asOf: number }             // complete MAIN commit boundary; 0 = empty
interface Scan {
  after?: number; before?: number;                    // exclusive id/seq bounds
  order?: "asc" | "desc"; limit: number;              // default asc; 1..10_000
}
interface ConversationScan extends Scan { parent?: number; owner?: number }
interface EntryScan extends Scan { conv?: number; kind?: string; key?: string; asOf?: number }
interface TaskScan extends Scan { conv?: number; kind?: string; live?: boolean }
interface ListReadOptions extends Scan { asOf?: number; stopAtTag?: string }
interface ListElement<T> { seq: number; value: T; tag?: string }
interface StoredValue<T> { value: T; seq: number }

interface Storage {
  readonly head: number;                              // highest committed GLOBAL seq, including working writes
  commit<Sc extends WriteScope>(writes: Write<Sc>[], context: Context): Promise<CommitResult>;
  getConversations(ids: number[], context: Context, at?: HistoricalRead): Promise<Map<number, ConversationState>>;
  scanConversations(query: ConversationScan, context: Context): Promise<ConversationState[]>;
  getEntries(ids: number[], context: Context): Promise<Map<number, Entry>>;
  scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
  getTasks(ids: number[], context: Context): Promise<Map<number, Task>>;
  scanTasks(query: TaskScan, context: Context): Promise<Task[]>;
  getValue<T>(address: Value<T>, context: Context, at?: HistoricalRead): Promise<StoredValue<T> | undefined>;
  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
  readList<T>(address: ValueList<T>, options: ListReadOptions, context: Context): Promise<ListElement<T>[]>;
  close(context: Context): Promise<void>;
}
```

Storage addresses include their bound conversation or working-scope identity (§5.6). Historical
reads apply to main conversation data only; session/working values expose current state. Current
multi-query snapshots use the session line. Every single logical query, including ancestor walks,
observes one committed state. Reads return immutable snapshots; callers cannot mutate owned data.
Filters precede limits. `stopAtTag` includes its matching element and never searches beyond limit.

```text
commit:
  validate one write scope: main OR one exact working id
  require final supplied seqs == head+1, head+2, ...; reject unsafe integers
  validate/prepare touched rows; persist one atomic batch
  publish rows/indexes/head together; only then resolve
  no callbacks, task handlers or plugin reducers inside storage

scope retirement in a MAIN commit:
  invalidate working data through the retirement seq atomically with sibling main writes
  physical cleanup may follow; cleanup failure does not undo the committed outcome

failure:
  pre-admission rejection → no changes or consumed seqs
  admitted persistence failure → fault; outcome may already be durable; reopen, never blind retry
close:
  seal admission; drain admitted persistence; release resources; retire no scopes
```

**Memory:** maps for current entities/scoped values/lists, ordered references for historical data.
Prepare only touched rows; publish synchronously without awaits/callbacks. Retirement drops current
working maps and releases obsolete payloads. Main history remains available. Binary-search ordered
value/list references; ancestor traversal costs fork depth, not unrelated session history.

**SQLite:** one transaction updates entities, historical versions, global head and any retirement.
Working value/list rows are ordinary scoped rows, not a journal of every old checkpoint.

```text
BEGIN IMMEDIATE
  validate supplied seqs against stored head
  apply entity/value/list writes and required history/index changes
  retirement: DELETE working scalar/list rows WHERE session_id=? AND scope_id=?
  advance global head
COMMIT
```

Use `(session, conv, address, seq)` historical indexes, `(session, workingScope, address, seq)`
working-list indexes, entity primary keys, live-task and conversation-owner indexes. Read compound
queries in one synchronous SQL read transaction; no awaits while holding it. WAL with
`synchronous=NORMAL` is the baseline. Rebuildable indexes are private, not another API contract.

**JSONL:** adopt the lane scoped-storage protocol described in
[`implementation-handoff.md`](mobile-handoff/01-harness/02-scopes/implementation-handoff.md).
That document is design evidence, not a claim that scoped storage is implemented in this tree.

```text
mainPath                         main entity/history commits + scope_retire records
mainPath.scopes/scope-<id>.scope  one named working scope, value/list commits only

commit:
  one session queue and global counter for BOTH kinds of file
  encode complete batch; writeAll to exactly ONE file, handling short writes
  publish in-memory state only after complete newline reached OS
  main retirement committed → serialize attempted unlink before later scope reuse
  failed unlink → old data still logically retired; retry cleanup on reopen

open:
  validate main/sidecar identity and complete transactions
  compute high-water mark from header + ALL complete main/sidecar records BEFORE cleanup
  find latest main retirement seq per working id
  retain only scoped writes newer than that retirement
  replay retained transactions in global order; preserve boundaries; reject duplicate/overlapping seqs
  discard only unterminated final transactions; malformed complete data fails open
  remove files containing no writes newer than their retirement
```

One batch has consecutive seqs, but files/history have legal gaps. Never use array position as a
seq. No per-scope counter, range reservation, cross-file acknowledgement, owner-derived sweeping,
or scope-creation transaction. First scoped write creates the sidecar atomically with a validated
header; names are encoded, fixed-prefix components, never raw paths. Follow the linked handoff's
Unicode/length validation and `.scope` layout so repository listing cannot mistake them for sessions.

Scopes are reusable. Retirement ends writes through its global seq, not every future use of the
name. A delayed unlink must never delete a later lifetime. Main compaction must retain retirement
boundaries while old physical files could otherwise become live. Repository deletion removes the
whole scope directory. Close/fault never retire. Main and sidecar complete writes provide process-
crash durability; power-loss durability/fsync is a separate explicit policy, not a cross-file protocol.

### 4.4 Memory

```ts
conversations: Map<id, ConversationState>      // live conversations only
tasks:         Map<id, Task>                   // live tasks, plus each conversation's newest generation (§8.1 reads it)
entries:       Map<id, Entry & { payload }>    // every id on a live conversation's context list
history:       LRU<id, payload>                // pages a UI asked for; bounded
```
This is **residency** and it is the same on every backend; it is not the read model (§4.2) and
does not depend on how the backend indexes. After each commit the harness keeps exactly the entries
some context list names and the tasks that are live or a newest generation, and drops the rest; a
commit that puts an old entry on a list (a fork) loads it first.
Objects are values (a write yields a new object). All reads are async; a hit is a microtask, a
miss uses the ordinary Storage entity/value/list reads. Execution residency is proportional to (live conversations ×
context size) + live tasks, plus the currently needed settings. Active plugin replicas additionally
hold their current state and tracking data; they do not retain every historical state revision.
The process's total memory also includes retained main history/indexes on memory/JSONL, live working
scope contents, bounded query/cache state on SQLite, and active dependency metadata. A bounded execution working set is not a claim of bounded
total process memory on memory/JSONL.

---

## 5. Typed values, lists and plugin state

### 5.1 Bound addresses

Keep the old harness's typed bound-address approach: namespace and optional key are bound once;
subsequent operations take that address, not another string key. Scope and kind are part of its
TypeScript type. No registration, declaration merging, runtime token catalog, or per-write rewind
flag is required. `declareVar` is replaced by these constructors:

```ts
const model = conversationValue<ModelIdentity>("pi.model");
const thinkingLevel = conversationValue<ThinkingLevel>("pi.thinking");
const activeTools = conversationValue<string[]>("pi.active-tools");
const planMode = conversationValue<boolean>("my-plugin.plan-mode");
const moves = conversationList<Move>("my-game.moves");

const sessionName = sessionValue<string>("pi.session.name");
const entryLabel = (id: number) => sessionValue<string>("pi.entry.label", String(id));
const requestInput = (requestId: string) => sessionValue<number>("pi.request-input", requestId);

await conv.setValue(planMode, true);
const enabled = await conv.getValue(planMode) ?? false;
await conv.deleteValue(planMode);
await conv.appendList(moves, move);
await harness.setValue(entryLabel(42), "before migration");
```

Namespace must be non-empty; namespace/key cannot contain NUL; the empty key is legal. Equal
(scope, kind, namespace, key) tuples name the same address within the receiver's scope. `pi` and
`pi.*` are reserved for core. Constructing the same address with incompatible value types is a
programming defect, not a reason for a runtime registry. Value types are determined by the address
(`NoInfer<T>` on writes); wrong scope, wrong kind and wrong value type are compile-time errors.
Defaults belong in caller code, not token definitions. Stored payloads are JSON values.

### 5.2 Scope and atomic writes

- **Session values:** latest value only through the public API; setting replaces and deletion
  removes. Session name, entry labels and request identities do not change on rewind or fork.
  Their journal records remain durable; the current-value index needs only the latest set's seq.
- **Session lists:** current append/page/delete semantics; no rewind or fork inheritance. Usage
  is a main session list. Working lists use the same operations with explicit lifetime (§5.6).
- **Conversation values:** each set appends an immutable version at its journal seq. Deletion
  appends a tombstone that masks both earlier local and inherited versions. JSON `null` is a value,
  not deletion. Historical reads select a complete commit boundary.
- **Conversation lists:** each append writes one immutable sequenced element. No per-element
  update, insertion or deletion. Forks share prefixes; they do not truncate parent lists (§5.4).

Model identity, thinking level and active tool names are ordinary rewindable conversation values,
not sticky configuration fields. Root creation writes their initial values in its creation command;
subagent initialization supplies its selected settings (§8.3). Generations capture the effective
settings they use; later setting changes do not rewrite an already-created generation.

Convenience setters issue one command each. Read-modify-write uses the serialized command line:

```ts
await conv.command(async (tx) => {
  const todos = await tx.getValue(todoBoard) ?? [];
  tx.setValue(todoBoard, [...todos, newTodo]);
});
```

Reads use the pre-command committed view (§7); buffered writes apply in order at commit. A bound
conversation command supplies its conversation id for conversation-address operations. The
session-level command uses an explicit conversation id, allowing input creation, request mapping,
child creation and initial values to commit atomically. Value/list writes never select transcript
content or trigger generation by themselves.

### 5.3 Historical scalar lookup

Only local versions are stored. To read address K in conversation C through boundary U:

1. Seek the newest local version of K with `seq <= U`.
2. A set returns its value; a tombstone returns absent and MUST NOT fall back to the parent.
3. If no local version exists, stop if C has no parent or `parent.inheritValues` is false.
4. Otherwise continue in the parent with `U = min(U, parent.asOf)`.

For example, A writes false at 40 and true at 80; B forks A through commit 60. B reads false.
Parent writes after 60 never leak into B, including through further nested forks. A local deletion
in B masks false; a later local set recreates the value only in B's history.

**Memory/JSONL:** map conversation and address to an ordered array of version references; binary
search the cutoff. References point to journal records rather than copying payloads. Parent lookup
is a map lookup. Worst case is one binary search per ancestor, not a scan of journal history.

**SQLite:** use the `value_versions` primary key (§4.2), one indexed seek per ancestor:

```sql
SELECT seq, deleted
FROM value_versions
WHERE conv = ? AND namespace = ? AND key = ? AND seq <= ?
ORDER BY seq DESC
LIMIT 1;
```

Fetch the winning version's payload by its indexed reference (or directly from that version row). Parent metadata is a point read and may be
cached for active conversations. No copied inventory, ancestor-closure table or recursive journal
scan is required. The baseline cost depends on fork depth; it is not constant-time. Query-plan
tests must show indexed searches without a temporary ordering b-tree.

### 5.4 Historical lists and paging

```ts
const page = await conv.readList(moves, { after: cursor, asOf, limit: 100 });
// [{ seq, value }, ...], oldest first; continue with the last returned seq
```

`after` is exclusive; `asOf` is an inclusive committed boundary. Omit `asOf` for the latest boundary
at that read; pass a fixed boundary across pages for a stable historical read. Limits are positive,
bounded, and required in this API sketch. A cursor is a sequence filter for the same conversation
and address, not a replication revision or a transferable replica binding.

Traverse the same parent chain, carrying the minimum cutoff at every boundary, and read ranges
oldest ancestor first. A historical fork sees its ancestor's visible prefix followed by its own
appends. Subagents stop value/list traversal at their initialization boundary (§8.3). Descendants'
local writes follow their inherited prefixes in journal order, so concatenating these ranges needs
no global sort or copying. Skip ranges outside the requested cursor/cutoff and stop when the page
limit is filled.

Memory/JSONL binary-search each local element array. SQLite uses `list_elements` with equality on
conversation/address, `seq > after AND seq <= cutoff`, `ORDER BY seq ASC LIMIT remaining`, then
fetches only those element payloads. An ordered-index outer loop plus addressed payload lookups
must not become a journal scan or temporary sort. Baseline traversal has fork-depth overhead plus
indexed reads of the requested elements, not work proportional to unrelated history.

### 5.5 Checkpoints and replicated state

Plugins own their delta shapes, reducers, validation and checkpoint cadence. A checkpoint is an
ordinary rewindable value; it contains the state and the last included list-element seq:

```ts
const checkpoint = conversationValue<{ through: number; state: CanvasState }>("my-canvas.checkpoint");
const deltas = conversationList<CanvasDelta>("my-canvas.deltas");
```

Hydration reads the checkpoint visible at the target, then pages visible deltas after `through`.
Checkpoint and delta writes that belong together share a command. An active wrapper retains the
current state so ordinary updates do not replay history on every write. Reopen and rewind reconstruct
from the selected checkpoint and suffix, without inverse operations. Checkpoint cadence bounds the
replay suffix only when maintained across the inherited history, not merely counted anew per child.
Checkpoints do not authorize deleting older deltas while arbitrary rewind is promised.

Replication is a layer over these values/lists, not another durable store (§9.1). A task is needed
only for an actual lifecycle; plugin state alone does not create one.

### 5.6 Named working scopes

History scope (session/conversation) and working lifetime are distinct concepts. Working addresses
are session-owned, durable until explicitly retired, and never inherit/rewind. Use a named group,
not a boolean retention hint, so related checkpoints/memos can commit and retire together.

```ts
interface MainScope { readonly kind: "main" }
interface WorkingScope { readonly kind: "working"; readonly id: string }
type WriteScope = MainScope | WorkingScope;
declare function workingScope(id: string): WorkingScope;

declare const valueType: unique symbol;
declare const addressScope: unique symbol;
declare const writeScope: unique symbol;
interface Value<T, Sc extends WriteScope = WriteScope> {
  readonly kind: "value";
  readonly scope: "session" | "bound-conversation" | "working";
  readonly namespace: string; readonly key: string;
  readonly conv?: number; readonly workingScope?: string;
  readonly [valueType]?: (value: T) => T;               // invariant value type
  readonly [addressScope]?: () => Sc;                  // covariant scope for reads
}
interface ValueList<T, Sc extends WriteScope = WriteScope> extends Omit<Value<T, Sc>, "kind"> {
  readonly kind: "list";
}
// Write<Sc> is the §4.1 tagged union, with final seq and this invariant phantom:
interface ScopedWrite<Sc extends WriteScope> {
  readonly seq: number;
  readonly [writeScope]?: (scope: Sc) => Sc;
}
type SessionValue<T> = Value<T, MainScope> & { readonly scope: "session" };
type SessionList<T> = ValueList<T, MainScope> & { readonly scope: "session" };
interface ScalarSelection {
  readonly scope: "conversation"; readonly kind: "value";
  readonly namespace: string; readonly key: string;
}
interface ConversationValue<T> extends ScalarSelection {
  readonly [valueType]?: (value: T) => T;
}
interface ConversationList<T> extends Omit<ConversationValue<T>, "kind"> { readonly kind: "list" }
interface InitialValueWrite { address: ScalarSelection; value: JsonValue }
declare function conversationValue<T>(namespace: string, key?: string): ConversationValue<T>;
declare function conversationList<T>(namespace: string, key?: string): ConversationList<T>;
declare function sessionValue<T>(namespace: string, key?: string): SessionValue<T>;
declare function sessionList<T>(namespace: string, key?: string): SessionList<T>;
declare function setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): InitialValueWrite;
declare function value<T>(namespace: string, key?: string): SessionValue<T>;
declare function value<T>(namespace: string, key: string, scope: WorkingScope): Value<T, WorkingScope>;
declare function list<T>(namespace: string, key?: string): SessionList<T>;
declare function list<T>(namespace: string, key: string, scope: WorkingScope): ValueList<T, WorkingScope>;
```

`sessionValue`/`sessionList` are explicitly named main-session constructors. Conversation tokens
bind a conversation at the harness boundary; the backend receives a numeric conv on the address.
Only main addresses may carry conv. Equal scope id + namespace/key + kind means equal address;
object identity does not matter. Retention information is stored, not reconstructed from tokens.

```ts
const work = workingScope(String(taskId));
const frames = list<AssistantMessageFrame>("pi.pending.frames", "", work);
const memo = value<JsonValue>("pi.pending.memo", "step", work);

await harness.command(work, tx => {
  tx.appendList(frames, frame);
  tx.setValue(memo, checkpoint);
});

// After sealing/draining that invocation's progress:
await harness.command(tx => {
  const resultId = tx.entry(convId, "tool_result", meta, result);
  tx.settle(taskId, { status: "done", state: { produced: resultId } });
  tx.retireScope(work);                              // MAIN write, not a direct working delete
});
```

All writes in a command are main OR one working id. Type invariance rejects main+working mixes;
a runtime check rejects two different working ids (their static tag is identical). Main commands
may retire multiple working scopes. Reads may use either lifetime; only writes are restricted.
Never mix a direct working append/set/delete with an entity settlement, even on SQLite.

Retirement is the sole storage authority: no task-name parsing, missing-owner heuristic, TTL or
implicit cleanup at close. Reusing a scope after retirement is legal. Harness invocation fencing
must prevent a late progress job from accidentally becoming that new lifetime. State coordinating
a task transition remains main-scoped; only independently committed working data goes in the scope.
A typed address alone does not make a cross-scope atomic update possible.

---

## 6. Context

### 6.1 The list and its three ops

`context: number[]` on the conversation state. Edited only by:
- `ctx_append { ids }`: emitted by the insert of a `select` kind, in the same command, in
  transcript order. Never called directly.
- `ctx_replace { through, with, expectPrefixVersion }`: remove the prefix up to and including
  entry `through`, put entry `with` (a summary) at the head. Rejected if `prefixVersion` moved.
- `ctx_reset { ids }`: replace the whole list with a bootstrap: `[]` (a user's `/clear`: waits for
  input), a `user` handoff requested by `new_context` (post_tools resets and creates its generation),
  or a `summary`-kind note. Reset alone never requests generation.

Both `replace` and `reset` bump `prefixVersion`; `append` does not. Consequently the list always has
the shape **[head?, then selected entries in transcript order]**, and a summarization that started
earlier survives appends (they land after `through`) but is rejected by a competing replace or
reset. Validation (§7.2) checks, on every `ctx_*` op, that every id exists in this conversation or
in the inherited prefix, that the resulting list has that shape, and that `through` does not split
an exchange: no `tool_result` after `through` may answer an assistant entry at or before it.
The context as of an earlier commit is reconstructed by replaying `ctx_*` records (§6.6).

### 6.2 Summaries and handoffs

A `summary` entry is appended by the `collapse` task and carries `through`. A handoff is a `user`
entry appended by post_tools for the model's `new_context` call and selected by `ctx_reset`. Both
are ordinary transcript entries at their append position; their place *in the context* is the
head. UIs draw a summary immediately after its `through` (so retained turns follow it) and a
handoff at its own position (§9.2).

### 6.3 Boundaries

```text
provider request: generation task exists; no unresolved foreground calls
replace/reset: canEditContext (§8.1), checked at committing boundary
historical fork: safe source boundary; subagent capture is separate (§8.3)
queued write: safe message boundary; never splice into an open tool exchange
```

Pending/retry-waiting generation may permit edits, never duplicate generation. Settlements complete
exchanges, including required error results. `through` must not split an exchange; reset drops
whole exchanges. Empty/note-only resets create no work.

### 6.4 Projection

```
messages := for each id in conv.context: entries[id].kind.project(entry)      (tool results ordered by callIndex within their message)
         then before_request hooks edit the request
```
Nothing else. Projections never write.

### 6.5 Collapse policy

```text
generation.pending, before provider intent:
  if captured collapseId exists: observe that task; do not recreate it
  else if usage > threshold × contextWindow and more than keepRecent turns remain:
    decide before_collapse outside line; revalidate context inside line
    if approved: commit collapse task + generation.after=[collapse] and captured reason
    RETURN; generation stays pending and scheduler waits for its dependency
  build request from resulting context
  commit streaming intent → call provider

provider overflow:
  decide collapse outside line; revalidate before outcome commit
  commit attempt usage + generation.retry_wait + collapse task/id together
  existing generation waits for that collapse, then retries once
  declined/impossible/failed overflow collapse → fail existing generation; no replacement

manual collapse: create collapse task only; does not request generation
collapse success: commit summary entry + ctx_replace + usage + terminal collapse
```

The id is a specific task dependency, not a progression flag. Driver can run collapse while its
generation waits; reopen observes the same task. Retry timers never bypass unfinished dependencies.
Threshold decline proceeds with existing generation, not another conversation check. Threshold
collapse failure proceeds with unchanged context; overflow collapse failure ends the generation.
Summary captures `through` and `prefixVersion`, includes the previous summary, and subsumes it.

### 6.6 Context as of a commit

```text
contextAsOf(conv, asOf):
  require complete commit boundary, with conv already created
  base = newest ctx_reset <= asOf, otherwise conv's ins_conv
  context = copy(base.ids or base.context)                 // inherited initial context included
  page context_ops in (base.seq, asOf], oldest first:
    ctx_append: append ids
    ctx_replace: replace prefix through named entry; retain EXISTING suffix
    ctx_reset: replace entire list
  return context
```

Replacement is not a full checkpoint: `[u1,a1,u2,a2] → [summary,u2,a2]` retains u2/a2 although their
appends preceded replacement. Indexed baseline replay excludes unrelated history but may span the
conversation since creation/reset. Compaction-bounded reconstruction remains an optimization to
review. Current context is a materialized point read; plugin hydration uses value/list indexes.

---

## 7. The line

One command queue per session. `session.command(build)` (exposed to task handlers as
`ctx.commit(build)`) runs the callback with a command-local buffer and the previous command's
committed view. Reads may be async; no other command runs until this one finishes.

The buffer starts its sequence counter at the last committed seq + 1. Adding a record mints its
seq immediately and advances that counter. Creation methods return the seq as the new object's id;
later records use it directly. These methods only build the command: they perform no storage write
and publish no state.

```ts
interface ValueReader {
  getValue<T>(address: Value<T>): Promise<T | undefined>;
  readList<T>(address: ValueList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
}
interface ValueCommand<Sc extends WriteScope> extends ValueReader {
  setValue<T>(address: Value<T, Sc>, value: NoInfer<T>): number;
  deleteValue<T>(address: Value<T, Sc>): void;
  appendList<T>(address: ValueList<T, Sc>, value: NoInfer<T>, tag?: string): number;
  deleteList<T>(address: ValueList<T, Sc>): void;          // reject historical conversation-list deletion
}
interface WorkingCommand extends ValueCommand<WorkingScope> {}
interface EntryOptions { by?: number; callIndex?: number; through?: number; key?: string }
interface TaskOptions { for?: number; at?: number; after?: number[] }
interface Command extends ValueCommand<MainScope> {
  readonly view: ConversationView;                      // committed pre-command reader
  conversation(options: Pick<ConversationState, "parent" | "owner" | "context">): number;
  setConversation(id: number, patch: Partial<ConversationState>): void;
  deleteConversation(id: number): void;
  entry(conv: number, kind: string, meta: JsonObject, payload?: JsonValue, opts?: EntryOptions): number;
  task(conv: number, kind: string, state: JsonObject, opts?: TaskOptions): number;
  set(id: number, patch: TaskPatch<string, JsonObject>): void;
  settle(id: number, patch: { status: string; state?: JsonObject }): void;
  ctxReplace(conv: number, through: number, withId: number, expectPrefixVersion: number): void;
  ctxReset(conv: number, ids: number[]): void;
  retireScope(scope: WorkingScope): number;              // always a MAIN write
  usage(taskId: number, conv: number, usage: Usage): number; // session-list append convenience
  bindValue<T>(conv: number, address: ConversationValue<T>): Value<T, MainScope>;
  bindList<T>(conv: number, address: ConversationList<T>): ValueList<T, MainScope>;
}
```

Bound `conv.command` supplies conversation-token reads/writes without repeating conv. Main command
reads can inspect working values; its writes cannot directly change them. WorkingCommand exposes
only value/list writes, and runtime validation pins all writes to the supplied working id.

```ts
await ctx.commit((tx) => {
  const assistantId = tx.entry(convId, "assistant", meta, { message }, { by: generationId });
  const calls = message.content.filter(block => block.type === "toolCall");
  const toolIds: number[] = [];
  for (const [callIndex, call] of calls.entries()) {
    toolIds.push(tx.task(convId, "tool", {
      status: "planned", callIndex, callId: call.id, name: call.name,
      args: call.arguments, allowed: activeToolNames.includes(call.name), replay: "never",
    }, {
      for: generationId, at: assistantId,
      after: sequential && toolIds.length ? [toolIds[toolIds.length - 1]!] : [],
    }));
  }
  const postTools = tx.task(convId, "post_tools", { status: "pending", generation: generationId }, {
    for: generationId, at: assistantId, after: toolIds,
  });
  tx.usage(generationId, convId, message.usage);
  tx.settle(generationId, { status: "done", state: { produced: assistantId, calls: toolIds, postTools } });
  tx.retireScope(workingScope(String(generationId)));
});
```

`entry` for a selected kind also buffers its `ctx_append` immediately, with its own seq (§6.1).
Callers neither append it themselves nor calculate offsets around it. All methods use the same
counter, including patches and context operations; ids require no `{ref}` placeholders, reserved
ranges, deep traversal, or fix-up pass.

Normal callback return commits the buffer; returning without adding records is a no-op. A throw
or validation rejection discards the whole buffer without advancing the committed sequence. Minted
ids MUST NOT be published or used for external effects before the command succeeds. The command
object is valid only during its callback; it cannot be retained to add records later.

After the callback returns, the line loads the rows the records target, validates them in order
against committed state plus earlier records in the buffer (§7.2), and appends the whole buffer as
one atomic commit. Storage verifies the supplied seqs are contiguous and start immediately after
its global committed head; it never renumbers them. Storage publishes its read model as part of commit
(§4.3), not via a second harness write. The line then updates execution residency (§4.4), delivers
to listeners, and resolves `true` (`false` for a no-op). A storage failure faults
the session (§7.3); reopening derives the next seq from the last complete durable commit. Sequence
exhaustion rejects rather than allocating an unsafe integer. Nothing else writes the journal.

### 7.1 Guarantees
1. No two commands interleave; a callback sees the previous command's committed state.
2. A caller resolves after delivery; a listener sees the state its records describe; a listener
   MUST NOT await a command on the same session inside its callback; a throwing listener is
   reported as `handler_error` and does not affect the commit.
3. Terminal settlement seals/drains working writes, then commits outcome + scope retirement together.
   Physical unlink follows; no task-status-based orphan inference exists (§3.5).
4. A completed task and its successors commit together; no later driver/event pass must create them.

### 7.2 Validation (rejects the whole commit)
- `ins_entry`: the conversation exists; `through` (if any) is an entry of it.
- `ctx_replace` / `ctx_reset`: the resulting list (§6.1) has the head+ordered-suffix shape; `through`
  does not split an exchange; `expectPrefixVersion` matches.
- `ins_task`: conversation exists; optional at belongs to it or its inherited prefix; for is valid;
  initial status is allowed; after targets exist in the same ownership tree and are acyclic.
- Every command writes main OR one working id. Main retirement is the sole cross-lifetime action;
  it retires logical scope contents without requiring a second-file transaction.
- `set`/`settle`: target exists; keys are the kind's; a status change is an allowed transition;
  `settle` reaches a terminal status; a terminal task accepts no patch.
- `ctx_*`: every id exists in this conversation or its inherited prefix.
- Conversation value/list writes: the target conversation exists, including when created earlier
  in the same command. Parent history boundaries are complete commits; a historical fork's
  inheritance link and a subagent's independent initialization survive reopen unchanged.
- `del_conv`: ownership subtree has no live tasks; cancellation was driven before deletion.
  Retain immutable history required by independent forks; reject new work in deleted conversations.

### 7.3 Faults
A failure after a plan's decision faults the session: later commands reject; the process should
exit and reopen. Rejections (§19) are not faults.

---

## 8. Conversations and admission

### 8.1 Context editing is not scheduling

Scheduler, drive scopes and cancellation are defined only in §3.6–§3.8.

```text
canAcceptNow = no foreground work and no outstanding cancellation (§3.4)
canEditContext = no streaming/polling request and no unresolved call in the current exchange
```

Pending post_tools blocks acceptance, even after all calls settled. Pending/retrying/deferred
generation can permit safe edits but never another generation. A held call blocks replacement/reset.
Background jobs do not block edits. Context-only writes never become generation requests on open.

### 8.2 Acceptance and the chain

```text
idle accept, ONE MAIN COMMAND:
  place eligible queued content + input in selected admission order; dequeue
  capture settings; create pending generation
  write optional external request mapping

busy/cancelling accept, ONE MAIN COMMAND:
  store unselected input + queue followUp
  write optional external request mapping
```

Acceptance starts no provider effect. The chain is generation → tools + post_tools → next generation
(§3.9–§3.11). Each tool settles only itself. The join exists before any call starts; the last tool
merely makes it eligible. Post_tools and final-answer generation own exchange/turn-end decisions.

### 8.3 Subagents and jobs

A subagent is a `subagent` task with `owns`. Its creation is **initialization**, not historical
value inheritance: the creating tool chooses scalar addresses to copy and typed overrides. Context
inheritance is independent. Public API sketch:

```ts
await conv.spawn({
  prompt: "inspect the parser",
  context: "inherit",
  values: {
    inherit: [model, thinkingLevel],
    set: [setValue(activeTools, ["read", "grep"])],
  },
});
```

`setValue(address, value)` here constructs a typed initial write; it does not commit independently.
There is no universal `inherit` flag on a token: one tool may need a value another must exclude.
Common selections are ordinary arrays of typed addresses, not a registry. Selection is scalar-only;
canvas/game lists are not implicitly copied into subagents.

Inside one serialized creation command, capture the parent boundary, read selected effective
values, create the child with `owner` and `parent: {conv, at?, asOf, inheritValues: false}`, write the selected
present values and overrides, insert the prompt AND its initial generation task, and mark the
owner task `running` with `owns`.
An absent selected value stays absent unless overridden. Copy values, not mutable object aliases.
Only the resulting local values are stored, not token objects or a durable selection policy.
The child cannot drive before this command commits. It has no parent value/list fallback: plan
mode and plugin state not selected are absent even when its context was inherited. Model, thinking
level and tool names become ordinary rewindable local values. A later historical fork of the child
inherits these values normally and stops at the child's independent initialization boundary.

The child gets an empty or inherited context per `context: "fresh" | "inherit"`. Initialization may
happen while the parent runs; an inherited context must end at a complete exchange and does not edit
the parent's context. The exact context-capture policy for an executing parent remains under review
(§25). The child finishing command settles its owner (§3.13). A foreground tool is already parked
in finishing with after:[owner]; it becomes eligible without a waitFor promise. Background launch
settles the tool with the id immediately. Job behavior is defined in §3.14.

### 8.4 Forks and rewind

A historical fork records `parent: {conv, at?, asOf, inheritValues: true}`. It inherits **all**
conversation values and lists visible at that boundary; no per-token filter applies. Fork creation
copies neither value inventories nor list prefixes. Local writes override inherited scalars, and
local list appends follow inherited prefixes (§5.3–§5.4). Session values remain session-wide.

A target may be `{ at: entryId }` or `{ asOf: commitEndSeq }`. Entry selection resolves to the commit
boundary that **contains** the entry, so a tool result and active-tools update in the same command
are inherited together. An explicit commit target supports moves or canvas changes that contain
no message entry. A seq inside a commit is rejected, not rounded to a partially visible state.

With inherited context, copy the parent's context as of the selected boundary (§6.6); for an
entry selection, also restrict to the selected entry position as in the original fork contract.
Trim to the last complete exchange. The fork evolves independently of later parent edits.
Historical forks inherit context/values, not live tasks. Continuing requires explicit generation-task
creation or acceptance; driving copied user-ended context must not infer work.

Unless keepRunning, `rewind` aborts/drains current conversation foreground work before creating
the fork. It does not selectively cancel graph nodes by at. keepRunning leaves the source chain
untouched. Entry/commit targets select inherited history, not cancellation membership. `/tree`
lists by parent and distinguishes independent forks by absent owner.

### 8.5 Open, resume, close, delete

- `open`: conversation states, live tasks, the entries on live conversations' context lists, scratch
  of live tasks. Start nothing; report live tasks by role.
- `drive(opts)`: schedule the selected ownership scope; session drive covers all trees (§3.8).
- `abort(conv)`: mark foreground targets and drain eligible queues once (§3.7).
- `close()`: seal admission, signal executions, drain persistence; retire/settle nothing.
- `shutdown(conv)`: conversation cancellation including background work.
- `delete(conv)`: report work; on confirm, shutdown/drain ownership subtree, then del_conv.
  Retain history needed by independent forks; physical repository deletion is separate.

---

## 9. Observation

### 9.1 Watch

`watch(conv, { limit })` runs on the line: it registers the listener and reads the base in one
step, so there is no gap. Base:
```
{ asOf: seq,
  conversation: ConversationState,                        // includes context and prefixVersion
  entries: [ last `limit` transcript entries in transcript order, with payloads ],
  tasks:   [ live tasks ],
  scratch: { [taskId]: reduced } }
```
Then deliver relevant main writes in commit batches, retaining each write's seq (`ins_entry`,
`ins_task`, `set`, `settle`, `set_conv`, context/value/list edits and scope retirement; owned
conversations if requested). Usage is a main-list append. Working progress is delivered as a preview,
and ephemeral deltas `{ frame | progress | kind-emitted, taskId }`, plus `quiescent` and `fault`.
Older pages: `entries(conv, { before, limit })`, each with its own `asOf`; the client ignores stream
records with `seq ≤ asOf` for entries it paged in. Remote clients RPC into the host, so the same
one-step base applies to them.

**Replicated plugin state** is a wrapper over conversation checkpoints and delta lists (§5.5),
exposing Chord's `ReplicatedState<T>` read surface. Persistence and conversation identity remain
Pi/application concerns, not Chord concepts.

- **No durable replication revisions.** Storage records only journal seqs. At fresh hydration,
  the adapter establishes stream revision 0, then numbers emitted update batches 1, 2, 3, ….
  Journal updates at 104 and 117 can therefore be stream revisions 1 and 2. Chord's consecutive
  revision check remains unchanged; no stored `stateSequence` or second allocation index exists.
  The adapter retains the journal cutoff for catch-up independently of the live stream counter.
- **Commit before publication.** Read the current committed state and derive/validate changes on
  the line; buffer delta/checkpoint writes; commit; then publish the corresponding state before
  the next command runs. Concurrent updates cannot compute from the same stale base. A failed
  command publishes nothing and its private draft must not contaminate a subsequent update.
  Retain the current committed state while active; hydration is not repeated per write.
- **Hydration and binding.** Read the visible checkpoint and delta suffix, capture the journal
  boundary and register update capture in one line step. On rewind, reconstruct the selected
  history, invalidate the old binding, hydrate the new one and restart its live counter. Reject
  deliveries from retired bindings. A periodic checkpoint does not by itself restart an existing
  replication stream or require a client-visible update when the state is unchanged.
- **Actual Chord boundary.** `replicatedState(initial)` exposes tracked `.state`, published `.value`
  and synchronous `.publish(context)`; its public subscription delivers complete values. Its
  decoded-operation subscription and producer registration are private. Moreover, subscribing to
  a producer or its service can flush pending mutations. Therefore mutating an exposed producer
  and then awaiting storage is NOT a safe persistence adapter. Draft tracking must remain private
  until commit; the exact supported Chord adapter seam is still to be designed (§25).
- **Delta ownership and encoding.** Chord Delta publicly supplies `track`, `apply`, `applyImmutable`,
  `encoder` and `decoder`. Decoded `Op[]` carry complete paths; compressed `WireOp[]` may depend on
  prior path definitions. A complete replacement resets those dictionaries. Arbitrary wire batches
  cannot be independently replayed or spliced across histories without their matching codec state.
  Durable encoding and codec handling at checkpoints/forks remain an explicit design choice (§25),
  not something list storage infers. Mutable replay must own its payloads; it must not mutate the
  authoritative in-memory journal. Immutable application shares unchanged subtrees but copies
  changed-path containers, whose cost can depend on container size.

The wrapper owns checkpoint cadence and state/batch bounds. Rewind reconstructs; it does not send
inverse operations. Historical data cannot be pruned merely because a newer checkpoint exists.

### 9.2 Rendering

Transcript order, with one rule: a `summary` is drawn immediately after its `through` (at the top
of the loaded page if `through` isn't loaded); everything else where it is. The context list marks
what the model sees (dim the rest).
A client-side `toLaneSnapshot(base)` (transcript, streaming message from the generation's reduced
scratch, running tools from live tool tasks, queues from the inbox) serves renderers that want the
old shape.

### 9.3 Events

Subscriptions over journal records by kind and transition; no separate event vocabulary.

---

## 10. Hooks

Points and decisions: `before_request` (edit), `after_response` (observe), `before_tool`
(`allow | block(text) | hold`), `after_tool`, `on_yield` (`pass | continue(message)`),
`before_collapse` (`decline | {meta}`). `hooks.on(point, handler, { priority })`, ascending; first
`block`/`hold`/`decline` wins; first `continue` wins. Hooks own no state.

---

## 11. Concrete task index

§3 is the authoritative task contract; this index introduces no second lifecycle definition.

| Task | Responsibility | Durable continuation |
|---|---|---|
| generation (§3.9) | provider response/retry/poll | tools + post_tools, or final boundary |
| tool (§3.10) | one call and own result | no sibling/turn orchestration |
| post_tools (§3.11) | join calls, apply exchange policy | next generation or finish |
| collapse (§3.12) | summarize and safely replace prefix | existing generation becomes eligible |
| subagent (§3.13) | own child conversation | child terminal command settles owner |
| job (§3.14) | spawn/adopt process, observe exit | dependent tool or scheduled job |
| approval (§3.15) | human decision | resume/finish existing tool |

`new_context` is a tool outcome, not another task kind: the tool stores handoff intent; post_tools
appends the handoff, resets context and creates the next generation atomically.

---

## 12. Public API and usage

### 12.1 Shared types and host services

```ts
type AgentInput = string | UserMessage | readonly AgentMessage[];
interface ModelIdentity { provider: string; modelId: string }
interface RetryPolicy { maxAttempts: number; baseDelayMs: number }
interface CollapsePolicy { threshold: number; keepRecent: number }
interface GenerationSettings {
  model: ModelIdentity;
  thinkingLevel: ThinkingLevel;
  activeToolNames: string[];
  toolOrder: "parallel" | "sequential";                  // creates after edges; not a scheduler lock
  streamOptions: JsonObject;
  retry: RetryPolicy;
}
interface DriveOptions { pollDeferred?: boolean }
type DriveOutcome = "idle" | "suspended" | "closed";
interface Inspection { start: Task[]; inflight: Task[]; waiting: Task[] }
interface Accepted { entryId: number }
interface AbortReport { drained: InboxItem[] }
type HistoryTarget = { at: number } | { asOf: number };
interface TaskServices {
  models: Models;
  tools: ReadonlyMap<string, Tool>;
  hooks: Hooks;                                         // typed points in §20
  resources: ReadonlyMap<string, unknown>;               // host capabilities; checked by consuming kind
  retry: RetryPolicy;
  collapse: CollapsePolicy;
}
interface SpawnOptions {
  prompt: AgentInput;
  context: "fresh" | "inherit";
  values: { inherit: readonly ScalarSelection[]; set: readonly InitialValueWrite[] };
}
interface RegisteredKind { readonly kind: string }       // opaque result of validated registration
declare function defineTask<S extends string, D>(definition: TaskDefinition<S, D>): RegisteredKind;
interface HarnessOptions extends TaskServices {
  initial: GenerationSettings;
  kinds: readonly RegisteredKind[];
  systemPrompt: string | (() => string | Promise<string>);
}
```

`RegisteredKind` is the validated/erased registration returned by defineTask/defineContent; each
constructor preserves its schema's state/status typing. This is not an arbitrary object registry
for values. Provider option patching and process-adoption capabilities remain host seams (§25).

### 12.2 Harness and conversation

```ts
interface ConversationView {
  state(): Promise<ConversationState>;
  entry(id: number): Promise<Entry | undefined>;
  task(id: number): Promise<Task | undefined>;
  entries(query: Omit<EntryScan, "conv">): Promise<Entry[]>;
  tasks(query: Omit<TaskScan, "conv">): Promise<Task[]>;
  getValue<T>(address: ConversationValue<T>, at?: HistoricalRead): Promise<T | undefined>;
  readList<T>(address: ConversationList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
}
interface ConversationCommand {
  readonly view: ConversationView;
  getValue<T>(address: ConversationValue<T>): Promise<T | undefined>;
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): number;
  deleteValue<T>(address: ConversationValue<T>): void;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>, tag?: string): number;
  readList<T>(address: ConversationList<T>, options: ListReadOptions): Promise<ListElement<T>[]>;
  entry(kind: string, meta: JsonObject, payload?: JsonValue, options?: EntryOptions): number;
  task(kind: string, state: JsonObject, options?: TaskOptions): number;
  set(id: number, patch: TaskPatch<string, JsonObject>): void;
}
interface Conversation extends ConversationView {
  readonly id: number;
  accept(input: AgentInput, options?: { requestId?: string }): Promise<Accepted>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  prompt(input: AgentInput, options?: { requestId?: string }): Promise<AssistantMessage | undefined>;
  result(inputId: number): Promise<InputResult>;          // contract still open in §18.2
  appendMessage(message: AgentMessage): Promise<number>; // context only, deferred if unsafe
  steer(input: AgentInput): Promise<number>;
  followUp(input: AgentInput): Promise<number>;
  nextRun(input: AgentInput): Promise<number>;
  cancelQueued(id: number): Promise<"cancelled" | "already_consumed" | "not_found">;
  abort(): Promise<AbortReport>;                        // commit intent; drive performs cancellation
  shutdown(): Promise<void>;                           // mark + drive whole ownership subtree, including background
  waitForIdle(): Promise<void>;                         // observe only; starts no work
  runWhenIdle<T>(callback: () => Promise<T>): Promise<T>; // host-side admission; semantics to finalize (§25)
  collapse(options?: { instructions?: string }): Promise<number>; // create task, not provider effect
  resetContext(ids: number[]): Promise<void>;
  fork(options: HistoryTarget & { context: "fresh" | "inherit"; label?: string; summary?: string }): Promise<Conversation>;
  rewind(target: HistoryTarget, options?: { keepRunning?: boolean }): Promise<Conversation>;
  spawn(options: SpawnOptions): Promise<number>;        // create owner task; return immediately
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: ConversationValue<T>): Promise<void>;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>, tag?: string): Promise<number>;
  command(build: (tx: ConversationCommand) => void | Promise<void>): Promise<boolean>;
}
interface Harness extends ValueReader {
  root(): Promise<Conversation>;
  conversation(id: number): Promise<Conversation | undefined>;
  conversations(query: ConversationScan): Promise<ConversationState[]>;
  inspect(): Inspection;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  command(build: (tx: Command) => void | Promise<void>): Promise<boolean>;
  command(scope: WorkingScope, build: (tx: WorkingCommand) => void | Promise<void>): Promise<boolean>;
  setValue<T>(address: Value<T, MainScope>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: Value<T, MainScope>): Promise<void>;
  watch(conv: number, options: { limit: number }, listener: (event: WatchEvent) => void): Promise<() => void>;
  decideApproval(id: number, decision: "grant" | "deny", details?: JsonValue): Promise<void>;
  delete(conv: number, options: { confirm: boolean }): Promise<void>;
  close(): Promise<void>;
}
declare const Harness: {
  open(storage: Storage, options: HarnessOptions): Promise<Harness>;
};
```

Invocation Context is supplied by the host binding; Storage receives it explicitly. Public async
wait cancellation must remain observer-only; it never silently calls abort. Expected-input fencing
and exact observer Context overloads remain open (§25). `InputResult` needs the explicit attribution
contract in §18.2, not chronological answer guessing. WatchEvent is the wire union in §21.

Conversation tokens carry scope/kind/value type but no conversation id until bound. SpawnOptions
contains prompt, fresh/inherit context, scalar address selections and typed initial writes (§8.3).
Heterogeneous selections erase only after each write has passed its address's NoInfer check.

### 12.3 Accept, inspect, drive and cancel

```ts
const h = await Harness.open(storage, options);          // no effects
const root = await h.root();
const accepted = await root.accept("Inspect the parser", { requestId: "web-request-42" });
console.log(h.inspect());                               // includes pending generation
const outcome = await root.drive();
if (outcome === "idle") console.log(await root.result(accepted.entryId));

// Another caller can cancel the conversation while drive is active:
const driving = root.drive();
const cancelled = await root.abort();                   // durable marks; no per-task cancel
await driving;                                         // provided this scope remains driven
console.log(cancelled.drained);

// After a restart, inspect for display, then drive; do not iterate tasks to resume each one.
console.log(h.inspect());
await h.drive({ pollDeferred: true });                  // all independent trees
```

### 12.4 Queueing and independent scopes

```ts
const first = await root.accept("Analyze A");
await root.accept("Then analyze B");                   // first generation exists: queues followUp
await root.steer("Use read-only tools");
await root.nextRun("Apply this on the next explicit idle acceptance");
await root.drive();

await root.appendMessage({ role: "user", content: "Context only", timestamp: Date.now() });
await root.drive();                                    // creates nothing merely from this message

const fork = await root.fork({ at: first.entryId, context: "inherit" });
await fork.accept("Try a different approach");
await fork.drive();                                    // parent and sibling forks remain parked
```

### 12.5 Values, child initialization and working state

```ts
const model = conversationValue<ModelIdentity>("pi.model");
const thinking = conversationValue<ThinkingLevel>("pi.thinking");
const tools = conversationValue<string[]>("pi.active-tools");
const plan = conversationValue<boolean>("my-plugin.plan");
await root.setValue(plan, true);
await root.spawn({
  prompt: "Inspect only the parser",
  context: "inherit",
  values: { inherit: [model, thinking], set: [setValue(tools, ["read", "grep"])] },
});
await root.drive();

// Working value/list writes use the SAME command path, pinned to one named lifetime.
const work = workingScope("upload-preview");
const chunks = list<string>("my-plugin.chunks", "", work);
await h.command(work, tx => { tx.appendList(chunks, "first chunk"); });
await h.command(tx => { tx.retireScope(work); });
await h.close();
```

The examples are API illustrations, not benchmark results or executable integration tests.

---

## 13. Invariants and tests

1. The read model equals a replay at every commit, on every backend.
2. Every external effect is preceded by committed inflight intent; settlement and successors are one command.
3. Every non-terminal status has a driver action; an unknown status fails at open.
4. After abort and a completed cancellation drive, all selected foreground/required tasks are terminal
   and their working scopes retired. Detached background tasks survive; shutdown includes them.
5. Delivery order and the listener rule (§7.1).
6. Projections never write; the driver never reads a payload.
7. Entries are never patched or reordered; a terminal task accepts no patch.
8. The context list is always `[head?, then entries in transcript order]`; every id on it exists; `through` never splits an exchange; `ctx_replace` with a stale `prefixVersion` rejects; a summarization survives appends and is rejected by a competing replace/reset; the context as of any commit boundary is reconstructible by replaying `ctx_*` records from the newest reset.
9. **Residency**: execution holds live conversation states, live tasks, their scratch, context entries and needed settings. Backend history and active plugin replicas are separate, explicitly counted costs (§4.4).
10. **Bound**: resident entries = union of context-list ids; resident tasks = |live| plus newest generations not already live; independent of journal length on every backend. Verify at ≥100k turns with cold reopens; this is a required measurement, not a validated result. Count full journal/index memory on memory/JSONL and active plugin tracking state separately.
11. A fork's context never changes when its parent summarizes or resets later.
12. A task older than any summary survives a cold open, is recovered, settles, and is readable by id.
13. Watch has no gap: base and subscription are one line step; a paged-in entry never regresses a streamed update (`asOf`).
14. Session metadata survives navigation unchanged; historical scalar reads respect every ancestor cutoff and deletion tombstone.
15. Historical forks copy no value/list prefixes; subagents store only selected initial scalar values and overrides, with no parent fallback. Both behaviors survive reopen.
16. List pagination and checkpoint replay produce the same visible history across nested forks as a reference traversal; no page leaks sibling or later-parent writes.
17. Input acceptance and external identity mapping are one atomic commit; a lost response cannot leave just one of them durable.
18. Replication publishes only committed state. Journal gaps require no durable replication counter; fresh bindings hydrate before consecutive emitted updates.
19. Acceptance/settlement/explicit caller commands create generation tasks, never driver tail inference.
20. Generation creates its tools and exactly one post_tools atomically. Tools settle only themselves;
    post_tools remains foreground and creates exactly one successor with its own settlement.
21. Context-only writes request no generation, before or after reopen; pending/retrying/deferred work prevents duplicate foreground admission.
22. Reported usage commits with its attempt outcome, including retries and stale collapse publication.
23. Main/working mixed writes reject before mutation. Retirement commits with task outcome; physical
    unlink failure cannot resurrect retired data. Late progress cannot reopen a finished task's scope.
24. Overlapping drive scopes share ownership; effect/recovery and abort never write concurrently.
25. Open starts nothing, invents no successors, and restores only explicitly live working lifetimes.

Scenarios: the v1 suite re-expressed; the walkthroughs in §15; the adversarial list: rewind after
replacing a conversation value; a plugin writing thousands of versions (execution residency flat,
backend history counted separately); nested forks before/after deletes and checkpoints; selective
subagent settings without inherited plan mode; compact
repeatedly (one head, never a chain); an ancient job waiting across many summaries; fork before a
later parent summary; a reset while a summarization runs (summary rejected); page while updates
arrive (`asOf`); render a summary with a retained tail at `limit: 3` (§15.6).

---

## 14. Contrast

| | runtime/ (lanes) | dom/ and pico v1 | pico v2 |
|---|---|---|---|
| unit | lane over an entry branch | node tree | conversation = transcript + tasks + values, with a context list |
| in-flight state | one 13-leaf op record per lane | status on nodes | status on tasks; one live set |
| model context | scan back to the compaction entry | collapse node / folds | explicit list: head + suffix; three ops |
| memory | window per lane | whole tree (v1) | context entries + live tasks |
| history | branch index, `getEntry` | resident tree | transcript pages, typed historical value/list reads |
| subagents | child lanes | nodes | tasks owning conversations |
| plugin state | session values/lists + custom entries | nodes | typed session values and rewindable conversation values/lists |
| rewind | move a cursor | fork node | historical fork; optionally cancel source conversation foreground |
| storage | entries + branch index | ops + checkpoints | journal + read model; JSONL rebuilds by scan, SQLite keeps tables |

---

## 15. Walkthroughs

Task names below stand for numeric creation seqs. Braces group ONE atomic main commit. Progress
commits go only to the named working scope; terminal commits include its retirement.

### 15.1 One tool

```text
accept:       { user U; create G1 }
request:      { G1 streaming } → provider
response:     { assistant A; create T; create P after:[T]; settle G1; retire G1 scope }
execution:    { T running } → tool
result:       { tool result R; settle T; retire T scope }      // P remains live, no idle gap
coordination: { settle P; create G2 }
answer:       { assistant B; settle G2; retire G2 scope }      // no continuation: idle
```

T knows nothing about P or other tools. P exists before T starts, so a crash after T's result
requires no repair: P is already ready. Crash during T executes its normal recovery policy.

### 15.2 Parallel and sequential calls

```text
parallel response:
  { create T1,T2,T3; create P after:[T1,T2,T3]; settle G1 }
completion order:
  { R2; settle T2 } → P blocked
  { R3; settle T3 } → P blocked
  { R1; settle T1 } → P ready
  { settle P; create G2 }

sequential response:
  { T1; T2 after:[T1]; T3 after:[T2]; P after:[T1,T2,T3]; settle G1 }
execution:
  T1 terminal → T2 ready → T2 terminal → T3 ready → T3 terminal → P ready
```

Both use the same tool and join handlers. The transcript preserves completion order; model
projection emits results in call order. A blocked tool produces an ordinary error result and
settles. Only P interprets completed exchange outcomes and decides whether generation continues.

### 15.3 Hold, restart and conversation cancellation

```text
T1 held: { create approval A; T1 waiting after:[A] }
T2 after:[T1] and P remain blocked
open: inspect reports all tasks; starts nothing
approve: { A granted; T1 planned approved:true } → covered drive runs T1

instead, conv.abort():
  { mark T1,T2,T3,P and required approval A; drain steer/followUp once }
  signal owned effects; join each task's own execution before abort handler
  each tool writes its error result; unstarted tools need not await predecessors
  P aborts without generation; every terminal task retires its working scope
```

Only conversation cancellation is public. Deleting a queue item is separate from cancelling live
work. Detached background tasks survive foreground cancellation; shutdown/delete includes them.

### 15.4 Foreground/background subagent

```text
foreground tool T delegates:
  { create owner S; T finishing after:[S] }                 // effect returns
S starts:
  { create child C owner:S; initial values; prompt; Gchild; S running owns:C }
child finishes:
  { final assistant B; settle Gchild; settle S result:B }   // existing T is now eligible
T finishes:
  { parent tool result from B; settle T }                  // parent P waits for all calls

background tool T delegates:
  { create S; tool result containing S.id; settle T }       // no dependency on S
```

No effect holds a promise across child lifetime. Recovery drives existing child tasks and stored
dependencies. Child completion does not execute parent work outside the caller's drive scope;
it only settles its owner as part of that completion. Parent tool finishing runs when covered.
Forks have no owner and are never pulled into a parent's scope merely through provenance.

### 15.5 Background job across restart

```text
{ create job J; tool result J.id; settle launching tool }
{ J spawning, durable adoption/log location } → spawn/adopt
{ J running, verified process identity } → install output/exit observers, return
parent P creates next generation without waiting for J

open → inspect J running; covered drive re-arms observer once
exit → { immutable result E; settle J exited produced:E; retire J scope }
later tool → indexed read J and E, even if J.at is long outside current context
```

The external process log and bounded working checkpoints have explicit host lifetime rules.
Neither context compaction nor ordinary foreground cancellation makes a detached job disappear.

### 15.6 Collapse, speculative, subsuming, and the rendering at `limit: 3`

Transcript `u1 a1 u2 a2` (ids 1..4), context `[1,2,3,4]`, budget exceeded, `keepRecent` keeps `u2 a2`:
```
20  T collapse C {pending, through:2, prefixVersion:0}      21 set 20 {summarizing}
    — meanwhile generation 22 runs and appends 23 (u3), 25 (a3): ctx [1,2,3,4,23,25] —
26  E summary C "…" through:2 by:20   (context: "none": not auto-appended)     ┐ one commit
27  ctx_replace {through:2, with:26, expectPrefixVersion:0}   → ctx [26,3,4,23,25]   │  prefixVersion 1
28  settle 20 {done, produced:26}                                                  ┘
```
A reset that had landed between 21 and 26 would have bumped `prefixVersion` and 27 would reject;
20 would settle `failed`. A second collapse later captures `through: 23` and summarizes the prefix
`[26, 3, 4, 23]`, which includes summary 26: the new summary subsumes it; the list stays one head
plus a suffix.

Rendering: transcript order is `u1 a1 u2 a2 u3 a3 S` (S = 26 was appended last). A watch with
`limit: 3` receives `[u3, a3, S]`; S is drawn after its `through` (a1), which isn't loaded, so at the
top: `S u3 a3`. Paging `before: u3` returns `[u2, a2]`, drawn below S because their positions are
after a1: `S u2 a2 u3 a3`. Paging again returns `[u1, a1]`: `u1 a1 S u2 a2 u3 a3`. Pagination uses
transcript order as stored; only the summary's display position is relocated.

### 15.7 Reset (Codex-style)

The new_context tool settles its own result with handoff intent. It never checks siblings or edits
context. Once all calls settle, post_tools applies the handoff:
```text
{ append handoff H; ctx_reset [H]; create G2; settle post_tools }
```
This is explicit continuation. `/clear` alone creates no task; changing context while a generation
is already pending does not implicitly cancel that task.
Transcript unchanged; jobs unchanged; conversation values/lists unchanged. The next generation projects `[40]`
plus subsequent appends. A watcher draws the handoff at its position and dims everything above it.

### 15.8 Fork and rewind

Fork at `a1` (entry 2) after §15.6 published: the fork copies C's context restricted to ids `≤ 2`:
`[26]`? No: 26 has `through: 2`, its head stands in for `1..2`; restricted to `≤ 2` that head is not
applicable (it was published after the fork point and the fork's `asOf` is earlier), so the fork
reads C's context **as of `asOf`** = `[1, 2]`, trims to the last complete exchange, and starts from
`[1, 2]`. Later parent summaries never reach it (invariant 11). `rewind(C, at: 2)` while tool 7 runs
under generation 2: cancel/drain the source conversation's foreground chain, then fork.
Values/lists in the fork follow the parent link through the commit containing entry 2; later parent
versions are invisible. A separate `{ asOf }` target can select a value-only or delta-only commit.

### 15.9 Plugin state and replicated state

Plan mode enabled at commit 80: `value_set C my-plugin.plan-mode=true`. A historical fork through
commit 60 sees the preceding value (or the caller's default if absent); parent changes after 60
are invisible. Deleting plan mode in the fork masks the inherited value without altering C.
A subagent can copy C's model/thinking level but omit plan mode and override active tools; all
initial settings commit with child creation (§8.3).

A canvas stores a checkpoint value at creation and periodically, plus one list append per delta
batch. Hydration finds the checkpoint visible through the selected commit and replays only its
visible suffix, including inherited ranges. A fork appends locally without copying parent strokes.
An entry label or external request mapping remains a session value and does not rewind.

If committed deltas have journal seqs 104 and 117, a freshly hydrated replication binding emits
revisions 1 and 2. Neither revision is stored. Rewind replaces the binding and hydrates the selected
state afresh. Un-journaled preview (cursors) is scratch on the canvas's live task, if it has one.

### 15.10 Open, in general

Read live tasks (`terminal = false`) and their conversation states; for each live conversation read
the entries on its context list (one batched read); read named working values/lists. Then drive the desired scope.
Execution-state reads use indexes rather than replaying the journal. JSONL first imports the
complete journal; active plugin state hydrates separately from checkpoints and bounded delta pages.

---

# Part II — interface details and validation

The task definitions are in §3. The following sections supplement them without defining another
lifecycle. Open design questions are explicit in §25. Templates and skills remain a layer above.

## 16. Tools

```ts
interface Tool {
  name: string; description: string;
  parameters: JsonObject;                              // provider-compatible JSON Schema
  replay?: "safe" | "never";                           // default never
  output?: { retain?: "head" | "tail"; maxBytes?: number }; // default tail, 64 KiB
  execute(args: JsonObject, ctx: ToolExecutionContext): Promise<void | ToolDelegation>;
}
interface ToolExecutionContext {
  signal: AbortSignal;
  invocationId: number; callId: string;
  conv: ConversationView;
  out: ToolSink;
  resources: ReadonlyMap<string, unknown>;
}
type ToolDelegation =
  | { kind: "subagent"; options: SpawnOptions; background?: boolean }
  | { kind: "job"; options: { command: string; notBefore?: number }; background?: boolean };
interface ToolSink {
  write(text: string): void;                          // appended to scratch; capped per `output`; truncation is marked in the result
  details(json: JsonValue): void;                     // result details, replaced on repeat
  image(image: ImageContent): void;                  // image block in final tool result
  handoff(text: string): void;                       // intent for post_tools, never edits context here
  usage(u: Usage): void;                              // journaled atomically with attempt outcome
  addTools(names: string[]): void;                    // updates the activeTools conversation value at settlement; unknown names are dropped
  terminate(v: boolean): void;                        // the run stops after this exchange; the assistant's other calls still settle
  progress(partial: JsonObject): Promise<void>;       // durable checkpoint in scratch; a `progress` delta to watchers; reported by recovery
  memo: { get(key): Promise<JsonValue | undefined>; set(key, v): Promise<void> };   // durable per-execution memos, retired at settlement
}
```
Rules. A tool's throw becomes an error result (`isError: true`, the message text); a throw after
`signal.aborted` becomes an aborted result. Only `execute` is inside the harness's try; a storage
failure while settling propagates (§7.3). Results are `tool_result` entries `{ callIndex, isError,
bytes }` with the capped text (`[truncated: N bytes total]` appended when capped), details, and
images. A call for a tool not in `tools` settles with `not found`; a `truncated` call (stop reason
other than toolUse) settles with `not executed` and never runs. `addTools` names not present in
`tools` are ignored. `terminate` ends the run after the current exchange: no new generation, the
turn is quiescent, `drive` returns `idle`. Calls are parallel unless
the captured `toolOrder` is sequential: generation creates after edges in callIndex order, and a
held predecessor remains nonterminal. The scheduler has no tool-specific concurrency lock.

## 17. Provider request boundary

Generation lifecycle, classifications, retry, polling, recovery and cancellation are defined once,
in §3.9. Request construction projects the captured context (§6.4), resolves captured model/tools,
resolves the system prompt and applies before_request. Tools must still enforce captured active-tool
authorization, not merely registry presence. Capture the MAIN context boundary before request intent;
working progress seqs are not navigation targets. Provider payload/cache/option parity remains in §25.

## 18. Queues and context-only writes

```ts
interface InboxItem {
  id: number;
  kind: "write" | "steer" | "followUp" | "nextRun";
  entry: number;             // durable unselected content, not yet placed in context
}
```

```text
API                         idle                              busy
accept(input)               place + create generation         enqueue followUp
appendMessage / selected    place safely; no generation       enqueue write
  context-only insertion
steer / followUp / nextRun   enqueue its tag                   enqueue its tag

boundary                    eligible items
idle acceptance             writes + nextRun + mode-selected steer/followUp, then accepted input
post_tools                  writes + mode-selected steer; successor unless stopped
normal final answer         writes; mode-selected steer/followUp if continuing
idle context-only append    earlier writes, then new write; no generation
abort                       drain steer/followUp; retain write/nextRun
```

Preserve admission order within selected items. `steeringMode`/`followUpMode` default to `all`;
`one-at-a-time` selects the oldest item of that tag, leaving others for later boundaries. `write`
placement never requests generation, even when it leaves a user-shaped context tail. `nextRun`
is consumed only by explicit idle acceptance. On failure/termination, place safe writes but do
not consume input requiring a successor that will not be created.

```text
enqueue: unselected content + inbox item in one command
consume: selected placement + dequeue + required generation in one command
cancelQueued: queued → cancelled; already placed → already_consumed; absent → not_found
```

Representation linking unselected content to placement/cancellation history remains open with
result attribution (§18.2). Admission position is not necessarily model-context position; do not
silently duplicate payloads or assume old entry ids can be appended out of transcript order.
The four queue behaviors and atomic consumption do not depend on that representation choice.

### 18.1 Caller-known acceptance identity

Ordinary `accept(input)` returns its numeric input id. An optional caller-supplied `requestId`
exists for recovery when acceptance commits but its response is lost. It is an opaque external key,
not an internal entity id, and need not be a UUIDv7. Only keyed acceptances pay its storage cost.

Inside the serialized acceptance command, look up `requestInput(requestId)` (§5.1). If absent,
create the accepted input and set that session value to its id in the same commit. If present,
resolve the existing acceptance rather than inserting another input. There is no crash window
between two records in one atomic command and no separate request-specific storage abstraction.

Memory/JSONL maintain the current keyed map from journal replay; SQLite uses the session-values
primary key to resolve the request key, then fetches its numeric input id from the journal payload.
No UUID field or secondary UUID index is needed on every entry, task or conversation. The mapping
is session-wide, survives rewind and is not copied as child conversation state. Core owns these
mappings; accepting a request must not overwrite an existing identity association.

Exact behavior for reusing a key with different input or a different conversation must be settled
before implementation; it must not silently accept a new request or return another conversation's
answer. Lookup itself is simply `harness.getValue(requestInput(requestId))` followed by input/result
lookup. A convenience result overload is not required for this mechanism.

### 18.2 Pending result attribution contract

The original rule, "first final assistant after the input", is invalid. If B is queued while A
runs, A's final answer can appear after B's acceptance entry without answering B. An explicit durable
input-to-completion association is needed, including queued consumption, cancellation, failure,
and multiple inputs consumed together. Its representation and exact result outcomes remain open;
request identity lookup does not solve this second association. Do not implement chronological
result inference as a substitute.

## 19. Outcomes, reports, errors

- Drive outcomes and ownership scope are defined in §3.8. Conversation idle concerns foreground;
  session idle means no live tasks. Suspended includes dependency-blocked work whose prerequisite
  awaits an outside event. Observe committed predicates after commits/passes; events only wake.
  Callers share execution, not authority to cancel it.
- `inspect()` → `{ start: Task[], inflight: Task[], waiting: Task[] }` from the live set; `open()`
  reports the same and starts nothing.
- Errors: `Closed` (command after `close`), `Faulted` (command after a fault; `.reason`),
  `Rejected` with a code (`invariant`, `busy`, `unknown_target`, `version_mismatch`, `not_found`);
  none of these is a fault. A listener that throws is reported through the `handler_error` signal.
- `close()` waits for in-process effects to observe cancellation (each `abort` signal fires; effects
  return), does not settle anything, does not wait for jobs.

## 20. Hooks, precisely

```ts
interface HookContract<I, D> { input: I; decision: D }
interface ProviderRequest {
  systemPrompt: string; messages: AgentMessage[]; tools: Tool[]; streamOptions: JsonObject;
}
interface HookContracts {
  before_request: HookContract<{ conv: ConversationView; generation: Task; request: ProviderRequest }, ProviderRequest>;
  after_response: HookContract<{ generation: Task; message: AssistantMessage }, void>;
  before_tool: HookContract<{ call: Task; args: JsonObject }, { kind: "allow" } | { kind: "block"; text: string } | { kind: "hold" }>;
  after_tool: HookContract<{ call: Task; result: JsonValue }, void>;
  on_yield: HookContract<{ conv: ConversationView; generation: Task; message: AssistantMessage }, { kind: "pass" } | { kind: "continue"; message: AgentMessage }>;
  before_collapse: HookContract<{ conv: ConversationView; through: number; prefixVersion: number }, { kind: "decline" } | { kind: "allow"; meta: JsonObject }>;
}
interface Hooks {
  on<P extends keyof HookContracts>(
    point: P,
    handler: (input: HookContracts[P]["input"]) => HookContracts[P]["decision"] | Promise<HookContracts[P]["decision"]>,
    options?: { priority?: number },
  ): () => void;
}
```

| point | input | decision | combination |
|---|---|---|---|
| `before_request` | `{ conv, generation, request: { systemPrompt, messages, tools, streamOptions } }` | `request` | applied in order |
| `after_response` | `{ generation, message }` | — | all run |
| `before_tool` | `{ call: Task, args }` | `allow` \| `block(text)` \| `hold` | first block/hold wins; later hooks do not run |
| `after_tool` | `{ call, result }` | — | all run |
| `on_yield` | `{ conv, generation, message }` (completed final response candidate) | `pass` \| `continue(message)` | first continue wins |
| `before_collapse` | `{ conv, through, prefixVersion }` | `decline` \| `{ meta }` | first decline wins; metas merged |
A hook that throws: `before_request` fails the generation; `before_tool` blocks with the error text;
`before_collapse` declines; `on_yield` passes; observers are reported as `handler_error` and ignored. Hooks are called by effects, outside the line, so a hook
MAY `await ctx.commit(...)` (append entries, write typed values/lists, insert work); those commands interleave
with other actors under §24. A `before_request` hook affects *this* request only through the
request it returns; an entry it appends is projected from the next generation on. Only listeners
(watch/`on`) are forbidden from issuing commands inside their callback.

## 21. Watch wire shapes

```
base   { type: "base", asOf, conversation: ConversationState, entries: Entry&{payload}[], tasks: Task[], scratch: { [taskId]: JsonValue } }
commit { type: "commit", firstSeq, lastSeq, writes: [ { seq, change } ] } // relevant MAIN writes, §4.1
delta  { type: "delta", taskId, kind: "frame" | "progress" | string, payload }
signal { type: "quiescent", conv } | { type: "fault", message } | { type: "handler_error", taskId?, message }
page   entries(conv, { before | after, limit }) → { asOf, entries: Entry&{payload}[] }
```
Base and subscription are one line step. Commit batches retain boundaries even when filtering
out unrelated writes; clients reduce a whole batch before publishing. Thus tool/result retirement
or post_tools/successor creation cannot become a partial visible transition. Preview/signal fields
are not durable work requests. Pages carry their own asOf for deduplication. del_conv ends the watch;
context replacement/reset cues model-context rendering. WatchEvent is this base/commit/delta/signal union.

## 22. Usage ledger and telemetry

**Usage** is journaled with the corresponding attempt outcome, not independently written to a ledger.

```text
provider completes: commit reported usage + outcome/retry/deferred transition together
collapse loses prefix race: commit reported usage + failed collapse, without summary/context edit
tool completes: commit usage + own result + own settlement + working-scope retirement
post_tools completes: commit exchange policy + successor generation, if continuing
identity: usage record seq, NOT taskId; a task can have several attempts
query: read the main session usage list; any aggregate/filter indexes are backend implementation details
fork: costs remain attributed to original conversations; no copied billing rows
cleanup: task completion/scratch retirement never removes usage
```

An interrupted request with no provider report has unknown cost; no exactly-once billing claim.
Reject stale/repeated outcomes instead of appending duplicate usage. Usage is an ordinary main
session list; no separate ledger authority/file or redundant full usage payload in task patches.

**Telemetry** uses pi's callback `TelemetryContext` (typed schemas, no second contract). Spans and
their parents follow the procedure nesting:
```
harness.open · harness.drive (per pass)
  acceptance / task settlement              (explicit successor creation)
  task.effect / task.recover / task.abort   (attributes: kind, taskId, status from→to, attempt)
    ai.request                              (model, usage, stop reason, durations; never prompts or completions)
    tool.execute                            (name, callIndex, bytes, isError; never args or results)
    hook (point, name, decision)
  line.command (op count, seqs, duration)   ← parent: the command's caller
  watch.deliver (listener count, duration)
```
A pre-aborted signal starts no span. Attributes are ids, names, counts, durations, statuses and
usage; never message text, arguments, results, file contents, provider payloads, headers or handles.
Each command and each effect carries its own telemetry parent and abort signal; cancellation ends
only that caller's observation.

## 23. Storage conformance

Each backend passes:
1. commit preserves command-minted global seqs and atomic batches. Each admitted batch starts at
   global head+1 and is contiguous; main files, working files and retained history have legal gaps.
2. Read model equals a replay of the journal after every commit (entries, tasks, conversations,
   context lists, `prefixVersion`).
3. Transcript pages and content queries equal a scan; typed value reads and list pages equal
   reference history traversal, including nested fork cutoffs and deletion tombstones.
4. Working values/lists use ordinary reads/writes, survive restart, and disappear only through
   explicit retirement. Result + task settlement + retirement survive or disappear together.
   Crash before physical unlink leaves logically retired files, not recoverable task state.
5. JSONL: one line per commit; a torn final line is truncated on open; rebuild-by-scan yields the
   same read model as SQLite's tables for the same journal.
6. Usage survives atomically with its outcome, including multiple attempts under one task id.
7. Storage open creates no conversation/tasks. Harness open on empty storage creates root + initial
   values in one command; nonempty open starts no work and writes no journal records.
8. Command construction: creation methods return their final numeric ids before append; subsequent
   records reference them directly, including automatic context appends. No-op and rejected commands
   consume no seqs; concurrent commands allocate disjoint consecutive ranges; reopen continues after
   the last complete commit. Payloads such as `{ ref: 0 }` round-trip unchanged.
9. SQLite value/list queries use ordered indexes without journal scans or temporary sorts;
   sparse keys and deep fork chains do not require reading unrelated history. Fork creation adds
   no inherited value/list rows. Subagent creation stores only selected present values and overrides.
10. Reopen preserves metadata, historical versions, list cursors and subagent initialization.
    Checkpoint payloads in the memory journal remain unchanged after mutable replay by a wrapper.
11. Acceptance and request mapping survive or disappear together; a retry after a lost response
    does not create a second input. Conflicting reuse tests follow the policy still pending in §18.1.
12. Paused persistence exposes old complete state, never proposed indexes. Short/failed JSONL writes
    and crash after newline/SQL commit but before publication reopen to one complete prefix.
    Malformed complete JSONL lines fail open; only unterminated final bytes are discarded.
13. Close drains admitted main/working writes and retires nothing. Reused scope ids retain only
    records newer than latest retirement. Old cleanup cannot delete a reused lifetime.
14. Crash around acceptance, tool and post_tools/final settlement: join always exists; no consumed
    trigger without generation, no duplicate successor on reopen; usage agrees with outcomes.
15. Mixed main/working and two-working-id commits reject. Memory, JSONL and SQLite agree on logical
    retirement. High-water computation includes retired physical records before cleanup.
16. Late progress is rejected by invocation fencing, not by a global ban on scope-id reuse.

## 24. Race catalog (each has exactly two durable orders; tests assert both)

| race | orders |
|---|---|
| `accept` vs `accept` on an idle conversation | first is the prompt; second queues as followUp |
| keyed `accept` vs process loss before response/`drive` | input and mapping both absent → retry may accept; both present → resolve existing input, never duplicate it |
| `drive` vs `drive` | both join one pass |
| `abort` vs generation settlement | marker first → aborted, no successor; settlement first → output and successors commit, then abort reaches any still-live successor |
| `abort` vs tool outcome | marker first → the effect's signal fires and it settles `aborted`; outcome first → `done`, result preserved |
| `abort` vs `retry_wait` | settles `aborted` without waiting the timer |
| `abort` vs collapse settlement | marker first → collapse aborted, list unchanged; settlement first → list replaced |
| `abort` vs `on_yield` continuation | marker first → the continuation entry is not inserted; entry first → the run continues and abort settles it |
| `cancelQueued` vs boundary consumption | cancellation first → cancelled; consumption first → already_consumed |
| conversation setting write vs generation creation | old value or new; the generation captures what it uses |
| `nextRun` vs `accept` | captured by this prompt or stays for the next |
| collapse settlement vs `ctx_reset` | reset first → `version_mismatch`, collapse `failed`; settlement first → the reset applies to the new list |
| collapse settlement vs appends | appends survive either order |
| frame/progress write vs settlement | seal/drain first; outcome + retirement commit together; failed unlink leaves logically dead data |
| watcher registration vs commit | one line step: old base + all later records, or new base |
| `close` vs settlement | settlement committed before close, or the task stays inflight and recovers next open |
| fork vs parent summary | the fork copied its list as of `asOf`; the summary is not applied to it |
| subagent initialization vs parent setting write | selected old values or selected new values at one captured boundary; no mixed initialization |
| plugin update vs plugin update | second command derives its update from the first committed state |
| replica binding vs committed delta | hydration includes it, or the new stream emits it after hydration; never a gap |
| parallel tool outcomes | either order settles only those tools; existing post_tools becomes ready when all dependencies are terminal |
| steering vs generation creation | included with creation, or queued for next boundary |
| context-only write vs drive/reopen | context may change; neither order creates generation |
| settlement vs uncertain persistence outcome | output/usage/successors/retirement all absent or all durable on reopen; old handle faults |
| post_tools settlement vs conversation abort | marked join creates nothing, or successor commits first and becomes a cancellation target |
| scope retirement vs reuse | later writes survive; older unlink is serialized before new lifetime |
| working progress vs retirement | admitted old writes drain before retirement; stale producer cannot recreate task data |
| overlapping drive callers vs cancellation | one shared ownership claim covers effect join and abort handler |

## 25. Remaining design decisions

These are not settled by the value/list and identity decisions above:

- **Result attribution:** durable input-to-completion association and conflicting request-key reuse
  (§18). Caller-known identity must not be confused with result ownership.
- **Historical context optimization:** §6.6 defines correct creation/reset-based replay; faster
  compaction-bounded reconstruction still needs review. Replacement alone is not a checkpoint.
- **Subagent context:** safe inherited-context capture while parent tool exchange is open; caller
  selections are copied at child creation, not implicitly at address construction.
- **Host and background lifecycle:** durable process adoption/exit status, bounded schedules, and
  whether close retains cooperative waiting or gains a bounded host policy. Finalize runWhenIdle
  admission/observer cancellation without introducing a second execution owner.
- **Queue/response policy:** exact input normalization, steering precedence/mode capture, conflicting
  handoffs, retained failed/deferred attempt messages and projection. Keep representation and policy
  separate from the settled chain mechanism.
- **Old-harness parity:** intentionally decide differences in tool termination aggregation, hook
  transformations/error handling, interrupted-stream recovery, retryable/overflow classification,
  deferred poll permits/external retry scheduling, token-budget/split-turn compaction, summarized
  navigation/import, usage adjustments/totals and complete watch hydration. These are not silently
  removed by rewriting tasks. Expected-input cancellation/result fencing remains tied to attribution.
- **Chord adapter:** choose a supported producer/operation seam and durable delta encoding, including
  checkpoint/fork codec state. Do not mutate an exposed producer while a commit is pending. Stream
  revisions remain process-local emission bookkeeping, regardless of this choice.

Implementation, stronger regression coverage, and equivalent faux-provider benchmarks follow design
review. CPU time, total process memory, and actual disk bytes (including scratch and usage) must be
measured separately; the spike's existing figures are not validated comparisons for this design.
