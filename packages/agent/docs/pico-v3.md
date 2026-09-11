# pico v3

Design under discussion. Code and traces illustrate the proposed behavior; they are not existing
package exports.

## 1. Goals and assumptions

### 1.1 Small concepts, replaceable behavior

Run agents using conversations, immutable entries, durable tasks, and scoped values/lists.
Built-in agent behavior is composed from tasks, not embedded in a fixed scheduler state machine.

```text
                    ┌─ tool A ─┐
generation ──────────┼─ tool B ─┼─ post_tools ─ generation
                    └─ tool C ─┘

replace a task definition
  → change that behavior
  → keep the scheduler and storage
```

The scheduler understands task lifecycle, dependencies, timing and cancellation. It does not
understand prompts, tool arguments or summaries. Storage understands stored objects and atomic
mutations, not task behavior.

### 1.2 One writer per session

Concurrent execution is allowed. Concurrent independent writers to the same session are not.

```text
caller ───────┐
tool ─────────┼─ session owner ─ serialized commands ─ storage
background ──┘

one command:
  read committed state
  construct mutations and assign numeric IDs
  commit the complete batch
  publish committed changes
```

All mutations, including working-state writes, pass through that owner. IDs are unique within the
session and are persisted unchanged. Uncommitted IDs cannot escape to callers or external effects.

Different sessions may have different owners and share a SQLite database. SQLite still serializes
its write transactions. After a crash, a replacement owner resumes from durable state; it must not
run alongside the previous owner.

### 1.3 Durable work, explicit recovery

Durable storage preserves work that has been accepted, including work that has not started yet.
Opening a session starts no task effects.

```text
commit pending task
  → crash
  → open: task is still pending
  → drive: execute it

commit external-effect intent
  → perform external effect
  → commit outcome and required successor tasks together
```

A crash during an external effect leaves uncertainty, not proof that nothing happened. Each task
definition must decide how to recover: retry safely, adopt existing work, or report interruption.
Durability does not promise exactly-once external effects.

```text
close     → stop local execution; leave unfinished durable tasks resumable
abort     → durably cancel selected work; drive its cancellation to settlement
```

### 1.4 Long-lived sessions without residency machinery

Old transcript entries and terminal tasks remain queryable. The harness should not retain them
merely because it encountered them earlier.

```text
check a dependency:
  read the named task
  inspect its terminal status
  return
  // no harness-owned reference needs to survive the check
```

Active executions naturally retain their inputs and working data. Other query results are ordinary
local variables. No pin/unpin API, residency manager, or sweep that maintains a second resident
model. Routine execution should depend on current work and context, not scan accumulated history.

Backend memory is a separate choice:

| Backend | Storage-owned memory | Persistence |
|---|---|---|
| Memory | All stored data and indexes | None; useful for tests |
| JSONL | All stored data and indexes, loaded on open | Main file plus working sidecars |
| SQLite | Read results and database caches; no required full-history JS copy | Database |

JSONL loading everything is intentional, not a violation of the working-set goal. Choose SQLite
when minimizing resident process memory matters. No fixed session-length limit is imposed; storage
capacity, numeric sequence limits and the amount of simultaneously live work remain real limits.

### 1.5 Efficiency must be demonstrated

```text
same faux-provider workload on each harness/backend
  → CPU time
  → total process memory
  → actual disk bytes, including working data and auxiliary files
```

Prefer small atomic writes, indexed queries and batched reads. Do not turn a point lookup into a
history scan or reload every object to answer a small question. Measure hot paths before adding
caches or specialized machinery. A faster spike is evidence to investigate, not proof that its
interfaces or correctness shortcuts belong in this design.

## 2. Conversations

A conversation has a linear transcript of immutable entries and a context list selecting entries
for the model. Tasks and state are associated with it, but do not implicitly become model input.

### 2.1 Entries and the transcript

Minimal shapes; `JsonValue` means strict JSON. Historical-position and ownership metadata are
introduced separately.

```ts
interface Entry {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly content: JsonValue;
}

interface Conversation {
  readonly id: number;
  readonly context: readonly number[];
}
```

These are read snapshots. Changing context produces a new conversation snapshot; an existing
entry's content never changes.

```text
conversation A

entry ID    kind          content
10          user          "Inspect the parser"
20          assistant     "The parser has two problems ..."
30          user          "Explain the first one"
40          assistant     "The first problem is ..."

transcript: [10, 20, 30, 40]
```

- New entries append; existing entries are never patched, reordered or renumbered.
- IDs increase in transcript order, but need not be consecutive numbers.
- A note can belong to the transcript without belonging to model context.

### 2.2 Context selects; projection converts

```text
transcript                  context IDs             provider messages
what happened               what is selected         what the model receives

[10, 20, 30, 40] ──────────> [10, 20, 30, 40] ──────> user, assistant, user, assistant
                                         projection
```

The context stores IDs, not copied messages or a second transcript.

```text
entryById = readEntries(conversation.context)          // batched read
messages = project selected entries in context order
normalize tool-result groups into their call order
```

An entry's kind defines its message contribution. A summary can project as a user message; a
selected custom entry can project nothing. Projection reads content and returns messages. It
writes no entries, state or tasks.

Tool completion order need not equal call order:

```text
assistant calls: [A, B]
transcript:       assistant → result B → result A
model messages:   assistant → result A → result B
```

The transcript remains unchanged by that normalization.

### 2.3 Three context operations

```text
appendContext(ids)
  extend with newly appended selected entries, in transcript order

replaceContextPrefix(through, replacement)
  replace the prefix ending at through; preserve the existing suffix

resetContext(ids)
  replace the whole context with an empty or bootstrap context
```

Appending selected content and appending its context ID happen in the same commit. Context-only
changes do not create generation tasks.

**Compaction:** append a summary entry, then replace a prefix in the same commit.

```text
before:
  transcript [10, 20, 30, 40]
  context    [10, 20, 30, 40]

commit:
  append summary 50 describing the prefix through 20
  replaceContextPrefix(through=20, replacement=50)

after:
  transcript [10, 20, 30, 40, 50]
  context    [50, 30, 40]
```

Summary 50 is newer than entries 30 and 40, but appears before them in model context. The entries
it summarizes remain in the transcript. Repeated compaction summarizes the previous summary too,
not an ever-growing chain of summary heads.

**Reset:** discard the selected context, not the transcript.

```text
commit:
  append handoff entry 70
  resetContext([70])

after:
  transcript [10, 20, 30, 40, 50, 70]
  context    [70]

resetContext([])
  → empty model context
  → same transcript
```

Baseline constraints:

```text
context shape: optional summary/handoff head + selected entries in transcript order
IDs:           existing entries in this conversation or its inherited prefix; no duplicates
replacement:   a contiguous PREFIX of the current context, not a consecutive numeric ID range
exchange:      replacement/reset must not split an assistant's tool-call/result exchange
concurrency:   no replacement/reset during a provider request or unresolved tool exchange
```

A summary prepared against an old prefix may still replace it after later appends. A competing
replacement/reset invalidates that prepared prefix. The commit must check this before publishing.

These operations are not an arbitrary list editor: no middle deletion or unrestricted reordering.
Reset accepts an empty context or a bootstrap head, not an arbitrary permutation of old entries.
Reset alone neither cancels existing tasks nor requests a new model response.

### 2.4 Forks share history, not future changes

A historical fork creates a new conversation at a selected historical position. Its transcript
shares the source prefix; new entries belong to the new conversation.

```text
A transcript: 10 ─ 20 ─ 30 ─ 40 ─ 50 ─ 70
                   │
                   └────────────── 90 ─ 100    B

B transcript: [10, 20, 90, 100]
               shared  local
```

Entries 10 and 20 retain their original IDs and owning conversation. There are no copied entry
rows for them. Each conversation still presents a linear transcript.

The fork inherits the context that existed at its selected position, not today's context truncated
by entry ID:

```text
P = historical position after the first exchange

A context at P:   [10, 20]
A context now:    [70]

create B from A at P:
  B context starts as [10, 20]
  NOT [] obtained by filtering today's [70]
```

B has its own context list. Later appends, compaction and resets in A cannot change B. Live tasks
are not inherited; continuing B requires explicit new work.

Here P is a historical position already selected by the caller. §3 defines how selecting a
transcript entry resolves to that position, including the entry-versus-commit distinction. State
initialization and historical inheritance are defined in §4.

### 2.5 Fork history and task ownership are different relationships

```text
historical relationship:
  conversation A ── fork at P ──> conversation B

execution ownership:
  conversation A ── task T ── owns ──> conversation C
```

B is an independent fork. C is an owned child, such as a subagent conversation. A child can start
with fresh or inherited context; that choice is separate from which state gets initialized.

```text
historical source → where inherited content/state came from
owning task       → which execution owns this conversation
```

A historical relationship alone does not pull B into A's drive or cancellation scope. Ownership
is explicit; scheduling and cancellation follow the task relationships defined in §§5–6.

## 3. Identity, commits and historical positions

One session-global sequence orders mutations. A creation mutation's sequence is the new object's
numeric ID. A complete commit, not an individual mutation, is a historical snapshot boundary.

### 3.1 Allocate while constructing the command

```text
last committed sequence: 99

build command:
  100  append user entry                 → entry ID 100
  101  append context ID 100
  102  set planMode = true
  103  create generation task            → task ID 103

persist ONE batch [100–103]
publish the committed changes
return entry ID 100 to caller
```

The command can reference IDs it just created. It cannot call external services with them or
return them to callers before persistence succeeds. Storage preserves the supplied numbers.

```text
command A constructs [100–103] ─ commits ─ command B starts at 104
command A rejects             ─ no write ─ command B starts at 100
```

Numbers are positive safe integers; exhaustion rejects. There are no UUID columns on ordinary
entries, conversations or tasks, and no separately reserved ID ranges.

### 3.2 Commit boundaries are part of the read result

Extend the entry snapshot from §2 with its creation commit's end:

```ts
interface Entry {
  readonly commitEnd: number;
}
```

The end is known once construction finishes. The caller does not need to enumerate the other
mutations in the commit.

```text
getEntry(100)
  → { id:100, conversationId:1, commitEnd:103, ... }

getConversation(1, asOf=103)
  → context as of that boundary

getValue(conversation=1, planMode, asOf=103)
  → true
```

```text
Memory   entry metadata contains commitEnd=103
JSONL    commit envelope contains [100,103]; replay derives the entry metadata
SQLite   entry row contains commit_end=103, inserted in the same SQL transaction
```

Task creation at 103 belongs to the source's durable work. It does not mean a fork inherits that
task. Context and rewindable state are historical; task execution is not rewound.

### 3.3 Proposed fork contract: after the containing commit

```text
fork(A, atEntry=100)
  → resolve entry 100 to commitEnd 103
  → fork A's transcript/context/rewindable state through 103
  → store source A and boundary 103
  → inherit no live tasks
```

This deliberately means **after the commit containing the selected entry**, not an intermediate
state after only mutation 100. No second filter truncates context to IDs <= 100.

```text
commit [200–203]:
  200  append entry X
  201  append entry Y
  202  append context IDs [200,201]
  203  set value V

fork at X ─┐
           ├─ same snapshot: includes X, Y and V
fork at Y ─┘
```

This is a proposed semantic choice to review, not merely an indexing trick. A UI must not imply
that X and Y select different snapshots. Strict entry-prefix forks would need a different rule
for associating context/state changes with entries; they must not silently mix a truncated
transcript with later state from the same commit.

A caller can also select a complete main-commit boundary directly:

```text
commit [204]: set V = 2                  // no transcript entry
fork(A, asOf=204)                        // selects this state-only change
```

Entry and explicit-boundary targets use the same historical query path. A position inside a
commit rejects. A fork requiring usable model context must also select a complete tool exchange;
reject an incomplete exchange rather than silently moving to a different historical position.

### 3.4 Sequence gaps are normal

Working writes use the same allocator but do not become retained conversation history.

```text
100–103  main commit
104–109  working progress
110–112  main settlement, including retirement of that working scope

retained main history: 100,101,102,103,110,111,112
next sequence:        113
```

Never use an array offset as the durable identity. A deleted working file does not free its IDs.
Working commits are not fork targets. The backend preserves the global high-water mark even when
working contents are retired; main historical boundaries remain independently identifiable.

### 3.5 Failure before or after admission

```text
construction/validation rejection:
  no durable writes; no IDs consumed; session remains usable

persistence outcome uncertain:
  stop using this session handle
  reopen storage
  recover the last complete durable batch and its high-water mark
  continue from recovered state, not the old process's guess
```

No observer may see half a commit. No effect may treat an uncertain write failure as permission
to retry the same external action with newly allocated IDs.

### 3.6 Caller-provided identities use ordinary state

External request keys are optional session-scoped values, not alternate internal IDs.

```text
accept(input, requestId="client-42"), ONE command:
  read session value (pi.request-input, "client-42")
  if present: resolve the existing acceptance
  otherwise:
    create accepted input and its required task/queue changes
    set session value (pi.request-input, "client-42") = input ID

commit succeeds, reply is lost
  → caller retries "client-42"
  → same accepted input ID, no second input
```

Lookup and insertion happen inside the serialized command. Core owns these mappings; normal
callers cannot overwrite them. Conflicting key reuse must reject rather than silently accept a
different request; the exact input-equivalence check belongs with acceptance in §8. Mapping a key
to an input does not answer which eventual result belongs to that input.

## 4. State

State is addressed independently of transcript content. Its mutations share the commit sequence,
so a historical boundary selects context and rewindable state together.

### 4.1 Scope and rewind behavior

| Address scope | Rewind behavior | Lifetime |
|---|---|---|
| Session | Sticky; one current value/list | Session |
| Conversation | Rewindable or sticky | Conversation and required fork history |
| Named working scope | Never rewound or inherited | Until explicit retirement |

```ts
const sessionName = sessionValue<string>("pi.session.name");
const plan = conversationValue<boolean>("plugin.plan", { rewind: true });
const expanded = conversationValue<boolean>("ui.expanded", { rewind: false });
const moves = conversationList<Move>("game.moves", { rewind: true });

await conversation.setValue(plan, true);
const enabled = await conversation.getValue(plan) ?? false;
await conversation.appendList(moves, move);
```

Addresses bind namespace, optional key, scope and rewind policy. Payload types come from the
address; writes must not infer a different type to accommodate the supplied value.

```ts
// Value<T> and ValueList<T> denote typed addresses, not wrappers around current data.
interface StateWrites {
  setValue<T>(address: Value<T>, value: NoInfer<T>): Promise<void>;
  appendList<T>(address: ValueList<T>, value: NoInfer<T>): Promise<number>;
}
```

The final interfaces also distinguish address scopes. A conversation address cannot be used as a
session address. Constructors require no global registration; defaults belong at the read site.
Storage persists scope/rewind information rather than depending on token objects surviving restart.
All persisted payloads are strict JSON; callers cannot mutate stored data through returned aliases.

### 4.2 Small mutation vocabulary

```text
value: set(value), delete()
list:  append(value), clear()
read:  getValue(address), readList(address, cursor, limit)
```

An append gets a numeric element ID from its mutation sequence. Baseline lists preserve append
order; they do not support replacing individual elements, inserting in the middle or moving them.
Structured editing uses delta values, as illustrated in §4.5.

```text
rewindable list:
  40 append A
  50 append B
  60 clear
  70 append C

read through 50 → [A, B]
read through 60 → []
read through 70 → [C]
```

Clear hides older elements at and after its position; it does not erase history required by earlier
forks. Deleting a rewindable scalar similarly records absence. JSON null remains a stored value.

Session/sticky state exposes only its current contents. JSONL may still contain previous mutations;
the harness does not interpret them as rewindable history.

### 4.3 Initialization is explicit; a historical fork preserves history

Creating a new subagent conversation chooses initial state independently of context:

```ts
await conversation.spawn({
  prompt: "Inspect the parser",
  context: "inherit",
  values: {
    inherit: [model, thinkingLevel],
    set: [setValue(activeTools, ["read", "grep"])],
  },
});
```

```text
ONE creation command:
  read selected current source values
  create child conversation
  copy selected present values, then apply overrides
  append prompt and create initial generation

unselected plan mode → absent in child
inherited context    → does not imply inherited plugin state
```

This initialization copies values, not a live link to parent state. Subsequent reads have no
unselected parent fallback. An absent selected value stays absent unless overridden. The baseline
selection is scalar-only; lists require an explicit initialization policy, not an accidental copy
of an unbounded log.

A historical fork has a different purpose:

```text
fork A at P:
  rewindable conversation values/lists → inherit all visible history through P
  sticky conversation state           → copy only explicitly selected current values/overrides
  session state                        → same session-wide state, not copied
  working state                        → never inherited
```

The proposed sticky default is no inheritance; callers opt in at creation. Sticky values selected
for copying come from the current source, not P: sticky state is outside the historical snapshot
promise. This is a separate choice from the fork's automatic rewindable inheritance.

### 4.4 Rewindable lookup follows the fork boundary

Only local changes need new records. A historical fork does not copy every scalar version or list
prefix into its own storage rows.

```text
A:  plan=false at 40; plan=true at 80
B:  fork A through 60

read B.plan:
  local version? no
  follow source A, capped at 60
  newest version <= 60 is false

B deletes plan:
  local deletion found → absent; do not fall back to A

B sets plan=true:
  local set found → true
```

At every ancestor, retain the tighter cutoff:

```text
readValue(C, address, cutoff):
  local = newest local version at or before cutoff
  if local is a set: return its value
  if local is a deletion: return absent
  if C has no historical-state source: return absent
  return readValue(C.source, address, min(cutoff, C.sourceBoundary))
```

Lists combine inherited visible ranges and local appends, honoring clear operations and the same
ancestor cutoffs. A list cursor identifies an element position, not an array offset. Fixed asOf
plus cursor/limit gives stable pages while later writes continue.

Memory/JSONL use indexed arrays; SQLite uses indexed version/range queries. Cost may include fork
depth, but not a scan of unrelated session history. An independently initialized child terminates
fallback; a later historical fork of that child inherits its local history normally.

### 4.5 Structured state uses deltas and checkpoints

```text
checkpoint value: { through: 500, state: ... }
delta list:       ... 501, 507, 510, 518 ...

hydrate at P=510:
  read checkpoint visible at P
  read visible deltas after checkpoint.through through P
  apply deltas to privately owned state
```

```text
update, ONE command:
  read/derive from committed state
  append delta batch
  optionally set checkpoint including that batch
commit
publish the updated state
```

The consumer owns the delta vocabulary, reducer and checkpoint cadence. Chord's delta machinery is
a candidate, not a storage dependency decided here. Storage does not execute plugin reducers.
Checkpointing bounds replay only when its cadence is maintained; it does not authorize deleting
older history while arbitrary historical forks remain supported. A live consumer can retain its
current state; it need not hydrate on every edit.

### 4.6 Working state is ordinary state with a named lifetime

```ts
const work = workingScope(String(taskId));
const frames = list<Frame>("pi.pending.frames", { scope: work });
const checkpoint = value<Checkpoint>("pi.pending.checkpoint", { scope: work });
```

```text
working-only commit:
  append frame
  set checkpoint

main settlement commit:
  append immutable result assembled from working data
  settle task
  retireWorkingScope(work)
```

Working values/lists survive restart until explicit retirement. They are not transcript entries,
rewindable state, or a separate scratch-storage API. Keys distinguish attempts so recovery cannot
mistake an earlier request's frames for the current request's output.

```text
allowed commit: main writes, including retirement of working scopes
allowed commit: value/list writes in ONE working scope
rejected:       direct main + working writes, or writes in two working scopes
```

This lets JSONL persist each batch to one file. Main retirement is authoritative; unlink happens
afterward. SQLite can delete working rows inside the main settlement transaction.

```text
crash before settlement → task and working data remain recoverable
crash after settlement  → result and retirement both exist; leftover file is invisible
close                   → no retirement
```

Before settlement, stop admitting progress from that execution and drain already admitted writes.
Late callbacks must be rejected, not allowed to recreate retired task data. Generic scope names
can be reused deliberately; retirement ends the old contents, not every future use of the name.
Storage never guesses retirement from a missing task, task kind or owner status.

## 5. Tasks

A task is durable work associated with one conversation. Its definition supplies behavior; its
stored record supplies the inputs, progress and eventual outcome needed across process lifetimes.

### 5.1 Task records and lifecycle

```ts
type TaskRole = "ready" | "inflight" | "waiting" | "terminal";

interface Task<State = JsonValue> {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly status: string;
  readonly role: TaskRole;
  readonly state: State;
  readonly after: readonly number[];
  readonly foreground: boolean;
  readonly spawnedBy?: number;
  readonly ownedConversationId?: number;
}
```

Timing and cancellation metadata are added in §6. State is validated JSON, not a promise, closure
or process handle. External handles must have a durable representation that recovery understands.

| Role | Meaning | Action when covered by a drive and not executing locally |
|---|---|---|
| ready | Can execute once dependencies and timing/permissions allow | Execute |
| inflight | External-effect intent was committed; outcome may be unknown | Recover |
| waiting | A child or external observer supplies the next transition | Restore observation when needed |
| terminal | Immutable outcome | None |

A definition maps its statuses to these generic roles:

```text
generation:
  pending, retry_wait, deferred → ready
  streaming, polling           → inflight
  done, failed, aborted        → terminal

job:
  planned                     → ready
  spawning                    → inflight
  running                     → waiting
  exited, killed, lost        → terminal
```

The harness derives role from status when validating a write. Storage persists/indexes that generic
metadata so querying live work does not decode every historical task's state or execute kind code.
Role is not independently editable. Terminal records accept no further patches.

### 5.2 Definitions are replaceable units of behavior

```ts
interface TaskDefinition<State> {
  readonly kind: string;
  readonly initialStatus: string;
  readonly roles: Readonly<Record<string, TaskRole>>;
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  validateState(value: unknown): State;
  execute(task: Task<State>, ctx: TaskExecution): Promise<void>;
  recover(task: Task<State>, ctx: TaskExecution): Promise<void>;
  abort(task: Task<State>, ctx: TaskExecution): Promise<void>;
}
```

TaskExecution supplies the execution signal, working scope and serialized command access. Its
concrete surface belongs in §§6 and 9; it is not another durable object.

```text
registry:
  "generation" → custom generation definition
  "tool"       → built-in tool definition
  "post_tools" → custom exchange policy
  "job"        → application process integration
```

The scheduler does not change when a definition changes. A replacement must understand the
persisted statuses/state of its live tasks; incompatible durable formats need an explicit migration.
Unknown live kinds or invalid live statuses reject restoration before execution begins.

A task handles ordinary provider/tool failures according to its policy. Storage failures and
invariant violations are not ordinary tool errors: they fault the session instead of being
swallowed and retried indefinitely.

### 5.3 Dependencies mean terminal, not successful

These traces assume T has a ready-role status and its timing/permissions allow execution.

```text
T.after = [A, B]

A running, B done    → T blocked
A failed,  B done    → T eligible
A aborted, B done   → T eligible unless T itself was cancelled
```

T interprets the outcomes it requires. The scheduler does not propagate success/failure policy
along edges. Referenced tasks must exist, and dependency edits must preserve an acyclic graph.
Dependencies stay within one execution-ownership tree; independent forks do not become runnable
merely because another tree refers to them.

```text
spawnedBy = who created this task       // provenance
after     = which tasks must settle    // execution dependency
```

These are different. A generation can create a collapse task and then depend on it; that provenance
link does not create a dependency cycle.

### 5.4 A generation publishes tools and their join atomically

```text
G returns assistant with calls [A, B]

ONE settlement command:
  append assistant entry
  create tool A
  create tool B
  create P = post_tools, after:[A,B]
  settle G

A settles its own result ─┐
                         ├─ P becomes eligible ─ { settle P; create G2 }
B settles its own result ─┘
```

Each terminal command also records known usage and retires its working scope when present. A tool
settles only itself: no sibling inspection, queue draining or next-generation creation. P owns the
exchange decision and remains foreground even after both tools have settled.

```text
parallel:
  A; B; C; P.after=[A,B,C]

sequential:
  A; B.after=[A]; C.after=[B]; P.after=[A,B,C]
```

Same tools, same join, different dependencies. No tool-specific scheduler lock is required.

```text
crash before G settlement → G remains live; normal recovery applies
crash after G settlement  → assistant, tools and P all exist
crash after last tool     → P already exists; no tail scan or successor repair
```

A final-answer generation either creates its explicit continuation in its terminal command or
ends the chain. An idle user-shaped context does not create work by inference.

### 5.5 A durable wait is not a task-lifetime promise

```text
DO NOT:
  create child task
  await child task's entire lifetime inside this effect

DO:
  commit dependency and continuation state
  return from this effect
  execute the continuation when its dependencies become terminal
```

A foreground tool delegating to a subagent can reuse its own task:

```text
tool execute:
  ONE command:
    create subagent owner S
    set tool status=finishing, after=[S]
  return

S starts child conversation, then returns in waiting status
child final settlement also settles S
existing tool.finishing becomes eligible
  → read S's result
  → run result hooks
  → commit own tool result and terminal status
```

Recovery uses stored tasks/dependencies, not reconstructed chains of waitFor promises. Joining this
process's current execution of the SAME task during cancellation is different; §6 defines that
ordering so effect and abort handlers cannot write concurrently.

### 5.6 Foreground work and detached background work

Foreground is chosen when work is created, not inferred from a tool name or the transcript tail.

```text
local foreground roots:
  generation, its tools, post_tools, automatic collapse

required foreground work:
  those roots + unfinished dependencies
  + required foreground work in their owned conversations

detached background work:
  other live tasks, such as background jobs, schedules and background subagents
```

A task needed by a foreground dependency is part of that required work even if it was not created
as a local foreground root. To detach a launch, return its ID instead of creating such a dependency.
Detailed cancellation selection is defined in §6.

```text
foreground launch:
  { create S; tool finishing after:[S] }
  parent exchange cannot finish until S supplies a result

background launch:
  { create S; tool result contains S.id; settle tool }
  parent exchange can finish while S continues
```

Normal conversation abort targets foreground/required work, not detached background work. The
public API also needs cancellation of a selected background operation and all-background shutdown;
these select cancellation scopes, not arbitrary edits to task status.

### 5.7 Ownership links a task to a child conversation

```text
conversation A
  task S ── owns ──> conversation C
                      generation, tools, post_tools, ...
```

```ts
interface Conversation {
  readonly ownerTaskId?: number;
}
```

S.ownedConversationId and C.ownerTaskId are reciprocal and commit together. Fork provenance does
not establish ownership. Child completion settles its existing owner in the same command when
appropriate; it does not depend on a later notification manufacturing missing work.

An ordinary fork has no owner and no copied tasks. A task can create a child, initialize its chosen
state/context, append its prompt and create its first generation atomically. Starting any of those
effects waits until that creation command is durable.

### 5.8 What every definition must specify

```text
creation      inputs/settings captured; initial status; foreground/dependencies
execution     durable intent before external work; bounded working-state writes
parking       persisted continuation/dependency/observer state; effect returns
settlement    output + usage + terminal state + successors + working retirement
recovery      retry/adopt/interrupted policy for every nonterminal status
cancellation  stop/join own execution; required result/cleanup; no normal successors
```

Normal successor-creating commands re-check current task status and cancellation before committing.
Task-specific cancellation must preserve required result records, such as an error result for an
unexecuted tool call. No definition may depend on the scheduler knowing its domain semantics.

## 6. Scheduling and cancellation

The scheduler executes durable task records. A drive call selects where execution is allowed;
it does not create work or become a second owner of tasks already executing.

### 6.1 Generic scheduling metadata

```ts
interface Task<State = JsonValue> {
  readonly notBefore?: number;               // earliest execution time
  readonly requiredPermit?: string;          // optional host permission, e.g. deferred polling
  readonly abortRequested?: true;            // durable cancellation membership
}

interface DriveOptions {
  readonly permits?: readonly string[];
  readonly signal?: AbortSignal;             // cancels this caller's wait, not durable tasks
}
```

The scheduler tests a permit name, not a provider's polling semantics. A retry stores a timestamp
on the existing task, not a promise that must survive restart.

```text
ready to execute = ready role
                   + every after dependency terminal
                   + notBefore reached
                   + requiredPermit supplied by a covering drive
                   + not cancelled or already executing
```

### 6.2 Drive scopes and outcomes

```text
conversation.drive() → that conversation and descendants reached through task ownership
harness.drive()      → all independent conversation trees

fork provenance     → never expands a drive scope
```

Overlapping callers share one scheduler. Permissions apply only inside the caller's scope; a
polling permit for one tree must not authorize unrelated trees.

| Outcome | Conversation drive | Session drive |
|---|---|---|
| idle | No required foreground work or selected cancellation remains in its tree | No live tasks anywhere |
| suspended | Work remains but needs an outside event/permission | Same |
| closed | Host closed before the requested condition | Same |

A future timer is local progress: wait for it rather than report suspension. An installed human
or process observer can leave the drive suspended. The observer may commit its task's outcome;
subsequent task execution requires a covering drive again.

Foreground completion is rooted at the requested conversation: foreground tasks inside a detached
child do not make its parent busy. Driving that child directly does wait for its own foreground.
A conversation drive services background tasks while active, but does not wait solely for detached
work. Hosts supervising background work drive the session and resume after relevant external events.

### 6.3 One execution claim per task

```ts
interface ExecutionClaim {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}
const executing = new Map<number, ExecutionClaim>();
```

This map owns actual executions, not a mirror of stored tasks. Waiting observers and their re-arm
markers exist only for live waiting phases; discard them on phase exit, settlement or close.
Determine scope membership from live task queries and ownership ancestor point reads, not by
walking every completed child conversation ever created. Temporary ancestor lookups can be shared
within a pass without becoming a permanent resident model.

```text
scheduler pass:
  read live tasks in covered scopes, using bounded indexed queries
  signal EVERY affected executing cancellation target
  reconcile cancellation targets under exclusive claims

  for each unmarked, unclaimed task:
    ready    → test dependencies/time/permit; claim and execute
    inflight → claim and recover
    waiting  → if not armed for this waiting phase: claim and recover to re-arm

  derive caller outcomes from committed state
  await commit | execution completion | next timer | outside notification
```

Claim before launching. Do not await an entire effect inside the scan before considering the next
task. Initial execution can install its observer; recovery must not install a duplicate. A waiting
owner whose child supplies completion needs no subscription and can simply mark re-arming complete.

Effects and observers re-check current task status, cancellation and their execution validity on
the command line before writing. Events wake checks; they are not durable continuation messages.
An unchanged ready task must not be relaunched forever after an unexpected exception: report it
and fault the handle. Ordinary retry belongs in a committed task transition.

### 6.4 Cancellation selects work, then drives cleanup

```text
conversation.abort():
  select current required foreground work (§5.6)

conversation.abortBackground(taskId):
  require a detached background root in this conversation
  select it, unfinished dependencies, and all live work in their owned subtrees

conversation.abortBackground():
  apply that selection to detached background work in this ownership tree
```

The background handle is a task ID, but this is scope cancellation, not permission to terminalize
an arbitrary node or skip its cleanup. A task currently required by foreground work is not detached;
use conversation abort for that chain. Further dependency-sharing policies remain a review point.

```text
ONE cancellation command:
  capture selected task IDs; mark every nonterminal target abortRequested
  for foreground abort, cancel currently queued steer/followUp in affected conversations
  keep context-only writes and nextRun input

repeated abort while the same foreground cancellation is outstanding:
  join existing cancellation; do not drain newly arrived input again
```

The marks survive restart. Do not shrink selection as earlier tasks settle. New foreground input
queues while cancellation is outstanding; normal successors and owned-child creation cannot escape
a marked task. Background cancellation also prevents new work beneath its marked owner.

### 6.5 Join an execution before invoking its abort handler

```text
for each marked task:
  keep/acquire ONE exclusive execution claim
  signal and await its current local execution, if any
  report its rejection; storage faults forbid further writes
  re-read committed task
  if already terminal: release claim
  otherwise: invoke definition.abort under the SAME claim
  release only after cleanup returns
```

Signal all affected executions before waiting on a slow one. Unstarted tasks can abort without
waiting for their normal after dependencies. An uncooperative effect can delay its own cleanup;
a timeout must not silently admit a second writer for that task.

A marked child-conversation owner settles only after its selected child work is terminal. The
scheduler waits for that condition, not an effect-held child-lifetime promise. Child completion
checks the owner's cancellation mark before publishing success. Direct foreground abort of an
owned child must also complete its owner as cancelled. That child drive may finish cancellation
of its marked owning task after selected child work is terminal, even though the owner record is
in the parent. It must not start other parent effects; parent-side continuation requires a covering
drive of the parent.

```text
post_tools settlement wins:
  { settle P; create G2 } → abort selects G2

abort wins:
  { mark P } → P.abort settles without G2
```

Task-specific error/result records still belong to task handlers. Cancellation does not synthesize
provider messages or interpret tool arguments in the scheduler.

### 6.6 Open, close, shutdown and deletion

```text
open:
  open storage; validate live task definitions
  expose inspect(), state and transcript queries
  start no provider, tool or process effects

close:
  seal public/effect admission
  signal local executions; stop observers/progress admission
  wait for cooperative executions and admitted persistence
  release storage; write no cancellation or terminal outcomes

harness.shutdown:
  seal public admission but allow internal cancellation commands
  mark ALL live session work, including background and owned descendants
  cancel all queued inputs, including write/nextRun; preserve their immutable history
  drive selected cancellation to settlement
  close
```

Close itself adds no outcomes; commands already admitted before its barrier can still complete,
including terminal settlements. It interrupts local execution, not necessarily an external process
that can be adopted later. Shutdown uses each kind's abort policy to stop external work where supported. A crash during
shutdown leaves durable cancellation marks for the next owner to reconcile.

Observer-wait cancellation only removes that caller's drive interest; it never signals shared
executions as if the conversation were aborted. Close remains cooperative and may block on a
broken external integration. Bounded-close/forced-process policies need an explicit host contract.

Deleting a conversation is a separate atomic mutation: reject while its ownership subtree has
live work. Once deleted, reject new work there. Preserve immutable history and source metadata
needed by independent forks; logical deletion is not permission to erase their inherited data.

## 7. Storage

One storage interface answers entity/state queries and commits atomic mutation batches. There is
no public journal reader, separate read-index interface, scratch store or payload-address system.

### 7.1 Store the information queries need

Complete the conversation snapshot with its historical source and context-replacement revision:

```ts
interface Conversation {
  readonly source?: { readonly conversationId: number; readonly asOf: number };
  readonly inheritState: boolean;
  readonly prefixRevision: number;
}

interface Entry {
  readonly metadata?: JsonObject;             // small preview/attribution/exchange fields
  readonly key?: string;                      // optional indexed content key, not a state address
  readonly byTaskId?: number;
}
type EntryHeader = Omit<Entry, "content">;
```

Source links cap inherited transcript access. Historical forks also set inheritState=true;
independently initialized children set it false even when inheriting context. Owner links remain
separate. Source and ownership identity are not arbitrary mutable configuration.

Current context is materialized. Its historical edits are retained. Prefix replacement/reset bumps
prefixRevision; append does not. Task role, conversation ID and scheduling fields are queryable
without decoding kind-specific state. Entry metadata permits exchange checks without loading large
message/image content.

### 7.2 Queries, motivated by callers

| Caller | Required read | Must not do |
|---|---|---|
| Scheduler | Live tasks in a scope; dependency IDs in one batch | Load terminal task history |
| Generation | Current context IDs, then those entries in a batch | Reconstruct context by scanning transcript |
| UI | Transcript page before/after an ID, with a limit | Load the whole conversation |
| Validation | Named task/conversation records and entry headers | Load unrelated message content |
| Fork | Entry commit boundary; historical context/state | Truncate today's context |
| State consumer | Latest value/version; bounded list range | Replay unrelated journal records |
| Background status | Task and named result entry | Keep an ancient task resident forever |
| Reopen on SQLite | Live tasks and required conversations | Replay all historical task transitions |

Filters apply before limits. Latest matching record means an indexed descending query with limit=1,
not loading a collection and taking its last item. Conversation batch reads matter just as entry
and task batch reads do.

```ts
interface CursorPage {
  readonly after?: number;
  readonly before?: number;
  readonly order?: "asc" | "desc";
  readonly limit: number;
}
interface Page<T> {
  readonly items: readonly T[];
  readonly asOf: number;
  readonly next?: number;
}
interface ConversationQuery extends CursorPage {
  readonly sourceConversationId?: number;
  readonly ownerTaskId?: number;
}
interface EntryQuery extends CursorPage {
  readonly conversationId: number;
  readonly kind?: string;
  readonly key?: string;
  readonly asOf?: number;
}
interface TaskQuery extends CursorPage {
  readonly conversationIds?: readonly number[];
  readonly live?: boolean;
  readonly role?: TaskRole;
  readonly kind?: string;
  readonly foreground?: boolean;
  readonly abortRequested?: boolean;
}
interface ListQuery extends CursorPage { readonly asOf?: number }
interface StoredValue<T> { readonly seq: number; readonly value: T }
interface ListElement<T> { readonly id: number; readonly value: T }
interface CommitBoundary { readonly first: number; readonly last: number }
```

Transcript queries return the effective inherited prefix plus local entries; each entry retains
its original conversationId. Tasks are never inherited by that query convention. Historical state
uses §4's capped source traversal. A page cutoff is not a generic timestamp for every data class:
sticky state and task scans expose current state, not historical snapshots. Transcript/rewindable
pages carry a main boundary; current task/sticky/working pages carry a global observation cutoff,
which is not a fork target. Historical reads on sticky/working addresses reject. Coherent current
multi-page reads use the command line; a cursor alone does not freeze mutable sticky contents.

### 7.3 One interface, no second transaction layer

```ts
interface Storage {
  readonly head: number;                       // global allocator high-water mark
  readonly mainHead: number;                   // last main commit, not another allocator
  commit(batch: CommitBatch): Promise<CommitBoundary>;

  getConversations(ids: readonly number[], asOf?: number): Promise<ReadonlyMap<number, Conversation>>;
  scanConversations(query: ConversationQuery): Promise<Page<Conversation>>;
  getEntries(ids: readonly number[]): Promise<ReadonlyMap<number, Entry>>;
  getEntries(ids: readonly number[], options: { content: false }): Promise<ReadonlyMap<number, EntryHeader>>;
  scanEntries(query: EntryQuery): Promise<Page<EntryHeader>>;
  getTasks(ids: readonly number[]): Promise<ReadonlyMap<number, Task>>;
  scanTasks(query: TaskQuery): Promise<Page<Task>>;

  getValue<T>(address: Value<T>, asOf?: number): Promise<StoredValue<T> | undefined>;
  scanValues(query: ValueQuery): Promise<ValuePage>;
  readList<T>(address: ValueList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  close(): Promise<void>;
}
```

ValueQuery is a bounded scope/namespace scan ordered by address key; its cursor is an address key,
not a numeric entity cursor. ValuePage returns addresses with their current visible values. No
arbitrary predicates, plugin reducers, user comparators or general SQL expressions cross this API.
State tokens arrive with their conversation/working identity bound; scope-specific receiver shapes
are shown in §9.

Each logical read, including ancestor traversal, observes one committed state. The session command
line supplies coherent multi-read operations and read-modify-write; no second public storage
transaction callback is needed. Historical context reads affect context, not current sticky state.
Tasks remain current even when their originating entries are old.

### 7.4 Atomic mutations

```text
main mutation vocabulary:
  createConversation, deleteConversation
  appendEntry, createTask, patchTask
  appendContext, replaceContextPrefix, resetContext
  setValue, deleteValue, appendList, clearList
  retireWorkingScope

working mutation vocabulary:
  setValue, deleteValue, appendList, clearList
```

```ts
interface CommitBatch {
  readonly scope: "main" | { readonly working: string };
  readonly writes: readonly Write[];           // tagged mutations above; each has its final seq
}
```

```text
harness command:
  read committed state; construct mutations and IDs
  validate against committed state + earlier writes in this batch
  no mutations → return builder result without a storage commit
  otherwise persist one batch
  notify observers; resolve caller

storage commit:
  check scope, supplied sequences and structural constraints
  prepare only touched data/index changes
  persist atomically
  publish new query-visible state and heads together
```

Task definitions validate status transitions/state; the harness enforces ownership, dependency,
context and admission rules. Storage stores the validated generic records without running kinds.
Rejected construction changes nothing. An admitted failure faults the handle (§3.5). Cancelling a
caller after persistence admission must not abandon the transaction or expose half a batch.

### 7.5 Memory and JSONL: the same queries, with optional files

```text
current maps:  conversations, tasks, scoped values/lists
ordered data: entries per conversation, state versions, context edits
lookup maps:  IDs, addresses, live-task membership, source/owner relationships
```

Memory applies prepared changes without exposing intermediate state. Indexes may reference the
same immutable payload objects; they need not duplicate content. JSONL uses that representation
and loads it fully on open.

```json
{"first":100,"last":103,"writes":[
  {"type":"appendEntry","conversationId":1,"kind":"user","content":"Inspect"},
  {"type":"appendContext","conversationId":1,"ids":[100]},
  {"type":"setValue","conversationId":1,"namespace":"plugin.plan","value":true},
  {"type":"createTask","conversationId":1,"kind":"generation","status":"pending"}
]}
```

Shown across lines for reading; the file contains one complete line per batch. This is illustrative
encoding, omitting address/task fields. A compact encoding may derive each stored seq from first+i;
logical writes already carried their final IDs before encoding.

```text
JSONL commit → encode whole batch → write all bytes + newline → publish in-memory changes
JSONL open  → validate complete batches → rebuild maps/indexes → expose queries
```

Do not publish in-memory changes before the write completes. Handle short writes. Discard only an
unterminated final batch; malformed complete lines fail open rather than silently deleting history.

```text
session.jsonl                    main batches
session.scopes/<encoded-id>       working batches for one named scope
```

On open, compute global high-water from all complete main/working batches before cleanup. Main
retirement hides that scope's records through its retirement seq. Later deliberate reuse survives;
serialize old unlink before reuse so delayed cleanup cannot delete a new lifetime. Only explicit
retirement authorizes cleanup. Process-crash durability is required; fsync/power-loss policy is an
explicit backend option, not a claim that ordinary writes are immune to power loss.

### 7.6 SQLite: queryable rows, not mandatory raw-journal replay

```text
conversations / current_context_elements
entries
tasks                                     // current records, including terminal outcomes
current_values / value_versions
list_elements / historical_clear_markers
context_edits
commit_boundaries / session_metadata
```

Every shared-container key starts with session ID. Suggested indexed suffixes:

```text
entries             (conversation, id), (conversation, kind, key, id)
tasks               (role, id), (conversation, role, id)
values              (scope, namespace, key)
value_versions      (conversation, namespace, key, seq)
list_elements       (scope, namespace, key, id)
context_edits       (conversation, seq)
conversations       (sourceConversationId), (ownerTaskId)
```

Live scans also need ordered partial indexes, for example (session_id, id) WHERE role != 'terminal',
so scanning across nonterminal roles does not sort all task history. Additional combinations follow
actual query plans, not an index for every possible filter.

```sql
-- One local step in a rewindable scalar lookup.
SELECT seq, deleted, value
FROM value_versions
WHERE session_id = :session AND conversation_id = :conversation
  AND namespace = :namespace AND key = :key AND seq <= :cutoff
ORDER BY seq DESC LIMIT 1;
```

```text
BEGIN
  validate global head
  insert entry 100 with commit_end=103
  append context element 100; retain context edit 101
  insert rewindable value version 102
  insert current task 103 with indexed role
  record main boundary 103; advance global head
COMMIT
```

No full transcript/context rewrite per append. Current context can use ordered element rows;
prefix replacement removes the selected prefix and inserts its head without rewriting the retained
suffix. A historical fork stores a source link and its initial context, not copies of source entry
or value/list inventories. Sticky updates overwrite current contents; working retirement deletes
working rows inside the settlement transaction. Retain only the histories the API promises.

### 7.7 Historical context is not today's context minus later IDs

```text
contextAsOf(C, P):
  start from latest reset <= P, otherwise C's initial context
  page later context edits through P in order
  append  → extend
  replace → replace named prefix, keeping the existing suffix
  reset   → replace whole list
```

A replacement is not a full checkpoint: it says nothing about the retained suffix's earlier
appends. The baseline replay may span from creation/reset; it is correct but not necessarily cheap
for ancient forks. Indexed context checkpoints can optimize it later if measurements justify them.
Current generation requests use the materialized context instead of this historical path.

## 8. Built-in task flows

These are task definitions and boundary policies, not scheduler special cases. Braces below group
one main commit. Every attempt outcome includes its reported usage; terminal outcomes retire their
working data. Hooks and external calls run outside the command line.

### 8.1 Acceptance, placement and result ownership

Proposed input representation: use an immutable admission entry as the input identity. Idle input
can be a selected user entry directly; busy input is unselected until a later placement entry.

```text
idle accept A:
  { user A with inline message; select A; G.inputs=[A]; result[A]=running }

busy accept B:
  { unselected input B with inline message; enqueue B; result[B]=queued }

later consume B:
  { user placement U referring to B; select U; dequeue B;
    create G2.inputs=[B]; result[B]=running }
```

The placement is new, so context remains in transcript order. Its message is resolved from B's
immutable content, not copied into another stored payload. Projection batch-loads such references;
placement references point directly to admission entries, never chains of placements. UI rendering
can distinguish arrival from placement rather than displaying the same message twice.

Queues use ordinary sticky values under conversation namespaces, one address per queued input.
Separate namespaces identify queue modes; fixed-width decimal input-ID keys preserve numeric
admission order in bounded key scans. Dequeue deletes the current queue value; it does not require
rewriting a growing inbox array or retaining consumed queue rows.
Session-scoped input-result values preserve each acceptance's outcome independently of that queue.

```text
G1.inputs=[A]
B queued while G1 runs
G1 produces final answer R

{ result[A]=done(R); settle G1;
  place B; dequeue B; G2.inputs=[B]; result[B]=running }

result(B) is NOT R just because R was appended after B's admission
```

At a tool boundary, newly consumed steering joins the current pending input group. A yield hook's
continuation also retains that group. Only a completed answer/stopping boundary resolves it.
Follow-ups consumed after an answer start a new group. Several inputs can legitimately share one
answer. Carry input IDs through generation/post_tools state, not through a new durable run object.

```ts
type InputResult =
  | { readonly status: "queued" | "running" }
  | { readonly status: "done" | "placed"; readonly entryId: number }
  | { readonly status: "cancelled" | "failed" | "stopped"; readonly reason?: string; readonly entryId?: number };
```

Placed is the terminal receipt for a context-only write, not an assistant answer. Cancelling a
queued input records cancelled; cancelling an active chain resolves its pending inputs in the
terminal boundary command. Retrying/deferred tasks leave them running. Session-wide request keys
resolve the original admission; reusing a key for another conversation or different normalized
semantic input rejects. Harness-generated metadata is not part of input equivalence.

This representation/result contract is proposed for review. It avoids chronological attribution,
a new input table, and duplicate message payloads; it does add placement records for queued input.

### 8.2 Queue boundaries

| Input mode | When it can be placed | Requests generation? |
|---|---|---|
| write | Next safe context boundary | No |
| steer | Next tool or final-answer boundary; explicit idle acceptance | Yes |
| followUp | Normal final-answer boundary; explicit idle acceptance | Yes |
| nextRun | Next explicit idle acceptance only | Yes |

```text
idle acceptance:
  place eligible queued items, then new input
  create ONE generation with all selected trigger IDs

post_tools:
  place safe writes and selected steering
  continue current input group unless cancelled/terminated

final-answer generation:
  if yield hook continues: retain current input group
  otherwise resolve current group with this answer
  eligible steer/followUp → place them and create next group/generation

failure/termination:
  resolve current group; do not consume triggers with no successor

foreground abort:
  cancel queued steer/followUp; preserve write/nextRun
```

Steering/follow-up modes select all eligible items or one oldest item of each mode. Preserve
admission order among selected items. Safe write placement never becomes a hidden run request.
Selection, placement, dequeue, result-state changes and required generation creation share a commit.
Queued input takes precedence over an old yield decision; stale hook preparation is discarded.

### 8.3 Generation

```text
create:
  capture model, thinking, tools, provider options and retry policy
  persist inputs and pending status

pending/retry execution:
  check current status/cancellation and request/exchange exclusion
  completed captured collapse → interpret its outcome once; do not recreate it on every retry
  live collapse → attach dependency and return
  automatic collapse needed → create C and G.after=[C] together; return
  capture main historical context boundary; commit streaming intent
  project context; apply before_request; re-check execution validity
  call provider; persist frames under this attempt's working keys

outcome:
  calls        → { assistant; tool tasks; post_tools with inputs; settle G }
  final answer → { assistant; resolve/continue inputs; settle G; required successor }
  deferred     → { usage; same G.deferred(handle), requiredPermit="deferred-poll" }
  retryable    → { usage; same G.retry_wait, attempt+1, notBefore }
  overflow     → { usage; same G waiting on one captured collapse retry }
  failure      → { partial/error if needed; resolve inputs failed; settle G }
```

A generation task exists throughout preflight/collapse/retry. Retries do not create a replacement
with a fresh budget. Polling records intent before fetching the stored handle; another deferred
response updates the same task. Transitions clear permit/timing metadata that no longer applies;
a normal retry must not accidentally retain a deferred-poll requirement. Poll permits and retry
timestamps remain generic scheduler data.
Known usage commits even for failed, deferred or discarded attempts; no report means unknown cost,
not zero and not an exactly-once billing guarantee.

```text
recover polling   → deferred; retain handle and budget
recover streaming → committed partial: publish interrupted outcome + required call errors
                    no partial: retry within budget or fail
abort             → drain frames; best-effort provider cancellation; required partial/results;
                    resolve pending inputs cancelled; no tools or normal successor
```

The interrupted-stream policy and provider-specific retry/overflow classification need parity
review. Do not catch persistence/invariant failures as provider errors. A never-started generation
has no fabricated assistant response. Stop reasons containing unusable/truncated calls still need
error results without invoking those tools.

### 8.4 Tool execution and post_tools

```text
tool execute:
  validate offered-tool authorization and arguments
  before_tool → allow | block | hold
  allow → commit running intent with effective args and replay policy
          invoke tool with execution signal, identity and bounded sink
  block/truncated/missing → prepare own error result without external invocation
  run after_tool outside line
  { own result; usage; active-tool additions; control intent; settle tool }
```

Registry presence is not authorization: the generation must have offered the tool. Persist the
actual arguments/replay decision before invocation. Ordinary throws produce error results, not
cancellation. Capture terminate/handoff intent in the outcome; the tool does not reset context or
inspect siblings. Foreground delegation uses the finishing phase in §5.5.

```text
recover → replay only when captured AND current tool policy permit it;
          otherwise interrupted result from checkpoint, no uncertain control side effects
abort   → join own execution; drain working writes; own aborted error result
```

```text
post_tools, ONE command:
  require all calls terminal; re-check its cancellation
  read outcomes and choose exchange policy
  stopped → resolve current inputs stopped/cancelled; no successor
  continue → place eligible writes/steering; apply valid handoff; create G2 with inputs
  settle post_tools

post_tools.abort:
  { resolve its pending input group cancelled; settle post_tools }
  no context edit, trigger consumption or successor
```

A new_context tool returns handoff intent. The join appends/selects that handoff and resets context
only after the exchange is complete. Ordinary errors can still be followed by generation. The draft
uses any terminate request to stop; conflicting handoffs reject the handoff rather than choosing
completion order. These policies are reviewable independently of the join mechanism.

### 8.5 Collapse, including speculative completion

```text
create C:
  capture complete prefix, through, prefixRevision, historical context and model/settings
  allow one live collapse per conversation; generation can depend on that existing C

execute:
  commit summarizing intent → call summarizer
  persist complete candidate, including reported usage, in working scope
  { usage; candidate reference/phase identifying that the attempt outcome was recorded }
  editable context + matching prefix → { summary; replace prefix; settle C }
  stale prefix/cancelled             → terminal outcome without context publication
  context busy                      → park C waiting for an editable-context predicate
```

The parked task restores an observer that checks committed context/request state, then makes C
ready to publish. Events only wake that check. Re-check prefix and editability in the publishing
command; do not record usage twice.

**Do not wait for a generation's terminal status to make context editable:** a retry can keep the
same generation alive while it waits for C. That would form a deadlock. The context predicate,
not the generation's lifetime, controls speculative publication.

```text
G retry_wait after:[C]   → no provider request in flight
C sees editable context → publish and settle
G becomes eligible      → retry with new context
```

Recovery reuses a durable complete candidate or retries within budget. Abort records known usage
and settles without replacement. C never creates G. Failed/declined overflow compaction ends the
bounded overflow retry; threshold/manual failure can leave G using unchanged context.

### 8.6 Subagent and approval

```text
subagent owner S:
  { child with owner=S; selected initial state; prompt; first generation; S waiting }
  return

child terminal foreground boundary:
  { its output/input outcomes; terminal child task; settle S with result reference }
```

For inherited subagent context, the proposed default is the last complete-exchange boundary before
the launching exchange, not its unresolved calls. Selected initial values still come from the
creation command. This is initialization, not a historical fork claiming one state/context snapshot.
Recovery drives the existing child tasks; it does not recreate the child or await a child-lifetime
promise. Cancellation completion follows §6.5 and must not report success for a marked owner.

```text
hold tool:
  { create approval A; tool waiting after:[A] }

grant:
  { A granted; matching tool ready with approved arguments }

deny:
  { A denied; matching tool finishing with denial outcome }
  tool runs its result hooks, writes own result and settles
```

Approval recovery restores the human decision surface; it never grants automatically. Cancellation
marks the approval and its required tool independently. Grant/deny versus abort is serialized;
late decisions cannot restart terminal work.

### 8.7 Jobs and schedules

```text
job:
  { spawning intent with durable adoption/log identity }
  spawn or reconcile existing process
  { running with verified process identity }
  install output/exit observers; return

exit:
  drain output → { immutable result; usage if reported; terminal job }
```

Recovery adopts the same process, or records lost if its outcome cannot be recovered. PID alone is
not identity. Abort stops the process through its host service, drains output and records killed.
Close detaches local observation; an adoptable external job can survive it. Process launch/exit
reconciliation and log retention are explicit host capabilities, not storage guesses.

A recurring schedule needs a stable cancellation handle, not a trail of successor IDs:

```text
schedule S ready at notBefore:
  { create action J; S collecting after:[J] }
  return

J terminal → S collecting:
  { record outcome reference;
    S scheduled with next notBefore and after:[], or terminal if complete }
```

The action can be a job or subagent owner. S remains the background root; cancellation includes
its unfinished dependency J and owned work. Recurrence and missed-run policy are persisted;
positive intervals and bounded catch-up prevent a restart from launching an unbounded backlog.
Recovery uses the stored timestamp/dependency; it must not create a second J while collecting.
Abort settles S without recurrence. Captured cancellation marks keep its action/owned work selected
even if S settles first; S does not hold an abort promise across J's lifetime.

### 8.8 Hooks are preparation or observation, not another scheduler

| Point | Decision |
|---|---|
| before_request | Transform the prepared request |
| after_response | Observe provider outcome |
| before_tool | Allow, block with result, or hold for approval |
| after_tool | Process/observe this tool's result |
| on_yield | Stop or request explicit continuation |
| before_collapse | Allow with instructions or decline |

Run hooks outside the command line, then revalidate their decisions before committing. Hooks may
repeat after a crash; external hook side effects need their own idempotence. Commit listeners,
unlike hooks, must not await another command on the same serialized line.

Hook ordering, transformation rights and exception policy need an explicit compatibility decision;
the task chain does not settle those questions. Cancellation suppresses yield/normal successor
creation even when a hook was already preparing a continuation.

## 9. Public API and observation

The earlier shapes describe stored snapshots and behavior. Handles issue commands; they are not
stored conversation objects. These sketches assemble those surfaces without requiring a second
state model or exposing backend layout.

### 9.1 Conversation and session handles

```ts
interface Accepted { readonly inputId: number }
type HistoryTarget = { readonly atEntry: number } | { readonly asOf: number };
type DriveOutcome = "idle" | "suspended" | "closed";

interface ConversationHandle {
  readonly id: number;
  snapshot(): Promise<Conversation>;
  accept(input: AgentInput, options?: { requestId?: string }): Promise<Accepted>;
  result(inputId: number): Promise<InputResult | undefined>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  prompt(input: AgentInput, options?: { requestId?: string }): Promise<{ inputId: number; result: InputResult }>;

  appendMessage(message: AgentMessage): Promise<Accepted>;  // context only; may queue
  steer(input: AgentInput): Promise<Accepted>;
  followUp(input: AgentInput): Promise<Accepted>;
  nextRun(input: AgentInput): Promise<Accepted>;
  cancelQueued(inputId: number): Promise<"cancelled" | "already_consumed" | "not_found">;

  abort(): Promise<void>;                                  // durable intent; drive performs cleanup
  abortBackground(taskId?: number): Promise<void>;
  collapse(options?: { instructions?: string }): Promise<number>;
  resetContext(ids: readonly number[]): Promise<void>;
  fork(target: HistoryTarget, options?: { sticky?: Initialization }): Promise<ConversationHandle>;
  rewind(target: HistoryTarget, options?: { keepRunning?: boolean; sticky?: Initialization }): Promise<ConversationHandle>;
  spawn(options: SpawnOptions): Promise<number>;            // subagent owner ID; no effect starts here

  getValue<T>(address: ConversationValue<T>, asOf?: number): Promise<T | undefined>;
  setValue<T>(address: ConversationValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: ConversationValue<T>): Promise<void>;
  appendList<T>(address: ConversationList<T>, value: NoInfer<T>): Promise<number>;
  clearList<T>(address: ConversationList<T>): Promise<void>;
  readList<T>(address: ConversationList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  command<T>(build: (tx: ConversationCommand) => T | Promise<T>): Promise<T>;
}

interface Harness {
  root(): Promise<ConversationHandle>;
  conversation(id: number): Promise<ConversationHandle | undefined>;
  conversations(query: ConversationQuery): Promise<Page<Conversation>>;
  inspect(): Promise<{ ready: readonly Task[]; inflight: readonly Task[]; waiting: readonly Task[] }>;
  drive(options?: DriveOptions): Promise<DriveOutcome>;
  entry(id: number): Promise<Entry | undefined>;
  entries(conversationId: number, query: CursorPage): Promise<Page<Entry>>;
  task(id: number): Promise<Task | undefined>;
  getValue<T>(address: SessionValue<T>): Promise<T | undefined>;
  setValue<T>(address: SessionValue<T>, value: NoInfer<T>): Promise<void>;
  deleteValue<T>(address: SessionValue<T>): Promise<void>;
  appendList<T>(address: SessionList<T>, value: NoInfer<T>): Promise<number>;
  clearList<T>(address: SessionList<T>): Promise<void>;
  readList<T>(address: SessionList<T>, query: ListQuery): Promise<Page<ListElement<T>>>;
  command<T>(build: (tx: Command) => T | Promise<T>): Promise<T>;
  command<T>(scope: WorkingScope, build: (tx: WorkingCommand) => T | Promise<T>): Promise<T>;
  watch(conversationId: number, options: { limit: number }, listener: (event: WatchEvent) => void): Promise<() => void>;
  decideApproval(taskId: number, decision: "grant" | "deny"): Promise<void>;
  deleteConversation(id: number): Promise<void>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}
```

AgentInput is string/user-message/message-batch input normalized at acceptance. AgentMessage and
provider model/usage types reuse the existing agent/pi-ai boundary. Initialization is the typed
scalar selection/override shape in §4.3; SpawnOptions adds prompt and fresh/inherit context.
These are proposed signatures, not new copies of provider message types. Direct spawn creates a
detached owner; foreground tool delegation makes that work required through its dependency.

Prompt accepts, drives while observing that input, and returns its result when terminal or progress
suspends/closes. It never substitutes another input's answer. Rewind normally requests/drains source
foreground cancellation before forking; keepRunning leaves source work alone. Validate the target
before cancellation so an invalid history request does not abort otherwise valid work.

### 9.2 Commands return results only after commit

Command exposes the mutations from §7.4 and read-only storage queries. Creation/list-append methods
return final numeric IDs immediately inside the builder; the outer command resolves only after
persistence and publication. ConversationCommand binds the conversation automatically. WorkingCommand
exposes only value/list writes, checked against one exact scope ID.

```ts
await conversation.command(async tx => {
  const current = await tx.getValue(plan) ?? false;
  tx.setValue(plan, !current);
});

const entryId = await harness.command(tx => {
  const id = tx.appendEntry(conversationId, "note", content);
  tx.setValue(labelAddress(id), "checkpoint");
  return id;
});
// entryId can escape here, not during the builder
```

Reads see pre-command committed state; validation applies buffered mutations in order. Buffer
construction does not perform external effects or publish plugin state. A throwing builder discards
its mutations. Runtime checks supplement token typing for strict JSON, address policy and exact
working-scope identity; changing an established address's rewind policy is not an implicit migration.

### 9.3 Task and tool integration

```ts
interface TaskExecution {
  readonly signal: AbortSignal;
  readonly workingScope: WorkingScope;
  readonly services: TaskServices;
  command<T>(build: (tx: Command) => T | Promise<T>): Promise<T>;
  command<T>(scope: WorkingScope, build: (tx: WorkingCommand) => T | Promise<T>): Promise<T>;
  observe<Event>(
    subscribe: (notify: (event: Event) => void) => () => void,
    reconcile: (event: Event | undefined, ctx: TaskExecution) => Promise<void>,
  ): void;
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;                 // provider-compatible JSON Schema
  readonly replay?: "safe" | "never";
  execute(args: JsonObject, ctx: ToolExecution): Promise<void | ToolDelegation>;
}
```

TaskServices supplies models, registered tools, hooks and host resources. ToolExecution supplies
invocation/call identity, the signal and bounded output/checkpoint/memo access using ordinary working
values/lists. The tool schema validates arguments before invocation. ToolDelegation identifies a
subagent/job launch and foreground/background choice; it does not contain an in-process promise.

```text
tool output surface:
  write text / add image       → durable bounded progress; capped final result
  set details / report usage   → final result/attempt metadata
  addTools / terminate / handoff → control intent interpreted at settlement/boundary
  checkpoint / typed memo      → ordinary working values, retired with that execution
```

Output backpressure must be explicit: await admitted progress or use a bounded buffer drained before
settlement. Delta frames/checkpoints must not silently rewrite an entire growing assistant message
for every token. Caps, image handling and durable log references are part of tool policy.

Observe installs a live-phase subscription, not another executor. Each reconciliation receives a
fresh execution context/signal under the same per-task claim used by effects/recovery/abort. Register
before an initial reconciliation with event=undefined, so an already-satisfied condition is not lost.
Events arriving during a claim queue/coalesce within a bounded policy. Phase exit/cancellation seals
and drains admitted callbacks. A stale callback cannot write through an expired context. Waiting
recovery restores missing subscriptions, not duplicates. Teardown and settlement are distinct.

### 9.4 Watch committed state without gaps

```text
ONE serialized step:
  capture main/global observation boundaries
  read conversation, bounded transcript page, live task metadata,
       queued-input state and requested reduced working previews
  register listener

then:
  deliver relevant main commits as whole batches
  deliver committed working previews and transient notifications separately
```

```text
base    { conversation, entries, referencedInputs, tasks, queued, previews, asOf }
commit  { firstSeq, lastSeq, changes:[...] }
preview { taskId, kind, value }
signal  { kind:"fault" | "handler_error" | "idle", ... }
```

This union is WatchEvent. Entry pages use immutable IDs and a cutoff for deduplication. Commit
filtering can omit unrelated changes but must preserve batch boundaries; clients publish after
reducing the complete delivered batch. A terminal task and its successor must not appear as an
observable idle gap.

Batch-load admission payloads referenced by visible placement entries into referencedInputs; they
need not appear as extra transcript rows. Arbitrary plugin state is hydrated by its explicit state
consumer, not automatically by a transcript watch. A commit listener cannot await a new command on
the same line; schedule it after delivery. Listener exceptions do not undo commits. Slow-consumer
buffering is bounded; a disconnected/lagging client can rebind from a fresh base.

If a Chord adapter needs consecutive revisions, those belong to its live binding:

```text
main commits 104, 117, 130 → binding updates 1, 2, 3
rebind/rewind              → fresh base, update counter starts again
```

Journal gaps are not transport gaps. Do not persist another state-sequence allocator. The adapter
publishes only after durable commit and rejects events from retired bindings; its concrete codec
and private-draft integration remain to be chosen.

### 9.5 End-to-end usage

```ts
const h = await Harness.open(storage, hostOptions);
const c = await h.root();
const off = await h.watch(c.id, { limit: 100 }, render);

const accepted = await c.accept("Inspect the parser", { requestId: "web-42" });
const outcome = await c.drive();
const result = await c.result(accepted.inputId);
if (result?.status === "done") show(await h.entry(result.entryId));
// suspended: wait for the needed event/permission, then drive again
```

```ts
// Cancellation is durable intent; keep or start a drive for cleanup.
const driving = c.drive();
await c.abort();
await driving;
await c.drive();                              // also covers a previously idle/suspended drive

const child = await c.spawn({
  prompt: "Inspect only tests",
  context: "fresh",
  values: { inherit: [model], set: [setValue(activeTools, ["read"])] },
});
await h.drive();                              // supervise detached work too; may suspend on outside events
console.log(await h.task(child));

const alternate = await c.fork({ atEntry: completedAnswerId });
await alternate.accept("Try a different implementation");
await alternate.drive();                     // source and unrelated forks remain parked

off();
await h.close();
```

Harness.open receives storage, task definitions, tools/model services, hooks/resources and initial
root values. It creates root plus initial values only for empty storage. Reopening existing storage
creates no new work. Host invocation cancellation/telemetry should be threaded through these calls,
not replaced with a separate tracing or cancellation framework.

## 10. Validation, performance and review decisions

This is a design, not a claim of implementation or benchmark parity. Tests should prove behavior
from committed state, then benchmarks should measure equivalent work under the chosen guarantees.

### 10.1 Backend conformance from the same mutation stream

```text
validated batches ─┬─ reference replay used only by tests
                   ├─ Memory
                   ├─ JSONL → close → reopen
                   └─ SQLite → close → reopen

compare:
  current objects and generic live-task metadata
  transcript pages and inherited prefixes
  historical contexts, scalar tombstones, list clears/ranges
  input/request mappings and result outcomes
  visible working lifetimes and next allocated sequence
```

Reference replay is a test oracle, not a required public storage API. Use randomized small histories
and explicit deep-fork cases. Include value-only commits, multi-entry commits and independent child
initialization so message-only tests cannot accidentally pass a broken history implementation.

```text
fork before/after a value delete → correct absence/fallback
fork before/after list clear     → correct inherited ranges
fork before a later summary     → earlier context, not today's filtered context
nested source cutoffs            → no later ancestor version leaks
sticky state                    → unchanged by historical reads; explicit copy on creation
```

### 10.2 Failure and concurrency matrix

| Scenario | Required observation |
|---|---|
| Persistence paused after construction | Queries/watchers still see the old complete state |
| Commit durable but caller reply lost | Reopen sees the whole batch; keyed retry reuses the input |
| Main + working writes in one batch | Reject without partial mutation |
| Torn final JSONL batch | Discard only that incomplete tail |
| Malformed complete JSONL batch | Fail open, never truncate valid later history silently |
| Retirement committed, unlink fails | Old working contents remain invisible |
| Reused scope, delayed old cleanup | New lifetime survives |
| Effect returns while abort starts | One claim covers effect join and abort reconciliation |
| Parallel tools settle in either order | Existing join becomes ready; exactly one continuation |
| Abort versus join/final settlement | No unmarked successor escapes the selected cancellation |
| Child finishes during owner cancellation | No success outcome overwrites cancellation |
| Observer notification during close | Drain/reject by admission order; no late terminal overwrite |
| Two overlapping drives | One execution per task; permissions stay scoped |
| One drive caller cancels its wait | Other callers and durable task intent are unaffected |
| Queued B precedes A's answer in transcript | B remains pending until its own group completes |
| Provider retry while collapse waits to publish | No generation/collapse dependency deadlock |
| Watch registration races a commit | Base includes it or the stream delivers it, never neither |

Use faux providers, fake processes/clocks and storage barriers. No real providers or paid tokens.
Exercise both durable orders, not a test that happens to win the same race every time. Validate
that failed/no-op commands consume no IDs and that old task IDs remain queryable after compaction.

### 10.3 Performance measurements

```text
workloads:
  many short turns, with/without tools
  frequent compaction plus cold reopen
  parallel/sequential tools and held approvals
  large streaming output/checkpoints
  deep forks and repeated historical state reads
  many completed child conversations, few live tasks
  many genuinely live background tasks
  queued input, cancellation and result lookup

measure separately:
  CPU user/system time; wall latency distributions
  process RSS, heap, external/array-buffer memory; peaks and post-GC retained size
  actual main/sidecar/database/WAL/auxiliary-file bytes
  query count, rows decoded, logical mutations and physical bytes written
```

Same provider messages, tool output, frame cadence, compaction boundaries, hooks, durability mode
and observation workload on both implementations. Warm-up and measurement instrumentation must be
comparable. Include fault handling costs required by the final contract, not just a happy-path spike.

Memory/JSONL history growth is expected. SQLite should avoid full-history JS copies. In every case,
separate backend-owned data, live execution data and faux-provider/test bookkeeping before claiming
anything about the harness working set. Do not hide backend memory when reporting total process use.

The exported pico2 spike reports 9.7 s versus 35.9 s for the lane harness on 2,000 faux turns with
two tools per turn. That motivates investigation, not a validated result for this design. Its
four-way test measures wall time and serialized main-mutation character counts; pico2 scratch and
usage writes bypass that counter. The export has no SQLite implementation. Its projection cache
also means the timing difference cannot be attributed solely to storage interfaces.

The useful lessons are cheap current/live queries, batched ID reads, small mutations and avoiding
history scans on routine execution—not adopting its types, residency machinery or unsafe shortcuts.

### 10.4 Decisions to review before implementation

| Decision | Current proposal / remaining work |
|---|---|
| Historical position | Entry selects its whole commit; reject incomplete exchange targets (§3.3) |
| Sticky conversation inheritance | Copy only explicitly selected current scalars; lists need a deliberate policy (§4.3) |
| State/list vocabulary | Set/delete and append/clear; structured edits as deltas, not arbitrary mutable-list operations |
| Input identity and results | Admission/placement entries plus ordinary result values and input groups (§8.1); finalize normalization/queue policies |
| Background dependency sharing | Required dependencies join foreground cancellation; review interaction with previously detached work |
| Recovery and shutdown | Cooperative close; explicit external adoption/idempotence and bounded host policies |
| Compaction | Correct historical replay first; review checkpoints, token budgeting and oversized/split turns |
| Hooks and tool policy | Confirm transformation/error rules, effective arguments, termination aggregation and conflicting handoffs |
| Observation/replication | Finalize bounded buffering, requested-state hydration and Chord adapter/codec boundaries |
| Backend details | Concrete schema/query plans, snapshot ownership and power-loss policy; no inferred crash guarantees |
| Old-harness capabilities | Explicit parity decisions for provider options/cache behavior, telemetry, usage adjustments, navigation/import and host context |

Do not silently remove an existing capability because the smaller core does not mention it. Decide
whether it belongs in a task, a host integration, or the public contract before implementing that
part. The next step is feedback on this design, not copying the exported spike into the repository.
