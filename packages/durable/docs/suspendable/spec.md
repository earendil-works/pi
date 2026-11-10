# Suspendable work in pi-durable

Status: draft, fifth revision, 2026-11-09. Nothing here is built. It extends
`packages/durable/docs/spec.md` (cited as "spec §n") and records the
decisions the owner made in review on 2026-11-09. The third and fourth
revisions were reviewed adversarially by gpt-6-astra, gpt-6.1-sol, and
claude-opus-5-5 against spec.md and the code; this revision folds in their
confirmed findings (section 14). The explainer `book.md` (built as `index.html`) follows this
file. How plugins compose hooks, order them, and build approvals, quotas, and
similar policies on these primitives is the host's design (p2, p3), not
Durable's (section 9).

## 1. Problem

Durable work waits without holding an invocation for two things today: other
tasks (`waiting`, spec §5.5) and time (`sleeping`, spec §5.6). It cannot wait
for the outside world. A tool that starts a CI build and needs its webhook, a
tool whose answer comes from a person, an approval before a tool runs, and a
subagent that itself waits for a person all await a promise in memory. That
holds a running invocation: `wake()` reports the Session active, a Durable
Object cannot hibernate, p2's worker stays alive, and a crash loses the wait (a
replay-safe tool starts its external work again, any other tool returns
`interrupted`).

This draft adds signals (a typed JSON value delivered to a live task from
outside), lets a sleep wait for signals as well as time, lets a wait wake on
the first task instead of all, lets a tool park and run again, and lets
`beforeTool` hooks make a call wait before it runs. There is no new task status.

Goals:

1. Parked work holds no invocation and is not active in `wake()`; only its
   deadline counts, as `at`.
2. A signal that arrives before the task parks is kept, and the park wakes at
   once.
3. An abort ends the wait of parked work at once (section 2.6).
4. Replay rules apply only to code that was running; a restart while parked
   runs no tool or task code. The one exception is a call parked at a gate
   (section 5.2): after open its gates are asked again, since the registry
   may have changed.
5. Existing tasks, tools, and hooks keep working unchanged at runtime.

## 2. Tasks

### 2.1 States

```ts
type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S; readonly wake?: WakeReason }
  | { readonly status: "running"; readonly checkpoint: S; readonly wake?: WakeReason }
  | {
      readonly status: "waiting";
      readonly checkpoint: S;
      readonly on: readonly TaskId[];
      /** New member "any": resumes once a task in `on` is terminal. */
      readonly policy: JoinPolicy;
    }
  | {
      readonly status: "sleeping";
      readonly checkpoint: S;
      /** Optional now. */
      readonly until?: number;
      /** New: resumes once one of these keys holds a value. */
      readonly signals?: readonly SignalKey<unknown>[];
    }
  | { readonly status: "completing"; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };

type JoinPolicy = "failFast" | "allSettled" | "any";

/** What a task commits: as today, but it never writes its own wake. */
type NextTaskState<S, R> =
  | { readonly status: "running"; readonly checkpoint: S; readonly wake?: never }
  | Extract<TaskState<S, R>, { status: "waiting" | "sleeping" | "terminal" }>;
```

A sleep needs `until` or a non-empty `signals`, or both; anything else rejects,
as an invalid `until` does today. With both, it ends at whichever comes first.

`policy: "any"` resumes the waiting task once at least one task in `on` is
terminal, possibly several. It follows `allSettled`'s rules: tasks the waiting
task does not own are allowed, nothing is abort-marked for it, an empty `on`
resumes at the next scheduling pass, and the wait-for cycle check of spec §5.5
applies unchanged (conservative for `"any"`).

Every list of parked states in spec §5 already names `waiting` and `sleeping`.
`TaskInspection`'s `sleeping` kind gets optional `until`, and the task graph's
`sleeping` node shows `until?` and `signals`. Code that reads `until` of a
sleeping task must handle its absence.

### 2.2 Why it woke

```ts
/** Why parked work runs again. Read by tasks as task.state.wake and by tools as api.wake. */
type WakeReason =
  | { readonly reason: "time" } // until reached, no signals listed
  | { readonly reason: "expired" } // until reached before any listed signal
  | { readonly reason: "signal"; readonly signal: string; readonly key: string } // the key whose value woke it
  | { readonly reason: "tasks"; readonly ended: readonly TaskId[] }; // terminal tasks of `on` at reservation
```

`WakeReason` is new; the existing `Wake` (`{ active, at? }`, the type of
`Harness.wake()` and `onWake`) is unchanged.

The reservation commit that changes a parked task to `running` writes `wake`.
Reconciliation at open, close, and handover write the task back as `pending`
with its checkpoint and its `wake`; the next reservation keeps it. The wake
stays until the task commits a different checkpoint, parks, or ends: a commit
of the same checkpoint (the intent pattern of spec §5.1) keeps it. A phase that
reruns after a crash or a close therefore reads the same wake. Progress for the
restart count (spec §5.4) compares whole states with `wake` left out: a sleep
or a wait is progress even at the same checkpoint, as today, and a wake
appearing or disappearing is not.

`wake` is plain JSON and small: for a signal it names the key, and the woken
code reads the value with `readSignal(token, wake.key)` (section 3.3), the one
way to read a signal.

### 2.3 Example

Examples build schemas with `@earendil-works/pi-schema` (`obj`, `str`, `bool`,
`oneOf`), as Durable's tools do.

```ts
import { obj, str } from "@earendil-works/pi-schema";

const HOUR = 60 * 60 * 1000;
const Answer = defineSignal({ name: "app.answer", version: 1, schema: obj({ text: str() }) });

const AskPerson = defineTask<{ question: string }, { phase: "ask" } | { phase: "answered" }, { text?: string }>({
  name: "app.ask-person",
  version: 1,
  initial: () => ({ phase: "ask" }),
  phases: {
    ask: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "sleeping",
          signals: [Answer.key("answer")],
          until: runtime.now() + 4 * HOUR,
          checkpoint: { phase: "answered" },
        }),
        context,
      ),
    answered: async (_task, runtime, context) => {
      const state = await runtime.readSignal(Answer, "answer", context); // { value } when answered, { expired } after the deadline
      const text = state !== undefined && "value" in state ? state.value.text : undefined;
      return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { text } } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
```

Whatever shows the question to a person (an inbox, a card, a chat bridge)
keeps its own record of it and calls `harness.signal()` with the answer.
Durable stores no description of what a sleep waits for.

### 2.4 Reservation and wakeups

A sleeping task is eligible when:

- one of its `signals` holds a value that has not woken the task before: the
  wake is `signal`, for the first such key in the order of `signals`. The
  reservation marks that key consumed (section 3.4). The other listed keys stay
  open: a value delivered to them later is kept for a later sleep;
- otherwise `until` is set and the Harness clock reached it: the wake is
  `expired` when `signals` is set, `time` otherwise. The same commit marks every listed key that holds no value expired,
  so a later delivery to it returns `closed`;
- it carries an abort mark (section 2.6).

A waiting task with `"any"` is eligible once one task in `on` is terminal; its
wake is `tasks` with every terminal task of `on`. `allSettled` and `failFast`
waits get `tasks` with all of `on`.

`Harness.wake()` (spec §5.6): `active` adds an eligible sleeping task and a
waiting `"any"` task with a terminal member, when not blocked. `at` is the
earliest `until` of sleeping tasks not yet due; a sleep without `until` counts
for neither. Without `onWake`, the Harness arms its sleep timer for the
earliest `until`, as today.

Open keeps parked tasks parked (except calls parked at a gate, section 5.2),
close does not touch them, and parked tasks accrue no restarts.

### 2.5 Restarts and abandoned children

Today every live task created with `abandonOnRestart` is abort-marked at the
first scheduling pass after a restart (spec §5.4). A replay-unsafe tool's
nested calls and children get that flag because the tool never runs again
after a crash. A tool that parks does run again. The rule therefore looks at
the owner's checkpoint, and the owner rule wins over the child's own flag:

- a child whose owner is a tool task with checkpoint `call` or `parked` is not
  marked: the owner was not cut off while running. That holds whatever the
  owner's status (`sleeping`, `waiting`, or `pending` after a crash between its
  wake reservation and its intent commit) and whatever the child's own state;
- a child whose owner is a tool task with checkpoint `execute` is marked: the
  owner was cut off in a run;
- every other `abandonOnRestart` task is marked as today.

### 2.6 Abort

An abort mark ends a sleep or a wait at once: the task becomes eligible for its
abort invocation without waiting for its signals, its deadline, or the tasks
in `on`. As today, the abort invocation starts only once the task's ordinary
owned work is no longer live (spec §5.5), so cleanup runs bottom-up.

### 2.7 Storage

No new status and no schema change: storage has no `until` column; task
records are JSON and the only task index is by status. A sleeping record
without `until` is valid; the scheduler's in-memory deadline tracking skips it.
Conformance gains round trips of a sleeping record without `until`, one with
`signals`, a waiting record with `"any"`, and a `pending` and a `running`
record with `wake`. A database written by this version is not meant to be
opened by an older one (rollback is not a goal; an older Harness would treat a
sleep without `until` as due at once).

## 3. Signals

### 3.1 Tokens

```ts
function defineSignal<S extends object>(definition: {
  /** Unique like a task or document kind; must not contain "/". */
  readonly name: string;
  readonly version: number;
  /** A pi-schema schema of a JSON value; the value type is Static<S>. */
  readonly schema: S;
  /** A value stored by an older version, to the current shape. */
  readonly migrate?: (value: JsonValue, fromVersion: number) => Static<S>;
}): SignalToken<Static<S>>;

interface SignalToken<T> {
  readonly name: string;
  readonly version: number;
  /** The key of one wait; JSON, used in sleeps and parks. */
  key(key: string): SignalKey<T>;
}

/** JSON: the token's name and the wait's key. `T` is a phantom type. */
type SignalKey<T> = { readonly signal: string; readonly key: string; readonly "~value"?: T };
```

Keys are non-empty strings. Signal values are JSON: a schema that admits
non-JSON values (pi-schema's `bigint()`, `bytes()`) is rejected by
`defineSignal`, and a delivery that is not JSON returns `invalid`. Values are
read with `readSignal()` (section 3.3), which migrates a value stored by an
older version with `migrate` and checks it against the schema; a missing
`migrate`, a throwing one, an invalid result, or a stored version newer than
the token's throws. The throw lands where any throw from that code lands: a task phase
faults (spec §5.1, rule 4), `execute()` ends with a `tool_error` result, and a
`beforeTool` hook blocks the call with the error text (spec §7.2).

### 3.2 Delivering

```ts
type SignalResult = "delivered" | "duplicate" | "invalid" | "closed" | "not_found";

interface Harness {
  /** tx.signal() in a commit of its own. */
  signal<T>(taskId: TaskId, token: SignalToken<T>, key: string, value: T, context: Context): Promise<SignalResult>;
}
interface Tx {
  signal<T>(taskId: TaskId, token: SignalToken<T>, key: string, value: T): Promise<SignalResult>;
}
```

`tx.signal()` reads the task record and, in order:

1. `not_found` for no task; `closed` for a terminal, `completing`, or
   abort-marked task;
2. `invalid` when the value does not match the token's schema;
3. `duplicate` when the key holds a value (consumed or not), `closed` when it
   is expired;
4. `closed` when the task sleeps on this key and its `until` has passed; the
   key is marked expired in the same commit;
5. otherwise it stores the value with the token's version and returns
   `delivered`.

The task need not be sleeping on the key: a value delivered while it still
runs, or sleeps on other keys, is kept, and a later sleep on that key wakes at
once. `delivered` means durably accepted, not consumed: the task may end
without waiting on the key.

`tx.signal()` reads a table: like `submit(tx)` it comes before the commit's
first table write and throws `ReadAfterWrite` after it (spec §12). Its result
is provisional until the commit is stored.
`Harness.signal()` enables scheduling, like `submit()`, and joins the calls
before which a host arms its recovery wakeup (spec §5.6). Neither checks who
calls it: authenticating the sender is the host's job.

### 3.3 Storage and reading

A key's state lives in the task's memos under the reserved prefix
`pi.signal.`: `pi.signal.<signal name>/<key>` (signal names contain no `/`),
holding `{ version, value }`, `{ expired: true }`, and, once a wake used it,
`consumed: true`. Memos already have the needed lifetime (spec §5.2): kept
through checkpoints, reconciliation, handover, and migration, dropped with the
terminal or `completing` state. The `pi.` memo prefix is reserved for the
Harness; hooks already prefix their memo names (spec §7.2).

Within one transaction, every write to a task record (a signal, the expiry and
consumed marks, a state change) composes with the transaction's latest
candidate of that record, so no write erases another; a terminal or
`completing` replacement drops the memos as today.

Code reads a key without waiting:

```ts
type SignalState<T> = { readonly value: T } | { readonly expired: true };

interface TaskRuntime {
  /** The key's state, the value migrated to the token's version; undefined while nothing came. */
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
}
```

`HookApi` and `ToolExecutionApi` gain the same method. A value stays readable
until the task ends.

### 3.4 One wait per key

A key serves one wait. The reservation that wakes a task on a key marks it
consumed; a sleep on a consumed or expired key rejects (for a task the commit
throws; for a tool or a `beforeTool` hook the call ends with a `tool_error`
result, code `invalid_park`, section 4.2). Otherwise a phase that sleeps again
on the key that just woke it would wake at once, forever, and the restart limit
would not stop it. A key that holds a value delivered early, before any wake
used it, is not consumed: the sleep wakes at once. A second wait for the same
kind of signal uses a new key (`ci-1`, `ci-2`); webhook retries of the first are
answered `duplicate`.

### 3.5 Size

Values have no size limit, and neither do keys per task. Rule: nothing large
goes into anything that lands in the task record (a signal value, a
checkpoint, a wake), because the scheduler mirrors live records in memory and
rewrites them on every write. A large payload goes into a document the host
writes first, or stays where it came from; the signal carries a reference (a
document ID, a CI run ID to fetch the log by).

## 4. Tools

### 4.1 API

```ts
type ToolPark<C extends JsonValue = JsonValue> =
  | { readonly sleep: { readonly checkpoint?: C; readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] }; readonly wait?: never }
  | { readonly wait: { readonly checkpoint?: C; readonly on: readonly TaskId[]; readonly policy: JoinPolicy }; readonly sleep?: never };

type ToolRegistration<TParameters extends object = object, TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue> =
  Tool<TParameters> & {
    // ... as today, and:
    execute(
      args: ToolArgs<TParameters>,
      api: ToolExecutionApi<TDetails, C>,
      context: Context,
    ): Promise<ToolExecutionResult<TDetails> | ToolPark<C>>;
    /** Clean up the external work of a call that parked (section 4.2, "Cleanup"). A throw is reported. */
    cancel?(args: ToolArgs<TParameters>, api: ToolExecutionApi<TDetails, C>, context: Context): Promise<void>;
  };

interface ToolExecutionApi<TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue> {
  // ... as today, and:
  /** Why this run started; undefined on a fresh call. */
  readonly wake: WakeReason | undefined;
  /** What the call last parked with; undefined on a fresh call or a park without one. */
  readonly checkpoint: C | undefined;
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
}

function defineTool<TParameters extends object, TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue>(
  tool: ToolRegistration<TParameters, TDetails, C>,
): ToolRegistration<TParameters, TDetails, C>;
```

A tool parks by returning a `ToolPark` instead of a result: `sleep` for a time,
signals, or both; `wait` for tasks the call's task owns (section 4.4). The call
runs again by `execute()` being called again with the same arguments and
`api.wake` set. A fresh call has `api.wake === undefined`. An object with both
`sleep` and `wait`, or with either and also a result field (`output`, `structuredOutput`,
`isError`, `details`, `diagnostics`, `usage`, `control`) is invalid (code
`invalid_park`).

```ts
import { obj, oneOf, str } from "@earendil-works/pi-schema";

const HOUR = 60 * 60 * 1000;

const CiResult = defineSignal({
  name: "app.ci-result",
  version: 1,
  schema: obj({ status: oneOf(["passed", "failed"]), logUrl: str() }),
});

// The host's webhook registry ("when the webhook for `match` arrives, signal this key to this task"; durable,
// idempotent) and the CI service's client, as this example assumes them.
declare const webhooks: { expect<T>(match: string, taskId: TaskId, token: SignalToken<T>, key: string, context: Context): Promise<void> };
declare const ci: {
  trigger(input: { ref: string; correlationId: string; idempotencyKey: string }, context: Context): Promise<{ id: string }>;
  cancel(buildId: string, context: Context): Promise<void>;
  cancelByKey(idempotencyKey: string, context: Context): Promise<void>;
};

const CiParameters = obj({ ref: str() });

const runCi = defineTool<typeof CiParameters, JsonValue, { buildId: string }>({
  name: "run_ci",
  description: "Run CI on a git ref and report the result",
  parameters: CiParameters,
  replay: "safe",
  async execute({ ref }, api, context) {
    // Read from the live record in memory: the result, the deadline's expiry, or nothing yet (a fresh call).
    const state = await api.readSignal(CiResult, "done", context);
    if (state !== undefined && "value" in state) {
      const { status, logUrl } = state.value;
      return { output: [{ type: "text", text: `CI ${status}: ${logUrl}` }], isError: status !== "passed" };
    }
    if (state !== undefined) {
      return { output: [{ type: "text", text: `CI build ${api.checkpoint?.buildId} never reported` }], isError: true };
    }
    // A fresh call. The tool's own idempotency key with CI, stable across reruns (memos are first-writer-wins).
    const runId = await api.memo("ci.run", crypto.randomUUID(), context);
    // Register before triggering, so a fast webhook already finds this task.
    await webhooks.expect(runId, api.taskId, CiResult, "done", context);
    const build = await ci.trigger({ ref, correlationId: runId, idempotencyKey: runId }, context);
    return { sleep: { checkpoint: { buildId: build.id }, signals: [CiResult.key("done")], until: api.now() + 2 * HOUR } };
  },
  async cancel(_args, api, context) {
    if (api.checkpoint !== undefined) await ci.cancel(api.checkpoint.buildId, context);
    else await ci.cancelByKey((await api.memo<string>("ci.run", context))!, context);
  },
});
```

### 4.2 Tool task

`pi.tool` becomes version 4:

```ts
type ToolTaskCheckpoint =
  | { phase: "call" }
  /** Intent: `execute()` runs in this phase; reached again only by recovery. */
  | { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe"; wake?: WakeReason; checkpoint?: JsonValue }
  /** The call is parked; `sleeping` or `waiting` holds this checkpoint. */
  | { phase: "parked"; arguments: JsonObject; replay: "safe" | "unsafe"; checkpoint?: JsonValue };
```

**Parking.** When `execute()` returns a `ToolPark`, the handler closes the
call's nested-call admission and lets admitted commits land, as before a
caller settles (spec §7.3), but does not abort the call's live nested calls:
parking is not settling. It stops the progress throttle and awaits the commit
in flight. One commit then persists the latest buffered details and
diagnostics (settling pending `details()` promises, as the result commit does
today), sets the slot's status to `"sleeping"` or
`"waiting"` and clears its output (details and diagnostics stay in the slot), writes the
checkpoint `parked`, and commits the state `sleeping` or `waiting` from the
park. A park that breaks a rule (no `until` and no non-empty `signals`, a
consumed or expired key, `on` naming a task the call's task does not own, a
mixed object) becomes a `tool_error` result with code `invalid_park`, through
the `afterTool` chain, and the task ends `failed` like a throw from
`execute()`.

**Waking.** The reservation from `parked` changes the task to `running` with
checkpoint `parked` and its `wake`. The `parked` handler then:

1. resolves the tool as `call` does (spec §7.3). A tool that no longer resolves
   settles a `tool_unavailable` result, without `cancel` (its code is gone),
   and the task ends `failed`, so work the call owns, which nothing supervises
   any more, is aborted (spec §8.4); the failure is reported;
2. commits intent: `execute` with the arguments, the current replay policy,
   the wake, and the checkpoint, with the slot `running` by a deferred commit;
3. runs `execute()` with `api.wake` and `api.checkpoint` set, in the same
   handler, and handles its return as `call` does: a result settles the call,
   a park parks it again.

**Recovery** of `execute` is today's rule: when both the stored and the current
policy are `safe`, `execute()` runs again with the stored arguments, wake, and
checkpoint; otherwise the call settles `interrupted`. A close and a crash both
leave `execute`, so a replay-unsafe run is never repeated.

**Cleanup.** `cancel` cleans up a call whose external work may be live while
no code of the tool runs:

- the abort handler runs `cancel` when the checkpoint is `parked`, or `execute`
  with `wake` (a woken run that was cut off, aborted before `execute()` was
  entered, or abort-marked after a restart);
- recovery runs `cancel` before an `interrupted` result when the checkpoint is
  `execute` with `wake`;
- when a park's commit is rejected because the call was abort-marked meanwhile,
  the run invocation runs `cancel` before it ends, with `api.checkpoint` set to
  the park's checkpoint and a cleanup context that the abort does not cancel
  (only the Harness's close does). The park's checkpoint is not stored; a crash
  before this `cancel` finishes leaves the call in `execute`, and the abort
  handler runs `cancel` without it, so `cancel` falls back to the tool's own
  idempotency key, as for a first run.

`cancel` does not run for a call parked at `call` (section 5: no tool code
ran), for a first run cut off before it parked (the tool's own idempotency key
is the only way to find its work, section 11), past the restart limit, or when
the tool no longer resolves: an abort of such a parked call settles `aborted`
without `cancel` and reports it. While
`execute()` runs, an abort reaches the tool through its context and the tool
cleans up itself; the abort handler's `cancel` may then run as well, so `cancel`
is idempotent. In `cancel`, `api.wake` is undefined and `api.checkpoint` is the
last park's; `cancel` starts no nested calls or tasks. A `cancel` that hangs
holds Stop, as a slow `afterTool` does. A throw is reported and the call still
ends.

**Output and timing.** Each run starts with empty output; details and
diagnostics stay in the slot across runs, and a run adds to them, so a result
that omits `details` gets the newest value and the result's diagnostics are
the slot's. A safe rerun of a woken run clears only the slot's output, not its
details and diagnostics (today's safe rerun clears all three); diagnostics the
interrupted run recorded stay. A nested call with `progress: false` writes no
details or diagnostics to its slot, so none carry over between its runs.
`durationMs` of every result the tool task writes is the span from the task's
`startedAt` to the result commit on the Harness clock: gate waits, parks, crash
downtime, and reruns included (today it measures only the last `execute()`
attempt, and results that never executed have none); a record without
`startedAt` keeps today's measurement. The same applies to
`NestedToolExecutionResult.durationMs` and slot summaries.

**Hooks.** `beforeTool` runs before intent and never again once intent is
committed; `afterTool` runs on the final result. Neither sees a park of
`execute()`.

**Abort messages.** The abort handler's message for a restart-marked call names
the phase it was in, `parked` included ("was not started" is only right for
`call`).

### 4.3 Replay-unsafe tools

A replay-unsafe tool may park. A restart while it is parked interrupts nothing,
and its children are kept (section 2.5).

### 4.4 Nested calls and children

```ts
interface ToolExecutionApi {
  /** As today: start or find the nested call, wait, return its result. */
  executeTool(name: string, args: JsonObject, context: Context, options?: { key?: string; progress?: boolean; wait?: true }): Promise<NestedToolExecutionResult>;
  /** wait: false: start or find it, return a handle at once. */
  executeTool(name: string, args: JsonObject, context: Context, options: { key?: string; progress?: boolean; wait: false }): Promise<NestedToolCall>;
  /** As today; with a key, a later call with the same key returns the existing task instead of creating one. */
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
    input: I,
    options: Omit<TaskOptions, "conversationId"> & { readonly key?: string },
    context: Context,
  ): Promise<TaskId<R>>;
}

type NestedToolCall = {
  readonly taskId: TaskId;
  /** The stored result once the nested call is terminal; otherwise waits for it. */
  result(context: Context): Promise<NestedToolExecutionResult>;
};
```

`executeTool()` with `wait: false` uses the call's existing key map
(`NestedCallDoc`, spec §7.3) and its reuse rule: the first call with a key
creates the nested call and records it in the same commit; a later call with
the key, in the same run, a rerun, or a later wake, returns it; another tool
name or other arguments throw.

A keyed `createTask()` records its task under the key in the same map, as a
member of its own kind (`{ kind: "task"; taskId }` beside the nested calls'
`{ kind: "nested"; taskId }`; a stored member without `kind`, written before
this version, is a nested call), with the same key validation. A later call with
the key returns the task; another task kind or other input throws. A key used
by one kind throws for the other. An unkeyed `createTask()` creates a task, as
today.

Default nested-call keys are positions in a run (`1`, `2`, ...), as today.
After a wake the same position may mean a different call, so `executeTool()`
without an explicit key, and an unkeyed `createTask()`, throw when `api.wake`
is set.

```ts
import { obj, str } from "@earendil-works/pi-schema";

type ResearchCheckpoint = { done: TaskId[] };
const ResearchParameters = obj({ x: str(), y: str() });

const research = defineTool<typeof ResearchParameters, JsonValue, ResearchCheckpoint>({
  name: "research_both",
  description: "Research two topics in parallel",
  parameters: ResearchParameters,
  replay: "safe",
  async execute({ x, y }, api, context) {
    const a = await api.executeTool("research", { topic: x }, context, { key: "a", wait: false });
    const b = await api.executeTool("research", { topic: y }, context, { key: "b", wait: false });
    const done = new Set(api.checkpoint?.done ?? []);
    if (api.wake?.reason === "tasks") for (const id of api.wake.ended) done.add(id);
    const open = [a, b].filter((call) => !done.has(call.taskId));
    if (open.length > 0) return { wait: { checkpoint: { done: [...done] }, on: open.map((call) => call.taskId), policy: "any" } };
    const [ra, rb] = await Promise.all([a.result(context), b.result(context)]);
    return { output: [{ type: "text", text: `${String(ra.structuredOutput)}\n${String(rb.structuredOutput)}` }] };
  },
});
```

A tool awaiting `executeTool()` with `wait: true` still holds its invocation for
as long as the nested call takes, also while that nested call is parked; only a
tool that parks on its handles lets the Session go idle. Spec §5.4's "a nested
call runs only while its replay-safe caller runs" no longer holds for callers
that park on their handles. Code mode parking its VM this way is separate work
(section 12).

### 4.5 Waiting on a subagent

A submission can ask for a signal when it settles:

```ts
type SubmissionDraft = /* as today */ & {
  /** When the submission settles, deliver SubmissionSettled to `taskId` under `key`, in the settling commit. */
  readonly notify?: { readonly taskId: TaskId; readonly key: string };
};

/** Built in. Its value is what Submission.wait() resolves to. */
const SubmissionSettled: SignalToken<SettledSubmissionRecord>;
```

The delivery is assembly work of the settling commit, like the resolution of
`tx.settleSubmission()` (spec §8.2): it runs against the transaction's
candidate records after the commit's table writes, for every submission the
commit settles (through `settleSubmission()`, a placement that settles a write,
or a record created settled), any number per commit. It follows `tx.signal()`'s
rules against the candidate task record; a `closed` or `not_found` result does
not fail the settling commit. A submission that settles before the tool sleeps
is an early signal, and the sleep wakes at once.

```ts
import { obj, str } from "@earendil-works/pi-schema";

// The answer entry's text, read from the settled record's answer entry.
declare function answerText(api: ToolExecutionApi, settled: SettledSubmissionRecord, context: Context): Promise<string>;

export const Subagent = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a task to a subagent and get its answer back",
      parameters: obj({ task: str() }),
      replay: "safe",
      async execute({ task }, api, context) {
        const state = await api.readSignal(SubmissionSettled, "answered", context);
        if (state !== undefined && "value" in state) {
          const settled = state.value;
          if (settled.status !== "done") return { output: [{ type: "text", text: `Subagent ended: ${settled.status}` }], isError: true };
          return { output: [{ type: "text", text: await answerText(api, settled, context) }] };
        }
        // The parent's own selection without this extension (spec §7.3), computed before the commit.
        const extensions = (await api.agent(context)).extensions.filter((name) => name !== Subagent.name);
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { extensions });
          return created.id;
        }, context);
        const handle = (await api.conversation(child, context))!;
        // The request ID makes a rerun find the same submission.
        await handle.submit(
          { type: "input", content: task, requestId: `subagent:${api.taskId}`, notify: { taskId: api.taskId, key: "answered" } },
          context,
        );
        return { sleep: { signals: [SubmissionSettled.key("answered")] } };
      },
    }),
  ],
});
```

While the subagent works, the Session is active anyway; once it parks too
(asks a person, waits for CI), every task is parked and the Session is idle.

## 5. Gates before a tool runs

### 5.1 `beforeTool` may sleep

```ts
interface ToolHooks {
  beforeTool(
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ): HookResult<{
    readonly arguments?: JsonObject;
    readonly block?: string;
    /** New: park the call before it runs. */
    readonly sleep?: { readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] };
  }>;
}

interface HookApi {
  // ... as today, and:
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
  /** The Harness clock. */
  now(): number;
}
```

The chain is today's: argument replacements in extension order; the first
`block` or `sleep` stops it. A `sleep` commits the tool task `sleeping` with its
checkpoint still `{ phase: "call" }` and its slot `status: "sleeping"`. Every
wake before intent runs the whole `call` phase again from the top: resolve,
repair, validate, every `beforeTool` in extension order, validate again. A hook
that waited reads its key with `api.readSignal()` (a value, expired, or nothing
yet) and passes, blocks, or sleeps on a new key. The call executes only when a
whole pass ends without a block or sleep; once intent is committed,
`beforeTool` never runs again. The rules of sections 2.1 and 3.4 apply to the
sleep; a violation ends the call with `invalid_park`.

```ts
import { bool, obj } from "@earendil-works/pi-schema";

const Approval = defineSignal({ name: "approvals.decision", version: 1, schema: obj({ allow: bool() }) });
const DAY = 24 * 60 * 60 * 1000;

// The extension's own judgment of a command, and a hash of JSON with sorted keys.
declare function isRisky(args: JsonObject): boolean;
declare function canonicalDigest(value: JsonValue): string;

export const Approvals = defineExtension({
  name: "approvals",
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        if (call.name !== "bash" || !isRisky(call.arguments)) return undefined;
        const key = canonicalDigest(call.arguments); // other arguments, another question
        const state = await api.readSignal(Approval, key, context);
        // One deadline per question, fixed at the first pass: later passes (wakes, registry changes) keep it.
        const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, context);
        if (state === undefined) return { sleep: { signals: [Approval.key(key)], until } };
        if ("expired" in state) return { block: "No approval within a day" };
        return state.value.allow ? undefined : { block: "Not approved" };
      },
    }),
  ],
});
```

Whatever shows the question keeps its own record and calls `harness.signal()`
with the task ID from the call's slot. An approval binds to the arguments it
saw: a later `beforeTool` that replaces them can make a call run with
arguments nobody approved. Ordering argument changes before approvals is the
host's composition (section 9), not a Durable guarantee.

### 5.2 Registry changes

The call phase reruns, so gates installed now decide, when:

- a registry publication occurs while a tool task is parked at `call`: it is
  woken;
- a `beforeTool` sleep commits while the registry changed since the phase's
  snapshot: the sleep is stored, and the scheduler wakes it at once, as a
  publication would (a handler cannot take a fresh snapshot itself);
- the first scheduling pass after open finds a tool task parked at `call`: it
  is woken, since the registry may differ from the one it parked under.

Such a wake carries no `wake`. When the sleep's `until` has already passed, it
takes the deadline path instead: the wake is `expired` and the listed keys without
a value are marked expired, so a late delivery returns `closed`. A gate that
sleeps with a deadline fixes it once, for example in a memo, so that later
passes do not move it.

Calls parked in `execute()` (section 4.2) are not affected.

### 5.3 Hooks and durable writes

Hooks get no `commit`: a hook answers a question; the asking task commits the
decision. A hook that writes elsewhere (a plugin's own store, even in the same
database) performs an external effect: it is not atomic with the task's
commit, it reruns with the phase (on every wake before intent, and after a
crash), so it is idempotent by a key derived from the task, and anything it
reserves is released from the call's outcome. `afterTool` runs on every result
the tool task writes, blocked, aborted, and unavailable included (spec §8.4),
except past the restart limit and for tool tasks the scheduler faulted or
orphaned; there the plugin reconciles against the task graph.

## 6. Hooks that start tasks

Only `beforeTool` parks its task, and only because the `call` phase it sits
in is before intent and reruns whole on every wake (section 5). The
generation's hooks sit in the middle of its phases, where a rerun would repeat
a model request or a classification, so they never park the generation. Two of
them may return tasks instead, which the
generation creates as its children and waits for with `allSettled`, as it does
for `afterRun` (spec §8.3). Children of the generation are its ordinary owned
work: Stop and idle waits include them, and an abort cascades to them first.
Requested tasks pass the checks `finish` applies (spec §8.3: an installed task
that is not built-in, JSON input, a valid `initial()`); a request that fails
one is reported as the hook's `extension_error` and skipped.

```ts
interface GenerationHooks {
  /** All observers today; may now request tasks, concatenated in extension order. */
  afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): HookResult<{ readonly tasks: readonly HookTask[] }>;
  /** The first result wins: a continuation now, or tasks whose result may carry one. */
  onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput } | { readonly tasks: readonly HookTask[] }>;
}

/** What an onYield task completes with to continue the run. */
type YieldDecision = { readonly continue?: UserInput };
/** What an afterTools task completes with to end the run after this round. */
type AfterToolsDecision = { readonly terminate?: true };
```

`pi.generation` becomes version 3 with two phases.

**`afterTools`.** In the `tools` phase, once the round is complete, the hooks
are asked. When they request tasks, one commit creates them and waits at
`{ phase: "afterTools"; assistant; tools; tasks }`. Once they are terminal, the
phase does what the `tools` phase does after its observers today (controls,
handoff, terminate, `maxTurns`, the `postTools` boundary, the next
generation). When any task completed with `{ terminate: true }`, the round ends as
a round whose calls all asked to `terminate` ends (spec §8.5): the inputs settle
`done` with the tool-calling answer (an answer that may hold no text, as for
`terminate` today), and the final boundary applies, or `afterRun`'s `finish`.
Otherwise a task answers the run by submitting a steer (`whenBusy: "steer"`) in
its terminal commit; the boundary places it as for any steer (in a terminating
round the final boundary takes it as a user item; at `maxTurns`,
`afterFailedRun` decides). A result that is neither absent nor an
`AfterToolsDecision` is reported as the hook's `extension_error` and ignored. A crash before the tasks exist asks the
hooks again; after, it resumes the wait. Abort, the restart limit, and the
scheduler's cleanup end the run as in `tools`.

**`yield`.** When the first `onYield` result is `{ tasks }`, the commit that
classifies a `stop` or `length` answer appends the answer, keeps `run` with its
inputs open, records `run.yield = { answer, tasks }` in `pi.live`, applies no
boundary, creates the tasks, and waits at `{ phase: "yield"; answer; tasks }`.
The tasks read the answer's entry from `run.yield.answer` (the hook runs before
the entry exists). Once all of them are terminal, the first task in creation
order that completed with a `{ continue }` holding a valid `UserInput` provides
the continuation, which applies as a `{ continue }` from the hook does today
(only with no steer, follow-up, or reset queued). Without one, the run ends as a
`stop` answer ends today (`afterRun`'s `finish`, or the final boundary). Every
other exit (abort, restart limit, scheduler fault or orphaning) settles the
inputs `done` with `run.yield.answer` and records no `runFailure`; the
scheduler's cleanup reads `run.yield` for that.

**`onYield` tasks and `afterRun` tasks are different moments** (the owner keeps
both; p3's account): `onYield` tasks decide whether the answer stands, while
the inputs are still open, so `Submission.wait()`, `notify`, and every caller
waiting on the run see only an answer that passed them; one decider wins, and
it can send the agent back to work in the same run. `afterRun` tasks act on an
answer that stands: they run after the inputs settled `done`, only when no
continuation applied, every hook's tasks are concatenated, and they can only
start new work (a submission becomes a new run). A review is therefore an
`onYield` task (an `afterRun` review comes too late, its callers already have
the answer), and delivering the answer to a chat, a notification, or a
subagent's report is `afterRun` work, which sees only reviewed answers.

## 7. Visibility

- **Task graph** (spec §9.4): `sleeping` nodes show `until?` and `signals`;
  `waiting` nodes show `policy`.
- **Tool slots** (spec §8.2): the `status` of tool and nested slots gains
  `"sleeping"` and `"waiting"`; `run` gains `yield?`. A parked slot holds no
  output, so `pi.live` bases stay small. `pi.live` gets no version bump: the
  new values are additions, and rollback is not a goal.
- What a parked task waits for, beyond keys and deadlines (a question's text,
  an approval's arguments), is kept by whoever started the wait, in its own
  state, keyed by task ID and key.

## 8. Hosts and liveness

- A host decides whether its process must stay up from `wake()`, not from the
  task graph or idle: a Session whose live work is all parked is not active.
  Public idle waits still include parked work; the kept contexts of spec §5.1
  use a separate inactivity check that counts a conversation whose live work is
  all parked as inactive.
- A host arms its recovery wakeup before `signal()`, as before `submit()`.
- A host whose process exits when idle (p2's worker) exits only after its next
  `at` has been durably handed to something that outlives it, since `onWake`
  runs after the commit and is not awaited. Signals for a Session whose process
  is gone are delivered by starting it and opening the Harness first.

## 9. What Durable leaves to hosts

How plugins' hooks are composed into Durable's registry (which runs in which
order, read-only observers, merging several gates' answers, argument changes
before approvals, taking a resource only after every other gate passed) is the
host's harness design. It builds on: extension order, `beforeTool` with
`block` and `sleep`, the rerun of the `call` phase on every wake and registry
change, `readSignal()`, `afterTool` on every result, and tasks returned from
`afterTools` and `onYield`. A third-party task that wants gates of its own
declares hooks whose results may ask to block or sleep and commits the sleep
itself.

Wrappers (`wrapTool`) decorate execution and never park. When the Harness
composes a tool, it hands each wrapper a base whose `execute()` records every
park it returns; a park the composite returns that its base did not return
becomes a `tool_error` result, code `invalid_park`. A wrapper that maps results
passes a park through unchanged.

## 10. Compatibility

- **Existing data and tools:** unchanged at runtime. Version 3 tool calls
  migrate as they are; tasks and plain sleeps behave as before.
- **Source changes:** `execute()`'s return type widens to include `ToolPark`
  (code that reads a tool's result handles parks); `until` is optional on
  sleeping states; `JoinPolicy` and slot `status` gain members; `executeTool()`
  gains an overload; `defineTool`, `ToolRegistration`, and `ToolExecutionApi`
  gain a checkpoint type parameter with a default; `HookApi` gains
  `readSignal` and `now()`; `RunEndTask`/`runEndTask` (1.5.0) are renamed
  `HookTask`/`hookTask` (callers of `afterRun` hooks rename one import). In p2: `apps/p2/src/runtime/tool-access.ts` annotates
  `Promise<ToolExecutionResult>`; `web/transcript.ts` passes `slot.status` into
  its `ToolStatus`; `activity/model.ts` and `web/transcript.ts` test only
  `pending` and `running`, so a parked call would read as not busy until they
  handle `sleeping` and `waiting`.
- **Behavior:** `durationMs` reports the whole span; registry publications and
  open wake calls parked at `call`.
- **Versions:** `pi.tool` 4, `pi.generation` 3. No SQLite schema change.
  Rollback to an older Harness is not supported.
- **Error codes:** spec §7.3's list gains `invalid_park`.
- **Changelog:** the implementation adds `### Breaking Changes` entries to
  `packages/durable/CHANGELOG.md` under `[Unreleased]` for the
  `RunEndTask`/`runEndTask` rename, `execute()`'s widened return type, `until`
  becoming optional, and the changed meaning of `durationMs`; the rest goes
  under `### Added`.

## 11. Footguns

1. **`execute()` may run twice before its park is stored.** A crash after an
   external call reruns a replay-safe `execute()`. Use an idempotency key the
   tool owns, memoized before the call.
2. **A first run cut off before it parked runs no `cancel`.** Its external
   work is found only through the tool's own idempotency key.
3. **`cancel` may run more than once** (after the tool's own abort handling,
   after a crash): make it idempotent.
4. **Webhook retries** get `duplicate`; a signal after an abort or after the
   deadline gets `closed`. Hosts answer both as final.
5. **A key serves one wait** (section 3.4). Other keys of a multi-key sleep
   stay open after one wakes it: a later value is kept for a later sleep.
6. **Signal values come from outside.** The schema checks their shape at
   delivery; what they mean is the receiver's to check.
7. **`beforeTool` reruns on every wake before intent**, and on registry
   changes: its side effects are idempotent, and an approval binds to the
   arguments it saw (section 5.1).
8. **A caller awaiting a parked nested call** (`executeTool()` with
   `wait: true`, code mode today) keeps its invocation.
9. **A parked call keeps its run busy**: new messages queue and are placed
   after the round; Stop is the way out.
10. **A host that idles** hands its next `at` to something durable before it
    exits (section 8).

## 12. Open questions

None left.

Decided (owner, 2026-11-09): an `afterTools` task can end the run with
`{ terminate: true }` (section 6), as a round whose calls all asked to
`terminate` ends; `RunEndTask`/`runEndTask` (released in 1.5.0) are renamed
`HookTask`/`hookTask`, a task spawned by a hook; `run.yield` stays in `pi.live`; gating a model
request (`beforeRequest` sleeping) is deferred; code mode parking its VM is
separate work, earendil-works/pi#11981.

## 13. Examples

The build adds runnable examples to `packages/durable/test/examples/`, in the
existing format (a header saying what it shows and how to run it, commented
steps, printed results; faux provider, memory storage), numbered after
`37-harness-registry.ts`. Each shows one concept and its crash or abort case:

| Example | Shows |
| --- | --- |
| `38-signals.ts` | `defineSignal`, `harness.signal()` results (`delivered`, `duplicate`, `invalid`, `closed`, `not_found`), an early signal kept and waking the sleep at once |
| `39-ask-a-person.ts` | a plugin task sleeping on a signal with a deadline: answered, then a second run that expires; `wake.reason` and `readSignal()`; `wake()` inactive while it sleeps |
| `40-tool-waits-for-webhook.ts` | a tool that parks on a signal (`run_ci` with a fake CI client and webhook registry): park, deliver, wake, result; a crash before the park (idempotency memo) and Stop while parked (`cancel`) |
| `41-tool-polls.ts` | a tool that parks on time and polls a fake job until it is done, with backoff |
| `42-parallel-children.ts` | `executeTool(..., { wait: false })`, `{ wait: { on, policy: "any" } }`, collecting results by key across wakes |
| `43-subagent-waits.ts` | a subagent tool that parks on `SubmissionSettled` (`notify`) while its child conversation parks on a person |
| `44-approval-gate.ts` | a `beforeTool` gate sleeping on an approval keyed by the arguments' digest, with a memoized deadline; a second gate (quiet hours) asked again on every wake; denial and expiry as blocks |
| `45-review-on-yield.ts` | an `onYield` hook returning a review task whose `{ continue }` sends the agent back; a user message queued meanwhile wins over the continuation |
| `46-after-tools-terminate.ts` | an `afterTools` task asking a person whether to go on: a steer on "go on", `{ terminate: true }` on "stop" |

Each example also prints `harness.wake()` while work is parked, so a host
author sees what keeps a process alive.

## 14. Review record

The third revision was reviewed by gpt-6-astra, gpt-6.1-sol, and
claude-opus-5-5 against spec.md and the code. Fixed here:

- The filled-key rejection broke early delivery (all three): the waking
  reservation marks its key consumed, and only consumed or expired keys reject.
- Submission notifications could not call `tx.signal()` after the settling
  commit's table writes (all three): delivery is assembly work, any number per
  commit, never failing the commit.
- Signal writes could be erased by a whole-record replacement in the same
  transaction (all three): writes compose against the latest candidate.
- The wake step dispatched straight into `execute`, which only recovery may
  reach (astra): reservation keeps checkpoint `parked`, whose handler commits
  intent and runs the tool.
- No path owned cleanup between wake intent and entering `execute()`, after a
  rejected park commit, or for a restart-marked woken run (all three): the
  cleanup rules of section 4.2.
- The `abandonOnRestart` rules contradicted each other and missed the crash
  between a wake reservation and intent (all three): one rule on the owner's
  checkpoint, which wins.
- Registry wakes raced a running `beforeTool` and were lost by a restart (all
  three): snapshot check at the sleep commit, wake at publication and at open.
- `Wake` already names `Harness.wake()`'s type (all three): `WakeReason`.
- Revision 4's delta review (all three) found: progress compared checkpoints
  only (now whole states without `wake`); registry and open wakes moved gate
  deadlines and skipped expiry (deadline path; deadlines memoized); "rerun
  instead of sleeping" was not implementable (commit, then wake at once);
  `HookApi` had no `now()`; the rejected-park `cancel` ran in an aborted
  context; recovery dropped carried details; old key-map members lacked
  `kind`; pi-schema admits non-JSON values; the self-signal throw conflicted
  with `notify` (dropped, writes compose); the subagent example replaced the
  parent's selection with host defaults; a removed tool's wake left owned work
  unsupervised (now `failed`); `read()` failures; aborting a parked call whose
  tool was removed. A late answer from astra added: flush buffered metadata at
  the park, `{ sleep, wait }` together is invalid, and `durationMs` covers every
  result.
- `defineSignal` could not infer its value type, sleeps were typed with records
  while examples passed tokens, and `is()` could not migrate an immutable wake
  (all three): `defineSignal<S extends object>` over a pi-schema schema, `SignalKey` is the JSON record,
  `readSignal()` is the one way to read a value (owner, after the review: the
  wake names the key only, no `token.read()`).
- `HookApi` lacked `readSignal`, and gates could not tell expired from not yet
  answered (opus, astra): `readSignal()` on `HookApi`, returning
  `{ value } | { expired: true } | undefined`.
- A task's wake was dropped by an intent re-commit and counted as progress
  (opus): the wake stays until the checkpoint changes; progress compares
  checkpoints.
- Wrappers' parks could not be told apart from the base's, and mixed objects
  were undefined (opus): instrumented bases; mixed objects are invalid.
- Typing of `defineTool`'s checkpoint, keyed `createTask` identity, slot
  content across runs, empty parks, the woken-but-removed tool, `durationMs`
  scope, hook-task validation, memo-name ambiguity, `"any"` in `wake()` and
  inspection, delivery order (now `signals` order, not a clock), the separate
  inactivity check, p2 consumers of slot status, the error code, and wording
  (book and spec).
- Dropped as unneeded (opus): `cancel`'s checkpoint parameter (it reads
  `api.checkpoint`) and the `pi.live` version bump. Opus also proposed merging
  the `expired` wake reason into `time`; the owner kept both reasons.
- After review, the owner: the wake names the key only; `readSignal()` is the
  one way to read a value, `token.read()` is gone.
