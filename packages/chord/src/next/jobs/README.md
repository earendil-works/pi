# jobs

Jobs in memory (§15, slice 5): owned work a call starts that outlives the call, in Durable's sandwich: intent (a
transaction), run (any effect), finish (a transaction on the current code). Persistence is slice 6, reload rules slice
7.

## For apps (`index.ts`)

```ts
import { defineJob } from "./index.ts";

const ShellState = defineState("chat.shell.state", { schema: obj({ output: str() }), version: 1, initial: () => ({ output: "" }) });
const ShellJob = defineJob("chat.shell", {
	version: 1,
	args: obj({ command: str(), author: Author }),          // closed, JSON only: checked at every start
	result: obj({ exit: int(), output: str() }),            // not validated
	state: ShellState,                                      // optional: one document per run
	concurrency: 1,                                         // optional: running plus finishing runs per object
});

host.serve(ChatStore, (_, self) => {
	const entries = self.state(Entries);
	const shell = self.job(ShellJob, {
		run: async ({ command }, ctx) => {                  // outside transactions; ctx.jobId, ctx.state
			const out = new OutputBuffer({ maxBytes: 64 * 1024, maxLines: 2_000, retain: "tail" });
			const write = async () => { const text = out.snapshot().text; await ctx.state.change((d) => { d.output = text; }, ctx); return text.length; };
			const progress = new Progress(write, report, 100);   // the author throttles state changes
			try { return { exit: await runProcess(command, ctx.abortSignal, (chunk) => { out.push(chunk); progress.mark(); }), output: out.snapshot().text }; }
			finally { await progress.stop(); await write(); }    // the last output reaches outcome.state, after an abort too
		},
		finish: async (outcome, tx) => {                    // one transaction with the cleanup: only `await tx.*`
			(await tx.draft(entries)).list.push(entryOf(outcome));
			tx.start(notify, { text: outcome.args.command }); // chaining: atomic with this outcome
		},
	});
	return {
		shells: shell.running,                              // a JSON watchable: views filter it
		runShell: async ({ command, author, requestId }, ctx) =>
			(await shell.start({ command, author }, ctx, { key: requestId })).id,
		abortShell: async ({ id }) => { shell.abort(id); return null; },
	};
});
```

- `defineJob(name, { version, args, result, state?, concurrency?, accepts?, persist? })`: `args` closed (every object
  `additionalProperties: false`) and without `bytes()` (`running` carries them); `state` a singleton definition;
  `concurrency` a positive integer; `accepts` `{ [older version]: { args, result } }`, both functions, checked now and
  used from slice 7 on; `persist: { resume: "rerun" | "abandon" }` is refused before slice 6. Declarations fail with
  an `Error` naming the path (`chat.shell.accepts[2]: not an older version`).
- `self.job(Job, { run, finish? })` in an object's factory (not in a facet), once per job name: a `JobHandle`.
  - `start(args, ctx, { key? })`: one transaction on the object's line; resolves with a `Run { id, outcome(ctx) }`
    after the commit. Only a live object takes starts (`not_ready` before, `released` once it ended).
  - `tx.start(job, args, { key? })` inside `self.tx` (and in `finish`): the same, with the transaction's other writes;
    its `Run` at once. A discarded transaction's `Run` rejects `released`.
  - In order: the args checked (`invalid/args`; one compiled check per definition); a key of an unsettled run (one
    started earlier in the same transaction too, a blocked one too) returns that run, args not compared; at the
    `concurrency` limit (running and finishing runs plus earlier starts in the transaction) `unavailable/busy`; then
    the run (id uuidv7) and its state document (`initial()`). The run whose `finish` the transaction is counts for
    neither: `finish` may start the same job again, with the same key too, and gets a new run. A start that only
    dedupes commits nothing.
  - `outcome(id, ctx)`: waits for an unsettled run; a settled or unknown id rejects `gone`.
  - `abort(id)`: fires a running run's signal (before `run` started too: it starts aborted); drops a blocked run (no
    `finish`; its record, key and state document go; `job_dropped`; its waiters reject `aborted`); ignored for
    finishing runs and unknown ids.
  - `running`: one entry per unsettled run in start order, `{ id, version, key?, args, state, phase: "running" |
    "finishing" } | { id, version, phase: "blocked", reason: "finish_failed" }` (`state` only with a state
    document).
- `run(args, ctx)`: `ctx` is a handler's `Ctx` (the object's principal for a remote type, the host's for a local one;
  the host's incarnation; `ctx.get` released when `run` settles) plus `jobId` and, with a state document, `state: {
  value, change(fn, ctx) }`. Its abort signal fires on `abort(id)`, on the object's end and at `host.close`.
  `ctx.state.change(fn, ctx)`: a transaction drafting only the run's document, under `ctx` without its abort signal
  (the run's own ctx is fine), accepted while `run` runs (also after an abort) and refused `released/settled` once it
  settled; a change admitted
  before `run` settled commits before the outcome is recorded. Every change is a commit (and a message while watched):
  throttle and await or catch them.
- Outcomes: `{ id, args, state } & ({ kind: "done", result } | { kind: "failed", error })`, `error` being `{ kind:
  "threw", error }` (`run` threw: reported `job_failed`; anything but a ChordError or PluginError becomes a
  PluginError `internal` with its message) or `{ kind: "aborted", reason: "abort" }` (`run` threw after its signal
  fired; a result returned after an abort is kept).
- `finish(outcome, tx)` runs when `run` settled (`phase: "finishing"`); its commit deletes the record and the key
  and retires the state document; without `finish` the commit only cleans up. A throw changes nothing: retried after
  1 s doubling to 60 s, each failure reported `job_finish_failed`; after five in a row the run is `blocked`: outcome,
  state and key kept, not counted for concurrency, its waiters waiting (their own ctx ends a wait).
- `run.outcome(ctx)` resolves once `finish` committed; the caller's ctx ends only its wait, which then keeps nothing
  of it (no listener on its signal). A retained `Run` answers late waits from how the run settled; a rejection's error
  keeps its stack's receivers (the transaction that ended the run) until its `stack` is read (V8), as every error.
- Keep-alive: running and finishing runs keep their object alive (a count, not references: never in
  `host.references`); an object without references ends after its last run settles (after its `linger`), dropping
  blocked runs (`job_dropped`). A run is counted in its start's commit step, before the commit publishes (a link
  closing while it sends may release the last reference) and before any run of the same commit settles (a `finish`
  chaining another job keeps the object). A run started while the object lingers keeps it. `host.activity.jobs`
  counts them.
- The object's end (revocation, `host.close`, the last release): runs' signals fire with the end's error, the drain
  waits for `run` and a `finish` running then (bounded by `closeTimeout`; admitted before `run` runs, which may end
  its own object), nothing finishes after it (its commit is refused, not reported), waiters reject with the end's
  error; blocked runs are dropped (`job_dropped`), at every end. `running` then reads `released` and keeps no run.

## For Chord's layers (`internal.ts`)

- `Job`: one job of one object (an `Attempt` makes it for `self.job`). `live()` once the object is live, `seal(error)`
  when it ends, `end()` when its documents are dropped; `stage(tx, args, ctx, options)` is `start`'s and `tx.start`'s
  work inside a transaction. Its records change only in staged changes (`documents/`'s `Staged`): `create`,
  `outcome`, `delete`, `block`, `drop`, adopted in the commit step (a new run is counted there); the actions after the
  commit start `run` (queued, after the transaction settled), settle waiters, uncount runs and report. A job stages
  only when it records something (`Transaction.staged` reads what it staged so far).
- `JobOwner`: what a job needs of its object: label, host, caller, the object's context (without an abort signal),
  documents, `admit` (the drain) and `countRuns` (keep-alive and `host.activity.jobs`).
- Inside: `JobRun` (one run: record, phase, its current `Invocation`, `running` entry, the `Run` handle over its
  detachable waiters; an `Invocation` is one call of `run` with its own seal token, abort signal and join, captured by
  its ctx and its settling, so an invocation a seal replaced never writes or records for the next one), the
  run states (a keyed `DocumentHandle` by run id, apart from `self.state`'s, never drafted while absent) and `Running`
  (`running`'s list, copied per change; while watched it records the ops of each change, a run's state ops re-pathed
  under its entry, delivered as one frame per batch).

Persisted jobs (slice 6b): `persist: { resume: "rerun" | "abandon" }` in a `local` type with empty params. Each
unsettled run's record (`stored.ts`) is a document in `chord.jobs`, its state one in `chord.job-states`
(`persisted.ts`, `run-states.ts`); a run is reserved (`running`) before `run`, counted after a crash (five in a row end it
`restart_limit`), written back `stopped` by the close writer after the drain, resumed on the next live attempt (per
`resume`); the records load once per object, again only after a load failed, a record of another version or fingerprint
blocked before its state is decoded; `abort(id, ctx)` is stored and joins the current invocation;
`ctx.state.change(fn, ctx, { persistence: { kind: "deferred" } })` holds a change (its ops folded in a `PendingOps`) until
the next immediate one, the outcome, the close writer or its deadline (one timer per object).
