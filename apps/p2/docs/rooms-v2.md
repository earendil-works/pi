# Rooms, second version: shared state, peer state, events

Status: spec draft, 2026-11-11, by the p3 session (8b6ab5cc) at the owner's request ("should we go for the new
proposal? ask reviewers"). Replaces the room model of `rooms.md` §2-§3 (messages, keyed messages, live and log rooms,
journal, acknowledgements, lag rule); keeps view principals, tokens, revocation (`rooms.md` §1), methods and calls
(§4) and text rooms. One small Chord addition (section 4). The owner allowed commit and deploy for the rooms work.

## 1. The problem

The first rooms gave a sketch three ways to send (messages, keyed messages, events), three room kinds (live, log,
text), a journal with acknowledgements, snapshots by the leader, and a lag rule that evicts views behind the others.
That is a second replication system on top of Chord's state, with its own failure modes. Trace of one (fixed in
290b02583, found in the field the same day): a Pong view sent only keyed messages; the kit counted only unkeyed ones as
applied; the view that joined first looked behind forever; the lag rule evicted it every 30-35 s; it rejoined with a
new peer ID and the players' sides swapped mid-game. The owner: "why do we have messages all of a sudden instead of
just using Chord state? isn't that the same and sufficient?"

Mostly it is. Chord state already gives a joiner a snapshot, a slow view merged changes instead of a backlog, and
order per link; events (Chord, d09753f4d) give lossy motion. What a sketch lacks is only a way to change shared state
without server code of its own.

## 2. The model

A view's room (one per opening of a custom view, as today) has:

| Part | What | Who writes | Kept |
| --- | --- | --- | --- |
| **presence** | the open views (peers): ID, name, role, mode; the **leader** (oldest that may write) | Chord's references | while open |
| **state** | one JSON object shared by all views of this view; it is the view's state (the agent's `view read/update`) | every view that may write, and the agent | persisted (the view's state) |
| **peer state** | per open view one JSON object | only that view | while that view is open |
| **events** | lossy motion (Chord events) | every view that may write | never |
| **clock** | the server's time | the server | - |
| **methods** and **calls** | what a view offers the agent; the leader runs a call | as today (`rooms.md` §4) | never |

Text rooms stay as they are (server rules for concurrent text; their carets become peer state).

Room kinds and their choice at join go: a room has all of the above. A text room is `p2view.text()`, separate.

## 3. The view kit API

```js
const room = p2view.room();               // opens the view's link on first use

// presence
room.me; room.peers; room.leader; room.isLeader;
room.onPeers((peers, leader) => ...);

// state: shared, persisted; a joiner gets it at once
room.state;                                // the current value (undefined until joined)
room.onState((state, by) => ...);          // by: a peer ID, "agent" or "you"
room.change((draft) => {                   // Chord Delta's tracker records the change as ops
  draft.board[3][2] = "red";
  draft.moves.push({ by: room.me, col: 3 });
});                                         // returns a promise: "applied", or "refused" with the error

// peer state: each view's own part
room.mine;                                  // this view's peer state
room.changeMine((draft) => { draft.cursor = { x, y }; });
room.peerState(id);                         // another view's, undefined when absent
room.onPeerState((id, value) => ...);       // value undefined: that view left

// events: motion
room.emit(value);                           // the kit's motion outbox (rooms.md, unchanged)
room.onEvent(({ from, at, value }) => ...);

// clock
room.now(); room.rtt();

// methods
p2view.methods.offer({ ... });              // unchanged
```

- **Local application:** `change` applies the draft locally at once (optimistic) and sends its ops; the room's
  confirmed state arrives as Chord state and replaces the local view of it (the kit keeps confirmed state plus the
  view's unconfirmed changes replayed on top, as the text client does). A refused change is dropped from the replay.
- **Granularity:** only what the draft changes travels: `draft.board[3][2] = "red"` is one small op;
  `draft.board = next` sends the whole board. The docs say so.
- Read-only views get presence, state, peer state and events; `change`, `changeMine` and `emit` refuse them.

## 4. Chord addition: applying ops a link brought into a transaction's draft

**Problem.** The room must apply a view's ops to its document so that Chord publishes exactly those ops to the other
views. Chord has no way to do that: a transaction records ops only from mutations of its drafts; Delta's `apply`
works on plain values, not drafts. Recomputing the new value and diffing it (`diffRevisions`) per change costs a walk
of the changed containers and loses append semantics.

**Proposal:** `tx.apply(handle, ops, key?)` inside `self.tx`: applies `ops` to the document's draft (the same draft
`tx.draft` returns) as if the code had made those mutations, so they are recorded and published as the draft's own.

- **A trust boundary** (wire input): every op is checked with Delta's existing checks (`assertValidOp`, safe paths, no
  `__proto__`/`constructor`/`prototype`, JSON values) and must apply to the draft's current value (a path that does
  not resolve, an index out of range): otherwise `invalid/args` and the whole transaction fails, nothing applied.
- **No schema walk:** the room's documents are untyped JSON objects (`unknown()` root); a typed document is not
  re-validated (R8 stays: values are not walked).
- **Cost:** per op one path resolution on the draft, as a hand-written mutation costs.
- Where it belongs: `documents/` (tx), with Delta's draft API. Design §9 ("Writes and transactions"), a decision entry.

## 5. The server

- `ViewRoom` version 3 (`evolve` from version 2; old kits get `contract_mismatch` and reload: p2 is the playground,
  and the frame reloads on a new opening anyway; no `accepts` for the removed members). Variant `peer`:
  - state members: `room` (the room's facts: store incarnation, the saved revision), `state` (the shared state),
    `peers` (peer states by peer ID), `presence`;
  - events: `stream` (as today);
  - methods: `join`, `change({ ops })`, `changeMine({ ops })`, `emit`, `now`, `offer`, `answer`.
- `change` runs `tx.apply(shared, ops)`; `changeMine` runs `tx.apply(peers, ops)` with every op's path prefixed by
  the caller's peer ID (`["p", id, ...]` style: the caller can only reach its own part; the prefix is added by the
  server, never taken from the view). A peer's part is created at join and deleted when it leaves.
- **Persistence:** the shared state is written to the view's state through `ViewBacking.write` (compare-and-set by
  revision, as the text room does) 300 ms after the last change and at the room's end. A change of the view's state
  the room did not write (the agent's `update`) becomes ops by `diffRevisions` and is applied like a change (`by:
  "agent"`).
- **Gone:** the journal, block documents, window, keyed member, acknowledgements, trim, the lag rule, log snapshots,
  epochs and terms, room kinds, the memory budget's message accounting. The budget (`viewRoomsMemory`) charges the
  encoded size of the shared and peer state instead.
- **Text rooms** keep their own state and rules; their cursors move to peer state.

## 6. Games on top (question for the reviewers)

The owner: can netplayjs's model be built on this, transport aside (no WebRTC or WebTransport)?

- **netplayjs's API:** `class Game { static timestep; constructor(canvas, players); tick(inputs); draw(canvas) }`,
  `new RollbackWrapper(Game).start()`: the game is a deterministic step function over a map of player inputs; the
  wrapper predicts missing inputs, rewinds on mismatch, and needs every input of every frame, in order.
- **Sketch of rollback here:** each view emits its input per frame as an event that also repeats its unconfirmed
  inputs (frame numbers); each view keeps in its peer state the last frame it holds of each other player
  (`confirmed: { [peer]: frame }`), so senders drop what is confirmed; start, players and the frame clock in shared
  state; a view missing inputs too long stalls (as netplayjs does). Lockstep: inputs appended to the shared state
  per turn (ordered, never lost), turns advance when all are in.
- **The kit could ship** a `p2view.netplay(Game)` helper with netplayjs's shape on these primitives.

## 7. Tests

Contract evolution; `tx.apply` (Chord: valid ops, every invalid kind, atomicity, recording and publication equal to
hand-written mutations, cost guard); `change` and `changeMine` (prefixing, refusal for read-only views, a peer's part
gone when it leaves); a joiner gets state and peer states; a slow view gets merged changes; optimistic changes and a
refused one; the agent's update as ops; persistence after a pause and at the end, a conflict with the agent's write;
events unchanged; text rooms unchanged with cursors in peer state; Chromium: two views share state both ways, carets
in a text room, a reconnect keeps everything; the view tool's `help` and `rooms.md` rewritten; Pong and Connect Four
rewritten on the new API.
