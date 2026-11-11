# Events: fire-and-forget members, and call windows by trust

Status: spec draft, 2026-11-11, by the p3 session (8b6ab5cc) at the owner's request ("write all of this up and have
reviewers"), for review, then a build in Chord, then in p2's rooms, then a new Pong view. Nothing is built. Design
sections are cited as "§n" (`packages/chord/docs/design.md`). Decided by the owner on 2026-11-11: call windows only for
untrusted links (§3, decision "Call windows only for untrusted links"); writing up events as below.

## 1. The problem

A view's frames play Pong through p2's room (`apps/p2/docs/rooms.md`). Each frame sends its paddle as a keyed room
message; the room keeps the newest per key and every frame holds the room's members. Over ngrok (round trip about
200 ms) the other paddle arrives four to five times a second, in bursts, and is drawn jerkily. Trace:

1. The frame sends: `ref.send(...)`, a Chord call. The kit awaits each call before the next
   (`apps/p2/plugins/views/kit/connection.ts`, `#flush`), so one batch leaves per round trip: 4-5/s.
2. The room commits the message into its `keyed` document; the commit is a `state` message to every other frame.
3. Each frame's link has the state window K = 2 (§3, "Flow control"): two `state` messages unacknowledged, the rest
   folded into the next. Even with step 1 fixed, a frame gets at most 2 per round trip, about 8-12/s, bunched after
   each `ack`, with the values in between folded away.

Folding and the window are right for state: a slow page gets the newest value, never a backlog (measured: a
`bufferedAmount` cap alone left state 9.4 s old; acks kept it current). They are wrong for motion. A paddle position
is a sample in time: interpolation needs every sample, evenly spaced, stamped with a time, and a sample is worthless
a moment later. The usual netcode families (research: `/tmp/netcode-research.md`):

| Family | Needs | In Chord |
| --- | --- | --- |
| Snapshot interpolation, prediction, lag compensation (Quake, Source) | inputs up every tick, snapshots down every tick, droppable, timed | events (this spec) up as unawaited calls, down as events |
| Rollback (fighting games, GGPO) | every frame's input, each packet repeating the unconfirmed ones, droppable | events carrying the unconfirmed inputs |
| Deterministic lockstep (RTS) | every command, in order, never dropped | state: an ordered log (p2's log room), unchanged |

What no change in Chord fixes: a WebSocket is TCP (one lost packet stalls everything behind it for a round trip), and
frames reach each other through the server. WebTransport datagrams are the later path.

## 2. Events: a third kind of member

A contract member is state (a JSON value, snapshot and ops, folded), a method (a call and its answer), or now an
**event**: a JSON value an object emits, delivered at once to every holder of a reference that is bound at that
moment, never folded, never kept, never sent to a later holder, and dropped for a holder that cannot keep up.

### 2.1 Contracts

```ts
const Paddle = obj({ peer: str(), y: num() });

export const Match = remote("game.match", {
	version: 1,
	params: { match: str() },
	hostAddress: () => Server(),
	variants: {
		player: {
			state: { players: arr(Player), score: Score },   // what a joiner needs
			events: { paddle: Paddle },                       // what moves
			methods: { move: method(obj({ y: num() })) },
		},
	},
});

// a local contract's flat members: the marker `event(schema)`, as `keyed(schema)` marks a keyed member
export const MatchStore = local("game.match-store", {
	version: 1,
	params: { match: str() },
	members: { score: Score, paddle: event(Paddle), move: method(obj({ peer: str(), y: num() })) },
});
```

- `VariantShape` gains `events?: { readonly [member: string]: Schema }`. A member name has one kind (state, keyed,
  method or event) in every variant that has it; an event's schema may differ per variant, as state's may
  (redaction). Event schemas describe JSON only (no `bytes()`, as for state).
- The fingerprint's normal form lists event members under their own kind, so a contract without events keeps its
  fingerprint.
- `evolve` edits: `addEvent(variant, member, schema)`, `removeEvent(variant, member)`, `event(variant, member, schema)`
  (changed schema); the local editor without the variant argument.
- `checkAccepts`: a changed event member needs `(current) => old` for each older version that has it, or `"refuse"`;
  a removed one needs nothing (an older consumer binds and receives none of it: an event has no value to hydrate);
  an added one needs nothing. The mapping runs once per emit per bound older version, as state mappings run once per
  commit per version (§22, "Adapted bindings").

### 2.2 Providing

```ts
host.serve(MatchStore, ({ match }, self) => {
	const paddle = self.events<Static<typeof Paddle>>();   // owned by this attempt
	return {
		score: self.state(ScoreDoc),
		paddle,
		move: async ({ peer, y }) => {
			paddle.emit({ peer, y });
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
			paddle: store.paddle,                              // re-exposed through the reference, as state members are
			move: ({ y }, ctx) => store.move({ peer: idOf(principal), y }, ctx),
		},
	};
});
```

- `self.events<T>()` in any factory (local or remote, any params: events are never persisted) returns an
  `EventSource<T>` with `emit(value: T): void`. Activation checks that an event member's implementation is an
  `EventSource` or a reference's event member (re-exposed); anything else fails the object `broken` naming the member
  (as for state members, Q14).
- **Emit is immediate, not transactional.** It does not wait for the object's line and is not part of a commit: an
  emit inside a `self.tx` callback goes out even if the transaction fails. What depends on a commit is emitted after
  it (`await self.tx(...); paddle.emit(...)`).
- **Timestamp:** Chord stamps each emit with the emitting host's `Date.now()`, `at`, carried unchanged through relays.
- **Flush:** an emit joins the host's batch (one per host, §11 "Publication"). At the end of the batch (or of the
  microtask turn when none is open) the host calls same-host listeners in emit order and sends one `event` message
  per link and origin holding every event of that turn for that origin's holds, in emit order. A game's tick (its own
  `onLive` loop) emitting several values in one turn therefore costs one message per link; Chord has no tick option.
- An emit after the attempt's seal throws `released`, as `self.tx` does (§6, "The seal fence").
- **Order against state:** within one origin, an `event` message goes after the `state` message of the same batch
  when that one is sent. A state change held back by a full window (§3) is overtaken by later events. Code that needs
  an event to follow a state change on every holder puts the fact into state.
- **Per-principal views** filter events with a source of their own and a routine that re-emits:
  `self.onLive(async (ctx) => { await store.paddle.on((e) => mine.emit(redact(e.value)), ctx); await untilAborted(ctx); })`.
  A re-exposed member (the example) costs nothing per view.

### 2.3 Consuming

```ts
const match = await host.get(Match, { match: "m1" }, ctx);
const listening = await match.paddle.on(({ value, at }) => samples.push({ ...value, at }), ctx);
// ...
listening.stop();
```

- `ref.member.on(listener, ctx)` resolves with `{ stop(): void }`. The listener is synchronous,
  `(event: { value: T; at: number }) => void`, called in emit order. A listener that throws is reported
  (`listener_error`) and its subscription ends, as a watch's does. The subscription ends with `stop()`, the context's
  abort, or the reference's release.
- Events reach a reference only while it is bound to an instance: those emitted while it is `loading` (a link drop, a
  restart's successor not live yet, a retry) or failed are lost. When the reference moves to a new instance (§7,
  "References are the only indirection") its subscriptions move with it.
- An event member is not a `Watchable`: not a derive source, an `on` source, a state member or a contribution. A
  factory that wants another object's events subscribes in a routine.
- `chord/react` gains `useEvents(member, listener)` (subscribes while mounted, the latest listener called);
  `TuiScope` gains `on(member, listener)` (stopped on dispose).

### 2.4 Wire

- **A message kind** `event` (provider to consumer): `{ origin?, events: [{ hold, member, at, value }] }`; `member`
  an index into the bound variant's event members, sorted (as state members and methods are indexed, §22), `at` an
  integer, `value` a part. The binary codec adds a kind byte, the text codec a tuple; `PROTOCOL_VERSION` stays 1
  (nothing deployed, §22).
- **Every bound hold receives all its variant's events**; there is no subscription message. A holder without a
  listener drops them on arrival. (A per-member subscription can be added if a case shows the cost.)
- **The event window E per link and origin:** at most E `event` messages unacknowledged, a host option `eventWindow`
  (default 32). The consumer acknowledges what it applied with `ack { origin?, events: n }` (the count of `event`
  messages applied since its last such ack), once per inbound turn; an `ack` without `events` is a state ack as
  today. When the window is full at a flush, that origin's events of the turn are **dropped**, not queued, and counted
  (`chord.events.dropped`); nothing is kept for a later send. So a slow consumer loses motion, never gets stale
  motion, and the provider holds no memory for it beyond the count.
- **Relays** forward each `event` message at once and never drop: per downstream origin they keep, as for state, the
  upstream sender of each `event` message in flight (a FIFO) and return the downstream's `events` acks to those
  senders as counts. The window is the emitting host's; the relay adds none.
- **Part limits** (§22) apply to each event's value at the consumer: an oversized one is dropped and counted, the hold
  stays bound (a state snapshot over the limit fails its hold; an event is not worth that).
- **Compression at the origin** (§22) applies to event parts as to any part.

### 2.5 Reload, revocation, presence, keep-alive

- A restarted object's old attempt emits until its seal; its holders receive those while they follow it; the
  successor's emits flow once it is live and they bound to it. A reload of the consumer's plugin remounts its
  components, which subscribe anew.
- Revocation, presence (`host.references`) and `host.activity` are unchanged: events add no holders, counts or
  principals. An event reaches only references whose bound variant has the member.

### 2.6 Cost

- **Emit:** one entry appended to the host's batch, the value encoded once as a part (JSON text) at the first link
  that sends it and reused for every other link (parts are encoded once at their origin, §22); no Delta encoder, no
  pending queue, no diff.
- **Flush:** one `event` message per link and origin with events this turn; per entry its hold, member, `at` and the
  shared part.
- **Memory:** nothing kept after the flush; per link and origin one counter of messages in flight.
- **Measured in the build:** an emit to 1, 10 and 70 holders over links (allocations, encodes, bytes), as §30's cost
  guards; a benchmark in `benchmarks.md`.

## 3. Call windows by trust (decided)

Decision "Call windows only for untrusted links" (§3, "Calls"):

- `hello.calls` takes 0, meaning no window. Each side announces what it accepts on that link: 0 on a link it was given
  as trusted (`trusted: true` on `accept`, `connect`, or in a route's `resolve` result), else the host option
  `callWindow` (default 10,000; today a fixed 256, `remote/host-link.ts` `CALLS`).
- A side whose peer announced 0 sends every call at once (no call queue on that link); a provider that announced 0
  never closes the link for running calls.
- Relays change nothing: a downstream client's calls are bounded by the window the relay announced to it; the
  relay's trusted link upstream to a worker has none.

## 4. What stays outside Chord

- **A clock.** Events carry the emitter's clock; a client that needs the server's time asks a method of the app's
  (`now()`), as p2's room does, and re-samples. A Chord clock would add timestamps to `ping` and `pong` and an active
  sampling mode for something one method does.
- **Consumer-to-provider events.** Inputs go up as calls the caller does not await one by one (the call window per
  untrusted origin is 10,000); each still gets its small `result`.
- **Unreliable transport** (WebTransport datagrams, WebRTC between frames): later, when a case needs it; Radius and
  the tunnel must pass QUIC.

## 5. Design changes on approval

- §2 concepts table, §5 (members: events), §7 (event members of references), §11 (kinds of state: events are not
  state; the batch flush), §22 (the `event` message, `ack.events`, the event window), §23 (Channels: game-like
  traffic is events; byte channels stay as they are), §30 (cost), §31: "a stream type in Chord" stays rejected for
  bytes and backpressured streams; events are lossy JSON values with no backpressure, no replay and no restart rules.
- A decision entry "Events: fire-and-forget members" in `decisions.md`.

## 6. Tests (one file per source file, one `describe` per mechanism)

- Contracts: `events` in variants and the local marker; one kind per name across variants; fingerprints of contracts
  without events unchanged; `evolve` edits; `checkAccepts` (changed with mapping, `"refuse"`, removed, added).
- Activation: an event member that is no `EventSource` fails `broken`; re-exposed members.
- Same host: listeners in emit order at the batch's end; several emits of one turn; a throwing listener ends its
  subscription only; `stop`, abort, release; emit after the seal throws.
- Over a link: one `event` message per link and origin per turn; `at` preserved; order against the same batch's
  `state`; the window: drops when full, counted, no queue, recovery after acks; batched `events` acks; a slow
  consumer never delays another origin.
- Relays: forwarded at once, acks returned per upstream sender, never dropped at the relay; an upstream drop.
- Reload and restart: events while `loading` lost, subscriptions moved to the successor, emits after the seal throw.
- Versions: an older consumer gets mapped values, `"refuse"` unbinds, a removed member gets nothing.
- Limits: an oversized event dropped, the hold stays bound; compressed event parts.
- Call windows: `hello` 0 on trusted links, no queue, no protocol error for running calls; `callWindow` honoured and
  its default; relays.
- GC: a stopped subscription and a released reference keep nothing (GC test).
- Cost guards through the in-memory telemetry adapter: encodes per emit with 10 holders (one), no walks or copies.
- An example `packages/chord/test/examples/NN-events.ts`: a ticking server object, two clients, a slow one dropping.

## 7. p2: rooms with events (after the Chord build)

`apps/p2/plugins/views`, documented in `apps/p2/docs/rooms.md`:

- `ViewRoom`'s `peer` variant gains `events: { stream: obj({ from: str(), key: opt(str()), data: str() }) }` and a
  method `emit({ messages: [{ key?, data }] })` for frames that may write; `RoomStore` gains `stream: event(...)`, its
  `emit` calls `stream.emit({ from: peer, key, data })` per message in order. Nothing is kept or charged to the
  memory budget.
- The kit: `room.emit(data, { key? })` and `room.onEvent(fn({ from, key, at, data }))`. Sends and emits no longer
  wait for each call: they leave in order at once (the frame's link is untrusted, so the 10,000-call window bounds
  them). A test shows a frame's `send`s keep their order in the room's numbering with many in flight.
- The kit's clock: `room.now()` re-sampled every 10 s (the shortest round trip of the recent samples wins);
  `room.rtt()` exposed.
- A frame revoked for lagging (rooms.md §5 (5a)) reconnects quietly instead of logging an error.
- The `view` tool's `help` text: events for motion, keyed messages for what joiners need, log rooms for lockstep.

## 8. Pong, version 7 (after the p2 build)

- Each frame emits its paddle every animation frame (`room.emit({ y }, ...)`; `at` is the server's time of the
  room's emit).
- The ball stays as in version 6: a trajectory as a keyed message per hit or serve (joiners need it), owned by the
  side it heads to, computed from `room.now()`.
- The other paddle is interpolated at `room.now() - delay`, where `delay` covers the age of samples at arrival and
  the gap between them (the 90th percentile of each over the recent samples).
- The page shows events per second, the delay and the round trip, so the owner sees what the network does.
