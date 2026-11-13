# Events: fire-and-forget members, and call windows by trust

Status: built in Chord (sections 2, 3, 5, 6; 2026-11-11, uncommitted at this writing; reviewed by Astra and Sol, their
findings fixed), the third draft as amended below by the build. Spec by the p3 session (8b6ab5cc) at the owner's
request. The first draft was
reviewed by gpt-6-astra (adversarial, `/tmp/events-review-astra.md`) and gpt-6.1-sol (against the design,
`/tmp/events-review-sol.md`); every confirmed finding is folded in (section 10). Then: a build in Chord, then in p2's
rooms, then a new Pong view (owner: commit and deploy allowed for this work). Design sections are cited as "§n"
(`packages/chord/docs/design.md`). Decided by the owner on 2026-11-11: call windows only for untrusted links (§3,
decision "Call windows only for untrusted links"); events as below.

## 1. The problem

A view's frames play Pong through p2's room (`apps/p2/docs/rooms.md`). Each frame sends its paddle as a keyed room
message; the room keeps the newest per key and every frame holds the room's members. Over ngrok (round trip about
200 ms) the other paddle arrives four to five times a second, in bursts, and is drawn jerkily. Trace:

1. The frame sends: `ref.send(...)`, a Chord call. The kit awaits each call before the next
   (`apps/p2/plugins/views/kit/connection.ts`, `#flush`), so one batch leaves per round trip: 4-5/s.
2. The room commits the message into its `keyed` document; the commit is a `state` message to every other frame.
3. A passive frame's link has the state window K = 2 (§3, "Flow control"): two `state` messages unacknowledged, the
   rest folded into the next. Even with step 1 fixed, a frame that only watches gets about 2 per round trip (8-12/s),
   bunched after each `ack`, the values between folded away. (A frame whose own call is answered gets the waiting
   state with the answer, past the window, §3 "A call's answer follows its state"; that does not help the others.)

Folding and the window are right for state: a slow page gets the newest value, never a backlog. They are wrong for
motion: a paddle position is a sample in time; interpolation needs ordered, timestamped samples around the time it
draws, often enough, and a sample is worthless a moment later. The usual netcode families (`/tmp/netcode-research.md`)
and what they need here:

| Family | Needs | With this spec |
| --- | --- | --- |
| Snapshot interpolation, prediction (Quake, Source) | inputs up and snapshots down every tick, droppable, sample times | inputs up as calls through a latest-only outbox (section 7), snapshots down as events; sample times in the payload |
| Rollback (fighting games, GGPO) | each frame's input with its frame number, packets repeating the unconfirmed ones, peer confirmations, a prediction horizon | events carry the inputs; frame numbers, confirmations and stalls are the game's |
| Deterministic lockstep (RTS) | every command, in order, a reset after a snapshot | state: an ordered log (p2's log room) with a send that reports its outcome (section 7); after an uncertain outcome the game dedupes by its own command IDs |

What no change in Chord fixes: a WebSocket is TCP (one lost packet stalls everything behind it for a round trip;
browsers inflate compressed parts one after another per link), and frames reach each other through the server.
WebTransport datagrams are the later path.

## 2. Events: a third kind of member

A contract member is state (a JSON value: snapshot and ops, folded), a method (a call and its answer), or now an
**event**: a JSON value an object emits, delivered once to each reference that was bound to the object before the
emit and still is when the event is sent, never folded, never kept, never sent to a later holder, and dropped for a
holder that cannot keep up. Over a link the provider's holder is the wire hold: several references of one host sharing
it (design §7, decision "References share one wire hold", 2026-11-12) are one holder there, and each gets what arrives
at its host after it bound.

### 2.1 Contracts

```ts
const Paddle = obj({ peer: str(), t: num(), y: num() });   // t: when the sender sampled it (its server-time estimate)

export const Match = remote("game.match", {
	version: 1,
	params: { match: str() },
	hostAddress: () => Server(),
	variants: {
		player: {
			state: { score: Score },                          // what a joiner needs
			events: { paddle: Paddle },                       // what moves
			methods: { move: method(obj({ t: num(), y: num() })) },
		},
	},
});

// a local contract's flat members: the marker event(schema), as keyed(schema) marks a keyed member
export const MatchStore = local("game.match-store", {
	version: 1,
	params: { match: str() },
	members: { score: Score, paddle: event(Paddle), move: method(obj({ peer: str(), t: num(), y: num() })) },
});
```

- `VariantShape` gains `events?: { readonly [member: string]: Schema }`; the local marker `event(schema)` puts a member
  there for the variant `members`. A member name has one kind (state, keyed, method or event) across the whole history
  (as `declare.ts` checks today); an event's schema may differ per variant (redaction). Event schemas describe JSON
  only (no `bytes()`).
- The fingerprint's normal form lists event members under their own kind; a contract without events keeps its
  fingerprint.
- **History edits:** `addEvent(variant, member, schema)`, `removeEvent(variant, member)`, `event(variant, member,
  schema)` (a changed schema); the local editor without the variant argument. The edit history gains the event side
  (`history.ts` `Change`), so `checkAccepts` asks for mappings by edits, as today (a no-op edit needs an identity
  mapping).
- **`accepts`:** a section `events`, by variant then member for a remote contract, flat for a local one:
  `{ 1: { events: { player: { paddle: (current) => old } } } }`, or `"refuse"` (the binding of that version is
  refused, as a refused state member refuses it). A removed event needs no mapping (an exception to §27's rule, stated
  there: an older consumer binds and receives none of it; an event has no value to hydrate). An added one needs none.

### 2.2 Types

- `EventMember<T>` (read side): `on(listener, ctx): Promise<EventSubscription>`. References expose event members as
  `EventMember<T>`, never with `emit`.
- `EventSource<T> extends EventMember<T>` (the owner's handle): adds `emit(value: T): void`. `self.events<T>()`
  returns one. The owner's own `on` subscribes to its source directly (no reference binding): it gets the emits made
  after its subscription, never one made before it (a reference subscribed after an emit but before the flush does get
  it, being bound before the emit).
- A factory implements an event member with an `EventSource<T>` of its own or an `EventMember<T>` of a reference
  (re-exposed). Activation checks that the implementation is one of those Chord-made values (the declaration boundary
  of Q14); anything else fails the object `broken` naming the member.
- `EventSubscription`: `stop(): void`. Listener: `(event: { value: T; at: number }) => void`.

### 2.3 Providing

```ts
host.serve(MatchStore, ({ match }, self) => {
	const score = self.state(ScoreDoc);
	const paddle = self.events<Static<typeof Paddle>>();
	return {
		score,
		paddle,
		move: async ({ peer, t, y }) => {
			paddle.emit({ peer, t, y });
			return null;
		},
	};
});

host.serve(Match, ({ match }, principal, self) => {
	const store = self.get(MatchStore, { match });
	return {
		variant: "player",
		members: {
			score: store.score,
			paddle: store.paddle,                              // re-exposed: forwarded unchanged, value and at
			move: ({ t, y }, ctx) => store.move({ peer: idOf(principal), t, y }, ctx),
		},
	};
});
```

- `self.events<T>()` is a declaration of the factory (local or remote, any params: events are never persisted). In
  staging it returns an inert handle. It belongs to the attempt: an `emit` after the attempt's seal throws `released`
  (§6, "The seal fence").
- **Emit is immediate, not transactional.** It neither waits for the object's line nor joins a commit. Emitting
  inside a `self.tx` callback is outside §9's rule (only `tx` work in a callback; nothing leaves a transaction before
  it commits), unchecked; the supported pattern is `await self.tx(...); source.emit(...)`.
- **`at`:** Chord stamps each emit with the emitting host's `Date.now()`. A re-exposed member forwards each event
  unchanged (its `value` and `at`). A view that transforms events emits from a source of its own, which stamps anew;
  a sample time the game needs belongs in the value (`t` above).
- **Per-principal filtering:** a view subscribes to the store's member in a routine and re-emits:
  `self.onLive(async (ctx) => { const s = await store.paddle.on((e) => mine.emit(redact(e.value)), ctx); try { await untilAborted(ctx); } finally { s.stop(); } })`.

### 2.4 Delivery: one rule

**Events are collected until the event flush, a microtask the first emit queues; the flush sends them after every
`state` message published before it runs.**

- An emit increments the host's emit counter and appends `{ source, value, at, n }` (`n` the counter's new value) to
  the host's event list; if the list was empty it queues one microtask: the **event flush**. Commits keep flushing
  synchronously at their end (W1), so state published before the flush runs is sent first. `emit(A); commit; emit(B)`
  in one synchronous run: the commit's `state` message, then one `event` message with A and B. A commit whose
  publication itself waits for a later microtask (`emit(A); queueMicrotask(commit)`) may follow A: only state already
  published when the flush runs is ordered before it.
- **Who gets an event:** each binding records the counter's value when it is made: a hold when its `bound` is sent, a
  same-host reference when it binds to the instance, a re-exposing reference likewise (counter values are each host's
  own: an event arriving over a link takes the receiving host's next counter value as it arrives, and that host's
  bindings are judged by it; a binding joining a shared remote object, design §7, records it when it binds, so it gets
  the events that arrive after it bound, also one emitted before it joined that was still in transit, and none
  already received and queued for its host's flush before it bound); it gets only entries with
  `n` greater than that value, and only while it stays that binding. At the flush, each entry goes to the bindings of
  its source's object instance that pass this test, and through re-exposure to the bindings of the re-exposing
  objects by the same test. A binding that ended before the flush (released, `loading`, `failed`, ended, or unbound
  and bound again, even to the same instance) gets nothing; one made after the emit never inherits it. A subscription
  stopped, aborted or released before its listener is called is skipped.
- **Wire:** per link and origin with entries, one `event` message (section 2.6), unless that origin's event window is
  full (section 2.6).
- **Same-host listeners** are called after the flush's sends, outside the publication's reentrancy fence, as watch
  callbacks are (§11): in entry order, then subscription order. A listener may release, subscribe, start transactions
  and emit; what it emits goes into the next flush (a new list). A listener that throws is reported (`listener_error`)
  and its subscription ends; the others are called.
- **Inbound:** a consumer applies a received `event` message by calling its subscriptions' listeners the same way,
  outside the fence, in entry order.
- **No order with later state:** a `state` message held back by a full state window (§3) is overtaken by later
  events. A fact that must follow a state change on every holder goes into state.

### 2.5 Consuming

```ts
const match = await host.get(Match, { match: "m1" }, ctx);
const subscription = await match.paddle.on(({ value, at }) => samples.push(value), ctx);
// ...
subscription.stop();
```

- `on(listener, ctx)` installs the subscription at once on the reference, bound or not, and resolves; it rejects
  `released` for a released reference and the context's abort reason for an aborted context. The subscription lives
  until `stop()`, the context's abort, or the reference's release.
- It receives events while the reference is bound to an instance whose variant has the member: none while `loading`
  or failed, none while bound to a variant without it (no failure call: an event has no value to fail), and again when
  a later binding has it. When the reference moves to a new instance (§7, "References are the only indirection") the
  subscription moves with it. Nothing missed is replayed.
- An event member is not a `Watchable`: not a derive source, not a source for `self.on`, not a state member, and not
  followed as a dynamic contribution (a registry value may hold any in-process value, as today).
- `chord/react` gains `useEvents(member, listener)` (subscribed while mounted; the latest listener is called);
  `TuiScope` gains `on(member, listener)` (stopped on dispose).

### 2.6 Wire

- **Message kind** `event` (to consumer): `{ origin?, events: [{ hold, member, at, value }] }`; `member` an index into
  the bound variant's event members, sorted (as state members and methods, §22); `at` an integer; `value` a part. The
  binary codec adds a kind byte; the text codec a tuple `["E", [[hold, member, at, value], ...]]`, wrapped with its
  origin as every message is (`["@", origin, ["E", ...]]`).
  `PROTOCOL_VERSION` stays 1 (nothing deployed, §22). Every bound hold receives all its variant's events (no
  subscription message); a consumer without listeners drops them on arrival, neither inflated nor parsed.
- **Acks:** `ack` gains `events?: int` (at least 1): the number of `event` messages of that origin the consumer
  **consumed** since its last such ack. A message is consumed once its parts are inflated (a browser's asynchronous
  inflate included) and parsed, and its entries delivered or deliberately dropped (no listener, an unknown or released
  hold, a part over the limit); never on transport receipt, so a message waiting behind an inflate keeps its slot. A
  consumer sends at most one such ack per origin per inbound turn (coalesced in a microtask after the first message it
  consumed).
  An `ack` without `events` is a state ack, as today; an `ack` with `events` acknowledges events only. The two are
  never combined, so state's `ownSent`/`ownAcked` bookkeeping (and its variant fence) is untouched.
- **The event window** per link and origin, at the emitting host: at most `eventWindow` `event` messages of its own
  unacknowledged (a host option, default 32). When it is full at a flush, that origin's entries of the flush are
  **dropped** and counted, as they are visited, before any value is encoded or an entry built for them; nothing is
  queued for later. So the provider holds no backlog for a slow consumer; what is
  already sent may still sit in transport and proxy buffers (the window bounds it to `eventWindow` messages per
  emitting host and origin; a consumer whose path crosses W workers and the server may have (W + 1) × `eventWindow`
  in flight). Late samples are the game's to discard by its own timeline.
- **Event tickets.** Per link and origin the provider side keeps a FIFO of the `event` messages it sent and not yet
  had acknowledged, each with its sender: `local` (this host's emits) or the upstream link it relayed it from. An
  `ack { events: n }` consumes exactly the first n tickets: a `local` one frees a slot of this host's event window, a
  relayed one is returned to its upstream link as `ack { origin, events }` (the tickets of one upstream link in the
  acknowledged prefix summed into one ack: each upstream gets exactly its consumed prefix); a ticket of an upstream link that closed is consumed and returned nowhere. A
  provider side's record is retired only when it has no holds, no calls, no state messages and no event tickets in
  flight (or its link or origin closes). Tickets are separate from the state FIFO and from its variant fence.
- **Relays** forward an upstream `event` message at once, never dropping for congestion. As for state, a link answers
  only for what was relayed over it (§3, "Relays"): entries of holds not relayed over the link they came from (released,
  rebound, from an old upstream link) are filtered out, and the message is forwarded with what is left, also with no
  entries. A relay never acknowledges an event message itself: an early ack of a filtered message would consume an
  upstream ticket of an earlier message still unconsumed downstream (two senders behind an upstream relay), so the
  downstream's acks, in order, stay the only credit.
- **Part limits** (§22) apply to each event's value where it is parsed: an oversized value is dropped and counted, its
  hold stays bound.
- **Compression at the origin** (§22) applies to event parts; a browser inflates them in link order, as any part.

### 2.7 Versions

An older consumer bound through `accepts` gets each event mapped by its version's mapping, run once per emit per bound
older version (the attempt keeps one mapping per version while a reference of it is bound, dropped with the last one
and at the attempt's end; GC-tested). A mapping that throws drops that emit for that version only, is reported once per
failure episode (`event_mapping_failed { object, member, version, error }`), and is tried again at the next emit;
current-version holders and other versions get the event.

### 2.8 Reload, revocation, presence, keep-alive

- A restarting object's old attempt emits until its seal; holds bound to it get those events. Its successor's events
  flow to the holds that bound to the successor. A re-exposing object follows its source's restart without
  restarting (its references move).
- Revocation, presence (`host.references`) and `host.activity` are unchanged: events add no holders, counts or
  principals.

### 2.9 Cost and telemetry

- **Emit:** one entry on the host's list; no Delta encoder, no pending queue, no diff. At the flush, each emitted value
  is JSON-encoded (and compressed above the threshold) once per representation sent (the current version, each mapped
  version), the part reused for every hold and link; each `event` envelope then writes it, per recipient.
- **Memory:** the list until the flush; per link and origin the ticket FIFO (one entry per message in flight); per
  mapped version one mapping while bound.
- **Metrics** (typed in `CHORD_TELEMETRY_SCHEMA`, recorded through the host's adapter, `host.metrics`, since `emit`
  takes no context): `chord.events.emitted` (values emitted), `chord.events.sent` (entries sent, one per hold),
  `chord.events.dropped { reason: "window" | "too_large" | "mapping" }` (entries dropped; a mapping's drop counted once
  per emit per version, as the mapping runs once for all of its bindings), `chord.events.encodes` (value encodes). Nothing is measured or walked for them (§29).
- **Measured in the build** (§30 cost guards and `benchmarks.md`): an emit with 0, 1, 10 and 70 holders over links,
  with a mapped version, through a relay; one encode per representation, no walks or copies.

## 3. Call windows by trust (decided)

Decision "Call windows only for untrusted links" (§3, "Calls"):

- `hello.calls` becomes optional: absent means no window (the binary codec writes 0 for it; the code's "no `hello`
  yet" state is kept apart from it). Each side announces what it accepts on that link: nothing on a link it was given
  as trusted (`trusted: true` on `accept`, `connect`, or in a route's `resolve` result), else the host option
  `callWindow` (default 10,000; today a fixed 256, `remote/host-link.ts` `CALLS`). Trust then decides two things: the
  `MESSAGE` check and the call window.
- A side whose peer announced no window sends its calls at once; a provider that announced none never closes the link
  for running calls.
- **Relays honour each upstream window.** A relay forwards a downstream origin's calls upstream under that origin; when
  the upstream link announced a window, relayed calls of an origin past it wait in a FIFO per (upstream link, origin)
  and go as answers free slots (the consumer side's call window logic), a new call never overtaking the origin's
  queue. Queued relayed calls follow the lifecycle of the relay's own queued calls (§3: "A call still queued when its
  hold rebinds"): when the relayed hold gets `loading`, its unsent calls are rejected `unavailable` (they carry the old
  variant's method indexes) and its forwarded ones are kept; on `failed` or `gone` its unsent calls are rejected with
  that cause. A call that crossed the `loading` notice and arrives after it carries the old indexes too: before the
  relay forwards the downstream's `ack` of a new `bound` upstream (which ends the provider's decoding by the old
  indexes), it rejects every call of that hold still in its queue `unavailable`; calls arriving after that ack were
  made with the new binding. `abort`, `release`, `closed` and the upstream's drop free or reject them as for the relay's own calls. A
  queue entry is removed before its slot is counted free. This resolves `slices.md`'s carry-over "one N everywhere
  until relays account for differing windows".
- The window bounds calls in flight, not calls waiting to be sent: a caller's queue is the caller's (section 7).

## 4. What stays outside Chord

- **A clock.** Events carry the emitter's clock; a client that needs the server's time calls a method of the app's
  (`now()`), as p2's room does, and re-samples. A Chord clock would add timestamps to `ping` and `pong` and a sampling
  mode for something one method does.
- **Consumer-to-provider events.** Inputs go up as calls; freshness is the client's outbox (section 7).
- **Netcode policy:** sample and frame numbers, interpolation, prediction, confirmations, retransmission and stalls
  are the game's.
- **Unreliable transport** (WebTransport datagrams, WebRTC between frames): later; Radius and the tunnel must pass QUIC.

## 5. Design changes on approval

Folded into `design.md` with the build, each rule where it belongs: §2 (event member, source, subscription); §3
(trust decides the call window too; `callWindow`, `eventWindow`; event tickets; relays' event forwarding, filtering
and acks; relays honour upstream call windows; the window bounds calls in flight only); §5 and §27 (the third member
kind, the local marker, JSON only, `accepts.events`, the removed-event exception, no-op edits); §6 (`self.events` as a
declaration, inert in staging, owned by the attempt, the seal); §7 (event members of references, subscriptions,
variant gaps, rebinding without replay, no hydration for events); §9 (emit is no `tx` work); §11 (the delivery rule
and its phases; "only `Watchable<Json>` goes on the wire" narrowed to state members); §14 (the re-emit routine); §17
(not a followed contribution); §19 (no presence entries); §21 (old attempts emit until the seal; re-exposing objects
follow); §22 (the `event` message, `ack.events`, optional `hello.calls`, both codecs, limits and compression); §23
(Channels: game-like traffic is events; React and TUI subscriptions); §29 (the metrics); §30 (costs); §31 ("a stream
type in Chord" stays rejected for byte and backpressured streams; events are lossy JSON values without backpressure,
replay or restart rules). Also `decisions.md` ("Events: fire-and-forget members"), `slices.md` (feature map,
carry-over), and the READMEs of `contracts/`, `host/`, `remote/`, `link/`, `react/`, `tui/`.

## 6. Tests (one file per source file, one `describe` per mechanism)

- **Contracts:** `events` in variants and the local marker; one kind per name across the history; fingerprints
  without events unchanged; the three edits; `accepts.events` typed and checked: changed with mapping, `"refuse"`,
  removed (none needed), re-added, no-op edits; one variant refusing without breaking another.
- **Activation:** a member that is no `EventSource` or `EventMember` fails `broken`; re-exposed members; inert staging
  handles; an event-only contract binds live (no state to hydrate).
- **Delivery, same host:** one flush per turn; `emit(A); commit; emit(B)` order; listener order; a listener's emit in
  the next flush; `stop`, release, a transaction and a subscription from inside a listener; a throwing listener ends
  only its subscription; emit after the seal throws; emit inside a failed transaction still delivered (documented
  behaviour).
- **Eligibility:** a hold bound after the emit gets nothing; released, `loading` or failed before the flush gets
  nothing; a `bound` held back by the state window gets no event before it; emit, unbind and rebind to another variant
  in one turn; emit, then a binding made at the same counter value (a same-host reference and a re-exposing view); unbind and rebind to the same instance before the
  flush.
- **Subscriptions:** `on` while loading, failed, or on a variant without the member, then a binding with it;
  pre-aborted context; released reference; subscriptions moving across a restart and a retry.
- **Wire:** both codecs round-trip `event` and `ack.events` with origins and compressed parts; one `event` message per
  link and origin per flush; `at` preserved; state and event credits independent (state window full while events
  flow, and the reverse); the event window drops when full, counts, recovers after acks; acks for dropped, unknown
  and oversized entries; a held browser inflate keeps the event window exhausted until the message is consumed.
- **Relays:** forwarded at once; local and two upstream senders mixed on one downstream origin, acks spanning senders;
  some and all entries filtered after a release (forwarded, also empty, never acked by the relay); two relay
  hops with two senders and a filtered second message behind an unconsumed first; an upstream drop and its replacement (old tickets consumed, never
  credited to the new link); downstream `closed`; a provider side retired only after its tickets drain.
- **Versions:** mapped values for an older consumer; a throwing mapping drops for its version only, reported once,
  next emit tried; mappings dropped with the last binding (GC test).
- **Call windows:** nothing announced on trusted `accept`, `connect` and route links; asymmetric trust; no calls before
  `hello`; `callWindow` honoured and its default; a provider never closing for running calls on a trusted link;
  relays queuing per upstream window (unequal finite windows, none to finite) with abort, release, closed and drop;
  a queued relayed call when its hold gets `loading`, then a `bound` of another variant (rejected, never sent with the
  old index), a call crossing the `loading` notice still queued when the new `bound`'s ack passes (rejected), and on
  `failed` and `gone`.
- **GC:** stopped subscriptions, released references, the flushed list and the ticket FIFO keep nothing.
- **Cost guards** (in-memory telemetry adapter): encodes per emit with 0, 1, 10 holders and a mapped version; no walks
  or copies; NOOP adapter costs nothing measurable.
- **Example** `packages/chord/test/examples/NN-events.ts`: a ticking server object, two clients, a slow one dropping.

## 7. p2: rooms with events (after the Chord build)

`apps/p2/plugins/views`, documented in `apps/p2/docs/rooms.md`:

- **Contracts.** `ViewRoom` evolves to version 2 (`evolve`, accepting version 1: frames of the immutable old kit keep
  working, without events); its `peer` variant gains `events: { stream: obj({ from: str(), key: opt(str()), data:
  str() }) }` and a method `emit({ messages: [{ key?, data }] })` behind the writer gate. `RoomStore` (local, same
  plugin) gains `stream: event(...)` and `emit`, which calls `stream.emit({ from: peer, key, data })` per message in
  order. Events take no room number and touch no journal, acknowledgement, trim, base, watermark or memory budget.
  Read-only peers receive events.
- **The kit's motion outbox.** `room.emit(data, { key? })` and `room.onEvent(fn) → unsubscribe`, fn gets
  `{ from, key, at, data }`. Emits leave at once while the room is joined, at most `maxInFlight` unanswered `emit` calls
  (a kit setting, default 32); past it, a keyed emit replaces the waiting one with its key (at most one waits per
  key) and an unkeyed one is dropped (the API is lossy). While the room is not joined (connecting, reconnecting, the reference loading) emits are dropped,
  never queued or replayed. On leaving joined the outbox is emptied and its generation retired: an answer of an emit
  of an earlier generation changes nothing of the new one's count, and nothing sent before is retried. Listeners belong to the room handle: on every rejoin they are attached to the new
  reference and detached from the old.
- **Reliable sends.** `room.send` keeps its own outbox (keyed replacement before sending, as today) and stops waiting
  for each call: batches leave in order at once. `send` returns a promise of a tagged outcome: `{ kind: "sent", seq }`
  (numbered by the room), `{ kind: "superseded" }` (a keyed message replaced in the outbox before it left; the newer
  one carries its key), `{ kind: "refused", error }` (the room refused it: `room_full`, a read-only frame) or
  `{ kind: "uncertain" }` (the link closed before the answer: it may or may not have been numbered). Nothing is replayed
  by itself; a lockstep game dedupes resends by its own command IDs.
  `ViewRoom.send` and `RoomStore.send` change their result from none to the numbers given, in order, from the
  numbering transaction; `ViewRoom` version 2's `accepts[1].methods.send.result` maps them back to `null` for old
  kits. A test
  shows a frame's messages keep their order in the room's numbering with many calls in flight.
- **Monotonic acknowledgements.** The room keeps a peer's acknowledgement as the highest it saw (`ack` and a send's
  piggybacked `ack`), so a delayed send cannot move it back.
- **Clock.** `room.now()` re-sampled every 10 s (the shortest round trip of the recent samples wins, measured with
  `performance.now()`); `room.rtt()` exposed.
- **Quiet reconnects.** Calls rejected because the frame's own link closed during a reconnect (lag eviction included)
  are not logged; a refused token, a closed opening and a revoked grant still are.
- **Docs and `help`:** events for motion, keyed messages for what joiners need, `send` (log rooms) for commands every
  peer must get.
- **Tests:** old-kit compatibility; emit and listeners, reattached after a reconnect; read-only peers receive, cannot
  emit; no replay after a reconnect; room accounting unchanged by events; pipelined sends in order and their numbers, old kits getting `null`; a
  keyed message replaced before it left resolving `superseded`, a send whose link closed before its answer
  resolving `uncertain`; unkeyed emits dropped past `maxInFlight`; a reconnect with `maxInFlight` full and a keyed sample
  waiting (nothing replayed, the new count untouched); acks never moving back; lag eviction quiet and a revoked grant reported (browser test).

## 8. Pong, version 7 (after the p2 build)

- **Paddle:** each frame emits `{ t, y }` every animation frame, `t` its `room.now()` at the sample, keyed `paddle`.
- **Ball:** as in version 6, a trajectory as a keyed message per hit or serve (joiners need it), owned by the side it
  heads to, computed from `room.now()`.
- **The other paddle:** samples kept by `t` (increasing; equal or older ones dropped), at most the last two seconds;
  drawn at `room.now() - delay` by linear interpolation; `delay` = the 90th percentile of (arrival time - `t`) plus
  the 90th percentile of the gap between samples, over the last 40, 50 ms before 5 samples arrived; past the newest
  sample it holds the newest; a gap over a second, a new peer, a store reset or a clock offset change of over 50 ms
  clears the buffer.
- **The page shows** events per second, the delay and the round trip.

## 9. Order of work

1. Chord: the call windows (section 3), then events (section 2), with the design folded in; `npm run check`, Chord's
   tests, the example; review of the code by gpt-6-astra and gpt-6.1-sol.
2. p2: section 7; `cd apps/p2 && npm run check` and the rooms tests; deploy to the phone.
3. Pong version 7.

## 10. Review record

Second round (both): relays acknowledging filtered messages early could credit the wrong sender two hops up (now
forwarded, also empty, never acked by a relay); the emit counter's boundary and each host's own counter; acks only
after a message is consumed (browser inflate); ordering only against state published before the flush; queued
relayed calls across `loading` and a new `bound`'s ack; the motion outbox bounded (one waiting per key, unkeyed
dropped) and emptied on leaving joined; `send`'s tagged outcomes and its contract result.

First draft:

Both reviewers: delivery and listener reentrancy undefined (section 2.4: one rule, listeners outside the fence, emits
from listeners in the next flush); eligibility at a deferred flush (emit counter per hold, binding at flush); relay
acks and filtering (event tickets with senders, filtering as for state, empty messages acked, dead links consumed);
stale motion queued upstream as calls (the kit's motion outbox, dropped while not joined); adapter failures and
variant gaps (section 2.7, subscriptions dormant on variants without the member); read and write types
(`EventMember`, `EventSource`), `at` on re-exposure; overstated ceilings and guarantees (narrowed in sections 1, 2.6).
Astra: relays across differing call windows (section 3: relays honour upstream windows); room ack regression under
pipelining (monotonic acks); log rooms' sends losing commands silently (`send` reports its outcome); Pong's time model
(sample time in the value, the interpolation rule). Sol: transactions (§9 discipline, emit after commit); p2 contract
versions (ViewRoom 2 accepting 1); listener reattachment; metrics, units and counting through `host.metrics`; the
example's missing member; `hello.calls` 0 colliding with the code's sentinel; the design sections to fold.
