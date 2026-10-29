# Dependency resolution in Chord v2: one model (decided, 2026-10-29)

Status: decided (owner, 2026-10-29); **built for slice 7a** (§1-4 and §6-11 without what installs and reloads add:
§1's `installing`, §4's install-end and reload wakes, §3.9's reload handover and §5's removal, versions and rollout
are slice 7b's; folded into `design.md` §3, §5, §6, §7, §17, §21's start barrier, §22; `slice-7a.md`). The draft
history below is kept as it was. Sources: the owner's direction
("park until resolved"; "no difference between local and remote resolution: a link going is like a plugin
unloading"), the reviews (`/tmp/dep-mechanism-*.md`, `/tmp/dep-graph-*.md`, `/tmp/barrier-*.md`,
`/tmp/model/review{1,2}-*.md`), the code at pi `358f7d46a`. **Owner** marks an open decision.

Draft 7 (round 6): (A) also retries in lockstep without finding the cycle (Fable); the probe's recovery after a
suppressed search becomes a choice between (B1) a re-search backoff for probes only (recommended) and (B2) a full
search lifecycle without timers, since `dead` notices alone need recovery state that eviction may not drop (Astra, Sol).
Causes are compared by value on wakes (Opus).
Round 7: a returned search is accepted while its initiator is parked, whatever its round (Astra: re-searches must not
invalidate searches under way); detection is eventual, not within one backoff period; the local walk stays (Opus).

Draft 6 (round 5): cycles across hosts become an owner choice between (A) the owner's slice 4b decision (simultaneous
starts across hosts time out, no probe message), narrowed to one deadline, and (B) the probe, completed with edge
tokens, no revisits, and `dead` notices back to the initiator (Astra: a check that dies silently can lose the only
search that survived dedupe). (A) turned out to either poll chains across hosts again or miss a ring of `waiting`
attempts, so (B) is recommended, pending its review.

Draft 5 (round 4, Sol's phantom cycle): the second round is replaced by a check along the recorded trail of
`(attempt, edge generation)` hops; a reported ring existed at one moment; probes grow with their path.

Draft 4 after round 4 (probe only): round numbers per attempt, forwarded only when newer than the stored one; probes
honoured on parent and route links, dropped on child links; completeness stated under an eventually stable graph; the
repair caveat broadened to any concurrent edge removal; a new edge generation resets confirmation; a bounded display
trail.

Draft 4 changes (round 3): the probe starts a fresh round on every new or changed wait edge (a ring closes at its last
edge, whose source finds it), keeps one seen entry per initiator, accepts only its current round, and states its
cost honestly; every host drops probes from untrusted links; local forwarding is iterative; no-placement remote
requests are re-placed when a host's first parent link connects; a cohort object that ends before its first outcome
settles the barrier; the last-good refinement is marked for the owner.

Draft 3 changes (round 2): remote types without placement keep today's fallback (here if served, else the parent);
hydration stays before parking; no copied `retryAt`; a dependency `ended` breaks its dependent; a reload's handover
binds new requests before releasing old ones; retry passes only to `broken` and `transient` blockers, once per
operation; `installing` re-evaluated at every install end (commit or rejection); a registry's last good value dropped
when one of its contributors leaves; the probe with round ids, bounded seen sets, edge-generation triggers, attempt
ids on every non-live answer and relays dropping probes from untrusted links; one cycle mechanism, local and remote.

## 0. The problem

The same situation, "what I need is not there", has five outcomes today, depending only on how it is declared:

| Declared as | Provider missing | Today |
| --- | --- | --- |
| `self.get(LocalType)` | no facet serves it | `self.get` throws, the factory throws: `broken` |
| `self.get(RemoteType)` | the worker does not serve it | the hold is refused `broken`; the dependent `transient`, polled 1-60 s forever |
| `self.registry(R)` | no provider | `transient`, woken at R's first value only |
| `self.registry(R)`, reader newer | | `broken` |
| a reload removes the type | | holders get `gone`: ended for good |

And the startup barrier deadlocks an acyclic graph across two hosts (Sol, `/tmp/dep-graph-sol-barrier.log`): S's eager
A needs W's B, B needs S's C; W's hold for C waits for S's whole `load`, which waits for A. Only `readyTimeout` ends it.

## 1. Requests and one resolver

- **A request** is what a reference stands for: type (or registry), params, principal, the consumer's contract version.
  Its holder makes it and owns it: an attempt (`self.get`, `self.registry`, keyed pins), a call (`ctx.get`), outside
  code (`host.get`, `host.hold`, `host.registry`), a link's peer (`hold`). **It ends only when its holder ends it** (the
  attempt ends, the call settles, `release()`, a getter gives up, the peer's link or origin closes, revocation, the
  holding host closes), never because its provider is missing, went away or does not fit.
- **The destination by address** (round 1): a `local` type goes here; a `remote` type goes to the address its
  `hostAddress` (computed from the consumer's own contract) gives: here if that is this host's address, whether served
  here or not, else over the route for that kind or the parent (design §3). Every `remote` type declares
  its `hostAddress` (owner, 2026-10-29: the optional `placement` of slice 3a is removed and the field renamed, and with it the fallback "here if
  served, otherwise the parent" and its re-placement at the first parent link). A hold arriving for an address that is not this host's is relayed or
  refused (`invalid/host_address`) as today; a relay never captures a hold because it serves the same name.
- **Then the selected provider is checked** (served, version or accepted version and fingerprint, `authorize`, the
  provider's own host-address check). Version checks never look at a same-name registration elsewhere.
- **The publication gate:** a request made on this host, or arriving on its links, before the host's first
  publication (§6) is not placed yet; it shows `loading` and is placed by the publication. The gate lasts only for the
  synchronous setups, never for activation, so it cannot deadlock.
- **Outcomes of the check:**

  | The check finds | Request |
  | --- | --- |
  | a fitting provider | bound (to the object here, or to the hold over a path) |
  | not published yet | unbound `unpublished`: `loading` |
  | nobody serves the name at its address | unbound `not_served`: `failed { waiting }` |
  | no fitting version, a fingerprint that differs at the same version, a host address the provider computes elsewhere (code skew) | unbound `version`: `failed { waiting }` |
  | the registry is served, but its first `compose` (or the reader's version mapping) threw | unbound `compose`: `failed { waiting }` |
  | the provider host is installing a revision and the hold does not fit its current code | unbound `installing` at the provider: `loading` |
  | the path has no link (a drop, a route resolving) | on the path: `loading` |
  | `authorize` refused, invalid params | `failed { broken, forbidden \| invalid }`, as today, never indexed |

  The unbound reasons that wait for a name (`unpublished`, `not_served`, `version`, `compose`) are indexed under it on
  the host that decided them: the consumer's host for a local request; the provider's host for a hold that arrived
  over a link (it already keeps such holds as refused: `remote/hold.ts`). `installing` is the provider host's own,
  re-evaluated at its install's end; `no_link` lives on the path, where the next link holds it again. Indexes drop an
  entry when its request ends; GC-tested.

## 2. States

`ref.state` keeps its four kinds; `FailureCause` gains one kind, `waiting`:

```ts
type RefState =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined }
  | { kind: "ended"; error: ChordError };

type FailureCause =
  | { kind: "transient"; error: ChordError }   // the object's own effect failed (an open, a follow): backoff
  | { kind: "broken"; error: ChordError }      // the object's own code, a cycle, or authority: retry() or a reload
  | { kind: "waiting"; error: ChordError };    // not the object's fault: no provider, no fitting version, a
                                               //   dependency failed; retryAt undefined, woken by an event
```

| The request is | `ref.state` | Calls |
| --- | --- | --- |
| bound, its object activating or parked with no failed blocker | `loading` | park, bounded |
| unbound `unpublished` or `installing`, or its path has no link | `loading` | park, bounded |
| unbound `not_served`, `version` or `compose` | `failed { waiting }` | reject at once |
| bound, its object failed | `failed` with the object's cause, as today | reject at once |
| bound, its object live | `live` | run |
| ended by its holder, revoked, or its host closed | `ended` | reject |

**Owner:** `waiting` as a new cause kind (Opus, Fable; recommended: the cause says "not your fault, an event will wake
you" and a UI can say what is missing) or no new kind: `transient` with no `retryAt` (Astra; today's wire already
carries a `transient` cause without `retryIn`, `remote-object.ts`), or `loading` with a diagnostic (Sol; parks every
call on a missing plugin for its full `readyTimeout`).

## 3. Dependents: parked until their dependencies resolve

A **dependency** is what an attempt declares and needs before it goes live: `self.get` (local or remote),
`self.registry`, keyed pins (`at(key)` on another object's keyed member). `self.follow` is the attempt's own step (its
attach runs Durable's code), not a dependency; a follower declares `retryOn` on the registry it reads the harness
through, or recovers by its own backoff.

1. **Order, as today up to the check:** the factory runs; persisted singletons hydrate (the object's documents, kept
   across attempts); the requests are made. The attempt is **parked** while any dependency is not `live` (hydrated):

   | Its dependencies | The dependent shows |
   | --- | --- |
   | any `loading`, none failed | `loading` |
   | any `failed` | `failed { waiting, "waiting for X: <X's cause>" }`, `retryAt` undefined; the message keeps the nearest blocker and the root cause within the 500-character rule |
   | one failed with `invalid/cycle` (a dependent off the ring) | `broken` with the same error: it would wait on a ring that never heals by itself |
   | one failed with `forbidden` (an `authorize` refused it: authority, §3.6) | `broken` with the same error: only `retry()` or a reload helps (slice 7a fix round 1) |
   | one `ended` (revoked, or its host closed) | `broken` with that error: the request cannot come back; `retry()` or a reload makes new requests (a guard: a dependency ends only with its holder's principal or host, so the dependent ends too; Fable) |

2. **The dependency check is the activation boundary:** once every dependency is `live`, the attempt runs its own
   steps (natives in order, follow attaches, member checks, derives), bounded by its own `readyTimeout` deadline, and
   goes live. A dependency that leaves `live` after the check is treated as after live (R18): the attempt goes on. This is
   R18's rule for live objects applied from the check on, not a rule of its own (owner, 2026-10-29: a dependency can
   go away at any point of an object's life; the object stays live, its calls through that reference meet its state). So a parked attempt holds no
   natives, and an attempt that opened natives is never parked.
3. **No timer while parked:** no dependency deadline, no backoff. The attempt's deadline is paused while parked (as
   eager migrations pause it) and resumes with the budget left.
4. **Wakes, one rule:** the dependent re-evaluates on every state change of any of its dependencies (live, loading,
   failed, a new cause compared by value, ended; Opus: otherwise a ring of waiting attempts passes its causes round and
   round), updating what it shows; it leaves parking when all are live. The factory never re-runs
   while parked. Wakes are coalesced per object and run after the batch that caused them; a change during the
   attempt's own steps or its teardown is remembered. (As built in 7a, with the parent's note 5: a change while the
   parked attempt checks or loads its pinned keys is remembered and checked again; after the dependency check, during
   the own steps, a change is ignored, §3.2's R18 rule.)
5. **Kept while parked:** its documents (the object's), its declarations and requests, its seal token; no natives.
   Ended with the object (its last holder; a host-lifetime object when its plugin is removed or the host closes).
6. **`broken` only for the object's own code** (a throwing factory, a derive throwing at activation, hydration,
   `migrate`, a document fingerprint mismatch, an `open` throwing `broken(...)`), **cycles** (§7) and **authority**
   (`forbidden`, an ended dependency).
7. **Retry passes on:** `ref.retry()` on a `failed { waiting }` object retries its `broken` and `transient` blockers,
   hop by hop (the existing `retry` message over links), once per retry operation (an id dedupes diamonds); `waiting`
   blockers pass it on; nothing else is touched. Retry of a `broken` or `transient` object starts a new attempt, as
   today.
8. **`retryOn`** wakes failed objects as decided in slice 8 (a value call retries a `transient` or `broken` object);
   while the object is parked `waiting`, a value call does nothing: its dependencies decide.
9. **Own-code reload of a parked object:** its plugin's reload replaces the parked attempt with the new factory's,
   as one handover: the new requests are made and bound first, then the old ones released (round 2, Astra N4: an
   unchanged dependency held only by this object must not end in between; today's `#activate` binds before
   `#releasePrevious`).
10. **After live, R18 unchanged:** a dependency leaving `live` leaves its dependent live.

## 4. Wakes: two events

| Event | Re-evaluates |
| --- | --- |
| **a target changes state**: a dependency's object goes live, loading, fails, gets a new cause or ends; a hold's `bound`, `loading`, `failed` arrive, also after a re-hold on a new link | the requests bound to it, and their dependents (§3.4) |
| **a name becomes usable, or an install ends, on a host**: a publication (`load`'s setups, a reload's commit, an install's commit) serves a type, a registry, a version; a registry composes or maps a value at a version; an install ends without a commit (rejected) | the unbound requests indexed under those names; the provider's `installing` holds; a refused hold re-runs its start and sends `loading`, then `bound` or `failed` |

No new message kind for wakes: `loading`, `bound`, `failed` and `retry` exist. The wire's `failed` carries the new cause
kind `waiting`.

## 5. Removal, versions, rollout

- **A reload that removes a type:** its objects end as today (natives close, reason `end`; callers rejected at once;
  handlers drain). Their requests are not ended: each becomes unbound `not_served` and binds again if a later commit
  serves the name.
  - **Locally:** a `Binding` whose target ended by removal becomes unbound and accepts a second `bind`: member sources
    re-bind by name (one frame from the last value, as on a restart), keyed pins re-pin, parked calls flush or
    reject, presence re-lists. The one new piece of machinery.
  - **Over a link:** a `failed` on a bound hold unbinds it (Fable: one message, one rule; the consumer applies it as
    `#startOver` plus `failed`); the provider detaches the hold's sources and drops its unsent pending ops and queued
    `bound`; the ack slots of `bound`/`state` messages already sent stay counted until their `ack` or the link's loss;
    calls in flight on it are rejected and free their slots once.
- **A reload that stops accepting a version** unbinds only the requests on that version (`version`); the object stays
  (its own plugin's reload still restarts it if it has natives, §21).
- **A type moved to another host kind:** the request carries the address its own consumer code computed; the old host
  answers `not_served`; the consumer's own reload makes a new request. No redirect.
- **A consumer whose code moves to a new version** releases its old request and makes a new one (today).
- **Rollout, without revision fields:** each host knows only its own install. A provider host that installs keeps
  holds that do not fit its current code `installing` (`loading`) and re-evaluates them when the install ends, by its
  commit or by its rejection. A provider host that is queued but not installing yet answers a mismatch `failed
  { waiting, version }` until its install commits and wakes it: a visible blip of at most one install, accepted (Opus).
  An install never waits for activations (a reverse-order rollout would deadlock); a host whose own install was
  rejected fails its own requests at once with the reason (design §21). The loader keeps its own duties (the desired
  code set, digests, serialized installs).
- **Old calls across a reload** follow §21 unchanged: a pure swap lets them finish on old handles; a native restart
  drains them first; a removal rejects their callers at once and drains the handlers. Calls are never resent.

## 6. Startup: publication, then first outcomes

1. **Publication:** `load` runs every facet's setup, then publishes all at once in one batch (types served,
   registries served and composed once, contributions in their tables), then wakes (§4) after that batch. Nothing
   activates inside it.
2. **No gate beyond it:** holds and `host.hold` wait only for the publication, never for the barrier. This ends the
   startup deadlock: W's hold for C binds as soon as S's setups published; B goes live, then A.
3. **The barrier** (**Owner:** (a) or (b); recommended (a), three reviewers of four):
   - **(a):** `load` resolves when every host-lifetime object of this `load` has a first outcome:
     `firstOutcome(o) = o.live || o.ownFailure || (o.parked && o.blockers.every((b) => !b.local || firstOutcome(b)))`,
     where `local` means executing on this host (an object here, a keyed pin still loading here), not the contract's
     kind. So `CodeMode → Harness` waits for the harness's outcome; a wait on another host or on a failed dependency
     ends the first pass. One `firstOutcome` signal per object, separate from the readiness dependents wait for (Sol),
     counted once, never reopened by retries. An object of the cohort that ends before its first outcome (its plugin
     removed, the host closing) settles its entry as ended; `host.close` settles the waiting `load` (Astra R3).
   - **What (a) promises:** every host-lifetime object on this host had its first try, and the contributions of those
     that went live are in their tables. **Not:** every tool that will arrive (a parked or slow contributor, tools found
     in `onLive`, MCP; Sol's probe `/tmp/barrier-sol-first-outcome.log`). What a first turn needs is p3's explicit
     admission check.
   - **(b):** `load` resolves after the publication; Chord adds `host.startup`, a watchable of the host-lifetime
     objects' first outcomes with their causes; the app decides (Fable). The same tracker, awaited by the app.
   - p2 today resumes its harness without waiting for all host objects (`apps/p2/src/hosts/worker.ts`), because its
     worker objects that need server types are reachable only after `control.ready()`.

## 7. Cycles (decided 2026-10-29: no probe)

On one host, cycles are found as today: at `self.get`, following the waiting edges of activating and parked attempts
(exact). Across hosts, a hold carries the activation chain it was made in, which finds every ring whose objects start
one after another. The remaining gap, a ring across hosts whose objects start at the same moment, is not detected:
without a dependency deadline it stays parked. It is made visible: an attempt parked longer than its `readyTimeout` on
a remote attempt that is itself only `loading` is reported once per parking episode as `HostError` `parked_long
{ object, waitingFor, since }`; nothing fails or retries. A cycle is a plugin bug; the guide gives plugin authors and
agents four rules: (1) a factory declares only what the object needs, never a type that needs it back; (2)
back-references and occasional lookups go into methods and routines (`ctx.get`); (3) data flows up through state and
registries, not mutual `self.get`; (4) host-lifetime objects on the server never declare worker types in their factory.

Rejected (owner, 2026-10-29): the probe (edge-chasing searches with a check along the recorded trail; seven review
rounds, `/tmp/model/review*-*.md`; complete only with a re-search timer or a full search lifecycle, the most intricate
code in Chord, for a plugin bug) and the slice 4b timeout narrowed (it polls chains across hosts again, misses a ring of
`waiting` attempts, and retries in lockstep without finding the ring).

## 8. Getters, holds, calls: one rule

- **`host.hold`** returns a reference at once; only invalid params throw (also before `load`). A missing local type
  gives `failed { waiting }` after the publication, `loading` before it.
- **`host.get`, `ctx.get` and `host.registry`** (owner, 2026-10-29, decision 2): resolve when live; wait while `loading`,
  `failed { transient }` or `failed { waiting }`, up to their `readyTimeout` (default 60 s, the caller's choice), then
  reject with the last cause; reject at once only on `failed { broken }`. On
  success, rejection or timeout their temporary wait goes; `host.registry` returns the `RegistryValue` with its
  ordinary watch ownership (no `release()`). A UI holds and shows `ref.state`; code that needs the object now gets it, with the
  patience it passes.
- **Calls** on a `loading` reference park, each bounded by the reference's `readyTimeout` from when it was made; on a
  `failed` one they reject at once with the cause; sent calls are never resent.

## 9. Registries

- The same resolver on one host: a reader's request for R at its version is bound while R is served and has a usable
  value at that version (composed; mapped by `accepts[old].value` for an older reader), otherwise unbound
  `not_served`, `version` or `compose`, or `loading` before the publication. Woken at every transition to usable
  (`#valued`'s first-value latch goes). S2's `broken` and S3's backoff go.
- **Version skew within one host:** a reload of the registry's plugin alone leaves other plugins' contributors and
  readers on their bundled versions; `accepts[old].contribution` and `.value` keep them working, unsupported
  contributions are left out and reported, unsupported readers are `waiting` (`version`).
- A registry waits for a value, never for a particular contribution (an empty table composes). After live, a later
  `compose` failure changes nothing for the reader: `.value` keeps the last good composition, **but only while every
  contribution it was built from is still in the table** (round 2, Astra N2): when one of them leaves (its
  contributor ended or was reloaded), the last good value is dropped and `.value` throws until `compose` succeeds, so
  it never hands out a native whose contributor ended. `compose` represents a missing contributor as a value.
- Registries stay host-local (contributions are in-process values).

## 10. Keep-alive, presence, revocation, jobs

- A request over a link counts once in `host.activity.references` from its arrival to its end, bound or unbound;
  presence (`host.references`) lists only bound references.
- Revocation ends the requests of a revoked principal, bound and unbound, at every hop; nothing revives them.
- `gone` stays only for revocation (a provider host closing closes its links and sends nothing; its consumers see a
  drop, `loading`, and hold again on the next link).
- Persisted job runs of a parked host-lifetime object are loaded with its documents; `run` and `finish` start only
  once it is live; the run count keeps the object as today.

## 11. Timeouts after the model

| Timeout or backoff | After | Why |
| --- | --- | --- |
| `readyTimeout` of an attempt | only its own steps; paused while parked | a slow dependency is bounded where it runs |
| `readyTimeout` of `host.get`, `ctx.get`, `host.registry` | kept | a caller gets an answer |
| `readyTimeout` of a parked call | kept | an action must not run long after it was asked for |
| identity backoff 1-60 s | only for the object's own `transient` failures | nothing else says the disk or network is back |
| dependency backoff, polling of refused holds | removed | recovery is an event |
| dependency deadline across links | removed | the simultaneous-cycle gap is a plugin bug, reported by `parked_long` |
| `parked_long` report | new: once per parking episode after `readyTimeout` on a remote attempt that is only `loading` | a diagnostic; nothing fails or retries |
| route backoff, heartbeat, `closeTimeout`, routine and `finish` backoffs, `linger` | kept | not dependency waits |
| rollout install timeout (not built) | a watchdog on the install only | never a deadline for dependencies |

## 12. What changes in the design

R18 (dependency failures `waiting`, no backoff, the deadline paused while parked, the dependency check as boundary,
wakes on every change, an ended dependency breaks), S2 and S3 (`waiting`, woken at every usable value), slice 8's
last-good rule (dropped when a contribution leaves), §3's destination table (by address; the publication gate), §6 (the
simultaneous-cycle gap: no probe, `parked_long`), §7 (`host.hold`, getters, calls), §21 (no `gone` on
removal; a dropped version unbinds only its requests; installs never await activations; rollout without revision
fields; the reload handover), the start barrier (R17, W6), `FailureCause` (+ `waiting`), `parked_long`. Unchanged: what an object's own code reload does (§21), R18 after live,
`retryOn` outside parking, `self.follow`'s R4, the call window and flow control, revocation, no client providers.

## 13. Decisions (owner, 2026-10-29)

1. The barrier: (a), `load` resolves at the first outcomes of this host's host-lifetime objects (§6.3).
2. Getters wait through `waiting` until their `readyTimeout`; calls on `failed` still reject (§8).
3. `waiting` is a new `FailureCause` kind (§2).
4. A pure swap whose new factory declares a dependency that is not there parks the object (its gate closes; holders
   see `loading` or `failed { waiting }`; calls park or reject); no overlap of old and new code (§21).
5. The last good registry value is kept only while every contribution it was built from is still in the table (§9).
6. Cycles across hosts: no probe; `parked_long` and four authoring rules (§7).

1, 3, 4 and 5 are the recommendations, taken when the owner said "just build this" (2, 6 decided in discussion).
