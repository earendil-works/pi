# remote

Remote objects over links (§3 hosts, links, routes, flow control and recovery, §4, §7, §22, W1; decision "Relay flow
control per origin"): both sides of every link of a host, the paths its upstream holds take across links, relayed
holds, the window of `bound` and `state` messages per origin, the call window, and (slice 4b) parts made and opened
within each link's limits, compression at the origin, activation chains and revocation from the parent. Apps use them through `host.accept`, `host.connect`,
`host.route` and references; nothing here is exported for apps.

## For Chord's layers (`internal.ts`)

- `HostLink` (one per link: `accept`, `connect` or a route's `resolve`): one `Channel` (handshake, codec, checks,
  heartbeat), a role (`parent`, `child`, `route`), the peer's principal as this host stamps it, a provider side per
  **origin** and one consumer side. Message kinds are directional, so each goes to its side: `hold`, `release`,
  `call`, `abort`, `retry` and `ack` to the provider side of their `origin` (0 when absent; a `hold` makes it, other
  messages for an origin without one are ignored), `closed { origin }` ends that provider side; `bound`, `state`,
  `failed`, `loading`, `result`, `error` and `gone` to the consumer side; `revoke` to the host, from a parent link only
  (`host.revoke` with this host's own `revokedBy`; anywhere else it is ignored). `origin` is honoured on every link.
  Closing it, from either end, ends both sides: the provider sides release the peer's holds and abort their calls, the
  consumer side's calls reject and its path tells the holders. It makes the parts this host originates (`part`:
  deflated above 16 KiB with the host's compressor) and opens the parts it owns (`openPart`: within the limits its
  owner gives, inflated in place with the host's compressor). On a host without a compressor the owner decides first
  what it owns (`inflates`: a call's arguments on a bound hold served here, the values of its own known holds' `bound`
  and `state`, the result of a call still waiting; never a part it relays, never one for an unknown id, Q1, never one
  past the wire limit), then inflates those asynchronously one after another within their decoded limit (`inflate`)
  and handles the message again; the channel holds the link's later messages until then, and the link's close cancels
  the inflate at once.
- **Whom a hold acts for** (`ProviderSide`): on a parent link, the hold's `principal` and `incarnation` fields when
  present, else the link's principal and the peer's incarnation; on child and route links always the link's (fields
  ignored: a tab cannot claim to be the owner). Calls carry no principal: a call runs as its hold's caller
  (`ctx.principal`, `ctx.incarnation`). Trust never grants the fields.

  What a host sends in those fields when it holds over a route link (`actingFor`, for `RemoteObject` and
  `RelayedHold`); on a parent link it sends none (the parent ignores them from a child: upward is a boundary, a worker
  that acts for a user towards the server passes the user as data). A relay never passes on the fields it received
  (`HoldRequest` has none): it decides whom the hold acts for once, when it arrives:

  | The reference was made by | `principal` | `incarnation` |
  | --- | --- | --- |
  | `host.get` / `host.hold` | the host's own | this host's |
  | `ctx.get` in a handler | the handler's `ctx.principal` (the caller's) | the handler's `ctx.incarnation` |
  | `self.get` in a remote object | that object's principal | this host's |
  | `self.get` in a local object or a facet | the host's own | this host's |
  | a relayed hold | the arriving hold's principal | the arriving hold's incarnation |

- **Origins.** An origin is whose work a message is: 0 for the sender's own, or a relay's number for one of its
  downstream origins (a downstream link, and the origin its messages carry), one counter per host (`host.relays`),
  never reused. Messages carry it as `origin` (absent for 0) and answers carry it back.
- `ProviderSide` (one origin of a link: the holds and calls the peer sent for it, by their ids): a message naming an id
  it does not know is ignored (Q1), one reusing a live id is a protocol error, and so are more running calls than this
  side announced in `hello` (N = 256 per origin; a call on an unknown hold is ignored before it is counted). Its table
  has two kinds of entries: `Hold` (served here) and `RelayedHold` (relayed, never hydrated). A call on a pending hold
  is answered `not_ready`; an aborted, released or gone call gets no reply. While the host closes, its holds are only
  dropped (the host ends the objects itself). It sends with its origin. A hold's `chain` is kept only from a trusted
  link and its stamped `limit` only from a parent link; its decoded limit is the smaller of the link's and the stamped
  one, which a relayed hold carries upstream as `limit`. A call on a relayed hold whose arguments are past the link's
  wire limit, or on a served hold whose arguments are past its limits, is answered `too_large/part` and never
  admitted. Compressed params (on any link) and compressed arguments from a child are protocol errors: params are never
  compressed, and clients never send compressed parts. Holds of a principal being revoked that still wait for `load`
  end with `gone` (`revokeWaiting`).
- **The window** (K = 2, `ProviderSide`): at most two of this host's own `bound` and `state` messages unacknowledged
  per origin; every other message is control and never waits. The consumer sends `ack` with the origin after applying
  each. The side keeps the sender of every message in flight in order (`local`, or the upstream link a relayed one came
  from); each `ack` answers the oldest: its own frees a slot, a relayed one goes to that upstream link as `ack` with
  the origin's number there. One with nothing in flight is ignored.
  - At the end of a batch, with a slot free and nothing waiting, one `state` message carries an entry per hold the
    batch touched. Otherwise each touched hold's ops join its members' pending queues (`PendingOps` from `delta/`: raw
    ops, folded by the leaf index, past 10,000 only "replace with the current value") and the hold waits.
  - A hold that goes live binds now when a slot is free and nothing waits, else waits for a slot; its snapshot and
    subscription are taken in one synchronous step when its `bound` is sent (race 2).
  - When an `ack` frees a slot: waiting state goes out as one `state` message (each waiting member's pending ops encoded
    once, or `[["r", value]]` after an overflow), waiting bindings as one `bound` with every waiting hold; when both
    wait they take turns, state first, so neither a hold that keeps changing nor a stream of new holds starves the
    other.
  - A live object stays live until it ends, so a hold waiting for its slot never goes back to pending; slice 7's
    reload adds that.
- **At a relay** nothing is folded, dropped or reset: each upstream `bound`/`state` for an origin is forwarded at once
  and acknowledged upstream when the downstream acknowledges it. A slow tab fills only its own origin's window at each
  worker, whose pending queues fold its commits; other tabs are other origins. A tab served by W workers may have 2W
  messages in flight, plus its relay's own 2.

  Trace (tab D through relay R, worker U, a derive over A and B on the tab): U's window for D's origin is full; a
  commit touching A and B joins U's pending queues. D acks one: R returns the `ack` to U, whose freed slot carries one
  `state` with A's and B's entries: the derive sees both at once, never A new with B old.
- `Hold` (one per `hold` served here, a `Holder` of its object): takes its object once `load` resolved; the hold's
  `params` part is parsed then (malformed: a protocol error). A refused type, a mismatch, invalid params, a wrong
  placement or a snapshot that throws is a broken `failed` that ends it (the provider forgets the id). While pending
  it follows its object's `state`: each failure, transient or broken, is sent as `failed` with `retryIn`, the rest of
  the object's backoff window (absent when broken), the current one at once when the object is failed already; the
  next attempt is announced with `loading`; the hold stays, so a `retry` (from any holder) renews even a broken object
  for every holder. Live, it binds through the window (`boundEntry`: the variant and each member's value as a part,
  names as indexes into the bound version). Its members' frames arrive as `Subscriber` calls inside the batch; at its
  end the hold's entry lists the members that changed with their ops, each encoded with that member's own Delta
  encoder (`entry`), or queues them (`queue`, later `pendingEntry`). Each entry counts one `chord.link.encodes`. A
  call's method is an index into the bound variant's methods; one outside them is a protocol error, its arguments are
  parsed when it arrives. A member that fails is listed in the header of the message that carries the failure, once
  per failure episode; while the window is full a member keeps one pending failure at most (a later one replaces it,
  dropping the member's pending ops; a value after it replaces it), and a retirement of a failed member waits for its
  next value (never listed beside its failure). Its
  object's end sends `gone` with its error (`forbidden/revoked` for a revocation; its running calls aborted with it). A
  released pending hold stops its wait for `load` at once. Params past the link's wire limit, or its decoded one, fail
  the hold broken `too_large/part`; a cycle its chain closes, broken `invalid/cycle` (`host.serving`). It counts as one
  of the host's `references` (`host.activity`) while it keeps its object.
- `RelayedHold` (a hold this host neither serves nor parses, `host.place` decided it): id `h` of its downstream
  origin, held with the same id on its path's current link under that origin's number, as the arriving hold's caller,
  from its kept `hold` message (params copied once out of the received message, so no view keeps the buffer). `call`,
  `abort`, `retry` and `release` go upstream at once; a call with no upstream link is answered `unavailable`. What
  comes back with the origin reaches its downstream `ProviderSide` (`forward`), which sends it whole with its own
  origin, ids and parts untouched. A link answers only for what was relayed over it: an entry, notice or reply whose
  hold (or call) is not relayed over the link it came from is dropped (Q1), a `bound`/`state` left empty is
  acknowledged to that link at once, and a link the origin relayed nothing to is ignored whole. Answers travel
  unchecked and unparsed: the end that parses a part checks it against its own link's limits. A revocation ends a
  relayed hold of the principal still waiting for its path's link (`revoked`: `gone` downstream), since the link it
  would be held on next gets no past `revoke`. Two downstream holds are two upstream holds with their own encoders
  (R1).
  - Upstream drop (its path tells it): relayed calls in flight `unavailable` (never resent), `loading` downstream; the
    path's next link holds it again with the same id and origin, and its `bound` is forwarded.
  - Downstream drop: the origin's provider side forgets its relayed holds and sends one `closed { origin }` to each
    upstream link it relayed to (no `release` or `abort`).
  - `gone` from upstream is forwarded and the relayed hold forgotten.
- `ConsumerSide` (the holds and calls this host's own references sent on a link, by its own counters from 0):
  `attach(holder)` holds a `RemoteObject` with a new id. A message with an origin goes to that origin's provider side
  (`host.relays`; an unknown origin is ignored). A `bound` or `state` message is prepared for every entry first (one
  that does not fit, an index outside the bound version or a member twice included, closes the link before anything
  changed), then adopted in one batch of this host, then one `ack` is sent. A malformed reply rejects its call
  `unavailable` before the link closes. When it closes, calls in flight and waiting reject `unavailable` (never
  resent) and its tables are dropped: nothing of a closed link reaches the next.
- `CallWindow` (one per consumer side): at most the peer's N calls (from its `hello`; none before it) in flight; further
  calls wait in one FIFO queue, sent in order as replies free slots; it does not preempt running calls. A relay
  forwards its downstream calls at once, so only this host's own calls wait here. A slot is freed once per call: its
  `result` or `error`, its `abort` (when sent), its hold's `release` or `gone`, or the link's close. A call still
  waiting when its hold gets `loading` is rejected `unavailable` (it may name a method of the old variant).
- `Path` (the parent, or one route address): its current link and its holders (`RemoteObject`s and `RelayedHold`s),
  held on that link and again on every next one; when the link drops, every holder is told (`dropped`). `changed`
  tells its owner (a route) when it needs a link or lost its last holder.
- `RemoteObject` (one per remote reference, owned by its host across the links of its path): its `state` (`loading`
  until a link's hold is bound and again on every drop or `loading`, `failed` from `failed` with `retryAt = now +
  retryIn`, `live` on `bound`, `released`), `settled` (pending while loading, resolved while live, rejected while
  failed and by a drop or a relay's `loading` while loading: a dependent's activation waits for it and fails at once
  then, R18, and `bound` retries the dependent), `lastFailure`, `variant` (set in `bound`'s batch, before derives recompute) and
  `member` (the last binding's, kept while loading or failed; outside the variant `invalid/member`), `call` (only while
  live; outside the variant `invalid/member`), `retry` (sends `retry` while failed on an open link; after a part past
  the limits, placed anew with `host.pathOf` and held with a new id, now or on that path's next link). Its holds made
  while the object that declared it activates carry that object's chain (`activationChain`). A snapshot or state part
  past the link's limits fails only its hold (`tooLarge`): released at the provider, the reference broken
  `too_large/part` and moved to the host's `unplaced` path, so no reconnect holds it and no route resolves for it,
  until `retry`; the message's other entries apply. Its call arguments go up a parent link
  uncompressed (the parent may have accepted it as a child). It keeps its
  binding's caller: two references with different principals are two remote objects. Its holds carry the params as a
  part and the address its placement computed. A `bound` (a first binding, a re-hold; also on a live hold)
  replaces the replicas in the message's batch: members it had get the snapshot as one frame `[["r", value]]` and a
  fresh decoder, members outside a new variant vanish (reads throw `invalid/member`, watches get one `failed` call and
  stay open, derives over them fail; a later binding with the member brings it back as `[["r", value]]`, as on the
  provider's host), new members are made; then the reference goes live (its parked calls are sent). Its release sends
  `release` on the current link and rejects its calls `released`; `gone` and the host's close end the reference with
  their error.
- `Replica`: a state member on the consumer, a `Source` with its own Delta decoder: built from the snapshot, then
  `decode(wire)` (the new value by Delta's `applyImmutable`, structure shared, nothing validated) and `adopt(value,
  ops)` inside the batch, `fail(error)` (a failure call: the watches stay open; the provider's next value for it is
  `[["r", value]]`, which `decode` alone accepts while failed); inside a re-hold's batch `reset(snapshot)` and
  `vanish(error)`; `end(error)` outside a batch when its reference ends.

Rules:

- One encoder and one decoder per member of a hold: two references from one host are two holds, and so are two
  downstream holds a relay forwards.
- A host serves over all its links (a server holds a worker's types over a route link and serves the worker's holds of
  server types on the same link) and holds over the parent link and its route links. Who reconnects a parent link is
  the app (its adapter calls `connect` again); route links are resolved again by their route. Chord only re-holds.
  Calls on a loading reference park in its `Binding` (`host/`), so links see only calls on live holds.
- Costs per hop: a relay decodes the envelope, swaps the origin (one shallow copy) and encodes the envelope, copying
  parts once (never parsing them), one FIFO entry per `bound`/`state`; a provider encodes once per commit per touched
  member, or once per waiting member per freed slot; a consumer adds one `ack` per `bound`/`state` message.
