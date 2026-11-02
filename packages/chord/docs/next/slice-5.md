# Slice 5: routines and jobs (spec)

Status: **reviewed, ready to build** (2026-10-24; reviews by Astra, Fable, Opus, Sol folded in). Guiding rule (owner): simple, fast, correct. The single source for building
slice 5, together with `design.md` §14 (routines) and §15 (jobs), read in full with the rest of `design.md`, the
feature map in `slices.md` (entries assigned to slice 5) and its "Carry-over" for slice 5, the decision log entries
"Routines for slice 5", "Routines and jobs open points" (with "Jobs keep accepts" and "Job crash handling"), D4, R11,
Q9, S8, W2b, P2, and the root `AGENTS.md` section "Chord v2 Code Style". Builds on slice 4b (`1c88b45d7`).

Slice 5 builds routines completely and jobs **in memory**. Persistence of jobs is slice 6 (it needs the store); the
reload rules of both (handover, `accepts` in use, `blocked { version }`, native restarts) are slice 7 (they need
reloads). Their APIs are declared here so that later slices add behaviour, not shape.

## What an app can do after this slice

```ts
// routines
host.serve(ForwardStore, (_, self) => {
  const forwards = self.state(Forwards);
  const catalog = self.get(Catalog, {});
  self.on(catalog.sessions, async (sessions, ops, ctx) => {
    for (const f of forwards.value.list) if (sessions[f.session]?.archived) await closeForward(f.id, ctx);
  });
  self.onLive(async (ctx) => {
    for (;;) { await sleep(HOUR, ctx); await dropExpired(ctx); }
  });
  return { … };
});

// jobs
const ShellJob = defineJob("chat.shell", {
  version: 1,
  args: obj({ command: str(), author: Author }),
  result: obj({ exit: int(), output: str() }),
  state: ShellState,
  concurrency: 1,
});
const shell = self.job(ShellJob, { run, finish });
await shell.start({ command: "npm test", author }, ctx, { key: requestId });
```

## 1. Routines (§14)

- `self.on(source, fn)` and `self.onLive(fn)`, declared only while the factory runs (as `state`, `derive`, `get`,
  `open`), in objects of both kinds and in facets (design §16: a facet holds documents, references, routines and
  contributions).
- `on` over a JSON `Watchable` calls `fn(value, ops, ctx)`; over a `NativeWatchable` (a registry value, `ref.state`)
  `fn(value, ctx)`. Overloads by the source's type. At runtime the source is resolved at declaration with
  `resolveWatchable` (Chord's own sources, constants, reference members); anything else that is a `NativeWatchable`
  (its `watch` yields a `NativeWatch`) is followed as native. There is no separate kind tag.
- Start: right after the object went live, in the same turn (owner); a method call admitted in that turn may run
  before the first `on` call. Stop: when the object ends, their `ctx` is aborted with the object's end error; the
  drain (§6) waits for routine calls like for method calls, bounded by `closeTimeout`.
- `on` is implemented over the shared `Watch` with a listener that **never throws** (a throwing listener would end the
  watch): it runs the handler, catches its error, reports it (`routine_failed`) and schedules its own retry. Calls
  never overlap; changes during a call fold into the next (the watch's pending queue: newest value, folded ops); a
  running call is never aborted by a change.
  - The first call gets the current value with `[["r", value]]` (W2b).
  - After a call that threw, the next call (the retry after the backoff, 1 s doubling to 60 s, or a change during the
    backoff, which calls at once) again gets `[["r", value]]`, never only the changes since: a handler that applies
    ops incrementally would otherwise drift. A call that succeeds resets the backoff.
  - The source ending (`ended`, `retired`: a document retired, a reference released) ends the routine without a
    report; the source failing (`failed`: a derive's compute threw, a provider member failed) ends it with one
    `routine_failed` report. (A failed provider member that recovers after a provider reload: slice 7 carry-over.)
- `onLive`: called once when the object is live. Returning ends it (until the next reload or activation, slice 7);
  throwing is reported and restarts it after the same backoff (reset when a run lasted at least a minute); an abort
  (the object ends) is no error and not reported.
- Each call's `ctx`: the object's principal (remote) or the host's (local), the host's incarnation, telemetry, and
  `ctx.get` references released when the call settles (`CallContext`).
- Not counted in `host.activity`.
- Helpers, exported for apps: `sleep(ms, ctx)` (rejects with the abort reason when `ctx` is aborted; clears its timer
  and listener; delays above the timer limit of 2^31-1 ms are chained) and `untilAborted(ctx)` (resolves when `ctx`
  is aborted). Portable (timers and `AbortSignal` only).
- `HostError` gains `routine_failed { object, routine, error }`, `routine` being the kind and declaration position
  (`"on #2"`, `"onLive #1"`).
- The reload handover per object is slice 7 (carry-over); in this slice a routine only starts with the object and
  stops with its end.

## 2. Jobs (§15), in memory

### Declaration

- `defineJob(name, { version, args, result, state?, concurrency?, accepts?, persist? })`: `args` closed (like method
  arguments: checked at `start` with a compiled validator, `invalid/args`); `result` not validated (the provider's);
  `state` a singleton document definition; `concurrency` a positive integer; `accepts` checked at declaration (shape,
  older versions only) and used in slice 7. `persist` has its final shape now, `persist: { resume: "rerun" |
  "abandon" }` (resume required, Durable's wording), and is refused in this slice (`not supported before slice 6`)
  rather than silently kept in memory.
- `self.job(Job, { run, finish? })` in an object's factory: once per job name per object; returns `JobHandle`.
- The per-run state documents are Chord's: an internal keyed handle per job (named after the job, keyed by run id),
  separate from the author's own `self.state` handles, so an author may also use the same definition for a document
  of their own without "declared twice".

### Run records and `running`

- The job keeps its records on the owner (a map by run id, with the key index); records and state documents change
  only inside transactions on the owner's line. Two hooks on `Transaction`: staged record changes (create, outcome,
  delete, block, drop) adopted inside the commit step with the documents, and actions after the commit (start a
  `run`, settle waiters).
- `running` is a `Source` of its own (not a `Derive`: keyed documents publish nothing), marked changed in the commit
  step whenever a record or a run's state document changed, delivering the new list in that batch. Entries:
  `{ id, version, key?, args, state, phase: "running" | "finishing" } | { id, version, phase: "blocked", reason }`.
  An entry is a new object exactly when its record or its state document's value changed (cached per run by record
  and state value identity, never by record alone); the list is copied on change (O(unsettled runs)).

### Start

- `start(args, ctx, { key? })`: one transaction on the owner's line; resolves with a `Run` after the commit.
  `tx.start(job, args, { key? })` inside `self.tx` joins the transaction's other writes and returns a `Run` handle at
  once (a handle, not data from a draft); its `outcome(ctx)` waits for the run and rejects `released` if the
  transaction is discarded. So a caller can never miss a short run: the handle exists before the run can settle.
  `job.outcome(id, ctx)` waits by id for an unsettled run only (an id of a settled or unknown run rejects `gone`;
  documented).
- Order inside a transaction: check args; dedupe by key (an unsettled run with the key, including one started earlier
  in the same transaction, returns its `Run`; the args are not compared: a key names one run); concurrency: running
  plus finishing runs plus runs started earlier in the same transaction, **excluding the run whose `finish` this
  transaction is** (so `finish` can chain the same job at `concurrency: 1`); at the limit `unavailable/busy`; then the
  record and the state document (`initial()`, checked once per definition, R8/D3).
- `run` starts after the commit, outside the batch, after `self.tx` settled (an action after the commit). An `abort`
  between the commit and the start pre-marks the run's signal, so `run` starts aborted.
- A `start` reaches only a live object (methods and routines run only then). New error reason `unavailable/busy` (the
  error table; `PROTOCOL_VERSION` stays 1). Run ids: uuidv7.

### Run

- `run(args, ctx)` runs outside transactions. `JobCtx` = `Ctx` plus `jobId` and `state: { value; change(fn) }` (only
  when the job has a `state`; typed so).
- `ctx.state.change(fn)` takes **no context**: it is a transaction on the owner's line drafting only the run's
  document, under the owner's context without the run's abort signal, so changes made while `run` stops after an
  abort still commit. It is accepted while the run's invocation is live (until `run` settles) and refused afterwards
  with `released` (an invocation fence: it checks the run's invocation, not only the owner's liveness); it never
  recreates a retired document. Changes admitted before `run` settled commit before the outcome is recorded (line
  order), so `outcome.state` includes them.
- `run`'s abort signal fires on `abort(id)`, on the object's end and on `host.close`. A run that throws after its
  signal fired ends `failed { aborted, reason: "abort" }` (not `threw`); a run that returns after an abort keeps its
  result.
- `run` throwing (not aborted): `failed { threw, error }` and a `HostError` `job_failed { object, job, id, error }`.

### Finish

- When `run` settles: the outcome is recorded on the run (`phase: "finishing"`), and `finish(outcome, tx)` runs in
  one transaction; the same commit deletes the record and the key and retires the state document. Without `finish`,
  the commit only cleans up.
- `finish` throwing: nothing changes; retried with backoff (1 s doubling to 60 s), each failure reported
  (`job_finish_failed { object, job, id, error }`); after five consecutive failures the run becomes
  `blocked { reason: "finish_failed" }`: outcome, state and key kept, not counted for concurrency, retried on the
  next reload (slice 7); a later `start` with its key returns the blocked run (dedupe).
- `Run.outcome(ctx)` resolves with the outcome when `finish` committed (also without `finish`); a blocked run's
  waiters keep waiting (their own `ctx` ends the wait); a dropped run's waiters reject `aborted`; the object's end
  rejects them with its error.

### Abort, keep-alive, object end

- `abort(id)`: fires the signal of a running run; drops a blocked run (owner: no `finish`; record, key and state
  document go in one transaction; reported `job_dropped { object, job, id }`; waiters reject `aborted`); ignored for
  finishing runs and unknown ids.
- Keep-alive: running and finishing runs are a **count** on the object, not `Holder`s (they are not references, so
  they never appear in `host.references`). An object whose last reference goes while the count is above zero stays;
  when the count reaches zero with no holders, it ends as on its last release (after its type's `linger`). Blocked runs
  do not count: at that end they are dropped with a `job_dropped` report each. `host.activity.jobs` counts running
  plus finishing runs.
- Object end (revocation R11, `host.close`, the last release): runs' signals fire; the drain waits for `run`
  invocations like for calls (bounded by `closeTimeout`); no `finish`; outcomes, states and waiters end with the
  object (waiters reject with the object's end error).

## Messages

None: jobs and routines are host-local; `running` is ordinary state.

## Races

1. Two `start`s with the same key in one turn: the line serializes them; the second sees the first's record and
   returns its run.
2. A `start` at the concurrency limit while a run is finishing: finishing counts; `busy`.
3. `tx.start` in a transaction that is then discarded: no record, no run; the `Run` handle it returned rejects
   `released` from `outcome(ctx)`.
4. `ctx.state.change` after `run` returned but before `finish` committed: refused (`released`); the outcome's state is
   the state at `run`'s settle. A change made after `abort` while `run` is still stopping: commits (no run abort
   signal on it).
5. `ctx.state.change` in flight (waiting for the line) when `run` settles: it was admitted while live, so it commits
   before the finish transaction (line order); the outcome's state includes it.
6. `abort` while `finish` runs: ignored.
7. The object ends while `finish` waits for the line: the finish transaction is refused (`released`); nothing is
   reported as a finish failure (it is the object's end).
8. `finish` throws five times: blocked; a new `start` with the same key returns the blocked run; a different key
   starts a new run (blocked runs do not count for concurrency).
9. `on`'s source changes during the backoff after a throw: the call happens at once with the newest value.
10. A routine call throws while the object ends: the end wins; no restart, no report of the abort.
11. `sleep` with a huge delay and an abort: the chained timers are cleared.
12. A job's `run` calls `start` on the same job (recursion): allowed; a new run (it is a different key or none).
13. `finish` chains the same job at `concurrency: 1`: the finishing run is excluded from its own transaction's check.
14. Two `tx.start`s with the same key in one transaction: the second returns the first's `Run`.
15. A short run started with `tx.start` settles before the caller awaits `outcome`: the handle resolves anyway.
16. `abort` between the start's commit and `run`'s start: `run` starts with its signal aborted.
17. The last run settles on an object without holders: the object ends after its `linger`; a blocked run is dropped.

## Cost

| Work | Cost |
| --- | --- |
| `on` per change | the shared watch's frame; folded under a busy call |
| `start` | one transaction: an args check (compiled), a record and a document |
| `state.change` | one in-memory transaction on the owner's line (prepare, adopt, flush) |
| `running` per change | one entry replaced; the array copied (O(unsettled runs)) |
| `finish` | one transaction (finish's writes plus cleanup) |

## Carry-over taken

From `slices.md` "Slice 5": routine errors reported to `onError` with their own kind; W2b (`on` gets the acquisition
value first); C3 and C4 (decided); jobs and revocation (R11) and `host.activity.jobs`.

## Carry-over left (to `slices.md` in the same change)

- Slice 6: `persist: { resume }` built (record and state document in the owner's store; persisted only in `local`
  objects with empty params, P3, enforced at declaration); outcomes and abort requests persisted (a recorded outcome
  resumes only `finish`); the restart limit (five crash interruptions, persisted, clean closes not counted; whether a
  state change resets the count; what a clean close records); deferred persistence for state documents (flushed before
  the outcome is recorded); the `finish` failure count persisted; the job fingerprint stored with every record from
  the start; the run's start trace carrier stored (§29).
- Slice 7: the routine handover per object on reload (bounded by `closeTimeout`, calls not waiting for it); job
  `accepts` in use (args and result mapped forwards once per run; `blocked { version }` without an adapter or for a
  newer version); when an older run's state document may migrate while its old code still writes it, and an older run
  keeping its old handles valid until it settles; a native restart aborts running runs (`aborted`, reason `reload`)
  and `finish` runs on the new code; a `finish` in flight across a reload; run records and state documents belong to
  the object across attempts (documents belong to an attempt today); blocked runs retried on reload; a job declaration
  removed while runs exist; a job fingerprint over args, result and state (a schema change without a version bump); an
  `on` routine whose source failed and recovers after a provider reload.
- Slice 9: spans for routine calls and job runs.

## Tests

Every rule and race above, one `describe` per mechanism:

- `on`: first call with `[["r", value]]`; folding; no overlap; a throw reported, retried with `[["r", value]]` after
  the backoff, a change during the backoff calling at once, success resetting it; the watch survives a throwing
  handler; source `ended`/`retired` (no report) and `failed` (one report); native sources (`ref.state`); in a facet.
- `onLive`: return; throw and backoff, reset after a long run; abort without report.
- Helpers: `sleep` abort, chaining above 2^31-1 ms (fake timers), no timer left; `untilAborted`.
- Routines with the drain and `host.close`; a routine call admitted in the first turn next to a method call.
- Jobs, start: args check; dedupe (across transactions and twice in one transaction; different args, same key);
  concurrency and `busy` (running plus finishing; earlier starts in the same transaction; chaining the same job from
  `finish` at `concurrency: 1`); `tx.start` atomic with other writes; a discarded `tx.start`'s handle rejecting; the
  handle of a short run resolving; `outcome(id)` for unsettled, settled and unknown ids; `run` starting after the
  commit outside the batch; an abort before `run` starts.
- Jobs, run: with and without state; `state.change` fence (after settle refused; in flight at settle committed before
  the outcome; after abort while stopping committed; never recreating the retired document); throw after abort is
  `aborted`; throw is `threw` with `job_failed`; result after abort kept.
- Jobs, finish: outcome kinds; record, key and state document gone in the finish commit; retries with backoff,
  `job_finish_failed`, `blocked` after five; dedupe returns the blocked run; abort drops it (`job_dropped`, waiters
  `aborted`).
- `running`: entries per phase; blocked entries without args or state; an entry replaced on a state-only change; no
  walk of other runs; per-principal views (example 19).
- Keep-alive: an object without holders stays while runs run, ends after the last one (with `linger`), dropping
  blocked runs; `host.activity.jobs`; runs not in `host.references`.
- Object end: revocation and `host.close` mid-run (signals, drain, no `finish`, waiters rejected).
- Cost guards: args compiled once per definition; `running` touches only changed runs.
- GC: an ended object releases runs, documents and waiters; routines release their watches; `sleep` leaves no timer;
  dropped and finished runs leave nothing.

Examples: `18-routines.ts` (`on` with a retry, `onLive` with `sleep`), `19-jobs.ts` (the shell job with a throttled
state document, flushed in a `finally`, changes awaited or caught, `OutputBuffer` with its required bounds,
per-principal views, abort and a chained job).

## Size

About 900-1,200 source lines.

## Decided on the draft (owner, 2026-10-24)

1. Routines start right after the object went live, in the same turn; a method call admitted in that turn may run
   before the first `on` call.
2. `abort(id)` on a blocked run drops it: no `finish`, its record, key and state document go, reported
   (`job_dropped { object, job, id }`), waiters reject with `aborted`.
3. `running` carries every run's `args`; views filter (no opt-in).

Folded in from the spec reviews (`/tmp/s5-review-{astra,fable,opus,sol}.md`): routines in facets (design §16); `on`
over a never-throwing watch listener with its own backoff and a full value after a failure; no kind tag (resolution
at declaration); internal per-job state handles; records with transaction hooks and `running` as its own source;
`tx.start` returning a `Run` handle; dedupe and concurrency within one transaction and excluding the finishing run;
`run` started after the commit outside the batch, an early abort pre-marking it; `state.change` without a context;
throw after abort is `aborted`; `job_failed`; runs counted, not held, and the object ending when the last one settles;
`persist`'s final shape.
