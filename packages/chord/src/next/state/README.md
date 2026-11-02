# state

Watchables (JSON and native), derives, writables and the batch: how values change, are computed from each other and
reach their watches.

## For apps (`index.ts`)

```ts
import { constant, mapShared } from "./index.ts";

const title = mapShared((note: Note) => note.text.slice(0, 20)); // called once per new note object
const titles = self.derive([notes], ([n]) => title(n.list));
const info = constant({ dataDir: "/data" }); // a watchable that never changes
const watch = await titles.watch(ctx);
watch.start(async (call, ctx) => {
	if (call.kind === "failed") return showError(call.error); // the watch stays open
	render(call.value);
});
```

- `Watchable<T>` (from `src/watch.ts`): `value` and `watch(ctx)`, which returns Chord's `WatchHandle`: the value at
  acquisition, then one call `(call, ctx)` per batch that changed it, in order, while the listener keeps up; batches
  that arrive while it is busy fold into its next call (the newest value, the ops since its previous call, folded by
  Delta's `PendingOps`). A call is `{ kind: "value", value, ops, retired }` or `{ kind: "failed", error }` (the source
  cannot compute its value now: the watch stays open, `watch.value` keeps the last value, the next value arrives as
  `[["r", value]]`). Values are JSON. A watch ends only for good (its owner ended, `stop()`, an aborted context, a
  throwing listener).
- `constant(value)`: a watchable that never changes; a state member or a derive source.
- Native sources (`NativeWatchable<T>`, W4): in-process values compared by identity, never ops, never state members (a
  factory returning one fails `broken`, Q14): `self.writable(initial)`, a registry's composed value
  (`self.registry`, `registries/`), and `ref.state`. They are derive sources (`self.derive([writable, doc], …)` takes
  both kinds; the result is JSON) and `on` sources. A watch gets one call per batch that changed the value, each new
  value in order; a failure (a registry whose `compose` threw) is one `failed` call per episode, the watch stays open.
  `observe(observer, ctx)` attaches a synchronous observer (Durable's shape: `advance(call, ctx)` inside the batch,
  record only; `end(end)`), which counts as watching. `ref.state` gives every state to its watches, not one per batch.
- `Writable<T>` (`self.writable(initial)`): `set(value)`; the same value (by identity) notifies nobody and costs one
  comparison; inside a batch it is marked there, outside it opens its own; inside a derive compute or a `compose` it
  throws `invalid/reentrant`. It belongs to its attempt: `set` after the attempt's end throws `released`, its watches
  end `ended`, its value stays readable.
- `mapShared(f)`: maps an array, calling `f` once per object element (by identity) and reusing its result while the
  element stays the same object, so a derive over a list keeps unchanged parts identical and its diff cheap.

Rules:

- `self.derive(sources, compute)`: a derive has no name; errors name it by the member that exposes it, or by its
  position (`derive #2`). Its `compute` is synchronous and pure; it reads only its declared sources. A derive that
  throws fails only itself and the derives over it: their reads throw, their watches get one `failed` call per failure
  episode (a recompute that throws again is quiet) and stay open, and its owner reports `derive_failed` once per
  episode (not while its attempt activates: `activation_failed` covers that). It recomputes on every later change of
  its sources (and on a re-bind of a member it reads) and heals as soon as it computes a value: its watches get it as
  `[["r", value]]`, with `retired` when a source's document was retired during the episode.
- A watch opened on a failed source starts at its last good value and gets the failure as its first call, then the
  heal; a source that never had a value (a remote member failed since its binding) rejects `watch` with its error. An
  `on` routine over a failed source waits for its next good value; a value queued behind its busy call is dropped
  when a failure follows it.
- An unwatched derive computes only when read. Reading `.value` once does not make it watched.
- Inside a commit's adoptions and in any derive compute, `self.tx`, `watch`, `release`, `get`, `load` and `close`
  throw `invalid/reentrant`. A raw `constant(...)` belongs to no host, so its own `watch` is not checked; through a
  reference it is.
- A frame delivery that throws (a derive whose value is no JSON) is reported to `onError` as `delivery_failed`; the
  commit's other frames are still delivered. A throwing watch listener is reported as `listener_error`.

## For Chord's layers (`internal.ts`)

- `Batch`, one per host, reporting `BatchError`s (`listener_error`, `delivery_failed`; watches get `reportListener`):
  `commit(adopt, ctx)` runs a commit's adoptions, then delivers one frame per watched source they changed, then runs
  the flushes listed with `flushing(flush)` during it (a link sends one state message per batch, W1);
  `within(adopt, ctx)` adopts a change inside the commit running now, or as a commit of its own, or, while a commit's
  flushes send, as the next commit (presence and keep-alive counts: a departure found while sending lands there);
  `run(work)` sets the reentrancy flag (nested); `compute(work)` also marks a pure compute (derives, `compose`), in
  which `assertNotComputing(operation)` refuses changes; `assertOutside(operation)`; `count(counter)` counts derive and
  registry work on the host's metrics (`chord.derive.computes`, `chord.derive.diffs`, `chord.registry.composes`,
  `chord.registry.adapts`). `changed(source)` takes any `Delivered` (JSON or native source).
- `Source`: a changing value on a host (a singleton document, a derive, a replica) with its watches, subscribers and
  dependents (`Dependent`: derives, and member sources passing changes on to theirs). Subclasses call `changed()` when
  a commit changes them and implement `deliver(ctx)` (`publish` a value, `failWatches` a recoverable failure,
  `endWatches` for good). `openWatch(ctx)` is `watch` without the Promise. `subscribe(subscriber)`: a `Subscriber` (a
  hold over a link, a member source) takes the watch's own sink shape, `advance(call, ctx)` synchronously inside each
  batch that changes the source (a value or a failure call) and `end(end)` when the source ends; a subscriber counts
  as watching, so a derive it follows recomputes in the batch.
- `Derive`: declared with its raw sources; `attach(resolve, report)` resolves them at activation (and drops the raw
  list; `report` gets a failure of its compute, once per episode), `detach(error)` when its object ends (later reads
  throw `error` for good), `invalidate()` from its sources (a failed derive too: it recomputes on its next read).
- `Constant`: the class behind `constant()`. `DeriveSource` is a JSON watchable as Chord follows it (a state member):
  a `Source` or a `Constant`; `DeriveInput` is what a derive reads: those and `NativeSource`s.
- `NativeSource`: the base of native sources, what derives and registry tables read: `dependents`, `start()`
  (`NativeStart`: a value, or a failure with its last good value), `changed()` (inside a batch: marks the dependents)
  and `end()` (drops them and the batch). `FollowedSource` adds followers through the batch: `openWatch`, `observe`
  (its abort listener removed at the end), `subscribe(observer)` (Chord's own followers, also without a value:
  `retryOn`), `deliver(ctx)` (the new value when its followers have another, a failure once per episode; nothing is
  kept once nobody follows). `WritableSource` is the writable, its owner (`WritableOwner`) the attempt's context and
  seal check, let go when the attempt ends; `ref.state` (`host/`) is a plain `NativeSource` giving each state to its
  own watches.
