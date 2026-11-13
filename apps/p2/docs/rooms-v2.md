# Rooms, second version: shared state, peer state, events

Status: spec, fourth draft, 2026-11-11, by the p3 session (8b6ab5cc). Reviewed three times by gpt-6-astra and
gpt-6.1-sol (`/tmp/rooms-v2-{astra,sol}.md`, `-2.md`, `-3.md`); both accept the core (the leader view as the sketch's
server object, one batch in flight, an explicit leader grant, one write gateway); section 11 says how each round was
folded. Replaces the generic room of `rooms.md` §2-§3 (messages, keyed messages, live and log rooms, journal,
acknowledgements, lag rule); keeps view principals, tokens and revocation (`rooms.md` §1), the agent's calls (§4),
events, and the text room as a separate service. The owner allowed commit and deploy for the rooms work.

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
  holds the rules, runs the intents (method calls from the other views and the agent) one at a time on its copy of the
  state, and sends the resulting changes. The server's room object only applies, stores, distributes and saves them;
  it understands nothing of them.
- **The two rules that make the leader a correct server object** (reviews 2 and 3):
  1. **Its copy is the room's state plus only its own unconfirmed changes.** The leader runs calls back to back on a
     tentative copy, collects their changes into a **batch**, and sends a batch only when the previous one is
     confirmed: one batch in flight. A refused batch refuses its calls and everything staged after it, and the copy
     falls back to the confirmed state: nothing is ever sent on a base the room does not have.
  2. **Every write goes through the leader** while one exists: other views' and the agent's intents are calls it runs;
     nobody else changes the shared state. Without a leader, the room applies the agent's writes itself.
- **Where it differs from a plugin's object:** the leader can vanish or stall (a background tab). Then the next view
  takes over from the room's state (section 5.3); calls the old leader had not answered end `uncertain`. A sketch that
  must keep running without views, hold large state or take many writes per second is a plugin.

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
  reconnects, `rooms.md` §1), so a game's player slot and a text editor's watermark keep their key across a reconnect.
  One link per editor is admitted: the room records the editor's active link inside its transaction and accepts writes
  only from it; a newer link replaces the older (whose cleanup never touches the newer one's part).
- **The leader** is the peer that may write and is connected longest without interruption: a leader whose link drops
  loses leadership at once, and coming back makes it the newest peer. Leadership moves once on a drop and never swaps
  back. A game derives sides from player slots in its state, never from presence order.

## 4. The view kit API

```js
const room = p2view.room();               // opens the frame's link on first use

// presence
room.me; room.peers; room.leader; room.isLeader;
room.onPeers((peers, leader) => ...);

// state: shared, persisted; a joiner gets it at once
room.state;                                // the room's confirmed state (the leader's tentative copy in the leader)
room.onState((state) => ...);

// intents: methods, declared once by every view (same code)
const { drop } = room.methods({
  drop: {
    description: "Drop a piece into a column",                       // the agent sees it (view_methods)
    args: { type: "object", properties: { col: { type: "integer" } }, required: ["col"] },
    run({ col }, { state, change, caller }) {                        // runs only in the leader, calls one at a time
      const slot = state.players[caller.id];                         // caller: who called, stamped by the room
      if (slot === undefined) throw new Error("not a player");
      const row = freeRow(state.board, col);
      if (row === undefined) throw new Error("column full");
      change((d) => { d.board[row][col] = slot; });                  // staged on the tentative copy, no waiting
      return { row };                                                // reaches the caller when the batch is confirmed
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
- **`run(args, { state, change, caller })`:** runs in the leader, one call at a time (its line). `state` is the
  tentative copy; `change(fn)` stages a draft on it at once (Chord Delta's tracker records the ops) and returns; `run`
  should be synchronous and do nothing but read `state` and stage changes (it may run again on another leader if the
  sketch marks it `idempotent`). `caller` is `{ kind: "peer", id, name }` or `{ kind: "agent" }`, stamped by the room
  from the principal, never from the arguments; the leader's own calls get its own peer. A `run` that throws discards
  only its own staged changes and refuses its call; the next call runs on the copy as it was.
- **Outcomes** of a method call and `changeMine`: `applied` (with the result, when the batch holding it is
  confirmed), `refused` (with the error: the run threw, or the room refused the batch, or a batch it depended on was
  refused; nothing of it was applied), `uncertain` (admitted, then the answer was lost: the leader vanished or timed
  out, the caller's link closed, cancellation); never retried by the kit.
- **Granularity:** only what a draft changes travels: change in place (`d.board[3][2] = "red"`), never rebuild
  (`d.board = next` sends the whole board).
- Read-only views get presence, state, peer state and events; method calls, `changeMine` and `emit` refuse them.
- `onState(state)` has no author: one notification may fold several batches.

## 5. The server

### 5.1 Contracts

- **`ViewRoom` version 3** (the generic room):
  - variant `peer` (frames): state members `facts` (store incarnation, `leader`, `term`, the confirmed number per
    stream, the calls pinned to the leader with their callers), `shared` (the shared state's envelope; `state` is
    reserved by Chord), `peers` (peer states by peer ID), `presence`; events `stream`; methods `join`,
    `commit({ term, n, ops, answers })` (the leader only), `changeMine({ n, ops })`, `emit`, `call({ method, args })`
    (a follower's intent), `offer`, `now`;
  - variant `viewer` (pages of people who may send): `update({ state } | { merge })` (the page bridge's `setState`);
  - variant `worker` (the session's worker): `methods`, `call`, `read`, `update({ state } | { merge })` (the agent's
    `view read`, `update` and `merge`).
  Old kits: open sketches on the old kit break until the view is closed and opened again (a new opening reloads the
  frame); accepted for the playground and written in `rooms.md`; no `accepts`.
- **`ViewText`** (the text room, unchanged in behaviour): today's text parts of `ViewRoom` version 2 (`room`, `log`,
  `keyed` for carets, `join`, `edit`, `history`, the base) under their own name, served by today's text code. The
  opening's mode (`state` or `text`) is recorded in the worker's views document at the first join and kept; a frame
  asking the other mode is refused.

### 5.2 Applying ops: a Delta helper

`applyOps(draft, ops)` in Chord Delta (exported from `chord/delta`; no transaction, store or wire code in it):
interprets ops on an existing draft with the draft's own mutations (assignment, delete, splice, `appendText`) and
placement checks, so the tracker records them and `self.tx` publishes its own normalized ops, never the incoming
tuples, and never through the plain-value `apply`. Its behaviour for a root `r` is documented (rooms always map `r`
away). The room calls it inside `self.tx(async (tx) => applyOps(await tx.draft(doc), ops), ctx)`.

- **Envelope:** the shared document is `{ value: JsonObject }`; the room maps the kit's `["r", v]` to `["s",
  ["value"], v]` and prefixes every other path with `"value"`. The peers document is `{ peers: { [id]: JsonObject } }`;
  a peer's ops map the same way under `["peers", id]`, the ID from the caller's principal; the peer must be present
  and the caller its active link, checked inside the transaction. A replaced value must be an object.
- **Trust boundary:** each op checked once (Delta's `assertValidOp`, safe paths) and applied strictly (a path that
  does not resolve, an index out of range, a placed value that is not JSON: `invalid/args`). The room does not catch
  it, so the transaction is discarded whole.
- **Documented, not enforced:** ops from a link land in the draft unchecked against the document's schema; the helper
  is for untyped documents, or for code that knows what it is doing (owner).
- Decision entry in Chord's `decisions.md`, design §9 (with the Durable rule: nothing but `tx` work in the callback).

### 5.3 The leader grant and calls

- `facts.leader` and `facts.term` change together, in one transaction on the room's line, when presence changes the
  leader (term + 1); that state message carries the room's state, from which the new leader's kit starts, writing only
  after it saw itself as leader.
- `commit({ term, n, ops, answers })` is applied only from `facts.leader`'s active link with `term === facts.term`,
  checked inside its transaction. The same transaction records `confirmed`, removes the answered calls from
  `facts`; after it commits, the room answers each call's caller with its result (the server answers at the commit:
  no extra leader round trip, Astra). A commit refused (term, size, budget, invalid ops) answers its calls `refused`.
- Calls are admitted with their caller and the current term. A leader change ends the old leader's unanswered calls
  `uncertain` (never given to the next leader, which could run them twice), except methods marked `idempotent`.
- **The leader's line:** the kit runs one call at a time, each bounded by `CALL_TIMEOUT`; a call past it has its
  staged changes discarded and is answered `uncertain` by the room at the same bound; the line goes on.

### 5.4 Batches and confirmation

- A **stream** is one writer's sequence of batches: the shared state's under one leader term, a peer's peer state
  under one room incarnation and one join of its editor. Batches carry `n` (1, 2, ... per stream); one is in flight,
  so the room needs only `facts.confirmed[stream] = n`, written in the batch's transaction: the state message that
  carries a batch carries its confirmation.
- **The leader's kit:** calls arriving while a batch is in flight run on the tentative copy and stage into the next
  batch; when `confirmed` reaches the in-flight batch, the next leaves. A refused batch: its calls and the building
  batch's calls are refused, the tentative copy is the confirmed state again.
- **`changeMine`:** changes made while one is in flight merge into the next (the peer is the only writer of its part,
  so merging is exact); a refused one refuses the merged ones too.
- **A lost answer:** a batch whose link closed before its confirmation resolves on the new link's first state:
  `applied` if the same stream's `confirmed` reached its `n`, otherwise `uncertain`.
- **Rejoin:** a peer's part is removed when its link leaves; on rejoin the kit republishes its local `mine` as the
  first batch of a new stream (a new submission, not a replay).

### 5.5 One gateway for writes, persistence

- **Every write of a custom view's state after its creation goes through the room store:** the agent's `view
  update`/`merge` and `read` (worker variant), the page bridge's `setState` (viewer variant), `open` of an existing
  view with state. The worker calls the room outside its Durable transactions. The view's **creation** commit seeds
  the worker's view, opening and initial state atomically before any room can exist for that opening (the one
  exception). The room store activates on demand (a write holds it, as a frame's join does) and ends after its linger.
  With a leader present it turns a write into a call of the leader's built-in `replace`/`merge` (reserved names the
  kit offers on every leader; shallow merge as the view tool's today; queued on the leader's line like any call);
  without one it applies the write itself (term + 1). So the room is the one authority whether or not views are open.
- **Saving:** a dirty revision; the room writes it through `ViewBacking.write` (compare-and-set by the backing revision
  it last wrote or read), one save at a time, after `ROOM_SAVE_PAUSE` without changes and at least every
  `ROOM_SAVE_EVERY` while changes keep coming; a success marks only the captured revision saved. **At the room's end**
  the store's native closer (it runs after the seal and still holds the backing reference) writes the last confirmed
  state after any save in flight, without a transaction of its own. A host shutdown closes links first, so there the
  last save may not reach the worker: documented as losing at most `ROOM_SAVE_EVERY`, like a crash.
- **A CAS mismatch:** the room reads the backing again; if the opening is closed, it stops and revokes its frames;
  if the backing holds the room's own earlier save (an answer lost), it adopts that revision and continues.
- **Shape:** the shared state is a JSON object; a view state that is `null` starts as `{}`; a scalar or array state
  cannot open a `state` room (the view tool's `help` says so).

### 5.6 Sizes: the existing limits, no new ones

- **Shared state:** the view state limit (`MAX_VIEW_STATE`, 256 Ki characters of JSON, Max's) applies per batch: the
  room applies the batch's ops to the plain confirmed value (`applyImmutable`, outside the transaction), measures it
  with `JSON.stringify` (about 0.5 ms at the limit on slayer; a draft would cost 10-15 ms, so never the draft), and
  refuses the batch if it is too large; otherwise it commits with `applyOps`.
- **Peer state:** one ledger of the `peers` member's encoded UTF-8 size, updated by the difference per change and on
  join and leave; a change or join that would take it past the part limit of the server's links to frames is refused.
- **Memory:** `viewRoomsMemory` charges the shared and peer states' sizes as measured above.

### 5.7 What goes

The journal, block documents, window, keyed member, `send`/`onMessage`, `history`, acknowledgements, trim, the lag
rule, log rooms and their snapshots, epochs and room kinds of the generic room.

### 5.8 The text room

Stays a server service (`ViewText`, both reviews: as a sketch it is feasible but not simpler: the complete ID model
and watermarks would count against the 256 Ki state limit, the agent's text updates need text-aware handling the
generic room cannot run without a leader, and remote typing would wait on a leader). `p2view.text()` replaces
`p2view.room("text")`; the agent's and the page's writes of a text view go through its validated edit path, as today.
A text sketch on the generic room can come later as a kit helper once it passes handover, refusal, reconnect,
agent-update and size tests.

## 6. Games on top (the owner's netplayjs question)

Both reviews: yes, transport aside, as an application protocol on these primitives (a helper the kit may ship later,
`p2view.netplay(Game)`, never a room feature):

- **Rollback** (netplayjs's model: deterministic `tick(inputs)`, `draw`, `serialize`/`deserialize`): match state
  written through the leader (`epoch`, roster of player slots keyed by peer ID, timestep, seed, checkpoint); inputs as
  events keyed by `(epoch, slot, frame)`, each batch repeating every input not yet acknowledged; each player's peer
  state holds the highest contiguous frame received per slot; a resend timer runs while the simulation is stalled;
  inputs are kept until every roster player acknowledged them; prediction repeats the last input; a mismatch restores
  the snapshot before the earliest affected frame and replays; a late joiner or a reconnect resumes from the
  checkpoint and the retained inputs, or the match restarts; events of an unknown epoch are buffered or dropped.
- **Lockstep:** inputs in shared state keyed `inputs[epoch][turn][slot]`, written through calls to the leader; a turn
  advances when every roster slot has its input; old turns are trimmed after every player passed them.

## 7. Performance (the owner's question; both reviews, measured on slayer, Node 24)

| What | Cost |
| --- | --- |
| Shared-state throughput | one batch per leader round trip L, any number of calls per batch: 200 ms L: 5 batches/s; 20 intents/s need ~4 per batch |
| Latency of a follower's intent | follower to server F, plus server to leader and back 2L, plus the wait for the next batch (0 to L) |
| Latency of the leader's own intent | shown at once (tentative copy); confirmed after about L |
| Server per batch | `applyOps`: ~0.003 ms for a small edit; the size check: ~0.002 ms (512 characters), ~0.08 ms (51 K), ~0.45 ms (246 K) |
| Peer state per change | ~0.4 ms at 1,000 peers for the ledger and the map update, before fan-out |
| Fan-out | Chord's state path: one encode per hold per batch; a joiner's snapshot |
| Memory | the confirmed shared and peer state, the ledger, the calls; no journal; the leader holds a tentative and an in-flight copy (structurally shared) |

- **Versus the first rooms:** no journal or acknowledgement accounting and smaller leaf updates; but the leader hop is
  new, and the first rooms pipelined sends (batching recovers throughput, not the hop).
- **Versus a plugin:** a plugin applies intents next to its state (one hop, no batch wait, small typed arguments
  instead of a whole-state size check) and keeps running without views: the right choice for high-rate shared
  updates, large state, or work that must go on when everyone left.
- The phone's numbers are measured in the build (the server runs there).

## 8. Timing constants (named, owner: name them all)

`ROOM_SAVE_PAUSE` (300 ms after the last change), `ROOM_SAVE_EVERY` (2 s while changes keep coming), the room store's
linger (10 s), `CALL_TIMEOUT` (60 s, the leader's line and the caller's wait), `TOKEN_TTL` (60 s), `TOKEN_WAIT`
(10 s), `MAX_BACKOFF` (10 s), `CLOCK_EVERY` (10 s); kept together in `room-timing.ts` and listed in `rooms.md`.

## 9. Tests

- **Chord:** `applyOps` (every verb on a draft, strictness, a valid op then an invalid one with the transaction
  discarded, publication equal to the hand-written mutations, root `r`, cost guards).
- **p2:**
  - Contracts: `ViewRoom` 3 with its three variants; `ViewText` with the text code unchanged; the opening's mode kept.
  - The leader as server object: calls one at a time; `caller` stamped (two players' `drop(3)` from two views land in
    rows 5 and 4 with their own slots); a throwing run refuses only its call; batching (calls during a batch in flight
    go into the next; answers at the commit); a refused batch refuses its calls and the building batch; a leader past
    `CALL_TIMEOUT`.
  - The leader grant: a follower's `commit` refused; a leader drop moves leadership once and never back; the new
    leader starts from the granted state; the old leader's late commit refused, its calls `uncertain`; one link per
    editor.
  - Confirmation: state before the answer; a disconnect after commit (applied on the new link) and before
    (`uncertain`); a new incarnation; rejoin republishing `mine` as a new stream.
  - Peer state: prefixing, `r` mapping, a departed peer's in-flight change refused, the ledger across joins.
  - The gateway: the agent's update, merge and read, the page's `setState`, `open` with state, with and without a
    leader; creation seeding before any room; built-in `replace`/`merge` on the leader's line.
  - Saving: after a pause, at the pace, at the end by the closer, one at a time; a CAS mismatch on a closed opening
    and on the room's own lost save.
  - Size refusals at both limits; events unchanged; the text room unchanged.
- **Chromium:** two views share state and peer state both ways; a reconnect keeps the peer ID and republishes its peer
  state; Pong (player slots in state, paddles as events) and Connect Four rewritten on the new API.
- `rooms.md` and the view tool's `help` rewritten.

## 10. Order of work

1. Chord: `applyOps` in Delta with its tests, design §9 and a decision entry; code review; commit.
2. p2: sections 3-5 with the tests; measure section 7's numbers on the phone; code review; commit; deploy.
3. Pong and Connect Four on the new API.

## 11. Review record

- **First draft (both):** the reserved member name `state`; Delta records revision differences, not intents; no
  confirmation model; two authorities and save conflicts; budget-only admission; text rooms losing their machinery;
  peer `r` and root rules; old kits not reloading; `by` unanswerable.
- **Second draft (both):** a single writer alone does not keep its base after a refused pipelined change; stable
  identity is no leadership; async calls writing after a term change; "refused" for outcomes that may have committed;
  the "room exists" branch and the page's `setState` bypassing the room; a per-peer quota overflowing as peers join.
  Astra proposed revision compare-and-set; the owner's model (the leader view as the sketch's server object) keeps the
  single writer.
- **Third draft (both):** the caller's identity missing (every move credited to the leader); `await change()` making
  batching impossible and a refused change look like success (now staging, answers at the commit); timed-out calls on
  the leader's line; the gateway's reachable contract and creation rule; linger not saving before the end (now the
  closer); peer state on rejoin (now republished as a new stream); the text room's own contract and the opening's mode;
  stringify of a draft costing 10-15 ms (now the plain value). Text as a sketch: feasible, not simpler; it stays a
  service.
