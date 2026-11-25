---
title: Waiting for the World: suspendable work in pi-durable
cover: Waiting for / the World
kicker: A design book · draft, fifth revision · pi-durable · 2026-11-09
subtitle: How a task, a tool, or a gate waits hours for a webhook, a person, or its children, while nothing runs and the process may sleep
stats:
  - 0 | new task statuses
  - 1 | new delivery operation, signal()
  - 0 | changes to the SQLite schema
  - 4 | reasons parked work wakes: time, expired, signal, tasks
note: |
  Draft for review, not built. Follows `spec.md` in the same directory (cited as §n), which records the owner's
  decisions of 2026-11-09, the review by gpt-6-astra, gpt-6.1-sol and claude-opus-5-5, and extends
  `packages/durable/docs/spec.md` (cited as spec §n). Schemas use `@earendil-works/pi-schema`. How plugins compose
  hooks into policies (approvals, quotas, ordering) is the host's design, not Durable's; the last chapter says where
  that line runs.
colophon: Waiting for the World · fifth revision · 2026-11-09 · based on suspendable/spec.md and pi-durable spec.md
---

# Before we begin {.preface}

Ana asks her team's agent to fix a flaky test and verify it. The agent edits a file and calls `run_ci`, which starts
a CI build. The build takes twenty minutes and reports its result by calling a webhook. The agent runs in a Cloudflare
Durable Object, or in p2's per-session worker: a process that costs money or memory while it exists and can be
evicted at any moment.

What Ana's team wants is simple to say. While the build runs, nothing should run: no process held open for twenty
minutes, no alarm except at a deadline. When the webhook arrives, the call continues where it left off and the model
gets the result. If the process dies in between, the wait is not lost, and the build is not started twice.

pi-durable cannot do that today. A tool is one in-memory function, so the only way for `run_ci` to get the webhook is
to await it inside that function. This book shows why that fails, and then builds the solution one concept at a
time: signals, sleeps that wait for signals, tools that park, waits on children, waiting for a subagent, and gates
before a tool runs.

## Eight things to know

:::findings
1. **No new task status.** A `sleeping` task may wait for a time, for signals, or both. A `waiting` task may wake on
   the first of its tasks instead of all of them.
2. **A signal is a typed value delivered to a live task.** `harness.signal(taskId, token, key, value)` stores it on
   the task, checked against the token's schema; the first value for a key wins.
3. **Early signals are kept.** A value that arrives before the task sleeps is stored, and the sleep wakes at once.
4. **Parked code is told why it woke.** Tasks read `task.state.wake`, tools read `api.wake`: time, expired, a signal, or tasks.
5. **A tool parks by returning instead of a result.** `execute()` returns `{ sleep }` or `{ wait }`; on wake it runs
   again with `api.wake` and `api.checkpoint`.
6. **Waking commits intent first.** A woken tool call records its wake before its code runs, so a replay-unsafe tool
   is never run twice.
7. **Gates are `beforeTool` hooks that sleep.** Every wake before intent reruns the whole call phase, so every gate is
   asked again.
8. **Abort ends a park at once,** and hosts decide liveness from `wake()`, not from the task graph.
:::

## Words used throughout

A **task** is a durable state machine with a **checkpoint** per step (spec §5.1); an **invocation** is one run of its
code in memory; a **phase** is one named step. A task **parks** when it commits `waiting` (until other tasks end) or
`sleeping` (until a time or a signal) and its invocation ends. A **signal** is a JSON value delivered from outside,
under a **key** that names one wait; its **token** gives it a name, a version, and a schema. A **wake** says why parked
work runs again. **Intent** is the commit that records a tool call before its code runs. A **gate** is a `beforeTool`
hook that may stop or delay a call. A **memo** is a small first-writer-wins value stored on a live task.

# Why It Fails Today {#today lede="What a durable task can wait for now, and what happens to a tool that waits for a webhook."}

A durable task can park in two ways today. It can wait for other tasks, and it can sleep until a time:

```ts
type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S }
  | { readonly status: "running"; readonly checkpoint: S }
  | { readonly status: "waiting"; readonly checkpoint: S; readonly on: readonly TaskId[]; readonly policy: "failFast" | "allSettled" }
  | { readonly status: "sleeping"; readonly checkpoint: S; readonly until: number }
  | { readonly status: "completing"; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };
```

A parked task holds no invocation. Its state is in the record, and the scheduler starts a new invocation at the stored
checkpoint once the tasks end or the time comes. That is what makes waiting cheap: `harness.wake()` reports
`{ active: false, at: until }`, and a Durable Object sets its alarm to `until` and hibernates.

Neither state fits a webhook: nothing inside the Session finishes, and no time is known. And a tool cannot park at
all. Its whole life is one function:

```ts
type ToolRegistration<TParameters extends object = object, TDetails extends JsonValue = JsonValue> = Tool<TParameters> & {
  readonly replay?: "safe" | "unsafe";
  execute(args: ToolArgs<TParameters>, api: ToolExecutionApi<TDetails>, context: Context): Promise<ToolExecutionResult<TDetails>>;
};
```

So `run_ci` has to await the webhook inside `execute()`:

```ts
import { obj, str } from "@earendil-works/pi-schema";

// The CI service's client, and a host helper that resolves when the webhook for a build arrives.
declare const ci: { trigger(input: { ref: string }, context: Context): Promise<{ id: string }> };
declare function webhookFor(buildId: string, context: Context): Promise<{ status: "passed" | "failed"; logUrl: string }>;

const runCi = defineTool({
  name: "run_ci",
  description: "Run CI on a git ref and report the result",
  parameters: obj({ ref: str() }),
  replay: "safe",
  async execute({ ref }, api, context) {
    const build = await ci.trigger({ ref }, context);
    const result = await webhookFor(build.id, context); // twenty minutes, in memory
    return { output: [{ type: "text", text: `CI ${result.status}: ${result.logUrl}` }], isError: result.status !== "passed" };
  },
});
```

:::sequence animate | run_ci today. The invocation is held for the whole build; a crash loses the wait.
actor tool "run_ci" "tool task, running"
actor harness "Harness" accent
actor ci "CI service" muted
tool -> ci: trigger(ref) -> build 7
note tool..ci: execute() awaits the webhook; wake().active = true; the object cannot hibernate
divider "the process is evicted after 8 minutes"
harness -> tool: recovery: replay-safe, execute() again
tool -> ci: trigger(ref) -> build 8, a second build
ci -> harness: webhook for build 7: nobody listens
:::

Three things go wrong. The Session stays active for twenty minutes, so the process cannot sleep. A crash loses the
wait: a replay-safe tool starts a second build, a replay-unsafe one returns `interrupted` to the model. And the webhook
needs something in memory to receive it, which is exactly what a sleeping process does not have.

The same holds for every wait on the outside world: an approval before a tool runs, a question to a person, a subagent
that itself waits for a person. Each is a promise in memory.

# Signals {#signals lede="A typed value delivered to a live task, stored on its record, whenever it arrives."}

The missing piece is a way for the outside world to hand a value to a task that is not running. That value is a
**signal**. A signal has a **token** that names it, versions it, and gives it a schema, like a document kind:

```ts
function defineSignal<S extends object>(definition: {
  readonly name: string; // unique like a task kind; no "/"
  readonly version: number;
  readonly schema: S; // a pi-schema schema of a JSON value (no bigint(), no bytes()); the value type is Static<S>
  readonly migrate?: (value: JsonValue, fromVersion: number) => Static<S>;
}): SignalToken<Static<S>>;

interface SignalToken<T> {
  readonly name: string;
  readonly version: number;
  /** The key of one wait, as JSON: { signal: this name, key }. */
  key(key: string): SignalKey<T>;
}

type SignalKey<T> = { readonly signal: string; readonly key: string; readonly "~value"?: T };
```

```ts
import { obj, oneOf, str } from "@earendil-works/pi-schema";

const CiResult = defineSignal({
  name: "app.ci-result",
  version: 1,
  schema: obj({ status: oneOf(["passed", "failed"]), logUrl: str() }),
});
// CiResult: SignalToken<{ status: "passed" | "failed"; logUrl: string }>

CiResult.key("done"); // { signal: "app.ci-result", key: "done" }: one wait, "the CI result for this call"
```

## Delivering

```ts
type SignalResult = "delivered" | "duplicate" | "invalid" | "closed" | "not_found";

interface Harness {
  signal<T>(taskId: TaskId, token: SignalToken<T>, key: string, value: T, context: Context): Promise<SignalResult>;
}
interface Tx {
  signal<T>(taskId: TaskId, token: SignalToken<T>, key: string, value: T): Promise<SignalResult>;
}
```

`signal()` is one commit on the Session line. It checks, in order:

| check | result |
|---|---|
| no such task | `not_found` |
| the task is terminal, holding its outcome, or abort-marked | `closed` |
| the value does not match the token's schema | `invalid` |
| the key already holds a value | `duplicate`; the first value is kept |
| the key expired (chapter IV) | `closed` |
| otherwise | stored: `delivered` |

`Harness.signal()` is for hosts: a webhook route, a button in a UI. `tx.signal()` lets one task deliver to another
inside its own commit. Neither checks who calls it; the host authenticates the sender.

## Early signals are kept

The value is stored on the task whatever state the task is in, as long as it is live. That matters in the case that
breaks most designs: the webhook can arrive before the task has parked.

:::sequence animate | An early webhook. The value is stored while the tool still runs; its sleep wakes at once.
actor tool "run_ci" "tool task, running"
actor harness "Harness" "the line" accent
actor ci "CI service" muted
tool -> ci: trigger build for task 41
ci -> harness: signal(41, CiResult, "done", { passed })
harness => harness: commit: value stored (task still running)
tool -> harness: return { sleep: { signals: [CiResult.key("done")] } }
harness => harness: commit: sleeping on "done"
harness -> tool: the key holds a value: wake at once
:::

Where it is stored: the task's memos, under a prefix the Harness reserves (`pi.signal.app.ci-result/done`). Memos
already live exactly as long as needed (spec §5.2): through checkpoints, restarts, handovers, and migrations, gone when
the task ends. Code never reads that memo directly.

## Size

There is no size limit, and no limit on keys per task. The rule instead: nothing large goes into the task record,
because the scheduler keeps live records in memory and rewrites them on every write. A webhook that would carry a whole
log carries the CI run's ID, and the task fetches the log by it.

# Sleeping on Signals {#sleep lede="A sleep that waits for a time, for signals, or both, and what the woken phase reads."}

With signals stored on the task, a sleep can wait for them. The `sleeping` state gains a list of keys, and `until`
becomes optional:

```ts
type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S; readonly wake?: WakeReason }
  | { readonly status: "running"; readonly checkpoint: S; readonly wake?: WakeReason }
  | { readonly status: "waiting"; readonly checkpoint: S; readonly on: readonly TaskId[]; readonly policy: "failFast" | "allSettled" | "any" }
  | { readonly status: "sleeping"; readonly checkpoint: S; readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] }
  | { readonly status: "completing"; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };
```

A sleep needs `until`, a non-empty `signals`, or both. With both, it ends at whichever comes first.

## Why it woke

The woken phase needs to know whether the signal came or the deadline passed. The reservation commit that wakes the
task writes that into the running state:

```ts
type WakeReason =
  | { readonly reason: "time" } // until reached, no signals listed
  | { readonly reason: "expired" } // until reached before any listed signal
  | { readonly reason: "signal"; readonly signal: string; readonly key: string } // the key whose value woke it
  | { readonly reason: "tasks"; readonly ended: readonly TaskId[] }; // chapter VI
```

The wake stays on the task until it commits a different checkpoint, parks, or ends. A restart, a close, or a handover
puts the task back to `pending` with its wake, so a phase that runs again after a crash reads the same one.

The wake names the key, not its value. The value is read with one method, typed by the token and migrated from an
older version if needed. It reads the live task record the scheduler keeps in memory, so it costs no storage access:

```ts
type SignalState<T> = { readonly value: T } | { readonly expired: true };

interface TaskRuntime {
  /** The key's state: its value, expired at the deadline, or undefined while nothing came. */
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
}
```

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
        () => ({ status: "sleeping", signals: [Answer.key("answer")], until: runtime.now() + 4 * HOUR, checkpoint: { phase: "answered" } }),
        context,
      ),
    answered: async (_task, runtime, context) => {
      const state = await runtime.readSignal(Answer, "answer", context); // { value: { text } } when answered, { expired } after four hours
      const text = state !== undefined && "value" in state ? state.value.text : undefined;
      return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { text } } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
```

The phase that sleeps commits the state and ends; it returns nothing. The checkpoint names the phase that runs on wake,
`answered`. A UI that shows the question keeps its own record of it and calls
`harness.signal(taskId, Answer, "answer", { text })` with the reply.

# Deadlines and Keys {#deadlines lede="Who wins when a signal and a deadline arrive together, and why a key serves one wait."}

## The deadline race

Suppose the deadline passes and the scheduler wakes the task with `expired`, and the signal arrives a second later. If
that signal got `delivered`, its sender would believe it was taken while the task reports a timeout. So the commit that
wakes a task for its deadline marks every listed key that holds no value as expired, and a later delivery gets
`closed`. `signal()` itself closes a key once the deadline of a sleep on it has passed, even before the scheduler woke
the task (for instance while a Durable Object sleeps past its alarm).

| arrives | result | the task wakes with |
|---|---|---|
| before the deadline | `delivered` | `signal` |
| after the deadline | `closed` | `expired` |
| a second copy of a delivered value | `duplicate` | (unchanged) |

## One key serves one wait

A value stays readable until the task ends. If a phase slept again on the key that just woke it, it would wake at
once, and again, forever; every wake counts as progress, so the restart limit would never stop it. So the reservation
that wakes a task on a key marks the key **consumed**, and a sleep on a consumed or expired key is rejected: the commit
throws for a task, a tool call ends with an `invalid_park` error. A key with a value that arrived early, before any
wake used it, is not consumed, and the sleep wakes at once. A second wait for the same kind of signal uses a new key:

```ts
CiResult.key("ci-1"); // the first build of this call
CiResult.key("ci-2"); // a second build in the same call
```

A sleep on several keys wakes on the first that holds a value, in the order listed. The other keys stay open: a value
delivered to them later is kept for a later sleep.

## Reading without waiting

`readSignal()` does not depend on the wake: it reads a key whatever woke the task, or nothing did. `HookApi` and
`ToolExecutionApi` get the same method, so hooks and tools can read a key without sleeping on it. Gates (chapter VIII)
need exactly that: a gate asked again after another gate's wake still finds its own answer.

## When parked work counts as active

`harness.wake()` gains two cases for `active`: a sleeping task that is eligible (a listed key holds an unused value, or
its `until` passed), and a waiting `"any"` task with a terminal member. `at` stays the earliest `until`. A sleep on
signals alone counts for neither, so a Session whose work is all parked on signals has no alarm and may stay asleep for
days.

# Tools That Park {#tools lede="A tool returns a park instead of a result, and runs again when it wakes."}

A tool cannot commit states; its task does. So a tool parks by returning what it wants instead of a result, and the
tool task commits it:

```ts
type ToolPark<C extends JsonValue = JsonValue> =
  | { readonly sleep: { readonly checkpoint?: C; readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] }; readonly wait?: never }
  | { readonly wait: { readonly checkpoint?: C; readonly on: readonly TaskId[]; readonly policy: "failFast" | "allSettled" | "any" }; readonly sleep?: never };

type ToolRegistration<TParameters extends object = object, TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue> =
  Tool<TParameters> & {
    readonly replay?: "safe" | "unsafe";
    execute(args: ToolArgs<TParameters>, api: ToolExecutionApi<TDetails, C>, context: Context): Promise<ToolExecutionResult<TDetails> | ToolPark<C>>;
    /** Clean up the external work of a call that parked; runs when no code of the tool runs. */
    cancel?(args: ToolArgs<TParameters>, api: ToolExecutionApi<TDetails, C>, context: Context): Promise<void>;
  };

interface ToolExecutionApi<TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue> {
  // ... as today, and:
  readonly wake: WakeReason | undefined; // undefined on a fresh call
  readonly checkpoint: C | undefined; // what the call last parked with
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
}

function defineTool<TParameters extends object, TDetails extends JsonValue = JsonValue, C extends JsonValue = JsonValue>(
  tool: ToolRegistration<TParameters, TDetails, C>,
): ToolRegistration<TParameters, TDetails, C>;
```

The words are the task's: `sleep` and `wait` mirror the parked states, `checkpoint` is what the tool keeps, `wake` is
why it runs. When the call wakes, the same `execute()` runs again with the same arguments and `api.wake` set.

## run_ci, parked

```ts
import { obj, oneOf, str } from "@earendil-works/pi-schema";

const HOUR = 60 * 60 * 1000;
const CiResult = defineSignal({ name: "app.ci-result", version: 1, schema: obj({ status: oneOf(["passed", "failed"]), logUrl: str() }) });
const CiParameters = obj({ ref: str() });

// The host's webhook registry ("when the webhook for `match` arrives, signal this key to this task"; durable and
// idempotent), and the CI service's client.
declare const webhooks: { expect<T>(match: string, taskId: TaskId, token: SignalToken<T>, key: string, context: Context): Promise<void> };
declare const ci: {
  trigger(input: { ref: string; correlationId: string; idempotencyKey: string }, context: Context): Promise<{ id: string }>;
  cancel(buildId: string, context: Context): Promise<void>;
  cancelByKey(idempotencyKey: string, context: Context): Promise<void>;
};

const runCi = defineTool<typeof CiParameters, JsonValue, { buildId: string }>({
  name: "run_ci",
  description: "Run CI on a git ref and report the result",
  parameters: CiParameters,
  replay: "safe",
  async execute({ ref }, api, context) {
    // The webhook's result, the deadline's expiry, or nothing yet (a fresh call). Read from the live record in memory.
    const state = await api.readSignal(CiResult, "done", context);
    if (state !== undefined && "value" in state) {
      const { status, logUrl } = state.value;
      return { output: [{ type: "text", text: `CI ${status}: ${logUrl}` }], isError: status !== "passed" };
    }
    if (state !== undefined) {
      return { output: [{ type: "text", text: `CI build ${api.checkpoint?.buildId} never reported` }], isError: true };
    }
    // A fresh call. The tool's own idempotency key with CI: memos are first-writer-wins, so a rerun gets the same one.
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

The tool owns its idempotency key and knows nothing about URLs. The host owns webhook routing: its route checks the
service's signature, looks up which task waits for `runId`, and calls `harness.signal()`.

## What the tool task commits

The tool task gets a third checkpoint:

```ts
type ToolTaskCheckpoint =
  | { phase: "call" } // resolve, validate, beforeTool
  | { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe"; wake?: WakeReason; checkpoint?: JsonValue } // intent
  | { phase: "parked"; arguments: JsonObject; replay: "safe" | "unsafe"; checkpoint?: JsonValue }; // sleeping or waiting
```

:::flow wide animate | The tool task's phases. New is accent: a park commits `parked`; its handler commits intent before the code runs again.
row "Today" muted
box call "call" "resolve, validate, beforeTool"
box exec "execute" "intent committed; execute() runs"
box result "result commit" "afterTool, entry, slot done"
row "New" accent
gap
box park "parked" "sleeping or waiting" accent
box wake "parked handler" "resolve, commit intent with the wake" accent
arrow call -> exec "intent"
arrow exec -> result "a result"
arrow exec -> park "a park"
arrow park -> wake "signal, time, tasks"
arrow wake -> exec "execute() again"
:::

The wake goes through the `parked` phase's own handler, not straight into `execute`, because `execute` is the phase
only recovery reaches. The handler resolves the tool (a tool removed meanwhile settles `tool_unavailable` and the task
fails, so work the call owns is aborted), commits
`execute` with the wake, then calls `execute()` in the same handler. That intent commit is what keeps replay honest: a
close writes running tasks back as `pending` without counting a restart, so without it a first wake and a rerun after a
close would look the same. With it, recovery finds `execute` and applies today's rule: rerun when both the stored and
the current policy say `safe`, otherwise `interrupted`. The wake is stored with it, so a rerun sees the same one.

:::sequence animate | The webhook arrives twenty minutes later. Between the park and the wake nothing runs.
actor gen "generation" "waiting on its tools" muted
actor tool "run_ci" "tool task"
actor harness "Harness" accent
actor host "host route" blue
actor ci "CI service" muted
tool -> harness: return { sleep: ... }
harness => harness: commit: checkpoint parked, sleeping on "done", until +2h
note gen..ci: no invocation; wake().at = the deadline; the object hibernates
ci -> host: POST webhook (signed)
host -> harness: arm recovery wakeup; signal(41, CiResult, "done", body)
harness => harness: commit: value stored
harness => harness: reserve: running at parked, wake = signal
harness => harness: parked handler: commit intent (execute, wake)
harness -> tool: execute(args) with api.wake
tool -> harness: result
harness => harness: commit: result entry, slot done
harness -> gen: all tools terminal: next request
:::

## Cleanup

`cancel` covers the cases where the call's external work may be live while no code of the tool runs:

- the call is aborted while parked;
- a woken run was aborted, also before `execute()` was even entered (the checkpoint is `execute` with a wake);
- a woken run of a replay-unsafe tool was cut off by a crash or a close, and recovery settles it `interrupted` (a
  replay-safe one simply runs again);
- `execute()` returned a park but the call was abort-marked before the park was stored; this `cancel` gets a context
  the abort does not cancel.

It does not run for a first run cut off before it ever parked: that run's work is found only through the tool's own
idempotency key, which is why `run_ci` memoizes `runId` before calling CI. While `execute()` runs, an abort reaches
the tool through its context and the tool cleans up itself; `cancel` may still run afterwards, so it must be
idempotent.

## Output and timing

Each run starts with empty output; details and diagnostics carry over in the call's slot. `durationMs` on a tool result
becomes the span from the task's start to the result, for every result: gate waits, parks and reruns included. Today
it measures only the last `execute()` attempt; records from before `startedAt` existed keep that.

# Waiting on Children {#children lede="A tool starts nested calls without waiting for them in memory, and parks until one ends."}

A tool that calls other tools today awaits `executeTool()`, which holds its invocation for as long as the nested call
takes. With parking, it can start the call, get a handle, and park until the call ends:

```ts
interface ToolExecutionApi {
  /** As today: start or find the nested call, wait, return its result. */
  executeTool(name: string, args: JsonObject, context: Context, options?: { key?: string; progress?: boolean; wait?: true }): Promise<NestedToolExecutionResult>;
  /** wait: false: start or find it, return a handle at once. */
  executeTool(name: string, args: JsonObject, context: Context, options: { key?: string; progress?: boolean; wait: false }): Promise<NestedToolCall>;
  /** As today; with a key, a later call with the same key returns the existing task. */
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
    input: I,
    options: Omit<TaskOptions, "conversationId"> & { readonly key?: string },
    context: Context,
  ): Promise<TaskId<R>>;
}

type NestedToolCall = {
  readonly taskId: TaskId;
  /** The stored result once the call is terminal; otherwise waits for it. */
  result(context: Context): Promise<NestedToolExecutionResult>;
};
```

Keys are what make this safe across runs. The call's key map (spec §7.3) records each child under its key in the
commit that creates it, so every later run with the same key gets the same child; another tool, other arguments, or
another task kind under a used key throw. Default keys are positions in a run, which mean different calls after a
wake, so after a wake every `executeTool()` needs an explicit key and an unkeyed `createTask()` throws.

A `wait` with `policy: "any"` wakes on the first child that ends; the wake lists the children that are terminal:

```ts
import { obj, str } from "@earendil-works/pi-schema";

const ResearchParameters = obj({ x: str(), y: str() });

const researchBoth = defineTool<typeof ResearchParameters, JsonValue, { done: TaskId[] }>({
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

Two rules keep the children alive. Parking is not settling: the tool task does not abort live nested calls when it
parks, as it does when a call settles. And children of a replay-unsafe tool, normally abandoned at the next restart
because their caller never runs again, are kept while their caller is parked: the rule looks at the caller's
checkpoint, `call` or `parked`, so it also holds if the caller crashed between its wake and its intent.

# Waiting on a Subagent {#subagent lede="A subagent tool parks until the subagent's answer settles."}

A subagent tool creates a conversation, submits the task, and waits for the answer. The subagent's work runs as
generation tasks owned by that conversation, not as children of the tool, so `wait.on` cannot name them. What the tool
can name is the submission. A submission can ask for a signal when it settles:

```ts
type SubmissionDraft = /* as today */ & {
  readonly notify?: { readonly taskId: TaskId; readonly key: string };
};

/** Built in: its value is what Submission.wait() resolves to. */
const SubmissionSettled: SignalToken<SettledSubmissionRecord>;
```

The commit that settles the submission also delivers the signal, as part of the same commit, so the delivery is atomic
with the settlement. It runs after the commit's own writes, like the submission settlement itself, and never fails the
commit:

```ts
// The answer entry's text, read from the settled record.
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
        // The parent's own selection without this extension, computed before the commit (spec §7.3).
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

While the subagent works, the Session is active anyway. Once the subagent parks too, asking a person or waiting for CI,
every task in the Session is parked and the process may sleep. A subagent that answers before the tool has parked is an
early signal, and the tool wakes at once.

# Gates Before a Tool Runs {#gates lede="A beforeTool hook that makes a call wait for an approval, a time window, or a quota."}

Some waits come before the tool runs at all: a person approves a risky command, a send waits for business hours, a
paid tool waits for its quota. Durable already has the place for "may this call run": `beforeTool`, which can block a
call or change its arguments. It gains one more answer, and hooks gain `readSignal`:

```ts
interface ToolHooks {
  beforeTool(
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ): HookResult<{
    readonly arguments?: JsonObject;
    readonly block?: string;
    readonly sleep?: { readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] };
  }>;
}

interface HookApi {
  // ... as today, and:
  readSignal<T>(token: SignalToken<T>, key: string, context: Context): Promise<SignalState<T> | undefined>;
  now(): number; // the Harness clock
}
```

The chain is today's: argument replacements in extension order, and the first `block` or `sleep` stops it. A `sleep`
parks the tool task at its `call` checkpoint. On every wake before intent, the whole `call` phase runs again from the
top: resolve, validate, every `beforeTool` in order, validate again. A gate that waited reads its key with
`readSignal()`, a value, expired, or nothing yet, and passes, blocks, or sleeps on a new key. The call runs only when a
whole pass ends without a block or a sleep; once intent is committed, `beforeTool` never runs again.

```ts
import { bool, obj } from "@earendil-works/pi-schema";

const DAY = 24 * 60 * 60 * 1000;
const Approval = defineSignal({ name: "approvals.decision", version: 1, schema: obj({ allow: bool() }) });

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
        // One deadline per question, fixed at the first pass: later passes keep it.
        const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, context);
        if (state === undefined) return { sleep: { signals: [Approval.key(key)], until } };
        if ("expired" in state) return { block: "No approval within a day" };
        return state.value.allow ? undefined : { block: "Not approved" };
      },
    }),
  ],
});
```

:::steps | A risky command, approved an hour later
+++ The first pass
The call phase runs; the approval gate finds nothing yet and returns a sleep. The tool task commits `sleeping` at
`call`. Nothing runs; the process may sleep.
+++ The answer
A person presses Allow. The host calls `harness.signal(taskId, Approval, key, { allow: true })`; the task wakes.
+++ The second pass
The call phase runs again from the top. Every gate is asked again; the approval gate reads its stored answer and
passes.
+++ Intent
No gate blocked or slept, so intent is committed and the command runs. Gates are never asked again for this call.
:::

Asking every gate again on every wake is what keeps several gates correct together. A quiet-hours gate that passed at
20:00 is asked again when the approval arrives at 23:30, and makes the call wait until morning.

An approval binds to the arguments it saw. A later `beforeTool` in the chain may still replace them, so making argument
changes come before approvals is the host's composition (chapter XII), not a Durable guarantee.

## Removing and adding gates

The call phase reruns, so the gates installed now decide, whenever the registry may have changed under a parked call:
a registry publication wakes every call parked at `call`; a `beforeTool` sleep that commits while the registry changed
since its phase started is woken at once; and the first pass after open wakes calls parked at `call`. That last one is
the only thing a restart runs while work is parked. When the sleep's deadline has already passed, such a wake takes
the deadline path, so the keys expire as they would have; and because every pass reruns the gate, a gate fixes its
deadline once, in a memo, as `Approvals` does. Calls that already committed intent are not affected.

## Hooks do not commit

Hooks get no `commit`. A hook answers; the asking task makes the decision durable in its own commit. A hook that writes
elsewhere, to a plugin's own store or a service, performs an external effect: it is not atomic with the task's commit
and runs again with every pass, so it is idempotent by a key derived from the task. Whatever it reserves is released
from the call's outcome: `afterTool` runs on every result the tool task writes, blocked and aborted included, except
past the restart limit and for tool tasks the scheduler faulted or orphaned, where the plugin reconciles against the
task graph.

# Hooks That Start Tasks {#hooktasks lede="afterTools and onYield may return tasks the generation waits for, instead of parking themselves."}

The gates of the last chapter park a tool call, and that is safe for one reason: `beforeTool` runs in the tool task's
`call` phase, before intent, and that whole phase reruns on every wake. The generation's hooks sit in the middle of its
phases: `onYield` runs between receiving an answer and classifying it, `afterTools` between a round and the next
request. Parking there would mean resuming a generation mid-phase, or rerunning a model request, which this design
avoids. So these hooks never park the generation. A hook that needs to wait returns tasks instead, and the generation
waits for them as its children, as it already does for `afterRun` (spec §8.3):

```ts
interface GenerationHooks {
  afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): HookResult<{ readonly tasks: readonly HookTask[] }>;
  onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput } | { readonly tasks: readonly HookTask[] }>;
}

/** Built by hookTask(task, input), which types input by the task. */
type HookTask = { readonly task: AnyTask; readonly input: JsonValue };
/** What an onYield task completes with to continue the run. */
type YieldDecision = { readonly continue?: UserInput };
```

**After a tool round,** returned tasks are created as the generation's children, and the round's usual end waits for
them. A task talks back in one of two ways: it completes with `{ terminate: true }`, and the run ends as a `terminate` round
ends, with the tool-calling answer; or it submits a steer, which the next boundary places before the next request.
Ana's Stop reaches the tasks through the generation.

**When the model answers,** `onYield` may return tasks, for a review that takes a model call or a person. The answer is
appended and the run stays open. Once all the tasks have ended, the first of them, in the order they were created, that
completed with `{ continue: input }` sends the agent back to work; without one, the run ends as it does today.

```ts
// A review the extension runs with a model of its choice; a rerun after a crash pays again.
declare function reviewWithModel(runtime: TaskRuntime<{}, { phase: "review" }, YieldDecision, {}>, context: Context): Promise<{ ok: boolean; notes: string }>;

const Review = defineTask<{}, { phase: "review" }, YieldDecision>({
  name: "app.review",
  version: 1,
  initial: () => ({ phase: "review" }),
  phases: {
    review: async (_task, runtime, context) => {
      const verdict = await reviewWithModel(runtime, context);
      const result: YieldDecision = verdict.ok ? {} : { continue: `A reviewer found problems:\n${verdict.notes}` };
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const Reviewer = defineExtension({
  name: "reviewer",
  tasks: [Review],
  hooks: [hook(GenerationTask, { onYield: () => ({ tasks: [hookTask(Review, {})] }) })],
});
```

Either kind of task may itself sleep on a signal, an `AskPerson` for example; the generation only waits for its
children to end.

`onYield` tasks and `afterRun` tasks are two different moments of a run. `onYield` tasks decide whether the answer
stands while the run's inputs are still open: whoever waits on the run (a parent's subagent tool, a chat bridge) gets
only an answer that passed them, and one of them can send the agent back to work. `afterRun` tasks act on an answer
that stands, after the inputs settled: delivering it to a chat, a notification, a subagent's report to its parent.
A review in `afterRun` would come too late, since the callers already have the answer.

# Abort and Crashes {#abort lede="What Stop does to parked work, and what runs again after a crash or a close."}

An abort is a durable mark, not a signal to running code, which is why it reaches work that has no running code. A
parked task with an abort mark stops waiting at once: it becomes runnable for its abort handler without waiting for its
signals, its deadline, or its tasks. Its children are aborted first, as always (spec §5.5).

:::sequence animate | Ana presses Stop while run_ci waits for its webhook.
actor ana "Ana" "Stop" blue
actor harness "Harness" accent
actor tool "run_ci" "parked"
actor ci "CI service" muted
ana -> harness: Conversation.abort()
harness => harness: commit abort marks: generation, run_ci
harness -> tool: abort invocation: cancel(args) with api.checkpoint
tool -> ci: cancel(build 7)
tool => harness: commit aborted result
ci -> harness: signal(41, ...)
harness --> ci: closed
:::

:::steps | Crash points of run_ci
+++ Before the park is stored
`execute()` triggered the build and the process died. The task is still in `execute`, without a wake. Replay-safe:
`execute()` runs again, and the memoized idempotency key makes CI return the same build. Replay-unsafe: `interrupted`;
only the tool's own key can find the build later.
+++ While parked
Nothing runs. Open keeps the task sleeping and counts no restart. The webhook may arrive before, during, or after the
restart: it is stored either way.
+++ Between the wake and the intent commit
The task comes back as `pending` at `parked` with its wake; the next reservation runs the `parked` handler again.
Nothing of the tool had run.
+++ While a woken run runs
Intent was committed with the wake. Replay-safe: the run repeats with the same wake. Replay-unsafe: `cancel` runs with
the last park's checkpoint, then `interrupted`.
+++ After the result
The result commit is atomic with the entry and the slot. Nothing reruns.
:::

# Seeing What Waits {#visibility lede="What hosts and UIs can see of parked work, and how a host decides whether to stay awake."}

The task graph shows a sleeping node with its `until` and its keys, and a waiting node with its policy. A parked tool
call's slot in `pi.live` shows `status: "sleeping"` or `"waiting"`. Durable stores no description of what a wait is
for: a question's text or an approval's arguments live with whoever asked, in their own records, keyed by task ID and
key.

A host decides whether its process must stay up from `wake()`, not from the task graph: a Session whose work is all
parked is not active. It arms its recovery wakeup before calling `signal()`, as before `submit()`. A host whose process
exits when idle, as p2's worker does, hands its next `at` to something durable before it exits, because `onWake` runs
after the commit and nothing waits for it. p2 counts every graph node as work today (`apps/p2/plugins/status/worker.ts`)
and must switch to `wake()`; its transcript and activity views must learn the new slot statuses.

# Where Durable Stops {#hosts lede="What this design leaves to the host's harness, and the one rule for wrappers."}

Durable provides the primitives: sleeps on signals, `policy: "any"`, tools that park, `beforeTool` that sleeps,
`readSignal()`, the rerun of the call phase on wakes and registry changes, `afterTool` on every result, tasks returned
from hooks. How a host composes its plugins' hooks on top (which run first, observers that cannot modify, several gates
merged into one answer, argument changes before approvals, a quota taken only after every approval passed) is the
host's harness design. p2 and p3 build that from extension order and these primitives. A third-party task that wants
gates of its own declares a hook whose result may ask to block or sleep, and commits the sleep itself.

Wrappers keep decorating how a tool runs: a command prefix, a timeout. They never park. The Harness hands each wrapper
a base whose `execute()` records the parks it returns, so a park the composite returns that its base did not return is
recognized and becomes an error result.

# Open Questions {.epilogue lede="What was decided at the end of the review."}

None left. Decided: an `afterTools` task can end the run with `{ terminate: true }`, as a `terminate` round ends;
`RunEndTask` and `runEndTask` (released in 1.5.0) are renamed `HookTask` and `hookTask`, a task spawned by a hook; `run.yield` stays in
`pi.live`; a model request cannot sleep yet (deferred); code mode parking its VM is separate work
(earendil-works/pi#11981).

# Examples to Build {.appendix}

The implementation adds one runnable example per concept to `packages/durable/test/examples/`, in the existing
format (faux provider, memory storage, printed results), after `37-harness-registry.ts`:

| Example | Shows |
|---|---|
| `38-signals.ts` | tokens, every `signal()` result, an early signal waking the sleep at once |
| `39-ask-a-person.ts` | a task sleeping on a signal with a deadline: answered once, expired once; `wake()` while it sleeps |
| `40-tool-waits-for-webhook.ts` | `run_ci` parking on a signal; a crash before the park, Stop while parked (`cancel`) |
| `41-tool-polls.ts` | a tool parking on time and polling with backoff |
| `42-parallel-children.ts` | `executeTool(..., { wait: false })` and `wait` with `policy: "any"` |
| `43-subagent-waits.ts` | a subagent tool parked on `SubmissionSettled` while its child waits for a person |
| `44-approval-gate.ts` | an approval gate with a memoized deadline, and a quiet-hours gate asked again on every wake |
| `45-review-on-yield.ts` | a review task sending the agent back with `{ continue }`; a user message winning over it |
| `46-after-tools-terminate.ts` | an `afterTools` task that steers on "go on" and ends the run with `{ terminate: true }` on "stop" |

# API Reference {.appendix}

| Surface | Change |
|---|---|
| `TaskState` | `sleeping`: `until?`, `signals?`; `waiting`: `policy: "any"`; `pending`/`running`: `wake?` |
| `WakeReason` | `time` \| `expired` \| `signal` (name, key) \| `tasks` (ended); the existing `Wake` is unchanged |
| signals | `defineSignal({ name, version, schema, migrate? })` over a pi-schema schema; `token.key(key)` |
| delivery | `harness.signal(taskId, token, key, value, context)`, `tx.signal(taskId, token, key, value)`: `delivered` \| `duplicate` \| `invalid` \| `closed` \| `not_found` |
| reading | `readSignal(token, key, context)` on `TaskRuntime`, `HookApi`, `ToolExecutionApi`: `{ value }` \| `{ expired: true }` \| undefined |
| tools | `execute()` may return `{ sleep }` or `{ wait }`; `api.wake`, `api.checkpoint`; `cancel?(args, api, context)`; `defineTool<TParameters, TDetails, C>` |
| nested | `executeTool(..., { wait: false })` returns `{ taskId, result(context) }`; `createTask(..., { key })`; explicit keys after a wake |
| submissions | `notify: { taskId, key }`; built-in `SubmissionSettled` |
| hooks | `beforeTool` may return `{ sleep }`; `afterTools` and `onYield` may return `{ tasks }`; `afterTools` tasks may end with `{ terminate: true }`; `RunEndTask`/`runEndTask` renamed `HookTask`/`hookTask` |
| `HookApi` | `readSignal()`, `now()` |
| tool task | `pi.tool` 4: checkpoint `parked`; intent stores `wake` and `checkpoint`; `durationMs` is the whole span |
| documents | `pi.live`: slot status `sleeping`/`waiting`, `run.yield` (no version bump); `pi.generation` 3: phases `afterTools`, `yield` |
| error codes | `invalid_park` |
| storage | no schema change |

# Glossary {.appendix}

**Checkpoint:** a task's saved step; for a parked tool, what it returned in its park. **Consumed:** a key that has
woken its task; it serves no second wait. **Expired:** a key closed by a sleep's deadline. **Gate:** a `beforeTool` hook
that may block or sleep. **Intent:** the commit that records a tool call before its code runs. **Invocation:** one run
of a task's code in memory. **Key:** names one wait for a signal. **Memo:** a small first-writer-wins value on a live
task. **Park:** commit `waiting` or `sleeping` and end the invocation. **Signal:** a typed JSON value delivered to a
live task. **Token:** a signal's name, version, and schema. **Wake:** why parked work runs again.
