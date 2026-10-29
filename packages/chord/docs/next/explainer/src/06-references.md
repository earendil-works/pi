
# Holding On {#references lede="References, the object lifecycle and ctx: what a caller sees while objects start, fail, restart and move, and why nobody writes retry code."}

A tab shows the notes of S1 for an hour. During that hour the laptop sleeps, the worker is stopped for idleness and
started again, the notes plugin reloads twice and the store's storage hiccups once. The panel should show the notes the
whole time, say "reconnecting" when it cannot reach them, and recover by itself. In Chord this is what a
**reference** does; plugin code contains no retry loops and no request ids.

## Three ways to hold

| Where | API | Released |
| --- | --- | --- |
| a factory | `self.get(Type, input)` | when the object ends |
| a call | `await ctx.get(Type, input, { state? })` | when the call ends |
| outside objects | `await host.get(Type, input, { signal, state?, parkTimeout? })` | `ref.release()` |

Use `self.get` for what an object needs its whole life (the view's store), `ctx.get` for what one call needs, and
`host.get` only in UI code, tests and entry points. `{ state: false }` binds for methods only, without receiving state.
A reference keeps its object alive while held.

## The object lifecycle

```text
(get) → activating → live → ending → ended
             └→ failed (backoff) → activating …
```

**Activating:** Chord binds the declared references and waits until they are live and hydrated, loads singleton
documents, opens natives (one after another, in declaration order), computes derives and starts routines. The object
goes live when all of that succeeded. Calls wait behind its **gate** until then.

**Ending:** routines stop, the object's calls and jobs are aborted as their rules say, natives close in reverse order,
references are released. An object with `lifetime: "referenced"` (the default) ends when its last reference goes,
after the type's `linger` if it has one. A `lifetime: "host"` object (only for types without a required input) lives
as long as the host. A running, finishing or blocked job counts as a reference (chapter XI).

## `ref.state`

Every reference reports what is going on as a tagged value; listeners get each new one:

```ts
type RefState =
  | { kind: "loading" }                                                // first hold, reconnecting, restarting
  | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined } // undefined: no automatic retry
  | { kind: "released" };
```

| Situation | Calls | Values |
| --- | --- | --- |
| link drop | park until reconnected | readable, `loading` |
| object loading or restarting | park until live | readable, `loading` |
| rollout: provider ahead or installing | park until installed | readable |
| object `failed` | reject at once with the cause | `failed`, with cause and `retryAt` |

Values stay readable through all of this: the panel keeps showing the last notes. Parked calls share one deadline (60
s by default, `parkTimeout` per `get`), then fail `unavailable`. Otherwise a call ends only through its caller's
signal; there is no per-call deadline. A call that was running on an instance that ends fails with an error and is
not resent: Chord cannot know whether it took effect.

**Errors look like disconnects.** A consumer handles a failed call exactly as a dropped link: show the error, let the
user retry. Work that must not run twice carries its own idempotency key as data (Durable's `requestId`, a job's
`key`).

:::steps | The worker restarts while a tab watches the notes
+++ Watching
The tab holds `Notes { S1 }`. `ref.state` is `live`; `notes.notes.value` has 40 notes.
+++ The worker goes away
The supervisor stops worker S1 (or it crashes). The server's IPC link to it drops. The server tells the tab that its
hold is gone; the tab's reference goes `loading`. The 40 notes stay readable.
+++ A click meanwhile
Ann's colleague clicks **Add**. The call **parks** on the reference; nothing is sent yet. The deadline is 60 s.
+++ Chord resolves again
Holds on S1 still exist, so Chord calls `route(Session).resolve({ id: "S1" })` again, with the per-address backoff.
The app forks a new worker: a new **incarnation** of `Session({ id: "S1" })`.
+++ Re-hold
The server re-holds every hold on S1 over the new link. The new worker activates `NoteStore { S1 }` (its notes load
from storage) and the views; it sends fresh snapshots. The tab's reference goes `live`.
+++ The parked call runs
The parked `add` is sent now and succeeds. The panel shows 41 notes. Nobody wrote recovery code.
:::

## Failure and retry

Any broken part fails the **whole** object: a half-working object could break rules that rely on its documents
changing together. Chord tags the cause by where it failed:

```ts
type FailureCause =
  | { kind: "transient"; error: ChordError }   // an open threw, a dependency was unreachable: automatic backoff
  | { kind: "broken"; error: ChordError };     // factory, derive, hydration or migrate threw: retried only by a trigger
```

**Transient** causes get a backoff per address: 1 s, doubling to 60 s; concurrent gets share one attempt; success
resets it. **Broken** causes would fail the same way again (a code bug, invalid data), so they are retried only by a
**trigger**: a plugin reload, `ref.retry()` (a Retry button), or a readable the factory declared with
`self.retryOn(...readables)`. Only an opener may declare its own failure broken, with `throw broken(error)`, for
example for invalid configuration. A failed reference stays held; on success it goes `loading`, then `live`.

```ts
host.serve(EnvConnection, ({ env }, self) => {
  const config = self.get(EnvConfig, {});                 // a facet or registry value, outlives the attempt
  self.retryOn(config.envs);                              // a config change retries a broken open
  const ssh = self.open(async ({ signal }) => {
    const c = config.envs.value[env];
    if (!c) throw broken(new Error(`unknown environment ${env}`));
    return connect(c, signal);
  }, (s) => s.close());
  …
});
```

`retryOn` sources must live independently of the attempt (facet documents, registry values); a member of one of the
object's own references is a type error, since it goes away with the attempt.

## Waiting for dependencies

An object whose references are not live yet stays `loading` and goes live the moment they are, bounded by
`readyTimeout` (60 s). The decision for the failure case (R18) is what makes recovery automatic:

:::sequence animate | Dependency recovery. The view fails transient with the store's cause, keeps its reference, and is retried the moment the store goes live.
actor tab "tab"
actor view "Notes { S1 }" blue
actor store "NoteStore { S1 }" accent
tab -> view: hold
view -> store: self.get (activation)
store -> store: open fails: disk not mounted
store --> view: failed (transient)
view --> tab: failed: transient, cause inside
note view..store: the view keeps its reference; its state is the retry trigger
store -> store: backoff retry: open succeeds
store --> view: live
view -> view: retried at once (backoff cancelled)
view --> tab: live
:::

A dependency that fails, or does not become live in time, fails the dependent **transient** with the dependency's
cause inside, never broken: the cause is the dependency's. The dependent keeps its references while failed, and Chord
uses their state as a retry trigger. Factory authors write `self.get` and know none of this. After an object is live,
a dependency leaving `live` does not change it: its calls that use the dependency get the dependency's error, or park
while it loads.

**Cycles are rejected** (Q5). If A's activation gets B and B's gets A, neither would ever lose its last reference.
Every object instance has a uuidv7 instance id; on one host Chord follows the waiting edges of activating objects, and
across hosts a hold made during an activation carries the chain of instance ids. A cycle fails the activation
`broken`, naming it ("A → B → A"), and keeps no references.

## No optional references

`get` has no `optional` flag. When a dependency's plugin may be missing, turn the dependency around: the dependent
owns a registry and the other plugin contributes to it. Radius uses forwards from the ports plugin, but ports is
optional, so radius owns `radius.forwards` and ports contributes its forwards; without ports the table is empty and
radius works (chapter XIII).

## `ctx`

Every call gets a `ctx` as its last argument:

| Field | Meaning |
| --- | --- |
| `signal` | fires when the caller cancelled or the object ended; pass it to everything you wait on |
| `principal` | the caller (remote types only) |
| `incarnation` | the calling host's incarnation, for calls that arrived over a link (chapter X) |
| `get` | references released when the call ends |
| `telemetry`, `trace(name, attributes, fn)` | the current span; a child span with a child `ctx` (chapter XVII) |
| `jobId`, `progress` | in a job's `run` (chapter XI) |

```ts
exportText: async ({}, ctx) => {
  const catalog = await ctx.get(Catalog, {});                     // released when the call ends
  const title = catalog.sessions.value[session]?.title ?? session;
  const res = await fetch(renderUrl, { method: "POST", body: render(title, list.value), signal: ctx.signal });
  return await res.text();
},
```

There are no code versions and no request ids in `ctx`. Durable's `Context` is the same module (`chord/context`):
`ctx` extends it, so passing `ctx` into pi-durable needs no conversion. Code outside objects gets a `ctx` from
`host.root(fn, { principal?, signal? })`; inside Durable tools it uses `chord(fn, context)` (chapter XIV).

:::note | Built so far
References, `ctx` and the lifecycle are layers L4 and L5. `ChordError` and `FailureCause` are specified in the L1
draft (`layer-1.md`), with codes `invalid`, `contract_mismatch`, `forbidden`, `gone`, `not_ready`, `released`,
`too_large`, `unavailable` and `aborted`, and a finer `reason` such as `invalid/args`.
:::
