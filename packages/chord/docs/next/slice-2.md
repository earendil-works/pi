# Slice 2: failures and natives (spec, for the owner's approval)

Status: **approved (owner, 2026-10-22)**, after Astra's and Fable's spec reviews. The single source for building slice 2, together with the feature map in `slices.md`
(entries assigned to slice 2), `design.md` read in full (most relevant: §3 timeouts, §6 lifecycle and failures, §7
references, §13 natives, §21 start barrier), the decision log, the carry-over (L4 section) and the root `AGENTS.md`
style section. Builds on slice 1 (`src/next/state`, `documents`, `host`, committed `d8f5e67e6`) and L1.

## What an app can do after this slice

```ts
host.serve(Inbox, (_, self) => {
  const settings = self.get(Settings, {});
  const watcher = self.open(
    async (context) => watchDir(settings.dir.value.path, context.abortSignal),   // opened during activation
    async (w, reason) => w.close(),                                               // closed in reverse when the object ends
  );
  return { count: …, rescan: async (ctx) => watcher.value.rescan(ctx) };
});

host.serve(Remote, (_, self) => {
  self.open(async (context) => {
    const config = readConfig();
    if (!config) throw broken(new Error("no remote configured"));   // retrying is pointless: broken
    return connect(config, context.abortSignal);                    // a throw here is transient: retried with backoff
  }, (c) => c.close());
  return { … };
});

const host = createHost({ onError, closeTimeout: 30_000, readyTimeout: 60_000 });
await host.load(facets, ctx);          // resolves once every host-lifetime object is live or failed; failures reported
const inbox = await host.get(Inbox, {}, ctx);   // waits through transient retries up to readyTimeout
await host.close(ctx);                 // closes natives (reason "stop"); rejects with every close error
```

## 1. Natives (§13)

- `self.open(open, close, options?)` in a factory returns a handle (`Native<T>`). Its `value` is readable from the
  moment its own `open` resolved until its `close` starts (so a later opener and handlers during the drain can use
  it); before that it throws `not_ready`, after that `released`.
- `open(context)` receives a context whose abort signal fires when the attempt is abandoned (the object ends, the
  attempt times out). `close(value, reason, context)` with `reason: { kind: "end" } | { kind: "stop" } | { kind:
  "reload" }` (`end`: last reference gone or a failed attempt; `stop`: `host.close`; `reload` is used from slice 7);
  the close context's signal fires at the native's `closeTimeout`, so a slow close can stop its own work. `options.closeTimeout`
  overrides the host default for this native.
- **Activation order:** factory; singleton documents hydrated; references live; natives opened **one after another in
  declaration order**; members checked; derives computed; live. An opener may read documents, references and earlier
  natives, not derives (they are computed after the opens).
- **Closing:** in reverse order. Each close is awaited up to its `closeTimeout`; one that takes longer is reported to
  `onError` as a possible leak and the others continue. A throwing close does not stop the others: `host.close` collects
  every close error and rejects with them (`AggregateError`); an object ending in the background reports each to
  `onError`.
- **Abandoned opens:** a failed or abandoned attempt closes the natives already open (reason `end`). An `open` that
  resolves after its attempt was abandoned has its value closed at once, exactly once (reason `end`); an abandoned
  attempt never comes back to life. A later attempt opens every native anew.
- Facets cannot open natives (`FacetSelf` has no `open`). The two restart patterns of R16 (drain in the background,
  swap through a registry) are documentation in the host README; there is nothing to build.

## 2. Failures (§6)

- Every activation failure becomes a `FailureCause` (L1: `{ kind: "transient" | "broken"; error: ChordError }`,
  foreign errors wrapped by `asChordError`). The kind comes from where it failed, never from the error:

  | Where | Kind |
  | --- | --- |
  | factory throws; a singleton's `initial()` fails its schema; member check (incl. a native watchable as state, Q14); first derive compute; a dependency cycle (Q5) | broken |
  | an `open` throws | transient, unless it threw `broken(error)` (L1) |
  | the attempt did not become live within `readyTimeout` | transient: `unavailable` "did not become live within …" |
  | a dependency failed (R18) | transient: `unavailable` "A: dependency B failed", with B's error as its `cause` |

  A keyed document's first `initial()` runs inside a later transaction; a failure there fails that transaction, not the
  object.
- **Every attempt is bounded** by the host's `readyTimeout`: when it passes, the attempt is abandoned (openers'
  contexts aborted, open natives closed `end`, a late open closed at once) and fails transient. A hanging `open` can
  therefore never block an object or the start barrier.
- **What a failed object keeps:** only an R18 failure keeps the object's references (so the dependency's recovery can
  retry it); every other failure releases them at once (a cycle, a factory, an open, a derive). A failed object stays
  while anything references it (host-lifetime objects always); it ends with its last reference.
- **Retries.** One attempt per object at a time; a trigger arriving during an attempt is ignored. Transient: retried
  with a **backoff per identity**, 1 s doubling to 60 s. The backoff lives in a host map `identity → { delay, timer }`
  holding no object (the window is its timer); it is deleted on success, on a broken failure, or when a window has
  passed with no object left to retry, and cleared by `host.close`; while its object stays failed the entry keeps the
  delay for the next doubling. A get inside the
  window waits until `until` before the first attempt; a failed object without references is not retried
  (host-lifetime objects always are). Broken: no automatic retry and no entry; a new object after its end tries at
  once. In this slice a broken host-lifetime object stays failed until the host is recreated (reload, slice 7, and
  `retryOn`, slice 8, add triggers).
- **Dependency recovery (R18):** when a failed dependency goes live, its R18 dependents are retried at once (their
  backoff timers cancelled). On every retry the new attempt binds its `self.get` references **before** the previous
  attempt's are released, so a dependency held only by this object never ends between attempts.
- **Reporting:** every failed attempt is reported to `onError` (with the object's name and cause); gets waiting for it
  are rejected in addition (section 3).
- **The start barrier (§21):** `load` resolves when every host-lifetime object's **first** attempt has an outcome (live
  or failed); later retries never hold `load`. A facet setup that throws or a facet document's `initial()` failing its
  schema still rejects `load` (code errors).

## 3. Getting a failing object (§7)

- `host.get(Type, params, context, { readyTimeout? })` resolves with a live reference. Each getter has its own deadline
  (`readyTimeout`, host default, overridable per get) for its whole wait, including a wait for `load`; it is separate
  from the attempt's own bound. A broken cause rejects the getter at once with its error; a transient one keeps it
  waiting through retries until the object is live or its deadline passes, then rejects with the last cause's error
  (or `unavailable` if no attempt has failed yet). A getter whose deadline passes or whose context is cancelled
  rejects and releases only its own reference; it never cancels the attempt for other getters.

## 4. Ending with natives (§3, §6)

- When an object ends: its transactions are sealed at once (`self.tx` throws `released`); callers of its running calls
  are rejected `released` at once and the handlers' contexts aborted (slice 1); Chord keeps each running **handler's**
  own promise and waits for those to settle (the drain), bounded by `closeTimeout`; then it closes its natives in
  reverse order (a handler still running after `closeTimeout` sees its natives close; that is reported); its documents
  stay readable until its closes are done, then are dropped; then the rest as in slice 1.
- A new attempt or a new object for the same identity starts only after the previous instance's ending has finished;
  gets arriving meanwhile wait.
- `host.close(context)`: marks every object ended at once (every call on the host fails `released`, every `self.tx`
  throws), aborts pending opens (their late values are closed), joins endings already running in the background, then
  drains and closes object by object in reverse live order (a dependent before its dependencies), with reason `stop`;
  resolves when all are done, or rejects with the collected close errors.

## 5. Timeouts (§3, cut C13)

Host options with per-thing overrides: `closeTimeout` (default 30 s; per native), `readyTimeout` (default 60 s; per
get; also bounds each attempt). The call drain uses `closeTimeout` (no separate setting; the design's per-type drain
override is not built). Park deadline (slice 3), routine handover and `finish` retry (slice 5) and rollout install
(slice 7) come with their slices.

## Cost per hop

Commits and derives are unchanged. A call adds one set entry for its handler's promise (the drain needs it).
Activation adds one awaited open per native and one attempt timer; a failure adds one backoff entry; ending adds the
drain and the closes.

## Carry-over taken by this slice

From `carry-over.md` (L4): `broken()`/`openFailure()` used for opens; a native watchable as state fails `broken`
naming the member; the drain on ending; cuts C5, C6, C7, C13 decided here.

## Tests

- Natives: open order and access to earlier handles; `not_ready` before live; close in reverse with reasons `end` and
  `stop`; a slow close reported after `closeTimeout` and the others still closed; throwing closes collected by
  `host.close` (AggregateError) and reported to `onError` for a background end; a partly failed attempt closes what it
  opened; the opener's context aborted when the object ends while opening; facets have no `open`.
- Failures: each row of the table gives the right kind; the cause's error is a ChordError; transient retries follow
  the backoff (fake timers) and reset on success; concurrent gets share one attempt; a broken failure is not retried;
  a failed object ends with its last reference and its backoff entry expires; a get right after a failure waits for
  the scheduled retry.
- R18: a dependent of a failing dependency fails transient with the dependency's cause, keeps the reference and is
  retried at once when the dependency goes live; releasing the dependent releases the dependency.
- Start barrier: load resolves with a failed host-lifetime object, reports it to `onError`, and the object goes live
  on a later retry; a throwing facet setup still rejects load.
- Gets: broken rejects at once; transient waits and succeeds on retry; transient past `readyTimeout` rejects with the
  cause; per-get `readyTimeout`; a cancelled caller releases only its own reference.
- Ending: the drain waits for a running handler (its own promise, not the rejected caller's) before its native
  closes, bounded by `closeTimeout`; documents readable during closes; transactions sealed at once.
- Races: an open resolving after its attempt was abandoned is closed once; a get arriving while the previous instance
  closes waits and gets a fresh attempt; simultaneous retry triggers give one attempt; two getters with different
  deadlines; a dependency held only by a retrying dependent is not ended between attempts; `host.close` during a
  pending open, during a background ending, and with several objects in dependency order; a cycle releases its
  references.
- GC: a failed object (documents, dependencies, natives, callbacks) is collected after its last reference while its
  backoff entry still exists; the entry expires on its own.
- Examples: `06-natives.ts`, `07-failures.ts` (numbering continues from slice 1).

## Decided with the owner (2026-10-22)

- `ref.state`, `ref.retry()` and `host.hold` move to slice 3 (no app-held reference can be failed before then).
- `host.get` on a failing object and the start barrier as in sections 2 and 3; C13 as in section 5; C5: no natives in
  facets; openers take a `Context`; `close` gets a context aborting at `closeTimeout`.
- C7: `linger` is built in slice 3, with links. The plugin error shape is decided in slice 3, where errors first cross
  a link.

## Size

About 700 source lines (both reviewers: the attempt states, backoff map, drain and timers).
