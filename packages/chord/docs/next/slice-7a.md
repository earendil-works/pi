# Slice 7a: the dependency model (spec)

Status: **ready to build** (owner, 2026-10-29: the model decided, "just build this"). Slice 7 is split: 7a builds the
dependency model on what exists (one `load` per host, links, routes, relays); 7b builds reload and rollout on top of it
(removal, dropped versions, installs, own-code reloads, loader D).

Read in full before writing code: `dependencies/model.md` (the model as decided; its section numbers are cited below as
M§), `design.md`, `decisions.md` (the entries of 2026-10-28/29: "No client providers", "Every remote type declares its
placement", "`hostAddress` instead of `placement`", "Only hosts with an address serve remote types", "Getters wait
through `waiting`", "Cycles across hosts: no probe, a diagnostic", "The dependency model is decided"), `slices.md`
(slice 7's carry-over: 7a takes none of it unless named here; 7b takes the rest), the explainer
`dependencies/book.md` for the scenarios (its catalogs are test material).

## 1. Requests and the unbound index (M§1)

- Every reference is a request with one holder (attempt, call, outside code, a link's peer). It ends only when its
  holder ends it; never because its provider is missing or does not fit.
- The destination by address is built (`host/destination.ts`, slice 7a's predecessor commit `5ec241882`). Add: version
  checks only against the selected provider (no `#assertRoute` comparison with a same-name registration on the
  consumer's host); a local type not served here is no longer a throw at `self.get`/`host.hold`/getters but an unbound
  request.
- **The publication gate:** a request made on this host, or a hold arriving on its links, before the host's first
  publication is not placed: `loading`, placed by the publication. `pendingLoad` no longer gates `Hold.start` or
  `#hold` beyond the publication (it ends the startup deadlock: Sol's probe `/tmp/dep-graph-sol-barrier.log` becomes a
  regression test that passes with fake timers never advanced).
- **Unbound reasons** (M§1's table): `unpublished` (loading), `not_served` and `version` (`failed { waiting }`),
  `compose` for registries (`failed { waiting }`), `no_link` on a path (loading); `authorize` refused or invalid params
  stay `broken`, never indexed. Indexes per host by name (local requests; refused holds that arrived over links, kept as
  today's refused state in `remote/hold.ts`); entries removed when the request ends (release, call settled, getter gave
  up, `closed { origin }`, link close, revocation). GC tests.

## 2. States (M§2)

- `FailureCause` gains `{ kind: "waiting"; error }` (no `retryAt`). The wire's `failed` cause schema carries it; the
  pinned list and its test change; `PROTOCOL_VERSION` stays 1.
- The mapping of M§2's table: `loading` for activating, unpublished, no link (and `installing`, 7b); `failed
  { waiting }` for not served, version, compose, and a dependent whose dependency failed.
- A remote refusal for not served / version is `failed { waiting }` instead of `broken`; the provider keeps the refused
  hold (it does today) and the consumer never retries it by itself (no backoff).

## 3. Parked attempts (M§3)

- Order: factory, persisted singleton hydration (as today), requests made; the attempt is **parked** while any
  dependency (`self.get` local or remote, `self.registry`, keyed pins) is not live and hydrated. `self.follow` is not a
  dependency (its attach is an own step).
- What it shows: `loading` while blockers are only `loading`; `failed { waiting, "waiting for X: <cause>" }` (nearest
  blocker plus root cause, 500-character rule) when one failed; `broken` when one failed with `invalid/cycle` (off-ring
  dependents) or ended.
- **No timer while parked:** no dependency deadline, no identity backoff for dependency failures; the attempt's
  `readyTimeout` deadline is paused while parked (as eager migrations pause it) and resumes with the budget left. The
  identity backoff stays for the object's own `transient` failures only.
- **The dependency check is the boundary:** once all are live, the own steps run (natives, follow attaches, member
  checks, derives) under the deadline; a dependency leaving `live` afterwards is treated as after live (R18): the
  attempt goes on.
- **Wakes on every state change** of a dependency (live, loading, failed, a new cause compared by value, ended):
  re-evaluate what the object shows, leave parking when all are live; never re-run the factory while parked; coalesce
  per object after the batch that caused them; remember changes during own steps or teardown.
- **Retry passes on:** `ref.retry()` on a `failed { waiting }` object retries its `broken` and `transient` blockers hop
  by hop (the existing `retry` message), once per operation (an id dedupes diamonds); `waiting` blockers pass it on.
  A `retryOn` value call while parked `waiting` does nothing.

## 4. Wakes (M§4)

Two events: a target changes state (the requests bound to it and their dependents); a name becomes usable on a host
(in 7a: `load`'s publication serving types and registries, a registry's value turning usable at a version): the
unbound requests indexed under it, and refused holds, which re-run their start and send `loading`, then `bound` or
`failed`. No new message kind.

## 5. Startup (M§6)

- `load` runs the setups, publishes them in one batch (types, registries served and composed once, contributions),
  wakes after that batch, then activates host-lifetime objects.
- **The barrier, decision (a):** `load` resolves when every host-lifetime object of the load has a first outcome:
  live, failed by its own cause, or parked with no blocker that is a local object still without its first outcome
  (`local` = executing on this host, keyed pins still loading here included). One `firstOutcome` signal per object,
  separate from the readiness dependents wait for; counted once; an object of the cohort that ends before its first
  outcome settles as ended; `host.close` settles a waiting `load`.

## 6. Getters, holds, calls (M§8, decision "Getters wait through `waiting`")

- `host.hold` returns a reference at once; only invalid params throw (also before `load`); a missing local type gives
  `loading` before the publication, `failed { waiting }` after it, before and after `load` alike.
- `host.get`, `ctx.get`, `host.registry`: resolve when live; wait through `loading`, `failed { transient }` and
  `failed { waiting }` until their `readyTimeout`, then reject with the last cause and release; reject at once only on
  `failed { broken }`.
- Calls: park on `loading` (bounded, as today); reject at once on `failed`; never resent.

## 7. Registries (M§9)

A reader's request: bound while R is served and has a usable value at its version; otherwise unbound `not_served`,
`version` (S2's newer or unmapped reader: `waiting`, not `broken`) or `compose` (first compose or the version mapping
threw), `loading` before the publication. Woken at every transition to usable (`#valued`'s latch goes). The last good
value is kept only while every contribution it was built from is still in the table (decision 5): when one leaves,
the last good value is dropped and `.value` throws until `compose` succeeds.

## 8. Keep-alive, revocation, cycles (M§7, M§10)

- A request over a link counts once in `host.activity.references` from arrival to end, bound or unbound;
  `host.references` lists bound references only.
- Revocation ends the requests of a revoked principal, bound and unbound, at every hop.
- `gone` only for revocation (a closing provider host sends nothing, as today).
- **Cycles:** the walk at `self.get` on one host, through parked attempts too; the activation chains across hosts as
  today. Remove the dependency deadline (no fallback). Add `HostError` `parked_long { object, waitingFor, since }`:
  once per parking episode, when an attempt has been parked longer than its `readyTimeout` on a remote attempt that is
  itself only `loading`. The guide (host README) states the four authoring rules of M§7.

## 9. Not in 7a (7b)

Removal and re-serving of types (local re-binding of a `Binding`, a `failed` on a bound hold unbinding it, window
slots), a dropped accepted version, `installing` and install ends, own-code reloads and the parked-attempt handover,
pure swaps parking (decision 4), rollout, loader D. 7a's code must leave those paths possible, not build them.

## 10. Tests and cost

- One `describe` per mechanism; the four catalogs in `dependencies/book.md` (chapters XIV-XVII) are the scenario list:
  every row that 7a's scope reaches becomes a test (memory links; relays; fake timers where a test proves no timer
  runs). Must include: the startup deadlock without `readyTimeout`; a hold before the publication placed here, not via
  the parent; a missing local type on `self.get`, `host.hold`, `host.get` (waits, then rejects with the cause); a
  remote refusal kept and re-run when the provider's late `load` publishes; a parked three-level chain across hosts
  woken in order; wakes on every state change with causes updated; retry passing on through a diamond once; the
  barrier's first-outcome rule (CodeMode → Harness waits; a remote blocker ends the pass); a cohort object ending
  before its outcome; registries' waiting reader, wake after a provider arrives, last good dropped when a contribution
  leaves; keep-alive counting unbound holds; revocation of unbound holds; `parked_long` reported once; GC tests for the
  indexes and a parked chain released from the top.
- Benchmarks (the bar of "The performance and memory bar"): calls, activation churn, a watched derive, links against
  HEAD, pinned, alternating, a HEAD copy at a path of the same length; results in `benchmarks.md`.
- Examples: `31-parked-dependencies.ts` (a missing provider arrives; causes shown; no timers), `32-startup.ts` (two
  hosts that would have deadlocked).
- Docs: fold the model into `design.md` (§3, §6, §7, §17, §21's 7a parts) in the same change as the build; mark
  `dependencies/model.md` as built for 7a.
