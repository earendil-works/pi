# Durable AgentHarness design (effects variant)

> **Variant note.** This document and `harness-v2-generator.md` are two candidate designs for the same goals. They share Parts I and II in substance. They differ in Part III: the generator variant inverts control flow into a synchronous state machine; this variant keeps straight-line async procedures and gets deterministic stepping from a gated effect boundary (section 15). Judge them against each other; only one will be implemented.

> **Compatibility policy.** Old coding-agent v3 JSONL sessions must open and restore idle. This is the only backward-compatibility requirement. All other formats and APIs in `packages/agent/src/harness` and `packages/storage/sqlite-node` (and their respective tests) may break. We do not write migrations, schema versioning, or conversion paths for anything else.

```mermaid
flowchart TD
    App[Application / UI] -->|prompt, steer, abort, config| Harness
    Harness -->|snapshots + events| App
    Harness -->|hooks + events| Ext[Extensions]
    Harness --> Lanes[Lanes: main, ...<br/>one operation each, parallel]
    Lanes --> Loop[Step primitives<br/>request / tools]
    Loop --> Provider[LLM provider]
    Loop --> Tools[Tools]
    Harness --> Session[Session<br/>tree · lanes · operation logs · global facts]
    Session --> Storage[(memory / JSONL / SQLite)]
    Harness -.->|telemetry| Obs[Observability]
```

The harness executes runs against one session. The session holds four kinds of state (section 2). Lanes execute in parallel inside one harness (section 3). Storage backends encode the session (Part III).

# Part I — Concepts

## 1. Goals

- **Durable runs.** An accepted prompt is a durable operation. After a crash, a new process restores the session. It resumes the run from the last safe boundary. Every state that a crash can produce is recoverable.
- **Lanes.** A session hosts one or more lanes. A lane is a named position in the conversation tree. Each lane runs at most one operation at a time. Lanes run in parallel. A run and its queued messages belong to the lane that accepted them. Example: a Slack channel is a session; each thread is a lane. Interactive pi uses one lane and does not show the concept in its UI. Extensions get the full harness API, including lanes. Example: a subagent tool runs on a second lane of its parent's session.
- **No partial outcomes.** A crash inside any operation — run, compaction, navigation — leaves one of two states: the operation has not happened, or recovery can complete it. Nothing in between is observable.
- **Harness API.** Events observe execution and cannot change it. Hooks intercept execution and can change it: context, requests, tools, run boundaries. Extensions build on events and hooks.
- **Deterministic stepping.** Every effect — durable write, provider request, tool execution, hook, timer — crosses one injected boundary. In `drive: "manual"` the harness parks before each effect and a test drives it call by call: stop at any boundary, inject input, or close and reopen to simulate a crash. Production and tests run the same procedures; the drive mode only controls the boundary (section 15).
- **Observability.** All execution is instrumentable for logging and tracing, down to provider request and response internals. This channel is separate from the hook system.
- **UI model.** A client gets one atomic snapshot, then a live event stream. Events are not replayed. Reconnect means a new snapshot.
- **Single writer.** One harness writes a session at a time. The serving layer enforces this. All lanes of a session live in that one harness. Restore treats states that a single writer cannot produce as corruption.
- **v3 sessions load.** Old coding-agent v3 JSONL files open unchanged and restore idle.

## Non-goals

- **Exactly-once hook side effects.** State a hook hands to the harness is durable when the call resolves: queued messages, appended entries. Side effects a hook makes on its own are invisible to the harness: HTTP calls, file writes. Interrupted handlers are not re-run on resume. A hook that needs crash-safe external effects must be idempotent, for example keyed by operation id.
- **Provider stream resumption.** Partial streams are never persisted. An interrupted streaming request is retried or abandoned. Deferred requests are different and in scope: the provider returns a handle at once and serves the result later (e.g. `background: true` on a Responses API, batch APIs). pi-ai returns an assistant message with stop reason `deferred` that carries the handle; it is persisted like any assistant message. Redeeming the handle appends a normal assistant message. Recovery sees the unredeemed handle and fetches instead of paying for a new request.
- **Multiple writers.** Two processes on one session are out of scope. The serving layer routes all traffic for a session to the process that holds its harness. Lanes cover the workloads that look like multi-writer: parallel threads over shared history.
- **Replication.** A session lives in one place. Coordination-free sync of diverging copies is a different design. Parked; see open questions.

## 2. What a session is

A session is durable state with four parts:

1. **The tree** — the conversation. Entries with `parentId` links: messages, model/thinking/tool-activation changes, compaction summaries, branch summaries, custom entries. The tree is shared and passive. It belongs to no lane. It only grows; entries are never changed or deleted.
2. **Lanes** — where work happens. A lane is a name plus a leaf: the entry that future work extends. Every session has the lane `main`. Applications create more, keyed by external identity (a Slack thread id, an email thread id).
3. **Lane operation logs** — what happened and what must happen. One flat, chronological record sequence per lane: operation started, task attempted, tool started, message queued, operation finished. This is where durability is implemented: records exist so that a new process can continue a lane's work after a crash. Nothing reads them during normal execution.
4. **Global facts** — session-scoped values where the latest write wins: the session name, entry labels. Not part of the tree. Kept as append-only history; readers see the newest value.

All writes across the four parts share one monotonic sequence number. The sequence orders global-fact history and lets a lane's operation log refer to tree positions.

```text
tree (shared, append-only)          lanes
a ── b ── c ── d                    main            → d   (op log: …)
      └── e ── f                    slack:171943…   → f   (op log: …)

global facts: name = "Refactor auth", label(b) = "checkpoint-1"
```

### Active and passive

The tree and the global facts are passive: shared data, readable by anything.

A lane is active. It owns its leaf, its operation log (at most one open operation), its queues, and its pending writes. Two lanes never share any of these. Every action of a lane produces entries chained to its leaf, or records in its own operation log.

### Invariants

- The tree is conversation only. No lane state, no orchestration state, no pointers live in it.
- An entry's parent chain never changes. Branches share prefixes; nothing is copied.
- A lane's leaf moves in exactly two ways: the lane appends an entry (leaf becomes that entry), or the lane navigates (leaf jumps to an existing entry).
- Operation-log records never affect the tree. Deleting every operation log leaves a complete, valid conversation.
- At most one operation is open per lane. A state where one lane has two open operations is corruption.
- Entries are shared; records are not. Two lanes may have the same entry on their paths. A record belongs to exactly one lane.

Records are not tree entries because they describe execution, not conversation: they must never enter model context, transcripts, branch queries, or forks, and within one lane their order is already their meaning — parent links would add nothing.

## 3. Lanes

A lane is a named position in the tree plus the work serialized on it. The closest existing concept is a git branch checked out in its own worktree: a name attached to a position, advanced by new work, movable to any entry without rewriting history, and never checked out twice. One difference to git intuition: navigation moves a lane to any entry, not only forward.

Every session has the lane `main`. Applications create further lanes with a name and an anchor entry. Lane names are permanent application keys: a Slack thread id, an email thread id. No UI lists lanes in the abstract; the platform's own UI (the thread list) plays that role.

A lane owns:

- **Its leaf.** New entries chain to it and move it. Navigation jumps it.
- **Its operation log.** At most one open operation. A second operation on a busy lane is rejected; other lanes are unaffected.
- **Its queues.** Steering, follow-ups, and next-run messages target one lane.
- **Its configuration view.** Model, thinking level, and active tools are entries on the path behind the lane's leaf. Two lanes can run different models without knowing of each other. Tool implementations, resources, and stream options are harness-global; only their activation is per-lane.

Rules:

- Lanes run operations in parallel. The harness stays the single writer; lane records and entries interleave in the shared sequence.
- Creating a lane copies nothing. Lanes are not deleted or renamed.
- State-dependent mutations on one lane are linearized on that lane's mutation line: validation, at most one durable write, and the in-memory update complete before the next mutation starts (section 15). Provider, tool, hook, and retry work never occupies the mutation line.
- Two lanes at the same leaf diverge on their next append. The tree handles this; no coordination exists between lanes.
- A lane with an unfinished operation restores as suspended, independently of its siblings. Suspension has a reason: crash, or a deferred provider request (section 1).

## 4. How work executes

### Operations

An operation is the unit of durable work on a lane. Three kinds:

- **Run** — an accepted prompt, through all automatic continuations: tool calls, steering, follow-ups, auto-compaction. Ends when nothing is pending.
- **Compaction** — replaces old context with a summary entry.
- **Navigation** — moves the lane's leaf to an existing entry, optionally with a branch summary.

An operation is accepted before it executes. Acceptance is durable: after a crash, an accepted operation is either completed by recovery or explicitly closed. Every operation ends with one outcome: `completed`, `failed`, `aborted` (stopped by abort), or `declined` (vetoed by a hook before any effect).

### Runs, steps, tasks

A run is a sequence of steps. A step: one task producing an assistant message, plus the complete tool batch that message requested.

A task is a retryable unit of work inside an operation: produce an assistant message, a compaction summary, or a branch summary. A task may make zero, one, or several provider requests. A failed attempt retries the same task; the attempt count is durable and survives restarts. A deferred provider request ends a task attempt early: the handle arrives inside a persisted assistant message, the lane suspends, and redemption later appends the real result (section 1).

### Queues and deferred writes

Two mechanisms carry input into a running lane. They differ in abort behavior:

- **Queues** carry conversational intent: `steer` corrects the current work, `followUp` adds work for when the model would stop, `nextRun` seeds the lane's next run. Steering and follow-ups die on abort; their payloads are returned to the caller. Next-run messages survive.
- **Deferred writes** carry facts: entries and configuration changes requested while a step is in flight. They survive abort and are applied even during cancellation.

Both are durable at acceptance: the accepting call writes a record with the full payload to the lane's operation log, then resolves. The tree entry is written later, when the item is applied or consumed — the position where the model first sees it. If the process dies between acceptance and the tree write, recovery reads the record and performs the append. Accepted input is never lost.

### Checkpoints

Between steps, the lane passes a checkpoint:

1. Apply pending deferred writes.
2. Consume queued steering messages.
3. Compact if the next request would not fit.

A step with tool calls forces another step so the model sees its results — with one exception: a batch in which every finalized tool result persisted `terminate: true` suppresses automatic tool continuation (steering or follow-up input can still start another step). Follow-up messages are consumed only when tool continuation and steering are exhausted. The run ends when a checkpoint finds nothing pending.

### Append-only context

> Across the requests of a lane, provider context only grows at the tail. An insertion before the previous request's tail invalidates the provider's KV cache from that point on and multiplies token cost.

This invariant is why mid-step writes defer to checkpoints: checkpoint application appends at the tail. Compaction is the one deliberate exception; it trades one full cache invalidation for a smaller context.

### Lane lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle: restored, no open operation
    [*] --> Suspended: restored, open operation
    Idle --> Running: operation accepted
    Running --> Idle: finished
    Running --> Cancelling: abort
    Cancelling --> Idle: reconciled
    Running --> Suspended: deferred handle persisted
    Suspended --> Running: resume continues the open operation
    Suspended --> Cancelling: abort
```

- States are per lane. One exception: a failed storage write faults the whole harness. A faulted harness stops all effects and rejects all calls; after the cause is fixed, reopening restores each lane from its records.
- **Suspended** means: an operation is open, nothing executes. Reached by restore after a crash, or deliberately when a deferred handle is persisted. `resume()` continues the operation; `abort()` closes it without further execution.
- **Abort** records the cancellation durably, signals running effects, and returns. Reconciliation follows: unresolved tool calls get synthetic results, and the transcript gets a closing assistant message. Automatic drive runs it in the background; manual drive leaves it parked at its next action.

### Resume

Resume continues the open operation. It never starts a new one. The entry point is wherever the records end: retry an unfinished task, redeem a deferred handle, reconcile a half-finished tool batch, or continue at the next checkpoint. Queued messages and deferred writes accepted before the crash are still pending and apply normally.

# Part II — How execution is recorded

Part II is backend-neutral. It defines the records a lane writes, when it writes them, and how recovery reads them back. Part III maps this onto APIs and storage.

## 5. Records

### The durability rule

> Before an effect: write an intent record that names what will happen and the ids it will produce. After the effect: append the result as an entry with exactly those ids.

There is no multi-record atomicity and none is needed. Each record and each entry is durable alone. A crash between intent and result leaves the intent unfulfilled; recovery decides per intent type: complete it, retry it, or close it with a synthetic result. An intent is fulfilled if and only if an entry with its provisioned id exists. A provisioned id that exists with different content is corruption.

### Provisioned ids

Intent records carry the ids of entries that do not exist yet:

```ts
/** An entry payload with its id pre-allocated. parentId, seq, and timestamp
    are assigned by storage when the entry is appended: it chains to the
    lane's then-current leaf. */
type ProvisionedEntry<T extends Entry = Entry> = Omit<T, "parentId" | "seq" | "timestamp">;
```

### Record catalog

Every record belongs to one lane's operation log. Records that belong to an operation carry `runId`: the id of that operation's `operation_started` record. `queue_enqueued` for the next-run queue is the one record without `runId`; it is consumed by the lane's next run.

```ts
interface RecordBase {
  id: string;
  seq: number;            // shared sequence, section 2
  lane: string;
  timestamp: number;      // Unix ms
}

// Acceptance boundary of an operation. Everything decided before acceptance
// is persisted here. This record's own id IS the runId that all other
// records of the operation carry.
interface OperationStarted extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;        // the lane's leaf at acceptance
  intent:
    | {
        kind: "run";
        /** Normalized caller input after skill/template expansion, before
            before_run. Kept for SuspendedOperation and before_resume. */
        originalPrompt: AgentMessage[];
        /** Captured nextRun items, then the prompt, then before_run
            injections. Full payloads, provisioned ids. Capture happens in
            the acceptance mutation (section 15): items present when it runs
            belong to this run; later items belong to the next. */
        initialMessages: ProvisionedEntry[];
        /** Present only when a hook overrode the system prompt; fixed for the
            whole run. Absent: the systemPrompt callback runs per request. */
        systemPromptOverride?: string;
        /** Opaque state keyed by stable hook registration id. Each
            before_resume handler receives only the value under its id. */
        resumeData?: Record<string, JsonValue>;
      }
    | {
        kind: "compaction";
        customInstructions?: string;
        resultEntryId: string;          // provisioned compaction entry
      }
    | {
        kind: "navigation";
        targetId: string | null;        // destination entry; null = root
        summarize: boolean;
        customInstructions?: string;
        label?: string;                 // global fact, written at completion
        summaryEntryId?: string;        // provisioned branch-summary entry
      };
}

// Written when abort() resolves. A request marker, not a terminal state:
// reconciliation follows, then operation_finished with outcome "aborted".
// Kills this operation's steer/follow-up queue items; next-run items survive.
interface AbortRequested extends RecordBase {
  type: "abort_requested";
  runId: string;
  reason: "user" | "shutdown";
}

// Closes the operation. failed = orderly durable failure (for example,
// retries exhausted). aborted = closed by abort. declined = vetoed by a
// hook before any effect.
interface OperationFinished extends RecordBase {
  type: "operation_finished";
  runId: string;
  outcome: "completed" | "aborted" | "failed" | "declined";
  error?: { code: string; message: string };
}

// Written before each attempt at a retryable task. Marks: we are about to
// do this, for the n-th time. Tasks are logged only because they are
// retryable: the durable count caps retries across restarts — a
// crash-restart loop cannot reset it. One record per attempt; one attempt
// may make zero or several provider requests (hook-supplied summaries make
// none, split-turn compaction makes two). Deferred results need no extra
// record: the handle lives in the persisted assistant entry (section 1).
interface TaskAttempt extends RecordBase {
  type: "task_attempt";
  runId: string;
  task: "step" | "compaction" | "branch_summary";
  attempt: number;                     // 1-based within this task
  /** Required exactly for compaction tasks. Persists why the summary is
      being generated so resume re-enters the same structural work without
      re-deriving context pressure. */
  compactionReason?: "manual" | "threshold" | "overflow";
}
// The model of a resumed request is not read from records: the lane's
// effective model is derived from its path, and a deferred handle's model
// is in the persisted assistant entry.

// Written after before_tool and validation pass, before the tool executes.
// assistantEntryId + toolIndex is the durable invocation identity.
interface ToolStarted extends RecordBase {
  type: "tool_started";
  runId: string;
  assistantEntryId: string;
  toolIndex: number;
  toolCallId: string;
  toolName: string;
  effectiveArgs: Record<string, unknown>;   // after before_tool
  resultEntryId: string;                    // provisioned
  /** The tool's declared replay safety, snapshotted at execution time.
      Recovery re-executes an unfinished call only when this field AND the
      current tool declaration both say "safe"; otherwise it writes a
      synthetic "interrupted" result. */
  replay: "never" | "safe";
}

// Queue acceptance. The payload travels here; the entry appears at the
// consumption point.
interface QueueEnqueued extends RecordBase {
  type: "queue_enqueued";
  queue: "steer" | "followUp" | "nextRun";
  runId?: string;                      // absent for nextRun
  target: ProvisionedEntry;
}

// Durable retraction of a pending queue item, before consumption. Without
// this record a crash would resurrect the item: recovery treats a
// queue_enqueued without its entry as pending.
interface QueueCancelled extends RecordBase {
  type: "queue_cancelled";
  runId?: string;                      // matches the queue_enqueued it kills
  entryId: string;                     // the enqueued target's provisioned id
}

// Deferred-write acceptance: an entry or configuration change requested
// while a step was in flight. Applied at the next checkpoint.
interface WriteDeferred extends RecordBase {
  type: "write_deferred";
  runId: string;
  target: ProvisionedEntry;
}

type LaneRecord = OperationStarted | AbortRequested | OperationFinished
  | TaskAttempt | ToolStarted | QueueEnqueued | QueueCancelled | WriteDeferred;

type NewRecord<T extends LaneRecord = LaneRecord> =
  T extends LaneRecord ? Omit<T, "seq" | "timestamp"> : never;
```

Blocked or invalid tool calls write no `tool_started`. No effect starts, so no intent is needed: the block is durable as a tool-result entry with `isError: true` and the block reason as content. A crash before that entry loses only the decision, and recovery makes it again — `before_tool` runs again for a call with no `tool_started` and no result.

A tool step needs no outcome record. Its result entry is the complete durable outcome, including the batch-control decision: the tool-result entry persists `terminate` (section 12). A crash after execution but before the result entry follows the replay policy (section 6); re-finalization runs `after_tool` again, which the section 1 non-goal explicitly permits.

### Validity

Recovery rejects a lane's log as corrupt when:

- more than one operation is open;
- a record references an operation that does not exist, or follows its finish;
- attempt numbers are not consecutive within a task;
- `compactionReason` is absent from a compaction attempt or present on another task kind;
- a steer or follow-up `queue_enqueued` for a run follows its `abort_requested`;
- a `queue_cancelled` targets an id with no `queue_enqueued`, or one whose entry exists;
- two `tool_started` records share an invocation identity;
- a provisioned id exists with different content.

## 6. What each action writes

Traces at the storage level. All traces show one lane. Legend:

```text
E   entry appended to the tree (chained to the lane's leaf)
R   record appended to the lane's operation log
L   lane pointer move
G   global fact written
H   hook (awaited; hooks are Part I concepts, their API is Part III)
X   crash site
```

### Run with one tool call

```text
    prompt("fix the bug")
H   before_run                        may inject entries, override system prompt
R   operation_started                 kind run; initial messages with provisioned ids
E   user message                      the provisioned id from the intent
R   task_attempt                      task step, attempt 1
E   assistant message [tool call]
H   before_tool                       may change args or block
R   tool_started                      effective args, provisioned result id, replay
E   tool result                       the provisioned result id
R   task_attempt                      next step, attempt 1
E   assistant message "done"
H   before_run_end                    nothing pending, returns nothing
R   operation_finished                completed
```

A crash between any two lines is recoverable. The general rule: an intent without its result entry is completed, retried, or closed with a synthetic result by recovery; a result entry without a consumed intent cannot exist.

### Retry

```text
R   task_attempt                      attempt 1
    request fails
R   task_attempt                      attempt 2 — durable count
E   assistant message
```

Crash during backoff: restore counts two attempts; resume starts attempt 3. The count never resets. Retryable errors below the cap are never appended as entries. Attempts exhausted — or a non-retryable terminal error — appends an assistant message with the error, then `operation_finished` failed:

```text
E   assistant message                 stop reason error; the failure is durable
X   crash                             operation still open
R   operation_finished                recovery writes failed — never completed
```

The error entry is the terminal-failure marker. Recovery that finds it drains accepted writes and queued input; unless consumed steering or follow-up input starts new work, it closes the run failed (section 7). A run whose newest own message is a task-produced error can never be completed by recovery.

### Steering while a tool runs

```text
E   assistant message [tool call]
R   tool_started
    steer("focus on the tests")       caller resolves here
R   queue_enqueued                    steer, full payload, provisioned id
E   tool result
E   user message                      checkpoint consumes the queue item; provisioned id
R   task_attempt                      next request sees the steering message
```

Crash before `queue_enqueued`: the steer never happened; the caller's promise never resolved. Crash after: recovery finds the record without its entry and appends it at the same point the checkpoint would have.

A queued item can be durably retracted before consumption:

```text
R   queue_enqueued                    steer, full payload, provisioned id
    cancelQueued(entryId)             caller resolves here
R   queue_cancelled                   the entry will never be appended
```

Crash between the two records: the item is still pending; the cancel promise never resolved. Cancellation and consumption are jobs on the lane mutation line, so `[cancel, consume]` and `[consume, cancel]` are the only histories (section 15).

### Input at the finish boundary

Same-lane decisions have one order: the lane mutation line (section 15). The final pending-work check and the terminal append are one `tryFinishRun` mutation, so a concurrent steer has exactly two histories:

```text
steer first                         finish first
R   queue_enqueued                  R   operation_finished
    tryFinishRun → continue             steer() → no_active_run
E   user message
... run continues
R   operation_finished
```

Deferred writes and abort use the same ordering. A deferred write accepted before finish must be applied before the run can close; one accepted after finish observes an idle lane and appends directly. `abort_requested` before finish selects abort reconciliation; abort after finish returns `no_active_operation`. There is no third history — that is the entire mechanism.

### Deferred write mid-step

```text
R   task_attempt                      request in flight, context ends at user message U
    session.appendMessage(M)          caller resolves here
R   write_deferred                    full payload, provisioned id
E   assistant message A               provider cached [.., U, A]
E   message M                         checkpoint applies the write; tail append
```

Appending M directly would produce [.., U, M, A]: a valid provider sequence that invalidates the KV cache from M on, and a transcript claiming A saw M when it did not. The checkpoint prevents both (append-only context, section 4).

### Abort during a tool

```text
E   assistant message [tool call]
R   tool_started
    abort()                           caller resolves here
R   abort_requested                   steer/follow-up queues die; payloads returned
E   tool result                       synthetic "interrupted", or real if it finished
E   assistant message                 closing message, stop reason aborted
R   operation_finished                aborted
```

Crash after `abort_requested`: recovery completes the same reconciliation. Pending deferred writes are applied even here; queued steer/follow-up items are not.

### Tool execution crash sites

```text
E   assistant message, calls c1, c2
X1  before before_tool                nothing durable for c1
H   before_tool(c1)
X2  decision made, nothing written    same as X1
R   tool_started(c1)
X3  tool executing
H   after_tool(c1)
X4  hook interrupted                  same durable state as X3
E   tool result c1
X5  result durable                    c1 finished
```

| crash site | durable state | recovery |
|---|---|---|
| X1, X2 | no record, no result | full normal path; `before_tool` runs (again) |
| X3, X4 | `tool_started`, no result | replay safe (record AND current declaration): re-execute persisted args, `after_tool` on the fresh result. Otherwise: synthetic "interrupted" result, no hooks |
| X5 | result entry exists | skip c1; c2 is at X1 |

Reconciliation handles each call of a batch at its own site, in source order. The step then ends normally.

### Auto-compaction at a checkpoint

```text
E   tool result                       step ends
    checkpoint: next request would not fit
H   before_compaction                 may decline or supply the summary
R   task_attempt                      task compaction — skipped if hook supplied
E   compaction entry
R   task_attempt                      task step; run continues on compacted context
```

Auto-compaction writes no `operation_started`; it belongs to the run. Manual `compact()` is its own operation: `operation_started` (kind compaction, provisioned result id) → hook → attempt → compaction entry → `operation_finished`.

### Navigation

```text
    navigateTree(target, { summarize: true, label: "before-refactor" })
R   operation_started                 kind navigation; target, provisioned summary id, label
H   before_navigation                 may decline or supply the summary
R   task_attempt                      task branch_summary — skipped if hook supplied
    summary text generated            in memory only
L   lane move → target                one storage write; the commit point
E   branch summary entry              appends chain to the lane's leaf — now the target,
                                      so the summary lands on the target branch
G   label                             from the intent; latest-wins, idempotent
R   operation_finished                completed
```

The move commits first; every later write chains off durable state. No multi-object atomic write exists anywhere in the design. Acceptance rejects `target === sourceLeafId`, so "has the move happened" is always decidable: the lane's leaf equals `intent.targetId` if and only if the move committed. Per crash site:

| crash after | recovery sees | action |
|---|---|---|
| `operation_started` | leaf at `sourceLeafId` | rerun hook or summary task, then move |
| summary generated | nothing durable of the text | regenerate under the same attempt cap |
| lane move | leaf at `intent.targetId` | append summary if `summaryEntryId` missing |
| summary entry | entry exists | set label, finish |
| label | fact set (idempotent) | finish |

Between the move and `operation_finished`, readers see the lane at the target with an open navigation — a recoverable state, not an invalid one. The lane runs nothing else meanwhile; one operation per lane already guarantees that.

### Deferred provider request

```text
R   task_attempt                      stream options request deferred execution
E   assistant message                 stop reason deferred, carries the handle
    lane suspends; prompt() resolves with outcome "suspended"
    ... hours pass, maybe a different process ...
    resume()                          newest entry on the lane's path is a deferred
                                      assistant message with no successor
                                      → the attempt is outstanding, redeem it
    fetchDeferred(model, handle)      model and handle from that entry
E   assistant message                 the real result
    run continues normally
```

The suspended lane is indistinguishable from a crashed one in storage: an open operation whose newest entry is a deferred assistant message with no successor. Restore lists it as suspended; `resume()` checks the handle. Redemption writes no intent record: it starts no new model work, and a committed successor entry prevents another fetch.

Each `resume()` performs one fetch. Three outcomes:

- **pending** — the provider returns stop reason `deferred` again. Nothing is written; the lane re-suspends. Poll cadence is application policy.
- **ready** — a normal assistant message. It is appended as the successor and the run continues.
- **terminal** — the provider returns stop reason `error` (expired, unknown, consumed), or the fetch itself rejects; the harness converts a rejection to the same error-message form. The message is appended and the run finishes failed. Redemption failure never starts an automatic replacement request; steering or follow-up input already accepted for this run can still start a later step.

`abort()` on a suspended lane: `abort_requested` record, best-effort cancellation of the handle at the provider, then normal reconciliation and `operation_finished` aborted. The deferred entry stays in the transcript.

Deferred assistant messages carry a handle, not content; they project to nothing in provider context.

## 7. Recovery

### Restore

Opening a session restores every lane independently. Restore reads; it never appends and never starts effects.

Per lane, one question: does the operation log hold an `operation_started` without a matching `operation_finished`? No: the lane is idle. Its only remaining state is pending next-run queue items. Next-run messages can be enqueued at any time; only the acceptance of a run consumes them — compaction and navigation pass over the queue. Pending items are therefore the `queue_enqueued` records after the lane's most recent run-kind `operation_started` whose provisioned entries do not exist and that no `queue_cancelled` retracts; nothing older can still be pending. Items a run captured are listed in its intent's `initialMessages`, so a captured-but-unappended item is completed by that run's recovery and is never offered to the next run. Yes: the lane is suspended, and its state is reduced from two bounded reads:

1. **The lane's records** since that `operation_started`. Everything after the finish of the previous operation is irrelevant history.
2. **The lane's own entries**: the path from its leaf back to the operation's anchor (`sourceLeafId`). These are exactly the entries this operation appended.

Both reads are bounded by the size of the open operation, not by the size of the session or the activity of other lanes.

### The reduction

From those two reads, the lane's state:

- **aborting** — an `abort_requested` record exists.
- **attempts used** — `task_attempt` records newer than the lane's newest own entry. An entry landing ends its task; attempts before it belong to finished work.
- **tool batch** — the newest assistant entry with tool calls, each call matched against `tool_started` records and result entries (section 6, crash-site table). The assistant stop reason is retained: a `length` batch is truncated and never executes on recovery. Persisted `terminate` values on result entries decide whether the completed batch forces another step.
- **deferred handle** — the newest own entry is a deferred assistant message with no successor.
- **pending queue items** — `queue_enqueued` records whose provisioned entry does not exist, excluding items retracted by `queue_cancelled` and steer/follow-up items killed by this run's `abort_requested`.
- **pending writes** — `write_deferred` records whose provisioned entry does not exist.
- **missing initial messages** — provisioned ids from the run intent without entries.
- **structural targets** — for compaction and navigation: does the provisioned result entry exist.

The same rules run live: during normal execution the harness updates this state in memory as it writes; restore recomputes it from storage. State and records cannot disagree, because the state is defined as their reduction.

### Resume

`resume()` continues the open operation from what the reduction says:

- missing initial messages → append them (accepted input is never lost), even when aborting.
- aborting → reconcile: synthetic tool results, closing assistant message, `operation_finished` aborted.
- unresolved tool batch → per call: skip, re-execute, or synthesize (section 6).
- deferred handle → redeem (section 6).
- terminal failure — the newest own message is a task-produced assistant error (a give-up entry, a non-retryable request error, or a failed redemption; never an arbitrary deferred-write message) → apply accepted writes and consume queued conversational input; if nothing consumed starts new work, append `operation_finished` failed. Recovery never completes such a run.
- unfinished task → resume that exact task before consuming new checkpoint input: next attempt if the cap allows, else fail the operation. A compaction task resumes with its recorded `compactionReason`.
- otherwise → continue at the next checkpoint; pending writes and queue items apply normally there.

Recovery appends are ordinary appends with one extra rule: skip any provisioned id that already exists. A crash during recovery therefore leaves less to recover; re-running recovery is always safe. Recovery never repeats an effect whose outcome is unknown, and interrupted hook handlers are not re-run (section 1).

Old v3 sessions contain no records. Every lane question answers "idle"; section 12 normalization restores `main` at the final retained logical entry (v3 `leaf` entries and discarded fact-like entries resolve through their nearest retained ancestor).

# Part III — API and implementation

## 8. Public API

### The lane surface

`AgentLane` is the operation surface of one lane. `AgentHarness` implements it for `main`: `harness.prompt(...)` is main's prompt. Every method is async, including getters an in-process implementation answers from memory: the interface must be implementable by a remote proxy, so no signature may promise synchronicity that only the local implementation can keep. Sync exceptions: `name`, and listener registration (`hooks.on`, `events.on`) — a server bridges events over its own transport, not registrations.

```ts
interface AgentLane {
  readonly name: string;                 // "main" on the harness itself
  getLeafId(): Promise<string | null>;

  // Operations. Never throw; every call resolves with a result (see below).
  // At most one operation per lane; other lanes are unaffected.
  prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
  prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
  skill(name: string, additionalInstructions?: string): Promise<RunResult>;
  promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
  compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
  navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
  resume(): Promise<ResumeResult>;       // continue this lane's open operation
  abort(): Promise<AbortResult>;         // durable on resolve; reconciliation runs in background

  // Queues. Durable on resolve (queue_enqueued record); the returned
  // entryId identifies the item until consumption. steer/followUp require
  // an active run; nextRun and cancelQueued work anytime.
  steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
  steer(message: AgentMessage): Promise<QueueResult>;
  followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
  followUp(message: AgentMessage): Promise<QueueResult>;
  nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
  nextRun(message: AgentMessage): Promise<QueueResult>;
  /** Durably retract a pending queue item (queue_cancelled record). */
  cancelQueued(entryId: string): Promise<CancelQueuedResult>;

  waitForIdle(): Promise<void>;
  runWhenIdle(callback: () => void | Promise<void>): Promise<void>;   // runtime-only

  // Manual drive controls. Section 15 defines their exact behavior; they
  // are usable only with AgentHarnessOptions.drive === "manual".
  peekAction(): Promise<ActionInfo | undefined>;
  executeAction(): Promise<ActionInfo | undefined>;
  runToCompletion(): Promise<void>;

  // Persisted configuration — entries on the path behind this lane's leaf,
  // resolved by point queries. Setters resolve on durable acceptance;
  // mid-step they become deferred writes on this lane.
  getModel(): Promise<Model>;                 setModel(model: Model): Promise<void>;
  getThinkingLevel(): Promise<ThinkingLevel>; setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getActiveTools(): Promise<string[]>;        setActiveTools(names: string[]): Promise<void>;

  /** This lane's view of the tree: reads default to this lane's leaf;
      appends defer while a run is open and otherwise chain to the leaf
      (section 12). */
  session: SessionTree;

  /** Scoped: this lane's transcript, state, queues, and events (section 9). */
  watch(): Promise<{ snapshot: LaneSnapshot; start: (listener) => void; unsubscribe: () => void }>;
}
```

### The harness

```ts
class AgentHarness implements AgentLane {
  /** Opens the session, restores every lane, starts no effects.
      One suspended entry per lane with an open operation. */
  static create(options: AgentHarnessOptions): Promise<{
    harness: AgentHarness;
    suspended: SuspendedOperation[];
  }>;

  // Lane management. Names are permanent application keys
  // ("slack:1719432.0021"). Handles are stateless facades bound to the
  // name: any number may exist, all equivalent; identity is the name,
  // never the object. Lanes are not deleted or renamed.
  lane(name: string): Promise<AgentLane | undefined>;    // lookup, never creates
  createLane(name: string, at: string | null): Promise<LaneResult>;
  /** Inventory. Always includes "main". */
  lanes(): Promise<LaneInfo[]>;

  // Harness-global configuration: registries and runtime capabilities.
  // Tool implementations are code and cannot persist; the active set
  // (names) persists per lane.
  getTools(): Promise<AgentTool[]>;      setTools(tools: AgentTool[], activeNames?: string[]): Promise<void>;
  getResources(): Promise<Resources>;    setResources(r: Resources): Promise<void>;
  getStreamOptions(): Promise<StreamOptions>;  setStreamOptions(o: StreamOptions): Promise<void>;
  getRetryPolicy(): Promise<RetryPolicy>;      setRetryPolicy(p: RetryPolicy): Promise<void>;
  getCompactionSettings(): Promise<CompactionSettings>; setCompactionSettings(s): Promise<void>;
  getSteeringMode(): Promise<QueueMode>;       setSteeringMode(m: QueueMode): Promise<void>;
  getFollowUpMode(): Promise<QueueMode>;       setFollowUpMode(m: QueueMode): Promise<void>;

  /** Session-wide observer: lane inventory snapshot plus the unfiltered
      event stream. No transcripts; compose with lane.watch(). */
  watchSession(): Promise<{ snapshot: SessionSnapshot; start; unsubscribe }>;

  // Harness-global. Every hook and event payload carries `lane`.
  hooks: Hooks;
  events: Events;

  /** Detach cleanly. Signals in-flight effects, waits for the append in
      progress, releases the writer claim. Open operations stay resumable;
      no shutdown record is needed. */
  close(): Promise<void>;
}

interface LaneInfo {
  name: string;
  leafId: string | null;
  operation: null | { id: string; kind: "run" | "compaction" | "navigation";
                      status: "running" | "suspended" | "aborting" };
}

type LaneResult = { ok: true; lane: AgentLane } | { ok: false; error: ErrorInfo };
```

### Options

```ts
interface AgentHarnessOptions {
  // Identity and providers
  session: Session;
  models: Models;                        // provider collection for all requests

  // Initial lane configuration — used when a lane's path has no persisted
  // config entries; persisted config wins otherwise.
  model: Model;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];

  // Runtime capabilities — harness-global, reconstructed at create()
  tools?: AgentTool[];
  toolContext?: TContext | (() => TContext | Promise<TContext>);
  systemPrompt?: string | ((ctx) => string | Promise<string>);   // evaluated per request
  resources?: Resources;                 // skills, prompt templates

  // Execution policy
  streamOptions?: StreamOptions;         // transport, headers, timeouts, deferred
  retry?: RetryPolicy;                   // task attempt cap; the durable count
  compaction?: CompactionSettings;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** automatic: operation methods drive their procedures to completion.
      manual: the operation's effects park at the gate; peekAction() /
      executeAction() / runToCompletion() drive them. Deterministic tests
      and debuggers. Section 15. */
  drive?: "automatic" | "manual";       // default automatic

  // Projection
  /** AgentMessage → provider messages, before each request. Default handles
      bash executions, custom messages, summaries; validates at acceptance
      that queued/prompted messages convert to user messages. */
  toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** Custom entry → context messages, at context build. Entries without a
      projector never enter provider context. */
  entryProjectors?: Record<string, EntryProjector>;

  // Telemetry. The default context is a no-op. Section 18.
  context?: ExecutionContext;
}
```

### Results, not exceptions

Operation and queue methods never throw. A rejection of the returned promise is a bug, not an outcome. Result shapes are discriminated unions; `ok: true` carries the payload, `ok: false` carries `outcome`.

```ts
interface ErrorInfo { code: string; message: string }

/** Shared failures. rejected: the call never became an operation; no record
    exists. faulted: storage stopped accepting writes; the harness is dead
    until reopened, open operations restore as suspended. */
type Failure =
  | { ok: false; outcome: "rejected"; error: ErrorInfo }
  | { ok: false; outcome: "faulted"; runId?: string; error: ErrorInfo };

type RunResult =
  | { ok: true; runId: string; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
  | { ok: false; outcome: "aborted";   runId: string; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
  | { ok: false; outcome: "failed";    runId: string; leafId: string; error: ErrorInfo; finalEntryId?: string; finalMessage?: AssistantMessage }
  | { ok: false; outcome: "suspended"; runId: string; deferred: DeferredHandle }   // parked on a deferred request
  | Failure;

type CompactionResult =
  | { ok: true; runId: string; entry: CompactionEntry }
  | { ok: false; outcome: "declined" | "aborted"; runId: string }
  | { ok: false; outcome: "failed"; runId: string; error: ErrorInfo }
  | Failure;

type NavigationResult =
  | { ok: true; runId: string; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
  | { ok: false; outcome: "declined" | "aborted"; runId: string }
  | { ok: false; outcome: "failed"; runId: string; error: ErrorInfo }
  | Failure;

type QueueResult = { ok: true; entryId: string } | Failure;

type CancelQueuedResult =
  | { ok: true }                                            // entry will never be appended
  | { ok: false; outcome: "already_consumed" | "already_cleared" }
  | Failure;                                                // unknown id: rejected

type ResumeResult =
  | ({ kind: "run" } & RunResult)
  | ({ kind: "compaction" } & CompactionResult)
  | ({ kind: "navigation" } & NavigationResult);
```

Rejection codes: `busy` (this lane), `no_active_run`, `no_active_operation`, `nothing_to_resume`, `missing_identities`, `invalid_message`, `unknown_skill`, `unknown_template`, `unknown_target`, `unknown_queue_item`, `unknown_lane`, `lane_exists`, `invalid_lane`, `nothing_to_compact`, `closed`, `faulted`.

`cancelQueued` outcomes mirror the mutation-line histories: `already_consumed` means the entry exists (the model saw or will see it); `already_cleared` means abort drained the item or an earlier cancel won.

`finalMessage` is the run's newest entry that projects to an assistant message; `finalEntryId` is that entry's id. `leafId` is the lane's leaf when the operation finished — the race-free anchor for branch queries (`findEntriesOnBranch({ start: leafId })`). The two differ when a deferred write was applied after the final assistant message. Full transcripts are not duplicated into results; they are in the session and were delivered as events.

### Suspended operations

```ts
interface SuspendedOperation {
  lane: string;
  kind: "run" | "compaction" | "navigation";
  id: string;
  startedAt: number;                             // Unix ms, from the operation_started record
  reason: "crash" | "deferred";
  prompt?: AgentMessage[];                       // runs: normalized original prompt
  deferred?: DeferredHandle;                     // reason "deferred"
  aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };  // abort accepted pre-crash;
                                                 // cleared payloads, offered for requeue
  missing: { tools: string[]; models: string[] };  // non-empty: resume() rejects
}
```

### Examples

```ts
// Interactive pi. suspended has 0 or 1 entries, always "main".
const { harness, suspended } = await AgentHarness.create({ session, models, model });
for (const s of suspended) await (await harness.lane(s.lane))!.resume();
await harness.prompt("fix the bug");
await harness.steer("focus on the tests");
await harness.setModel(opus);

// Slack bot. Channel = session + main; thread = lane, keyed by thread id.
const key = `slack:${threadTs}`;
const t = (await harness.lane(key)) ?? (await harness.createLane(key, pingedEntryId)).lane;
await t.prompt("summarize this thread");     // parallel to main and other threads
await t.setModel(haiku);                     // this thread only
await t.session.appendMessage(msg);          // this thread's branch

// Thread renderer: this lane only.
const { snapshot, start } = await t.watch();
render(snapshot.transcript);
start((event) => update(event));

// Deferred run (batch pricing). prompt() parks; a webhook or timer resumes.
const r = await t.prompt("analyze this mailbox");
if (!r.ok && r.outcome === "suspended") schedulePoll(t);
// later: const done = await t.resume();     // suspended again, or the final result

// Dashboard: inventory + firehose, no transcripts.
const s = await harness.watchSession();
for (const lane of s.snapshot.lanes) {
  if (lane.operation?.status === "suspended") await (await harness.lane(lane.name))!.resume();
}
```

## 9. Snapshots and subscription

A UI needs current state plus every change after it, with no gap. This includes the transport gap: a server that proxies a harness must deliver the snapshot to its client before any event reaches the wire. `watch()` buffers until the consumer arms delivery:

```ts
const { snapshot, start, unsubscribe } = await lane.watch();   // harness.watch() = main's

await send(client, { kind: "snapshot", snapshot });   // snapshot is on the wire
start((event) => send(client, event));                // flush buffer in order, then live
```

`watch()` captures the snapshot and starts buffering in one step. `start(listener)` flushes the buffer in order and switches to live delivery. Each event arrives exactly once, in order. No sequence numbers, no registration race. `unsubscribe()` drops the subscription and its buffer; a watcher that never calls `start()` buffers without bound.

`watch()` is lane-scoped: this lane's transcript, operation state, queues, pending writes, and only this lane's events. A Slack thread renderer sees its thread and nothing else. `watchSession()` is the session-wide observer: lane inventory, no transcripts, unfiltered event stream. A dashboard composes both: `watchSession()` for the overview, `lane.watch()` per opened thread.

```ts
interface QueuedItem {
  entryId: string;                     // correlates with QueueResult and cancelQueued
  message: AgentMessage;
}

interface LaneSnapshot {
  lane: string;
  /** This lane's branch, oldest first: the context window plus its
      compaction entry. Older history is paged via session queries. */
  transcript: Entry[];
  leafId: string | null;

  operation: null | {
    id: string;
    kind: "run" | "compaction" | "navigation";
    status: "running" | "suspended" | "aborting";
    startedAt: number;                   // Unix ms
    /** status "suspended": everything a client needs to offer resume/abort.
        The same data create() returned; a remote UI only sees snapshots. */
    suspended?: SuspendedOperation;
    /** Live progress, when mid-step. What the watcher would have
        accumulated from streaming events. */
    streamingMessage?: AssistantMessage;
    runningTools: {
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult?: AgentToolResult;
    }[];
    retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
  };

  queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
  pendingWrites: { id: string; entry: ProvisionedEntry }[];

  faulted: boolean;                      // harness-wide, mirrored into every snapshot
}

interface SessionSnapshot {
  lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
  faulted: boolean;
}
```

Rules:

- Configuration is not in snapshots. Getters return the current value; `config_update` events (section 10) tell a UI when to re-read. One source of truth.
- `streamingMessage` and `runningTools` let a client that attaches mid-step render immediately, without replaying events.
- Reconnect means a new `watch()`. Against a living harness the new snapshot includes live progress. Only process death loses stream state: a restored harness has no partial streams to report, and the snapshot shows the suspended operation instead. The durable transcript is complete either way. Surviving transport drops is the serving layer's job.
- A lane watcher receives the section 10 event vocabulary filtered to its lane, plus harness-global events such as `fault`. `watchSession()` and `events.on(type, listener)` receive everything; `events.on` is live-only — no snapshot, no buffer.
- Watchers are independent; each has its own buffer and its own `start()` gate.

## 10. Events

One flat stream. `events.on(type, listener)` receives everything; lane watchers receive their lane's events (section 9).

Guarantees:

- Passive. A throwing listener is caught and reported as a `handler_error` event plus telemetry; it never affects execution. A listener that throws while handling `handler_error` goes to telemetry only.
- Ordered. Delivery follows process order, identical for watchers and `events.on`. Concurrent lanes do not promise `seq`-ordered passive delivery; durable consumers use `getLog()`.
- Not persisted, not replayed. Reconnect means a new `watch()`.
- Events that report durable facts fire after the fact is committed; what an event announces is already queryable.
- Events report final values, after hook transformation.
- Payloads are JSON-serializable and secret-free; a server can proxy them verbatim. Live objects (models, tools) are referenced by name, never embedded.
- Lane-scoped events carry `lane: string` (omitted below); harness-global events such as `fault` omit it. Operation-scoped events carry `runId`; step-scoped events carry `stepId`; recovered work carries `recovery: true`.

### Catalog

```ts
// Run lifecycle
{ type: "run_start";   runId }
{ type: "run_resume";  runId }                       // resume() entered
{ type: "run_suspend"; runId; deferred: DeferredHandle }   // lane parked
{ type: "run_abort";   runId; steer: AgentMessage[]; followUp: AgentMessage[] }  // abort accepted; cleared payloads
{ type: "run_end";     runId; outcome: "completed" | "aborted" | "failed";
                       leafId; finalEntryId?; finalMessage?; error? }
{ type: "fault";       code; message }               // harness-wide
{ type: "handler_error"; error; stack? } & ({ kind: "hook"; hook } | { kind: "event"; event })

// Steps and retries. First-try success emits no retry events.
{ type: "step_start"; runId; stepId }
{ type: "step_end";   runId; stepId; message: AssistantMessage; toolResults: ToolResultMessage[] }
{ type: "retry_scheduled"; runId; task; attempt; maxAttempts; delayMs; errorMessage }
{ type: "retry_start";     runId; task; attempt }
{ type: "retry_end";       runId; task; attempt; success: boolean; finalError? }

// Messages. Every message entering the tree fires these, regardless of
// source. message_end means committed; entryId is the tree entry.
{ type: "message_start";  runId?; message: AgentMessage }
{ type: "message_update"; runId; message: AgentMessage; event: AssistantMessageEvent }  // streaming only
{ type: "message_end";    runId?; message: AgentMessage; entryId: string }

// Tools
{ type: "tool_start";  runId; stepId; toolCallId; toolName; args }      // effective args
{ type: "tool_update"; runId; stepId; toolCallId; toolName; partialResult }
{ type: "tool_end";    runId; stepId; toolCallId; toolName; result; isError; terminate }

// Tree, queues, facts
{ type: "entry_added";   entry: Entry }              // non-message entries
{ type: "write_pending"; runId; entryId; entry }     // deferred write accepted; entry_added
                                                     // or message_end follows with the same id
{ type: "queue_update";  steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] }
{ type: "fact_update" } & (
  | { fact: "name";  name: string }
  | { fact: "label"; targetId: string; label: string | undefined })

// Configuration. Compact payloads; clients re-read via getters.
{ type: "config_update" } & (
  | { property: "model"; value: { provider; modelId }; previous }
  | { property: "thinkingLevel"; value; previous }
  | { property: "activeTools"; value: string[]; previous: string[] }
  | { property: "tools" | "resources" | "streamOptions" | "retryPolicy"
              | "compactionSettings" | "steeringMode" | "followUpMode" })

// Structural operations. End events mirror operation outcomes.
{ type: "compaction_start"; runId; reason: "manual" | "threshold" | "overflow" }
{ type: "compaction_end";   runId; reason; outcome: "completed" | "declined" | "aborted" | "failed";
                            entry?: CompactionEntry; fromHook: boolean; error? }
{ type: "navigation_start"; runId; targetId }
{ type: "navigation_end";   runId; outcome: "completed" | "declined" | "aborted" | "failed";
                            oldLeafId; newLeafId; summaryEntry?; error? }

// Lanes
{ type: "lane_created"; at: string | null }
```

### Nesting

```text
run_start
  step_start
    message_start / message_update* / message_end     assistant committed
    tool_start / tool_update* / tool_end              per call
    message_end                                       tool results, source order
  step_end
  compaction_start ... compaction_end                 auto, at a checkpoint, when needed
  step_start ... step_end                             until nothing is pending
run_end
```

A UI's busy indicator spans `run_start`..`run_end`, and the `compaction_start`/`navigation_start` brackets for standalone operations. Resumed structural operations re-emit their start event (`recovery: true`) so brackets always balance.

Failed attempts emit `retry_scheduled`, then `retry_start`, then `retry_end` when retrying resolves either way. `run_suspend` ends event flow for the parked lane; the next `run_resume` continues it.

## 11. Hooks

Hooks are awaited interception points. Registration mirrors events, with an optional stable registration id:

```ts
const off = harness.hooks.on("before_tool", async (event) => {
  if (event.toolName === "bash") return { block: { reason: "not allowed" } };
});

harness.hooks.on("before_run", async () => ({
  resumeData: { version: 1 },
}), { id: "extension.example" });
```

Semantics, uniform across all hooks:

- Registration is harness-global. Every hook event carries `lane` (omitted below); a handler scopes itself. Per-lane registration is an open question (section 19).
- `before_run` and `before_resume` registrations require a stable `id`. An id is unique within one hook name; duplicate registration rejects synchronously. The same extension uses the same id for both hooks across restarts. The runner stores each `before_run` handler's `resumeData` under its id and hands each `before_resume` handler only the value under the same id.
- `before_run` runs on the normalized caller prompt, outside the lane mutation line, before acceptance. It does not see captured nextRun items; the acceptance mutation captures those afterwards (section 15). A rejected acceptance (busy lane) discards the hook output.
- Handlers run sequentially in registration order. Each transformation handler sees the output of the previous one; returned `messages` append and a returned `systemPrompt` replaces the current value.
- A throwing handler does not fail the run: it is skipped, reported via `handler_error`, and the remaining handlers run. One exception: `before_tool` fails closed — a throwing handler blocks the tool. A skipped policy handler must not allow a tool it might have blocked.
- Hook results that feed durable state are persisted before execution proceeds: `before_run` output lands in the `operation_started` record, `before_tool` effective arguments in the `tool_started` record.
- Events report post-hook values; observers never see pre-hook state.

### Catalog

```ts
// Run boundaries ------------------------------------------------------

// Once per run, before acceptance. Not re-run on retry or resume; its
// output is persisted in the operation_started record.
before_run: {
  event:  { prompt: AgentMessage[]; systemPrompt: string; resources };
  result: {
    messages?: AgentMessage[];       // persisted as entries after the prompt
    systemPrompt?: string;           // persisted override, fixed for the run
    resumeData?: JsonValue;          // stored under this handler's registration id
  } | undefined;
}

// On resume(), before any effect. Rebuilds process-local extension state.
// Must be idempotent: a crash can rerun it. Cannot rewrite the prompt.
before_resume: {
  event:
    | { runId; kind: "run"; prepared: { prompt: AgentMessage[]; systemPromptOverride? };
        resumeData?: JsonValue }
    | { runId; kind: "compaction" | "navigation"; resumeData?: JsonValue };
  result: void;
}

// At a normal finish boundary: no tool continuation, no queued messages.
// Returned follow-ups continue the same run; the runner commits them
// conditionally — an abort that wins while the hook runs drops the
// follow-up (section 15). Does not run for abort, terminal failure, or
// exhausted auto-compaction. May fire again after a crash at the same
// boundary; handlers that must not double-fire keep their own durable
// marker.
before_run_end: {
  event:  { runId; messages: AgentMessage[] };
  result: { followUp?: string } | undefined;
}

// Request pipeline ----------------------------------------------------

// Per request. AgentMessage level, before toProviderMessages. Pruning,
// injection, custom-message handling. Ephemeral: shapes what the provider
// sees, never what the session contains.
transform_context: {
  event:  { messages: AgentMessage[] };
  result: { messages: AgentMessage[] } | undefined;
}

// Per request. Provider-neutral request options.
before_request: {
  event:  { model: Model; task: "step" | "compaction" | "branch_summary"; attempt; streamOptions };
  result: { streamOptions?: StreamOptionsPatch } | undefined;
}

// Per request. Provider-specific wire payload. Last stop.
before_payload: {
  event:  { model: Model; payload: unknown };
  result: { payload: unknown } | undefined;
}

// Per response, after the stream finishes, before the assistant message
// is committed. The committed message is what events and the session see.
after_response: {
  event:  { status: number; headers: Record<string, string>; message: AssistantMessage };
  result: { message?: AssistantMessage } | undefined;   // must keep role
}

// Tools ---------------------------------------------------------------

// After validation, before execution. Effective args are persisted in the
// tool_started record. Not re-run for a call whose tool_started exists.
before_tool: {
  event:  { toolCallId; toolName; args: Record<string, unknown> };
  result: { args?: Record<string, unknown>; block?: { reason: string } } | undefined;
}

// After execution, before the result entry is committed. Patch semantics,
// field by field. Runs on safe replay; not on synthetic results.
after_tool: {
  event:  { toolCallId; toolName; args; content; details; isError; usage? };
  result: { content?; details?; isError?; usage?; terminate?: boolean } | undefined;
}

// Structural operations ------------------------------------------------

// Decline, adjust, or supply the summary. Runs after operation_started,
// live and on resume alike. Not re-run when the result entry exists or a
// task_attempt already durably selected generated-summary work.
before_compaction: {
  event:  { reason: "manual" | "threshold" | "overflow"; preparation: CompactionPreparation; customInstructions? };
  result: { decline?: boolean; compaction?: CompactResult } | undefined;
}

before_navigation: {
  event:  { targetId; preparation: NavigationPreparation };
  result: {
    decline?: boolean;
    summary?: { summary: string; details?; usage? };
    customInstructions?: string;
    label?: string;
  } | undefined;
}
```

### Replay across retry and resume

Hooks re-run only where the work itself re-runs. Persisted outputs are never recomputed.

| hook | fresh | retry | resume |
|---|---|---|---|
| `before_run` | once | no | no (persisted) |
| `before_resume` | no | no | yes, idempotent |
| `transform_context`, `before_request`, `before_payload` | per request | yes | yes |
| `after_response` | per response | per response | per response |
| `before_tool` | per call | — | not when `tool_started` exists |
| `after_tool` | per executed result | — | on safe replay only |
| `before_compaction`, `before_navigation` | per operation | no | not when a result entry or a generated-summary `task_attempt` exists |
| `before_run_end` | per normal finish boundary | — | at the boundary resume reaches (may repeat); never for abort, terminal failure, or exhausted auto-compaction |

## 12. Session and SessionTree

### Entries

The tree content. No other entry types exist; pointers and global facts are not entries (section 2).

```ts
interface EntryBase {
  type: string;
  id: string;
  seq: number;                 // shared sequence; read-side, storage-assigned
  parentId: string | null;     // storage-assigned: the appending lane's leaf
  timestamp: number;           // Unix ms, storage-assigned
}

interface MessageEntry           extends EntryBase { type: "message"; message: AgentMessage }
interface ModelChangeEntry       extends EntryBase { type: "model_change"; provider: string; modelId: string }
interface ThinkingLevelEntry     extends EntryBase { type: "thinking_level_change"; thinkingLevel: string }
interface ActiveToolsEntry       extends EntryBase { type: "active_tools_change"; activeToolNames: string[] }
interface CompactionEntry        extends EntryBase { type: "compaction"; summary: string;
                                                     retainedTail: AgentMessage[];
                                                     tokensBefore: number; details?; usage? }
interface BranchSummaryEntry     extends EntryBase { type: "branch_summary"; fromId: string; summary: string;
                                                     details?; usage? }
interface CustomEntry            extends EntryBase { type: "custom"; customType: string; data? }

type Entry = MessageEntry | ModelChangeEntry | ThinkingLevelEntry | ActiveToolsEntry
           | CompactionEntry | BranchSummaryEntry | CustomEntry;
```

A v4 tool-result `MessageEntry` additionally persists the finalized batch-control decision as `terminate?: true` beside `message`. It is orchestration state for the reduction (section 7), never model context; the projection to provider messages ignores it. `AgentToolResult.terminate` exists at the tool API level but `ToolResultMessage` does not carry it, so the entry field is the durable form.

Every v4 compaction — generated or hook-supplied — stores the complete `retainedTail`; an empty tail is `[]`, never omission. The compaction entry is a self-contained checkpoint: context builds never read past it.

v3 files additionally contain `custom_message`, `label`, `session_info`, and `leaf` entries, plus old compaction entries that use `firstKeptEntryId`. Load normalizes them before exposing the v4 tree:

- `custom_message` becomes a custom agent message.
- `label` and `session_info` become global facts (latest by file position wins) and disappear from the logical tree. A label targets its nearest retained parent.
- `leaf` entries disappear; `main`'s leaf resolves through the last `leaf` entry, then to the nearest retained ancestor if that target was discarded.
- Each retained child of a discarded entry is reparented to the discarded entry's nearest retained ancestor.
- An old compaction resolves `firstKeptEntryId` against its own branch and materializes that range as `retainedTail`. V4 never exposes or persists `firstKeptEntryId`.
- v3 entry timestamps are ISO strings and convert to Unix milliseconds.

Read-only opens keep the physical v3 file unchanged; the first v4 write persists the normalized form (section 13).

### SessionTree

The tree-facing contract. Each lane exposes one view (`lane.session`); `Session` itself implements it for `main`. Reads pass through always. A write through a lane view enters that lane's mutation line: while a run is open — including suspension and cancellation — it becomes a durable deferred write; during compaction or navigation it waits for the operation to end; on an idle lane it appends directly. Writes on a standalone `Session` (no harness attached) apply immediately.

```ts
interface EntryQuery {
  type?: Entry["type"];
  customType?: string;                     // for type "custom"
  order?: "newestFirst" | "oldestFirst";   // default newestFirst
  limit?: number;
  cursor?: EntryCursor;
}

/** Bounds of a branch scan. Default: the whole path, leaf to root. */
interface BranchBounds {
  start?: string;              // default: the view's lane leaf
  stopAtType?: Entry["type"];  // scan ends after the first match, inclusive
  stopAtId?: string;
}

interface SessionTree {
  getLeafId(): Promise<string | null>;
  getEntry(id: string): Promise<Entry | undefined>;
  getStats(): Promise<SessionStats>;

  // Global facts. Latest wins; not branch-scoped. "set", not "append":
  // append vocabulary is reserved for tree writes.
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
  getLabel(targetId: string): Promise<string | undefined>;
  setLabel(targetId: string, label: string | undefined): Promise<void>;

  /** Session-wide, all branches, sequence order. */
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  findEntry(query?: EntryQuery): Promise<Entry | undefined>;

  /** Branch-scoped: the path from start toward root. */
  findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
  findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;

  // Writes. Resolve on durable acceptance; the returned id is the entry's
  // id (provisioned when the write defers).
  appendMessage(message: AgentMessage): Promise<string>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}
```

Query semantics: a branch scan takes the path from `start` to root, walks it in `order` direction, stops after a `stopAt` match (inclusive), filters, then applies `limit` and `cursor`.

- `newestFirst` with `stopAtType: "compaction"` ends at the newest compaction: the context window.
- `type` and `customType` filter results; a `stopAt` entry is returned only if it passes the filter.
- Extension patterns: effective state = `findEntryOnBranch({ type: "custom", customType })`; collections = `findEntriesOnBranch(...)`; global inventory = `findEntries(...)`.
- Context build is a branch scan with `stopAtType: "compaction"`, projected through `entryProjectors` and `toProviderMessages`. Its projection is the compaction summary, the materialized `retainedTail`, then the entries after the compaction; nothing before the compaction is read.
- `SessionTree` has no navigation; moving a lane is `navigateTree()` on the lane.

Read consistency: finders and `getEntry` return committed entries only. A deferred write is not in the tree until applied; a handler that appends and immediately queries does not see its own write. Pending writes are visible in the snapshot, correlated by provisioned id.

### Session

`Session` adds the lane surface and the record log. It is usable standalone — no harness required. In production the harness writes records; recovery fixtures and Tier A tests prefill them through the same API. Lanes, entries, and facts are Session-level.

```ts
class Session implements SessionTree {          // bound to "main"
  constructor(storage: SessionStorage, options?: { idGenerator?: IdGenerator });
  /** Process-local id provisioning used by Session and harness. Default
      UUIDv7; tests inject a deterministic generator. Sync by design. */
  readonly idGenerator: IdGenerator;

  /** SessionTree bound to a lane: reads default to its leaf, appends chain
      to it and advance it. The only write-binding mechanism; no SessionTree
      method takes a lane parameter. view("main") behaves like the Session. */
  view(lane: string): SessionTree;

  // Lanes — permanent named pointers. Durable via storage (section 13).
  getLanes(): Promise<{ lane: string; leafId: string | null }[]>;
  createLane(lane: string, at: string | null): Promise<void>;   // rejects existing names
  moveLane(lane: string, to: string | null): Promise<void>;

  /** Low-level provisioned append for the harness, recovery, and test
      fixtures. Bypasses the SessionTree deferral policy; a harness caller
      already holds the lane mutation line. */
  appendEntry<T extends Entry>(entry: ProvisionedEntry<T>, lane: string): Promise<T>;

  // Records — harness and recovery only.
  appendRecord(record: NewRecord): Promise<LaneRecord>;
  findRecords(query?: { lane?: string; type?: LaneRecord["type"]; runId?: string;
                        afterSeq?: number; order?; limit? }): Promise<LaneRecord[]>;
  /** Full chronological view: entries, records, facts, lane moves,
      merged by seq. Debugging and tests. */
  getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;
}

interface IdGenerator { next(): string; }
```

The old `getStorage()` escape hatch is gone: all writes flow through `Session`, which is the single writer the storage contract assumes.

**Ownership rule:** after an application passes a `Session` to `AgentHarness.create()`, it mutates that session only through the harness and its lane views until `close()` resolves. Concurrent writes through the original standalone reference are unsupported caller misuse; the harness adds no machinery for it.

## 13. Storage

### Contract

One session per storage instance. Storage persists and answers queries; `Session` owns validation and view binding. Storage knows nothing about operations, queues, or recovery; record payloads are opaque except for indexed columns.

```ts
interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;

  // Lanes
  getLanes(): Promise<{ lane: string; leafId: string | null }[]>;
  createLane(lane: string, at: string | null): Promise<void>;
  moveLane(lane: string, to: string | null): Promise<void>;

  /** Durable on resolve. Input carries no parentId, seq, or timestamp;
      storage assigns all three. parentId is the lane's current leaf; the
      entry becomes the lane's new leaf, in the same transaction. Callers
      cannot pass a stale parent because they never pass one. */
  appendEntry<T extends Entry>(entry: ProvisionedEntry<T>, lane: string): Promise<T>;
  appendRecord(record: NewRecord): Promise<LaneRecord>;

  // Reads
  getEntry(id: string): Promise<Entry | undefined>;
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  /** start is mandatory here; defaulting to a lane's leaf is view sugar. */
  findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]>;
  findRecords(query?: RecordQuery): Promise<Record[]>;
  getLog(options?): Promise<LogItem[]>;

  // Global facts
  getName(): Promise<string | undefined>;      setName(name: string): Promise<void>;
  getLabel(id: string): Promise<string | undefined>;  setLabel(id, label): Promise<void>;
  getStats(): Promise<SessionStats>;
}
```

Contract rules, all backends:

- One monotonic `seq` across entries, records, facts, and lane moves.
- Storage linearizes concurrent writes from all lanes of the session and allocates `seq` inside each write's atomic commit; callers never read, reserve, or increment the sequence. Write promises resolve in commit order. The lane mutation line (section 15) serializes decisions; this rule serializes the writes underneath them — both are needed, neither replaces the other.
- A write is durable when its promise resolves; events fire after.
- `Session` and the harness provision ids with `session.idGenerator`; storage enforces per-session uniqueness at append.
- Every durable payload must be JSON-serializable. `Session` validates before dispatch so Memory, JSONL, and SQLite accept the same values; Memory does not retain values JSONL would reject.
- Reads return immutable data.
- No conditional writes exist. Single-writer plus the lane mutation line make compare-and-set unnecessary; storage stays plain appends and pointer/fact updates.
- One writer per session, enforced by the serving layer; SQLite additionally rejects a second writer itself. Per session, not per backend: one SQLite database hosts many sessions, each with its own single writer.
- Any write failure faults the harness (section 4). The store is left a valid prefix.
- Global-fact and lane-move history is kept, never rewritten: latest by `seq` wins. History is the cheaper implementation (insert, never update), and lane-move history is a reflog if anyone ever wants one.

### Memory

Plain structures: entry map, record list, lane map, fact lists, one seq counter, one session-wide write queue. Append validates, clones, allocates `seq` at the head of that queue, commits; reads clone out. The reference implementation: the parity test suite runs against it first.

### JSONL

One file per session: a header line, then one JSON object per line, in `seq` order. Every logical mutation is exactly one line; a line is the atomic unit.

```text
{"kind":"header", "version":4, id, createdAt, cwd, parentSessionId?}
{"kind":"entry",  "lane":"main", id, parentId, type, timestamp, ...}
{"kind":"record", "lane":"main", id, runId?, type, timestamp, ...}
{"kind":"lane",   "lane":"slack:t1", "leafId":"e42"}        // create or move
{"kind":"fact",   "fact":"name",  "name":"Refactor auth"}
{"kind":"fact",   "fact":"label", "targetId":"e17", "label":"checkpoint"}
```

- Open reads the whole file into memory; all queries run against that state. One session-wide append queue serializes writes from every lane, one line each; the queue allocates `seq`, and its order is the line order. Every storage mutation in this section is exactly one line — nothing in the design needs a multi-line atomic write.
- The `lane` field on entry lines is envelope metadata: replay derives each lane's leaf from it (last entry line per lane, overridden by later `lane` lines). It dies at decode; entries expose `seq` but no lane.
- Torn tail: a malformed final line is the append that died mid-write. Open truncates it; the write was never acknowledged, nothing is lost. A malformed line anywhere else is corruption; open rejects.
- Durability is process-crash level: a resolved append call. No fsync promise; if power-loss durability is ever needed, it becomes an explicit capability.
- v3 files: entries only, no `kind` tags. Open builds the normalized logical tree from section 12; every entry belongs to `main`, and `main`'s leaf resolves through the last `leaf` entry to its nearest retained ancestor. Before the first v4 append, the file is rewritten once with a v4 header (write temp, rename). This is the single conversion the compatibility policy allows. Read-only opens never rewrite.

### SQLite

Greenfield schema; existing WIP databases are discarded. The engine design is the current engine's, with one persisted leaf per lane instead of the single implicit active leaf.

```sql
session_sequences (session_id, next_seq)                    -- atomic seq allocator
entries        (session_id, seq, id, parent_id, type, timestamp, payload)
records        (session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload)
lanes          (session_id, lane, leaf_id)          -- current pointer per lane
lane_moves     (session_id, seq, lane, leaf_id)     -- history; getLog parity
facts          (session_id, seq, kind, key, value)  -- name, labels; latest by seq
branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type, custom_type)
branch_tips    (session_id, branch_id, tip_id)      -- PRIMARY KEY (session_id, tip_id)
leases         (session_id, owner, heartbeat)       -- writer claim

-- indexes
records:        (session_id, lane, type, seq), (session_id, lane, type, op_kind, seq)
branch_entries: (session_id, branch_id, entry_type, entry_seq)
                (session_id, entry_id)              -- reverse lookup: entry → branches
```

`branch_entries` and `branch_tips` are a private read cache. No interface exposes them; no other backend has them; rebuilding them from parent pointers is an explicit repair operation, never a runtime fallback.

Two invariants carry the whole design:

- **Every entry is in at least one branch.** Every append inserts its entry into a branch (extend or copy, below). A branch holds a full root path; below any entry it contains, it agrees with every other branch containing that entry, because parent chains are unique.
- **Tips are unique.** A branch only ever ends in the entry that was just created — extension and copy both place a brand-new entry at the end — so no two branches share a tip. `branch_tips` answers "does a branch end at X" with one point lookup, 0 or 1 rows.

**Read plan** — `findEntriesOnBranch({ start })`, any entry, tip or not:

1. Reverse index: look up `start` → any containing branch.
2. Range scan that branch, `entry_seq <= start.seq` (parent-before-child makes path order equal seq order), join entries, apply filters and stops.

**Append plan** — `appendEntry(entry, lane)`, one transaction. The storage instance queues writes before opening the transaction; the transaction increments the session's sequence row and uses the returned value, so concurrent lane calls cannot receive the same `seq` and their promises resolve in that order.

1. `leaf = lanes[lane].leaf_id`; allocate `seq` from `session_sequences`; insert the entry with `parent_id = leaf`.
2. `branch_tips` lookup: does a branch end at `leaf`?
   - Yes → insert one `branch_entries` row there; update that tip to the new entry.
   - No → new branch: copy rows `entry_seq <= leaf.seq` from any branch containing `leaf`, insert the new entry's row, insert its tip. (Empty lane: no copy, just the new branch.)
3. `lanes[lane].leaf_id = entry.id`. Update fact/stats projections. Commit, then events.

The four cases, `Bn: [...]` are one branch's rows in seq order:

```text
Case 1 — plain append. The overwhelmingly common case: one lookup, one row.

  tree: a(1)─b(2)─c(3)      lanes: main→c       cache: B1:[a b c]
  main appends d(4):        a branch ends at c → extend
  tree: a─b─c─d             lanes: main→d       cache: B1:[a b c d]

Case 2 — two lanes, one leaf. First extends, second copies.

  lanes: main→c, t1→c                           cache: B1:[a b c]
  t1 appends u(4):          B1 ends at c → extend        B1:[a b c u]
    (B1 now runs past main's leaf — harmless: main's reads stop at seq ≤ 3)
  main appends d(5):        no branch ends at c → copy   B2:[a b c d]
  tree: a─b─c─u                                 lanes: main→d, t1→u
            └─d

Case 3 — lane parked mid-history. createLane("t2", at=b), then append.

  lanes: main→d, t2→b                           cache: B1:[a b c u], B2:[a b c d]
  t2 reads:                 b found in B1 (or B2), scan seq ≤ 2 — nothing built
  t2 appends x(6):          no branch ends at b → copy   B3:[a b x]

Case 4 — a branch still ends at an entry that has children.

  From case 2: B1:[a b c u], B2:[a b c d]; t1 navigates away, main navigates to c.
  main appends e(7):        c has children (u, d) — but the tip test asks the
                            right question: does a branch END at c? No → copy.
  If instead a branch DID end there (its continuation had gone to another
  branch's copy), the tip test extends it — one row instead of a path copy.
  The has-children test would copy needlessly; the tip test never does.
```

Stale branches (no lane resolves through them) are kept, matching the current engine.

Every restore query is an index seek plus a bounded scan: a lane's open operation via `(lane, type, seq)`, its last run-kind start via `(lane, type, op_kind, seq)`, its records above the operation via the same index, its own entries via the read plan from its leaf. No query touches another lane's traffic.

## 14. Agent-loop building blocks

`agent-loop.ts` is split into building blocks. Blocks own no durable state and know nothing about sessions, records, or lanes. The harness composes them and inserts its durability writes between their phases. The existing `agentLoop` / `runAgentLoop` API stays in the file as a thin composition of the same blocks, with its current signature and behavior — existing consumers do not change.

### Streaming one assistant response

```ts
export interface StreamAssistantConfig {
  model: Model;
  systemPrompt?: string;
  tools?: AgentTool[];
  /** AgentMessage[] → AgentMessage[]. Pruning, injection. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** AgentMessage[] → provider messages. */
  toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** Dispatch. models.streamSimple resolves auth per request (credential
      store, expiring tokens, header merge, env, baseUrl) — no auth surface
      on this config. streamFn overrides dispatch for tests. */
  models: Models;
  streamFn?: StreamFn;
  /** SimpleStreamOptions carries apiKey/headers/env overrides, transport,
      timeouts, metadata, deferred — and onPayload/onResponse, the mounting
      points for the before_payload and after_response hooks. */
  streamOptions?: SimpleStreamOptions;
  signal?: AbortSignal;
}

/** One provider request. Emits message_start / message_update / message_end
    to the sink; returns the final assistant message. Provider errors are
    in-band: stopReason "error" | "aborted" | "deferred". Does not mutate
    its inputs — persistence is the caller's job. */
export function streamAssistant(
  messages: AgentMessage[],
  config: StreamAssistantConfig,
  emit: AgentEventSink,
): Promise<AssistantMessage>;
```

### Tool execution

Tools declare recovery safety. Omission means `"never"`:

```ts
interface AgentTool {
  replay?: "never" | "safe";
  // existing fields
}
```

Three phases per call, exposed separately because the harness needs to write between them and recovery needs phase 2 and 3 without phase 1:

```ts
type PreparedToolCall  = { kind: "prepared"; toolCall: AgentToolCall; tool: AgentTool; args: unknown };
type ImmediateOutcome  = { kind: "immediate"; result: AgentToolResult; isError: true };
                         // unknown tool, invalid args, blocked, aborted
type FinalizedToolCall = { toolCall: AgentToolCall; result: AgentToolResult; isError: boolean };

/** Phase 1 — clearance. Tool lookup, prepareArguments, schema validation,
    beforeToolCall (may replace args or block), validation of replacement
    args, abort checks. No effect starts here. */
export function prepareToolCall(
  toolCall: AgentToolCall, tools: AgentTool[], callbacks: ToolCallbacks, signal?: AbortSignal,
): Promise<PreparedToolCall | ImmediateOutcome>;

/** Phase 2 — the effect. Streams tool_execution_update via the sink and
    drains pending update events before resolving. Never throws; failures
    become error results. */
export function executeToolCall(
  prepared: PreparedToolCall, emit: AgentEventSink, signal?: AbortSignal,
): Promise<{ result: AgentToolResult; isError: boolean }>;

/** Phase 3 — afterToolCall patch, field by field; a throwing callback
    becomes an error result. */
export function finalizeToolCall(
  prepared: PreparedToolCall, executed: { result; isError }, callbacks: ToolCallbacks, signal?: AbortSignal,
): Promise<FinalizedToolCall>;

/** content ?? [] normalization, addedToolNames passthrough, timestamp. */
export function createToolResultMessage(finalized: FinalizedToolCall): ToolResultMessage;
export function createErrorToolResult(text: string): AgentToolResult;

export interface ToolCallbacks {
  beforeToolCall?(call, args, signal): Promise<{
    args?: Record<string, unknown>;
    block?: { reason: string };
  } | undefined>;
  afterToolCall?(call, result, isError, signal): Promise<ToolResultPatch | undefined>;
  /** Between phases 1 and 2: the durability point. The harness writes its
      tool_started record here. Called in source order in both modes —
      preparation is always sequential. */
  onToolStart?(call: AgentToolCall, effectiveArgs: Record<string, unknown>): Promise<void>;
  /** After phase 3, before the result message is emitted; source order.
      The harness appends the result entry here, persisting the finalized
      terminate decision on it (section 12). */
  onToolResult?(message: ToolResultMessage, terminate: boolean): Promise<void>;
}

/** The batch driver. Rules, preserved from the current loop:
    - stopReason "length" fails every call without executing: streamed
      arguments are salvage-parsed and can validate while silently
      truncated; none are safe.
    - Mode: sequential when options.toolExecution === "sequential" or when
      any called tool declares executionMode "sequential"; else parallel.
    - Parallel mode: phase 1 and onToolStart run sequentially in source
      order; phase 2 runs concurrently; phases 3, onToolResult, and message
      emission happen in source order after all executions settle.
    - Abort: no further calls are prepared; already-executing calls settle.
    - terminate: true when every finalized result sets terminate. */
export function executeToolBatch(
  assistant: AssistantMessage, tools: AgentTool[], callbacks: ToolCallbacks,
  options: { toolExecution?: "sequential" | "parallel" }, emit: AgentEventSink, signal?: AbortSignal,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }>;
```

### Compatibility wrapper

The existing public interface of `agent-loop.ts` must not break. Every current export keeps its signature and behavior: `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue`, `AgentEventSink`, and the config surface they consume (`getSteeringMessages`, `getFollowUpMessages`, `prepareNextTurn`, `shouldStopAfterTurn`, `beforeToolCall`, `afterToolCall`, event order included). They are reimplemented as thin compositions of `streamAssistant` and `executeToolBatch` — no durability, no new semantics. Acceptance criterion: the existing `agent-loop` and `agent` test suites pass unchanged.

## 15. Harness internals

The code below is the specification of harness behavior, composed from the section 14 blocks. Live calls and resume run the same procedures: `prompt()` runs `runProcedure()` after acceptance; `resume()` runs it with the operation already recorded. Everything is lane-scoped; procedures of different lanes run concurrently and meet only at the storage append path.

Part III adds no new durability semantics over Part II. It adds two mechanisms: the **effects boundary**, which makes every crash site steppable, and the **lane mutation line**, which closes the check-then-act races between a running procedure and the public lane surface.

### The effects boundary

Every effect a procedure performs goes through one injected `Effects` handle, `fx`. In `drive: "automatic"` the handle passes straight through to the session, the models, the tools, and the hook runner. In `drive: "manual"` the same handle is wrapped in a gate (below). The method list is the complete crash-site catalog: stopping before or after one of these calls is exactly a section 6 X state.

```ts
interface Effects {
  // Durable writes. Each validates and commits at the head of the lane's
  // mutation line (below), then updates LaneState.
  appendEntry(entry: ProvisionedEntry): Promise<Entry>;
  appendRecord(record: NewRecord): Promise<LaneRecord>;
  moveLane(to: string | null): Promise<void>;
  setFact(fact: FactWrite): Promise<void>;

  // Conditional commits. Decision and write in one mutation-line job.
  tryFinishRun(runId: string, outcome: "completed" | "failed",
               error?: ErrorInfo): Promise<"finished" | "continue">;
  finishOperation(runId: string, outcome: "completed" | "declined" | "failed" | "aborted",
                  error?: ErrorInfo): Promise<"finished" | "continue">;
  commitRunEndFollowUp(runId: string, item: ProvisionedEntry): Promise<"committed" | "dropped">;
  consumeQueueItem(runId: string, queue: "steer" | "followUp",
                   entryId: string): Promise<"consumed" | "skipped">;
  applyPendingWrite(runId: string, entryId: string): Promise<"applied" | "skipped">;

  // External effects.
  streamAssistant(request: AssistantRequest): Promise<AssistantMessage>;
  executeTool(prepared: PreparedToolCall): Promise<{ result: AgentToolResult; isError: boolean }>;
  fetchDeferred(model: Model, handle: DeferredHandle): Promise<AssistantMessage>;
  cancelDeferred(model: Model, handle: DeferredHandle): Promise<void>;

  // Interception and time.
  runHook<K extends HookName>(name: K, event: HookEvent<K>): Promise<HookResult<K>>;
  sleep(delayMs: number): Promise<"elapsed" | "aborted">;
}
```

Rules:

- Reads (`getEntry`, `findEntriesOnBranch`, context building, id allocation) are not effects and never gate.
- **Construction rule:** procedures receive only `fx` — never the session, models, tools, or hook runner directly. Tool objects handed to `executeToolBatch` are wrapped so each `execute` routes through `fx.executeTool`; the section 14 callbacks route through `fx.runHook`, `fx.appendRecord`, and `fx.appendEntry`. The rule is enforced by construction and by a test: any operation driven in manual mode performs zero storage writes and zero provider or tool calls while parked.
- `fx.streamAssistant` wraps section 14 `streamAssistant` with authenticated dispatch through `Models`; `transform_context`, `before_payload`, and `after_response` run inside it via `fx.runHook`. Summary tasks force `deferred: false`; a deferred structural result is a defect.
- The `fx` implementation converts a rejected `fetchDeferred` into a `stopReason: "error"` assistant message, so expected provider failures stay in-band. Unexpected rejections from durable writes fault the harness (section 4).

### The lane mutation line

Every race in this design has one shape: a decision is made from lane state, an `await` passes, then a durable write commits the stale decision. The fix is structural. Each lane has one process-local FIFO — a promise chain — and every state-dependent decision commits inside one job on it:

```ts
let tail: Promise<unknown> = Promise.resolve();

function mutateLane<T>(job: () => Promise<T>): Promise<T> {
  const result = tail.then(job);
  tail = result.then(() => undefined, () => undefined);
  return result;
}
```

A job is: validate against live `LaneState` → at most one durable write → update `LaneState`. Nothing else. Provider requests, tool executions, hooks, and backoff never run inside a job; they run between jobs, which is exactly why every commit revalidates inside its own job. Because jobs run one at a time, two concurrent operations on a lane have exactly two possible histories — `[A, B]` or `[B, A]` — and both are defined outcomes. No third, interleaved history exists.

The jobs, by caller:

- **Lane surface** (ungated, enqueue directly):
  - *Operation acceptance* — validate idle, capture the pending `nextRun` items into `initialMessages`, write `operation_started`, set `state.operation`. The second of two concurrent acceptances sees the first and rejects `busy` with no write. `before_run` ran before this job, outside the line, on the prompt only.
  - *Queue acceptance* (`steer`, `followUp`) — validate an active, non-aborting run; write `queue_enqueued`. `nextRun` validates nothing and always accepts.
  - *Queue cancellation* (`cancelQueued`) — target entry exists: `already_consumed`; not pending (abort-drained or already cancelled): `already_cleared`; else write `queue_cancelled` and remove the item from its pending set.
  - *Deferred-write acceptance* (lane-view writes, config setters) — run open: write `write_deferred`; structural operation open: wait for it to end, then re-enter; idle: append the entry directly.
  - *Abort* — write `abort_requested`, set `aborting`, drain `pendingSteer`/`pendingFollowUp` (payloads return to the abort caller and in the `run_abort` event), signal the active effect's `AbortController`.
  - *Resume admission* — reserve the lane's single execution slot; no write.
- **Procedure via `fx`** (gated in manual mode):
  - `tryFinishRun` — if aborting or anything pending, write nothing and return `"continue"`; else write `operation_finished` and idle the lane.
  - `consumeQueueItem` — if the item is still pending and the run is not aborting, append its entry and remove it; else `"skipped"`.
  - `applyPendingWrite` — same shape for deferred writes; they apply even while aborting.
  - `commitRunEndFollowUp` — write `queue_enqueued` only while the run is active and non-aborting; else `"dropped"`.
  - `finishOperation` — terminal record unless preempted: a non-abort outcome returns `"continue"` when an abort marker exists; an `"aborted"` outcome returns `"continue"` while deferred writes are still pending, so reconciliation applies them first.
  - Plain `appendEntry`/`appendRecord`/`moveLane`/`setFact` — unconditional single writes, still serialized by the line.

Two examples, both orders legal, nothing else possible:

```text
steer vs finish                          abort vs before_run_end follow-up
[steer, finish]:                         [abort, commit]:
  queue_enqueued; pendingSteer=[x]         abort_requested; queues drained
  tryFinishRun → "continue"                commitRunEndFollowUp → "dropped"
  run consumes the steer                   reconciliation; no record after abort
[finish, steer]:                         [commit, abort]:
  operation_finished; lane idle            queue_enqueued committed
  steer → no_active_run, no write          abort drains it; payload returned
```

### Race catalog

The complete list. Each row names the two legal histories and the jobs that force them. Tier C (section 20) tests both orders of every row.

| # | race | histories | mechanism |
|---|---|---|---|
| 1 | `prompt()` vs `prompt()` | one accepted; other `busy`, no write | acceptance job |
| 2 | `steer`/`followUp` vs run finish | consumed at a checkpoint · `no_active_run` | queue acceptance + `tryFinishRun` |
| 3 | deferred write vs run finish | applied before close · idle direct append | write acceptance + `tryFinishRun` |
| 4 | abort vs run finish | reconciliation, outcome `aborted` · `no_active_operation` | abort job + `tryFinishRun` |
| 5 | abort vs queue consumption | entry appended, not in abort payload · returned by abort, skipped | `consumeQueueItem` + abort drain |
| 6 | abort vs `before_run_end` follow-up | committed then drained by abort · dropped, nothing behind the marker | `commitRunEndFollowUp` |
| 7 | `nextRun` vs acceptance | captured by this run · belongs to the next | capture inside acceptance |
| 8 | deferred write vs abort close | applied during reconciliation · applied before it | `finishOperation("aborted")` loops |
| 9 | config/tree write vs acceptance snapshot | committed before the run's first request · deferred write | both are line jobs; snapshots read after acceptance |
| 10 | abort vs in-flight provider/tool effect | effect settles · effect interrupted | irreducible: signal cancellation; only the procedure commits results (abort path owns synthetics) |
| 11 | cross-lane writes | any interleaving | storage `seq` linearization (section 13); lanes share no state |
| 12 | `cancelQueued` vs consumption | consumed first: `already_consumed` · cancelled first: consumption skips, the model never sees it | cancel job + `consumeQueueItem` |

Row 10 is the one race no ordering can remove: an external effect may have happened even though its result never arrived. The design's answer is the section 5 intent record plus the replay policy — the same answer as for a crash.

### Drive modes

`drive: "automatic"` passes `fx` through; zero overhead. `drive: "manual"` wraps the operation's `fx` in a gate: every method call parks before executing and surfaces a JSON-safe description.

```ts
type ActionInfo =
  | { kind: "append_entry";  entryType: Entry["type"]; entryId: string }
  | { kind: "append_record"; recordType: LaneRecord["type"] }
  | { kind: "move_lane"; to: string | null }
  | { kind: "set_fact"; fact: "name" | "label" }
  | { kind: "try_finish_run"; outcome: "completed" | "failed" }
  | { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
  | { kind: "commit_follow_up" }
  | { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
  | { kind: "apply_pending_write"; entryId: string }
  | { kind: "stream_assistant"; task: "step" | "compaction" | "branch_summary"; attempt: number }
  | { kind: "execute_tool"; toolCallId: string; toolName: string }
  | { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
  | { kind: "hook"; name: HookName }
  | { kind: "sleep"; delayMs: number };
```

```ts
class GatedEffects implements Effects {
  private readonly queue: { info: ActionInfo; release: () => void }[] = [];

  private gate<T>(info: ActionInfo, run: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ info, release: () => run().then(resolve, reject) });
      this.arrived();          // wakes a pending peekAction()
    });
  }

  appendRecord(record: NewRecord) {
    return this.gate({ kind: "append_record", recordType: record.type },
                     () => this.inner.appendRecord(record));
  }
  // ... one wrapper per method
}
```

The public controls, on the lane (section 8):

- `peekAction()` resolves with the description of the next parked call, or `undefined` when no operation exists or the operation has settled. No side effect; calling it twice returns the same action.
- `executeAction()` releases exactly the parked call `peekAction()` describes, awaits that effect's completion, and returns the next parked action or `undefined`. It never releases two.
- `runToCompletion()` releases until the operation settles.
- Two concurrent drivers are a programmer defect, as is calling the controls in automatic mode.

Semantics that make tests deterministic:

- The gate serializes. Parallel tool batches issue phase-2 calls in source order (phase 1 is sequential, section 14); the gate parks them as separate `execute_tool` actions and manual mode runs them one at a time. Parallelism is a production optimization; source-ordered finalization already fixes the semantics, so automatic and manual modes produce the same durable log.
- The lane surface stays ungated. While the procedure is parked, a test calls `steer()`, `abort()`, `session.appendMessage()` — their jobs run on the mutation line immediately. Both orders of every race-catalog row are constructed by choosing whether to call the surface method before or after `executeAction()`.
- `close()` while parked: every parked call rejects with `HarnessClosed`, the local operation promise rejects, nothing else commits. The durable state is exactly the prefix of released effects — the definition of a crash site. Reopen the backend and `resume()` runs ordinary section 7 recovery. In automatic mode `close()` signals the in-flight effect, waits for the append in progress, and releases the writer claim; open operations stay resumable either way.

### Live lane state

```ts
/** In-memory state per lane. Always equal to the reduction of the lane's
    records and own entries (section 7): live commits update it; restore
    recomputes it. */
interface LaneState {
  leafId: string | null;
  operation: null | {
    id: string;
    kind: "run" | "compaction" | "navigation";
    intent: OperationStarted["intent"];
    aborting: boolean;
    task: null | {                          // unfinished task: attempts newer than newest own entry
      kind: "step" | "compaction" | "branch_summary";
      attempts: number;
      compactionReason?: "manual" | "threshold" | "overflow";
    };
    toolBatch: null | ToolBatchState;
    missingInitialMessages: ProvisionedEntry[];
    pendingSteer: ProvisionedEntry[];
    pendingFollowUp: ProvisionedEntry[];
    pendingWrites: ProvisionedEntry[];
    deferred: DeferredHandle | null;        // unredeemed handle
    /** Newest entry this operation appended; pure predicates read it. */
    newestOwn: null | { entryId: string; type: Entry["type"];
                        role?: AgentMessage["role"]; stopReason?: StopReason };
    targets: { result?: boolean; summary?: boolean };   // structural ops
  };
  pendingNextRun: ProvisionedEntry[];
}

interface ToolBatchState {
  assistantEntryId: string;
  calls: {                                  // original source order and ordinals
    toolIndex: number;
    toolCall: AgentToolCall;
    started?: ToolStarted;
    resultExists: boolean;
    terminate?: boolean;                    // persisted on the result entry
  }[];
  truncated: boolean;                       // assistant stopReason was "length"
  unresolved: boolean;
}
```

Three control-flow signals travel by exception inside a procedure; none escapes to a caller. `RunFailed` carries a terminal failure into the drain-and-finish path. `Park` unwinds when a deferred handle was persisted; the lane suspends. `Aborted` unwinds to the abort path. Any other rejection faults the harness.

```ts
class RunFailed { constructor(readonly error: ErrorInfo) {} }
class Park      { constructor(readonly handle: DeferredHandle) {} }
class Aborted   {}

const newId = (): string => session.idGenerator.next();

/** Recovery-safe re-entry everywhere: skip a provisioned id that already
    exists (verify equal content; different content is corruption). */
async function appendIfMissing(target: ProvisionedEntry): Promise<void> {
  if (!(await session.getEntry(target.id))) await fx.appendEntry(target);
}
```

### Dispatch

```ts
async function resume(): Promise<ResumeResult> {
  if (missing.tools.length || missing.models.length) return rejected("missing_identities");
  emit({ type: "run_resume", runId: op.id, recovery: true });
  switch (op.kind) {
    case "run":        return { kind: "run",        ...await runProcedure() };
    case "compaction": return { kind: "compaction", ...await compactionProcedure() };
    case "navigation": return { kind: "navigation", ...await navigationProcedure() };
  }
}

async function runProcedure(): Promise<RunResult> {
  try {
    for (const m of [...op.missingInitialMessages]) await appendIfMissing(m);  // never dropped
    if (op.aborting) return await abortPath();

    if (op.deferred) {
      const redeemed = await redeemDeferred();               // may throw Park, RunFailed, Aborted
      if (hasToolCalls(redeemed)) await runToolBatch(redeemed);
    }
    if (op.toolBatch?.unresolved) await reconcileToolBatch(op.toolBatch);

    // A crash mid-task resumes that exact task before new checkpoint input
    // is consumed (section 7). Live retry and recovery consume identically.
    if (op.task?.kind === "step") {
      const outcome = await stepAndTools();
      if (outcome) return outcome;
    } else if (op.task?.kind === "compaction") {
      await autoCompact(requireAutoReason(op.task));         // recorded reason
    } else if (op.task) {
      throw new Error("Run has a branch-summary task");      // corruption
    }

    if (newestOwnMessageIsTaskError(state)) {                // terminal-failure marker (section 7)
      return await handleRunFailed(existingFailure(state));
    }
    return await driverLoop();
  } catch (e) {
    return await handleRunSignal(e);
  }
}

async function handleRunSignal(e: unknown): Promise<RunResult> {
  if (e instanceof Park)      return suspended(e.handle);    // discard procedure; lane parked
  if (e instanceof Aborted)   return await abortPath();
  if (e instanceof RunFailed) return await handleRunFailed(e.error);
  throw e;                                                   // storage/defect → faulted harness
}
```

### The loop

```ts
async function driverLoop(): Promise<RunResult> {
  while (true) {
    // checkpoint — each consumption is a conditional mutation-line job
    for (const w of [...op.pendingWrites])            await fx.applyPendingWrite(op.id, w.id);
    for (const m of steeringForThisCheckpoint(op))    await fx.consumeQueueItem(op.id, "steer", m.id);
    if (op.aborting) return await abortPath();
    if (await contextOverLimit()) await autoCompact(pressureReason());   // may throw RunFailed

    if (needsAssistant()) {
      const outcome = await stepAndTools();
      if (outcome) return outcome;
      continue;                                              // fresh checkpoint
    }

    for (const m of followUpsForThisCheckpoint(op))   await fx.consumeQueueItem(op.id, "followUp", m.id);
    if (needsAssistant() || hasPendingWork()) continue;

    // finish boundary
    const r = await fx.runHook("before_run_end", { runId: op.id, messages: runMessages() });
    if (r?.followUp) {
      await fx.commitRunEndFollowUp(op.id, provisionUserMessage(newId(), r.followUp));
    }
    if (hasPendingWork()) continue;

    const done = await fx.tryFinishRun(op.id, "completed");
    if (done === "finished") return finished("completed");
    // "continue": accepted input or abort won the ordering — loop
  }
}

async function stepAndTools(): Promise<RunResult | undefined> {
  const assistant = await stepTask();                        // may throw Park, RunFailed, Aborted
  if (assistant.stopReason === "aborted" || op.aborting) return await abortPath();
  if (hasToolCalls(assistant)) await runToolBatch(assistant);
  return undefined;
}

async function handleRunFailed(error: ErrorInfo): Promise<RunResult> {
  try {
    // Drain accepted input. No before_run_end, no further model work
    // unless consumed conversational input restarts the loop.
    while (true) {
      for (const w of [...op.pendingWrites]) await fx.applyPendingWrite(op.id, w.id);
      let consumed = 0;
      for (const m of steeringForThisCheckpoint(op)) {
        if (await fx.consumeQueueItem(op.id, "steer", m.id) === "consumed") consumed++;
      }
      if (consumed === 0) {
        for (const m of followUpsForThisCheckpoint(op)) {
          if (await fx.consumeQueueItem(op.id, "followUp", m.id) === "consumed") consumed++;
        }
      }
      if (op.aborting) return await abortPath();
      if (consumed > 0) return await driverLoop();           // input clears the failure
      const done = await fx.tryFinishRun(op.id, "failed", error);
      if (done === "finished") return finished("failed", error);
    }
  } catch (e) {
    return await handleRunSignal(e);
  }
}
```

`needsAssistant()`: the newest own message is a user, steering, follow-up, or tool-result message — except a completed tool batch in which every result persisted `terminate: true`, which does not by itself force another step (section 4). `hasPendingWork()`: pending writes, pending queue items, or `needsAssistant()`.

### Tasks

A failed attempt appends nothing; only a deferred handle, a terminal message, or the final give-up error enters the tree (section 6, retry trace).

```ts
async function stepTask(): Promise<AssistantMessage> {
  while (true) {
    if (op.aborting) throw new Aborted();
    const attempt = (op.task?.kind === "step" ? op.task.attempts : 0) + 1;
    if (attempt > retry.maxAttempts) {
      await fx.appendEntry(giveUpAssistantEntry(newId(), state));   // transcript records the give-up
      throw new RunFailed(retriesExhausted());
    }

    const options = await fx.runHook("before_request",
      { model: laneModel(state), task: "step", attempt, streamOptions });
    await fx.appendRecord(taskAttempt(op.id, "step", attempt));

    const final = await fx.streamAssistant(assistantRequest(state, options));

    if (final.stopReason === "deferred") {
      await fx.appendEntry(assistantEntry(newId(), final));
      emit({ type: "run_suspend", runId: op.id, deferred: final.deferred });
      throw new Park(final.deferred);
    }
    if (final.stopReason === "error" && isRetryable(final)) {
      await fx.sleep(retryDelay(attempt));                   // retry events around this
      continue;                                              // durable count already advanced
    }

    await fx.appendEntry(assistantEntry(newId(), final));
    if (final.stopReason === "error") throw new RunFailed(messageError(final));
    return final;                                            // stop, toolUse, length, aborted
  }
}
```

`summaryTask(task, reason?)` has the same shape: `task_attempt` before each attempt (`compactionReason` for compaction tasks), `before_request`, one non-deferred request, durable cap. It returns the summary value; the caller appends the result entry. A hook-supplied summary makes no attempt.

### Deferred redemption

```ts
async function redeemDeferred(): Promise<AssistantMessage> {
  const final = await fx.fetchDeferred(deferredModel(state), op.deferred!);
  if (op.aborting) throw new Aborted();
  if (final.stopReason === "deferred") throw new Park(op.deferred!);   // pending; no write
  if (final.stopReason === "aborted")  throw new Aborted();

  await fx.appendEntry(assistantEntry(newId(), final));      // ready or terminal
  if (final.stopReason === "error") throw new RunFailed(messageError(final));
  return final;
}
```

One fetch per `resume()`. Pending re-parks without a write. A terminal answer — returned or converted from a rejected fetch — lands as the error entry and fails the run through the normal drain path, which still honors input accepted before the failure (section 6).

### Tools

The live path is section 14 `executeToolBatch`; the durability callbacks route through `fx`, so the gate and the traces see every write in order:

```ts
async function runToolBatch(assistant: AssistantMessage): Promise<void> {
  const resultIds = new Map<string, string>();               // toolCallId → provisioned id

  await executeToolBatch(assistant, gatedActiveTools(), {
    beforeToolCall: async (call, args) => {
      return await fx.runHook("before_tool",
        { toolCallId: call.id, toolName: call.name, args });  // may patch args or block
    },
    onToolStart: async (call, effectiveArgs) => {
      const resultEntryId = newId();
      resultIds.set(call.id, resultEntryId);
      await fx.appendRecord(toolStarted(op.id, {
        assistantEntryId: newestAssistantEntryId(state),
        toolIndex: indexOf(assistant, call),
        toolCallId: call.id, toolName: call.name,
        effectiveArgs, resultEntryId,
        replay: declaredReplay(call),
      }));
    },
    afterToolCall: (call, result, isError) =>
      fx.runHook("after_tool", { toolCallId: call.id, toolName: call.name, ...result, isError }),
    onToolResult: async (message, terminate) => {
      // Blocked/invalid calls have no tool_started and no provisioned id;
      // their error result entry gets a fresh id (section 5).
      await appendIfMissing(resultEntry(
        resultIds.get(message.toolCallId) ?? newId(), message, terminate));
    },
  }, { toolExecution: config.toolExecution }, emitLaneEvents, abortSignal);
}
```

The recovery path handles each call at its crash site, in source order, keeping original ordinals:

```ts
async function reconcileToolBatch(batch: ToolBatchState): Promise<void> {
  if (batch.truncated) {                                     // stopReason "length": never execute
    for (const call of batch.calls) {
      if (!call.resultExists) await appendIfMissing(truncatedToolResult(newId(), call.toolCall));
    }
    return;
  }

  for (const call of batch.calls) {
    if (call.resultExists) continue;

    if (call.started) {                                      // X3: effect outcome unknown
      if (call.started.replay === "safe" && currentDeclaration(call) === "safe") {
        const prepared = { kind: "prepared", toolCall: call.toolCall,
                           tool: toolByName(call.started.toolName),
                           args: call.started.effectiveArgs };   // persisted, not re-derived
        const executed  = await fx.executeTool(prepared);
        const finalized = await finalizeToolCall(prepared, executed, { afterToolCall }, abortSignal);
        await appendIfMissing(resultEntry(call.started.resultEntryId,
          createToolResultMessage(finalized), finalized.result.terminate === true));
      } else {
        await appendIfMissing(syntheticResult(call.started.resultEntryId, "interrupted"));
      }
    } else {                                                 // X1/X2: full path, original ordinal
      await runToolBatchForSingleCall(call);
    }
  }
}
```

### Abort

`abort()` itself is a lane-surface job (mutation line, above): marker, queue drain, signal, resolve. Reconciliation is procedure work. If the operation was suspended with no procedure running, `abort()` starts one at the abort path; manual mode leaves it parked at its first action.

```ts
async function abortPath(): Promise<RunResult> {
  if (op.deferred) await fx.cancelDeferred(deferredModel(state), op.deferred);  // best effort:
                                                             // rejection → telemetry, then proceed
  while (true) {
    for (const call of op.toolBatch?.calls ?? []) {
      if (call.resultExists) continue;
      await appendIfMissing(syntheticResult(idFor(call), call.started ? "interrupted" : "aborted"));
    }
    for (const w of [...op.pendingWrites]) await fx.applyPendingWrite(op.id, w.id);  // facts survive abort
    if (!newestOwnMessageIsAborted(state)) await appendIfMissing(abortClosureEntry(newId(), state));

    const done = await fx.finishOperation(op.id, "aborted");
    if (done === "finished") return finished("aborted");
    // "continue": a deferred write landed meanwhile — apply it before closing
  }
}
```

### Structural operations

```ts
async function compactionProcedure(): Promise<CompactionResult> {
  try {
    if (op.aborting) return await abortStructural();
    if (!op.targets.result) {
      let result: CompactResult | undefined;
      if (!op.task) {          // no attempt yet: the decision hook may still run
        const hook = await fx.runHook("before_compaction",
          { reason: "manual", preparation, customInstructions: op.intent.customInstructions });
        if (hook?.decline) return await finishStructural("declined");
        result = hook?.compaction;
      }
      result ??= await summaryTask("compaction", "manual");  // durable attempts and cap
      await appendIfMissing(compactionEntry(op.intent.resultEntryId, result));
    }
    return await finishStructural("completed");
  } catch (e) { return await handleStructuralSignal(e); }
}

/** Inside a run, at a checkpoint. Same hook, same durable attempts and cap
    as manual compaction; no nested operation records. Exhausted retries
    throw RunFailed — the enclosing run drains and finishes failed, without
    before_run_end (section 11). */
async function autoCompact(reason: "threshold" | "overflow"): Promise<void> {
  if (!op.task) {
    const hook = await fx.runHook("before_compaction", { reason, preparation });
    if (hook?.decline) return;
    if (hook?.compaction) {
      await appendIfMissing(compactionEntry(newId(), hook.compaction));
      return;
    }
  }
  const result = await summaryTask("compaction", reason);
  await appendIfMissing(compactionEntry(newId(), result));
}

async function navigationProcedure(): Promise<NavigationResult> {
  try {
    if (op.aborting) return await abortStructural();
    const moved = state.leafId === op.intent.targetId;       // acceptance rejected target == source
    let summary: SummaryValue | undefined;

    if (op.intent.summarize && !op.targets.summary) {
      if (!moved && !op.task) {                              // decision hook: once, pre-move
        const hook = await fx.runHook("before_navigation",
          { targetId: op.intent.targetId, preparation });    // preparation derives from
                                                             // intent.sourceLeafId — valid pre- and post-move
        if (hook?.decline) return await finishStructural("declined");
        summary = hook?.summary;
      }
      summary ??= await summaryTask("branch_summary");       // regenerates after a post-move crash
    }

    if (!moved) await fx.moveLane(op.intent.targetId);       // the commit point (section 6)
    if (op.intent.summarize && !op.targets.summary) {
      await appendIfMissing(summaryEntry(op.intent.summaryEntryId!, summary!));  // chains to the target
    }
    if (op.intent.label !== undefined) {
      await fx.setFact(labelFact(op.intent.targetId, op.intent.label));          // idempotent
    }
    return await finishStructural("completed");
  } catch (e) { return await handleStructuralSignal(e); }
}

async function finishStructural(outcome: "completed" | "declined") {
  const done = await fx.finishOperation(op.id, outcome);
  if (done === "continue") return await abortStructural();   // abort won the ordering
  return structuralOutcome(outcome);
}

async function abortStructural() {
  // Nothing to reconcile: structural operations own no tool batch, and
  // lane-view writes wait for them (section 12).
  await fx.finishOperation(op.id, "aborted");
  return structuralOutcome("aborted");
}

async function handleStructuralSignal(e: unknown) {
  if (e instanceof Aborted)   return await abortStructural();
  if (e instanceof RunFailed) {
    const done = await fx.finishOperation(op.id, "failed", e.error);
    return done === "continue" ? await abortStructural() : structuralOutcome("failed", e.error);
  }
  throw e;
}
```

Hook-to-block wiring, in one table:

| harness hook | insertion point |
|---|---|
| `transform_context` | inside `fx.streamAssistant` (`StreamAssistantConfig.transformContext`) |
| `before_request` | before `fx.streamAssistant`, patches stream options |
| `before_payload` | inside the stream function, provider level |
| `after_response` | on the stream result, before the entry is appended |
| `before_tool` | `ToolCallbacks.beforeToolCall` (phase 1) |
| `after_tool` | `ToolCallbacks.afterToolCall` (phase 3) |
| `before_run_end` | `driverLoop` finish boundary; result committed via `fx.commitRunEndFollowUp` |
| — (record/entry writes) | `ToolCallbacks.onToolStart` / `onToolResult` via `fx` |

Notes:

- Auto-compaction inside a run runs under the run's own records; no nested operation.
- There is no "crashed mid-task" case in the code: an interrupted attempt is an attempt without a result entry, and the cap check decides retry versus `RunFailed`.
- Parallel batches and crash sites compose: `tool_started` records are written in source order during the sequential phase-1 pass, so a crash mid-batch leaves a source-order prefix of records — some with results, some without (section 6 table applies per call).
- An aborted assistant message (`stopReason: "aborted"`) skips tool execution; `abortPath()` owns the synthetic results.
- A crash between the navigation move and its summary entry loses the in-memory summary text; recovery regenerates it under the same attempt cap. A hook-supplied summary lost in that window is regenerated rather than re-asked: the hook's decline authority ended at the move.
- One policy knob deferred to implementation: whether `resume()` waits inside `fetchDeferred` when the provider is not ready (`wait` option) or re-parks immediately.

## 16. pi-ai: deferred requests

The provider-level interface the harness builds on. Everything is per-request; batch APIs can implement the same shape through a custom provider.

```ts
// Request. Providers map this to their native mechanism, e.g.
// background: true on a Responses API, or a batch submission.
interface SimpleStreamOptions {
  deferred?: boolean | { window?: "15m" | "1h" | "24h" };
  // ... existing options
}

// Response. A deferred request resolves quickly with a handle instead of
// content. The message is persisted like any assistant message; the handle
// is the durable fact recovery needs.
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

interface DeferredHandle {
  provider: string;
  api: string;
  id: string;                    // provider token: response id, batch id + row
  expiresAt?: number;            // Unix ms
  pollAfterMs?: number;          // provider hint
}

interface AssistantMessage {
  // ... existing fields
  stopReason: StopReason;
  deferred?: DeferredHandle;     // present iff stopReason === "deferred"
}

// Redemption lives on the provider. The two methods are optional: their
// presence is the capability signal. A provider without them never returns
// stopReason "deferred" and ignores the deferred request option.
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;

  /** Redeem a handle. Same return type as streamSimple; downstream code is
      identical. Polls or re-attaches until terminal, then emits the normal
      events and final message. Resolution states, all in-band:
      - ready:          normal message (stop | toolUse | length)
      - still pending:  stopReason "deferred" with the same handle (after
                        `wait` expires; wait: 0 checks once)
      - terminal:       stopReason "error" (expired, unknown, consumed)     */
  fetchDeferred?(model: Model<Api>, handle: DeferredHandle,
                 options?: { wait?: number; signal?: AbortSignal }): AssistantMessageEventStream;

  /** Best effort; providers without cancellation omit it. */
  cancelDeferred?(model: Model<Api>, handle: DeferredHandle): Promise<void>;
}
```

`Models.fetchDeferred(model, handle, options?)` and `Models.cancelDeferred(model, handle, options?)` delegate to these provider methods with normal model resolution and authentication (credential store, expiring tokens, header merge); the harness never talks to a provider object directly. A provider that returns `stopReason: "deferred"` must implement fetch; cancellation is best effort.

A terminal fetch answer is final for the run: the harness appends the error message and fails the operation (section 6). It never starts an automatic replacement request. The executor converts a rejected fetch promise into the same `stopReason: "error"` message form, so expected provider and authentication failures stay in-band. On a returned pending message the harness requires the complete handle to equal the persisted handle: a provider cannot replace durable handle data without a write, so a mismatch is a defect.

Deferred assistant messages carry a handle, not content: they project to nothing in provider context, and the default `toProviderMessages` drops them.

## 17. Forks and subagents

One copy primitive on the session repository:

```ts
type ForkOptions =
  | { scope?: "branch"; entryId?: string; position?: "before" | "at" }  // one path, root to fork point
  | { scope: "tree" };                                                  // all entries, every branch

repo.fork(source, options & { id?, parentSessionId? }): Promise<Session>;
repo.create({ id?, parentSessionId? }): Promise<Session>;
```

- Entries only. No records, no queues: a fork starts idle, every lane question answers "no open operation".
- Lanes: `scope: "branch"` → the fork has only `main`, at the fork point. `scope: "tree"` → every lane name and leaf pointer is copied. No operation logs or queues are copied either way, so every forked lane is idle.
- Facts: `scope: "tree"` copies all; `scope: "branch"` copies the name always, labels only when their target entry was copied.
- The fork point may be any message entry. A copy whose tip sits mid-tool-batch is still promptable: pi-ai's transformMessages inserts synthetic empty results for orphaned tool calls at request build time.
- The source is untouched; copying while it runs reads the committed prefix.
- Linkage is `parentSessionId`, set by `fork()` and settable on `create()` — the basis for subagent parent/child tracking and export bundles.
- A subagent tool derives its child session id deterministically from its invocation (`f(parentSessionId, toolCallId)`): a safe replay reattaches to the same child instead of spawning a twin, and the child stays discoverable from the parent even when a crash swallowed the tool result.
- Policy, restated from Part I: a platform thread that shares history with its channel is a lane; a fork is for isolation — subagents, exports, clones. A subagent can also run on a lane of its parent's session when isolation is not wanted.

## 18. Telemetry

In-process diagnostics, separate from events (public observation) and hooks (control). Vendor-neutral: pi emits structured span events; subscribers convert to OTel, logs, or metrics. Core packages never import OTel or Node-only APIs. Mechanism and adapters: `packages/agent/docs/observability.md`; its event names are superseded by this document's vocabulary.

Context propagation is explicit: the telemetry context flows as an ordinary argument — harness to procedure, procedure to `Effects` implementation, effect to the work it performs. No `AsyncLocalStorage`, no global current-span state. A context object is process-local capability data and is never persisted in a record, entry, snapshot, event, or deferred handle.

Span tree, aligned to the execution model; every span carries `lane` plus the ids public events carry (`runId`, `stepId`, `toolCallId`), so traces, events, and records correlate without translation:

```text
pi.harness.run           runId, lane, recovery
├─ pi.harness.step        stepId
│  ├─ pi.harness.task      task, attempt
│  │  └─ pi.ai.request      physical provider request(s)
│  └─ pi.harness.tool      toolName, toolCallId, replay
├─ pi.harness.checkpoint
└─ pi.harness.hook         hook type

pi.harness.compaction    manual operation; auto nests under its run
pi.harness.navigation
pi.harness.resume
pi.session.append        entry/record type, seq
```

Safety: default payloads carry identifiers, counts, durations, stop reasons, status codes — never prompts, completions, tool arguments, tool output, or headers. Content capture is opt-in via redaction hooks at subscriber configuration. Subscribers are passive: their errors are swallowed; exporting, sampling, and scrubbing are their job.

## 19. Open questions

1. **Per-lane hooks and events.** Registration is harness-global; every payload carries `lane`, handlers scope themselves. Enough, or do we want `lane.hooks.on(...)` with scoped delivery — for example a `before_tool` policy for one Slack thread? Global-with-lane is more general but pushes filtering onto every scoped consumer.
2. **Records and replication.** Lane operation logs are flat sequences without parent links, because a single writer per lane makes order equal causality (section 2). Replicating or merging diverged copies of a session would need explicit causality — parent links or equivalent. Out of scope (section 1); recorded here so the flat encoding is a known, deliberate bet.

## 20. Testing strategy

Three tiers. Each tests a different claim; none replaces another.

### Tier A — reduction and resume

Prefill a session with the records and entries of one section 6 crash state through the public `Session` API (`appendRecord`, low-level `appendEntry`), open the harness, call `resume()`, assert the durable result.

```ts
await session.appendRecord(opStarted("run", { originalPrompt, initialMessages: [userEntry] }));
await session.appendEntry(userEntry, "main");
await session.appendRecord(taskAttempt("step", 1));
await session.appendEntry(assistantWithToolCall, "main");
await session.appendRecord(toolStarted({ replay: "safe", resultEntryId: "result-1" }));
// This durable prefix is X3.

const { harness, suspended } = await AgentHarness.create(options);
expect(suspended).toHaveLength(1);
expect((await harness.resume()).ok).toBe(true);
```

Coverage: every X1–X5 tool state, replay safe/never/changed declarations, every source-order position in a batch, truncated (`length`) batches proving no execution, abort before and after each durable point, the terminal-failure marker with and without later consumed input, missing initial messages, pending, cancelled, and abort-killed queue items, deferred writes, deferred handles (pending, ready, terminal, rejected fetch, abort), unfinished tasks and attempt caps across restart including auto-compaction exhaustion, post-move navigation states from the section 6 table, section 5 validity rejections, and half-completed recovery (run the same prefix through recovery twice).

The in-memory backend is the reference. The parity suite runs the same setups against memory, JSONL, and SQLite; one case runs concurrent writes on two lanes and asserts unique increasing `seq` and identical `getLog()` order; another asserts every backend rejects the same non-JSON payloads.

### Tier B — writer conformance

Tier A assumes live execution writes the correct prefix; Tier B verifies it. Run the public harness against an instrumented `Session` recording every entry (`E`), record (`R`), fact (`G`), and hook (`H`). Assert exact order against the section 6 traces: one-tool run, retry, terminal failure, steering during a tool, finish-boundary orders, deferred write mid-step, abort during a tool, auto-compaction, manual compaction, navigation (move-first), deferred suspension and every fetch outcome. This tier catches the critical regression class: an effect starting before its intent record.

### Tier C — deterministic interleavings

`drive: "manual"` against the real `AgentHarness`, the faux provider, and a real backend. The gate is the only test hook; there is no second machine.

```ts
const { harness } = await AgentHarness.create({ session, models, model, tools: [calc], drive: "manual" });
const promptResult = harness.prompt("calculate");

while ((await harness.peekAction())?.kind !== "execute_tool") await harness.executeAction();

// X3: intent durable, effect not started
const started = await session.findRecords({ lane: "main", type: "tool_started" });
expect(await session.getEntry(started[0]!.resultEntryId)).toBeUndefined();

expect((await harness.steer("focus on tests")).ok).toBe(true);   // surface is ungated
await harness.runToCompletion();
expect((await promptResult).ok).toBe(true);
```

Crash simulation is `close()` at a chosen boundary, then reopening the same backend and resuming. Coverage: **both orders of every race-catalog row (section 15)**, input injected between arbitrary actions, abort while a cancellable effect is parked and while it runs, process loss at every action of the section 6 traces, and automatic versus manual drive producing identical durable logs and outcomes for the same scripted provider.

Gate invariants, asserted across Tier C:

- `peekAction()` has no side effect and is stable until `executeAction()`.
- `executeAction()` releases exactly the peeked action, never a later one.
- Stopping before an action leaves exactly the preceding durable prefix.
- While parked, zero storage writes and zero provider or tool calls happen (construction rule, section 15).
- Every accepted operation gets exactly one `operation_finished` unless it suspends.
- A faulted append leaves a valid prefix and faults the whole harness.

### Other suites

- The existing `agent-loop` and `agent` suites pass unchanged — the section 14 compatibility criterion.
- Event ordering per section 10, including `message_end` after commit.
- Hooks: registration-id `resumeData` round trips, duplicate-id rejection, aggregation order, fail-closed `before_tool`.
- v3 fixtures: labels, session info, and `leaf` entries mid-chain and at end of file, old `firstKeptEntryId` compactions — all open as one normalized idle `main` lane.

## 21. Implementation sequence

Keep each stage passing before starting the next.

1. v4 `Session` and in-memory storage: entries, records, lanes, facts, shared `seq`. Backend-neutral parity suite.
2. JSONL v4 with the v3 read path; greenfield SQLite with the branch cache. Parity suite against all three.
3. Section 7 reduction and validity checks. Tier A before any live procedure exists.
4. Split `agent-loop.ts` into the section 14 blocks; existing `agent-loop`/`agent` tests pass unchanged.
5. `Effects`, the lane mutation line, the conditional commits, and the gate. Automatic/manual equivalence for a no-tool run.
6. The run procedure: acceptance with capture, checkpoints, tasks and retries, queues, deferred writes, terminal failure, conditional finish, abort. Tier B traces as they land.
7. Tool batches through the section 14 callbacks, `terminate` persistence, replay and reconciliation. The full tool crash matrix in Tier A and C.
8. Deferred provider requests through `Models`; faux-provider support for pending, ready, terminal, and cancellation outcomes.
9. Manual and auto compaction; navigation with the move-first commit.
10. Events, hooks, snapshots, telemetry context. Tier C race-catalog completion.
11. Adapt coding-agent to the new result and session APIs; run its non-e2e suites on the faux provider.
12. `npm run check` clean.

## 22. Required reading

For a fresh implementation session, in this order. This document wins over anything older; `harness.md` (v1 of this design) is superseded and must not be followed where they disagree. `harness-v2-generator.md` is the competing variant of Part III — read it only to compare, never to implement from both.

1. `packages/agent/docs/harness-v2-effects.md` — this document.
2. `packages/agent/src/agent-loop.ts` — the loop to split into the section 14 building blocks.
3. `packages/agent/src/agent.ts` — queues, continuation, abort, settlement to preserve in spirit.
4. `packages/agent/src/harness/agent-harness.ts` — the harness being replaced.
5. `packages/agent/src/harness/types.ts` — current entry union and storage contract.
6. `packages/agent/src/harness/session/session.ts` — context build, projectors, entry creation.
7. `packages/agent/src/harness/session/jsonl-repo.ts` — v3 format and reload.
8. `packages/agent/src/harness/session/memory-repo.ts` — in-memory parity.
9. `packages/agent/src/harness/messages.ts` — message conversion (toProviderMessages default).
10. `packages/agent/src/harness/compaction/compaction.ts` — preparation, split-turn summaries.
11. `packages/ai/src/utils/transform-messages.ts` — orphaned-tool-call healing.
12. `packages/coding-agent/src/core/agent-session.ts` — old behavior to preserve in spirit.
13. `packages/coding-agent/src/core/extensions/runner.ts` — old extension error isolation.
14. `packages/storage/sqlite-node/src/sqlite/storage/index.ts` — current engine: transactions, sequences, branch materialization.
15. `packages/storage/sqlite-node/src/sqlite/storage/branch-entries.ts` — the branch cache being generalized.
16. `packages/storage/sqlite-node/src/sqlite/repo.ts` — create/open/fork.
17. `packages/coding-agent/docs/session-format.md` — v3 JSONL, the compatibility target.
18. `packages/agent/docs/observability.md` — telemetry background; section 18 defines context propagation.
