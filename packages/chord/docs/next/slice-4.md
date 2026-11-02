# Slice 4: the topology (draft: scope, structural changes, races)

Status: **overview** (owner, 2026-10-23: slice 4 is split into 4a and 4b). The 4a spec proper is `slice-4a.md`, which
wins where the two differ; 4b is sketched at the end of this file. Reads with `design.md` (§3 hosts, links, routes, flow control; §4 principals and
revocation; §6 cycles; §7; §19 presence; §22 wire), the decision log (R1, R2, Q1-Q5, Q13, R20, "Flow control: an
ack-clocked window", "One pending queue for slow consumers of state", "Compression at the origin", "Wire protocol"),
the carry-over (L6, L7) and slices 3a/3b. Builds on `9066b343c`.

## The split

| Slice | Contents |
| --- | --- |
| **4a: links and relays** | IPC and WebSocket links; trusted links; parts as opaque bytes; flow control (acks, pending queue, call window); host kinds, addresses, `placement`; `route` (`authorize`, `resolve`, re-resolve with backoff); relayed holds and calls (ids mapped, principal and origin incarnation stamped, per-hop acks, `reset` and a second `bound`) |
| **4b: authority and housekeeping** | revocation (`revokedBy`, `host.revoke`, propagation to children); cycle checks across hosts (activation chain in hold headers); `host.references` (origin ids); `host.activity`; size limits per part (the admitting link's decoded limit stamped on relayed work); compression at the origin |

4a is what the playground needs (server, workers over IPC, tabs over WebSocket). 4b adds header fields on top of 4a's.

## 4a: structural changes the current code needs

1. **A link carries both directions.** Slice 3 has `ProviderLink` (`accept`: serve only) and `ConsumerLink` (`connect`:
   hold only). With routes, the server holds worker objects over a resolved link *and* serves the worker's holds of
   server types over the same link; the worker serves the server's holds over its `connect` link *and* holds server
   types over it. One per-link object with both sides (two id spaces: holds this side sent, holds it received; message
   kinds are directional, so dispatch stays by kind).
2. **Parts are opaque bytes.** Today the codecs parse every value (`params`, `args`, `value`, `ops`, snapshot members)
   at decode. A relay must forward them unparsed (R1), so values become byte parts that only the end that owns them
   decodes (the consumer's replica, the provider's `checkArgs`). Exception: a `hold`'s params, which a relay parses to
   compute placement and authorize (small; checked by `checkParams` anyway). Sizes then come for free (`byteLength`).
3. **Stamped header fields.** `hold` and `call` gain the origin's principal and incarnation (Q13), set by the relay
   from the link the work came in on; honored only on a link from a parent; overwritten on every other link. 4b adds
   the activation chain, the origin id and the decoded limit the same way.
4. **`ack`** (consumer to provider, after applying each `bound`/`state` message) and the call window in `hello`
   (`calls: N`).
5. **Resets as `r` ops** (decided below): a `state` entry flagged `reset: true` carries `[["r", value]]` per member;
   the consumer applies it like any ops (the decoder restarts at `r`). A second `bound` on a live hold stays refused
   until slice 7.
6. **`loading` on a live hold**: a relay whose upstream link dropped tells its downstream holds; 3b's consumer moves
   only `failed -> loading` on it today.
7. **The pending queue** (fold, leaf index, cap 10,000) per hold member on the provider side, and in Chord's shared
   watch handle (pi first; carry-over L6).

## 4a: races

Routes and resolve:

1. Two holds (or a hold and a call's re-hold) for one address while its `resolve` runs: one `resolve` per address,
   shared; both holds go out on the link it returns.
2. `resolve` rejects or its signal aborts: the holds stay `loading`; re-resolve with the per-address backoff (1 s
   doubling to 60 s) while holds for the address exist.
3. Every hold for an address is released while `resolve` runs: the resolve finishes (a worker start that produced a
   link finishes even if its first requester left, §3); the link is kept for the next hold. Who closes an idle worker
   link is the app's supervisor (`host.activity`, 4b).
4. `authorize` refuses: the hold fails broken `forbidden` before anything starts; a later hold with another principal
   for the same address still resolves.
5. Placement: the caller computes `placement(params)` and routes by it; the provider computes it again and refuses an
   object that is not its own (`invalid/placement`, broken). A placement rule changed by a reload between the two is
   that refusal (rollout handling is slice 7).
6. A worker restarts (crash, the supervisor stopped it): its link drops; the new link's `hello` carries a new
   incarnation; re-holds get fresh objects (in-memory documents gone, as 3b race 7).

Relays (server between a tab and a worker):

7. The worker link drops with relayed holds: the server sends `loading { hold }` downstream (tabs go `loading`,
   values readable, new calls park on the tab), fails relayed calls in flight with `unavailable` (never resent),
   re-resolves, re-holds upstream, and forwards the new `bound` downstream (accepted while `loading`, as 3b's
   re-hold; another variant is allowed). Superseded by `slice-4a.md` section 4.
8. A tab call that crossed the `loading` notice reaches the server while the upstream link is down: answered
   `unavailable` (as a call sent before a drop, §7), not parked at the relay.
9. The tab releases a hold while its upstream re-hold or `resolve` is pending: the relay releases upstream once the
   upstream hold exists; nothing is sent downstream after the release (Q1 covers a `bound` crossing it).
10. The tab link closes: the relay releases every upstream hold it made for that tab and cancels its relayed calls.
11. Two tabs of one principal hold the same object: two upstream holds, each with its own encoder (R1, as today).
12. A worker sends `gone` for a relayed hold: forwarded downstream; the relay forgets the mapping.
13. A worker holds a server type (or another worker's): it goes over its `connect` link; the server serves it or
    routes it on (worker to worker through the server, §3).

Flow control:

14. An `ack` crossing a `reset`, a `release` or a link close: acks count messages per link, not holds; an ack for a
    message whose hold was released still frees its slot.
15. A `reset { hold }` reaching the provider while the hold is pending, failed or released: ignored unless bound
    (Q1).
16. A relay with a full window towards a tab: it drops new parts for that tab's holds and marks them; when the tab
    acks, it sends `reset { hold }` upstream for each marked hold and drops further parts for a hold until its new
    `bound` arrives.
17. **Torn resets:** one commit touched holds A and B of a tab; both were dropped and reset; the two new `bound`s
    arrive as two messages, so a derive over A and B could see A new and B old in between. Proposal: `reset` carries
    a list of holds and the provider answers with one message holding all their snapshots.
18. The pending queue reaches its cap while the window is full: only "replace with the current value" stays; when a
    slot frees, the provider sends a snapshot of the member (a second `bound` part or an `r` op; see open point 3).
19. Calls: more than N calls from one link are parked by the caller (one FIFO per link, across references); a
    cancel frees the slot at the caller when sent and at the provider when received (per-direction order keeps the
    counts equal).
20. **Call fairness at the relay:** each tab has N calls towards the server, but the server has one window of N
    towards a worker for all tabs and its own calls. Proposal: the relay parks relayed calls per origin and sends
    round-robin, so one flooding tab cannot occupy the worker's window; the relay holds at most tabs x N parked calls.

Links and transports:

21. IPC: `send` while the child is exiting, `disconnect` racing a message in flight: the link closes once; messages
    after close are dropped; `process.send` errors close the link.
22. WebSocket: a frame above the transport's `maxPayload` closes the connection (code 1009); a client that stops
    reading is bounded by the window (2 messages) plus the pending queue cap, not by the socket buffer.
23. Trusted links skip the message schema check (IPC, carry-over L6) but never grant stamping: stamped fields are
    honored only from the link to the parent.

## Decided (owner, 2026-10-23)

1. **Trusted links are an explicit option:** `accept(link, { principal, trusted: true })`, and `resolve` may return
   `{ link, principal, trusted }`; default untrusted. Trusted skips the message schema check; stamping is still
   honored only from the parent link.
2. **Resets and overflow are `r` ops in an ordinary `state` message** (races 16-18): a relay's `reset { holds }`
   (a list) is answered with one `state` message whose entries carry `[["r", value]]` for every member of each reset
   hold that is still bound, all snapshots taken in one synchronous step, applied by the consumer in one batch (no
   torn commit across the reset holds). An overflowed pending queue sends `[["r", value]]` the same way. Delta's
   encoder and decoder restart at an `r`. A state entry gets the header flag `reset: true`, so a relay (which never
   reads parts) knows when to stop dropping a reset hold's parts. A second `bound` stays only for slice 7 (a restarted
   object may choose another variant).
3. **Call fairness: round-robin per origin at the relay** (race 20): each origin's calls keep their order; while the
   worker's window is full, origins take turns, so one flooding tab cannot starve the others.
4. **The Durable conversation view:** known cost until Durable's windowed view (pi #11327, waiting for its reporter)
   lands: a re-hold sends the whole active transcript.

## 4b: scope and races (sketch)

- **Revocation:** `createHost({ revokedBy })`; `host.revoke(r)` ends every object and closes every link whose
  principal has `r` in `revokedBy` (L1's `revocationKeys`), then propagates `r` to children (a `revoke` message on
  trusted child links). Races: a hold stamped with a revoked principal already on its way to a worker (it binds, then
  its link closes: R10's window); revoke during an activation; revoke while a relayed call runs (its handler is
  aborted; R11 jobs later).
- **Cycles across hosts (Q5):** a hold made during an activation carries the chain of activating instance ids
  (bounded); the provider refuses a hold whose chain contains the instance being activated (`invalid/cycle`); chains
  from untrusted links are ignored. Races: the chain crossing a relay (copied, never extended by the relay); a cycle
  through a host that restarts.
- **`host.references(Type)`** (presence, §19): who holds objects of a type, with an origin id per client (stamped by
  the relay, so two tabs are two clients); a link drop is a departure.
- **`host.activity`**: `{ references, calls, jobs, lingering }` as one readable for the app's keep-alive.
- **Size limits per part (R2, Q2)**: checked from the header before decoding; an oversized part fails only its hold or
  call (`too_large`); the admitting link's decoded limit is stamped on relayed work and enforced where it is decoded.
- **Compression at the origin**: a part above a threshold is compressed once by its origin (codec field in the
  header); relays forward it compressed; only the end that decodes inflates it, with the decoded limit.

## Size

Reviewers' estimate for slice 4 as a whole: 2,500-3,000 source lines; 4a carries most of it (the two-sided link, the
relay, transports, flow control).
