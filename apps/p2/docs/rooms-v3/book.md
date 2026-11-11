---
title: Rooms, the simple way: thirteen use cases
cover: Rooms / Use Cases
kicker: A walkthrough · p2 rooms v3 · 2026-11-11
subtitle: The server orders what people do, every view computes the same state, and thirteen real uses show where that is enough and where it is not
stats:
  - 13 | use cases worked through
  - 1 RTT | from a tap to every view
  - ~0.19 ms | server work per input (approximation)
  - 0 | browsers in the input path
note: |
  Based on the working model `apps/p2/docs/rooms-v3-model.md`, the independent verdicts of claude-opus-5-5
  (`/tmp/rooms-verdict-opus.md`) and gpt-6-astra (`/tmp/rooms-verdict-astra.md`), and the use cases worked through by
  claude-opus-5-5 (games, `/tmp/uc-opus.md`), gpt-6-astra (documents and boards, `/tmp/uc-astra.md`) and gpt-6.1-sol
  (cross-cutting, `/tmp/uc-sol.md`), each cross-reviewed by another (`/tmp/uc-review-{opus,astra,sol}.md`); second
  edition with all three cross-reviews folded in; third edition with the RTS chapter rewritten from Terrano and Bettner's
  "1500 Archers on a 28.8" (read in full) and the glyph chapter rewritten from Max's actual editor (his gist:
  `glyph-editor.html`, `glyph-editor-ge.py`, `glyph-editor-bridge.js`), after the owner rejected both stories. Nothing here is built. Latencies are estimates
  at 200 ms round trip; server costs come from an isolated approximation of today's publish path, not from a v3
  implementation. Notes marked *review* are open points found while working through the cases.
colophon: Rooms v3 use cases · third edition · 2026-11-11 · p3 session 8b6ab5cc with Opus, Astra and Sol
---

# Before we begin {.preface}

Mario opens a Connect Four view on his laptop; his son opens the same view on the tablet in the next room. Each taps a
column, the piece falls on both screens about a fifth of a second later, and the agent, asked "who is winning?",
looks at the board and answers. They stop for dinner and continue the next evening, where they left off. A guest at
a meetup watches a Pong match on her phone without being able to play. Max reshapes the `a` of a typeface while the
agent fixes the other glyphs and writes them back to the font's sources. Each of these is a **sketch**: an HTML view the agent wrote, running in a sandboxed
frame, with no server code of its own.

The first rooms (built, `rooms.md`) gave sketches a numbered journal, keyed messages, three room kinds,
acknowledgements and a lag rule; the lag rule evicted Pong players in turn every 30 seconds, and their sides swapped
mid-game. The second design (`rooms-v2.md`, four drafts, three reviews) made one browser tab the sketch's server: it
grew terms, grants, batches and refusal cascades, and every review found new holes in exactly those parts. Two
independent reviewers then recommended what Mario had described as his model all along, the "1500 archers"
lockstep: **the server only orders what people do; every view computes the same state from it.**

This walkthrough takes that model through thirteen uses, from Connect Four to the son's robot, and says for each
one what the person sees, what the sketch's code looks like, what crosses the wire, what the agent can do, what
survives a restart, how it fails, what it costs, and whether it works.

## Nine things to know

:::findings
1. **The server orders, it never computes.** It stamps each input with a number, a sender and the server's time, and
   sends it to every view. It does not parse inputs or run the sketch's code.
2. **Every view computes the same state.** The sketch declares `initial()` and one deterministic `apply` per kind of
   input; every view folds the same inputs in the same order. An invalid move is a no-op in every view: rules hold
   without an authority.
3. **Checkpoints let people start late and the server forget.** A caught-up view posts the folded state at a
   number; the server accepts it by numbers alone, trims the inputs it covers, and saves it as the view's state.
4. **Cursors and motion stay out of the sequence.** Events carry motion (cursors, drags, paddles); peer state holds
   each view's latest value a joiner must see (a selection, a grabbed point, "typing"). A moving mouse never touches
   the journal.
5. **Games fit, with changes.** Connect Four is the model's best case. Pong works as a hybrid (paddles as events, one
   input per hit), with visible corrections at 200 ms. A small RTS works the way Age of Empires did: every player sends one input per turn, and a
   turn runs when all are in; no server clock.
6. **Documents mostly need no rules at all.** Max's glyph editor (a font on disk, edited by a person and the agent)
   needs only path-level built-ins the server applies, path reads for the agent, and read-only view assets for its
   big base data; a whiteboard hits the 256 Ki-character limit after about 150 strokes.
7. **The agent sees fresh computed state only while a view runs.** Otherwise it gets the last checkpoint plus the
   raw inputs after it, labelled as such. Data kept with the kit's built-in operations (`$set`, `$delete`, `$merge`)
   is the exception: the server applies those itself, so a shopping list the agent edits alone stays current.
8. **Some things are not sketches.** A trusted vote, hidden cards, real motors and secrets need a plugin.
9. **The model needs changes before it is built.** Identity and seats, input outcomes, saved watermarks,
   server-applied built-ins with path reads, view assets, a persisted input catalogue, migration, and more (the
   epilogue).
:::

## Words used throughout

A **view** is one open frame of a sketch on someone's screen; a **peer** is a view in a room, a **writer** one that
may change things, a **read-only** one that may only watch. A **room** is the server object all open views of one
sketch share. An **input** is something a person or the agent does (`drop({ col: 3 })`); the **sequence** is the
room's numbered order of inputs; **apply** is the sketch's deterministic function that changes the state for one
input; **folding** is applying inputs in order. A **checkpoint** is the folded state at a number; the **tail** is the
inputs after it. **Peer state** is each view's own latest value (a selection); an **event** is a lossy value for motion (a cursor).
An **epoch** starts when the state is replaced wholesale. A **plugin** is ordinary Chord code with its own server
object, the alternative to a sketch.

# How We Got Here {#history lede="Two designs, and why the third one is the owner's lockstep."}

The rooms built on 2026-11-11 (`rooms.md`) are a small replication system of their own: numbered messages in a
journal, keyed messages sharing the numbering, live, log and text room kinds, acknowledgements from every view, and
a lag rule that disconnects a view behind the others for 30 seconds. In the field, Pong views counted only plain
messages as applied while the game sent only keyed ones, so the view that joined first looked behind forever, was
evicted, rejoined with a new ID, and took the other side. The fix was one line; the lesson was that the coupling
between unrelated traffic and eviction was the problem.

The second design (`rooms-v2.md`) kept the state in Chord and made the oldest writer view the sketch's server: it
runs every intent on its copy and sends the changes. Four drafts and three review rounds made it correct, and each
round found new majors in the parts that exist only because the authority is a browser tab: leader grants with
terms, tentative copies, batches with one in flight, refusal cascades, calls pinned to a leader. A frozen phone tab as
leader stalls everyone, the agent included; a follower's move costs two to three round trips.

Opus and Astra, asked independently whether this was too complex, slow and brittle, both said yes, and both pointed
at the same alternative: systems without application server code either merge without an authority (Liveblocks,
Yjs) or sequence inputs and fold them in every client (Croquet). Electing a client as the server is game
middleware's "master client" pattern, known for exactly v2's failures. The second option is the owner's lockstep
model, and it reuses most of v1: the numbered journal was right; the acknowledgements, the lag rule and the mixing
of cursors into the numbering were not.

# The Model {#model lede="Five parts, one rule for each, and an API of about twenty lines."}

The room keeps one sequence of inputs per sketch. Every view runs the sketch's model over it. Everything that does
not need an order travels beside it.

| Part | What | Ordered | Kept |
| --- | --- | --- | --- |
| **inputs** | what a view or the agent does, stamped `{ seq, from, at }` | yes, one sequence | from the last checkpoint on, persisted |
| **model** | the sketch's `initial()` and one `apply` per input kind | - | code, in every view |
| **checkpoint** | `{ modelVersion, epoch, seq, value }`, posted by a caught-up writer view | - | the latest, as the view's state |
| **peer state** | each view's latest selection, grabbed point or "typing" | no | while the view is there |
| **events** | lossy motion: cursors, drags, paddles | no | never |

Presence (who is here) and the server's clock are as today. **Questions** stay from the first rooms: the agent may
ask a view something that is not a state change ("what lies under this region?"), answered by one view.

:::sequence animate | One input, from a tap to every view: one round trip for the sender, about the same for everyone else.
actor a "Alice's view" accent
actor server "room (server)" blue
actor b "Bob's view"
a -> a: tap: drop({ col: 3 }), counter n = 5
a -> server: input drop {col:3}, n 5
server => server: n > mark[Alice]? stamp seq 18, at; append
server --> a: seq 18
server --> b: seq 18
a -> a: apply: the piece falls
b -> b: apply: the piece falls
note a..b: the server neither parses the input nor runs apply
:::

## The API

```js
const room = p2view.room({
  version: 1,                                          // model version
  initial: () => ({ board: emptyBoard(), turn: 0, players: [] }),
  inputs: {
    join: { apply(s, _args, { from }) { if (s.players.length < 2 && !s.players.includes(from)) s.players.push(from); } },
    drop: {
      description: "Drop a piece into a column",       // the agent sees name, description and args
      args: { type: "object", properties: { col: { type: "integer" } }, required: ["col"] },
      apply(s, { col }, { from }) {                    // deterministic; an invalid input returns: a no-op everywhere
        const slot = s.players.indexOf(from);
        if (slot !== s.turn % 2) return;
        const row = freeRow(s.board, col);
        if (row === undefined) return;
        s.board[row][col] = slot; s.turn++;
      },
    },
  },
});
const { join, drop } = room.inputs;                    // functions, no strings
await drop({ col: 3 });                                // resolves { seq } once sequenced
room.state; room.onState((state, input) => draw(state));
room.me; room.peers; room.onPeers((peers) => ...);
room.setMine({ cursor: { x, y } }); room.onPeerState((id, value) => ...);
room.emit(v); room.onEvent(({ from, at, value }) => ...);
room.answer({ describeRegion: async (args) => ... });  // questions the agent may ask
```

`apply` gets `meta`: `from` (the sender, or `"agent"`), `at` (server time), `seq`, and `rand()` seeded by `seq`.

## The rules

- **Exactly once.** Every input carries its editor's counter; the server drops what it has seen (the text room's
  watermark rule); the kit resends unconfirmed inputs after a reconnect.
- **Determinism is the sketch's contract.** `apply` reads only its arguments and `meta`: no `Date.now`, no
  `Math.random`, no DOM, no network. Views compare state hashes at the same number to notice drift.
- **Checkpoints by numbers.** A caught-up writer posts one every couple of hundred inputs or after a quiet moment;
  the server accepts it for the current version and epoch if it is newer, trims, and saves it as the view's state.
  No leader, no term: a checkpoint at a number is a function of the inputs before it.
- **Persistence.** The server saves the checkpoint and the tail periodically, without any view.
- **No server clock.** Turns are the game's own: in a real-time simulation every player sends one input per turn and a
  turn runs when all are in, as in Age of Empires (chapter V). The server never ticks.
- **Built-in data operations.** `room.set(path, value)`, `room.delete(path)`, `room.merge(path, value)`, list append and
  remove, and conditional forms, are the kit's own inputs; the server applies them to the checkpoint itself whenever
  the tail holds no custom input (Opus, cross-review). Documents kept with them need no view for current state and
  no `apply` at all, which is most documents (chapter VI).
- **The agent.** It reads (fresh with a view running or a built-ins-only tail, labelled stale otherwise), sends inputs
  by name, replaces the state (a new epoch), merges, and asks questions (chapter XII).

:::note | What is reused and what is new
Reused from the built rooms: principals, tokens, revocation, the journal blocks, the window and history paging, the
memory budget, events, presence, the text room, questions. New: input deduplication by editor, checkpoints from any
caught-up writer, persisting the tail, model versions and epochs, the agent's read barrier (Sol checked each against
`apps/p2/plugins/views/`).
:::

# Connect Four {#connect-four lede="The model's best case: small state, turns, rules every view can check."}

Two seated players take turns; others watch. A piece lands about a fifth of a second after the click, and the
sketch can show a faded ghost at once. Hovering over a column shows a marker on the other screen.

```js
const ROWS = 6, COLS = 7, empty = () => Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
const room = p2view.room({
  version: 1,
  initial: () => ({ board: empty(), turn: 0, players: [], winner: -1 }),
  inputs: {
    join: { description: "Take a free seat", apply(s, _a, { from }) { if (s.players.length < 2 && !s.players.includes(from)) s.players.push(from); } },
    drop: {
      description: "Drop your piece into a column (0-6) on your turn",
      args: { type: "object", properties: { col: { type: "integer", minimum: 0, maximum: 6 } }, required: ["col"] },
      apply(s, { col }, { from }) {
        const slot = s.players.indexOf(from);
        if (s.winner !== -1 || s.players.length < 2 || slot !== s.turn % 2) return "not your turn";
        const row = freeRow(s.board, col);
        if (row === undefined) return "column full";
        s.board[row][col] = slot; s.turn++;
        if (fourFrom(s.board, row, col, slot)) s.winner = slot; else if (s.turn === ROWS * COLS) s.winner = 2;
      },
    },
    rematch: { description: "New game, seats swapped", apply(s) { if (s.winner === -1) return; s.board = empty(); s.turn = 0; s.winner = -1; s.players.reverse(); } },
  },
});
const { join, drop, rematch } = room.inputs;
room.onState((s) => draw(s));
boardEl.onclick = async (e) => { ghost(colAt(e)); await drop({ col: colAt(e) }); clearGhost(); };
boardEl.onpointermove = (e) => room.setMine({ hover: colAt(e) });
room.onPeerState((id, v) => drawHover(id, v?.hover));
```

## What happens

At t = 0 Alice clicks column 3; the kit sends `drop { col: 3 }` with her counter and the sketch draws a ghost. At
about 100 ms the server checks the counter, stamps `seq 18`, appends and fans out, without parsing the input. At
about 200 ms both views apply it; the piece falls, the ghost clears, `drop()` resolves `{ seq: 18 }`. If Bob clicked
while it was still Alice's turn and his `drop` reached the server before hers, it becomes `seq 17` and is a no-op in
every view: his ghost disappears, and nothing tells him why. If his click reaches the server after hers, it is his
turn by then and the move counts, although he made it without seeing her piece; a sketch that wants to prevent that
sends the turn number it saw and refuses a mismatch (Sol, cross-review). After a quiet 300 ms the checkpoint writer posts the 250-byte board and the server saves it.

## Joining, the agent, persistence

A joiner gets the checkpoint (usually current, thanks to the quiet rule) and folds the few inputs after it. A
dropped link keeps the seat and the kit resends an unconfirmed `drop`, applied once. The agent reads the 250-byte
board directly (with a view open, a fresh read takes 200-300 ms), takes a seat and plays as `"agent"`, and can set up
a puzzle with `view update` (a new epoch; an opponent's drop in flight is refused). It cannot wait for its turn: it has
to ask again. A server crash rewinds by whatever was not saved yet; with a save interval of a couple of seconds that
is a move or two.

## How it fails

- **Clicking out of turn:** the ghost appears and vanishes with no message; `drop()` only says it was sequenced.
  The ghost must stay until the input is applied locally, not until the server's receipt.
- **A reload loses the seat.** `from` is today the frame's editor ID, new on every reload and every day; the player
  is no longer `players[slot]` and can never move again in this game.
- **An opponent who never returns:** the game waits forever; the rules cannot see who is present.
- **A hostile writer posts a fake checkpoint** (a win): accepted. Hashes show the mismatch; same trust as today.

**Numbers:** about 100 bytes per input per view, about 0.19 ms of server work per input, a 250-byte checkpoint, under
2 KB per room. **Verdict: works well.** Caveats: identity across reloads, no feedback for a no-op, no way for the agent
to wait.

# Pong {#pong lede="Lockstep is unplayable at 200 ms; a hybrid with paddles as events is not."}

**Lockstep, rejected.** If every view sends its paddle each tick and every view runs the ball's physics, your own
paddle reaches the simulation one round trip plus a tick after you move it: 200 to 250 ms at 200 ms round trip. Drawing
it locally does not help, because the hit is judged against the sequenced paddle, so the ball passes through the
paddle you see. At 60 ms round trip lockstep would be acceptable.

**The hybrid, chosen.** Paddles travel as events. The ball is state, changed by one sequenced input per hit or
miss. The side the ball heads to decides, with its own current paddle.

```js
const W = 800, H = 480, PAD = 80, V = 0.5;
const launch = (y, dir, vy, t0) => ({ y, dir, vy, t0, arrive: t0 + (W - 40) / V });
const defender = (s) => s.players[s.ball.dir > 0 ? 1 : 0];
const room = p2view.room({
  version: 1,
  initial: () => ({ players: [], score: [0, 0], rally: 0, ball: null }),
  inputs: {
    join: { apply(s, _a, { from }) { if (s.players.length < 2 && !s.players.includes(from)) s.players.push(from); } },
    serve: { apply(s, _a, { at, rand }) { if (s.players.length === 2 && !s.ball) s.ball = launch(H / 2, rand() < 0.5 ? 1 : -1, rand() * 0.4 - 0.2, at); } },
    hit: { apply(s, { rally, off }, { from }) { if (s.ball && rally === s.rally && from === defender(s)) { s.ball = bounce(s.ball, off); s.rally++; } } },
    miss: { apply(s, { rally }, { from, at }) {
      if (!s.ball || rally !== s.rally || (from !== defender(s) && at < s.ball.arrive + 1500)) return;  // the attacker may claim after 1.5 s
      if (at < s.ball.arrive + 10000) s.score[s.ball.dir > 0 ? 0 : 1]++;                                  // a stale rally scores nothing
      s.ball = null; s.rally++;
    } },
  },
});
canvas.onpointermove = (e) => { me = e.offsetY; room.emit({ y: me }); };
room.onEvent(({ from, value }) => { if (from !== room.me) them = value.y; });   // buffered by `at`, drawn ~100 ms behind
// each frame: when the ball arrives on my side, judge it with my paddle: hit({ rally, off }) or miss({ rally }),
// and draw my predicted bounce at once until the sequence confirms it
```

:::sequence animate | A hit: Bob defends; the ball arrives at t = 5000 in server time.
actor a "Alice (attacker)"
actor server "room" blue
actor b "Bob (defender)" accent
b => b: t=5000: ball arrives, paddle at 300: hit({ rally: 7, off: 0.25 }); draw the bounce at once
a -> a: t=5000: predict the bounce from Bob's last paddle
b -> server: hit
server -> server: t≈5100: seq 42
server --> a: seq 42
server --> b: seq 42
a -> a: t≈5200: apply: correct the predicted bounce by a few pixels
:::

Your paddle follows your finger with no delay, the ball moves smoothly on both screens from a shared trajectory and
the server clock, and you never lose to a ball that passed through your paddle. The opponent's paddle trails by about
a quarter second. The attacker predicts the bounce from the opponent's last paddle, about 200 ms old; the real `off`
can differ by up to 2, which moves the ball by up to 120 px by the time the hit arrives (Sol, cross-review), so the
sketch blends the correction over a moment. The defender's decision is trusted: every view replays it, none checks the
collision itself. **Numbers:** one sequenced input every 1.5 s, paddle events throttled to about 30 per second per
player of about 70 bytes, state under 1 KB. **Verdict: works with caveats** at 60 to 200 ms: visible corrections after
the opponent's hits, the sketch writes its own prediction (the kit gives no access to pending inputs), and a reload
loses the seat.

:::review | Review: the sketch above is not finished
Sol found three bugs in this code: a defender returning the next day can hit the hours-old ball before the timeout
voids the rally (stale rallies must be handled before any collision test); `hit` has no time window and `miss` lets an
unseated view claim; `bounce` reuses the vertical speed before the wall reflections instead of the reflected one. Fix
before using it as the reference sketch.
:::

# A Little RTS {#rts lede="Age of Empires' model, as the article describes it: commands for two turns ahead, and a turn runs when every player's turn is in."}

Three players, 500 archers each, integer math. The model is the one Mark Terrano and Paul Bettner describe in "1500
Archers on a 28.8" (Age of Empires, 2001), and it maps onto the room almost one to one.

## What Age of Empires does

- **Simultaneous simulations.** No unit state crosses the network; every machine runs the same simulation from the
  same commands. Passing positions would have capped the game at 250 moving units.
- **Commands for two turns ahead.** Commands issued during communication turn 1000 execute in turn 1002, so they are
  received and acknowledged while turn 1001 still animates. Turns were about 200 ms; rendering frames are separate.
- **A turn runs when every player's turn is in.** Each machine sends a "Turn Done" each turn, with its commands. The
  game runs only as fast as the slowest machine and connection; a frozen machine stalls everyone.
- **Speed control.** Each Turn Done carries the frame rate that machine can sustain and its longest ping (2 bytes);
  the host sets the next turn length from them, rising fast and settling slowly, because a steady 500 ms of command
  latency plays better than latency jumping between 80 and 500 ms. Players did not notice 250 ms at all.
- **Out of sync stops the game.** Checksums of the world catch the slightest divergence ("a deer slightly out of
  alignment ... minutes later a villager would path a tiny bit off"); random numbers are seeded and synchronized and
  must be drawn the same number of times everywhere.
- **Recorded games come free.** The command stream replays the whole game; it became a feature and the best bug report.
- **Players send a command every 1.5 to 2 seconds,** spikes of 3 to 4 per second in battles; repeated clicks on the
  same spot are filtered.

## In the room

Each player's view sends **one input per turn**, its Turn Done: the commands collected during the turn, scheduled for
two turns ahead, plus its frame rate, its ping and a hash of an earlier turn's state. The room orders them; that is
all the server does. Every view runs turn T as soon as the sequence holds every seated player's input for T. Since
every view sees the same sequence, every view runs every turn at the same point and in the same way. No server ticks,
no host: the turn length is a deterministic function of the reported frame rates and pings, computed identically in
every view.

```js
const AHEAD = 2;
const room = p2view.room({
  version: 1,
  initial: () => ({ turn: 0, turnMs: 200, seats: [], units: [], pending: {}, nextId: 1, outOfSync: false }),
  inputs: {
    seat: { description: "Take a free seat before the match starts", apply(s, { name }, { from, rand }) {
      if (s.turn === 0 && s.seats.length < 3 && !s.seats.some((x) => x.peer === from)) spawn(s, { name, peer: from }, rand);
    } },
    turnDone: {
      description: "One player's commands for a turn, sent every turn even when empty",
      apply(s, { t, commands, fps, ping, hash }, { from }) {
        const seat = s.seats.findIndex((x) => x.peer === from);
        if (seat < 0 || t < s.turn || s.outOfSync) return;
        (s.pending[t] ??= {})[seat] = { commands, fps, ping, hash };
        while (s.turn < AHEAD || s.seats.every((_, i) => s.pending[s.turn]?.[i])) runTurn(s);
      },
    },
  },
});
function runTurn(s) {
  const turn = s.pending[s.turn] ?? {}; delete s.pending[s.turn];
  for (const [seat, { commands }] of Object.entries(turn)) for (const c of commands) command(s, Number(seat), c);
  if (new Set(Object.values(turn).map((x) => x.hash)).size > 1) s.outOfSync = true;   // the senders' hashes of turn T-2
  s.turnMs = speedControl(s.turnMs, turn);       // from every fps and ping: rise fast, settle slowly, the same in every view
  simulate(s, s.turnMs);                          // integer steps, squared distances, fixed tie order, rand from meta
  s.turn++;
}
// the view: collect clicks during a turn, send them for two turns ahead
let commands = [];
canvas.onpointerup = () => commands.push({ box: dragBox(), x: px(mouse.x), y: px(mouse.y) });
setInterval(() => {
  room.inputs.turnDone({ t: room.state.turn + AHEAD, commands, fps: sustainableFps(), ping: room.rtt(), hash: hashOfTurn(room.state.turn - AHEAD) });
  commands = [];
}, room.state.turnMs);
```

:::sequence animate | One turn: three players, 200 ms turns, 200 ms round trip; A's click executes two turns later in every view.
actor a "A's view" accent
actor server "room" blue
actor b "B's view"
actor c "C's view"
a -> server: turnDone t=1002: [order hill], fps 30, ping 200, hash(1000)
b -> server: turnDone t=1002: [], fps 60, ping 180, hash(1000)
c -> server: turnDone t=1002: [], fps 24, ping 210, hash(1000)
server --> a: seq 3007, 3008, 3009
server --> b: seq 3007, 3008, 3009
server --> c: seq 3007, 3008, 3009
note a..c: turn 1001 still animates meanwhile
a -> a: all three for 1002 are in: run turn 1002, the archers turn towards the hill
c -> c: the same turn, the same result; hashes of 1000 agree
:::

## What the person sees, and when

A's click shows a target marker at once; the archers start moving two turns later, about 400 ms with 200 ms turns,
the same moment on every screen (as the article says, 250 to 500 ms is very playable in an RTS, and steady matters more
than short). If C's phone falls behind, its frame rate in its turn inputs raises the turn length a little for
everyone; the game slows smoothly instead of stuttering.

## Waiting, leaving, coming back

- **A frozen phone stalls the match,** as in Age of Empires: no turn runs without C's input. After a while the others
  can sequence `drop({ seat })`, which every view applies at the same turn, and the match goes on without C's commands
  (C's archers stand).
- **Everyone leaves:** nobody sends turn inputs, so nothing runs; there is no server clock to keep the battle going
  through the night. The next day the views load the checkpoint, and the match resumes when the seated players are
  back (or the others drop the missing ones).
- **A spectator or a late view** loads the checkpoint (taken at any number: the state includes the pending inputs of
  future turns) and replays the inputs after it, about 1 s on a phone for a few hundred.
- **Out of sync** stops the game for everyone, visibly, as in Age of Empires, and the recording (checkpoint plus
  inputs) is the bug report. Refolding silently would hide exactly the bug the article spent years on.
- **Recorded games:** the sequence is the recording; a replay view folds it from the start of the match.

## Numbers and verdict

Three players at 200 ms turns send 15 inputs per second, mostly empty (about 60 bytes, commands about 40 bytes more):
about 3 ms of server work per second at the 0.19 ms approximation, 2.7 KB/s of fan-out per view. The checkpoint (about
60 KB for 1500 units) goes out every few hundred inputs, about every 20 to 30 seconds. **Verdict: works well,** with
no tick machinery in the room at all. What it needs from the model: seats that survive a reload (a frame ID changes,
so a seat must be reclaimable by its person), a migration when the sketch changes between sessions, and a simulation
loop that does not pay for a tracking draft on every unit (measure it). Like every sketch it trusts its players.

# Max's Glyph Editor {#glyph lede="Not a game with rules: a font on disk that a person and the agent edit together."}

The real editor (Max's gist, `glyph-editor.html`, `glyph-editor-ge.py`, `glyph-editor-bridge.js`) edits the UFO
sources of a typeface, Mallos Serif, four masters. The truth lives in `.glif` files on disk; the view holds a working
copy. Its state today:

| Key | What | Size |
| --- | --- | --- |
| `glyphs` | every glyph of one master, compactly encoded (`{ w, u, c: [[x, y, t, ...]], k, a }`) | the bulk; one master must fit the 256 KB view-state limit |
| `edits` | the unsaved glyphs, name to glyph, overlaying `glyphs` | small; kept first because the agent's `view read` returns only the first 40,000 characters |
| `current`, `notes`, `previewText`, `metrics`, `order` | the open glyph, the agent's notes pinned on glyphs, the preview line | small |

The page edits one glyph locally: points, handles, the pen, contours, components, undo. Dragging stays local; every
finished operation writes the whole glyph into `edits[name]` (`commit()`, through `p2view.setState`, saved after 300 ms
of rest). Its selection goes to the agent with `p2view.select` ("Regular /a: 2 points selected ...").

**The agent is the main partner,** through code-mode helpers (`bridge.js`): `load(master)` exports a master from the UFO
with Python and pushes it into the view (`view update` with the whole state); `peek()` reads the open glyph, the
unsaved names, the notes and the selection; `edit(fn)` changes glyphs programmatically (`api.get`, `api.set`,
`api.note`, `api.open`) and merges `edits`, `notes` and `current`; `save()` writes the unsaved glyphs back to the
`.glif` files and folds them into the base, keeping "edits made since the read". Every one of these works around a limit
of today's views: reads chunked to 30 KB because the read tool truncates, the state ordered so `edits` survive the
40,000-character read, whole-map merges that can overwrite a glyph the person changed meanwhile, and the 256 KB cap on a
master.

## Under the new model

The editor has no rules for the server or other views to agree on: it is a document. It needs no custom inputs and no
deterministic `apply`, only the room's built-in operations at path granularity, which the server applies itself:

```js
const room = p2view.room({ version: 1, initial: () => ({ edits: {}, current: null, notes: {}, previewText: "" }) });
// the page, after each finished operation on the open glyph: one glyph, one path
const commit = (name, glyph) => room.set(["edits", name], encode(glyph));
const open = (name) => room.set(["current"], name);
const dropNote = (id) => room.delete(["notes", id]);              // notes keyed by id, not by index
room.onState((s) => redraw(s));                                   // the agent's edits arrive as state changes
room.emit({ glyph: cur, points: draggedPoints() });               // optional: show the live drag to others
room.setMine({ glyph: cur, selection: selectedKeys() });          // who is on which glyph, for other people
```

And the agent, without rewriting the state:

```js
// code mode, through the view tool's room operations (proposed)
await tools.view({ action: "set", id: "glyph", path: ["edits", "a"], value: enc(fixedA) });   // one glyph, a few hundred bytes
await tools.view({ action: "read", id: "glyph", path: ["edits"] });                             // only what it needs
// save: write the .glif files, then drop each saved glyph from `edits` only if it is still what was saved
await tools.view({ action: "deleteIf", id: "glyph", path: ["edits", "a"], equals: hashOf(saved.a) });
```

What changes, concretely:

- **The agent's edits are small and current.** A glyph change is one `set` at `["edits", name]`, applied by the server
  whether or not the view is open, instead of a merge of the whole `edits` map. A person editing glyph `b` while the
  agent saves glyph `a` lose nothing; today's whole-map merge could.
- **Reads by path.** The agent reads `["edits"]`, `["current"]` or one glyph, not the first 40,000 characters of
  everything; the ordering trick and the chunked reads go away. This is possible only because the server applies the
  built-ins and so always holds the current document.
- **Saving without a race.** `deleteIf` drops a saved glyph from `edits` only if it still equals what was written to
  disk; an edit made during the save stays unsaved. A conditional built-in, compare-and-set on one path.
- **Same glyph, two people:** the later commit of the whole glyph wins. Peer state shows who has which glyph open, so
  people see the collision coming; finer merges inside a contour are not worth it (point indexes shift when points are
  added).
- **The base master is not state.** All glyphs of a master are reference data from disk that only `load` and `save`
  change. Kept in the room, they are what hits the 256 KB cap and makes every checkpoint and every joiner carry a
  whole master. They belong in a read-only **view asset**: a file of the session the frame fetches by URL, as it
  fetches its HTML, written by `load` and `save`. The room then holds only `edits`, `current`, `notes` and the
  preview line, a few KB.

**Numbers:** a glyph commit is a few hundred bytes to a few KB; the room's state is the unsaved glyphs plus a little;
the master asset is loaded once per frame (about 200 KB for Mallos Serif Regular). **Verdict: works well** with
path-level built-ins, path reads for the agent, a conditional delete, and view assets; the custom-input machinery of
the model plays no part. The ideas from the first edition of this chapter (point-level moves, a guarded whole-glyph
replace) were invented, not taken from the real editor.

# A Whiteboard {#whiteboard lede="Strokes as one input each at pointer-up; the checkpoint limit arrives early."}

A pen follows the hand at once; others see a slightly delayed preview that may have gaps, and pointer-up publishes
the complete stroke, which repairs them. Shapes can be selected and moved; overlapping edits settle in sequence order.

```js
const room = p2view.room({
  version: 1,
  initial: () => ({ items: {}, order: [] }),
  inputs: {
    stroke: { apply(s, a) { if (Object.hasOwn(s.items, a.id)) return; s.items[a.id] = { kind: "stroke", points: a.points, color: a.color, x: 0, y: 0 }; s.order.push(a.id); } },
    move: { apply(s, { id, x, y }) { if (!Object.hasOwn(s.items, id)) return; s.items[id].x = x; s.items[id].y = y; } },
    remove: { apply(s, { id }) { delete s.items[id]; s.order = s.order.filter((k) => k !== id); } },
  },
});
room.onState((s) => { drawBoard(s); clearCommittedPreviews(s.items); });
room.onEvent(({ from, value }) => previewFromPeer(from, value));   // lossy preview chunks while drawing
const finishStroke = (id, points, color) => room.inputs.stroke({ id, points, color });   // id: a UUID made by the page
```

The limit is size: a 150-point stroke is about 2 KB, so about 140 to 150 strokes exceed the 256 Ki-character
checkpoint (integer deltas instead of coordinates give about three times as many). Every stroke was accepted, the board still looks right, but checkpoints start failing and the tail grows
until the memory budget refuses work. The model has no rule or visible signal for that yet. And drawing is stroke, pause, stroke: the "300 ms after the last
input" rule would post the whole board after almost every stroke, 200 KB for a 2 KB stroke. Checkpoints for large
states go by the size of the tail relative to the checkpoint (say a quarter), and views that are current get a
reference, not the value (Opus, cross-review). **Numbers:** two artists
each finishing a stroke per second in a room of six views: about 24 KB/s of durable fan-out, plus about 60 KB/s of
previews. **Verdict: works with caveats for a small canvas.** A real whiteboard needs a document or file-backed
plugin; the sequencer does not solve size, persistent undo or large assets.

# The Family List {#family lede="Long-lived data the agent edits while nobody looks: custom rules do not fit, built-ins do."}

When a phone is open, items tick off and the other phone sees it about 200 ms later. When both phones are closed and
the agent queues "add milk" and "move dinner to Friday", the server stores the inputs but runs no model. The next
"what do we still need?" gets the old list plus a tail of commands, not the current list; the agent can reason
through the tail itself, but that is its work, not the room's.

```js
const room = p2view.room({
  version: 1,
  initial: () => ({ items: {}, order: [] }),
  inputs: {
    put: { description: "Add an item or change its label/day", apply(s, { id, label, day }) {
      if (!Object.hasOwn(s.items, id)) { s.items[id] = { label, day, done: false }; s.order.push(id); }
      else { s.items[id].label = label; s.items[id].day = day; } } },
    setDone: { description: "Set whether an item is checked", apply(s, { id, done }) { if (Object.hasOwn(s.items, id)) s.items[id].done = done; } },
    remove: { apply(s, { id }) { delete s.items[id]; s.order = s.order.filter((k) => k !== id); } },
  },
});
```

Three more problems follow from "nobody runs the model": a view question (`forDay`) cannot be answered with every
view closed; the agent can only send inputs whose names and schemas the server has persisted, which needs a
registration path the model does not have; and the tail grows (about 4 KB a day at 20 edits) until a phone opens.
Astra's verdict was a server-owned document or a plugin. Opus, in the cross-review, found a cheaper way inside the
model: the kit's built-in operations are the server's own vocabulary, so the server can apply them itself whenever
the tail holds no custom input. A list written with built-ins only is always current for the agent, takes writes with
no view open, and is saved without any view:

```js
const room = p2view.room({ version: 1, initial: () => ({ items: {}, order: [] }) });   // no custom inputs
const add = (label, day = "") => { const id = crypto.randomUUID(); room.set(["items", id], { label, day, done: false }); room.append(["order"], id); };
const check = (id, done) => room.set(["items", id, "done"], done);
const remove = (id) => { room.delete(["items", id]); room.remove(["order"], id); };
```

**Verdict: works well with built-ins;** custom rules (a list that refuses duplicates, a planner that moves conflicting
entries) need a view to run them, and then the caveat above holds. The built-ins need precise semantics (paths,
arrays, deletion) before they are built.

:::review | Review: built-ins or a separate document kind
Astra proposed a separate server-owned document kind; Opus proposes server-applied built-ins inside the room. Both give
the agent current data without a view; the built-ins keep one room kind. Open for the owner.
:::

# The Meetup Poll {#poll lede="Seventy guests are not the hard part; who may vote, and whether the tally can be trusted, are."}

Guests see a question, choices and live counts; eligible voters tap a choice and see it confirmed about 200 ms
later; voting again replaces the choice. The model records one choice per `from`.

```js
const room = p2view.room({
  version: 1,
  initial: () => ({ question: "Which session next?", closed: false, choices: { a: "Graphics", b: "Agents" }, votes: {} }),
  inputs: {
    vote: { description: "Set this peer's choice", apply(s, { choice }, { from }) { if (!s.closed && from !== "agent") s.votes[from] = choice; } },
    close: { description: "The agent closes voting", apply(s, _a, { from }) { if (from === "agent") s.closed = true; } },
  },
});
```

Thirty votes in a two-second burst to 71 views is about 0.38 MB of fan-out and about 6 ms of server work: fine. Four
things are not:

- **Permissions:** read-only guests cannot submit inputs, and there is no "may vote but not otherwise write" right.
- **Identity:** another tab or device is another voter; `from` is not a person.
- **Trust:** any writer may post a checkpoint, accepted by numbers; a modified client can post a fabricated tally.
- **Hashes:** if every view publishes a state hash after every input, 71 views turn 30 votes into about 150,000
  deliveries. Hash checks need a cadence.

**Verdict: works with caveats** for a small public honour-system poll; **needs a plugin** for one person one vote,
secret ballots or a trusted result.

# Shared Notes {#notes lede="The text service stays; only its carets move to peer state."}

Two people type in the same note; their own typing appears at once, the other's arrives without overwriting the
document, and named carets follow characters, not positions. The text room's rules (ID-based editing with
articulated, editor watermarks) keep running on the server, so no view has to run them and no checkpoint has to hold
the whole ID model.

```js
const text = p2view.text();                       // today's text client under its new name
const unbind = text.bind(document.querySelector("#note"));
text.onChange((value, from) => status(`${value.length} characters (${from})`));
text.onCursors((cursors) => drawCarets(cursors));
```

A joiner rebuilds the text from the text service's base and journal; a reconnect resends pending edits and the
watermarks stop duplicates. The agent's text changes stay ID-preserving edits, as today. Two notes from Sol's check
of the code: today's kit waits for each edit call per editor, about five confirmed batches per second per editor at
200 ms, enough for normal typing with a short local queue during bursts; and carets are still numbered keyed messages,
so moving them to peer state needs a small text-service facet.

:::review | Review: a text bug found while working through this
Astra reproduced data loss in today's text binder: while an input method composes (a phone keyboard's suggestions),
the binder keeps the old field text while remote edits arrive; at the end of the composition it submits the stale
field. Alice composes in `abc`, Bob inserts `x` meanwhile, Alice ends with `aZbc`: Bob's `x` is gone. The fix is in
the text client (rebase the composition's edit over remote changes), not in the room. Also missing: the text kit
reports later edit refusals only in the log, never to the page.
:::

**Verdict: works well** after that fix.

# Cursors and Presence {#presence lede="Latest values, never in the sequence, and N² once rooms get large."}

People see names appear as views connect, cursors moving on the same board, and highlights of others' selections.
Cursors are motion and go as events, about 20 per second; selections are latest values a joiner must see and go as
peer state. Peer state is Chord state, which a passive receiver gets about twice per round trip, folded: right for a
selection, too coarse for a cursor (Opus, cross-review). A departure removes the peer's state; nothing is journaled. Committing something (pinning an object) is an input; a
selection is not.

```js
pad.addEventListener("pointermove", (e) => room.emit({ cursor: normalised(e) }));      // motion: events
pad.addEventListener("click", (e) => room.setMine({ selection: e.target.dataset.id ?? null }));   // latest value
room.onEvent(({ from, value }) => moveCursor(from, value.cursor));
room.onPeerState((id, value) => paintSelection(id, value?.selection));
room.onPeers((peers) => { people.textContent = peers.map((p) => p.name).join(", "); });
```

**Numbers:** ten peers at 20 updates per second are about 2,000 deliveries per second (all-to-all), about 300 KB/s;
two peers about 12 KB/s. **Verdict: works well** for small rooms. Open: whether read-only guests may publish a cursor,
and which ID is the public one (today a link ID, while the reconnectable editor ID is another).

# The Agent {#agent lede="Five different operations, and one honest limit."}

The agent reads, sends inputs, replaces the state, merges, and asks questions. They are not five spellings of one
thing:

| Operation | What happens | Time at 200 ms |
| --- | --- | --- |
| **read**, a view open | the server asks a caught-up writer for a checkpoint at the current head | one view round trip, ~200 ms |
| **read**, no view | the last checkpoint plus the raw inputs since it, labelled with both numbers; current if the tail holds only built-ins | server only |
| **input** | an input by name, args checked against its schema, from `"agent"`; the game may still reject it as a no-op | server only to sequence |
| **update** | the value becomes a new checkpoint in a new epoch; old-epoch inputs are refused; works with no view | server only |
| **merge** | the built-in `$merge`, applied by the server itself when the tail holds no custom input | server only |
| **question** | one view answers ("what is under this region?"); `uncertain` if it leaves | one view round trip, ~200 ms |

The agent's tool runs on the session's worker, next to the server, so only the view's round trip counts (Astra,
cross-review).

The limit: a server that never runs the sketch cannot hand the agent the current computed state when no view runs
it. Astra put it as "pick three of four": arbitrary derived state, a server that never runs application logic, no
live view, and an immediate fresh read. Sketches choose the first three and label reads; data kept with built-ins gets
the fourth for free, and data with custom rules that needs it is a plugin. **Verdict: works with caveats** until the read results, reset fences, agent
request identities and a question catalogue with schemas are specified.

# Read-Only Guests {#guests lede="Watching is cheap and safe; hiding anything is impossible."}

A guest sees the same board and motion as the players and cannot move. A late guest gets the checkpoint and the tail
and renders once it has a coherent prefix. Re-enabling a button in developer tools changes nothing: the server
refuses the input. Revoking the share closes the guest's frame link; the game continues. Guests never pin history:
retention is checkpoint plus tail, not "keep everything until the slowest viewer catches up".

"Read-only" is an access rule, not secrecy: every view receives every input and the whole state. Hidden cards, a
robot's token or a private answer cannot be protected by a sketch. **Numbers:** an input reaches a guest in about
200 ms; 20 guests at 100 inputs per second of 200 bytes cost about 400 KB/s. **Verdict: works well** for public state;
**needs a plugin** for hidden information or anti-cheat.

# When Things Break {#failures lede="Reconnects, frozen phones, restarts, code edits and drift, one at a time."}

- **A lost reply.** Alice's input is sequenced as #80, her link drops before the answer. On rejoin the kit resends the
  same input identity, and deduplication must answer with #80, not append a second one. A watermark alone cannot map
  every older resend to its number: the receipts need persisting.
- **A frozen phone.** Everyone else goes on. The phone's presence disappears when its link closes (Chord pings after
  15 s of silence and closes at 30 s), not when the screen locks. It is never the reason a match stalls.
- **A server restart.** All views reconnect and get the saved checkpoint and tail. Inputs sequenced since the last
  save are lost and the views rewind by that much; the model does not yet name the save interval or show a "saved
  through" number.
- **The agent edits the HTML mid-session.** The pane replaces the frame. Version 2 must not fold a version 1 sequence,
  and an old frame elsewhere must stop submitting. Changing rendering only, changing rules compatibly, and starting a
  new model are three different things the agent has to say; a migration of the checkpoint is needed for the third.
- **Drift.** Compare hashes only at the same version, epoch and number. Refolding from a good checkpoint repairs a
  missed delivery; it cannot repair a nondeterministic `apply` or a bad checkpoint everyone trusts. The person needs to
  see "out of sync", not a silent loop.

**Verdict: works with caveats.** Ordinary reconnects and frozen phones fit well; restart durability, version
changes and repair need explicit protocols and visible states (connecting, catching up, incompatible version, reset,
budget refused, out of sync).

# Where Sketches Stop {#plugins lede="The son's robot, secrets, and rules that must hold with nobody watching."}

A sketch can show a robot plan; pressing a real motor button must be a command to a trusted owner of the device. A
motor call inside `apply` would run in every view, again on every replay and every join. Exactly-once sequencing does
not make a physical effect happen once. Closing every view must not remove speed limits, authentication or an
emergency stop, and a frozen phone must never be the stop mechanism.

The plugin version: the view sends a typed command to the plugin's server object, which owns the device connection,
checks limits, records the intent, drives the device and reports "accepted", "rejected", "done" or "outcome unknown"
as state. Credentials stay with that object, never in HTML, inputs, peer state or a checkpoint. The same holds without
hardware for timers, spending limits, protected game rules, audits and authorization.

**How a sketch grows into a plugin:** keep the rendering; move validation, state transitions and effects into the
plugin's object; replace sequenced inputs with typed command methods; expose state and events back to the view. One
authority, never the same rule in both the reducer and the plugin. How a sandboxed sketch reaches a plugin's objects
is not designed yet.

# What the Model Needs {.epilogue lede="The changes the use cases found, in order of importance, and the decisions for the owner."}

The core holds across all thirteen cases: the server orders, every view folds, checkpoints by numbers, cursors and
motion beside the sequence. Before building, the model needs these changes; the use cases that need each are in
brackets.

1. **Identity, three kinds.** `from` is the editor ID (the frame), kept across reconnects, and `room.me === from`;
   `meta.person` is the authenticated principal (the owner or a guest grant, with a role); a game's **seat** is its own
   state, claimed and recovered explicitly, since two of the owner's devices are one person (Sol). The editor map is
   persisted. [Connect Four, Pong, RTS, poll, presence, failures]
2. **Outcomes, validation, status.** `apply` may return a reason; a submit resolves `{ seq, result }` after the local
   apply (a local result, not a durable one); a throwing `apply` is a no-op everywhere; the kit checks `args` in every view before `apply` (the server
   checks only the agent's inputs); a room status: connecting, catching up, incompatible version, reset, out of sync,
   budget refused. [Connect Four, glyph, whiteboard, poll, agent, guests, failures]
3. **Durability and dedupe.** A named save interval; accepted versus saved progress; checkpoint, tail, epoch, version
   and per-editor marks saved together; a reconnecting kit finds its own input by `from` and counter, and a checkpoint
   carries the marks, so a lost reply resolves without a receipt table; agent tool calls get a request ID.
   [Connect Four, family list, poll, agent, failures]
4. **Checkpoint production and size.** Cadence by tail size relative to the checkpoint, by count or by time (the idle
   rule only for small states); a fallback producer when the preferred one is frozen; a reference, not the value, to
   current views; whether a checkpoint may exceed the view-state limit with a projection as the view's state; a
   refused checkpoint visible to person and agent. [RTS, whiteboard, family list, agent, failures]
5. **View assets.** Read-only files of the session a frame fetches by URL, as it fetches its HTML, for large reference
   data (a font master) that should not live in the room's state, its checkpoints and every joiner's snapshot. [glyph,
   whiteboard backgrounds, RTS maps]
6. **Server-applied built-ins.** Precisely defined `set`, `delete`, `merge`, list append and remove, and a conditional
   `deleteIf`/`setIf` (compare-and-set on one path), applied by the server while the tail has no custom input; the
   agent reads and writes by path through the view tool; `view update` takes an expected epoch or head; `at` never
   decreases and `seq` keeps rising across epochs. [glyph, family list, agent, simple boards]
7. **A persisted input catalogue.** Names, descriptions and schemas per opening and version, posted by the kit, stored
   by the server, for the agent's inputs with no view open. [family list, agent, Connect Four]
8. **Versions and migration.** `view update` carries the new version; a `migrate(value, fromVersion)` hook in the
   first newer writer; frames of the old version fenced. [RTS, failures, glyph, agent]
9. **The read contract.** `{ value, seq, head, epoch, version, fresh or stale, saved }`, a timeout and another writer as
   fallback, projections of large states. [Connect Four, RTS, family list, agent]
10. **Opt-in sequenced presence.** `$joined`/`$left` appended by the server at its own observation, so every view
    applies them at the same number. [RTS, Connect Four, Pong]
11. **Drift detection.** Hashes at fixed multiples of `seq`, compared at the same version, epoch and number, in a
    kit-owned slot, throttled in large rooms; a visible notice; a lint of `apply` sources. [RTS, poll, failures]
12. **Permissions and trust.** Whether read-only peers may publish peer state; a scoped "may submit these inputs"
    right (vote-only guests); any writer's checkpoint is trusted, documented. [poll, presence, guests]
13. **Questions as a catalogue** with description, args schema, which view answers, and the shape of `uncertain`.
    [RTS, glyph, whiteboard, agent]
14. **Agent wake-up:** wait for inputs after a number instead of polling. [Connect Four, RTS, family list]
15. **Kit conveniences:** `room.pending`; one `onState` after a catch-up; a plain-mutation mode for simulations
    (measure a 1500-unit step first). [Pong, Connect Four, RTS, glyph, whiteboard]
16. **Guidance:** events for motion, peer state for latest values; event payloads named `value` (today `data`).
17. **View lifecycle:** the page's old `setState` fenced for room views; library save and load capture checkpoint,
    tail and version. [glyph, whiteboard, family list]
18. **Text service:** carets as peer state, a fresh text read, the composition fix, edit refusals reported. [notes]
19. **A plugin path for sketches:** an authenticated way for a sandboxed view to call a plugin's typed methods.
    [robot, and any sketch that outgrows itself]

## Decisions for the owner

- **Build the sequenced room** as the generic sketch room, replacing v1's live and log kinds and dropping v2.
- **Server-applied built-ins** (Opus) or a **separate server-owned document kind** (Astra) for data the agent
  maintains alone, like the family list.
- **Identity:** `from` (the frame) and `person` (the principal), with seats left to each game.
- **Checkpoint trust:** any writer (simple; a modified client can lie) or only the owner's views (safer; stalls when
  the owner is away).

# Verdicts at a Glance {.appendix}

| Use case | Verdict | What it needs or where it stops |
| --- | --- | --- |
| Connect Four | works well | seats; no-op feedback; agent waiting |
| Pong (hybrid) | works with caveats | corrections up to 120 px; own prediction; seats; code fixes |
| RTS | works well | per-turn inputs as in Age of Empires; seats across reloads, migration, a cheap draft |
| Glyph editor | works well | path-level built-ins, path reads, a conditional delete, view assets for the base master |
| Whiteboard | works with caveats | checkpoint size limit, ~150 strokes |
| Family list | works well with built-ins | custom rules need a view; built-ins need precise semantics |
| Meetup poll | caveats / plugin | vote rights, identity, checkpoint trust, hash cadence |
| Shared notes | works well after a fix | the composition bug; caret facet for the text service |
| Cursors, presence | works well | read-only peer state, public ID |
| The agent | works with caveats | read freshness, reset fences, catalogue, waiting |
| Read-only guests | works well / plugin | no hidden information in sketches |
| Failures | works with caveats | receipts, save interval, versions, visible states |
| Robot, secrets | plugin | effects and secrets never in a sketch |

## Numbers

| What | Estimate |
| --- | --- |
| Tap to every view | about one round trip; A to B about (R_A + R_B)/2 |
| Server per input | ~0.19 ms single (an isolated approximation of v1's publish path, without validation, fan-out or storage) |
| Agent read with a view | ~200 ms (one view round trip; the tool runs next to the server) |
| Joiner | one checkpoint plus up to ~200 inputs; RTS ~1 s on a phone |
| Checkpoint | Connect Four 250 B, glyph 6-10 KB, RTS 60 KB, limit 256 Ki characters |
| Cursors | N² × rate: 10 peers at 20/s ≈ 2,000 deliveries/s |
