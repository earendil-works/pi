# References sharing one wire hold

Status: design, for review (2026-11-12). Owner agreed to the change on 2026-11-09 (p3 `efficiency.md` §3: "sounds
ok") and asked for it now (2026-11-12: "yes, then p2 can be slop and it won't matter"). Sections cited: design §3
(holds, flow control), §7 (references), §19 (presence), §22 (wire), §29 (telemetry), §30 (cost), §31 (rejected);
`src/remote/README.md`; decision D8 (no consumer-side linger).

## 1. Problem

Every remote reference is its own `RemoteObject` with its own hold on the link (`host.bind` creates one per
`Binding`; `RemoteObject.hold(binding)` takes "its one reference"). N references to the same remote object on one host
cost N `hold` messages, N snapshots, N delta streams with N encoders at the provider and N decoders here, and N
entries in the provider's window.

Measured in p2 (2026-11-12, Chromium at phone size, 4x CPU, 150 ms round trip; switching back to a session with three
Markdown artifact views): the page sends about 40 holds; `p2.views` is held 3 times, `p2.chat` and `p2.chat-mode`
twice each, the artifacts store once per Markdown pane. About 10 of them go to the session's worker, whose window
(K = 2 per origin) lets the first two `bound` messages through and the rest wait for acks. The visible view showed at
693 ms, all panes at 966 ms; server and worker work under 1 ms per hold. Components holding the same object they
already hold elsewhere is the normal shape of a React page; the cost should not depend on it.

Local references already share their object: a host has one `ChordObject` per identity (type, params, principal key),
and every `Binding` is one of its holders. Remote references should behave the same.

## 2. Decision

A host shares one `RemoteObject`, and with it one wire hold and one replica per member, among its references that
would send the same `hold`: same path, same type, version and fingerprint, same params (by params key), same caller
(principal and incarnation). The address needs no part of its own: `hostAddress` is a function of the type's
params. Each `host.get`, `host.hold`, `ctx.get` and `self.get` still returns its own
reference with its own `Binding`: its own release, state, watches, event subscriptions, parked calls and calls. The
`RemoteObject` ends, and its hold is released on the link, when its last binding releases or ends.

Not shared:

- **References a dependent declares while it activates** (`self.get` whose `RemoteObject` carries the dependent's
  activation chain, Q5): their holds carry a chain the provider checks for cycles; two dependents have two chains.
  A `self.get` reference is never shared, activating or not, so a chain never travels on a hold another reference
  joined.
- **Relayed holds:** a relay forwards each downstream hold as its own upstream hold (R1 stays). Two tabs are two
  origins and two principals or incarnations anyway; one tab's components share before the relay sees them.
- **A reference made after the shared object's last binding ended**, even in the same turn: the hold is released and a
  new one made. Keeping a hold past its last reference is consumer-side linger (D8, §31 Rejected); a page that mounts
  and unmounts the same object hoists its hold (p3 `efficiency.md` §2, rule 1).

## 3. The sharing key

```ts
// host.bind, for a placement on a path (Destination.reference gave { kind: "path", path, address })
// one table per path (a WeakMap<Path, Map<string, RemoteObject>>, so a path that goes keeps nothing)
key = `${Type.name}\u0000${Type.version}\u0000${Type.fingerprint}\u0000${params.key}\u0000${callerKey(caller)}`
callerKey(caller) = `${caller.principal === undefined ? "" : principalKey(caller.principal, context, host's principalKey)}\u0000${caller.incarnation}`
```

- `params.key` is the identity key `CheckedParams` already carries (the same key local objects share by).
- The table is the path's: the parent, or a route address's path (one `Path` object per path). The address needs no
  part of the key: on one path, the same type and params give the same address.
- `callerKey`: the principal as the host's identity uses it (§4 principal key) and the incarnation the hold would act
  for (`actingFor`, `src/remote/README.md`). Two callers whose holds would carry different `principal`/`incarnation`
  fields never share; on a parent link (no fields sent) the caller still decides: a worker's `ctx.get` on behalf of
  two different callers keeps two holds, so a provider that serves per-principal variants is never asked once for two.
- The table entry is removed when the `RemoteObject` ends (last release, `gone`, revocation, host close) or leaves its
  path (`tooLarge` moves it to `unplaced`: it is taken out of the table then, so a new reference holds anew instead
  of joining a broken one).

Cost: one string per remote reference made (the params key exists already), one map lookup; nothing
per message.

## 4. Behaviour

| Event | Today (one hold per reference) | Shared |
| --- | --- | --- |
| a second reference with the same key | new `RemoteObject`, new `hold` | joins the existing `RemoteObject`; no message. Live already: its binding is live at once (`moved()` in the same turn), hydrated from the replicas. Loading or failed: it sees that state |
| a reference releases, others remain | `release` sent | nothing sent; its watches, subscriptions and calls end (`released`) as today; the others are untouched |
| the last reference releases | `release` sent | `release` sent, entry removed |
| `failed`, `loading`, `bound` (rebind, another variant), `gone` | told to its one binding | told to every binding (each `retarget()` and `moved()` in one batch, as a local object tells its holders) |
| a call | over its hold | over the shared hold, from its own binding (parked per binding while loading, as today); `released` rejects only that binding's calls |
| `ref.retry()` | `retry` on its hold | `retry` on the shared hold (any binding); a `too_large/part` one is placed anew for all of them |
| `too_large/part` on a snapshot or state part | that reference fails broken, moves to `unplaced` | every sharing reference fails broken (they show the same member); the entry leaves the table |
| revocation of the principal on this host | each reference ends | the shared object ends, every binding with it (same principal by key) |
| link drop, re-hold on the next link | each `RemoteObject` re-holds | one re-hold for all |
| events | per binding, from its `RemoteObject`'s nodes | the shared object's nodes; each binding taps them through its own subscriptions (`ref.member.on`), nothing replayed to a joining one (§11 counter rule: it starts from the counter value it binds at) |
| presence at the provider (`host.references`) | one entry per consumer reference | one entry per shared hold: per consumer host, type, params, principal, incarnation (§19 changes, §5 below) |

A joining reference whose shared object is `live` but bound to a variant at the provider gets that variant, the same
one its siblings see; references never see different variants of one shared object.

## 5. What changes in the design

- **§7 References:** add after "Members": "Remote references share. A host keeps one remote object per (path, type,
  version, fingerprint, params, caller); references made with the same key bind to it and share its hold,
  replicas and state; each keeps its own release, watches, subscriptions and calls. The hold ends with the last
  reference. A `self.get` reference is never shared (its holds carry an activation chain)."
- **§3** "Every reference is a request" stays as it is for the consumer: each reference is one holder of its object
  (the shared remote object), which is one holder at the provider. Add: "a remote object shared by references
  (§7) is one hold."
- **§19 Presence:** "two tabs are two origins" stays; add: "references of one host to the same object as one caller
  are one entry: they share one hold (§7)."
- **§22 Wire:** "Two holds of the same principal (two tabs) encode the same ops separately" stays (tabs are separate
  hosts); nothing in the protocol changes. No message kind, field or version.
- **§30 Cost:** the per-reference wire cost (a hold, a snapshot, an encoder and a decoder per member) becomes per
  shared object.
- **`src/remote/README.md`:** `RemoteObject` "one per remote reference" becomes "one per sharing key"; the rule "two
  references from one host are two holds" becomes "references from one host with the same key are one hold; two
  downstream holds a relay forwards are two holds".
- **decisions.md:** a new entry "References share one wire hold (owner, 2026-11-09 and 2026-11-12)" with §2's
  decision and its exceptions.

## 6. Build

- `src/host/host.ts` `bind`: for a `path` placement without a dependent, look the key up in the path's table and bind
  to the existing `RemoteObject`, else create it, `path.attach` it and store it. With a dependent, as today.
- `src/remote/remote-object.ts`: `#binding` becomes a set of bindings; `hold` adds (a live object tells the new
  binding at once: `retarget()` then `moved()`), `unhold` removes and releases the hold only when the set empties;
  `#move`, `lost`, `revoke`, `tooLarge` tell every binding; `#end` clears the table entry (a callback the host gives,
  so the object does not know the table's shape).
- Telemetry (§29): the first reference's `chord.hold` span as today; a joining reference's getter span links to it
  while it is open ("Shared work": a getter waiting for a shared activation links to it), nothing when it is bound
  already. `chord.call` spans are per call, unchanged.
- No change to `ConsumerSide`, `ProviderSide`, relays, the window or the wire.

## 7. Tests (one file per source file, per the Chord code style)

- Two `host.hold`s of one remote object: one `hold` message, one snapshot; both live; a commit at the provider reaches
  both in one batch.
- Releasing one: no `release` sent, the other keeps receiving; releasing the last: one `release`.
- A reference after the last release: a new `hold` (no linger).
- Different principal, incarnation, version, fingerprint or params, or another path: separate holds.
- `self.get` while activating and after: never shared.
- A joining reference while loading, while failed (transient with `retryAt`, broken), while live (live in the same
  turn, its values readable at once).
- Calls through two references: each answered; releasing one rejects only its calls (`released`), the other's run on.
- Parked calls per reference while loading, sent in order when live.
- Rebind to another variant: every reference moves, in one batch; a member the new variant lacks fails for all.
- `retry` from either reference; `too_large/part`: all fail broken, a new reference holds anew; `retry` places once.
- Link drop: one re-hold on the next link, both references back live.
- Revocation: both end.
- Events: two references subscribed to one event member each get every event once; a joining reference gets none from
  before it bound.
- Presence at the provider: one entry for two references of one consumer host and caller, two for two hosts.
- Reload at the provider (slice 7b): both references follow the restart; a version no longer accepted unbinds both.
- GC: the path's table holds no `RemoteObject` after its last reference ends (a `WeakRef` check, as the other caches).
- Cost guard: two references, one hold: `chord.link.encodes` counts one encode per commit, not two.
- An example, `test/examples/NN-shared-holds.ts`: three components holding one remote object over a link, the hold
  count printed.

## 8. Not decided here: first bindings and the window

The p2 measurement also shows holds waiting for the provider's window (K = 2 per origin): with about 10 holds sent at
once, the first two `bound` messages leave, the rest wait for an `ack`. Waiting bindings already leave as one `bound`
per freed slot (`ProviderSide.#slotFreed`), taking turns with waiting state. Sharing removes most duplicate holds, so
fewer wait. Whether the window should exempt first bindings is a separate question, decided after a trace with p2's
new telemetry shows how many round trips the remaining holds take.
