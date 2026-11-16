# References sharing one wire hold

Status: built (2026-11-13), from the sixth draft (2026-11-12: the fifth draft, 0b48a1d18, with the fixes of its
reviews by GPT-6 Astra and GPT-6.1 Sol) with the eight amendments of its last review folded in below (principal key,
seen members, accepted difference 9, cancellation order, table ownership, retry transfer, telemetry, getters), and
the build's own decisions in §9. The owner's model: sharing is the consuming host's
business. A reference to a remote object this host already holds for the same caller joins that hold: no message, no
round trip; the host counts its references and releases the hold when the last one goes. Drafts 1–4 (502f79e3e …
ec1ffa15c) and two review rounds (GPT-6 Astra, GPT-6.1 Sol) are in this file's history; their findings are answered
below or listed as accepted differences (§2).

Sections cited are design.md's unless marked: §3 (holds, routes, relays, flow control), §4 (principals), §7
(references), §11 (state, watches), §19 (presence), §21 (reload), §22 (wire), §29 (telemetry), §30 (cost); the events
spec (`docs/events/spec.md`) §2.4; decisions D8, R1, Q5, "A reloaded UI part shows its loading state", "Shared work".

## 1. Problem

Every remote reference holds its object separately: N references to one object on one host cost N `hold` messages,
N snapshots (encoded at the provider, sent, parsed here), N encoders at the provider and N decoders and replicas
here, every commit encoded N times, and N bindings waiting in the provider's window (K = 2 per origin). In p2 a page
holds `p2.views` 3 times, `p2.chat` and `p2.chat-mode` twice, and the artifacts store once per Markdown pane (measured
2026-11-12); a React page normally has several components showing one object. Local references already share their
object (one `ChordObject` per identity, every `Binding` one of its holders). Remote references should too.

## 2. Decision, and what differs

A host keeps one `RemoteObject` per sharing key (§3). A reference whose key it already holds binds to that
`RemoteObject` at once: it is live at once if the object is live, with the object's replicas; nothing is sent. Each
reference keeps its own `Binding`: release, state, watches, event subscriptions, parked calls, calls. The hold is
released on the link when the last binding releases or ends; a reference made after that holds anew (no linger, D8).

Unchanged: every reference's own behaviour (states, values, calls and their order and errors at the caller, parked
calls, retries, release at the caller), the provider object's behaviour, code reloads (a restarted provider object
re-binds the one hold; every binding follows, as each followed its own hold), revocation, link drops and re-holds,
relays, the wire.

Differs (owner, 2026-11-12, accepted):

1. **Provider presence and activity count holds, not components.** `host.references` lists one entry per hold, so
   several references of one host and caller are one entry; `host.activity` counts likewise. Every user in p2 asks
   "who", not "how many components": `login` asks whether the owner still holds `ProviderLogin` (`some`), `sharing`
   maps guests by id, `status` counts viewers as a `Set` of the `viewer` param, the counter example dedupes names.
2. **A joining reference skips the provider's admission and first snapshot.** It is not authorized again at relays
   (the same caller and address passed already; withdrawing access is revocation, which ends the hold), not checked
   against a just-reloaded contract while the old attempt still serves it, and reads the replica as it is: a change
   still in transit is seen a moment later than a fresh snapshot would have shown it.
3. **Events in transit reach a joiner.** A joining reference gets the events that arrive after it joined, also one
   the provider emitted before it joined that was still on the way.
4. **Releasing one of several references aborts its running calls at the provider with `aborted`** (an `abort` per
   call), not `released` (the reason a `release` gives). The caller still gets `released`; the work is cancelled
   either way.
5. **Part limits apply to received parts.** A joiner receives no snapshot, so a value that grew past a part limit
   through deltas does not fail it with `too_large/part` as a fresh snapshot would.
6. **Shared values are identical.** `a.member.value === b.member.value` is `true` where two snapshots parsed two
   copies. Values are immutable by convention.
7. **Timing:** a joining reference is live at once if the object is live (as a local reference to a live object is),
   where a new hold took a round trip and a window turn.
8. **A retry renews the shared hold for every reference.** Retrying a hold the provider refused (a type not served,
   another version) restarts that one hold, so every reference sharing it sees the attempt (`loading`, then its
   outcome), where today only the retrying reference's own request restarted. (A retry of a failed provider object
   already reaches every holder today.)
9. **Watch callbacks within one commit run in subscription order.** Several references sharing a replica have their
   watches subscribed to that one replica: within one commit their callbacks run in the order the watches subscribed,
   not in the order the references were held (and so may the calls those listeners make), where separate holds ran
   per hold.

Telemetry is not surface.

## 3. The sharing key

One table per path (`WeakMap<Path, Map<string, RemoteObject>>`; one `Path` per path: the parent, or a route
address's path). The key is an injective tuple built with Chord's escaped key join (`joinKey`, as local identities):

```ts
key = joinKey([
	Type.name, String(Type.version), Type.fingerprint,
	params.key,                                                     // CheckedParams' identity key
	joinKey([address.kind, canonicalJson(address.params)]),         // the WireAddress the placement computed
	caller.principal === undefined ? "-" : `+${principalJson(caller.principal)}`, // the principal's own JSON
	caller.incarnation,
]);
```

- **The address** is in the key because `hostAddress` is not in the fingerprint (§3, §5): old and new code may place
  the same params at different addresses over one parent path; each must reach its own provider.
- **The caller** is in the key because a hold acts for its caller (`actingFor`, `src/remote/README.md`): a server
  handler's `ctx.get` holds for whoever called it, and two callers must not share a hold (their variants and
  `ctx.principal` at the provider differ). On a page or TUI every reference is the host's own principal. The
  principal part is the principal's own JSON (`JSON.stringify`, insertion order, as the wire carries it), cached per
  principal object in a `WeakMap` (`principalJson`, one walk counted per object): two callers share only when they
  serialize equally (amendment 1; replaces canonical JSON plus the app's key: equal app keys with different data, and
  equal data in another field order, stay separate).
- `joinKey` escapes every part, so no params or principal content can collide; "no principal" (`-`) and a principal
  are distinct.

Not shared:

- **`self.get` references** (activating or not): their holds carry the dependent's activation chain (Q5).
- **Relayed holds:** a relay forwards each downstream hold as its own upstream hold (R1).
- **A reference after the last release**, even in the same turn: a new hold (D8).
- **A reference that retries after `too_large/part`:** it moves into a private `RemoteObject` of its own (§4).
- **A `RemoteObject` failed broken** leaves the table (by identity) and is never put back, also after it recovers: a
  new reference holds anew, as a new hold would have been checked anew.
- **A suspended path** (a route suspended): a new reference holds separately, as today (it fails `unavailable` on its
  own), instead of inheriting the object's state. A path whose route failed to resolve is joined, and the join counts
  as a new request there (§4, `path.requested()`; §9).
- **A key whose object is failed `waiting` over a link** (the provider or a relay refused it: a type not served,
  another version, a relay's failed route): a new reference holds anew, unindexed, as today: a new hold is a new
  request there, and a relay's failed route resolves again for it (§9).

An object is stored in the table, an owned entry (never a placeholder), and its first binding bound to it, before it
attaches to its path, so a resolver that re-enters `bind` during the attach finds it, and a reference that resolver
makes and releases is not its last (amendment 5). Entries are owned: removed only by the `RemoteObject` they map to
(`if (table.get(key) === this) table.delete(key)`), and never put back: at its last release and on every broken
failure (a provider's `failed { broken }` too) before anything is told (teardown cannot re-enter and find it); on
`gone`, revocation and the host's close the bindings are captured and the entry taken out before any is told.

## 4. Behaviour

| Event | Shared |
| --- | --- |
| a reference with a held key | binds to the `RemoteObject`: live at once if it is live (values from its replicas), else loading or failed as it is. "Seen" means a value this binding received while it was live (amendment 2): joining an object that is not live (loading, failed) it has seen no member; joining a live one, the members failed or missing from the bound variant are not seen. Such a member is seen once a value arrives for it after the join, read or not (also while no source of the binding exists); until then it shows no last value: a watch on it rejects with its error, as on a fresh failed snapshot, and watch creation, `start`, holding, detaching and a vanishing keep none. From then on the binding's own last-value rules apply; its history survives rebinds and the retry transfer (§6) |
| a join while the path's route failed to resolve and has no link | the join tells the path a request arrived (`path.requested()`); a route treats it as an attach: it resolves again unless suspended or resolving |
| a reference releases, others remain | no `release`. Its watches and subscriptions end; its calls reject `released`: its queued calls leave the call window's queue unsent first, all of them, then a snapshot of its sent calls is aborted in reverse wire-send order, **newest first** (so a relay drops a later call still waiting in its upstream window before an earlier abort frees a slot for it); its call records and their abort listeners are gone before `Binding.end` aborts its controller (amendment 4) |
| the last reference releases | `release` sent, entry removed |
| `failed`, `loading`, `bound` (a restart, another variant), `gone`, host close, revocation | every binding is told: all retarget in one batch, then each is told (`moved()`), as a local object tells its holders; each ends exactly once |
| a call | over the shared hold from its own binding (parked per binding while loading) |
| `ref.retry()` | `retry` on the shared hold: a failed provider object retries for every holder (as today); a refused hold restarts for every reference sharing it (§2.8) |
| `too_large/part` on a snapshot or state part | every binding fails broken (they share the part); the object leaves the table. A `retry` from one binding moves **that binding alone** into a new private `RemoteObject`, placed anew; the others stay failed until they retry. Oversized call arguments or results fail only their call; oversized event values are dropped, as today |
| link drop | one re-hold on the next link for the object |
| events | the object's nodes; each binding taps them through its own subscriptions from the counter value it bound at (§11); see §2.3 |
| telemetry | the hold's `chord.hold` span is shared work (§29): a root on the host's adapter whatever the first getter's context, linked to that getter's span when traced; a joining getter links to it while open; a re-hold's span links to the first whenever the adapter records (amendment 7) |
| a getter (`get`, `ctx.get`) | waits for its own binding (its live wait, abort and deadline as before); one timing out or aborted releases only its own binding; per-binding event cutoffs never reset when another binding joins (amendment 8) |

## 5. What changes in the design

- **§7 References**, after "Members": "Remote references of one host share a hold (decision "References share one
  wire hold"): an eligible reference to a remote object this host holds for the same type, version, fingerprint,
  params, address and caller joins that hold's remote object, with no message; each keeps its own release, watches,
  subscriptions and calls; the hold ends with the last reference. Releasing one cancels its own calls (queued ones
  unsent, sent ones aborted). `self.get` references and relayed holds stay separate; a private retry after
  `too_large/part` is never indexed, a broken remote object leaves the index, and a reference on a suspended or
  unreachable path holds separately. No hold survives its last reference."
- **§3:** "Every reference is a request" gains: "a remote reference joining a held remote object (§7) is a holder of
  that object on this host; the provider sees one hold". Routes: "a reference joining a remote object on a route path
  that failed to resolve counts as a new request".
- **§19 Presence:** "a hold shared by references of one host (§7) is one entry".
- **§21** reload row for web and terminal plugins: "a remounted reference is live at once if it joins an already live
  eligible remote object; otherwise it sees that object's loading or failure, or makes a fresh hold".
- **decisions.md:** "A reloaded UI part shows its loading state" refined accordingly; borrowed references and leases
  stay rejected; §31: sharing a hold among references held at the same time is allowed, keeping one past the last
  release is not. New entry "References share one wire hold (owner, 2026-11-09 and 2026-11-12)": §2 with its
  differences.
- **§29:** the shared hold's span is shared work; "a remote reference's hold" becomes "a remote object's hold".
- **§30:** per binding: watches, subscriptions, calls, one key lookup; per shared object: one hold, snapshot, encoder
  at the provider, decoders and replicas here.
- **Events spec §2.4:** "a binding joining a shared remote object gets the events that arrive after it bound".
- **§3 provider checks, §5 compatibility, §7 acquisition, §21 new requests and reload:** "checks run when a new hold
  is made; a reference joining a held remote object uses that hold without a new provider or relay admission or
  snapshot, also while an old attempt drains; the consuming host still places and admits it before the lookup."
- **§7 "References are the only indirection":** the seen-member rule (a joiner does not acquire another reference's
  last value of a member failed or missing at its join; once it receives a value its own last-value rules apply,
  across later failures, rebinds and a private retry transfer).
- **§7 calls on release:** "the caller's calls reject `released`; releasing one of several references sharing a hold
  aborts its sent calls (`abort`, the provider sees `aborted`), the last release sends `release` as before".
- **§7 retry:** a retry of a shared refused hold restarts it for every reference sharing it.
- **§2 and §5 event concepts, §11 "Who gets an event", events spec §2 opening rule and §2.4:** the provider's
  eligibility is per wire hold; a binding joining a held remote object gets the events that arrive at its host after
  it bound, also one emitted before that was in transit. Same-host eligibility unchanged; no wire field or fence.
- **§19 entry lifetime and §3 `host.activity`:** presence lists bound holders on the provider (same-host bindings and
  arriving wire holds); `host.activity.references` counts the incoming served wire holds, from arrival to end (bound
  or not; same-host bindings do not count). Several consuming-host bindings behind one hold are one entry in the first
  and one count in the second until that hold ends; a non-final consumer release removes nothing there. Local, `self.get`, private-retry, other-key and separate
  downstream holds are not deduplicated. No provider code change: incoming holds already are the unit.
- **§22 "Size limits per part":** a joiner receives no snapshot and checks none; an oversized snapshot or state part
  fails the shared object and all its bindings; only a binding that retries moves to a new private hold. No message,
  codec or protocol-version change; the per-hold encoder and two-tab rules stay.
- **decisions.md:** "Events: fire-and-forget members" (per-reference-before-emit wording) and the `too_large`
  recovery wording marked refined in part, pointing to the new decision; D8, R1 and Q5 unchanged.
- **`slices.md`:** the feature map entry; **`benchmarks.md`:** a small manual benchmark (create, join, release,
  commit fan-out, memory, wire bytes), as the hot path changes.
- **`src/remote/README.md`:** `RemoteObject` one per sharing key; "two references from one host are two holds"
  becomes "references from one host with the same key are one hold; two downstream holds a relay forwards are two";
  `ConsumerSide`: cancelling one binding's calls.

## 6. Build

- `host/host.ts` `bind`: for a `path` placement without a dependent on a path that is not suspended or unreachable,
  compute the key and look it up in the path's table; join the `RemoteObject` found (and call `path.requested()` if it
  is failed waiting on an unlinked path), else create it, store it, then attach it. Otherwise as today.
- `remote/path.ts`, `host/route.ts`: `Path.requested()`, a route handles it like an attach; the path tells whether it
  is suspended or unreachable.
- `remote/remote-object.ts`: a set of bindings; `hold` adds (a live object retargets and tells the new binding at
  once); `unhold` removes: not the last, cancels that binding's calls on the current hold; the last, `release`.
  `#move`, `lost`, `revoke`, `tooLarge`, `#end` tell every binding (retarget all in one batch, then `moved()` each).
  Table removal by identity through a callback the host gives. `Binding.bind` already retargets and tells a new
  binding; `hold` does not repeat it.
- **Retry transfer** (`host/reference.ts`, `remote/remote-object.ts`, `host/object.ts`): `Binding.retry` passes itself
  (`Target.retry(walk, binding)`); `ChordObject.retry` ignores the binding and keeps its walk-based behaviour (its other
  callers unchanged). `RemoteObject.retry` after `too_large/part` creates a private `RemoteObject` (never indexed),
  places it, and moves the binding with an internal atomic `Binding.transfer(target)`: removed from the old target,
  added to the new one and retargeted, without ending its public reference, watches, subscriptions, waiters, calls or
  retained values; its seen-member records carry over. A placement that throws fails the private object broken (the
  binding stays transferred, as a separate reference's failed retry would). The old object losing its last binding
  ends as any; its table callback cannot remove a newer entry. The move is dedicated (amendment 6): it keeps the
  public reference, never runs the old object's `#end` on the moved binding, a throwing placement fails only that
  binding, the private object never enters or evicts a table entry, and a `self.get` binding's private object keeps
  its dependent's chain.
- **Seen members** (`remote/replica.ts`, `host/reference.ts`, `host/reference-source.ts`): each replica counts the values
  it adopts (`generation`, one integer). A joining binding records, only for members failed or missing at the join,
  the generation it saw (a sparse map); such a member is seen once the replica's generation passes it, whether the
  binding read it or not. An unseen member's watch opens as on a fresh failed snapshot. Per amendment 2, a join to an
  object that is not live records every state member of the contract (one pass over its members at the join, none
  per read); a join to a live one only the failed or missing ones; a binding's sources made before a join (a binding
  that followed another object) keep the members they hold values of.
- **Call owners** (`host/reference.ts` `Binding.#send`, `Target.call`, `remote/remote-object.ts` `call`,
  `remote/consumer.ts` `call` and `OutgoingCall`, `remote/calls.ts` `CallWindow`): an internal owner token (the binding)
  travels from `Binding.#send` to the consumer's call record; never on the wire. `CallWindow` gains owner-scoped removal
  of queued calls (hold-wide removal stays for loading, failure and release; relay windows unchanged).
  `ConsumerSide.cancelCalls(hold, owner, label)` removes and rejects every queued call of the owner first, then sends
  an `abort` for each of its sent calls, newest first; each frees its slot exactly once (the `released` error is made
  only when the owner has calls). It runs from `unhold`,
  coordinated with `Binding.end`'s abort controller so no call is rejected, aborted or freed twice.
- **Principals:** `principalJson` (`data/principal.ts`), the principal's own JSON, cached per principal object in a
  `WeakMap` (one counted walk per object; a GC test for the cache). The key's canonical JSON of the address params is
  counted work, as `canonicalJson` already counts.
- Telemetry per §4. No change to `ProviderSide`, relays, the window or the wire.

## 7. Tests (one file per source file, per the Chord code style)

Each changed source file gets its cases in its existing test file: `host/host`, `host/reference`,
`host/reference-source`, `host/route`, `host/object`, `remote/path`, `remote/remote-object`, `remote/consumer`,
`remote/calls`, `remote/replica`, `data/principal`.

Sharing and keys:
- Two `host.hold`s of one remote object: one `hold`, one snapshot; the second is live at once; a commit reaches both
  in one batch.
- Separate holds for a different principal (also equal key, different data), incarnation, version, fingerprint,
  params, address or path; key collisions (params with separators, backslashes, NUL; an absent principal against one
  whose canonical form is empty-like): separate.
- Two contract tokens with one name, version and fingerprint placing the same params at different addresses over the
  parent path: two holds.
- `self.get` while activating, after, and on a re-hold: never shared. Two downstream holds through a relay: two
  upstream holds.

Joining and releasing:
- A join while loading, failed transient (`retryAt`), failed waiting, live (live in the same turn); a join to a failed
  broken object makes a new hold.
- Seen members: a join to a live object with a failed member: its watch rejects with the error (no last value) until
  a value arrives; a member missing from the current variant: likewise.
- Releasing one: no `release`; the other keeps receiving. The last: one `release`. A reference after it (also in the
  same turn): a new `hold`.
- A getter timing out or aborted (before and after the first binding) releases only its own binding.
- Non-last release with a finite call window and interleaved calls (A1 sent, A2 and B1 queued): the wire carries
  `abort(A1)`, never `call(A2)`; B1 is sent. Direct and relayed, asserting exact wire messages.
- Calls through two references both answered; parked calls per reference sent in order when live.

State changes:
- Rebind to another variant: every binding moves in one batch; a member the new variant lacks fails for all.
- Provider type removed and served again; a provider reload (§21): both references follow; a version no longer
  accepted unbinds both.
- `gone` and host close: every binding ends exactly once; the entry is gone. Revocation: both end. Link drop: one
  re-hold, both live again.
- Route recovery: A on a route whose resolve failed stays held; a new `get` with the same key re-resolves; both live
  (none while suspended).
- `too_large/part`: all fail broken; a new reference C makes a new hold; `retry` from A1 moves A1 alone into a private
  hold (A2 stays failed); ending the old object, A1's and C's in any order leaves the table right.

The accepted differences, asserted positively:
- Presence and `host.activity.references` at the provider: one entry and count for two references of one host and
  caller; a non-final release changes neither, the last removes both; other keys, private, `self.get` and other hosts
  stay separate.
- Admission: through a relay whose `authorize` turns false after A is held, B joins with no new hold and no
  authorization call; during a version-dropping reload's drain, B joins the held old binding; a commit held in
  transit: B first reads the replica, then gets the commit.
- Events in transit: emitted before B joins, delivery or inflate delayed, B joins and subscribes: B gets it; an entry
  already received and queued for the host's flush before B bound does not reach B.
- Cancellation: a non-final release: the caller gets `released`, the provider handler's signal `aborted`, a sibling
  call survives; the final release gives `released`; direct and relayed. Relayed with an upstream window of 1 (A1
  running, A2 and B1 queued at the relay): the worker sees A1 and B1, never A2.
- Limits: a value grown past the snapshot limit by small deltas: B joins without failing; a received oversized state
  part fails every binding; an oversized call or event value affects only its call or is dropped.
- Identity: `a.member.value === b.member.value`; the survivor keeps receiving after the other releases.
- Readiness: a joining getter makes no hold and no window turn and reads the replica; joins while loading or failed
  show that state.
- Refused retry: two references to an unserved type; retrying one shows both `loading`, then `failed`.

More rows:
- Suspension: a route suspended while its resolve runs: A stays loading; a new reference holds separately and fails
  `unavailable` as today.
- Re-entrancy: a resolver calling `bind` for the same key during the attach finds the stored object (one hold).
- Principals: equal app keys with different data, and equal canonical JSON told apart by the app's key: separate.
- Seen members: failed, then good, then failed again before the joiner's first read: it keeps that value as its own
  last value; missing, then present, then missing across variants; the same across a private retry transfer.
- Retry transfer: two bindings retrying separately; a throwing re-placement; preserved watch handles and last values;
  GC after transfer.
- Calls: several sent calls, a reply crossing the release, the final-release path; no call settled twice.
- `gone`, host close, revocation: watches, subscriptions and calls end, not just `ref.state`; a broken object that
  recovers is not re-indexed and ending it leaves a newer entry alone.
- Failure and loading fan out to every binding with watch callbacks in batch order; a last release while the first
  binding is still pending.

Events, presence, telemetry, memory, cost:
- Two references subscribed to one event member each get every event once; stopping one leaves the other's.
- Telemetry: the shared `chord.hold` root linked to its first trigger; a joining getter's link while open; an
  untraced first getter followed by a traced joiner; the NOOP path.
- GC (`WeakRef` probes): no `RemoteObject` in the table after the last release while the path lives; a released
  binding not retained by a live sibling object; a released reference kept by the app does not retain the object; a
  dropped route path takes its table while the host lives; a dropped principal is collected while `defaultKeys` lives
  (the existing test, reused).
- Cost guard: two references, one hold: `chord.link.encodes` counts one encode per commit.
- An example, `test/examples/NN-shared-holds.ts`: three components holding one remote object over a link; holds and
  snapshots printed.

## 8. The window

The provider's window (K = 2 `bound`/`state` messages per origin) sends every binding waiting at a freed slot in one
`bound` message (`ProviderSide.#slotFreed`). With sharing, duplicate holds disappear; distinct holds sent together
cost at most one extra round trip (the first two `bound`s, then one with all the rest). p2's measured session switch
also chained loads (views, then each pane's artifacts hold, then its `read`); that chain is p2's to shorten. Whether
first bindings should be exempt is decided after a trace of the switch with p2's telemetry once this is built.

## 9. Build notes (2026-11-13)

Decisions the build took where this design was open or contradicted itself, conservatively (today's behaviour):

- **A path whose route failed to resolve is joined** (§4's row and §6's `path.requested()`), not held separately as
  §3's "suspended or unreachable" read: the join counts as a new request, so the route resolves again, and both
  references go live on one hold. A suspended path is not joined (§3).
- **A key whose object is failed `waiting` over an open link is held anew** and the new object is not indexed (the
  entry stays the older object's): the provider's or a relay's refusal is re-checked by a new request, as today (a
  relay's failed route resolves again for it). §7's "join while failed waiting" applies to an unlinked path.
- **Bind before attach:** the first binding binds to its new object before the object attaches to its path (it used
  to attach first): a resolver re-entering during the attach finds an object with one binding, so a reference the
  resolver makes and releases there does not end it.
- **`joinKey` copies a part only when it has something to escape** (most have nothing); a non-final release makes no
  `released` error unless the reference has calls to cancel. Both measured (`benchmarks.md`, "Shared holds").
- **Tests** are in each changed source file's test file; the relay cases with two hops connect each upstream as the
  relay's child (an accepted link carries no origins).
