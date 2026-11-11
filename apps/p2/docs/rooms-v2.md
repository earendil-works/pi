# Rooms, second version: shared state, peer state, events

Status: spec, second draft, 2026-11-11, by the p3 session (8b6ab5cc). The first draft was reviewed by gpt-6-astra
(`/tmp/rooms-v2-astra.md`) and gpt-6.1-sol (`/tmp/rooms-v2-sol.md`); both approved the direction and found the
mutation, confirmation and persistence rules missing. The owner then decided: every state has a single writer
(section 2). Replaces the generic room of `rooms.md` §2-§3 (messages, keyed messages, live and log rooms, journal,
acknowledgements, lag rule); keeps view principals, tokens and revocation (`rooms.md` §1), methods and calls (§4), the
text room, and events. The owner allowed commit and deploy for the rooms work.

## 1. The problem

The first rooms gave a sketch three ways to send, three room kinds, a journal with acknowledgements, snapshots by the
leader and a lag rule: a second replication system on top of Chord's state. Trace of one failure (fixed in 290b02583):
a Pong view sent only keyed messages, the kit counted only unkeyed ones as applied, the lag rule evicted the view that
joined first every 30-35 s, it rejoined with a new peer ID and the sides swapped mid-game. Chord state already gives a
joiner a snapshot, a slow view merged changes, and order per link; events give lossy motion.

## 2. Two worlds, one rule (owner, 2026-11-11)

- **A plugin** is ordinary Chord: its leader is its server object; its views are Chord clients of its contracts
  (typed state, schema-checked method arguments, documents with fingerprints and `migrate`). It takes intents as
  methods and applies them in its own code, as the text room does. It needs none of this room.
- **A sketch** keeps all logic in its views. The server has only a helper object that holds, distributes and saves the
  sketch's state without understanding or enforcing its contents (the views' business; bad values break only that
  sketch).
- **Every state has a single writer.** The shared state is written only by the **leader** (the oldest view that may
  write); everyone else (other views, the agent) sends **intents as calls** to methods the leader offers, and the
  leader applies them. A peer state is written only by its own view. A single writer's changes are made against the
  base it saw, which is the base the server applies them to (one ordered link, no other writer), so Delta's revision
  ops are exact: no concurrent string appends, no reversed list inserts, no stale indexes (Astra's B1).

## 3. The model

| Part | What | Writer | Kept |
| --- | --- | --- | --- |
| **presence** | the open views (peers) and the **leader** | Chord's references | while open |
| **state** | one JSON object shared by all views; it is the view's state the agent reads | the leader (or the server, section 5.4) | persisted |
| **peer state** | per peer one JSON object | that peer | while that peer is in the room |
| **events** | lossy motion (Chord events) | every view that may write | never |
| **clock** | the server's time | the server | - |
| **methods** and **calls** | what the leader offers; views and the agent call them; the leader runs each call | the leader | never |

**A peer is a frame, stable across reconnects.** Its ID is the frame's editor ID (server-minted per viewer and
opening, already kept across a frame's reconnects, `rooms.md` §1), not the link's. Presence orders peers by the first
time each joined this room store, so a reconnect keeps a view's place and its leadership: sides do not swap.

## 4. The view kit API

```js
const room = p2view.room();               // opens the frame's link on first use

// presence
room.me; room.peers; room.leader; room.isLeader;
room.onPeers((peers, leader) => ...);

// state: shared, persisted; a joiner gets it at once
room.state;                                // the current value: confirmed, plus the leader's own unconfirmed changes
room.onState((state) => ...);
room.change((draft) => { draft.board[3][2] = "red"; });   // the leader only; others call a method instead

// peer state: each view's own part
room.mine;
room.changeMine((draft) => { draft.cursor = { x, y }; });
room.peerState(id);
room.onPeerState((id, value) => ...);      // value undefined: that peer left

// intents: calls to the leader's methods (the agent's view_call uses the same path)
p2view.methods.offer({ drop: { description, args, run: async ({ col }) => room.change((d) => play(d, col)) } });
await room.call("drop", { col: 3 });       // runs in the leader's frame; its result, or a failure

// events, clock: as today
room.emit(value); room.onEvent(({ from, at, value }) => ...);
room.now(); room.rtt();
```

- **Outcomes** of `change`, `changeMine` and `call` are tagged as `send`'s are today: `applied`, `refused` (with the
  error), `uncertain` (the link closed before the answer; never resent by the kit).
- **Granularity:** only what the draft changes travels. The docs say: change in place (`draft.board[3][2] = "red"`),
  never rebuild (`draft.board = next` sends the whole board).
- Read-only views get presence, state, peer state and events; `change`, `changeMine`, `emit`, `call` refuse them.
- `onState(state)` has no author: one notification may fold several commits (both reviews).

## 5. The server

### 5.1 Contract

`ViewRoom` version 3, variant `peer`: state members `facts` (store incarnation, the leader's term, the writers'
confirmed batch numbers, section 5.3), `shared` (the shared state's envelope; `state` is reserved by Chord, both
reviews), `peers` (peer states by peer ID), `presence`; events `stream`; methods `join`, `change({ term, n, ops })`,
`changeMine({ n, ops })`, `emit`, `call({ method, args })` (a view's intent, pinned to the leader like the agent's),
`offer`, `answer`, `now`. Variant `worker` as today (`methods`, `call`) plus `update({ state } | { merge })` for the
agent (section 5.4). Old kits: the release breaks open sketches on the old kit until the view is closed and opened
again (a new opening reloads the frame); accepted for the playground, written in `rooms.md`; no `accepts` (Sol 7,
Astra moderate).

### 5.2 Applying ops: a Delta helper, no new transaction verb

`applyOps(draft, ops)` in Chord Delta: interprets ops on an existing draft with the draft's own mutations
(assignment, delete, splice, `appendText`), so the tracker records them and `self.tx` publishes its own normalized ops,
not the incoming tuples (both reviews). The room calls it inside `self.tx(async (tx) => applyOps(await tx.draft(doc),
ops), ctx)`.

- **Envelope, so `r` never replaces a document root:** the shared document is `{ value: JsonObject }`; the kit's ops
  are relative to the state, and the server maps `["r", v]` to `["s", ["value"], v]` and prefixes every other path
  with `"value"`. The peers document is `{ peers: { [id]: JsonObject } }`; a peer's ops map the same way under
  `["peers", id]`, the ID taken from the caller's principal, never from the ops; the peer must be present when the
  transaction runs (an in-flight change cannot recreate a departed peer's part). A replaced value must be an object.
- **Trust boundary:** each op is checked once (Delta's `assertValidOp`, safe paths) and applied strictly: a path that
  does not resolve, an index out of range (the existing plain `apply` clamps; this helper refuses), or a placed value
  that is not JSON fails the call `invalid/args`. The room does not catch it, so the transaction is discarded whole
  (both reviews: atomicity is the callback's rejection, not a promise of the helper).
- **Documented, not enforced:** ops from a link land in the draft unchecked against the document's schema; the helper
  is for untyped documents, or for code that knows what it is doing (owner).
- **Cost:** path resolution plus the placed values' copy and the array work each op implies, as hand-written
  mutations cost; no diff, no walk. Cost guards in Chord's tests.
- Decision entry in Chord's `decisions.md`, design §9 (with the Durable rule: nothing but `tx` work in the callback).

### 5.3 Confirmation of a writer's own changes

A writer's view shows confirmed state plus its own unconfirmed batches. To drop exactly the confirmed ones (Sol 4,
Astra B2): each batch carries `n` (per writer, increasing), and the room's commit writes the writer's `n` into
`facts.confirmed[writer]` in the same transaction as the change, so the state message that carries the change also
carries its confirmation (one commit, one atomic message per link). The kit drops pending batches up to
`facts.confirmed[me]` before it replays the rest; a folded message confirming several batches works the same. Shared
state: `writer` is the leader and its term (`facts.term`); a change whose `term` is not the current one is refused
(the old leader's late change). Peer state: `writer` is the peer.

- **Refused batch:** dropped with the batches after it (they were made on top of it); the kit reports each as
  refused.
- **Uncertain** (the link closed before the answer): the kit keeps the batch until its new link's first state shows
  `confirmed[me]`: confirmed, or gone (reported uncertain, never resent).
- **Leader change:** the new leader starts from confirmed state; the old leader's pending batches are dropped as
  refused when it sees the new term.

### 5.4 Persistence and the agent

- **One authority while the room lives:** the room. The view's state in the worker (`p2.view-state`) is its sink.
  The agent's `view update` and `merge` go to the room (`ViewRoom` worker variant `update`) while the room exists, and
  to the worker's document as today otherwise; `view read` reads the room's state while it exists (Astra M1).
- **The agent's update** is applied by the server as the writer of that moment: it replaces (or merges into) the
  current shared state and increments the leader's term, so the leader's unconfirmed batches are refused and it
  rebases on the result. Explicit policy: the agent's write wins over unconfirmed view changes.
- **Saving:** a dirty revision of the shared state; the room writes it through `ViewBacking.write` (compare-and-set by
  the backing revision it last wrote or read) after a pause in changes and, while changes keep coming, at least at a
  fixed pace, and when the room's last peer leaves; one save at a time; a success marks only the captured revision
  saved. A CAS failure means someone wrote the backing outside the room (only possible for a closed or replaced
  opening, since the agent writes through the room): the room stops saving and revokes its frames as for a closed
  opening. What a crash between saves loses is documented (Sol 5).
- **Shape:** the shared state is a JSON object. An existing view state that is `null` starts as `{}`; a scalar or array
  state cannot open a room (the view tool's `help` says so).

### 5.5 Sizes: the existing limits, no new ones

- **Persistence:** the view state limit (`MAX_VIEW_STATE`, 256 Ki characters of JSON, Max's) applies: a leader's
  change whose resulting shared state is larger is refused before it commits. Measured with one `JSON.stringify` of
  the shared value per accepted batch (cost accepted for sketches and measured; a sketch that needs more state is a
  plugin).
- **Peer state:** a peer's change is refused when that peer's JSON would pass the client links' part limit divided by
  the peers present (so the `peers` member always hydrates a joiner); one stringify of that peer's object per change.
- **Memory:** `viewRoomsMemory` charges the shared and peer states' sizes as measured above.

### 5.6 What goes

The journal, block documents, window, keyed member, `send`/`onMessage`, `history`, acknowledgements, trim, the lag
rule, log rooms and their snapshots, epochs, room kinds and `join({ kind })`.

### 5.7 Text rooms

Unchanged: their contract, store, edits, IDs, watermarks and journal stay (`p2view.text()` replaces
`p2view.room("text")`). A view uses either `room()` or `text()` (the first one decides for the opening), so one
writer owns the view's state. Their carets stay keyed messages of the text room for now.

## 6. Games on top (the owner's netplayjs question)

Both reviews: yes, transport aside, as an application protocol on these primitives (a helper the kit may ship later,
`p2view.netplay(Game)`, never a room feature):

- **Rollback** (netplayjs's model: deterministic `tick(inputs)`, `draw`, and `serialize`/`deserialize` for rewinds):
  match state written by the leader (`epoch`, roster of stable player slots, timestep, seed, checkpoint); inputs as
  events keyed by `(epoch, slot, frame)`, each batch repeating every input not yet acknowledged; each player's peer
  state holds the highest **contiguous** frame received per slot; a resend timer runs even while the simulation is
  stalled; inputs are kept until every roster player acknowledged them; prediction repeats the last input; a mismatch
  restores the snapshot before the earliest affected frame and replays; a late joiner or a reconnect resumes from the
  checkpoint and the retained inputs, or the match restarts; events of an unknown epoch are buffered or dropped.
- **Lockstep:** inputs in shared state keyed `inputs[epoch][turn][slot]`, written through calls to the leader (one
  writer); a turn advances when every roster slot has its input; old turns are trimmed after every player passed them
  or a checkpoint covers them.

## 7. Timing constants (named, owner: name them all)

`ROOM_SAVE_PAUSE` (300 ms after the last change), `ROOM_SAVE_EVERY` (2 s while changes keep coming), the linger of a
room store (10 s), and the existing `CALL_TIMEOUT` (60 s), `TOKEN_TTL` (60 s), `TOKEN_WAIT` (10 s), `MAX_BACKOFF`
(10 s), `CLOCK_EVERY` (10 s); kept together in `room-timing.ts` and listed in `rooms.md`.

## 8. Tests

Chord: `applyOps` (every verb on a draft, strictness, a valid op then an invalid one with the transaction discarded,
publication equal to the hand-written mutations, cost guards). p2: contract v3; single writer (a follower's `change`
refused, its `call` applied by the leader); confirmation (state before the answer, a folded message confirming
several batches, a refused batch and its dependents, uncertain after a disconnect, a leader change and the old
leader's late batch refused); peer-state prefixing and `r` mapping, a departed peer's in-flight change refused; stable
peer identity across a reconnect (no leader change, no side swap); the agent's update and merge through the room
while it lives, through the worker otherwise, and its term increment; saving after a pause, at the pace while
continuous, at the last peer's leaving, one save at a time, a CAS failure; size refusals at both limits; events
unchanged; text rooms unchanged; Chromium: two views share state and peer state both ways, a reconnect keeps
leadership; Pong and Connect Four rewritten on the new API; `rooms.md` and the view tool's `help` rewritten.
