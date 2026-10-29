
# Work That Outlives the Call {#jobs lede="Jobs: owned work started by a method that keeps running after its caller leaves, with cancel, dedupe and a recorded outcome."}

Importing a 50 MB text file into notes takes a minute. The tab that started it may close; the import must go on, be
cancellable, not run twice when the tab retries after a link blip, and its result must be recorded. A method cannot do
this (it dies with its caller), a routine is standing behaviour rather than a request, and a Durable task is for work
that must resume after a crash. Chord's form for it is the **job**, built in pi-durable's sandwich: **intent** (a
transaction), **effect** (anything), **outcome** (a transaction in the current code).

## Defining and running a job

```ts
// notes/worker.ts
const ImportJob = defineJob("notes.import", {
  version: 1,
  args: obj({ path: str() }),
  progress: obj({ lines: int() }),
  result: obj({ added: int() }),
  concurrency: 1,                                         // one import at a time per NoteStore
});

const ImportResults = defineState("notes.import-result", {
  schema: obj({ outcome: union([obj({ added: int() }), obj({ error: str() })]) }),
  version: 1, initial: () => ({ outcome: { added: 0 } }), keyed: true,
  checkpointWhen: () => true,
});

host.serve(NoteStore, ({ session }, self) => {
  const list = self.state(NoteList);
  const results = self.state(ImportResults);
  const imports = self.job(ImportJob, {
    run: async ({ path }, ctx) => {                                       // 2. effect
      let lines = 0;
      for await (const line of readLines(path, ctx.signal)) {
        await addNote({ id: `${ctx.jobId}:${lines}`, text: line, by: "import" }, ctx);   // keyed by job id
        ctx.progress({ lines: ++lines });
      }
      return { added: lines };
    },
    finish: async (outcome, tx) => {                                      // 3. outcome, current code
      (await tx.draft(results, outcome.id)).outcome =
        outcome.kind === "done" ? outcome.result : { error: outcome.error };
    },
  });
  return {
    …,
    imports: imports.running,                                             // live list of runs
    startImport: ({ path, requestId }, ctx) =>
      imports.start({ path }, ctx, { key: requestId }),                   // 1. intent (refined below)
    abortImport: ({ id }) => imports.abort(id),
  };
});
```

`defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })`; `progress` and the outcome
are typed by the schemas.

:::sequence animate | The job sandwich. The intent commits before anything runs; the effect runs outside any transaction; the outcome commits in the current code.
actor tab "tab"
actor store "NoteStore { S1 }" accent
actor run "run" "effect" blue
tab -> store: startImport({ path, requestId })
store => store: 1. intent: busy check, dedupe by key, commit
store --> tab: { id }
store -> run: start after the commit
run -> run: read lines, add notes (keyed by jobId)
run --> store: progress { lines } (throttled)
note tab..store: the tab may close here: the job counts as a reference
run --> store: settles: { kind: "done", result }
store => store: 3. record outcome, finish(outcome, tx), ack
:::

## The three steps

**1. Intent.** `job.start(args, ctx, { key? })` is shorthand for `tx.start(job, args, { key? })` inside a
transaction, which may contain other writes. The busy check (`concurrency`) and deduplication (the same key returns the
existing run) are atomic and in the same commit; `run` starts only after the commit. Run ids are uuidv7.

**2. Effect.** `run(args, ctx)` may do anything: processes, network, other objects. It writes no document itself; it
returns the outcome. External writes carry a dedupe key derived from `ctx.jobId` (above: note ids), so an interrupted
attempt cannot apply them twice. On a reload `run` keeps its old code.

**3. Outcome.** When `run` settles, Chord records the outcome in its own record, then calls the **current** code's
`finish(outcome, tx)` and acknowledges the run in the same commit. The outcome is tagged:

```ts
type Outcome<R> = { id: string } & ({ kind: "done"; result: R } | { kind: "failed"; error: "threw" | "aborted" | "lost" });
```

A throwing `finish` changes nothing and is retried with a backoff (1 s to 60 s), and after the next reload. `finish`
is optional and follows Durable's transaction rule.

## Dedupe ends with the run

Deduplication covers **unsettled runs only** (Q9). Once `finish` has committed, Chord drops the run's record and key
and releases its waiters' references; it keeps nothing beyond a run's lifetime. Dedupe after completion is the
owner's. Studio records which run a request started, in the same commit as the intent, and `finish` records the
result by run id (`ImportResults` above):

```ts
const Requests = defineState("notes.import-request", {
  schema: obj({ run: str() }), version: 1, initial: () => ({ run: "" }), keyed: true, persist: true,
  checkpointWhen: () => true,
});

startImport: async ({ path, requestId }, ctx) => {
  const prior = await requests.get(requestId);                  // read outside the transaction (R13)
  if (prior) return { id: prior.run };                          // started before, maybe finished long ago
  return self.tx(async (tx) => {
    const run = await tx.start(imports, { path }, { key: requestId });   // dedupes a concurrent retry
    (await tx.draft(requests, requestId, { tags: [SessionTag(session)] })).run = run.id;
    return { id: run.id };
  }, ctx);
},
```

Two concurrent retries both miss `prior`, but the key makes `tx.start` return the same unsettled run. The client
watches `imports` for progress and reads the result by run id once it is gone from `running`.

Why Chord does not keep completed runs itself: either 100,000 keyed imports would stay in memory forever, or a
retention limit would let a retried key rerun its effect. The owner knows which results matter.

## Watching, waiting, aborting

- **`running`** is a readable of `{ id, version, args, progress, phase }`. `phase` is `running`, `finishing` (outcome
  recorded, `finish` not yet committed) or `blocked` (with the reason). `concurrency` counts only active runs. The
  panel shows a progress bar from it.
- **Progress** is in memory, throttled and sent as deltas. For output, use `OutputBuffer` and `Progress` from
  `@earendil-works/chord/output`: bounded windows, adaptive throttling, no write amplification.
- **Waiting:** `start` returns a run with `outcome(ctx)`. The caller's abort ends only its wait, never the run.
- **Abort is a request:** `job.abort(id)` fires the run's `ctx.signal`; the run decides what it returns (a result
  that already arrived stays a success). A run that ignores the signal keeps its slot until it ends. `finish` runs in
  Chord's own context.

## Lifetime, persistence, revocation

**Jobs keep their owner alive.** A running, finishing or blocked job counts as a reference to its object, which ends
only once all its jobs are settled. Starting an import and closing the tab does not abort it. Unsettled runs also
count as activity for the worker's keep-alive.

**Revocation takes precedence** (R11). Revoking a principal ends its objects at once, whatever jobs remain; the jobs
get the abort signal and the normal close timeout. A job runs as its object's principal.

**Persistence:** jobs are in memory by default and gone with the process. `persist: true` (only for stable
identities) keeps the record: a run live at a crash ends `lost` at the next activation and `finish` records it.
Nothing is rerun automatically.

**Versions:** a run started under an older job version keeps its version; `finish` and `running` see it through pure
`accepts` adapters, and stored outcomes are never rewritten. A version bump without an adapter does not refuse the
reload: the old outcome is `blocked`, kept and reported until a later reload brings the adapter.

**Native objects:** a job in a native object ends `aborted` when the object restarts on a reload (chapter XV). In a
pure object it keeps running on its old `run` code.

## What is not a job

| Work | Use |
| --- | --- |
| request and response that may die with its caller | a method |
| input into running work (a pasted code, an approval) | a flow (chapter XII) |
| work that must resume after a crash | a Durable task |
| standing behaviour | a routine |

:::review | Review: jobs are the largest open simplification (#9, C3)
Decision #9 (deferred until login is ported): a login or a long relocation is a job whose state consumers want to
address and watch (`LoginFlow { id }`). Options: (a) jobs stay records inside their owner, watched through `running`;
(b) a job is an object of its own, addressed by its id, living until done. Separately, review round 3 proposed cut C3:
shrink jobs to a runner over documents (no job versions, `accepts`, `blocked`, `persist`) or move them out of the
kernel. Not decided. `chord-next-walkthrough.md` concept 17 still shows the older outcome shape `{ ok: true, result }`;
the design tags outcomes by `kind`.
:::
