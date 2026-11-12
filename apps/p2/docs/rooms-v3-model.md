# Rooms v3: the sequenced model (working model for the use-case walkthrough)

Status: working model, 2026-11-11, by the p3 session (8b6ab5cc), from the independent verdicts of claude-opus-5-5
(`/tmp/rooms-verdict-opus.md`) and gpt-6-astra (`/tmp/rooms-verdict-astra.md`) after the owner's worry that rooms v2
(`rooms-v2.md`, a leader view acting as the sketch's server) was too complex, slow and brittle. Both recommend this
model; it is the owner's lockstep model ("1500 archers"). Not decided: the use-case walkthrough tests it first.

## The idea

The server orders inputs and never runs the sketch's code. Every view runs the same deterministic model over the same
ordered inputs and gets the same state. A checkpoint (a view's folded state at a sequence number) lets joiners and the
agent start late and lets the server forget old inputs. Cursors and motion do not go through the sequence.

## Parts

| Part | What | Ordered | Kept |
| --- | --- | --- | --- |
| **inputs** | what a view (or the agent) does: `drop({ col: 3 })`; stamped by the server `{ seq, from, at }` | yes, one sequence per room | from the last checkpoint on, persisted |
| **model** | the sketch's `initial()` and one deterministic `apply` per input kind, run in every view | - | code |
| **checkpoint** | `{ modelVersion, epoch, seq, value }`: the state after input `seq`, posted by any caught-up writer view | - | the latest, persisted (it is the view's state) |
| **peer state** | per peer, latest value (cursor, selection, "typing") | no | while the peer is there |
| **events** | lossy motion (Chord events) | no | never |
| **presence**, **clock** | as today | - | - |
| **questions** | v1's method calls with results, for things that are not state changes ("what is under this region?"), answered by one view, `uncertain` when it leaves | - | never |

## API (view kit)

```js
const room = p2view.room({
  version: 1,                                          // model version: views of another version do not share a sequence
  initial: () => ({ board: emptyBoard(), turn: 0, players: [] }),
  inputs: {
    join: { apply(s, _args, { from }) { if (s.players.length < 2 && !s.players.includes(from)) s.players.push(from); } },
    drop: {
      description: "Drop a piece into a column",       // the agent sees name, description and args
      args: { type: "object", properties: { col: { type: "integer" } }, required: ["col"] },
      apply(s, { col }, { from }) {                    // deterministic; mutates a draft; invalid input: return (a no-op everywhere)
        const slot = s.players.indexOf(from);
        if (slot !== s.turn % 2) return;
        const row = freeRow(s.board, col);
        if (row === undefined) return;
        s.board[row][col] = slot; s.turn++;
      },
    },
  },
  tick: 0,                                              // real-time sims: e.g. 50 ms; the server sends empty ticks when quiet
});
const { join, drop } = room.inputs;                    // functions, no strings
await drop({ col: 3 });                                // resolves { seq } once sequenced (exactly once, see below)
room.state; room.onState((state, input) => draw(state)); // after each applied input, and on join
room.seq;                                              // the last applied input's number
room.me; room.peers; room.onPeers((peers) => ...);
room.setMine({ cursor: { x, y } }); room.peerState(id); room.onPeerState((id, value) => ...);
room.emit(v); room.onEvent(({ from, at, value }) => ...);
room.now(); room.rtt();
room.answer({ describeRegion: async (args) => ... });  // questions the agent may ask (v1 methods)
```

`meta` in `apply`: `from` (the stamped peer ID, or `"agent"`), `at` (server time), `seq`, `rand()` (seeded by `seq`).

## Rules

- **Exactly once.** Each input carries its editor's counter `n` (the editor ID is stable across reconnects); the server
  drops `n <= mark[editor]` (the text room's watermark rule); the kit resends unconfirmed inputs after a reconnect.
- **Determinism is the sketch's contract.** `apply` uses only its arguments and `meta` (`rand`, `at`), no `Date.now`,
  `Math.random`, DOM or network. Views put `hash@seq` of their state in peer state; a mismatch is logged and the view
  refolds from the checkpoint.
- **Checkpoints.** The present writer view with the smallest peer ID posts one every ~200 inputs and 300 ms after the
  last input. The server accepts one for the current `modelVersion` and `epoch` with `checkpoint.seq <= head` and newer
  than the current one, by numbers alone (no leader, no term), trims the inputs it covers, and saves its value as the
  view's state.
- **Persistence.** The server saves the checkpoint and the inputs after it (periodically, no view needed); a restart
  loses at most the unsaved interval.
- **Real time.** With `tick`, the server sends an empty tick when no input came for `tick` ms; a turn closes by server
  time, never by waiting for every peer (a frozen phone does not stall the match).
- **The agent.** `view read`: if a caught-up writer view is open, a read barrier (the server asks it for a checkpoint
  at the current head, with a timeout); otherwise the last checkpoint plus the raw inputs since it, labelled with
  `seq` and `head`. `view input`: appends an input by name (args checked against its schema), from `"agent"`.
  `view update` (full replace): the server makes the value the new checkpoint and starts a new `epoch` (inputs of the
  old epoch refused); works with no view open. `view merge`: a built-in input `$merge` every view applies; queued if no
  view runs the model.
- **Model versions.** A view of another `version` gets the checkpoint but does not submit to or fold this sequence
  until it reloads or the epoch is reset.
- **Text** stays its own service (`p2view.text()`).
- **Limits:** the existing ones only (view state 256 Ki characters for checkpoints, the client part limit, the memory
  budget `viewRoomsMemory`).

## Costs (from the verdicts)

- One round trip from submit to "sequenced"; A's input reaches B in about (R_A + R_B)/2.
- Server per input: append to a journal block and the window, watermark compare, memory charge, fan-out; no parse of
  the input, no walk of the state (v1's measured publish path: ~0.19 ms single, ~13 µs per input at 20 per batch).
- Per checkpoint: replace the base, trim, one CAS write to the worker.
