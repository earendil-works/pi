# Rooms, second version: shared state, peer state, events

Status: spec, third draft, 2026-11-11, by the p3 session (8b6ab5cc). Reviewed twice by gpt-6-astra and gpt-6.1-sol
(`/tmp/rooms-v2-{astra,sol}.md`, `-2.md`); both approved the direction; the second round showed that a single writer
needs its changes one at a time and an explicit leader grant (section 10). The owner's model: the leader view is the
sketch's server object. Replaces the generic room of `rooms.md` §2-§3 (messages, keyed messages, live and log rooms,
journal, acknowledgements, lag rule); keeps view principals, tokens and revocation (`rooms.md` §1), the agent's calls
(§4), text rooms and events. The owner allowed commit and deploy for the rooms work.

## 1. The problem

The first rooms gave a sketch three ways to send, three room kinds, a journal with acknowledgements, snapshots by the
leader and a lag rule: a second replication system on top of Chord's state. Trace of one failure (fixed in 290b02583):
a Pong view sent only keyed messages, the kit counted only unkeyed ones as applied, the lag rule evicted the view that
joined first every 30-35 s, it rejoined with a new peer ID and the sides swapped mid-game. Chord state already gives a
joiner a snapshot, a slow view merged changes, and order per link; events give lossy motion.

## 2. Two worlds: a plugin's server object, a sketch's leader view

- **A plugin** is ordinary Chord: its server object owns its state and applies intents (typed methods) in
  transactions on its line, always on the current state. Its views are Chord clients of its contracts. It needs none
  of this room.
- **A sketch** has no server code. **Its leader view plays the server object** (owner, 2026-11-11): the leader's code
  holds the rules, takes the intents (method calls from the other views and the agent) one at a time, and computes each
  change on the current state. The server's room object only applies, stores, distributes and saves what the leader
  computed; it understands nothing of it.
- **What the leader must do to be a correct server object** (second review): its rules run on its copy of the state,
  and the room applies the resulting changes blindly, so the copy must be the room's current state when a change is
  computed. Two rules make it so:
  1. **One change in flight.** The leader sends a change and computes the next only after the room confirmed the
     previous one (its copy then is the room's state). A Connect Four trace without it: A's `drop(3)` sends `set
     board[5][3]`; B's `drop(3)`, computed before that is confirmed, sends the same row and overwrites A; with
     optimism instead, a refused first change leaves B's piece in row 4 above an empty row 5.
  2. **Every write goes through the leader** while one exists: other views' and the agent's intents are calls it
     runs; nobody else changes the shared state. Without a leader (no view that may write is open), the room applies
     the agent's writes itself.
- **Where it differs from a plugin's object:** the leader can vanish. Then the next view takes over from the room's
  state (section 5.3); calls the old leader was running end `uncertain`.

## 3. The model

| Part | What | Writer | Kept |
| --- | --- | --- | --- |
| **presence** | the open views (peers) and the **leader** | the room, from Chord's references | while open |
| **state** | one JSON object shared by all views; the view's state the agent reads | the leader (the room without one) | persisted |
| **peer state** | per peer one JSON object | that peer | while that peer is in the room |
| **events** | lossy motion (Chord events) | every view that may write | never |
| **clock** | the server's time | the server | - |
| **methods** and **calls** | the sketch's intents; the leader runs each call | the leader | never |

- **A peer** is a frame. Its ID is the frame's editor ID (server-minted per viewer and opening, kept across the frame's
  reconnects, `rooms.md` §1), so its peer state and a game's player slot keep their key across a reconnect. One link
  per editor is admitted: a newer link of the same editor replaces the older one (the room revokes the old link), so a
  peer never has two writers.
- **The leader** is the peer that may write and is connected longest without interruption: a leader whose link drops
  loses leadership at once (no grace period), and coming back makes it the newest peer, never the leader again while
  others are there. So leadership moves once on a drop and never swaps back. A game derives sides from player slots in
  its state, never from presence order.

## 4. The view kit API

```js
const room = p2view.room();               // opens the frame's link on first use

// presence
room.me; room.peers; room.leader; room.isLeader;
room.onPeers((peers, leader) => ...);

// state: shared, persisted; a joiner gets it at once
room.state;                                // the room's confirmed state (the leader: plus its change in flight)
room.onState((state) => ...);

// intents: methods, declared once by every view (same code)
const { drop } = room.methods({
  drop: {
    description: "Drop a piece into a column",                       // the agent sees it (view_methods)
    args: { type: "object", properties: { col: { type: "integer" } }, required: ["col"] },
    run: async ({ col }, { state, change }) => {                     // runs only in the leader, one call at a time
      const row = freeRow(state.board, col);
      if (row === undefined) throw new Error("column full");
      await change((d) => { d.board[row][col] = room.me; });         // resolves once the room confirmed it
      return { row };
    },
  },
});
await drop({ col: 3 });                    // from any view: a call the leader runs (in the leader: queued locally)

// peer state: each view's own part
room.mine;
room.changeMine((draft) => { draft.cursor = { x, y }; });
room.peerState(id);
room.onPeerState((id, value) => ...);      // value undefined: that peer left

// events, clock: as today
room.emit(value); room.onEvent(({ from, at, value }) => ...);
room.now(); room.rtt();
```

- **Methods are functions** (owner: `xyz(obj)`, never `call("xyz", obj)`): `room.methods(declarations)` returns one
  function per declaration. The leader's declarations are what the room offers (the agent's `view_methods` and
  `view_call` see them); a follower's only make its callables. `p2view.methods.offer` goes.
- **`run(args, { state, change })`:** `state` is the room's current state when the call starts; `change(fn)` records
  the draft with Chord Delta's tracker, sends it as the leader's one change in flight, and resolves when the room
  confirmed it (the leader's copy is then the room's state again). The call's `change` is bound to the call's term
  (section 5.3): after a leader change it refuses, so an old call cannot write into the new leader's state.
- **One call at a time:** the leader's kit queues calls (its own included) and runs the next when the previous one
  settled. That is the leader's line.
- **Outcomes** of a method call, `change` and `changeMine`: `applied` (with the result), `refused` (with the error:
  refused before it ran, or by the room before it committed), `uncertain` (anything after it was admitted that lost its
  answer: the leader vanished, a timeout, the caller's link closed, cancellation); never retried by the kit.
- **Granularity:** only what the draft changes travels: change in place (`d.board[3][2] = "red"`), never rebuild
  (`d.board = next` sends the whole board).
- Read-only views get presence, state, peer state and events; method calls, `changeMine` and `emit` refuse them.
- `onState(state)` has no author: one notification may fold several commits.

## 5. The server

### 5.1 Contract

`ViewRoom` version 3, variant `peer`: state members `facts` (store incarnation, `leader` and `term`, the confirmed
numbers per writer stream, section 5.4), `shared` (the shared state's envelope; `state` is reserved by Chord),
`peers` (peer states by peer ID), `presence`; events `stream`; methods `join`, `change({ term, n, ops })` (the leader
only), `changeMine({ n, ops })`, `emit`, `call({ method, args })` (a follower's method call, pinned to the leader),
`offer`, `answer`, `now`. Variant `worker`: `methods`, `call`, and `update({ state } | { merge })` for the agent.
Old kits: open sketches on the old kit break until the view is closed and opened again (a new opening reloads the
frame); accepted for the playground and written in `rooms.md`; no `accepts`.

### 5.2 Applying ops: a Delta helper, no new transaction verb

`applyOps(draft, ops)` in Chord Delta: interprets ops on an existing draft with the draft's own mutations
(assignment, delete, splice, `appendText`), so the tracker records them and `self.tx` publishes its own normalized
ops, not the incoming tuples. The room calls it inside `self.tx(async (tx) => applyOps(await tx.draft(doc), ops), ctx)`.

- **Envelope, so `r` never replaces a document root:** the shared document is `{ value: JsonObject }`; the kit's ops
  are relative to the state, and the room maps `["r", v]` to `["s", ["value"], v]` and prefixes every other path with
  `"value"`. The peers document is `{ peers: { [id]: JsonObject } }`; a peer's ops map the same way under
  `["peers", id]`, the ID from the caller's principal, never from the ops; the peer must be present when the
  transaction runs. A replaced value must be an object.
- **Trust boundary:** each op is checked once (Delta's `assertValidOp`, safe paths) and applied strictly: a path that
  does not resolve, an index out of range (the plain `apply` clamps; this helper refuses), or a placed value that is
  not JSON fails the call `invalid/args`. The room does not catch it, so the transaction is discarded whole.
- **Documented, not enforced:** ops from a link land in the draft unchecked against the document's schema; the helper
  is for untyped documents, or for code that knows what it is doing (owner).
- **Cost:** path resolution, the placed values' copy and the array work each op implies, as hand-written mutations
  cost; no diff, no walk. Cost guards in Chord's tests.
- Decision entry in Chord's `decisions.md`, design §9 (with the Durable rule: nothing but `tx` work in the callback).

### 5.3 The leader grant

- `facts.leader` and `facts.term` change together, in one transaction on the room's line, whenever presence changes the
  leader (term + 1), and when the agent writes without a leader. The state message carrying the new leader carries the
  room's state at that moment, so the new leader's kit starts from exactly that state and writes only after it saw
  itself as leader.
- `change({ term, n, ops })` is applied only from `facts.leader` with `term === facts.term`, checked inside its
  transaction. A call is admitted with the term of its admission; its `change` sends that term, so after a leader
  change the old call's writes are refused and its caller gets `uncertain`.
- Calls pinned to a leader that vanishes end `uncertain` (as today); they are never given to the next leader (it might
  run them twice). Methods marked `idempotent: true` may be given to the next leader (as today).

### 5.4 Confirmation

- A **stream** is one writer's sequence of changes: the shared state's under one leader term, or a peer's peer state
  under one room incarnation. Its changes carry `n` (1, 2, ...); one is in flight at a time, so the room needs only
  `facts.confirmed[stream] = n`, written in the same transaction as the change: the state message that carries a
  change carries its confirmation.
- The kit resolves a change when `facts.confirmed[stream]` reaches its `n`. A change refused by the room resolves
  `refused`; nothing was sent after it (one in flight). A change whose link closed before an answer stays pending
  until the new link's first state: confirmed if `confirmed[stream]` reached its `n` (the stream and incarnation
  matching), otherwise `uncertain` (the term or incarnation moved on: nothing can tell, so nothing is claimed).

### 5.5 One gateway for writes, persistence

- **Every write of a custom view's state goes through the room store**, always: the agent's `view update` and
  `merge` (from the worker, `ViewRoom` worker variant), the page bridge's `setState`, `openView` with state. The room
  store activates on demand (it is a local object of the server; a write starts it, as a hold does) and ends after its
  linger once nobody holds it. With a leader present the room turns the agent's write into a call to the leader's
  built-in `replace`/`merge` (the kit offers them on every leader); without one it applies it itself. So the room is
  the one authority whether or not views are open: no "does a room exist" branch, no race between the room and a
  direct write (second review).
- **Reads:** `view read` reads the room store's state when it is active, the worker's document otherwise (they agree
  once saved).
- **Saving:** a dirty revision; the room writes it through `ViewBacking.write` (compare-and-set by the backing revision
  it last wrote or read) after `ROOM_SAVE_PAUSE` without changes, at least every `ROOM_SAVE_EVERY` while changes keep
  coming, and before its end (a store whose last holder left saves before it goes; a crash loses at most the unsaved
  interval, documented). One save at a time; a success marks only the captured revision saved. Since every writer goes
  through the room, a CAS failure means the opening closed: the room stops and revokes its frames.
- **Shape:** the shared state is a JSON object; a view state that is `null` starts as `{}`; a scalar or array state
  cannot open a room (the view tool's `help` says so).

### 5.6 Sizes: the existing limits, no new ones

- **Shared state:** the view state limit (`MAX_VIEW_STATE`, 256 Ki characters of JSON, Max's) applies: a change
  whose resulting state is larger is refused before it commits; measured with one `JSON.stringify` of the shared value
  per accepted change (cost accepted for sketches and measured; a sketch that needs more is a plugin).
- **Peer state:** one ledger of the `peers` member's encoded size in UTF-8 bytes (each peer's subtree, its key and
  separators), updated by the difference on every change and on join and leave; a change or a join that would take it
  past the part limit of the server's links to frames is refused, so the member always hydrates a joiner. One stringify
  of the changing peer's object per change, never of all peers.
- **Memory:** `viewRoomsMemory` charges the shared and peer states' sizes as measured above.

### 5.7 What goes

The journal, block documents, window, keyed member, `send`/`onMessage`, `history`, acknowledgements, trim, the lag
rule, log rooms and their snapshots, epochs, room kinds and `join({ kind })`.

### 5.8 Text rooms

Unchanged: their contract, store, edits, IDs, watermarks and journal stay (`p2view.text()` replaces
`p2view.room("text")`). A view uses either `room()` or `text()` (the first one decides for the opening). Their carets
stay keyed messages of the text room for now. The page's `setState` and the agent's writes of a text view go through
the text room's validated edit path, as today.

## 6. Games on top (the owner's netplayjs question)

Both reviews: yes, transport aside, as an application protocol on these primitives (a helper the kit may ship later,
`p2view.netplay(Game)`, never a room feature):

- **Rollback** (netplayjs's model: deterministic `tick(inputs)`, `draw`, and `serialize`/`deserialize`): match state
  written through the leader (`epoch`, roster of player slots keyed by peer ID, timestep, seed, checkpoint); inputs as
  events keyed by `(epoch, slot, frame)`, each batch repeating every input not yet acknowledged; each player's peer
  state holds the highest contiguous frame received per slot; a resend timer runs even while the simulation is
  stalled; inputs are kept until every roster player acknowledged them; prediction repeats the last input; a mismatch
  restores the snapshot before the earliest affected frame and replays; a late joiner or a reconnect resumes from the
  checkpoint and the retained inputs, or the match restarts; events of an unknown epoch are buffered or dropped.
- **Lockstep:** inputs in shared state keyed `inputs[epoch][turn][slot]`, written through calls to the leader; a turn
  advances when every roster slot has its input; old turns are trimmed after every player passed them or a checkpoint
  covers them.

## 7. Timing constants (named, owner: name them all)

`ROOM_SAVE_PAUSE` (300 ms after the last change), `ROOM_SAVE_EVERY` (2 s while changes keep coming), the room store's
linger (10 s), and the existing `CALL_TIMEOUT` (60 s), `TOKEN_TTL` (60 s), `TOKEN_WAIT` (10 s), `MAX_BACKOFF` (10 s),
`CLOCK_EVERY` (10 s); kept together in `room-timing.ts` and listed in `rooms.md`.

## 8. Tests

- **Chord:** `applyOps` (every verb on a draft, strictness, a valid op then an invalid one with the transaction
  discarded, publication equal to the hand-written mutations, cost guards).
- **p2:**
  - contract v3; methods as functions; the leader's declarations offered to the agent.
  - The leader as server object: calls one at a time; two quick `drop(3)` from two views land in rows 5 and 4.
  - One change in flight; a refused change with nothing sent after it.
  - The leader grant: a follower's `change` refused; a leader drop moves leadership once and never back; the new
    leader starts from the granted state; an old call's write after a leader change refused, its caller `uncertain`.
  - One link per editor (a second link replaces the first).
  - Confirmation: state before the answer, a disconnect after commit (confirmed on the new link) and before commit
    (`uncertain`), a new incarnation.
  - Peer state: prefixing, `r` mapping, a departed peer's in-flight change refused, the ledger across joins.
  - The gateway: the agent's update and merge with and without a leader, the page's `setState`, `openView` with
    state, all through the room; reads.
  - Saving: after a pause, at the pace while continuous, before the store ends, one at a time, a CAS failure on a
    closed opening.
  - Size refusals at both limits; events unchanged; text rooms unchanged.
- **Chromium:** two views share state and peer state both ways; a reconnect keeps the peer ID and its peer state;
  Pong (player slots in state) and Connect Four rewritten on the new API.
- `rooms.md` and the view tool's `help` rewritten.

## 9. Order of work

1. Chord: `applyOps` in Delta, with its tests, design §9 and a decision entry; commit after a code review.
2. p2: sections 3-5, with the tests; code review; commit; deploy.
3. Pong and Connect Four on the new API.

## 10. Review record

First draft (both): the reserved member name `state`; Delta records revision differences, not intents (concurrent
string appends, reversed list inserts, stale indexes); no confirmation model; two authorities and save conflicts;
budget-only admission; text rooms losing their machinery; peer `r` and root rules; old kits not reloading; `by`
unanswerable. Second draft (both): a single writer alone does not keep its base after a refused pipelined change (now
one in flight); stable identity is no leadership (now the longest-connected peer, no swap back, an explicit grant with
the state); async calls writing after a term change (now call-scoped terms); "refused" for outcomes that may have
committed (now `uncertain`); the "room exists" branch and the page's `setState` bypassing the room (now one gateway
always); a per-peer quota overflowing as peers join (now one ledger). Astra proposed revision compare-and-set as a
simpler generic primitive; the owner's model (the leader view as the sketch's server object) keeps the single writer.
