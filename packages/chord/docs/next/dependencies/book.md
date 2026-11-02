---
title: Parked Until Resolved: one model for dependencies in Chord v2
cover: Parked / Until Resolved
kicker: A design proposal · Chord v2 · slice 7 · 2026-10-29
subtitle: What happens when what an object needs is not there yet, is somewhere else, has gone away or does not fit, told through the scenarios that decide it
stats:
  - 5 → 1 | answers today to "the provider is not there"
  - 0 | deadlines on waiting for a dependency
  - 300+ | scenarios played through by four reviewers
  - 6 | decisions left for the owner
note: |
  A proposal, not a decision. It states the dependency model the redesign session drafted on the night of
  2026-10-28/29 from the owner's direction ("park until resolved"; "no difference between local and remote
  resolution: a link going is like a plugin unloading") and five rounds of review by Astra, Fable, Opus and Sol, who
  played more than 300 scenarios from p2's plugins and their own against it. The working document is
  `/tmp/model/model.md`; the reviews are in `/tmp/dep-graph-*.md`, `/tmp/barrier-*.md` and `/tmp/model/review*-*.md`.
  Code references are to pi `main` at `358f7d46a` (`packages/chord/src/next`). Notes marked *review* record a point
  the reviewers found or still disagree on; *Owner* marks a decision that is his.
colophon: Parked Until Resolved · first edition · 2026-10-29 · Chord v2 design proposal for slice 7
---

# Before we begin {.preface}

It is a Tuesday morning and Mario opens a session on his phone. The server starts a worker for it. The worker
connects to the server, loads its plugins and opens the agent's harness. One of the plugins, code mode, needs the
harness before it can contribute its tools. Another, search, needs a feed that lives on the server. A third, sharing,
was removed from the worker's plugin set last night, but the notes view still asks for it. At the same moment the
browser tab holds the session's notes, which live on the worker that is still starting.

Every one of these is the same question asked in different places: *what I need is not there yet; what now?* Chord
v2 answers it today in five different ways, depending on how the dependency was declared and where its provider
lives. A missing type on the same host breaks the object for good; the same type missing on another host makes it
retry every few seconds forever; a missing registry waits for a value; a reload that removes a type ends every
reference to it. And when two hosts start at once and need each other's objects in a chain that has no cycle at all,
both wait until a 60-second deadline breaks the knot.

The owner's direction was short: an object should be **parked until its dependencies resolve**, and there should be
no difference between a dependency on this host and one on another: a link going away is like the provider's plugin
being unloaded, and a link coming back is like it being loaded. This book works out what that means, rule by rule,
and plays it through the scenarios that decide whether it holds.

## Eight things to know

:::findings
1. **A request outlives its provider.** A reference stands for a request (type, params, principal, version). It ends
   only when its holder ends it, never because the provider is missing, went away or does not fit.
2. **One resolver for local and remote.** The address decides where a request goes; the provider found there is
   checked; a missing provider here and a missing provider on another host give the same answer.
3. **Two kinds of not-yet.** Something under way (activating, reconnecting, installing, not published yet) shows as
   `loading`; nothing under way (not served, no fitting version, a dependency failed) shows as `failed` with the new
   cause `waiting`.
4. **Dependents park.** An object whose dependencies are not all live waits with no timer and no backoff, and is
   woken by events: a dependency changing state, or a name becoming usable on a host.
5. **`broken` means the object's own fault.** Only its own code and cycles break an object; whatever it waits for is
   `waiting`.
6. **Startup needs one short gate, not a barrier.** Requests wait only for the host's facets to be published, which
   is synchronous; that ends the startup deadlock. Whether `load` then also waits for first outcomes is the owner's
   call.
7. **One gap in cycle detection needs a choice.** Objects on two hosts that start at the same moment and need each
   other are caught today only by a deadline. A probe can walk the waiting edges and find the ring without failing
   anything (recommended); a narrowed deadline is simpler but polls, misses a ring, or never finds the cycle at all.
8. **Only callers and own work keep clocks.** Getters, parked calls and an object's own steps keep their deadlines;
   waiting for a dependency has none.
:::

## Words used throughout

A **host** is one participant (the server, a session worker, a browser tab). A **provider** is what serves a type or
a registry on a host: a facet registered it with `host.serve`. A **request** is what a reference stands for: a type
or registry, its params, the principal it acts as and the consumer's contract version. Its **holder** made it and
owns it: an object's attempt (`self.get`, `self.registry`), a call (`ctx.get`), outside code (`host.get`,
`host.hold`) or a peer host (a `hold` arriving over a link). A request is **bound** when it points at an object (here)
or a hold (over a link), and **unbound** with a reason otherwise. An **attempt** is one try at activating an object:
its factory, its requests, its natives. A **dependency** is a request an attempt needs live before it may go live. An
attempt is **parked** while one of its dependencies is not live. A **publication** is the moment a host makes its
facets' declarations visible: the setups of `load`, the commit of a reload, the commit of an install. A **wake** is an
event that makes the resolver look at a request again.

The running example is a small p3: a server **S** with the session catalog and the search feed; a worker **W** for
session `S1` with the harness, code mode, the notes store and the search indexer; and a browser tab **T** that shows
the notes. The plugins are `core`, `models`, `codemode`, `notes`, `search` and `sharing`.

# Five Answers to One Question {#today lede="What Chord v2 does today when a dependency is missing, and why the answers disagree."}

Chord v2 was built slice by slice, and each slice answered "the provider is not there" for the case in front of it.
Slice 1 made `self.get` of a type nobody serves throw, because a typo in a type name should fail loudly. Slice 3b made
remote holds survive link drops, so a missing provider on another host became a refused hold that the consumer retries.
Slice 8 made `self.registry` a dependency that waits for a value. Each answer was reasonable alone. Together they
give five outcomes for one situation.

| Declared as | The provider is missing | Today |
| --- | --- | --- |
| `self.get(LocalType)` | no facet serves it | `self.get` throws, so the factory throws: the object is `broken` |
| `self.get(RemoteType)` | the worker does not serve it | the hold is refused `broken`; the dependent is `transient` and retried every 1 to 60 seconds, forever |
| `self.registry(R)` | no plugin serves `R` | `transient`, woken at `R`'s first value only |
| `self.registry(R)`, the reader newer than the provider | | `broken` |
| a reload removes the type | | every holder gets `gone`: ended for good |

The differences are not about the situation. Whether the notes plugin is missing on this host or on the worker, the
notes view cannot work until someone installs it. Yet in one case the view is broken until a reload, in the other it
polls the worker every minute for the rest of the session, and the reload that finally brings the plugin back cannot
revive a reference that got `gone`.

## The deadlock without a cycle

The startup barrier has a worse problem. Sol reproduced it against the current code (`/tmp/dep-graph-sol-barrier.log`).

:::sequence animate | The startup deadlock today. Nothing in the object graph is cyclic; the two barriers block each other.
actor s "server S" "load: waits for A"
actor w "worker W" "load: waits for BStore"
s -> s: setups: serve C; start eager A
s => w: A needs B: hold B
w -> w: setups: serve B; start eager BStore
w => s: BStore needs C: hold C
s -> s: Hold.start waits for S.pendingLoad
note s..w: S's load waits for A, A for B, B for BStore, BStore for C, C's hold for S's load
divider "60 s later"
s -> s: A's activation deadline fires, A fails
s --> w: C binds, BStore and B go live, A is retried
:::

`C` has no dependencies and is registered the moment S's setups ran. Its hold waits anyway, because incoming holds
wait for `pendingLoad`, and `pendingLoad` is the whole of `load`: the setups and the barrier that waits for every
host-lifetime object, `A` included. Two jobs share one promise. Holds only need the first ("are the types
registered?"); the second ("has every plugin had its first try?") is for the app. Mixing them makes an acyclic chain
across two hosts wait until a timeout fires.

## Timers standing in for events

Both problems have the same root. Where Chord does not know when something will change, it polls or waits for a
deadline: the identity backoff retries a dependent whose remote provider refused it; the activation deadline breaks the
startup knot; the same deadline is the only answer to two objects on two hosts that start at the same moment and need
each other, a cycle the activation chains cannot see (design §6, "Known limitation").

A timer is the right tool when nothing else can tell Chord that the world changed: a disk that may be back, a worker
process that may start this time, a silent transport. It is the wrong tool when an event exists or can exist. A
missing plugin comes back through a reload, which is an event on the host that serves it. A dependency going live is
an event. A link opening is an event. The model below uses those events and keeps timers only where no event can
exist.

# Requests That Wait {#requests lede="A reference is a request with a holder; it outlives every provider it meets."}

The first change is a separation the code makes only halfway today: between what a reference **asks for** and what
currently **answers** it. When the notes view on W does `self.get(NoteStore, {})`, it asks for "the NoteStore of this
host, as the host, at contract version 3". Which object answers is a second question, and the answer can change: no
object yet, an object activating, a live one, a failed one, none again after a reload, a new one after the next.

## A request and its holder

A **request** is the asking part: type (or registry), params, principal and the consumer's contract version. Every
request has exactly one **holder**, which made it and is the only one that ends it.

| Holder | Made by | Ends when |
| --- | --- | --- |
| an attempt | `self.get`, `self.registry`, a keyed pin `ref.notes.at(key)` | the attempt ends (its object ended, or a reload replaced it) |
| a call | `ctx.get` | the call settles |
| outside code | `host.get`, `host.hold`, `host.registry` | `release()`, or the getter gives up |
| a peer host | a `hold` arriving over a link | the peer releases it, or its link or origin closes |
| any of them | | revocation of its principal; its own host closes |

That list is the whole of how a request ends. **A request never ends because its provider is missing, went away or
does not fit.** Today it does in two places: a `self.get` of a type nobody serves throws before the request exists,
and a reload that removes a type sends `gone`. Both go.

## The address decides where

A request goes to one place, and the address decides which. For a `local` type, the place is this
host. For a `remote` type, the consumer computes the address from the params with its own contract's
`hostAddress` function (design §3; `placement` until 2026-10-29): `Notes { session: "S1" }` is placed on `Session { id: "S1" }`. If that is this host's
address, the request goes here; otherwise over the route for that kind, or over the parent link.

Until 2026-10-29 the code checked something else first: whether the type is registered here. A type placed on this host but not
registered yet was sent over the parent link, which is wrong twice. Sol's example: the server has address `Server`,
the catalog type is placed on `Server`, and no facet serves it yet. That code, `Placement.reference` (`host/placement.ts`, now `host/destination.ts`), sent the server's
own request over a parent link the server never had, and when the catalog plugin was installed later, nothing woke
that request, because it was never registered as waiting here. The rename removed the first half; slice 7 builds the
wait.

:::flow wide | The destination by address. The destination follows from the address alone; only then is the provider found there checked.
row "Where" accent
box addr "the request's address" "from the consumer's own `hostAddress`" accent
box here "here" "a local type, or this host's address"
box away "a route or the parent" "every other address" blue
row "Then" muted
box check "check the provider here" "served? fitting version? authorize, own host address"
box hold "hold over the path" "the provider host checks it the same way" blue
arrow addr -> here
arrow addr -> away
arrow here -> check
arrow away -> hold
:::

The rule, from the reviews (Sol B1, Astra F1): the destination never depends on what is registered when the type names an
address. A request placed here whose provider is missing is **unbound here**, waiting for the name. A version check
compares the consumer with the provider actually selected, never with a same-name registration on the consumer's own
host (today `#assertRoute` does that before choosing the destination, so worker W1 serving `Notes` v1 rejects a `Notes` v2 request
placed on W2, which serves v2).

Every `remote` type declares its `hostAddress` (owner, 2026-10-29, who also renamed `placement` to it). Until then
`remote()` allowed leaving it out, a
leftover of slice 3a, which built remote objects over one link before host kinds existed; such a type went "here if
served, otherwise the parent", which needed its own fallback and a re-placement when a tab that loads before it
connects gets its first parent link (Opus, Sol). Opus and Fable proposed making it required; the owner agreed.

## What the check finds

Once placed, the provider found there is checked: served, a fitting version (the current one or an accepted older one,
with the fingerprint computed from the provider's own history), `authorize`, and the provider's own host-address check.
The request is then **bound** (to an object here, or to a hold over a path), or **unbound** with a reason:

| The check finds | The request | Shows |
| --- | --- | --- |
| a fitting provider | bound | its object's state |
| this host has not published its facets yet | unbound `unpublished` | `loading` |
| nobody serves the name at its address | unbound `not_served` | `failed { waiting }` |
| no fitting version, a fingerprint that differs at the same version, a host address the provider computes elsewhere | unbound `version` | `failed { waiting }` |
| the registry is served, but its first `compose`, or the reader's version mapping, threw | unbound `compose` | `failed { waiting }` |
| the provider host is installing, and the hold does not fit its current code | unbound `installing`, at the provider | `loading` |
| the path has no link (a drop, a route resolving) | waits on the path | `loading` |
| `authorize` refused, or the params are invalid | refused | `failed { broken }`, as today |

The reasons that wait for a name (`unpublished`, `not_served`, `version`, `compose`) are kept in an index under that
name, on the host that decided them: the consumer's host for a local request, the provider's host for a hold that
arrived over a link. The provider already keeps such holds today as **refused** (`remote/hold.ts`), and `retry` re-runs
them. `installing` belongs to the provider host's own install; `no_link` lives on the path, where the next link holds
the request again, as today. Every index drops an entry when its request ends, so a released getter, a closed tab or a
revoked guest leaves nothing behind. A refused request (no authority, bad params) is never indexed: a later
publication cannot grant authority.

## The publication gate

There is one short gate. Before a host has run its facets' setups, it does not know what it serves, so it cannot tell
"not served" from "not registered yet". A worker connects to its parent before it loads (W6), so holds can arrive in
that window, and p2's web shell holds references before its own `load` resolved.

So a request made on a host, or arriving on its links, before the host's **first publication** is not placed at all:
it is unbound `unpublished` and shows `loading`. The publication places it. Without this gate the request would be
placed by a half-empty registration table (Fable's trace: W1's own `Notes` sent over the parent, relayed back by the
server, forever), and a tab would see "not served" during every worker start (Opus's trace).

The gate is not the barrier. It lasts only until the setups ran, and the setups are synchronous code at the start of
`load`: they register types and registries and contribute, and wait for nothing. That is the difference that ends
the startup deadlock (chapter VI).

# Loading or Waiting {#states lede="What a reference shows while it is not live, and why a missing plugin is an answer rather than a spinner."}

`ref.state` keeps its four kinds: `loading`, `live`, `failed`, `ended`. What changes is one new kind of failure cause.

```ts
type RefState =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined }
  | { kind: "ended"; error: ChordError };

type FailureCause =
  | { kind: "transient"; error: ChordError }   // the object's own effect failed (an open, a follow): backoff
  | { kind: "broken"; error: ChordError }      // the object's own code, a cycle, or authority: retry() or a reload
  | { kind: "waiting"; error: ChordError };    // not the object's fault: woken by an event, never by a timer
```

## The mapping

Whether a request that is not live shows `loading` or `failed { waiting }` follows from what it waits for:

| The request is | `ref.state` | Calls on it |
| --- | --- | --- |
| bound, its object activating, or parked with no failed blocker | `loading` | park, bounded |
| unbound `unpublished` or `installing`, or its path has no link | `loading` | park, bounded |
| unbound `not_served`, `version` or `compose` | `failed { waiting }`, no `retryAt` | reject at once with the cause |
| bound, its object failed | `failed` with the object's own cause and `retryAt`, as today | reject at once |
| bound, its object live | `live` | run |
| ended by its holder, revoked, or its host closed | `ended` | reject |

The intuition is "is something under way?": an activation, a reconnect, an install, a load. When something is under
way, the reference waits and calls park; when nothing is, the reference says what is missing and calls fail fast.
The reviewers pointed out that "under way" is not something Chord can observe in general (a parent reconnect is the
app's, a `resolve` may hang), so the table is the rule and the intuition only explains it.

## A link drop and an unload, side by side

The owner's point was that a link going away is like the provider's plugin unloading. For the request they are the
same: it stays, it keeps its last values readable, it binds again when a provider is reachable, and its holder
notices nothing but the state. They differ in what is under way.

:::steps | The notes view on T, once through a link drop and once through an unload on W
+++ Live
T's notes view holds `Notes { S1 }` on W through the server. `ref.state` is `live`; the view renders the notes.
+++ The link drops
W's link to the server closes (a crash, a network change). The request on T stays; the path has no link: unbound
`no_link`, `ref.state` `loading`. The last notes stay readable. A call made now parks, bounded by `readyTimeout`.
Calls already sent fail and are never resent: their outcome is unknown.
+++ The link comes back
The route resolves again, the request is held anew on the new link, `bound` arrives with a fresh snapshot. `live`.
Parked calls go out in order.
+++ The plugin is removed on W
A reload on W removes the `notes` plugin. The provider's object ends as today: its natives close, its callers are
rejected at once, its handlers drain. The request on T does not end: W sends `failed { waiting, not_served }` on
the bound hold, which unbinds it. `ref.state` is `failed { waiting }`; the last notes stay readable; new calls fail at once with "notes is
not served on Session S1".
+++ The plugin comes back
A later reload on W serves `Notes` again. The publication re-runs W's refused holds for that name: `loading`, then
`bound`. T's view is live again without having done anything.
:::

One difference must stay: calls already sent. When a link drops, a sent call's outcome is unknown, so it fails and
is not resent. When a plugin unloads on the same host, its handlers are drained on the old code (design §21). Location
decides nothing else.

:::review | Review: a third cause kind, or not
Opus and Fable recommend `waiting` as above. Astra would keep two kinds and mark event-waited failures as `transient`
with no `retryAt` (today's wire already carries a `transient` cause without `retryIn`, `remote/remote-object.ts`), so
no kind is added; the cost is that `transient` then means two things, a backoff under way or an event awaited. Sol would show `loading` with a diagnostic; that parks every call on a missing plugin for 60
seconds and spins forever in the UI. The draft recommends `waiting`. **Owner** decision 3.
:::

# Parked {#parked lede="An object whose dependencies are not all live waits, with no timer, and goes on the moment they are."}

The owner's instinct was that an object is parked until its dependencies all cleanly resolve. This chapter makes that
exact: what a dependency is, what the parked object shows, what it keeps, and where parking ends.

## What counts as a dependency

A **dependency** is a request an attempt makes in its factory and needs live before the object may go live:

- `self.get(Type, params)`, local or remote: one rule for both;
- `self.registry(R)`: a registry at the reader's version (chapter X);
- a keyed pin, `ref.notes.at(key)` on another object's keyed member: the key must be loaded.

Two things are not dependencies. `self.follow(attach)` is the attempt's own step: its `attach` runs Durable's code
and may fail like an `open`, with the object's own `transient` failure and backoff (a follower that wants to recover
the moment a new harness appears declares `self.retryOn` on the registry it reads the harness through). And a
`ctx.get` in a method is not part of the object's activation at all: it is the call's request.

## The dependency check

An attempt runs its factory, hydrates its persisted singletons (they are the object's documents, kept across
attempts, as today), makes its requests, and is **parked** while any dependency is not live (and hydrated). What it
shows follows its dependencies:

| Its dependencies | The parked object shows |
| --- | --- |
| any `loading`, none failed | `loading` |
| any `failed` | `failed { waiting, "waiting for X: <X's cause>" }`, no `retryAt`; the message keeps the nearest blocker and the root cause within the 500-character rule |
| one failed with `invalid/cycle` (a dependent off the ring) | `broken` with the same error: it would wait on a ring that never heals by itself |
| one `ended` (revoked, or its host closed) | `broken` with that error: the request cannot come back; `retry()` or a reload makes new requests |

When every dependency is live, the attempt passes the **dependency check** and runs its own steps: its natives in
declaration order, its follow attaches, the member checks, its derives. Those are
bounded by its own `readyTimeout` deadline, as today. Then it goes live.

The dependency check is the boundary between waiting and working (Astra's F3). Before it, the attempt holds no
natives; after it, a dependency that leaves `live` is treated as after live (R18): the attempt goes on, and its calls
through that reference meet the reference's state. So a parked attempt never holds a native, and an attempt that
opened a native is never parked. It is not a rule of its own: it is R18's rule for live objects (a dependency that
goes away leaves the object live; same-host calls in flight finish, remote ones fail, new calls meet the reference's
state), applied from the dependency check on. Without that boundary a contributor unloading while the attempt opens its natives
would leave it half open and parked, or force a seal, a drain and a fresh attempt for a dependency the object may not
even use at once.

:::sequence animate | Code mode on W parks on the harness and goes on the moment it is live.
actor cm "CodeMode" "host-lifetime, local"
actor h "Harness" "host-lifetime, local"
actor m "HarnessModels" "registry"
cm -> h: self.get(Harness): loading
note cm: parked: shows loading, no timer
h -> m: self.registry(HarnessModels): usable
h -> h: own steps: open Durable
h => cm: Harness live: a state change
cm -> cm: dependency check passes; open the sandbox
cm -> cm: live; contribute tools
:::

## No clock while parked

A parked attempt has no dependency deadline and no backoff. Its `readyTimeout` deadline is paused while it is
parked, as eager migrations already pause it (`attempt.ts`, `deadline.pause()`), and resumes with the budget left when
the attempt passes the check. Today a dependency that does not go live within 60 seconds fails its dependent
`transient`, which then retries with backoff from 1 to 60 seconds. Both go: the dependent is woken when the dependency
changes, and the time a dependency takes is bounded where it runs, by that dependency's own steps.

## What a parked attempt keeps

It keeps its documents (the object's), its declarations and its requests (R18's holding today), and its seal token.
It keeps no native. It ends with its object: when its last holder releases it, or, for a host-lifetime object, when
its plugin is removed or the host closes. A parked object
with params that nobody holds any more ends and releases its requests, so a whole parked chain goes when its top is
released.

## `broken` is the object's own fault

After the model, `broken` means exactly three things: the object's own code failed (a throwing factory, a derive that
throws at activation, a hydration or `migrate` that fails, a document fingerprint mismatch, an `open` that throws
`broken(...)`), the object is on a cycle, or it lost its authority (`forbidden`, a dependency that ended). Everything an object waits for, including a provider that is itself
broken, makes it `waiting`. The difference matters for recovery: a broken object needs `ref.retry()` or a reload of its
own plugin; a waiting one recovers by itself when what it waits for recovers.

## Retry passes on

A Retry button on a waiting object should do something. Opus's trace: the tab's `Panel` waits for the server's `Dash`,
which waits for `Catalog`, which is broken by a factory bug that a configuration fix would heal at the next attempt.
The user sees "waiting for Dash: waiting for Catalog: …" and presses Retry. Today `Panel` would re-check, find `Dash`
still failed and do nothing.

So `ref.retry()` on a `failed { waiting }` object retries its failed blockers, hop by hop, with the existing `retry`
message over links: it retries the blockers that are `broken` or `transient` (the only ones a retry can change),
passes through the `waiting` ones, and leaves the rest alone. Each retry carries an operation id, so a diamond of
dependencies retries a shared leaf once. Retry of a `broken` or `transient` object starts a new attempt, as today. A
`retryOn` value call still retries a failed object as slice 8 decided; while the object is parked `waiting`, it does
nothing: its dependencies decide.

## A reload of the parked object itself

The parked attempt's factory never runs again while it is parked, with one exception: a reload of the object's own
plugin replaces the parked attempt with the new factory's attempt, as one handover: the new requests are made and
bound first, then the old ones released (Astra: a dependency held only by this object, unchanged by the reload, must
not end in between; today's `#activate` already binds before `#releasePrevious`). If the new code no longer declares
the missing dependency, the object can go live at once.

## After live, nothing changes

R18's second half stays: once an object is live, a dependency that leaves `live` (a link drop, a removal) leaves the
object live. Its calls that use the dependency get the dependency's state: they park while it is `loading` and reject
while it is `failed`. Reactivating every live consumer on every dependency loss would turn one worker disconnect into
closed natives, withdrawn contributions and aborted jobs on the server; the reviewers agreed it should not.

# What Wakes Whom {#wakes lede="Two kinds of event replace every poll and every dependency deadline."}

A model without timers lives or dies by its wakes: a wake that is lost leaves an object parked forever. So the wakes
are kept to two kinds of event, each with one owner, and every unbound request and every parked attempt is
subscribed to exactly the events that can change it.

| Event | Who is told | Exists today? |
| --- | --- | --- |
| **a target changes state**: an object goes live, loading or failed, or gets a new cause; a hold receives `bound`, `loading` or `failed`, also after a re-hold on a new link | the requests bound to it, and the attempts that depend on those requests | partly: `dependencyLive` covers only "goes live" |
| **a name becomes usable on a host**: a publication (`load`'s setups, a reload's commit, an install's commit) serves a type, a registry or a version; a registry composes or maps a value at a version | the unbound requests indexed under that name on that host; a refused hold re-runs its start and sends `loading`, then `bound` or `failed` | partly: refused holds and `retry` exist; the re-run at publication is new; a registry wakes only at its first value |

## Every change, not only "live"

Draft 1 woke a parked attempt only when a dependency went live. Astra, Fable and Sol found the same hole: a dependency
that moves from `loading` to `failed`, or from one cause to another, leaves its dependent showing a stale state, and a
dependent that should now show `failed { waiting }` keeps parking calls. So a parked attempt re-evaluates on every
state change of any of its dependencies and updates what it shows. It leaves parking only when all of them are live.
Its factory never re-runs on a wake.

Three details keep this correct and cheap:

- **Coalesced, after the batch.** Wakes run after the batch that caused them (a publication, a commit, an inbound
  `bound`), once per object, so a commit that changes three dependencies wakes their dependent once, and no factory
  runs inside another owner's batch.
- **Remembered.** A change that arrives while the attempt runs its own steps or tears down is remembered and applied
  after (today's R18 wake memory, generalized).
- **Indexed by name.** A publication touches only the unbound requests waiting for the names it serves. A reload of
  `notes` never looks at requests waiting for `search`.

## Across a link: no new message

The wake across hosts needs no new message kind. Today a provider keeps a hold it could not serve as refused, and a
`retry` from the consumer re-runs its start. The model adds one thing: the provider re-runs its refused holds itself,
at its own publication, for the names that publication serves.

:::sequence animate | The search indexer on W waits for the server's feed, which a reload on S adds.
actor w "worker W" "Indexer, parked"
actor s "server S" "search plugin missing"
w -> s: hold SearchFeed
s --> w: failed { waiting, not_served }
note w: Indexer shows failed { waiting }; no timer, no retries
divider "a reload on S adds the search plugin"
s -> s: publication serves SearchFeed; re-run refused holds for it
s --> w: loading
s --> w: bound (snapshot)
w => w: a target changed state: Indexer re-evaluates, passes the check, goes live
:::

Two existing messages change: `failed` carries the new cause kind `waiting`, and `loading` and a `waiting` `failed`
carry the provider's attempt id for the cycle probe (chapter VIII). The pinned list of causes and its test change with
them, and `PROTOCOL_VERSION` stays 1 until p3 ships.

## Registries

A registry reader is woken at every transition of the registry's value at its version to usable: when the registry
is served, when it composes for the first time, when an older reader's mapping succeeds again after it failed. Today
`RegistryValueSource` wakes only at the very first good value (`#valued`), which a registry whose provider is removed
and added again would never pass a second time.

# Starting Up {#startup lede="The barrier did two jobs with one promise; separated, the deadlock disappears."}

`load` does three things today: it runs every facet's setup, it publishes them (types served, registries composed
once, contributions in their tables), and it waits until every host-lifetime object has had its first outcome. The
promise of the whole thing, `pendingLoad`, is also what incoming holds and `host.hold` wait for. That is the startup
deadlock of chapter I.

## Publication first

The model splits `load` at the publication:

1. **Setups.** Every facet's setup runs. Setups only declare: `host.serve`, `self.contribute`, `host.references`.
   They are synchronous and wait for nothing.
2. **Publication.** All declarations become visible at once, in one batch: types served, registries served and
   composed once, contributions in their tables. Nothing activates inside that batch.
3. **Wakes.** After the batch, every request that waited for the publication (unbound `unpublished`) is placed, and
   every unbound request for a name the publication serves is re-evaluated.
4. **First outcomes.** The host-lifetime objects activate. Whether `load` waits for them is the barrier question below.

Requests wait for step 2 only. Since the setups wait for nothing, a host always reaches step 2, and a request from
another host can never wait for this host's activations. Chapter I's knot comes apart:

:::sequence animate | The same startup as in chapter I, under the model. No deadline is needed.
actor s "server S" ""
actor w "worker W" ""
s -> s: setups, publication: C served
s => w: A needs B: hold B
w -> w: setups, publication: B served
w => s: BStore needs C: hold C
s --> w: bound C (S has published; C activates and goes live)
w -> w: BStore live, B live
w --> s: bound B
s -> s: A live; S's first pass done
:::

## The barrier: (a) or (b)

What is left of the barrier is the app's question "has every plugin had its first try?". R17 needs it: p3's base code
resumes the harness after `load`, so the first turn sees the tools of every plugin that loaded. Two shapes are on the
table.

**(a) Chord keeps it.** `load` resolves when every host-lifetime object of this `load` has a **first outcome**: it is
live, failed by its own cause, or parked with no blocker that is a local object still without its first outcome. In
code, per object:

```ts
const firstOutcome = (o: Obj): boolean =>
  o.live || o.ownFailure || (o.parked && o.blockers.every((b) => !b.local || firstOutcome(b)));
```

So `CodeMode → Harness`, both local, waits until the harness had its outcome: code mode is parked on a local object
that is still in its first attempt, so code mode is not done. A wait on another host, or on a dependency that failed,
ends the first pass: the barrier never waits for another host, a retry, a later contribution or a reload. The signal
is separate from the readiness dependents wait for (Sol: resolving that for a parked object would let its dependents
open natives too early), and it is counted once per object, never reopened by retries. An object of the cohort that
ends before its first outcome (its plugin removed, the host closing) settles its entry as ended, and `host.close`
settles a `load` that is still waiting (Astra).

**(b) The app keeps it.** `load` resolves after the publication. Chord adds `host.startup`, a watchable of the
host-lifetime objects and their first outcomes with causes; base code decides when to resume (Fable). The tracker is
the same; only who awaits it changes.

Three of the four reviewers recommend (a): the activation graph is Chord's, and every app that wants R17's behaviour
would otherwise build the same cohort tracker. Fable recommends (b): the policy belongs to the app, and p2 already has
three different ones. **Owner** decision 1.

## What the barrier does not promise

Neither shape can promise that every tool is there for the first turn, and the model does not pretend it can. Sol
reproduced it against today's code (`/tmp/barrier-sol-first-outcome.log`): object A's `open` fails on its first
attempt (A's first outcome); B goes live and contributes; the registry changes and `retryOn` wakes A for a second,
slow `open`; `load` resolves with only B's contribution in the table. Tools found in `onLive` (MCP) arrive later by
design. What a first turn really needs (a model, an environment, a reconciled working directory) is p3's explicit
admission check, as p2's `whenRegistered` and its harness prerequisites are today.

:::note | What p2 does today
p2 does not wait for all host objects before the first turn. Its worker (`apps/p2/src/hosts/worker.ts`) loads with
`awaitHostObjects: false`, waits for the harness, resumes Durable, tells its parent `control.ready()` and only then
awaits `host.ready()`. It has to: its subagent tools and the search indexer need server types, and the server admits
the worker's link only after `control.ready()`. A barrier before that point would deadlock, exactly as in chapter I
(Astra and Sol, independently).
:::

# Plugins Coming and Going {#reload lede="Removals, versions and rollouts across hosts, as events the requests wait for."}

Slice 7 brings reload and rollout, and with them the cases where a provider disappears on purpose. Today's design
handles them with their own mechanisms: `gone` when a type is removed, a final `contract_mismatch` when a version is
dropped, `updating` with a deadline during a rollout. Under the model all of them are one thing: a request becomes
unbound with a reason, and the event that fixes the reason wakes it.

## A type removed, and served again

A reload that removes a type ends its objects as today: natives close with reason `end`, callers of running calls are
rejected at once, handlers drain. What changes is what happens to the requests that pointed at those objects.

- **Over a link,** the provider sends `failed { waiting, not_served }` on the bound hold. A `failed` on a bound hold
  unbinds it (Fable: one message, one rule; the consumer applies it as today's `#startOver` plus `failed`). The
  provider detaches the hold's sources and drops its unsent pending ops and any queued `bound`. Two things it must not
  do (Sol): free the ack slots of `bound` and `state` messages already sent, which stay counted until their `ack` or
  the link's loss, or resend calls, which fail and free their slots once.
- **On the same host,** a `Binding` whose target ended by removal becomes unbound and accepts a second `bind`. Its
  member sources re-bind by name (one frame from the last value, as on a restart today), keyed pins re-pin, parked
  calls flush or reject, presence lists it again. This is the one genuinely new piece of machinery in the model
  (Fable, Sol): today `bind` runs once per binding, and the ended object is forgotten.

When a later commit serves the name again, the publication wakes every request indexed under it, on every host that
holds one, and they bind as if nothing had happened.

## A version no longer accepted

A reload can also keep the type and stop accepting an old version (it drops `accepts[1]`). Draft 1 ended the provider
object then; Sol and Astra caught it: the object, its documents, its jobs and its holders on the current version are
fine. Only the requests on version 1 become unbound `version`. The object's own plugin reload still restarts it if it
has natives (§21), as for any reload.

## A type that moved

A plugin can move a type from the worker to the server by changing its `hostAddress`. A consumer's request carries the
address its own code computed, so the provider appearing on the server cannot wake it: the request is not waiting
there. The old host answers `not_served`; the consumer's own reload, which brings the new `hostAddress`, makes a new
request. The model adds no redirect: moving state between hosts is a deliberate migration, not something Chord guesses.

## Rollouts across hosts

A rollout installs a revision on the server first, then on the workers, then on the tabs (design §21). Between those
installs, hosts run different code. The model needs only one rule for that: **each host knows its own install, and
nothing more.**

- A provider host that is **installing** keeps holds that do not fit its current code as unbound `installing`: the
  consumer sees `loading`, its calls park. When the install ends, by its commit or by its rejection, the host
  re-evaluates them against the code it now runs (Astra, Sol: a rejected install must not leave them asleep).
- A provider host that is **queued** but not installing yet answers a mismatch with `failed { waiting, version }`
  until its install commits and wakes the request. That is a visible blip of at most one install; Opus judged it
  acceptable, and avoiding it would need revision fields in every answer.
- **Installs never wait for activations.** An install that waited for its objects to go live would deadlock a rollout
  that runs in the other order: the worker's objects wait for the server's new types, the server's install waits for
  the worker.
- A host whose **own** install was rejected fails its own requests at once with the reason (design §21).

:::steps | The sharing plugin's contract goes from v1 to v2; the server installs first
+++ Before
S and W run revision R. W's `ShareStatus` holds the server's `Sharing` v1; T's tab holds W's `ShareBadge`. All `live`.
+++ S installs R+1
R+1 makes `Sharing` v2, with no `accepts[1]`. While S stages it, S still runs R: W's v1 hold fits the running code
and stays `live`. A hold that arrived now from a host already on R+1 (a v2 hold) would not fit R: it would wait
`installing` (`loading`, calls park) until the install ends.
+++ S commits R+1
The install ends. S re-evaluates: v1 is not served. W's hold becomes `failed { waiting, version: asked 1, served 2 }`.
`ShareStatus` stays live (R18 after live); its calls that use sharing reject at once with the cause.
+++ W installs R+1
W's new code bundles `Sharing` v2. Its own reload's handover makes the new request at v2 and releases the old one. The
new hold binds; `ShareStatus` is fully back. T's `ShareBadge` never noticed anything but one stale value.
:::

## Old calls

Calls that were running when the reload came follow §21 unchanged: a pure swap lets them finish on their old handles;
a native restart drains them first; a removal rejects their callers at once and drains their handlers. Chord never
resends a call.

# Finding Cycles {#cycles lede="Without the deadline, the one gap left in cycle detection needs an answer: a narrowed deadline, or a probe."}

A provider that never appears keeps its dependents parked, and that is visible: they say what they wait for. A cycle is
different: A waits for B, B for A, every provider exists, and still neither can go live first. Today Chord has two detectors and a deadline. On one host, `self.get` follows the waiting edges of
activating objects. Across hosts, a hold carries the activation chain it was made in, and a provider refuses a hold
whose chain contains the object being activated. The gap is documented (design §6): when A on the server and B on a
worker start at the same moment, the holds carry `[A]` and `[B]`, neither finds the other, and both fail at the 60-second
deadline. The model removes the deadline, so the gap must close.

## Two answers

The owner decided this gap once already. On 2026-10-24, after the slice 4b reviews, he made simultaneous starts across
hosts "a documented limitation: they time out transient and retry; no probe message." That decision assumed the
activation deadline. The model removes the deadline for dependency waits, so the decision needs one of two
continuations, and this one is his (**Owner** decision 6):

- **(A) The 4b decision, narrowed.** One deadline stays: an attempt parked on a dependency held over a link, whose
  target attempt is known and still activating or parked, fails `transient` after its `readyTimeout` and retries with
  backoff; its next attempt usually starts after the other side, and the activation chain in its hold finds the cycle.
  Working it through showed the catch. A target that is *parked* is the common case of a chain across hosts waiting
  for a missing plugin: a tab's view on a worker object that waits for an uninstalled type. Those dependents would time
  out and poll again, as today, so "local = remote" would stop at the link. Narrowing the deadline to targets that are
  `loading` avoids the polling but misses a real ring: A and B on two hosts wait on each other, and B also on a missing
  X. B is `failed { waiting }`, so A is too; when X appears, both stay `failed { waiting }` on each other, with no
  deadline to break it and no chain to see it. Worse (Fable, round 6): an object's activation chain is fixed
  when it is created and its instance id survives retries, so a retried attempt sends the same hold with the same
  chain; two simultaneous starts time out and retry in lockstep and are never found. The deadline would poll without
  finding what it is for.
- **(B) The probe (recommended, pending review)** described in the rest of this chapter: no deadline at all, one new
  message kind, and the most intricate rules in the model. Five review rounds found a counterexample in each of the
  first four drafts; the version below answers all of them, with one choice left in rule 5. Slice 7
  would prove it with tests before the old deadline goes.

The rest of the chapter describes (B): it is the answer that keeps one rule on both sides of a link, and its review
history shows what a complete answer takes.

## Why a growing chain is not enough

Draft 1 proposed letting chains grow: an activating object that receives a hold with a chain sends the grown chain on
to its own dependencies. Astra and Sol showed two flaws. Chains are cut at 32 entries today, so a ring of 33 objects
started at once is never found: the chain that reaches each object is always missing that object's own id. And a
chain records ancestry, not the current wait graph: once A stops waiting for B, B's chain still names A, and a later
wait of B on A looks like a cycle that is not there.

## (B) The probe

The model uses an edge-chasing probe (the idea of Chandy, Misra and Haas), for the rings that cross a link; on one host the `self.get`
walk stays, synchronous and exact, as today (Opus).
Five rounds of review shaped it; the rules below are the result.

1. **Attempts, edges, tokens.** Every attempt has its own id, minted per attempt: a retry or a reload is a new
   attempt (today the id is per instance and survives retries). A **wait edge** runs from a parked attempt to the
   activating or parked attempt it waits for, through a bound request. Unbound waits and registry reads are never
   edges: they are not deadlocks, they end when a provider appears. Every edge carries an **edge token**: a number from a counter the
   attempt keeps, never reused, replaced by a fresh one on any interruption or change of that edge (Astra, Sol: two
   requests to one object are two edges): a new target attempt (also when a local
   target retries without a re-bind), any `loading` on a bound or pending hold (a relay re-holding upstream included),
   an unbinding, a rebinding, a re-hold after a reconnect. An attempt is parked for one interval only (once past its
   dependency check it never parks again), and attempt ids are never reused. A provider tells its consumers which attempt they wait for on every answer that is not `bound`:
   `loading { hold, attempt }`, and a `waiting` `failed { hold, cause, attempt }`.
2. **A search per edge change.** Whenever a parked attempt gets a new edge, or a new token on one, it starts a
   search: `probe { kind: "search", round, initiator, trail }`, with the next number of a counter the attempt keeps,
   its own attempt id, and the trail of `(attempt, edge token)` hops crossed so far, starting with its
   own. A ring closes at its last edge,
   and that edge's source starts the search that finds it (Sol's simplification after Astra's counterexample: a ring
   that forms only after a reconnect, with unchanged attempts, is otherwise missed). Searches are coalesced per batch.
   On the same host a probe is a call on the target attempt, forwarded through a queue rather than recursion; over a
   link it is a new message, `probe { hold, to, ... }`, consumer to provider, relayed by hold id with the origin.
   **Probes are honoured on parent and route links and dropped on child links** (`accept`), whatever `trusted` says
   (Opus): a tab learns attempt ids from `loading` and could otherwise break an object with a forged probe, while a
   worker whose transport is untrusted must still take part. Clients serve no remote types, so no real cycle runs
   through one.
3. **Forwarding.** An attempt that receives a search drops it if `to` is not its current attempt or if it is not
   parked. If the initiator is itself, the search came back. If the attempt is already in the trail, it drops it: a ring
   that does not contain the initiator is found by its own members' searches (Opus). Otherwise it forwards it along
   every wait edge, appending itself and the edge's token to the trail, but only if its round number is higher than the one it stored for
   that initiator; then it stores it. A late, older round is dropped even if this attempt never saw it: its initiator
   has moved on (Astra, Opus). The seen map holds one number per initiator, up to 256 initiators, and goes with the
   attempt.
4. **The check.** The initiator accepts a returned search while it is still parked, whatever round it carries (Astra:
   a re-search must not invalidate an older search still under way); the check decides. It verifies its own hop, then
   sends a
   `probe { kind: "check", round, trail }` along the recorded trail: each hop passes it on only if it is still that
   attempt, still parked, still holding the recorded edge token, pointing at the next hop's attempt. The check follows the
   trail by position, ignores the seen map and dies on any mismatch. When it returns, the initiator verifies its own hop
   once more. If the check comes
   back, the initiator fails `broken invalid/cycle`, naming the path from the trail, and today's propagation breaks
   the other activating objects on the ring and the dependents off it.
5. **No silent loss.** Astra found the last hole: a search can reach an attempt first by a shortcut and be dropped
   there when it arrives again along the ring itself; if the shortcut breaks before the check, the check dies and
   nothing is left to find the ring. Round 6 tried `dead` notices sent back to the initiator. Sol and Astra showed
   that reliable notices need recovery state per search that the seen map's eviction may not drop, and that a long-
   parked attempt would otherwise keep for every initiator that ever passed: a leak, unless every search gets a full
   lifecycle with completion and cancellation. So rule 5 is a choice, part of **Owner** decision 6:
   - **(B1) Re-search with backoff (recommended).** An attempt parked on a remote attempt starts a fresh search again
     after a backoff, 1 second doubling to 60, reset by an edge change, whether it shows `loading` or `failed
     { waiting }`; the timer stops when the attempt leaves parking. No `dead` messages and no recovery state;
     eviction only costs work; a new search starts within one backoff period, so every stable ring that
     crosses a link is eventually found (no wall-clock bound: delivery is only fair). The
     timer runs as long as the attempt stays parked on a remote attempt: a view on a worker object that waits for a
     missing plugin re-searches every minute until a reload (Fable). The timer sends probes only: it
     never fails an object, never re-holds, never polls a provider. Its cost is one probe per parked remote dependent
     per period, which dies at the leaves of the downstream wait graph.
   - **(B2) Events only.** Every search is owned until it settles: branches report completion or abort along their
     trails, a dropped probe answers `dead { initiator, round }` by a reverse route, edges remember the searches they
     carry until those settle, and an initiator that ends or moves on cancels its old search. Complete without any
     timer, bounded by the searches in flight, and the most intricate protocol in Chord; not yet specified to the
     reviewers' satisfaction.

   Sol's correctness reference, enumerating every simple trail without dedupe, never suppresses a ring copy, but its
   work is exponential on chains of diamonds.

:::sequence animate | Two objects on two hosts start at the same moment and need each other. The probe finds it; nothing times out.
actor a "A on server S" "attempt a1"
actor b "B on worker W" "attempt b1"
a -> b: hold B (A activating)
b -> a: hold A (B activating)
b --> a: loading { attempt: b1 }
a --> b: loading { attempt: a1 }
a => b: search { to: b1, round: 1, initiator: a1, trail: [a1·t1] }
b => a: forward: search { to: a1, round: 1, trail: [a1·t1, b1·t1] }
a -> a: search 1 came back: check the trail
a => b: check { round: 1, trail }: b1 still waits on a1 with token t1
b => a: check passes on
a -> a: check came back: broken invalid/cycle "A → B → A"
:::

## Why a reported ring existed

Draft 4 confirmed a cycle with a second, independent round. Sol showed a schedule in which two rounds pass through two
different stale paths, each of them half replaced by reloads, and together report a ring that never existed at any
moment (`/tmp/model/sol-probe4.log`). The check closes that: it walks the very path the search recorded and demands
that every edge still carry the token it had when the search crossed it. A token changes on every interruption and is
never reused, and an attempt is parked for one interval only, so an edge cannot vanish and come back unnoticed (Fable and Opus
checked the argument in round 5). Every edge of the trail therefore existed from the moment the
search crossed it until the moment the check crossed it; the search crossed all of them before the check began, so
when the check began, every edge of the ring existed at once. In Sol's schedule the check dies at `B`, whose edge now
points at another attempt.

## Why every ring is found

Under an eventually stable wait graph and fair delivery (endless edge churn can keep invalidating searches), and with
rule 5's (B1) or (B2) for a search suppressed behind a path that broke, a ring of parked attempts is closed by its last
edge. When that edge appears, its source starts a search; every other edge of the
ring exists at that moment, and every attempt on the ring waits, directly or not, on the source, so none of them can
go live before the search and its check come back. Rings of any length are found, through local and remote edges
alike. On a graph without cycles, searches die at the leaves; on a diamond, the seen map drops the second arrival.

## What it does not promise

- **A ring broken up just after.** A ring that existed when the check began may be broken up by a reload, a retry, an
  unbinding or a revocation a moment later; it is still reported, because it did exist. The objects it breaks recover
  as every broken object does, through `ref.retry()` or a reload of their plugin.
- **Linear work under every schedule.** With more than 256 initiators passing one attempt at once, an evicted entry lets
  a search be forwarded again, so in an adversarial schedule the work can grow with the number of simple paths (Astra, Sol); never endlessly, since
  a search never revisits an attempt already in its trail.
  The seen map's memory stays bounded. Each edge change costs one search that crosses each downstream edge once,
  and one check per returned search; with (B1), every attempt parked on a remote attempt adds one search per backoff
  period, also while an acyclic chain only waits for a missing plugin.
- **Constant message size.** A probe carries its trail, so it grows with the length of the path it crossed; a search
  that returns carries a trail as long as its ring. That is the price of the check; chains were cut at 32, trails are
  not, because the trail is the proof.

:::review | Review: the state of (B)
The check's argument (a reported ring existed at the moment the check began) was confirmed by all four reviewers in
rounds 5 and 6, given exact edge identity (the tokens). Completeness under an eventually stable graph holds with
(B1); with (B2) it holds once the search lifecycle is specified, which no draft has done yet. If the owner chooses (B),
slice 7 keeps today's deadline for activations waiting across links until the probe's tests pass: long rings,
diamonds, a ring closed after a reconnect with unchanged attempts, Sol's phantom schedule, Astra's broken shortcut,
Sol's eviction schedule, 300 concurrent initiators, edges added and removed, reloads, relays, forged probes.
:::

# Callers {#callers lede="Getters, holds and calls get one rule: wait while something is under way, answer when nothing is."}

Objects park; callers do not. A caller is code that wants an answer: a method that needs a reference now, a tool that
runs inside a turn, a tab that wants to render. The model keeps their deadlines and gives them one rule.

## `host.hold`

`host.hold` returns a reference at once and never rejects; only invalid params throw, also before `load`. That was
already the design; the model removes today's inconsistency: a missing local type throws after `load` but fails the
reference before it. Now a missing local type gives `loading` before the publication and `failed { waiting }` after
it, and the reference binds when a provider appears. A UI that wants to wait for something that may never come
holds it and shows its state.

## `host.get`, `ctx.get`, `host.registry`

The getters resolve when the reference is live. While it is `loading`, or `failed { transient }` (its object's own
retry is under way), they wait, bounded by their `readyTimeout`. On `failed { waiting }` or `failed { broken }` they
reject at once. On success, rejection or timeout their temporary wait goes; a rejected getter releases its request.
`host.registry` returns the `RegistryValue`, whose watches and observers are owned as they are today; it has no
`release()`.

Opus's case decided the recommendation. A Durable tool runs `chord((ctx) => ctx.get(SharingView, { session }), ctx)`
while sharing is not installed. If getters waited through `waiting`, the tool, and with it the agent's turn, would
hang for 60 seconds and then fail; a call on the same reference would fail at once. With the rule above, the getter
and the call give the same answer at the same moment. The rule has a cost Opus named: a dependent whose only blocker is
an object recovering by itself (an SSH environment coming back, `transient` with its own backoff) is `waiting`, so a
getter on the dependent rejects at once. Code that wants to ride that out holds the reference instead of getting it.

:::review | Owner decision 2: getters on `waiting`
Recommended: reject at once (Opus; Fable agreed in round 2). The alternative waits through `waiting` up to
`readyTimeout`, which keeps "local = remote" just as well but makes every getter on a missing plugin cost its full
deadline.
:::

## Calls

Calls on a `loading` reference park in order, each bounded by the reference's `readyTimeout` from the moment it was
made (never renewed by a reconnect or a reload). Calls on a `failed` reference reject at once with the cause. A call
already sent when its link drops, or when its object ends, fails and is never resent; its outcome is unknown, and
idempotency is the app's (a `requestId`, as p2's chat does).

## The rule in one table

| The reference | `host.hold` | getters | calls |
| --- | --- | --- | --- |
| `loading` | returns it | wait, bounded | park, bounded |
| `failed { transient }` | returns it | wait, bounded | reject |
| `failed { waiting }` | returns it | reject at once | reject |
| `failed { broken }` | returns it | reject at once | reject |
| `live` | returns it | resolve | run |

# Registries {#registries lede="The same resolver on one host, with versions that can differ inside one revision."}

A registry is host-local: its contributions are in-process values, often natives. Slice 8 made `self.registry(R)` a
dependency that waits for a value. The model keeps that and folds it into the one resolver.

## A reader's request

A reader asks for `R` at the version its own bundle was built against. The request is bound while `R` is served and
has a usable value at that version: composed, and for an older reader mapped back by the provider's
`accepts[old].value`. Otherwise it is unbound: `not_served` (no plugin serves `R` here), `version` (the provider does
not accept the reader's version, or the reader is newer), `compose` (`R` is served, but its first composition, or this
version's mapping, threw), or `loading` before the publication. The reader is woken at every transition of the value
at its version to usable. S2's `broken` for a newer reader and S3's backoff go; so does `#valued`, the latch that woke
readers only at the very first good value.

A registry waits for a value, never for a particular contribution: an empty table composes. "Wait until model X is
there" is the app's admission check, not a registry rule; Durable's own "model unavailable" wait covers the harness.

## Versions inside one host

Draft 1 claimed that a registry's provider and its contributors always run the same version, because a host installs
a revision atomically. Astra corrected it: a revision is a set of plugin bundles, and a reload of the plugin that owns
the registry leaves every other plugin's contributors and readers on the version they were built against. So the
provider's adapters do real work inside one host: `accepts[old].contribution` maps an older contribution, `accepts[old].
value` maps the composition back for an older reader. A contribution without an adapter is left out and reported; a
reader without one is `waiting` with `version`.

## The last good value, and natives

Slice 8 decided that a throwing `compose` keeps the last good composition, so an extension point stays available while
its owner fixes a bug. Astra found the case where that hands out something dead: the harness contributes its native
`H`; a reader is live; the harness ends; the next composition throws for an unrelated reason; `.value` still returns
the composition that contains the closed `H`.

The model narrows the rule: `.value` keeps the last good composition only while every contribution it was built from
is still in the table. When one of them leaves (its contributor ended or was reloaded), the last good value is dropped
and `.value` throws until `compose` succeeds again. And `compose` represents a missing contributor as a value
(absent), never by throwing.

:::review | Review: drop the last good value, or fence the reads
Sol would keep the last good value and instead require natives in a registry to be looked up at use through their
owner, without the guarantee. The draft takes Astra's narrower rule, because it keeps "a registry never hands out a
native whose contributor ended" without asking every contributor to wrap its natives. It narrows a decision of slice 8,
so it is the owner's: **Owner** decision 5.
:::

# Keep-alive, Presence, Revocation {#housekeeping lede="What a waiting request costs, who counts it, and who may end it."}

A parked object and an unbound request are resources: they hold memory, they may keep a worker process alive, and
they act for a principal. The model says how each of those works while nothing is bound.

## Keep-alive and presence

A worker stays alive while `host.activity` shows work: references held over links, calls, jobs, lingering objects. A
request that arrived over a link counts once in `host.activity.references` from its arrival to its end, bound or
unbound. Without that, a session whose tab waits for a plugin that is not installed would see its worker stopped every
idle period (five minutes in p2) and restarted by the next re-hold, forever (Opus). Presence is different:
`host.references` lists only bound references, so "who is looking at these notes" counts viewers, not waiting
requests.

## Revocation

Revocation ends the requests of a revoked principal, bound and unbound, at every hop. A guest whose grant is revoked
while their tab waits for a missing plugin does not get a reference later when the plugin comes back: the request is
gone, and nothing revives an ended request (no publication, no Retry, no new grant). A refused request (no authority)
is never indexed in the first place.

## `gone`

`gone` remains for one thing: revocation. A provider host that closes closes its links and sends nothing (today's
`#close`); its consumers see a link drop, `loading`, and hold again when the host comes back. A reload that removes a
type sends `failed { waiting }` instead of `gone` (chapter VII).

## Parked objects and their jobs

A parked object with params lives while it is referenced, like any object; when its last holder releases it, it ends
and releases its requests, so a parked chain goes from the top down. A host-lifetime object parks until its plugin is
removed or the host closes. Persisted job runs of a parked host-lifetime object are loaded with its documents, before
it parks; `run` and `finish` start only once it is live, and the run count keeps the object as today.

# The Clock {#clock lede="Which timers stay, and why each of them has no event to replace it."}

The owner expected the model to remove almost every timeout, "except maybe `readyTimeout`". That is what it does for
dependencies. Every remaining timer bounds something no event can end: a caller's patience, an object's own code, a
silent transport, a process that may start this time.

| Timeout or backoff | After the model | Why |
| --- | --- | --- |
| `readyTimeout` of an attempt | only its own steps (natives, follow attaches, checks, derives); paused while parked | a slow dependency is bounded where it runs, by its own steps |
| `readyTimeout` of `host.get`, `ctx.get`, `host.registry` | kept | a caller must get an answer |
| `readyTimeout` of a parked call | kept | an action must not run long after it was asked for |
| identity backoff 1 to 60 s | only for the object's own `transient` failures (an `open`, a follow) | nothing tells Chord that a disk or a network came back |
| dependency backoff, polling of refused holds | **removed** | a dependency's recovery is an event |
| dependency deadline for waits across links | answer (A): kept only for an attempt waiting on a remote attempt that stays activating; answer (B): kept until the probe's tests pass, then **removed** | the simultaneous-cycle gap (chapter VIII) |
| probe re-search backoff, only with answer (B1) | new: 1 to 60 s while parked on a remote attempt | finds a ring whose search was suppressed; sends probes only, never fails or re-holds |
| route backoff per address | kept | a failed worker start has no event; it avoids fork storms |
| heartbeat 15 and 30 s | kept | the only detector of a silent transport |
| `closeTimeout` (natives, the drain, the routine handover) | kept | bounds other code's teardown |
| routine and job `finish` backoffs | kept | the object's own code throwing |
| `linger` | kept | a policy for warm objects, not a wait |
| rollout install timeout (designed, not built) | a watchdog on the install only | never a deadline for dependencies |

So `readyTimeout` stays, but its meaning narrows to two things: how long a caller waits, and how long an object's own
activation steps may take. Waiting for someone else never counts against it.

# A Morning, Step by Step {#morning lede="The preface's Tuesday morning, played through under the model from the first click to the afternoon's rollout."}

The rules of the earlier chapters meet in one story. Mario opens session `S1` on his phone; the server S has the catalog
and the search feed; the worker W for `S1` has not started. W's plugin set has `core`, `models`, `codemode`, `notes`
and `search`, but not `sharing`, which was removed last night; the notes view still asks for it. Later in the day a
rollout brings sharing back, with a new contract.

:::steps | Session S1 on Tuesday
+++ 1. The tab asks for the notes
T calls `host.hold(Notes, { session: "S1" })`. The address is `Session { id: "S1" }`, not T's own, so the request goes
over T's parent, the server. S has a route for `Session`: it resolves the address by starting W. T's reference shows
`loading`; the request waits on S's path until W's link exists.
+++ 2. W connects before it loads
W connects to S first (W6), then starts `load`. The hold for `Notes` arrives before W has published its facets: it is
unbound `unpublished` and waits, still `loading` for T. Nothing is placed by a half-empty table, so the hold is not
sent back to S.
+++ 3. W publishes
W's setups run, synchronously, and are published in one batch: `Notes`, `NoteStore`, `Harness`, `CodeMode`, `Indexer`
are served; `HarnessModels` and `HarnessExtensions` are served and composed once. After that batch, the waiting hold
for `Notes` is placed and binds; the host-lifetime objects start.
+++ 4. Code mode parks on the harness
`CodeMode` declared `self.get(Harness)`. The harness is still opening Durable, so `CodeMode` parks: `loading`, no timer.
The harness reads `HarnessModels`, which has a value (composed at the publication; the model runtime's contribution may arrive
after), finishes its own steps
and goes live. That state change wakes `CodeMode`, which passes its dependency check, opens its sandbox, goes live and
contributes its tools.
+++ 5. The indexer waits for the server
`Indexer` needs the server's `SearchFeed`. The hold goes over W's parent; S published long ago, so it binds at once,
`SearchFeed` is live, and `Indexer` goes live. Had S been starting at the same moment, the hold would have waited only
for S's publication, never for S's activations: the startup deadlock of chapter I cannot form.
+++ 6. The first pass
With barrier (a), W's `load` resolves once `Harness`, `CodeMode` and `Indexer` had their first outcomes. `CodeMode`
waited for the local harness, so its tools are in the table; base code resumes the harness, and the first turn sees
them. With (b), base code would read `host.startup` and decide the same.
+++ 7. The notes view asks for sharing
`Notes`'s factory declared `self.get(ShareStatus)`, a local type of the sharing plugin. Nobody serves it on W: the
request is unbound `not_served`, indexed under the name. `Notes` parks `failed { waiting, "waiting for ShareStatus: not
served on Session S1" }`. T's reference shows the same; a call from T rejects at once with that cause. No backoff, no
polling, no 60-second wait.
+++ 8. The phone changes networks
T's link to S drops. T's reference goes `loading`: its request stays, its last value stays readable, a call made now
parks. A call that was in flight fails and is not resent. T reconnects; the request is held again on the new link; W
answers as before: `failed { waiting }`.
+++ 9. Sharing comes back, with a new contract
In the afternoon a rollout brings the sharing plugin back at revision R+1, where `Sharing` on the server is v2. S
installs first and serves `Sharing` v2. W's install is queued; nothing on W asks for `Sharing` yet, because the sharing
plugin is not installed there, so nothing changes for W. (Had W still run a sharing facet built against v1 without an
adapter on S, its requests would show `failed { waiting, version }` until W installed: the ordinary window of a
server-first rollout.)
+++ 10. W installs R+1
W's install commits: a publication. It serves `ShareStatus` again: the index wakes `Notes`'s request, which binds.
`ShareStatus` activates, holds the server's `Sharing` at v2 (W's new code bundles v2), goes live, and `Notes` passes its
dependency check, opens what it needs and goes live. T's reference becomes `live` without T having done anything.
:::

What did not happen is the point. Nothing waited for a deadline; nothing retried on a timer; no reference ended
because a plugin was missing; no host waited for another host's activations; and every waiting object said what it
was waiting for.

# Scenarios: Starting Up {#sc-startup lede="Twenty startups on p2's real hosts, under the model, with the barrier as (a) and as (b)."}

These scenarios, from Astra, follow p2's real hosts: the server alone, workers started by a tab or by another worker,
web tabs, the TUI, restarts in the middle. Each row says what the model does, with the barrier in both shapes where
they differ, and what today's code does. The pattern across all of them: publication never waits for activation, so
dependency traffic between hosts always moves; what differs between (a) and (b) is only when base code is told that
the first pass is over, and neither shape promises every tool before the first turn.

The Rule column cites sections of the working document, reproduced in appendix C.

| # | Scenario | Under the model | Today | Rule |
| --- | --- | --- | --- | --- |
| 1 | The server starts alone. Catalog, ModelConfig, LoginService and ForwardStore initialize before any session worker exists. | Their local references are `loading` during initialization, then `live` or `failed` with an own cause. Under (a), `load` waits for these first outcomes; under (b), it returns after publication. Public admission still needs explicit security prerequisites; a completed first pass is not proof that every service works. | p2 starts its HTTP listener but gates requests and upgrades behind plugin startup (`apps/p2/src/hosts/server.ts`). Current next waits for eager objects' first live/failed outcomes (`host/host.ts:load`). | §§1–3, 6 |
| 2 | A tab's request reaches the server before its first facet publication. Catalog is declared by a later setup in that same load. | The request stays `loading` behind the publication gate. The complete declaration batch places it; Catalog activation then produces `bound` and the reference becomes `live`. Neither (a) nor (b) delays that hold until unrelated eager objects finish. | Current next's `Hold.start` waits for `pendingLoad`, which includes every eager object's first outcome (`remote/hold.ts`). It waits longer than declaration safety requires. | §§1, 4, 6 |
| 3 | Several server facets set up successfully, but the last setup throws. A tab is already waiting for Catalog. | No partial declaration batch may activate objects. Load fails and the host closes; local held references become `ended`, while the tab sees a link drop and remains `loading`. A replacement server's successful publication can satisfy the tab's retained request. | Current next closes the host on a throwing setup and activates no objects (`host/host.ts:load`). Setup failure rejects load directly. | §§1, 6, 10 |
| 4 | A session worker's Harness opens slowly. Its CodemodeRuntime startup object declares Harness and contributes tools only after its own sandbox opens. | Harness and CodemodeRuntime start `loading`; CodemodeRuntime waits without a dependency timer. Harness becoming `live` wakes CodemodeRuntime, which opens its sandbox and becomes `live`. Under (a), this local chain finishes before load returns and resume; under (b), the application must await the same startup outcomes or risk a first turn without those tools. | p2 resumes after Harness is ready, before `host.ready()` (`apps/p2/src/hosts/worker.ts`); CodemodeRuntime depends on Harness (`plugins/codemode/worker.ts`). Current next's load barrier waits for both first outcomes. | §§3, 6, 11 |
| 5 | A tab opens Chat for a stopped session. The server starts that session worker, whose Search Indexer needs server SearchFeed. | Chat remains `loading` while the route starts the worker. The worker connects and publishes before its application barrier; SearchFeed can bind immediately on the already-published server. Indexer becomes `live` when its prerequisites are ready, and Chat receives `bound` once its own prerequisites are ready. Under (a), a still-remote startup blocker can already count as a parked first outcome; neither option guarantees that every remote-backed feature precedes resume. | p2 connects IPC first but the parent admits it only after `control.ready()`; Harness resumes before the later `host.ready()` (`src/hosts/worker.ts`). Current next gates incoming holds on whole-host load (`remote/hold.ts`). | §§1, 3–4, 6 |
| 6 | A running worker calls ConversationBroker on the server. The broker sends to another session whose worker is stopped. | Only the second worker starts a new publication and first-pass sequence. Its PeerConversation reference is `loading` until that view binds; the first worker and broker remain `live`. Under (a), the new worker's scheduler waits for its first-pass report; under (b), its application must supply that admission rule. This call does not reopen the first worker's startup barrier. | p2 gets PeerConversation inside the broker's call and starts its worker through the session route (`plugins/conversations/server.ts`, `src/runtime/server.ts`). The spawned worker uses p2's Harness-before-host-ready ordering. | §§3, 6, 8 |
| 7 | Many tabs open the same stopped session while other tabs open several different sessions. | Requests to one worker share route resolution and provider identities where their principals match. Each tab's reference starts `loading` and becomes `live` on its own binding. Both barrier options remain per host; a slow worker cannot hold back every other worker's first turn. The application shows per-session startup status, not one global ready flag. | Current next shares resolution per route address (`host/route.ts`). p2's SessionHosts also serializes starts per session (`apps/p2/src/runtime/server.ts`). | §§1, 6 |
| 8 | During server startup, an eager Bootstrap object needs a worker's Agent. That worker's eager FeedOwner needs the server's independent Catalog. | Server and worker publication happen independently of their first-pass reports. Catalog binds while Bootstrap is still `loading`; that wakes FeedOwner, then Agent and Bootstrap can become `live`. Both (a) and (b) avoid a host-ready gate on this dependency traffic. The acyclic object graph needs no timeout to make progress. | Current next can deadlock its whole-host load gates until activation deadlines fail attempts: the Agent hold waits for worker load, while the Catalog hold waits for server load (`host/host.ts`, `remote/hold.ts`). This is an architectural example using p2-style server/worker dependencies, not a claim that p2 has a Bootstrap plugin. | §§1, 4, 6 |
| 9 | The worker has a healthy Harness, but its `p2.subagent-tools` startup object still waits for server Subagents. The first generation is ready to run locally. | `p2.subagent-tools` remains `loading` while its remote reference binds, or `failed` with `waiting` if that provider is unavailable. Under (a), the remote wait can settle its first outcome without its contribution; under (b), publication returns even earlier. Server `bound` later wakes `p2.subagent-tools` and publishes its tools for future phases. If the first turn requires those tools, application admission must wait explicitly. | p2 `p2.subagent-tools` declares both Harness and server Subagents (`plugins/subagents/worker.ts`). Its worker resumes Harness before admitting the upstream-dependent host objects (`src/hosts/worker.ts`). | §§2–4, 6 |
| 10 | In a p3 port, the core serves a Models registry whose empty composition is valid. The optional models contributor is absent when the worker starts. | The registry is usable, so this absence alone does not park Harness; Harness can become `live`. Neither (a) nor (b) waits for an uninstalled contributor. The generation's model selection or application admission must report model unavailable and wait for a contribution. Registry publication later wakes that domain-level wait; it is not a missing-provider activation failure. | p2 instead awaits the `HarnessConfig` default entry inside Harness's Durable opener (`src/runtime/worker.ts:serveHarness`). Without the models contribution, that opener does not finish normally. | §§3, 6, 9 |
| 11 | A session is configured for SSH. Harness's execution opener finds that the environment is invalid or cannot open. | Harness becomes `failed` with its own `transient` cause, or `broken` if the opener marks the error permanent. Dependents still before their readiness check become `failed` with `waiting`. Under (a), this is a first outcome, not a healthy Harness; under (b), load already returned but resume still requires a usable Harness. Effect retry or a configuration-triggered retry can later make it `live`; no local-execution fallback is implied. | p2 opens the session machine during Harness activation and fails rather than silently using the local machine (`src/runtime/worker.ts`). Worker startup failures are surfaced and can require explicit retry (`src/runtime/server.ts`). | §§2–3, 6, 11 |
| 12 | Prompt becomes live before its initial local instruction-file read finishes. A user immediately sends the first message. | Prompt's reference can be `live` while its file-loading work continues. Under (a), its InputGate contribution is present before a normal local first pass completes; the gate still controls when local input may proceed. Under (b), the application must ensure that contribution exists before admitting input. The model does not turn background file loading into a host-wide barrier. | p2 contributes InputGates and awaits the initial local load in its prompt sections; remote instructions deliberately load in the background (`plugins/prompt/worker.ts`). Object readiness is already distinct from instruction readiness. | §§3, 6, 9 |
| 13 | Search starts an archived session worker only to rebuild its historical index. Indexer has a long scan to perform. | Once SearchFeed and Harness are usable, Indexer becomes `live` even while its `scanned` state is false. Both (a) and (b) leave scan completion to the explicit IndexScan operation. The archived-worker application keeps Harness scheduling paused, waits for the scan result and then stops the worker. A startup report does not override that resume policy. | p2 passes `resume:false` for archived index-only starts, exposes `IndexScan.scanned`, and stops the archived worker after rebuilding (`plugins/search/server.ts`, `plugins/search/worker.ts`, `src/hosts/worker.ts`). | §§3, 6 |
| 14 | After a worker starts, a tab opens Workspace for a large directory. Its filesystem watcher is slow to initialize. | The on-demand Workspace reference is `loading` until the backend is usable, then `live`. Its background watch may still be starting. Neither barrier option waits for every future Workspace view or directory watch; a component that needs a complete initial scan must use explicit domain readiness. | p2 deliberately returns the Workspace backend before installing a potentially slow watcher (`plugins/workspace/worker.ts`). This work is not a universal worker-start prerequisite. | §§3, 6 |
| 15 | A worker restores durable work that can resume immediately. No new Chat.send call occurs, so there is no incoming-input gate to intercept it. | Harness opens with scheduling paused and can become `live` before all startup contributors. Under (a), base code resumes after the first-pass report and required application checks; under (b), base code must await equivalent outcomes itself. Input gates on new messages do not guard this replay. Each phase pins the contributions present when that phase begins. | p2 explicitly calls Harness.resume before `host.ready()` (`src/hosts/worker.ts`). Its Durable registry adapter snapshots the extension table per phase/version (`src/runtime/durable.ts`). | §§6, 9 |
| 16 | A previously loaded web tab starts while the server is offline. Its local UI facets can render an offline shell. | Publication of the tab's local facets does not require the server. Remote references stay `loading` on the absent path. Under (a), remote blockers can count as parked first outcomes; under (b), declaration publication returns directly. The shell renders, and later connection plus `bound` messages make the affected views `live`. | p2 starts reconnection before facet installation and renders React without awaiting a whole-host ready promise (`src/hosts/web/main.tsx`). It already supports an offline shell after the page has been loaded. | §§1–2, 6 |
| 17 | A TUI candidate loads before its launcher activates BridgeLink. A startup UI object declares a server reference, whose outgoing frames are buffered. | The reference remains `loading` on a remote dependency. Under (a), that remote wait is a parked first outcome, so candidate preparation can finish; under (b), publication alone finishes. Launcher activation flushes the frames, and `bound` wakes the UI object. Do not replace this dependency declaration with an own native opener that waits indefinitely for launcher activation. | p2's setupTui awaits facet load while BridgeLink buffers frames until `activate` (`src/hosts/tui-worker-runtime.ts`). Adding an eager remote-dependent host object under the old full-ready load rule could stall candidate preparation until a deadline. | §§1, 3, 6, 11 |
| 18 | A tab starts a worker, but the process crashes while Harness is still opening. The server launches a replacement. | The tab's Chat reference remains `loading` across the lost path and replacement startup. The replacement has its own publication and first-pass cohort; successful binding makes Chat `live`. Both (a) and (b) must keep transport/start failure distinct from a healthy startup report. A process manager may surface a startup error and require user retry rather than retrying forever. | p2 records worker startup failures and has an explicit retry path; it does not treat every failed boot as an automatically healing object (`src/runtime/server.ts:SessionHosts`). Current next's route layer independently retries failed resolution (`host/route.ts`). | §§1–2, 6, 11 |
| 19 | The server restarts while a worker is still starting. A detached terminal host already owns running PTYs. | Tabs see their server and worker references become `loading`; new hosts publish and bind them again. The application may stop old workers on parent loss, while the detached PTY owner survives. The old server's unfinished first-pass wait settles on close (its entries end). New startup reports must not wait for the detached PTYs to restart. | p2 workers stop on IPC disconnect, while the terminal driver detaches its socket without killing the detached PTYs (`src/hosts/worker.ts`, `plugins/terminals/detached.ts`). Current next settles ended objects through its existing load settlement path. | §§1, 6, 10 |
| 20 | A startup contributor in a v2 port reads a keyed configuration document from a local store. The store is live, but the first requested key still needs hydration. | The contributor remains `loading` until that pin is ready; store-live alone does not make the dependency usable. Under (a), this local key-loading work remains part of the first pass, then the contributor can become `live` and publish before resume. Under (b), publication returns earlier, so the application must await that readiness if the first turn needs the contribution. | Current next loads dependency pins before opening the consumer's natives and before its settled promise completes (`host/attempt.ts:pinKeys`). Its activation deadline currently also bounds this wait. This is a v2-port example, not an existing p2 keyed API. | §§3, 6, 11 |

# Scenarios: References, Holds and Calls {#sc-refs lede="Getters, holds, calls, link drops, relays, release and revocation, played through."}

Fable's scenarios use p2's names: `Catalog` and `Hosts` (the sessions plugin, on the server), `Sessions` (on the
server, called from worker tools), `SessionTransfer` (a worker type the server calls for a fork), `Notes { session }`
(a worker type a tab holds), `NoteStore` (local on the worker), `ForwardStore` (ports, on the worker) and `Forwards`
(radius, on the server), and `Harness` (host-lifetime, on the worker). S is the server, W1 the worker of session S1, T
a web tab. The pattern: a request waits where something is under way and answers where nothing is; nothing a holder
does is needed to recover; and an ended holder leaves nothing behind in any index.

The Rule column cites sections of the working document, reproduced in appendix C.

| # | Scenario | Under the model | Today | Rule |
| --- | --- | --- | --- | --- |
| 1 | `self.get(NoteStore)` in `Notes { S1 }`'s factory on W1; `NoteStore` is served and activating. | `Notes` makes its request, it binds to the `NoteStore` object, `Notes` parks `loading`. `NoteStore` goes live: a target state change wakes `Notes`, which opens its natives and goes live. No timer ran. | The same wait, bounded by `readyTimeout`; past it `Notes` fails `transient` and backs off (`attempt.ts` `waitFor`). | §3.1, §3.4, §4 |
| 2 | `self.get(Catalog)` from W1's `ForwardStore`; the parent link is up, S has published, `Catalog` is served there. | The request goes over the parent (`hostAddress: () => Server()`); S binds the hold; `bound` arrives; `ForwardStore` was `loading`, now goes on and live. | The same, after S's whole barrier (`Hold.start` awaits `pendingLoad`). | §1, §2 |
| 3 | The same, but `Catalog`'s plugin is not installed on S. | S indexes the hold `not_served` under "p2.catalog" and answers `failed { waiting, not_served }`; `ForwardStore`'s reference shows `failed { waiting }`, the object parks `failed { waiting, "waiting for p2.catalog: not served" }`. A reload on S serving `Catalog` re-runs the hold: `loading`, `bound`; the reference goes live, the dependent wakes. No backoff, no new hold. | The hold is refused `broken`; `ForwardStore` fails `transient` and re-holds every 1-60 s, refused each time (`remote/hold.ts` `#refuse`, `object.ts` backoff). | §1, §3.1, §4, §5 |
| 4 | `self.get(SessionInfo)` on W1 when the core facet is missing (same host, not served). | The request is unbound `not_served` on W1 itself; the dependent parks `failed { waiting }`; a reload serving the type binds it and wakes the dependent. | `#assertRoute` throws in the factory: the object is `broken` until `retry()` or a reload (`host.ts` `reference`). | §1, §3.1, §4 |
| 5 | A tab's `NotesView` declares `Notes { S1 }`; S routes `Session`, `resolve` forks W1, W1 connects and publishes. | The hold waits at T on its path (`no_link` while S resolves: `loading`), is relayed to W1, waits there `unpublished` until W1's setups, then binds; `bound` comes back through the relay. `NotesView` was `loading` the whole time and goes live. | The same chain of waits, each bounded by `readyTimeout`; a slow worker start past it fails the tab object `transient` and polls. | §1, §6.2 |
| 6 | `host.get(Notes, { session }, ctx)` from a tab's page code while W1 is starting. | The getter waits while the reference is `loading`, up to its `readyTimeout`, then rejects with the cause and releases its request. It resolves as soon as `bound` arrives. | The same. | §8 |
| 7 | `host.get(Catalog, {}, ctx)` on W1 when S does not serve `Catalog`. | The reference becomes `failed { waiting }` at the first answer; the getter rejects at once with "not served on server" (recommended; owner's choice to wait instead). | Rejects at once too (a broken failure), after the refused hold's `failed`. | §8 |
| 8 | `host.hold(Catalog, {}, ctx)` on W1 before W1's `load` ran. | The reference is returned at once, `loading` (`unpublished`); W1's publication places it over the parent; it follows the object for its whole life: `loading`, `live`, `failed { waiting }` if S drops the plugin, `live` again when it comes back. | Returned at once; placed once `load` resolved (`host.ts` `#hold` races `load`); a removal ends it for good with `gone`. | §1, §8, §5 |
| 9 | `host.hold(Missing, {}, ctx)` for a local type nobody serves here. | `loading` before the publication, `failed { waiting, not_served }` after it; a reload serving it binds the same reference. | Throws `unavailable` at once after `load`; before `load`, fails the reference broken once it resolved. | §8 |
| 10 | `await host.registry(HarnessModels, ctx)` by base code when the models plugin is missing. | Rejects at once with `unavailable/undeclared` (`waiting`); code that wants to wait declares the registry in an object or holds. A served registry whose first `compose` threw rejects the same way (`compose`). | Rejects at once (slice 8 build). | §8, §9 |
| 11 | `ctx.get(Sessions, {})` inside a worker tool through `host.root` (`plugins/sessions/worker.ts`) while the parent link is down. | The request waits on the path (`no_link`, `loading`); the getter waits up to `readyTimeout`; the link comes back, the path re-holds, `bound`, the getter resolves. The request ends when the tool call settles. | The same (`ctx.ts` `CallContext.get`, `path.ts` re-hold). | §1, §8 |
| 12 | A call `notes.add(args, ctx)` on a reference whose object is `loading` (W1 restarting). | The call parks in the reference's queue with its own `readyTimeout`; `bound` flushes the queue in order; past the deadline it rejects `unavailable/park_timeout`. | The same (`host/parked.ts`). | §8 |
| 13 | A call on a reference that is `failed { waiting }` (the plugin is not there). | Rejects at once with the cause, no parking: nothing is under way. | Rejects at once (the reference is failed). | §2, §8 |
| 14 | A call already sent to W1 when the IPC link drops. | The call fails `unavailable` and is never resent (its outcome is unknown); the reference goes `loading`; calls made after the drop park until the re-hold's `bound`. | The same (`consumer.ts` link close). | §2, §5 |
| 15 | The parent link drops while `ForwardStore` is parked `loading` on `Catalog` (S restarting). | The request stays on the path (`no_link`), `ForwardStore` stays `loading`; the reconnect holds it again, S answers `loading { attempt }` or `bound`; the dependent wakes on the state change. No deadline on the wait. | The dependent stays `loading` until `readyTimeout`, then `transient` with backoff (the audit's choice 6). | §1, §3.3, §4 |
| 16 | A route link to W1 drops while T holds `Notes { S1 }` through S's relay. | The relay sends `loading` downstream, rejects relayed calls in flight `unavailable`, re-resolves the address with the route backoff, holds again upstream with the kept request; `bound` is forwarded. The tab's dependents stay `loading`. | The same (`relay.ts`); the route backoff stays. | §1, §4, §11 |
| 17 | T's own link drops while its hold for `Notes { S1 }` is still unbound at W1 (`not_served`). | S sends `closed { origin }` upstream; W1 drops the indexed hold with the origin: no leak. T reconnects and holds anew. | The same for refused holds (`provider.ts` origin close). | §1, §10 |
| 18 | A tab closes while `NotesView` is parked on `Notes { S1 }`. | Its last holder releases: a parked object ends at once (it is not live, so no `linger`); its requests end, the relayed hold is released upstream, the index entries go. Nothing keeps the chain. | The same (`object.ts` `#idle`). | §1, §3.5, §10 |
| 19 | `host.revoke({ grant })` while a guest's objects on W1 are parked and its tab's holds wait unbound. | Every request of the principal ends, bound and unbound, at every hop: the parked objects end `forbidden/revoked`, the tab gets `gone` for each hold, the child link closes. Nothing revives them; a new login holds anew. | Bound objects end, holds waiting for `load` are ended (`host.ts` `revokeWaiting`); refused holds are released with the link. | §10 |
| 20 | A worker with nothing live: a tab holds `Notes { S1 }` but the notes plugin is missing on W1. | The unbound hold counts in `host.activity.references` from its arrival, so the supervisor does not stop W1 while the tab waits; it is not in `host.references` (presence lists bound references only). | A refused hold is not counted: the worker stops idle, restarts on the next hold, refuses again. | §10 |
| 21 | S holds `SessionTransfer` on W1 for a fork while W1's `Harness` is parked on the models registry (not served). | The hold binds to `SessionTransfer`, whose attempt parks on `Harness`: `loading`, then `failed { waiting, "waiting for p2.harness: waiting for registry …" }`, with the chain in the message; S's `ctx.get` rejects at once with it. A reload on W1 serving the models plugin wakes the harness, then `SessionTransfer`; a later `ctx.get` binds. | `SessionTransfer` fails `transient` after `readyTimeout`, polls; S's getter rejects at its own deadline. | §3.1, §3.4, §8 |
| 22 | `ref.retry()` from a tab's Retry button on a `failed { waiting }` reference whose blocker on W1 is `broken` (a throwing factory). | The retry passes over the link (`retry { hold }`) to the parked object, which passes it to its `broken` blocker: a new attempt; `waiting` blockers are passed through, `not_served` ones untouched. If the blocker goes live, the chain wakes. | `retry` reaches only the object the hold is on; a refused hold is started again. | §3.7 |
| 23 | Keyed pin: `Notes` pins `store.drafts.at(key)` on `NoteStore`; the key's load fails at the provider. | The pin is a dependency: `Notes` parks `failed { waiting on p2.note-store.drafts[key] }`; the provider's re-bind of that member (a retry) wakes it. | `dependency_failed` transient with backoff (`attempt.ts` `pinKeys`). | §3, §4 |

# Scenarios: Providers, Versions, Registries {#sc-providers lede="Plugins missing, added, removed and broken; versions that do not fit; registries and the harness."}

Opus's scenarios cover the provider side: plugins that are missing, arrive by a reload, are removed or break; versions
that fit through `accepts` or do not; registries with missing providers, skewed versions and last good values;
`self.follow` over a harness that restarts; and reloads of an object's own code. The pattern: what used to be `broken`
or polled becomes `waiting`, woken by the one event that can fix it, and an object's own code is still the only thing
that breaks it.

The Rule column cites sections of the working document, reproduced in appendix C.

| # | Scenario | Under the model | Today | Rule |
| --- | --- | --- | --- | --- |
| 1 | Worker W1 has no drafts plugin. Chat (chat plugin, on W1) declares `self.get(DraftStore)`. | Chat's request is unbound `not_served` and indexed under `DraftStore`. Chat is `failed { waiting, "waiting for DraftStore: not served" }`, with no timer. A tab's Panel holding Chat shows the same cause, and its calls reject at once. | `#assertRoute` throws in the factory, so Chat is `broken`. Only `ref.retry()` or a reload recovers it (`host.ts`). | §1, §2, §3.1 |
| 2 | A reload adds the drafts plugin to W1 while Chat waits (1). | The reload's commit publishes `DraftStore`. The index wakes Chat's request, which binds; DraftStore activates and goes live. Chat leaves parking, opens its natives and goes live; Panel goes `live`. | Chat stays `broken` unless the reload retries broken objects. | §4, §5 |
| 3 | Server S has no models plugin. On W1, the models plugin's host-lifetime ModelRuntime declares `self.get(ModelConfig)` (placed on S). | S keeps W1's hold as refused, `not_served`. ModelRuntime is `failed { waiting }`. W1's `load` counts it as a first outcome (parked on another host). The harness runs, and its generations report "model unavailable". | S refuses `broken` (`remote/hold.ts #refuse`). ModelRuntime is `transient` and polls: each backoff tick (1-60 s) makes a new hold across the link and reports again, for the host's life. | §1, §3, §6.3 |
| 4 | S gets the models plugin by a reload (3, continued). | S's commit re-runs its refused hold and sends `loading { hold, attempt }`, then `bound`. ModelRuntime wakes, opens its native and contributes to `HarnessModels`. The harness's next generation finds a model. | The next backoff tick re-holds; recovery waits up to 60 s. | §4 |
| 5 | A reload removes the ports plugin from S. Tabs hold `PortsView`; Radius (live) reads the `radius.forwards` registry that Ports contributed to. | PortsView's objects end, and their holds become unbound `not_served`: the provider sends `failed` on the bound hold, and the tabs show `failed { waiting }`. Radius gets a table without Ports, composes the empty value and keeps working. A later re-add re-runs the kept holds, which bind again. | The holds get `gone` and the references end for good (design §21). A re-add cannot revive them. | §5, §9 |
| 6 | A reload removes W1's file-index plugin. The live Files object (files plugin) holds `self.get(FileIndex)` locally. | Files' `Binding` becomes unbound `not_served`. Files stays live (R18). Its member sources keep their last values, and calls through that reference reject with the cause. When file-index is re-added, the binding binds again and the members re-bind by name (one frame). | The reference ends `released`; Files can never use FileIndex again without a restart. | §5 (locally), §3.10 |
| 7 | After a sessions plugin update, S's Catalog factory throws. W1's Chat waits on Catalog; a tab's Panel waits on Chat. The user presses Retry on Panel. | Catalog is `broken`; Chat and Panel are `failed { waiting, "waiting for Catalog: …" }`. Retry passes on hop by hop (T, then S's Catalog, through W1) and retries Catalog once. If the cause is gone (the config is fixed), Catalog goes live and Chat, then Panel, wake. | Chat polls by backoff with new holds. Retry on Panel retries only Panel, which is still blocked. | §3.7 |
| 8 | S's EnvManager (envs plugin) opens an SSH connection that fails because the remote host is offline. W1's environment objects wait on S's env views, which wait on EnvManager. | Only EnvManager backs off (`transient`, its own `retryAt`). Its dependents are `failed { waiting }` with no timers. When SSH comes back, EnvManager goes live and the chain wakes in order. A `host.get` on a dependent rejects at once (it is `waiting`); a hold just shows it. | Every level runs its own 1-60 s backoff and re-holds across the link at every tick. | §3.1, §3.3, §8 |
| 9 | A reload of the terminals plugin restarts S's TerminalService (natives: the terminal host process D). Terminals{session} objects are live and depend on it. | Native restart as in §21: new calls park while it is `loading`; running calls drain; natives close with reason `reload`; the factory runs; natives reopen. Its dependents stay live (R18); their calls park while it is `loading`. | The same; this is design §21, unchanged. | §5 (old calls), §3.10 |
| 10 | Worker W1 crashes while a tab views Chat{S1} through S. | S's relayed hold goes to its path, `no_link`, so the tab's reference is `loading` and its calls park, bounded. The route re-resolves (route backoff); the new W1 publishes, the held request binds, and a fresh `bound` reaches the tab. | The same, except a dependent that is activating fails at its 60 s deadline in between. | §1, §2 |
| 11 | A tab on Chat v1 meets W1 serving Chat v2 with `accepts[1]`. | The check accepts v1; the hold binds through the mappings (slice 7). The tab is `live`. | The same once slice 7 builds `accepts`. | §1, §5 |
| 12 | A tab on Chat v1 meets W1 serving Chat v3 without `accepts[1]`. | The hold is unbound `version`, so the tab shows `failed { waiting }` ("update the page") and its calls reject. The tab's own reload makes a new v3 request and releases the old one. If W1 rolled back to v2, the old hold would bind again in place. | Refused `broken`, or `gone` at the reload that dropped v1: ended for good. | §1, §5 |
| 13 | A tab reloaded to v2 holds Chat while W1 is installing v2. | W1 keeps the hold `installing`: the tab is `loading` and its calls park, bounded. W1's install commit re-evaluates the hold, which binds v2. If W1's install is rejected, the hold is re-evaluated at that end and becomes `failed { waiting, version }`. | Refused `broken` (`contract_mismatch`); design §21's `updating` is not built. | §5 |
| 14 | A plugin changed Chat's contract without bumping the version: a tab on v1 (fingerprint A), W1 on v1 (fingerprint B). | Unbound `version` (a fingerprint that differs at the same version), so `failed { waiting }`. It is not `broken`: the consumer did nothing wrong, and its next reload or a fixed provider heals it. | Refused `broken`, `contract_mismatch`. | §1 |
| 15 | A reload of chat makes Chat v4 accept v3 but drop v2. Tabs hold Chat at v2 and at v3. | Only the v2 holds unbind (`version`). The object, its v3 holds, documents, jobs and natives stay. | Design §21: the version's holds end with `gone`. | §5 |
| 16 | S has no web-shell plugin. Files, artifacts and terminals contribute routes to `Http`; proxy-marker reads `Http`. | The contributions wait in the table. Proxy-marker's reader is unbound `not_served` at once after the publication: `failed { waiting }`. A reload that adds web-shell serves and composes `Http`, the index wakes the reader, and it goes live. | Slice 8 S3: the reader fails `transient` (`unavailable/undeclared`) at once and is woken at the first value only. | §9 |
| 17 | The codemode plugin is reloaded alone with a `HarnessExtensions` token v3; the core harness serves v2. | Codemode's v3 contribution is left out and reported (`contribution_refused`). A reader bundling v3 is unbound `version`: `failed { waiting }`. A core reload to v3 makes it usable, which wakes the reader. | The contribution is refused the same way; the reader is `broken` (S2). | §9 |
| 18 | Core is reloaded alone, serving `HarnessExtensions` v3 with `accepts[2]` (contribution and value). | v2 contributions are adapted once per value; v2 readers get the composition mapped back once per composition. A reader at v1 (no mapping) is `failed { waiting, version }`. | The same, except the v1 reader is `broken` (S2). | §9 |
| 19 | The harness's `HarnessExtensions` compose throws at the first composition (an owner bug). | The registry is served but has no usable value, so the Harness's request is unbound `compose`: `failed { waiting }`. The barrier counts its first outcome. A reload that fixes compose makes the value usable, and the Harness wakes and activates. | S3: the Harness fails `transient` at once, woken at the first good value. | §1, §9 |
| 20 | Codemode contributes its sandbox (a native) to `HarnessExtensions`. Later another contributor's entry makes compose throw, and then codemode restarts. | While compose throws, `.value` keeps the last good composition. When codemode's contribution leaves, that last good value is dropped (it holds the closed sandbox), and `.value` throws until compose succeeds again. No reader is handed a closed native. | Slice 8 keeps the last good value regardless, so a reader could use the closed sandbox. | §9 |
| 21 | Transcript (on W1) follows the harness through `Harnesses.value.observeConversation(...)` and declares `retryOn(Harnesses)`. The harness's Session fails and the harness object restarts. | `self.follow` is Transcript's own step: S1 ends the observer `failed`, so Transcript fails `transient` (its own backoff). When the new harness contributes, `retryOn` wakes it, and it attaches to the new harness and gets one fresh frame. | The same (slice 8 S1 and `retryOn`); unchanged by the model. | §3 (follow), §3.8 |
| 22 | A reload of chat swaps the live Chat in place (no natives). Its new factory adds a `self.get(Sharing)`, and the sharing plugin is absent. | Owner item 4, recommended: Chat parks. Its holders see `failed { waiting, "waiting for Sharing: not served" }` and its calls reject until sharing appears. The alternative keeps the old code until the dependency resolves. | Not built (slice 7); design §21 swaps the object and opens its gate. | §3.9, §13.4 |
| 23 | Chat is parked on DraftStore (1). A chat reload ships code that no longer needs DraftStore. | One handover: the new attempt's requests bind first, then the old ones are released. Chat activates on the new code and goes live; the old `not_served` index entry goes. | Not built; today a broken Chat is retried by the reload (slice 7 plan). | §3.9 |
| 24 | A reload removes the models plugin from W1 while ModelRuntime is parked on S's ModelConfig (3). | ModelRuntime (host-lifetime) ends with its plugin. Its requests end, and W1's refused hold at S is released (a `release`). Nothing stays waiting. | The type's objects end (§21), and its backoff polling stops with it. | §3.5, §1 |

# Scenarios: Rollouts and Cycles {#sc-rollout lede="Delayed facets across hosts, rollout windows, chains over three hosts, and the probe at work."}

Sol's scenarios cover the windows in which hosts run different code: a server facet ahead of its worker facet and the
reverse, tabs older or newer than the server, installs that are queued, staged or rejected, a type moved between host
kinds; then chains across three hosts, diamonds and rings, the probe's own corner cases and a forged probe. Row 20 is a
case round 3 found against the previous draft; the rule that fixes it is in chapter VIII. The pattern: a version that
does not fit is a request waiting for a publication, never an error that ends it; an install answers only for its own
host; and a cycle is found by the attempt whose edge closed it.

The Rule column cites sections of the working document, reproduced in appendix C.

| # | Scenario | Under the model | Today | Rule |
| --- | --- | --- | --- | --- |
| 1 | The models plugin's server facet upgrades first. Browser and TUI model pickers still use its older Models contract, which the new provider accepts. | Their references remain usable through the old-version adapters. If an owning native restarts, affected references show `loading` until its fresh binding is ready. A caller that later installs the new contract releases its old request and makes a new one. | `host/host.ts:#assertMatch` accepts only exact versions and fingerprints. Accepted-version serving across reload is not built in next; p2 uses its older cluster reload runtime. | §1, §5 |
| 2 | A worker's new search facet makes SearchIndexer depend on SearchFeed v2. The server still serves v1; its search facet installs later. | SearchFeed's request is `failed { waiting }` for the version mismatch. SearchIndexer is also `failed { waiting }`, without a dependency retry timer. The server's later publication rechecks the request; SearchFeed becomes `live` and wakes the indexer. | A remote mismatch is refused as broken; its dependent fails transient and retries with backoff. See `host/attempt.ts` and `remote/hold.ts`; p2's real indexer declares this server dependency in `plugins/search/worker.ts`. | §2–5 |
| 3 | A new web workspace facet arrives before the selected worker's matching Workspace contract. The user opens the workspace panel during this window. | The panel's held Workspace reference becomes `failed { waiting }`; an awaited getter rejects under the recommended getter rule. The old worker object and compatible readers are unaffected. Installing the worker facet wakes the held request and supplies a fresh binding. | Exact-match refusal reaches the client; a dependent object can enter R18 backoff. Next has no install-aware wake protocol yet; p2's workspace UI and worker facets live in `plugins/workspace/`. | §2, §5, §8 |
| 4 | A tab sleeps while the worker upgrades Workspace and accepts its old version. The tab reconnects without updating its code. | The retained request shows `loading` while its path is down. Re-holding asks for the tab's original version, and `bound` supplies the mapped snapshot, returning it to `live`. No old method index is interpreted as a new one. | Path re-holding already exists in `remote/path.ts`, but unequal versions still fail in `host/host.ts`. Reload-time adapters are slice 7 work. | §1, §5 |
| 5 | The server publishes a new Models contract without accepting the old TUI version. The TUI launcher downloads its replacement bundle later. | The old TUI request stays held but shows `failed { waiting }`. The old runtime releases it when the launcher swaps workers. The replacement runtime makes a new-version request and can become `live`; the old request is not silently relabeled. | p2 polls for TUI bundles and swaps sandbox workers in `hosts/tui-client.ts`. Next does not yet implement reload-time version recovery. | §1, §5, §8 |
| 6 | The server and tabs already use revision R5 when a route starts a worker from an older plugin set. The worker connects before loading its current facets. | Business requests stay `loading` until publication or show `failed { waiting }` against published incompatible code. The loader installs the desired code set without awaiting activation. Publication then rechecks waiting requests and the actual objects activate; a route must not wait for the worker's activation barrier before admitting its link. | p2 sends selected worker facets through WorkerInit and uses a separate control-ready sequence. Next has the publication/activation admission deadlock described in `host/host.ts:load` and `remote/hold.ts:start`. | §1, §5–6 |
| 7 | A tab installs new workspace code while the worker's matching install is queued but has not started. | The old worker answers `failed { waiting }`, not `loading` merely because another host knows an upgrade is planned. A held reference survives; a getter rejects. The worker's own install and its completion re-evaluate the request, so it can later become `live`. | Next has no revision/install status handling; it returns an exact-match failure. The model deliberately accepts this rollout-window blip instead of adding revision fields to mismatch messages. | §2, §5, §8 |
| 8 | The worker's search facet stages a new contract, so an incompatible request is held as installing. Staging fails and the old search code remains published. | The request was `loading` during the install. Rejection is an install-end event even without publication, so the request is checked against the old provider and becomes `failed { waiting }` for the remaining mismatch. Its getter rejects rather than waiting forever for a commit that will not occur. | Next has no installer. p2's `hosts/server.ts:performReload` retains published code and bundles when preparation fails, through a different reload protocol. | §4–5, §8 |
| 9 | A worker's own envs facet install is rejected while it needs a capability from the new code set. A provider elsewhere becoming ready cannot repair that rejected local install. | Requests blocked by the worker's own rejected install fail promptly with its reason. Published old code is not replaced by half-installed new code. A later successful local install or explicit retry is needed; waiting for a remote activation is not an install strategy. | Next has no own-install state. Design §21 specifies the prompt own-rejection rule; p2 reports reload refusal while retaining its previous selection. | §5 |
| 10 | The worker ports tool facet is added before the server ports facet. The tool is registered successfully, but the first invocation looks up server Ports with `ctx.get`. | The tool owner remains `live`: this is a call-time lookup, not a declared factory dependency. The missing Ports request is `failed { waiting }`, so the invocation reports unavailable and its call-scoped request ends. After the server facet publishes, a later invocation can acquire a live Ports object. | This is how `plugins/ports/worker.ts` declares the tool: its callback does `ctx.get(Ports)`. Next's remote lookup currently receives a broken refusal; no provider-publication recovery is built. | §1–3, §5, §8 |
| 11 | The server removes Ports first, while old worker tool code and an old browser Ports sheet remain loaded. The worker and browser facets update afterward. | The browser's held request becomes `failed { waiting }` without ending permanently. Ordinary live worker owners stay `live`; their next Ports lookup fails while the provider is absent. Updating those consumers removes obsolete surfaces, or a later provider publication can restore a still-held request. | p2 normally refuses removal when outside-batch consumers still hold a removed type (`hosts/server.ts:refuseHeldRemoval`). Next's target design originally ended removed-type references; the retained-request behavior is new. | §3.10, §5 |
| 12 | Notes(session=7) moves from a server facet to a worker facet. An old tab still computes the server address; a new tab computes worker 7. | The old request stays at the old address and shows `failed { waiting }`; publishing Notes on the worker cannot wake it there. The new tab routes to worker 7 and can become `live`. Updating the old consumer computes a new address and creates a new request; the model adds no redirect. | Placement is already computed by the caller and checked by the provider in `host/placement.ts`. Next has no relocation reload implementation. | §1, §5 |
| 13 | Worker 1 still serves Notes v1 for its own session. Its new code requests Notes v2 placed on worker 2, which already serves v2. | Resolution chooses worker 2 before checking its version. The request can become `live` without waiting for worker 1's unrelated registration to upgrade. Worker 2's `bound` wakes any dependent waiting on that request. | `host/host.ts:#assertRoute` checks a same-name local registration before `Placement.reference`, so worker 1's v1 can wrongly reject this v2 request. | §1 |
| 14 | The models plugin's server facet updates now, but the worker facet updates hours later. Each host has its own native model registry and compatible local contributors. | Each host composes its own table and its local consumers can stay `live`. A worker does not wait for the server's registry revision: native registries are host-local. Only an actual remote object contract used between those facets creates a cross-host version wait. | p2 also has independent server ModelConfig and WorkerModels resources (`plugins/models/server.ts`, `worker.ts`). Next's registry adapters already handle local reader/contributor versions; atomic registry replacement is not built. | §5, §9 |
| 15 | A tab Panel depends on a worker SessionView, which depends on a server Catalog view. Catalog's new facet arrives last. | Catalog's missing request is `failed { waiting }`; SessionView and Panel show waiting with the nearest blocker and root cause. The server publication binds Catalog and makes it `live`. Its state change wakes SessionView; that provider's `bound` then wakes Panel, with no dependent backoff loops. | R18 retains dependency references but fails dependents transient and uses identity backoff. `host/object.ts:dependencyLive` already skips that backoff on a live event; registration-based recovery is missing. | §1–4 |
| 16 | A server Summary waits for views on two workers. Both views reach a shared local CatalogStore on the server, whose own required provider is absent: a diamond, not a cycle. | CatalogStore is `failed { waiting }`, and waiting propagates through the views to Summary. Probes reach the common store, but its unavailable request has no target attempt and no edge back to Summary. It must not report `invalid/cycle`; adding the missing provider later wakes the chain. | Current local waiting-edge traversal and trusted activation chains distinguish cycles from shared dependencies. Dependency failures still use R18's transient/backoff path (`host/object.ts`, `host/attempt.ts`). | §3–4, §7 |
| 17 | Thirty-three object attempts on trusted server/worker links form a ring and start together. Each reference resolves to the next attempt in that ring. | All participants stay pre-activation, showing `loading` or waiting according to their blockers. With answer (A), the attempts waiting across links time out after `readyTimeout`, retry with backoff, and the activation chains of the later attempts find the ring. With answer (B): the attempt whose edge closed the ring last starts a search; it returns, a check along its recorded path returns, and the initiator fails `broken invalid/cycle`; propagation breaks the others and the dependents off the ring. The probe carries its trail of 33 hops; no cap cuts it. | Concurrent cross-host cycles can escape fixed activation chains and rely on readyTimeout/backoff. `host/object.ts:assertNoCycle` and design §6 document that limitation; next has no probe. | §3.1, §7 |
| 18 | A ring is being confirmed when one worker reloads its facet and removes its outgoing dependency, repairing the ring. Some probe returns are already in flight. | With answer (B): New attempts have new ids, and obsolete target ids are discarded. If the check passed before the repair, the ring is reported (it existed when the check began); if the repair came first, the check dies at the replaced attempt and nothing is reported. Unchanged attempts can therefore become `broken invalid/cycle` and need `ref.retry()` or their own plugin reload; provider readiness alone does not retry broken objects. | Next has no probe or reload implementation. Broken cycle failures already require retry, and `host/object.ts:retry` starts another attempt. | §3.6–9, §7 |
| 19 | A malicious tab learns a worker attempt id and sends a forged probe naming that same attempt as its initiator through the server relay. | With answer (B): The server drops the probe because it arrives on a child link, before any forwarding. The worker object and legitimate references keep their states. A child link never carries cycle evidence. | There is no probe message today. `remote/provider.ts` already strips activation chains from untrusted holds rather than trusting a child to declare ancestry. | §7.2 |
| 20 | A→B→C wait while C's return path to A is disconnected. Sixty-five unrelated initiating rounds pass through C before reconnect makes C→A a known edge. | With answer (B): Found in round 3 against draft 3 (C could have evicted every round from the ring). Under the model the re-hold gives C a new edge token, so C starts its own search; it crosses A and B and returns to C, the check along its path confirms, and C fails `broken invalid/cycle`. Foreign rounds and evictions play no part. | Current re-hold carries an activation chain (`remote/remote-object.ts:attach`), which can detect a small newly reachable ring; otherwise the dependency deadline remains its fallback. No probe-round cache exists today. | §7.2–3 |

# Open Questions {.epilogue lede="What the owner decides, and what slice 7's spec must still pin down."}

The model replaces five answers to "the provider is not there" with one: the request stays, the dependent parks, an
event wakes it. It ends the startup deadlock with a gate that lasts only for the synchronous setups, finds cycles with a probe
instead of a deadline (or, if the owner prefers, one narrowed deadline), and keeps timers only where no event can exist. Four reviewers played more than 300
scenarios against five drafts; the catalog in the chapters before this one is a selection.

## Decisions for the owner

1. **The barrier** (chapter VI): (a) Chord's `load` waits for the first outcomes of this host's host-lifetime objects,
   with the local-blocker rule; or (b) `load` resolves after the publication and the app reads `host.startup`.
   Recommended (a); Astra, Opus and Sol for (a), Fable for (b).
2. **Getters on `waiting`** (chapter IX): reject at once (recommended) or wait up to `readyTimeout`.
3. **`waiting` as a cause kind** (chapter III): a new kind (recommended; Opus, Fable), `transient` without `retryAt`
   (Astra), or `loading` with a diagnostic (Sol).
4. **A pure swap whose new factory needs a dependency that is not there:** the object parks (its gate closes, its
   holders see `loading` or `failed { waiting }`, calls park or reject; recommended), or it stays on the old code until
   the dependency resolves (old and new code would then overlap without bound, against §21's "a host is at R or R−1").
5. **The last good value** (chapter X): kept only while every contribution it was built from is still in the table
   (recommended; Astra), or kept as slice 8 decided, with natives in a registry looked up at use through their owner
   (Sol).
6. **Cycles across hosts** (chapter VIII): (B) the probe, with (B1) a re-search backoff that sends probes only
   (recommended) or (B2) a full search lifecycle with no timer at all; or (A) the slice 4b decision narrowed to one
   deadline, which polls chains across hosts again, misses a ring of waiting attempts, and retries in lockstep without
   finding the cycle it is for.

## For slice 7's spec

- The test list: the startup deadlock resolving without `readyTimeout`; an early hold placed here, not through the
  parent; remove-then-serve with a live dependent's calls recovering; a 1,000-hold publication wave under the window;
  the probe on long rings, diamonds, edge changes, reloads, relays, reconnects and forged probes; GC of a parked
  three-level chain after its top is released; every index entry gone after release, revocation and link loss.
- The local re-binding of a `Binding` (member sources, keyed pins, parked calls, presence) and the unbinding of a live
  hold under flow control, both with their race tests.
- The wire: `waiting` in the `failed` cause schema, the attempt id on `loading` and `failed`, the `probe` message, the
  pinned list; `PROTOCOL_VERSION` stays 1 until p3 ships.
- The design changes listed in appendix A, folded into `design.md` and the decision log in the same commit as the
  owner's decisions.

# What Changes {.appendix}

| Where | Today | Under the model |
| --- | --- | --- |
| R18, activation | a dependency that does not go live within `readyTimeout` fails the dependent `transient`; backoff 1 to 60 s | the dependent parks with no timer; `failed { waiting }` when a dependency failed; woken on every state change of a dependency; the deadline paused while parked |
| R18, the boundary | "live" means every dependency was live at the end of activation | the dependency check is the boundary: after it, a dependency leaving `live` is treated as after live |
| `self.get` of a missing `local` type | throws in the factory: `broken` | unbound `not_served`: `failed { waiting }`, woken by the publication that serves it |
| a remote hold the provider cannot serve | refused `broken`; the dependent polls by backoff | refused and kept at the provider, re-run at its publication; `failed { waiting }` |
| design §3, the destination | "served here" decides "here"; `placement` optional on `remote()` | the address decides; every remote type declares its `hostAddress`, renamed from `placement` (owner, 2026-10-29) |
| the start barrier, `pendingLoad` | holds wait for all of `load` | holds wait only for the publication; the barrier is (a) or (b) |
| S2, a registry reader newer than its provider | `broken` | `failed { waiting, version }` |
| S3, a registry without a value | `transient`, woken at the first value only | `failed { waiting }`, woken at every transition to usable |
| slice 8, the last good value | kept whenever `compose` throws | kept only while every contribution it was built from is still in the table |
| design §6, cycles | a walk on one host, chains across hosts, a documented gap closed by the deadline | the gap of simultaneous starts across hosts: (A) one narrowed deadline, or (B) a probe: a search per edge change, a check along the recorded path, edge tokens, `dead` notices |
| design §7, `host.hold` | throws for a missing local type after `load` | always returns a reference |
| design §7, getters | wait through every failure up to `readyTimeout`, reject on `broken` | wait through `loading` and `transient`; reject at once on `waiting` and `broken` |
| design §21, removal | `gone` to every holder | `failed { waiting, not_served }`; the request binds again when the name is served |
| design §21, a dropped version | `contract_mismatch`, final | only that version's requests unbind; the object stays |
| design §21, rollout | `updating` with revision fields and a deadline | each host knows its own install; `installing` re-evaluated at the install's end; installs never await activations |
| `FailureCause` | `transient`, `broken` | adds `waiting` |
| the wire | | `failed` cause `waiting`; the attempt id on `loading` and `failed`; with (B), one new message, `probe` (`search`, `check`, `dead`) |
| unchanged | | an object's own code reload (§21); R18 after live; `retryOn` outside parking; `self.follow`'s R4; the call window and flow control; revocation's semantics; no client providers |

# Glossary {.appendix}

**Attempt:** one try at activating an object: its factory, requests, natives; its own id since the model. **Bound:** a
request pointing at an object here or a hold over a path. **Dependency:** a request an attempt needs live before it
may go live (`self.get`, `self.registry`, a keyed pin). **Dependency check:** the moment all of an attempt's
dependencies are live; after it the attempt runs its own steps. **Edge generation:** a number of a wait edge, incremented by its
source whenever the request binds anew. **First outcome:** an object is live, failed by its own cause, or parked with no local
blocker still in its first attempt. **Holder:** whoever made a request and alone ends it. **Parked:** an attempt
waiting for a dependency, with no timer. **Probe:** the message that walks wait edges to find cycles: a `search`, then a `check` along the recorded path. **Publication:**
a host making its facets' declarations visible: `load`'s setups, a reload's commit, an install's commit. **Refused:** a
request without authority or with invalid params; never indexed. **Request:** what a reference stands for: type or
registry, params, principal, version. **Round:** the number of one search, from a counter per attempt. **Seen set:** the newest round number an
attempt has forwarded, per initiator (up to 256). **Unbound:** a request with no provider at the moment, with a reason (`unpublished`, `not_served`,
`version`, `compose`, `installing`, no link). **Waiting:** the cause of a failure that is not the object's own, woken by
an event. **Wait edge:** a parked attempt waiting for another attempt. **Wake:** an event that makes the resolver look
at a request again.

# The Working Document {.appendix}

The proposal as the reviewers checked it, `/tmp/model/model.md`, draft 4. Its section numbers are the ones the
scenario catalogs cite.

Status: proposal for the owner, not decided. Built in slice 7 with reload and rollout. Sources: the owner's direction
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
   attempt's own steps or its teardown is remembered.
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
kind `waiting`; `loading` and a `waiting` `failed` carry the provider's attempt id for the probe (§7).

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

## 7. Cycles

On one host, cycles are found exactly as today: at `self.get`, following the waiting edges of activating and parked
attempts. Across hosts, a hold carries the activation chain it was made in (today), which finds every cycle whose
objects start one after another. What remains is the documented gap (design §6): objects on two hosts that start at
the same moment and need each other. The owner decided on 2026-10-24 (slice 4b review decisions (2)) that this is a
documented limitation that times out and retries, with no probe message. Without dependency deadlines that timeout no
longer exists, so the gap needs one of two answers (**Owner**):

- **(A) The 4b decision, narrowed.** One deadline stays: an attempt parked on a dependency held over a link whose target
  attempt is known and still activating or parked fails `transient` after its `readyTimeout` and retries with backoff;
  its next attempt usually starts after the other side and its chain finds the cycle. It has a cost that decides
  against it: the target being *parked* is the common case of a chain across hosts waiting for a missing plugin (a
  tab's view on a worker object that waits for an uninstalled type), and those dependents would time out and poll
  again, as today, so "local = remote" would not hold across hosts. Narrowing it to targets that are `loading` (not
  `failed { waiting }`) avoids that but misses a real ring: A and B on two hosts wait on each other, B also on a
  missing X; B is `failed { waiting }`, so A is too; when X appears, both stay `failed { waiting }` on each other, with
  no deadline and no chain to find it. And even the timeout does not find what it is meant to (round 6, Fable): an
  object's chain is fixed when it is created and its instance id survives retries, so a retried attempt sends the same
  hold with the same chain; two simultaneous starts time out and retry in lockstep and are never found.
- **(B) The probe (recommended)**, below: no deadline at all, one new message kind, the most intricate rule set in the
  model. Five
  review rounds found a counterexample in each of the first four drafts; draft 6's version answers all of them, but it
  has not been reviewed again, and slice 7 would have to prove it with tests before the deadline could go.

### (B) The probe

Replaces the activation chain in holds. On one host the `self.get` walk stays (it is synchronous and exact: a ring
with no remote edge is found there, where (B1)'s timer does not run; Opus, round 7); the probe serves the rings that
cross a link. It replaces draft 1's bounded chain too
draft 1's bounded chain (a ring of 33 is never found with chains cut at 32; chains keep stale ancestry). Draft 5 replaces the
second round by a check along the recorded path (round 4, Sol: two rounds through different stale paths can report a
ring that never existed, `/tmp/model/sol-probe4.log`).

1. **Attempts, edges, tokens.** Every attempt has its own id (uuidv7 per attempt: a retry or reload is a new
   attempt). A **wait edge** runs from a parked attempt to the parked or activating attempt it waits for, through a
   bound request (unbound waits and registry reads are never edges; they are not deadlocks). Each edge carries an **edge
   token** (round 5, Astra, Sol): a number from a counter per attempt, never reused, replaced by a fresh one on any
   interruption or change of that edge, so two requests to one object are two edges: a new target attempt (also a
   local target's retry, without a re-bind), any `loading` on a bound or pending hold (a relay's upstream re-hold
   included), an unbinding, a rebinding, a re-hold after a reconnect. An attempt is parked for one interval only (one
   that passed its dependency check never parks again) and ids are never reused. A provider tells its consumers the attempt they wait for on
   every non-live answer: `loading { hold, attempt }` and a `waiting` `failed { hold, cause, attempt }`.
2. **A search per edge change.** Whenever a parked attempt gets a new edge or a new token on one, it starts a
   search: `probe { kind: "search", round, initiator, trail }` along each of its wait edges, `round` the next number of
   a counter the attempt keeps, `trail` the list of `(attempt, edge token)` hops it crossed, starting with
   the initiator's own. A ring closes at its last
   edge, and that edge's source starts the search that finds it. Coalesced per batch. Locally a call on the target
   attempt, forwarded through a queue (no recursion); over a link the message `probe { hold, to, ... }`, consumer to
   provider, relayed by hold id with the origin. **Probes are honoured on parent and route links and dropped on child
   links** (`accept`), whatever `trusted` says.
3. **Forwarding.** An attempt receiving a search drops it if `to` is not its current attempt or it is not parked. If
   the initiator is itself, the search returned (4). If the attempt is already in the trail, it drops it (a ring that does not contain the initiator is
   found by its own members' searches; Opus). Otherwise it forwards it along every wait edge, appending `(itself, the edge's
   token)` to the trail, only if the round number is higher than the one it stored for that
   initiator (older or equal rounds are dropped: the initiator superseded them), and stores it. The seen map holds one
   number per initiator, up to 256 initiators, and goes with the attempt.
4. **The check.** A returned search is accepted while its initiating attempt is still parked, whatever round it
   carries (round 7, Astra: a re-search must not invalidate an older search still under way); the check decides. The
   initiator then sends `probe { kind: "check", round, trail }` along the recorded trail: the initiator first verifies its own hop; each hop passes it on only if it is still
   that attempt, still parked, still has the recorded edge token, pointing at the next hop's attempt; otherwise the
   check dies (also on a `to` mismatch). The check follows the trail by position and bypasses the seen
   map. The initiator verifies its own hop again when the check returns. If the check returns, the initiator fails `broken invalid/cycle`, the path named for display from the trail,
   and today's propagation breaks the other activating objects on the ring and the dependents off it. 5. **No silent loss.** Dedupe can drop the copy of a search that travelled the ring in favour of a copy whose path
   later breaks (Astra, round 5); then the check dies and nothing is left to find the ring. Round 6 tried `dead`
   notices back to the initiator; Sol and Astra showed that reliable notices need recovery state per search that
   eviction may not drop and that a long-parked attempt would otherwise keep for every initiator that ever passed (a
   leak), i.e. a full search lifecycle with cancellation. Two ways (**Owner**, part of decision 6):
   - **(B1) Re-search with backoff (recommended).** An attempt parked on a remote attempt starts a fresh search again
     after a backoff (1 s doubling to 60 s, reset by an edge change), whether it shows `loading` or `failed { waiting }`;
     the timer stops when the attempt leaves parking. No `dead` messages, no recovery state, eviction
     only costs work; a new search starts within one backoff period, so every stable ring that crosses a link is
     eventually found (no wall-clock bound: delivery is only fair; a ring on one host is the walk's). The timer runs as long as the attempt stays parked on a remote attempt: a view on a worker object that
     waits for a missing plugin re-searches every 60 s until a reload (Fable: cheap, but for as long as it waits). The timer sends probes only: it never
     fails an object, re-holds or polls a provider. Cost: one probe per parked remote dependent per period, which
     crosses the downstream wait graph and dies at its leaves (an unbound wait is not an edge).
   - **(B2) Events only.** Each search is owned until it settles: branches report completion or abort back along their
     trails, a dropped probe answers `dead { initiator, round }` with a reverse route, an edge records the searches it
     carries until they settle, and an initiator that ends or starts a new round cancels its old one along the same
     routes. Complete without a timer, bounded by the searches in flight, and the most intricate protocol in Chord; not
     yet specified to the reviewers' satisfaction.
   Rejected: enumerating every simple trail without dedupe (Sol's correctness reference): no ring copy is ever
   suppressed, but work is exponential on chains of diamonds.
- **Why a reported ring existed:** every edge of the trail kept its token from the moment the search crossed it
  to the moment the check crossed it; the search crossed all of them before the check started, so at the moment the
  check started every edge of the ring existed at once. A token changes on every interruption and is never reused, so an edge cannot
  vanish and come back unnoticed. Sol's counterexample fails at the check: `C1` is no longer `B`'s target.
- **Why every ring is found** (under an eventually stable wait graph and fair delivery; endless edge churn can keep
  invalidating searches; with rule 5's (B1) or (B2) for a search suppressed behind a path that broke): a ring is closed by its last edge; its source starts a search when the edge appears; every
  other edge exists then and every attempt on the ring waits transitively on the source, so none goes live before the
  search and the check return. Rings of any length, local and remote mixed. On a DAG searches die at the leaves; on a
  diamond the second arrival is dropped.
- **What it does not promise:** (1) a ring that existed when the check started may be broken up by a concurrent reload,
  retry, unbinding or revocation just after; it is still reported (it did exist). Its broken objects recover as every
  broken object does: `ref.retry()` or a reload of their plugin. (2) Linear work under every schedule: with more than
  256 initiators passing one attempt at once, an evicted entry lets a search be forwarded again, so work can grow with
  the number of simple paths (never endlessly: a search never revisits an attempt in its trail). (3) Constant message size: a probe carries its trail, so its size grows with the length of the
  path it crossed (a returning search's trail is as long as its ring); no cap cuts it, since the trail is the proof.
- **Cost:** one search per edge change, crossing each downstream edge once, one check per returned search; with (B1),
  one more search per backoff period for every attempt parked on a remote attempt, also while an acyclic chain waits
  for a missing plugin, plus the trail bytes. The bounded memory is the seen map's; probes in flight are bounded by
  the searches started.
- **Transition:** today's dependency deadline for activations waiting across links stays until the probe's tests pass
  in slice 7 (long rings, diamonds, a ring closed after a reconnect with unchanged attempt ids, Sol's phantom schedule,
  300 concurrent initiators, edges added and removed, reloads, relays, forged probes); then it goes in the same slice.

## 8. Getters, holds, calls: one rule

- **`host.hold`** returns a reference at once; only invalid params throw (also before `load`). A missing local type
  gives `failed { waiting }` after the publication, `loading` before it.
- **`host.get`, `ctx.get` and `host.registry`:** resolve when live; wait while `loading`, or `failed { transient }`
  (its own retry is under way), up to their `readyTimeout`; reject at once on `failed { waiting }` or `{ broken }`. On
  success, rejection or timeout their temporary wait goes; `host.registry` returns the `RegistryValue` with its
  ordinary watch ownership (no `release()`). **Owner:** recommended (nobody waits 60 s for a plugin that is not
  there; code that wants to wait holds instead), or wait through `waiting` too.
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
| dependency deadline across links | (A): only for a parked attempt whose remote target attempt stays activating or parked; (B): until the probe's tests pass, then removed | the simultaneous-cycle gap |
| probe re-search backoff (B1) | new, only with (B1): 1 s doubling to 60 s while parked on a remote attempt | finds a ring whose search was suppressed; sends probes only, never fails or re-holds |
| route backoff, heartbeat, `closeTimeout`, routine and `finish` backoffs, `linger` | kept | not dependency waits |
| rollout install timeout (not built) | a watchdog on the install only | never a deadline for dependencies |

## 12. What changes in the design

R18 (dependency failures `waiting`, no backoff, the deadline paused while parked, the dependency check as boundary,
wakes on every change, an ended dependency breaks), S2 and S3 (`waiting`, woken at every usable value), slice 8's
last-good rule (dropped when a contribution leaves), §3's destination table (by address; the publication gate), §6 (the
simultaneous-cycle gap: (A) one narrowed deadline or (B) the probe), §7 (`host.hold`, getters, calls), §21 (no `gone` on
removal; a dropped version unbinds only its requests; installs never await activations; rollout without revision
fields; the reload handover), the start barrier (R17, W6), `FailureCause` (+ `waiting`), `loading`/`failed` with the
attempt id, one message kind (`probe`, tagged `search` or `check`). Unchanged: what an object's own code reload does (§21), R18 after live,
`retryOn` outside parking, `self.follow`'s R4, the call window and flow control, revocation, no client providers.

## 13. Open for the owner

1. The barrier: (a) or (b) (§6.3).
2. Getters on `waiting`: reject at once (recommended) or wait up to `readyTimeout` (§8).
3. `waiting` as a new cause kind (recommended) or not (§2).
4. A pure swap whose new factory declares a dependency that is not there: the object parks (its gate closes, holders
   see `loading` or `failed { waiting }`, calls park or reject; recommended) or stays on the old code until it
   resolves (old and new code would overlap without bound, against §21's "a host is at R or R−1").
5. **The last good value** (§9): kept only while every contribution it was built from is still in the table (draft;
   Astra), or kept as slice 8 decided, with natives in a registry looked up at use through their owner (Sol).
6. **Cycles across hosts** (§7): (B) the probe, with (B1) a re-search backoff for probes only (recommended) or (B2) a
   full search lifecycle without any timer; or (A) the slice 4b decision narrowed to one deadline, which polls chains
   across hosts again, misses a ring of `waiting` attempts, and retries in lockstep without finding the cycle it is for.

