# Slice 4b: authority and housekeeping (spec)

Status: **revised (2026-10-24) for flow control per origin; the owner sent it to building directly**, with reviews of
the build by fresh reviewers. Guiding rule (owner): simple, fast, correct. The single source for building 4b, together
with the feature map in `slices.md` (entries assigned to 4b) and its "Carry-over" section for slice 4b, `design.md` read
in full (most relevant: §3 links, relays and keep-alive, §4 principals and revocation, §6 cycles, §19 presence, §22
size limits and compression, §26 open points), the decision log (R2, R10, R11, Q2, Q5, R26, "Compression at the
origin", "Relay flow control per origin", "Slice 4b: `host.activity` is a watchable", "Simplification pass after 4a")
and the root `AGENTS.md` section "Chord v2 Code Style". Builds on slice 4a as simplified (`79a0206dc`).

Points marked **proposal** are the builder's default; the owner decides them after the build (they are collected in
the last section).

## What an app can do after this slice

```ts
type Revocation = { grant: string } | { device: string } | { session: string };
const server = createHost<P, Revocation>({
  address: Server(), principal: { kind: "server" }, onError,
  revokedBy: (p) => p.kind === "guest" ? [{ grant: p.grant }, { session: p.session }]
    : p.kind === "owner" && p.access === "device" ? [{ device: p.device }] : [],
  compression: nodeCompression,                      // from `@earendil-works/chord/next/node`
});
server.revoke({ grant: "g1" }, ctx);                 // ends g1's objects here and on every worker, closes g1's links

host.serve(Notes, ({ session }, principal, self) => {
  const viewers = self.derive([host.references(Notes)], ([refs]) =>
    refs.filter((r) => r.params.session === session).length);
  …
});

const activity = await worker.activity.watch(ctx);   // the app's supervisor decides

server.accept(webSocketLink(ws), { principal, limits: { part: 16 * MiB, decoded: 64 * MiB } }, ctx);
```

## 1. Revocation (§4, R10, R11)

- `createHost({ revokedBy })`: `(principal: P) => R[]`, `R` JSON; the same app code on every host. A principal's
  **revocation keys** are the canonical JSON of each value `revokedBy` returns, computed once per principal object and
  cached weakly (a `WeakMap` keyed by the principal object, with a GC test). L1's unused `revocationKeys` was cut
  (owner, 2026-10-24): write the helper here, next to its user.
- `host.revoke(r, context)` on a host, synchronously:
  1. ends at once every object whose identity principal `p` has `r` in its keys (remote objects; local objects have no
     principal), whatever references remain (R11): each holder gets `gone` with `forbidden` ("revoked"), running
     calls' contexts are aborted (their callers are rejected), an activation in progress is abandoned. Teardown then
     runs as for any ending (drain, closes with reason `end`).
  2. closes every **child** link (made by `accept`) whose principal has `r`; never the parent link, never the host's
     own principal. Closing a tab's link at a relay sends `closed { origin }` upstream (4a), so that tab's holds on the
     workers are released without a revocation message.
  3. sends `revoke { revocation: r }` on every **route** link (its children), which apply it with their own
     `revokedBy`, and so on down. Nothing is replayed: a child connected later gets no past revocation (its objects
     are new, and the revoked links are closed already).
- A `revoke` message is honoured only on the **parent** link (like the principal fields on holds); arriving on any
  other link it is ignored.
- What `gone` means for consumers is 3a's rule (calls on the hold reject; a relay forwards it). Holds acting for a
  revoked principal arrive at a worker as their own objects (identity principal = the hold's principal, 4a), so the
  worker's own `revokedBy` ends them.
- Reconnecting never restores revoked authority: authentication is the app's; a changed grant is a new principal (its
  key includes the grant revision, design §4).
- Jobs and revocation (R11) arrive with slice 5.

## 2. Cycles across hosts (§6, Q5)

- Every object instance gets an **instance id** (uuidv7) at its first attempt; a restarted object (a new instance)
  gets a new one, so an old chain never matches it (owner, 2026-10-24, D4).
- A hold made during an activation (a `self.get` of a type that is not served here, routed over a link) carries
  `chain: string[]`: the chain of the activating object (the chain of the hold that created it, if any) plus its own
  instance id; at most 32 entries (a longer chain keeps its last 32: a longer cycle is not detected; documented).
- A provider refuses a hold whose chain contains the instance id of the object it would bind while that object is
  activating: the hold fails broken `invalid/cycle` naming the cycle by labels where known.
- **Proposal:** a dependency failing with `invalid/cycle` fails the dependent **broken** with the same error (an
  exception to R18's "dependency failures are transient"). Otherwise, A (server) → B (worker) → A would fail B
  transient, B would retry with backoff, and every retry would hit the same cycle.
- `chain` is honoured on trusted links (any role: a cycle runs server → worker → server over route and parent links)
  and dropped from holds arriving on untrusted links. Relays copy it upstream unchanged (they activate nothing).
- One-host cycles stay as built (slice 1: following waiting objects).

## 3. Presence: `host.references(Type)` (§19)

- `host.references(Type)` (on the host, and on the facet's host): a JSON `Watchable` of the references to objects of
  that type on this host: `{ params, principal, origin }[]` (`principal` absent for a local type). `origin` is the
  incarnation of the host where the reference was made: for a hold over a link, the hold's caller incarnation (the
  tab's own, carried by a relay on route links, 4a); for a local reference, this host's incarnation. Two tabs are two
  origins.
- It changes in the batch where a reference binds or ends; derives over it recompute there (W1). A link drop is a
  departure (its holds end); smoothing is the UI's. Lingering objects have no references.
- Cost: one entry added or removed per reference, kept per type (a type nobody asks about costs a counter at most:
  **proposal** build the list per type only while it is watched or read).

## 4. Keep-alive counts: `host.activity` (§3, R26)

- `host.activity`: a JSON `Watchable` of `{ references, calls, jobs, lingering }` (owner, 2026-10-24): holds arriving
  over links and served here, method calls running on this host (local and remote), running jobs (0 until slice 5),
  lingering objects.
- Counters are kept where the work happens; a change marks the watchable dirty, and one publication per microtask turn
  carries every change of that turn (not one per call start and end); its value is built from the counters when
  published or read. A slow watcher gets the newest counts (pending queue).

## 5. Size limits per part (R2, Q2)

- `accept(link, { …, limits })`, `connect(link, { …, limits })` and `resolve`'s result take
  `limits: { part?: number; decoded?: number }` (bytes): `part` bounds a part's size on the wire, `decoded` its size
  after inflating (section 6). Defaults (Q2): none on trusted links (IPC); on untrusted links 16 MiB and 64 MiB.
- Checked from the part's length before it is parsed or inflated (parts are opaque); the decoded bound is enforced
  while inflating (section 6).
- An oversized part fails only its hold or call (`too_large/part`); the other parts of the message apply: an argument
  part fails its call (`error` to the caller), a result fails its call, a snapshot fails its hold (no automatic
  re-hold), a state part fails its hold. The link stays up.
- **The admitting link's limits travel with relayed work** (Q2): a relay checks `part` on the admitting link itself
  (the bytes are there) and stamps `limit` (the admitting link's `decoded`) on the upstream `hold`; honoured only on
  the parent link (like the principal fields); calls on the hold inherit it. The host that inflates enforces the
  smaller of its own link's and the stamped one, so a worker never inflates a tab's argument beyond the tab link's
  limit.
- The WebSocket's `maxPayload` stays the transport's hard cap (4a).

## 6. Compression at the origin (#27: owner leaning (b), built as (b))

Problem: encoding happens in the synchronous flush (one message per commit, W1), so compression must be synchronous;
browsers have only the asynchronous `CompressionStream`/`DecompressionStream`.

- **Who compresses:** a host with a synchronous compressor (`createHost({ compression })`) compresses each JSON part
  above 16 KiB (deflate raw, level 1) when it encodes it; the part's envelope says so (a codec flag per part in both
  codecs). Byte segments stay raw. Hosts without one (browsers) send every part uncompressed; their parts are
  arguments and params, which are small.
- **Who inflates:** the end that owns the part, when its message is handled. Relays never inflate (parts are opaque).
- **The adapter**, portable: `compression?: { deflate(bytes): Uint8Array; inflate(bytes, limit): Uint8Array }`
  (synchronous). Chord ships `nodeCompression` (Node's `zlib.deflateRawSync`/`inflateRawSync` with
  `maxOutputLength`) in a Node-only subpath; `src/next` itself imports no Node module. Without the adapter, a host
  inflates asynchronously with the web `DecompressionStream("deflate-raw")`, counting output bytes and aborting past
  the limit.
- **Order with asynchronous inflate:** a received message whose parts need an asynchronous inflate is held, and every
  later message of that link waits behind it, in order, until it is inflated and handled. The queue is bounded: a
  provider has at most two `bound`/`state` messages in flight per origin (2W + 2 for a tab behind a relay with W
  workers), at most N = 256 call results per origin, and the `ack` goes out only after the message was applied, so a
  slow inflate is backpressure like a slow consumer (its commits fold at the provider). Control messages (`ping`,
  `pong`) are answered when they are reached in order; the 30 s heartbeat leaves ample room.
- Threshold (16 KiB) and level (1) are protocol constants, not per link.
- `PROTOCOL_VERSION` stays 1 (nothing deployed).

## Messages

- `hold` gains `chain?: string[]` (trusted links only) and `limit?: number` (parent link only).
- `revoke { revocation }` (parent to child; honoured on the parent link only; no origin).
- A part's codec flag: in the binary codec a flag in the part's length prefix (builder's choice, documented); in the
  text codec, which is for debugging but may sit on a relayed link, a compressed part travels as a tagged element
  holding its base64 (**proposal**; the text codec itself never compresses).

## Races

1. `revoke` while an object of the principal activates: the attempt is abandoned, holders get `gone`.
2. `revoke` while a call of the principal runs: its context is aborted; the caller is rejected (`gone` reaches it).
3. A hold stamped with a revoked principal is already on its way to a worker: it binds, then the worker's `revoke`
   (sent right after on the same link, per-direction order) ends it: R10's window, accepted.
4. Two tabs of one grant, one revoked: both principals have the key, so the shared objects end for both and both links
   close.
5. `revoke` crossing a `resolve`: the new worker link gets no past `revoke`.
6. A `revoke` from a child link: ignored.
7. A cycle through a relay: the chain is copied upstream; detection at the provider.
8. A cycle through a restart: new instance ids, no false cycle.
9. `host.references` and a link drop in one batch with a commit: the derive sees the departure in that batch.
10. An oversized part inside a `state` message with other holds' entries: only its hold fails.
11. A compressed part whose inflated size exceeds the limit: its hold or call fails `too_large/part`; the link stays.
12. A stamped `limit` or `chain` from a child or untrusted link: ignored.
13. An asynchronous inflate in flight when the link closes: its message and everything queued behind it are dropped.
14. A slow asynchronous inflate at a tab: the worker's window for the tab's origin fills; its commits fold.

## Cost per hop

| Hop | Work |
| --- | --- |
| revoke | keys cached per principal; one lookup per object and link; O(objects + links) once |
| hold during activation | one chain array (at most 32) |
| presence | one entry added or removed per reference, in the batch |
| activity | counters; at most one publication per microtask turn with changes |
| size limits | one comparison per part before parsing |
| compression | one deflate per part above 16 KiB at its origin, one inflate at its owner; relays nothing |

## Carry-over taken (from `slices.md`, section "Slice 4b")

All of it: revocation, cross-host cycles with instance ids, `host.references` and `host.activity`, size limits and
compression, the Durable conversation view's size on re-hold (known cost until pi #11327; nothing to build), route
links' context (give `route` a `context` option, defaulting to the host's background context, used for the link's
work and telemetry), one N on every host (unchanged; note stays), `gone` becomes reachable (test it through
revocation; drop the hand-ended test only if the new one covers the same paths).

## Tests

Every race; revocation on one host, across a relay to a worker, two tabs of one grant; a child's `revoke` ignored;
cycles server → worker → server and through a relay, no false cycle after a restart, the broken dependent (proposal);
presence per origin with derives and link drops; activity counts per kind and one publication per turn; limits per
part in every message kind, the stamped decoded limit, a compressed bomb (both inflate paths); compression round
trips in both codecs, relays not inflating (a counter), the asynchronous inflate's ordering and its close race; cost
guards; GC (revoked objects, presence entries, revocation key cache, chains, the inflate queue). Examples:
`15-revocation.ts`, `16-presence-and-activity.ts`, `17-limits-and-compression.ts`. Benchmarks in `benchmarks.md`: a
500 KB snapshot and a 1 MiB result compressed and not (bytes, encode and inflate time, synchronous and asynchronous).

## Size

About 800-1,000 source lines.

## Decisions for the owner after the build

Collected here by the builder and reviewers; known now:

1. A cycle error makes the dependent broken (section 2), an exception to R18.
2. Compression (b) as built: adapter shape, the asynchronous fallback, the text codec's form of a compressed part.
3. `host.references` built lazily per type, or always.
