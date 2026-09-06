# mini

A minimal coding agent on the durable `AgentHarness`, split across three processes that talk JSON
over a socket and a pipe. It exists to exercise the harness from a real client and to find out what
an RPC-shaped presentation actually needs from it.

```bash
node packages/coding-agent/src/experimental/mini/main.ts [--continue]

# while the harness is changing under us, run from source instead of built dist:
./node_modules/.bin/tsx --tsconfig tsconfig.json packages/coding-agent/src/experimental/mini/main.ts
```

`--continue` attaches to the newest session for the current directory. Starting `mini` twice attaches
two presentations to the same session; both see the same transcript, live.

## Topology

```text
tui        tui        tui          presentations: render, no agent state
  \         |         /
   \        |        /             unix socket, ~/.pi/agent/experimental/mini.sock
    \       |       /
        server                     routes calls, fans out events, spawns workers
       /        \
      /          \                 child process stdio pipes
  worker       worker              one per session: harness, storage, model runtime
```

A presentation holds one connection and reaches every service through it. The server answers
`sessions` itself and forwards anything else to the worker that connection is attached to, so the TUI
never learns which host answers what. The same rule runs backwards: a worker calling `sessions.list`
is answered by the server.

The first `mini` to start spawns the server detached. The server kills a worker when its last
presentation disconnects, and retires itself ten seconds after the last presentation leaves, so the
next start always runs current code. If that worker held an open durable operation, its replacement
automatically resumes the operation from the last recorded recovery state.

## Layout

| path | role |
| --- | --- |
| `main.ts` | the `mini` command |
| `shared/transport.ts` | `Connection`: newline-delimited JSON over any duplex pair |
| `shared/rpc.ts` | frames, named services, routing, liveness, cancellation |
| `shared/protocol.ts` | service tokens, contracts, wire types |
| `server/run.ts` | routes, worker supervision, event fan-out |
| `worker/run.ts` | opens the session, builds the harness, provides services |
| `worker/lane-service.ts` | `Lane`: watch subscriptions and lane commands |
| `worker/models-service.ts` | `Models`: catalog, accounts, interactive login |
| `tui/run.ts` | presentation host: ensure server, attach, run the view |
| `tui/session.ts` | attach, subscribe, hold the replicated snapshot |
| `tui/view.ts` | alt-screen rendering, reusing interactive-mode components |

## RPC

Two verbs. **Call** asks a question and gets one answer; **emit** publishes to whoever listens. Both
directions on every connection.

```ts
const peer = createPeer(connection, { forward });   // forward handles names this peer lacks
peer.provide(Lane, laneService);                    // register and announce
const lane = peer.use(Lane);                        // Remote<LaneServiceApi>
await lane.prompt("hi");                            // -> { kind: "call", id, method: "lane.prompt" }
peer.on(Lane, (event) => fold(event));              // typed by the token
```

The wire is six frame kinds: `call`, `result`, `error`, `cancel`, `event`, `announce`, `ping`.
Replies correlate by `id` and resolve one promise; events carry a service name and no id, so the two
never interfere — a five-minute `lane.prompt` sits pending while its stream of events flows past.

Services are plain objects registered under a token, and a token carries the name plus the call and
event types, so `provide` checks the implementation and `use` checks the caller. Names are announced
on registration, so routing is a lookup and an unroutable call fails with both inventories named.

Failure handling: a closed connection rejects every pending call and aborts every in-flight handler;
peers ping every five seconds and declare a silent line dead after fifteen, which catches a wedged
process that never closes; callers may pass a `signal` (sends `cancel`) or a `timeoutMs`. Timeouts
are opt-in per call site, because an agent turn has no bounded duration.

## State replication

The worker holds every live object. A presentation holds a `LaneSnapshot` and nothing else.

Each presentation gets **its own** `lane.watch()` in the worker, in the harness's two phases:
`watch()` captures a snapshot while the harness buffers that subscription's events, and `start()`
drains them. Because the harness pairs snapshot and stream with no gap and no duplicate, the client
needs no buffering or ordering logic of its own — it applies events with the harness's own
`reduceLaneSnapshot`. When the fold answers `{ rebase: true }`, which a completed navigation does, the
presentation takes a fresh subscription and drops the old one. First attach and rebase are the same
function.

Rendering is a pure function of that snapshot. Transcript entries are keyed by id and appended, so a
streamed token costs one markdown rebuild rather than a repaint; the view repaints wholesale only
when the entry-id prefix diverges, which is what compaction and navigation do.

## What it is not

No slash-command system, extensions, skills, hooks, themes beyond the shared one, session picker, or
tree navigation. Interactive login and model selection exist because they proved the awkward
directions of the protocol: server-to-client requests, and identity-based configuration.

Two known shortcuts: the server broadcasts a worker's events to every attached presentation, so with
N presentations each event crosses N² times and each client discards the copies that are not its own;
and cancelling an interactive login only interrupts at a prompt, since the worker's login has no
abort path yet.
