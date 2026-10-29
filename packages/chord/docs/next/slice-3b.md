# Slice 3b: surviving drops (spec, for the owner's approval)

Status: **approved (owner, 2026-10-22)**, after Astra's and Fable's spec reviews. Guiding rule (owner): simple, fast,
correct. The single source for building 3b, together with the feature map in `slices.md` (entries assigned to 3b),
`design.md` read in full (most relevant: §3 links, recovery and timeouts, §4, §6, §7 references, §8, §19, §22), the
decision log, the carry-over (L4, L5, L6) and the root `AGENTS.md` style section. Builds on L1 and slices 1, 2 and 3a
(`76b32ed2d`).

## What an app can do after this slice

```ts
const notes = host.hold(Notes, { session: "S1" }, ctx);        // a reference at once, not awaited
notes.state.value;                                              // { kind: "loading" }
const w = await notes.state.watch(ctx);                         // the current state, then every change
w.start(async (state) => render(state));                        // loading → live → loading (link dropped) → live …

await notes.add({ text: "milk" }, ctx);                         // parks while loading, sent once live
if (notes.state.value.kind === "failed") notes.retry();         // a Retry button

client.connect(newLink, { principal: { kind: "server" } }, ctx);  // after a drop: every reference re-holds

host.serve(Notes, factory, { linger: 5 * 60_000 });             // a just-released object stays warm for 5 minutes
```

## 1. Reference state (§7)

- Every reference has `ref.state`, a `NativeWatchable<RefState>` (in-process: it holds errors; open point 1):

  ```ts
  type RefState =
    | { kind: "loading" }
    | { kind: "live" }
    | { kind: "failed"; cause: FailureCause; retryAt: number | undefined }   // undefined: broken, no automatic retry
    | { kind: "released" };
  ```

  `ref.state.watch(ctx)` delivers the current state, then every change. On release the state becomes `released` and
  the watch ends `ended` (the end is the notification; a native watch drops undelivered frames when it ends).
- **One rule for both sides:** a reference is `loading` while its object is activating or retrying, while it waits for
  `load` or a parent link, and while its link is down; `failed` while its object is failed and no attempt runs; `live`
  when bound; `released` once released. `variant` is `undefined` before the first binding and keeps the last bound
  variant while `loading` or `failed`.

  | State | Calls | State members |
  | --- | --- | --- |
  | `loading` | park (section 3) | readable: the last value; before the first binding a read throws `not_ready` and a `watch` waits for the first value |
  | `live` | run | readable |
  | `failed` | reject at once with the cause's error | reads throw the cause's error; existing watches stay open |
  | `released` | throw `released` | reads throw `released`; watches end `ended` |

- Member watches survive `loading` and `failed` (reference states): they get the next frame when the reference is live
  again. They end only when the reference is released, the member itself fails (W1, `failed`), or the member is not in a
  newly bound variant (`ended`).
- **Retry** (open point 2): `ref.retry()` asks the object for an attempt now, skipping the backoff window and renewing a
  broken object's readiness (carry-over L5); one attempt runs at a time, so a retry during one is ignored. Local: the
  object's `attempt()`. Remote: a new message `retry { hold }`; the provider does the same for the held object, for all
  its holders. On `live` and `released` references `retry()` does nothing; without an open parent link the next
  `connect` re-holds anyway.
- **Attempt notice** (open point 2): when a failed object starts a new attempt (backoff, retry, or a dependency going
  live), its holds get `loading { hold }`, so remote references move `failed → loading` and park calls exactly like local
  ones. `failed { hold, cause, retryIn? }` carries the remaining delay of the provider's window (`until - now`, from a
  new `until` on slice 2's backoff entry, carry-over L4) as advice for `retryAt`; the attempt itself is announced by
  `loading`.

## 2. Acquiring: `hold` and `get` (§7)

| Situation | `host.hold(Type, params, ctx, options?)` | `host.get(…)` |
| --- | --- | --- |
| invalid params, a local type not served here, no principal for a same-host remote type | throws at once (made before `load`: `failed` broken once `load` resolved, since the types are known only then) | rejects at once |
| before `load` resolved, or no parent link yet (remote) | `loading` | waits |
| the object activates | `loading` | waits |
| a transient failure | `failed` (with `retryAt`), then `loading` on the next attempt | waits; at its deadline it releases the reference and rejects with the last cause |
| a broken failure | `failed` | releases the reference and rejects at once with the cause |
| the link drops before the first binding | `loading`, re-held on the next `connect` | keeps waiting within its one deadline |
| live | `live` | resolves |
| the caller's context is aborted | (no effect on a `hold`) | releases the reference and rejects |

A `hold` follows its object until released and never rejects. A `get` has one deadline (`readyTimeout`, per get) from
the moment it is called, across reconnects.

## 3. Parking (§3, §7)

- A call made on a `loading` reference is queued with its own deadline, measured from the moment it was called (a
  reconnect never renews it). When the reference goes `live`, queued calls are **sent** in the order they were made,
  before any later call (a new call cannot overtake queued ones); their completions may arrive in any order. When the
  reference goes `failed` they reject with the cause; at its deadline a call rejects `unavailable/park_timeout`; the
  caller's cancellation rejects it at once; release rejects them `released`.
- A queued call is resolved against the binding it is sent on: after a reconnect that bound another variant, a method
  the new variant lacks rejects `invalid/member`; indexes are taken from the new binding.
- Calls already **sent** when the link drops fail `unavailable` (never resent, §7).
- **The park deadline is `readyTimeout`** (owner, 2026-10-22; C13's two host timeouts stay): a queued call waits at most
  the reference's `readyTimeout` (host default 60 s, per `get`/`hold` override), then rejects `unavailable/park_timeout`.

## 4. Link drops and re-holds (§3 recovery, §4, §22)

- **One owner of remote objects across links:** the host keeps its remote references (their objects) independent of any
  one link; each `connect` creates a link with fresh id counters (ids are link-local) and re-holds every non-released
  remote reference on it; a closed link's tables are dropped, and nothing of an old link (a late callback) touches the
  new one.
- **On a drop:** every non-released remote reference goes `loading` (also a `failed` one), sent calls fail
  `unavailable`, new calls queue. `host.connect(link, …)` may be called again once the previous parent link has closed
  (open point 6); while one is open it throws.
- **The re-hold:** a new `hold` (new id); on its `bound`, in **one batch** of this host and before any queued call is
  sent: each member of the bound variant gets the snapshot value with one frame `[["r", value]]` and a fresh Delta
  decoder (open point 4); members not in the bound variant end (`ended`, derives over them fail); new members get their
  first value; failed members listed in `bound` fail (W1); `variant` is updated. A different variant is the normal result
  of a changed grant (design §4: reconnect, authenticate anew, re-hold). Then queued calls are sent.
- **The provider side** is unchanged: a closed link releases its holds (objects with params end with their last
  reference unless they linger, section 5); a reconnecting child is a new `accept` with new holds.
- **References a host's objects hold** (`self.get` of a remote type) go `loading` the same way; a **live** dependent
  stays live (R18: a dependency leaving `live` does not change it) and its calls through them queue. An **activating**
  dependent keeps waiting for the dependency; its own `readyTimeout` bounds it (slice 2), and R18 retries it on `bound`.
- Who reconnects is the app (its link adapter calls `connect` again); Chord only re-holds.

## 5. `linger` (§3, §6, §19, D8, C7)

`host.serve(Type, factory, { linger })` (milliseconds, default 0): a **live** object with params whose last reference
is released stays live for `linger`, keeping its own dependencies; a `get`, `hold` or arriving `hold` message within
that time reuses it; otherwise it ends. An object that is waiting, activating or failed when its last reference goes
ends at once (slice 2). A failed state member is not a failed object and does not end a lingering one. `host.close`
ends lingering objects at once. Host-lifetime objects (`local`, empty params) never end by references; a remote type
with empty params lingers like any other.

## Races (listed before sizing)

1. A sent call when the link drops: fails `unavailable`, never resent.
2. A call made while `loading`: queued with its deadline; sent once live, in order; `park_timeout`; cancellation;
   release.
3. A reference released while `loading` (no link): nothing sent; not re-held; queued calls reject `released`.
4. `connect` while the previous parent link has not finished closing: throws.
5. A drop during a re-hold's handshake or before its `bound`: stays `loading`; the next `connect` re-holds again.
6. The re-hold finds the object failed: `failed` with `retryIn`; the provider's next attempt sends `loading`, then
   `bound` when live.
7. A reconnect creates a fresh object (the old one ended without linger): new snapshot; the old in-memory documents are
   gone (documented).
8. A get or an arriving `hold` within `linger` versus the linger timer: a reuse cancels the timer; the holder count
   decides, so an expiry never ends an object that has a holder again; no grace period.
9. A failing object without references ends at once, never lingers; the last release during activation ends it.
10. `host.close` with queued calls and loading references: queued calls reject `released`, references go `released`.
11. `ref.retry()` during an attempt or a pending re-hold: ignored.
12. Shared remote retry: two consumers hold one failed object; one retries; both get `loading`, then `bound` or
    `failed`.
13. A broken object held by another consumer: a `retry` renews it for everyone.
14. A reconnect binds another variant (a changed grant): replicas rebuilt in one batch; vanished members' watches end;
    queued calls checked against the new variant.
15. A release or a call's deadline while a snapshot is being adopted or queued calls are being sent: the reference's
    state decides at each step; nothing is sent for a released reference.
16. A member `watch` before the first binding: waits; rejects on `failed` (cause) or release.
17. A re-hold arrives while the previous instance (released by the drop, no linger) still tears down: waits for that
    ending (slice 2), then a fresh object.
18. An activating dependent whose remote dependency's link drops: it fails transient at the drop (the dependency's
    pending outcome rejects `unavailable`); R18 retries it when the dependency is bound again.
19. A drop while `failed`: `loading`, re-held on the next `connect`.

## Cost per hop

Nothing changes for live references (calls, commits, frames as 3a). A drop costs one `hold` and one snapshot per
reference on reconnect; a queued call holds its arguments until sent; `ref.state` is created lazily on first access.

## Benchmarks

Extend `test/next/bench/links.ts` (both codecs): reconnect with 1 and 100 references (time to all live, bytes), 1,000
queued calls flushed on reconnect (time, order), and the live paths of 3a unchanged (regression rows).

## Carry-over taken by this slice

L4: `retryAt` (backoff `until`). L5: `ref.retry()` renewing a broken object's readiness; calls on a failed reference
reject with its cause; C8. L6: `linger`, `ref.state`, `ref.retry()`, `host.hold`. Moved out: a second `bound` as a reset
(slice 4 for `reset` after overflow, slice 7 for restarted objects); the park deadline's per-type override is not
built.

## Tests

- `ref.state`: every transition for local and remote references, watched (first value, each change, the end on
  release); `variant` before, during and after bindings.
- `hold` and `get`: every row of the table in section 2.
- Parking: queue order, one deadline across reconnects, cancellation, release, failure, a variant change.
- Drops and re-holds: references go loading; sent calls fail; reconnect re-holds with fresh ids; one batch per bound
  with `[["r", value]]` frames; another variant on reconnect; old-link callbacks never touch the new link.
- Retry: local and remote; shared across consumers; broken renewed; ignored during an attempt; `loading` notices.
- `linger`: reuse within the window, end after it, only live objects linger, failed members do not end it,
  `host.close`, reconnect within linger keeps in-memory documents.
- Every race above, both codecs where a link is involved.
- GC: a released `hold` reference, a reference across a drop, a closed link's tables, a lingering object after expiry.
- Examples: `10-drops.ts` (drop, park, reconnect, re-hold, `ref.state`), `11-linger-and-retry.ts`.

## Decided with the owner (2026-10-22)

`ref.state` is a `NativeWatchable<RefState>` (the `NativeWatchable` interface joins `Watchable` in `src/watch.ts`,
upstream first); remote retries use two new messages, `retry { hold }` and `loading { hold }`; parked calls wait at most
`readyTimeout` (no third host timeout); a re-hold replaces each member with `[["r", value]]`; C8 (`state: false`) is
cut; `connect` may be called again once the previous parent link has closed; `host.root` moves to slice 8.

## Size

About 1,100-1,400 source lines (reference state, acquisition, parking with its queue, re-holds with variant changes,
retry and loading notices, `linger`).
