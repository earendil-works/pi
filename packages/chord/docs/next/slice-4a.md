# Slice 4a: links and relays (spec, for the owner's approval)

Status: **approved (owner, 2026-10-24)**, revised after Astra's and Fable's spec reviews (`/tmp/s4a-review-*.md`);
sections 4-6 and their races revised for the decision "Relay flow control per origin" (owner, 2026-10-24), which
replaces per-hop acks, `reset { holds }`, relay recovery and id renumbering.
Guiding rule (owner): simple, fast, correct. The single source for building 4a, together with the feature map in
`slices.md` (entries assigned to 4a), `design.md` read in full (most relevant: §3 hosts, links, routes, flow control,
recovery; §4; §7; §18; §22), the decision log (R1, Q1, Q4 and "Wire protocol", Q13, R20, "Flow control: an
ack-clocked window", "One pending queue for slow consumers of state", "Slice 4 split and first decisions", "Slice 4a
spec decisions", "Slice 4a review decisions", "Relay flow control per origin"), the carry-over (L6, L7, 4b), `slice-4.md` (the split and 4b) and the
root `AGENTS.md` style section. Builds on L1 and slices 1-3b (`9066b343c`).

## What an app can do after this slice

```ts
export const Server = hostKind("server");
export const Session = hostKind("session", { id: str() });         // params like a contract's

export const Notes = remote("notes", {
  version: 1,
  params: { session: str() },
  placement: ({ session }) => Session({ id: session }),            // never part of the fingerprint
  variants: { … },
});

// server.ts
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });
server.route(Session, {
  authorize: (principal, address) => principal.kind === "owner" || (principal.kind === "guest" && principal.session === address.params.id),
  resolve: async (address, context) => {
    const child = fork("worker.ts", [], { serialization: "advanced" });   // no `signal`: see below
    child.send({ id: address.params.id, init: initFor(address.params.id) });   // the app's own start message
    return { link: ipcLink(child), principal: { kind: "worker", session: address.params.id }, trusted: true };
  },
});
await server.load(serverFacets, ctx);
wss.on("connection", (ws, req) => server.accept(webSocketLink(ws), { principal: authenticate(req) }, ctx));

// worker.ts: connect first (W6), then load; start data through the core facet (§18)
const { id, init } = await startMessage(process);
const worker = createHost<P>({ address: Session({ id }), principal: { kind: "worker", session: id }, onError });
worker.connect(ipcLink(process), { principal: { kind: "server" }, trusted: true }, ctx);
await worker.load([{ name: "@app/core", facet: coreWorkerFacet(init) }, ...workerFacets], ctx);   // serves SessionInfo

// a tab
const tab = createHost<P>({ onError });
tab.connect(webSocketLink(new WebSocket("/chord")), { principal: { kind: "server" } }, ctx);
const notes = await tab.get(Notes, { session: "S1" }, ctx);        // tab → server → route(Session) → worker
```

Do not pass `context.abortSignal` to `fork`: `host.close` aborts it, which kills the worker and makes Node emit an
`error` event on the child process that crashes an app without a handler. Chord closes the link at `host.close`; the
worker exits when its parent link closes. `resolve` returns the link before the worker has loaded (the worker connects first, W6): a `resolve` that waited for
the worker's `load` while the worker's facets hold server types would deadlock.

## 1. Host kinds, addresses, placement (§3)

- `hostKind(name, params?)` declares a kind of addressable host; `params` follow L1's params policy (a flat record of
  required `str()`, `int()`, `bool()`, `oneOf(...)`), checked with L1's compiled params check. `Session({ id: "S1" })` is
  an **address**: `{ kind, params, key }`, its key built like an identity key (`session|S1`). Two addresses are equal
  when their keys are. No host-name strings in app code.
- `createHost({ address })`: an addressable host. Without an address a host is a client (§3 roles). A host without a
  principal serves only local types: `serve` of a remote type makes `load` throw (owner, 2026-10-24; a remote object
  is owned by the serving host's principal).
- `remote(name, { …, placement })` (an L1 change): `placement(params) => Address`, a typed function; not part of the
  fingerprint (L1 normal form unchanged). `local` contracts have no placement.
- **The caller computes the address** and sends it in the `hold` (section 5). A host that relays never needs the
  contract: it routes by the address alone.
- **Where a reference or an arriving hold goes** (first match):

  | Case | Goes |
  | --- | --- |
  | the type is served here and its placement (computed here from the params) is this host's address, or it has none | here |
  | a reference made here (`host.get`/`hold`, `self.get`, `ctx.get`) to a served type whose address is another host's | on, as if not served here (next rows): worker S1 reaches `Notes { session: "S2" }` through the parent |
  | an arriving hold for a served type whose params place it on another host | broken `invalid/placement` (misrouted; never forwarded); the address the hold names only routes it |
  | the hold names an address of a kind this host has a route for | over that route's link (the address's params checked against the kind; `authorize` first) |
  | otherwise (a remote type) | over the parent link; a hold that arrived *on* the parent link is never sent back to it: `unavailable` |
  | no parent link | `unavailable` (as 3a) |

- `placement` or `authorize` throwing fails the hold broken with that error; an address whose params fail the kind's
  check is broken `invalid/placement`.

## 2. Routes (§3)

```ts
host.route(Session, {
  authorize(principal: P, address: Address<typeof Session>): boolean;
  resolve(address: Address<typeof Session>, context: Context): Promise<{ link: Link; principal: P; trusted?: boolean }>;
});
```

- `route` is called by base code before `load`; one route per kind (a second throws).
- **`authorize`** runs for every hold routed over the route, with the hold's principal (section 4), before anything
  starts. `false` fails the hold broken `forbidden`.
- **`resolve`** runs at most once at a time per address: the first hold starts it, later holds wait for the same
  promise. The returned link becomes the address's link (section 3, role `route`). `context` is aborted only when the
  host closes. A resolve whose holds were all released meanwhile finishes and its link is kept (§3).
- **Failure and re-resolve:** a rejected `resolve`, a returned link that is already closed, or the address's link
  closing while holds over it exist, starts the per-address backoff (1 s doubling to 60 s; a backoff map keyed by
  address, separate from objects' identity backoff). While waiting, the holds are `loading` (3b). Only a link that
  completed its handshake resets the backoff. Without holds for the address, nothing is resolved again.
- A `resolve` that never settles is the app's (it bounds its own `fork`); getters still time out by their deadlines.
- Chord never closes a route link itself except at `host.close`; stopping idle workers is the app's (`host.activity`,
  4b).

## 3. Links carry both directions (§3, §22)

- **One link object per link** replaces 3a's `ProviderLink`/`ConsumerLink` pair: one channel (handshake, codec,
  checks, heartbeat), a **provider side** (holds and calls it received; ids chosen by the peer), a **consumer side**
  (holds and calls this host's own references sent; ids from its own counters). The provider side is one per
  **origin** (section 4): the peer's own work, and each downstream link of a peer that relays. Message kinds are
  directional, so each goes to its side. Locally served holds and relayed holds are two kinds of entries in a provider
  side's table; a relayed hold is never hydrated into a `RemoteObject`.
- Every link has the peer's principal, `trusted`, and a role:

  | Role | Made by | A hold arriving on it acts as | This host holds over it |
  | --- | --- | --- | --- |
  | parent | `connect` | the hold's `principal`/`incarnation` fields when present, else the link's principal and peer incarnation | types routed to the parent (a worker's holds of server types, everything a client gets) |
  | child | `accept` | the link's principal and peer incarnation (fields ignored) | nothing |
  | route | `resolve` | the link's principal and peer incarnation (fields ignored) | the address's objects |

- **Trusted links** (`trusted: true` on `accept`, `connect` and `resolve`'s result; default untrusted) skip only the
  `MESSAGE` schema check (carry-over L6): framing, `checkParams`, `checkArgs` and Delta decoding still run. Trust never
  grants the principal fields: they are read only on the parent link.
- `host.close` closes every link (children, routes, parent), then ends objects (3a order).
- **Remote objects** (3b's `RemoteObject`) belong to a **path**: the parent, or a route address. Each new link for a
  path holds every remote object of that path again (3b's re-hold); a closed link drops its tables and the objects go
  `loading`.

## 4. Principals and relays (§4, §22, R1, Q13, R20)

**Principals on holds.** A `hold` carries `principal?` and `incarnation?`. The receiver uses them only on its parent
link; everywhere else they are ignored and the link's principal and peer incarnation apply (a tab cannot claim to be
the owner). Calls carry no principal: a call runs as its hold's principal and with its hold's incarnation
(`ctx.principal`, `ctx.incarnation`), so stamping calls separately is not needed (refines R1/Q13 "hold and call").

**What a host sends** in those fields when it holds over a route link (towards a child that honours them):

| The reference was made by | `principal` | `incarnation` |
| --- | --- | --- |
| `host.get` / `host.hold` | the host's own | this host's |
| `ctx.get` in a handler | the handler's `ctx.principal` (the caller's) | the handler's `ctx.incarnation` |
| `self.get` in a remote object | that object's principal | this host's |
| `self.get` in a local object or a facet | the host's own | this host's |
| a relayed hold (below) | the arriving hold's principal | the arriving hold's incarnation |

So a guest's call on the server whose handler `ctx.get`s a worker type reaches the worker as the guest, and gets the
guest's variant. `RemoteObject` keeps its binding's caller (3b drops it today) and two references with different
principals are two remote objects.

**Upward is a boundary.** A worker's hold of a server type goes over the worker's parent link; the server ignores
principal fields from a child, so it acts as the worker, whoever the worker's handler serves. A worker that acts for a
user towards the server passes the user as data and the server object decides. Documented.

**Relays.** A host that receives a hold it cannot serve (section 1's table: a route or the parent) relays it: it holds
it again on that link (the **upstream** link) with the arriving hold's principal and incarnation, and forwards between
the two without parsing payloads (decision "Relay flow control per origin").

- **Origins.** The relay gives each downstream origin (a downstream link, and the origin its messages carry when that
  link is itself a relay's) a number, one counter per host, never reused; 0 is a host's own work. Every message
  upstream for that origin carries `origin` (section 5); the provider keys holds, calls, windows and acks by (link,
  origin, id), and its answers carry the origin back. `origin` is honoured on every link (a worker may relay a
  child's hold to its parent); principals and incarnations stay parent-only.
- **Ids are not renumbered:** an upstream hold has the downstream hold's id, under the origin's number; calls the
  same. Two tabs (two holds) of one principal are two upstream holds with their own encoders (R1).
- **Nothing is parsed:** the relay routes by the hold's address and authorizes it; params, arguments, results,
  snapshots and ops travel as opaque parts (section 5).
- **What the relay keeps:** per relayed hold, its upstream link and its original `hold` message (params copied once),
  which routes `call`, `cancel`, `retry` and `release` upstream at once and holds again on the next link; per
  downstream origin, the FIFO of the sender of each `bound`/`state` message in flight (section 6), and the set of
  upstream links it relayed to.
- **Forwarding up:** `hold`, `call`, `cancel`, `retry`, `release` with the origin's number; a `hold` waiting for its
  route is sent when the link exists; a `release` before that drops it. A call is forwarded at once; with no
  upstream link it is answered `unavailable`.
- **Forwarding down:** a message from upstream with an origin goes to that origin's provider side, which forwards it
  with its own origin (none for a tab), ids and parts unchanged: `bound`, `state`, `failed`, `loading`, `result`,
  `error`, `gone`. One upstream message concerns one origin, so it is never split. **A link answers only for what was
  relayed over it** (owner, 2026-10-24): every entry of a `bound` or `state`, every `failed`, `loading` and `gone` by
  its hold, every `result` and `error` by its call is checked against the relay's table: the hold (the call's hold)
  must be relayed over the link the answer came from; otherwise it is dropped (Q1: also an answer crossing a release).
  A `bound` or `state` left with some entries is forwarded with those; left with none, it is acknowledged to that link
  at once (its window would otherwise lose the slot). A message for an origin from a link the origin relayed nothing
  to is ignored whole. Cost: one table lookup per entry, a copy of the entry list only when one is dropped.
- **Upstream drop:** the relay sends `loading { hold }` downstream for every relayed hold on the dropped link, fails
  their relayed calls in flight with `unavailable` (never resent), re-resolves (section 2) and holds again upstream
  from the kept message (same id, same origin); the new `bound` is forwarded. A `bound` on a hold the consumer has
  bound already replaces its replicas in one batch, another variant allowed (3b's re-hold path, now also for live
  holds); `loading` on a live hold moves it to `loading`, and on a hold still loading fails a dependent's wait at once
  (R18, as a dropped link does).
- **Downstream drop:** the origin's provider side ends: its served holds are released, its relayed holds forgotten,
  and every upstream link it relayed to gets one `closed { origin }`, which releases the origin's holds and aborts its
  calls there. The origin's number is never used again.
- **`gone`** from upstream is forwarded; the relayed hold is forgotten.

## 5. Messages (§22, 2b)

Changes to slice 3a's `MESSAGE` and both codecs:

- **Parts are opaque bytes:** `params`, `args`, `value` (results), `bound` member values and `state` member ops are the
  UTF-8 JSON text as bytes (plus byte segments for payloads marked `bytes`). The binary codec already writes them
  length-prefixed; decoding returns views of the received buffer. A part is parsed only where it is owned, right when
  its message is handled (so a malformed part is still a protocol error that closes the link): the provider parses
  `params` (`checkParams`) and `args` (`checkArgs`), the consumer parses results and snapshots and decodes ops. A
  message naming an unknown id is ignored before its parts are parsed (Q1). The text codec, a debugging codec,
  re-serializes parts at decode (accepted cost: one parse per part per relay hop).
- `hello { protocol, incarnation, calls }`: `calls` is the number of concurrent calls this side accepts (section 6).
- **`origin?`** on `hold`, `release`, `call`, `cancel`, `retry`, `ack` (towards the provider) and `bound`, `state`,
  `failed`, `loading`, `result`, `error`, `gone` (back): the relay's number of the downstream origin (an integer from
  1; absent: the sender's own work). Binary codec: the kind byte's high bit, then the origin as a varint; text codec:
  `["@", origin, tuple]`. The schema refuses an origin on `hello`, `ping` and `pong`.
- `hold { origin?, hold, type, version, fingerprint, params, address?, principal?, incarnation? }`: `address` is the
  address the caller computed (absent for a type without placement); it routes the hold, the provider places it by
  its params.
- **`bound { holds: [{ hold, variant, members, failed }] }`:** one message may bind several holds; the consumer applies
  all of them in one batch. Used for first bindings and re-holds.
- `ack { origin? }`: consumer to provider, one per applied `bound` or `state` message of that origin.
- `closed { origin }`: relay to provider, the downstream origin ended: its holds are released and its calls aborted.
- `ping {}` and `pong {}`: the heartbeat (section 7).
- `PROTOCOL_VERSION` stays 1 (nothing is deployed; carry-over L6).

## 6. Flow control (§3, decision log)

**The window.** Per origin of a link, at most **K = 2** of the provider's own `bound` and `state` messages
unacknowledged; only these two kinds count (every other message is control and is never queued behind them). The
consumer sends `ack` (with the message's origin) after applying each (after its batch); an `ack` after the link or
the origin closed, or crossing nothing in flight, is ignored. The provider keeps per origin the sender of every
message in flight, in order: itself, or (at a relay) the upstream link it forwarded the message from. Acks arrive in
that order: one for its own message frees a slot, one for a relayed message is sent to that upstream link with the
origin's number there. So a tab served through a relay by W workers may have 2W messages in flight (plus the relay's
own 2), each worker's window bounding its own.

**The provider while the window is full:**

- each touched hold member keeps its ops in its **pending queue** (raw ops, never mutated: the same ops feed other
  holds and watches; `r` drops everything before it; the leaf index merges a new append or primitive set into the last
  pending op on the same path, any other op clears it; past 10,000 pending ops only "replace with the current value"
  stays). The cap bounds entries, not payload bytes. When an `ack` frees a slot, one `state` message carries every
  waiting hold's entry: its members' pending ops encoded once (or `[["r", value]]` after an overflow), all reflecting
  the latest commit.
- a hold that binds while the window is full waits for a slot; its snapshot and subscription are taken in one
  synchronous step when its `bound` is sent (3a race 2).
- a hold whose object leaves `live` while its `bound` waits goes back to pending (no `bound` is built for it; slice
  7's reload).

**The pending queue** is shared Chord code (`src/delta/`); the shared watch handle uses it too, in the same pi change
(carry-over; pi first).

**The relay** folds, drops and resets nothing: it forwards each upstream `bound`/`state` at once and returns its
`ack` when the downstream acknowledges it. A slow tab stalls only its origin at each worker, whose pending queues fold
its commits as they do for a direct consumer; other tabs and the relay's own holds on the same worker are other
origins with their own windows. A relay keeps no state per message beyond its senders FIFO.

**Calls.** `hello` announces how many concurrent calls a side accepts per origin (N, default 256, the same on every
host); a side sends no call before the peer's `hello`. A host sends at most N of its own calls per link in flight;
further calls wait in the link's **call queue**, one FIFO, sent in order as replies free slots (it does not preempt
calls already running). A relay forwards calls at once: each downstream origin's consumer is bounded by its own N,
so the upstream sees at most N per origin. Rules:

- a slot is freed once per call: by its `result` or `error`, by its `cancel` (when sent, at the caller; when received,
  at the provider), or by its hold's `release`, `gone`, its origin's `closed` or the link closing;
- a call still queued when its hold rebinds (`loading`, then `bound`) is rejected `unavailable` (it may name a method
  index of the old variant);
- a provider seeing more than N running calls of one origin closes the link (protocol error); a call naming a hold it
  does not know is ignored before it is counted (Q1).

## 7. Transports and heartbeat (§3)

- **`ipcLink(port)`** over a Node IPC channel (`fork` with `serialization: "advanced"`, or `process` in the child),
  typed structurally (`send`, `on("message")`, `on("disconnect")`, `disconnect()`), no Node import in Chord. A
  `Uint8Array` crosses as one message. `send` returning `false` is backpressure, not failure; a thrown error, an error
  callback or `disconnect` closes the link once; messages after close are dropped; listeners are removed on close.
- **`webSocketLink(socket)`** over a WebSocket (`ws` in Node, the browser's), typed structurally: binary frames,
  `binaryType = "arraybuffer"`; messages sent while the socket is still connecting are buffered and sent on `open`;
  a socket already closed gives a closed link; close on `close` and `error`. The transport's `maxPayload` stays its
  hard cap (code 1009; size limits per part are 4b).
- Both deliver whole messages in order and close both ends, like `memoryLinkPair`. They live in `src/next/link/`.
- **Heartbeat on every link kind**, in the channel: each link keeps a `lastReceived` timestamp (updated on every
  received message; sends do not count) and the host runs one interval timer for all its links (no timer per
  message). A link silent for 15 s sends `ping` (once its handshake is done; `hello` comes first); the peer answers
  `pong` at once, never queued behind the window. A link silent for 30 s, the handshake included, is closed (its
  references go `loading`, 3b). Both numbers are host options; tests use fake timers. The heartbeat detects a silent
  transport, not a peer that answers pings but withholds acks (bounded instead by the window and the pending cap).

## Races

Routes and resolve:

1. Two holds for one address while its `resolve` runs: one `resolve`, shared.
2. `resolve` rejects or returns a closed link: holds stay `loading`; re-resolve after the address's backoff while holds
   exist; only a link that completed its handshake resets the backoff.
3. Every hold for an address is released while `resolve` runs: it finishes; the link is kept.
4. `authorize` refuses or throws: the hold fails broken; other principals for the address still resolve.
5. Placement mismatch at the provider: broken `invalid/placement`.
6. A worker restarts: its link closes; the next link's `hello` has a new incarnation; re-holds get fresh objects.
7. `host.close` during `resolve`: its context is aborted; a link it still returns is closed at once.
8. A hold from the parent for a type this host does not serve and has no route for: `unavailable` (never back to the
   parent).

Principals and relays:

9. A tab sends `principal: { kind: "owner" }` on its hold: ignored (child link); the hold acts as the tab's principal.
10. A guest's handler on the server `ctx.get`s a worker type: the worker sees the guest (principal and incarnation).
11. A worker's handler serving a guest gets a server type: the server sees the worker (upward boundary).
12. The upstream link drops with relayed holds: `loading` downstream, relayed calls in flight `unavailable`,
    re-resolve, re-hold with the same id and origin, the new `bound` forwarded; acks for messages of the dropped link
    still in flight downstream go nowhere.
13. A tab call that crossed the `loading` notice reaches the relay while upstream is down: `unavailable`.
14. A tab releases a hold whose upstream hold is not sent yet: dropped; already sent: released upstream; messages
    crossing it are forwarded and ignored by the tab (Q1).
15. The tab link closes: one `closed { origin }` to each upstream link it relayed to (no `release` or `cancel`); the
    worker releases the origin's holds and aborts its calls; its messages crossing the `closed` are dropped at the
    relay (the origin is gone).
16. `gone` from upstream: forwarded, the relayed hold forgotten.
17. Holds of two tabs on one worker: two origins, so never one message; each tab's messages are atomic for it.

Flow control:

18. An `ack` crossing a `release` or a close, or crossing nothing in flight: acks count messages per origin; one
    with nothing in flight is ignored.
19. Two workers' messages for one tab interleave at the relay: the senders FIFO returns each `ack` to its worker.
20. A first `bound` from a worker while the tab is slow: forwarded at once (the worker's window for the tab origin
    has room for it, or the binding waits there).
21. A commit touches A and B of one tab on one worker while the tab is slow: one entry each in the worker's next
    message for the tab origin, never split.
22. A worker answers for a hold (or a call) of the same origin relayed over another worker's link, or for one the tab
    released: the entry, notice or reply is dropped; a `bound`/`state` left empty is acknowledged to it at once. A
    link the origin relayed nothing to: its message is ignored whole.
23. The pending queue overflows while the window is full: the next message carries `[["r", value]]` for that member.
24. A failed member, a constant and an empty variant in a first binding: carried in the `bound` (values, failed list).
25. More than N calls: the excess waits in the caller's call queue; a relay forwards at once, so a worker counts at
    most N per origin; one more is a protocol error.
26. A call queued across a rebind with another variant: rejected `unavailable`.

Links and heartbeat:

27. IPC: the child exits during `send`, or `disconnect` races a message in flight: the link closes once.
28. WebSocket: a frame above `maxPayload` closes the connection (1009): references go `loading`.
29. A WebSocket still connecting: `hello` and early messages are buffered until `open`.
30. A peer that never sends `hello`: closed after 30 s. A busy link sends no pings. Two sides pinging at once: both
    answer.
31. A peer stalled by a synchronous handler for over 30 s is closed (documented: handlers must not block the event
    loop that long).

## Cost per hop

| Hop | Work |
| --- | --- |
| relay, per message | decode the envelope, swap the origin (one shallow copy of the message), encode the envelope; parts copied once into the outgoing buffer (O(bytes)), never parsed; per `bound`/`state` one FIFO entry |
| relay, per hold | the address's params checked once (route admission, `authorize`) |
| provider, window free | as slice 3a: one encode per commit per touched hold member |
| provider, window full | per op: one path key and one map lookup (leaf index); one encode per waiting member per freed slot |
| provider, per origin | a window and pending state per origin with holds; none for a relay |
| consumer | as slice 3a, plus one `ack` per `bound`/`state` message |
| origin | two bytes per message on a relay's upstream links |
| heartbeat | one timestamp write per received message; one host-wide timer |
| trusted link | no `MESSAGE` schema check |

Producer-side string diffs are not 4a's: a provider whose documents grow by plain string assignment pays Delta's
O(length) append detection per commit until it writes through `appendText` (pi #9265).

## Benchmarks

Extend `test/next/bench/` (by hand, recorded in `benchmarks.md`): commit-to-frame and bytes through a relay (tab ↔
server ↔ worker over memory links, and over real IPC and a loopback WebSocket); hold-to-live through a relay including
`resolve` of an in-process worker; a consumer throttled to 64 KiB/s with stalls of 1, 10 and 60 s receiving a streamed
reply into a 500 KB view (bytes, catching up, sender heap; the producer's commit time recorded separately from the
encode); 10,000 calls from one tab with another tab's latency (p95) through the relay.

## Carry-over taken by this slice

L6: trusted links skip the message check; a second `bound` on a bound hold (now in 4a: upstream re-holds);
`PROTOCOL_VERSION` unchanged. L7: `placement` (`invalid/placement`, not in the fingerprint). Decided: C12 (no call
credits; the call window). The pending queue and the shared watch handle change (pi first). §18's core facet pattern
(start data from the start message), shown in example 13. Left for 4b: revocation, cross-host cycles,
`host.references`, `host.activity`, size limits, compression (carry-over section 4b). Left as it is: L6's
`map(bytes())` declaration bug. From the 4a reviews (owner, 2026-10-24): an activation's `readyTimeout` covers its wait for the
previous instance's teardown too (an attempt abandoned there has opened nothing).

## Tests

- Host kinds and placement: addresses and keys; `placement` excluded from the fingerprint; every row of section 1's
  table; `invalid/placement`; throwing `placement` and `authorize`; never back to the parent.
- Routes: one `resolve` per address, rejection and backoff (fake timers), a closed returned link, re-resolve after a
  drop while held and not without holds, `authorize` per principal, `host.close` aborting `resolve`.
- Two-sided links: the server holds a worker type and serves the worker's hold of a server type over one route link;
  worker to worker through the server; a host that applies its own messages and forwards a tab origin's, each
  acknowledged by its consumer.
- Principals: every row of section 4's table (guest `ctx.get`, remote `self.get`, local `self.get`, `host.get`
  through a route), a forged `principal` from a tab ignored, the upward boundary, two origins with equal principal
  keys but different incarnations.
- Relays: ids kept under the origin both ways, an origin per downstream link never reused, a worker's entries,
  notices and replies for another worker's hold of the same origin dropped (a mixed message forwarded with its own
  entries only, an emptied one acknowledged at once); no part parsed at a binary relay (a counter); upstream drop (`loading`, calls
  `unavailable`, re-hold with the same id and origin, `bound` with another variant); downstream drop (`closed` per
  worker); `gone`; mixed codecs (binary tab, text worker link).
- Flow control: K = 2 with a slow consumer; folding through the leaf index and the cap; a `bound` waiting for a slot,
  and going back to pending when its object leaves `live`; a window per origin (a stalled origin folds, another
  keeps receiving); `closed` per origin; through a relay: every message forwarded at once, each `ack` back to its
  worker in order across two workers, a derive over two holds of a slow tab never torn.
- Calls: the window of N, the FIFO call queue, release and `gone` freeing slots once, a queued call across a
  variant-changing rebind, N per origin at the provider (one more closes the link; an unknown hold ignored first),
  calls in both directions with equal ids.
- Transports and heartbeat: IPC with a real `fork` (one small test) and a fake port (`send` returning false is not a
  close); WebSocket over `ws` loopback and a fake socket (connecting buffer, already closed); silence before `hello`,
  a busy link without pings, a half-open link closed at 30 s, simultaneous pings; timers and listeners released.
- Cost guards: no part parsed at a binary relay; one encode per waiting member per freed slot; no `MESSAGE` check on
  trusted links; no timer per message.
- GC: a released relayed hold, a closed route link, a dropped downstream link, pending `resolve` waiters, the call
  queue, the pending queue after a `closed`, received buffers not kept by parts after handling.
- Examples: `12-routes.ts` (a server routing to an in-process worker, a guest's `ctx.get` through it), `13-relay.ts`
  (tab, server, worker over IPC and WebSocket; the worker's `SessionInfo` from its start message), `14-flow-control.ts`
  (a slow tab: folding at the provider, and through a relay folding at the worker per origin while a fast tab keeps
  receiving).

## Size

About 2,500-3,000 changed or new source lines (two-sided links, routes, principals, the relay with origins, opaque parts in both codecs, flow control with the pending queue and the call queue, two transports, the
heartbeat), plus the pi change for the pending queue and the watch handle. Tests and examples about as much again.
