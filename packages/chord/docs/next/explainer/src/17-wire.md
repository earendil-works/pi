
# On the Wire {#wire lede="What travels over a link, what a relay does with it, how big things are kept in check, what each hop costs, and how to see it in traces."}

Most plugin code never thinks about the wire: it declares state, commits transactions and calls methods, and Chord
moves the bytes. You need this chapter when something is slow, when a value is large, when a link misbehaves, or when
you want to read a trace. It also explains why the earlier chapters insisted on small operations, shared structure and
no callbacks: each of those rules removes a cost on some hop.

## What a state member sends

Every exposed document, derive or readable is a **state member**. Over a hold it produces one of these:

| Update | When |
| --- | --- |
| `snap` | on hold and on re-hold: the whole value, once |
| `ops` | per commit: the draft's recorded ops, no diff |
| `ops` from a diff | per change of a derive (and of an adapted binding, chapter XVI) |
| throttled `ops` | job progress |
| `reset` | a migration commit replaced the value (adapted for older consumers) |
| `error` | the member failed |

**Commits are atomic for consumers.** On the same host, subscribers are notified once, after every document of the
commit is adopted. Remotely, one `state` message per hold carries a batch of member updates that is applied before
listeners run, and a commit that touches several holds on one link travels as **one** `state` message on that link.
A consumer never sees half a commit.

## Messages

A message is a **header plus opaque parts** (R1). There is one part per hold the message concerns; the header says
which hold each part belongs to and how large it is.

| Direction | Kind | Parts |
| --- | --- | --- |
| consumer to provider | `hold`, `release`, `call`, `cancel` | `call` has one (the arguments) |
| provider to consumer | `bound` | one: the snapshot |
| | `state` | one per hold the commit touched on this link |
| | `result` | one |
| | `gone` | none |

There are no request ids in application code. Hold ids and call ids exist only inside the protocol, per link.

**One binary format on every link (Q4):** `u32 header length | header JSON | part bytes`, as one `Uint8Array`. A
WebSocket sends it as a binary frame, IPC passes it with `serialization: "advanced"`, a memory link delivers it
asynchronously. Encoding, framing, header checks, id resolution, flow control and size limits are one shared protocol
layer; link adapters only move bytes. Tests on memory links therefore run the production path.

A part is encoded **once, at its origin**, with that hold's own Delta encoder (paths are interned per hold, end to
end between provider and consumer). A JSON part above a threshold (about 16 KiB) is compressed once at its origin,
whatever the link; byte segments stay raw; relays forward compressed parts as they are; the header names the codec.

**The header is a TypeBox schema (R4)**, a union tagged by `kind`; the protocol types derive from it. Headers from
untrusted links (client WebSockets) are checked with the schema compiled once; trusted links (IPC between server and
workers) are not checked. **Unknown ids are ignored on both sides (Q1).** They are normal races: a `result` crossing a
`cancel`, a `call` crossing a `gone`, a state part crossing a `release`. The side that ended a hold or call settles
its own pending work: a consumer that receives `gone(h)` rejects its pending calls on `h`, and the order per
direction guarantees nothing else for `h` follows. Only a header that fails the schema is a protocol error, and it
closes that link.

The link protocol has a version. Hosts with different protocol versions refuse each other; a web page reloads to get
the server's protocol.

## Through a relay

A tab never talks to a worker directly (chapter I). The server **relays**, and a relay reads and rewrites only
headers: it maps hold and call ids between its two links, stamps the principal on `hold` and `call` (a client's
principal field is always overwritten; only a trusted parent link may carry one), and groups parts per destination
link, so each link gets only its own holds' parts. It never parses a payload.

:::sequence animate | The owner adds a note while Ann watches. The commit leaves the worker as one `state` message with two parts; the server splits it by destination without decoding either part.
actor owner "owner's tab" "hold h1" blue
actor ann "Ann's tab" "hold h2" muted
actor server "server" "relay" accent
actor worker "worker S1" "NoteStore, Notes"
owner -> server: call c7 Notes.add (1 part)
server -> server: map ids, stamp owner
server => worker: call c3 (part forwarded as is)
worker -> worker: method runs, self.tx commits
worker => server: state: parts for h1', h2'
server -> server: group parts per link
server --> owner: state (h1 part)
server --> ann: state (h2 part)
worker --> server: result c3
server --> owner: result c7
:::

The `state` message reaches the owner's tab before the `result`, so when `await notes.add(…)` resolves, the new note
is already in `notes.value`. Ann's view is a different variant (reader) and gets its own part from its own derive; the
relay neither knows nor cares.

## Flow control

Each link has **one byte window**, counted from each message's `byteLength` (parts are already encoded bytes; nothing
is measured or stringified to count it). The window covers every message, first snapshots included.

- **Snapshots are always admitted (R19)**, even when larger than the window; they use it up. Whether a hold
  **overflows** is decided on the changes queued after the snapshot.
- **Under backpressure** a commit's ops are collected per hold and encoded into one part when credits return. The
  consumer still gets the commit atomically.
- **After an overflow** the hold is dropped and established again once the previous snapshot's debt has drained
  (credits back at the full window, Q3), and not more often than a minimum interval. So there is at most one snapshot
  in flight per hold: no re-hold storm, and no stall for a snapshot larger than the window.
- **Calls** are throttled by call credits the provider grants (a generous window). Beyond them calls wait locally.
  Nothing is refused for being "too many", and holds are not limited by count; authorization and input validation
  protect them.
- **Byte-heavy traffic** such as terminals uses separate channels (chapter XIII), so a large state message never
  holds up keystrokes.

**Recovery:** after a link drops, the consumer re-holds every hold over the new link and receives snapshots; calls in
flight fail as on any disconnect, calls made meanwhile park. A relay whose window overflows releases the hold and
re-holds; the provider sends a fresh snapshot. After a routed link drops, Chord re-resolves the address (with the
per-address backoff) while holds on it exist, so a passive viewer recovers without anyone pressing anything.

## Size limits

Limits apply **per part** (R2, Q2), both to the compressed and the decoded size, and are checked from the sizes in the
header before anything is decoded; zlib's `maxOutputLength` enforces the decoded limit in the one decode function.

| Situation | What fails |
| --- | --- |
| a part over the limit | only its own hold or call, with `too_large`; the other parts of the message apply |
| a snapshot over the limit | its hold ends `failed`, with no automatic re-hold |
| a WebSocket frame over `maxPayload` (e.g. 64 MiB) | the connection closes (code 1009); this is the transport's hard cap |

Defaults for client WebSockets are 16 MiB compressed and 64 MiB decoded per part, configurable per link kind. The
decoded limit travels with relayed work: the server stamps the admitting link's limit on the header at admission
(never taken from the client), and the host that decodes enforces it. IPC therefore needs no limit of its own.

Large data is never a large state member or a large argument. Files go through chunked transfers or the HTTP
component (chapter XIII); long lists are keyed documents or bounded windows (chapter VIII).

## What each hop costs

Chord v2's goal is as little compute and memory as possible while staying correct: **O(size of the change)** per
commit and per viewer, independent of the size of the value. A 500 KB value is touched as a whole only when a new
viewer takes its first snapshot. Delta, the value library under documents, was built for this, and its own primitives
are almost free: `diffRevisions` on shared subtrees takes 0.018 ms, `applyImmutable` of a small change 0.004 ms.

| Hop | Work |
| --- | --- |
| commit | Delta's `prepare` (copies and checks only the values placed in this commit), adopt by pointer swap; storage writes the delta |
| reads in a transaction | the draft overlay, no copy; an unchanged draft writes nothing |
| subscribers on the same host | the same value and ops, by reference |
| derives | compute plus `diffRevisions`; unchanged parts stay the same objects (`mapShared`, chapter VIII) |
| send | one encoding per hold part at its origin, size taken from the encoded bytes |
| relay | header only: ids mapped, principal stamped, parts grouped; parts never parsed |
| receive | compiled header schema on untrusted links; arguments stripped and validated once at the provider (compiled schema); inputs normalized |
| apply | `applyImmutable`, structure shared |
| new hold | the value encoded once (unavoidable) |
| memory | one authoritative value per document per host; replicas and derived values share structure; one cached value per adapted binding |

These are targets. The frozen kernel measured far worse, which is why the design is so strict here:

:::stats
- 35 ms | one small change to a 500 KB value in the frozen kernel, no viewer
- +13 ms | per viewer on top (10 viewers: 130 ms)
- 17 / 33 / 101 ms | a tiny SQLite commit after 0 / 10 / 50 earlier deltas
:::

Nearly all of that came from layers around Delta: whole-value validation on every access, whole-value freezing,
JSON-ness walks on every received frame, double stringification to measure a frame, snapshots cloned per viewer, and
a SQLite storage that replayed history, and schemas rebuilt for every check (a compiled TypeBox check takes
0.012 ms, an interpreted one 5.6 ms). The redesign removes each of them (chapters V, VIII and this one); the
before/after per hop is in `apps/p2/docs/p3-reviews/v2-cost-model.md`.

:::review | Review: v2-cost-model.md is partly outdated
The measurements and the per-hop "after" targets in `apps/p2/docs/p3-reviews/v2-cost-model.md` are current. Its
closing section "Decisions this needs" is not: items 6 and 7 (validation by the caller's trust; contract descriptions
once per link and fingerprint) were replaced by R7 (validate for every caller) and R6 (no descriptions on the wire),
and §10 still describes the description fetch.
:::

### Cost guards

Chord reports **full-value walks, deep copies, encodes, schema validations and materializations** as ordinary
telemetry metrics, always on; with the NOOP adapter they cost an empty call where such work happens. Tests use the
in-memory adapter and assert them per hop. The reference case: one appended note to a 500 KB document with 10 viewers
does no walks, no copies, one encode per hold part at its origin and none at relays, and no validations. A
`vitest bench` suite measures the hops.

### Ways to make it slow anyway

| Mistake | Why it costs | Instead |
| --- | --- | --- |
| a derive that builds new objects for unchanged data | every commit diffs and sends O(value) | keep unchanged items identical: `mapShared`, `previous` (chapter VIII) |
| one long array that changes often (R24) | sharing is per path; each change copies one slot per element and visits each | keyed documents or a bounded window |
| bytes as base64 strings | inflated, parsed, compressed as text | `bytes()` leaves; chunked transfers for files |
| awaiting I/O inside `self.tx` | the object's line is blocked for every caller | do the I/O first, then a short transaction |
| storing registry entries or references in documents | stale after a reload, not data | look up the current value at use |
| opening natives at module level or in a facet | no owner: never closed, never restarted | `self.open` in an object (chapter IX) |
| callbacks as arguments | cannot cross a link, keep old code alive | registries, jobs, flows |
| one big object that everybody views | one large snapshot per viewer and per reconnect | split by viewer need; views of the same variant share one value |

## Telemetry

Chord reports traces, events and metrics through `@earendil-works/pi-telemetry`. Each host gets **one adapter**,
`createHost({ telemetry })`, NOOP by default; the adapter decides sampling, buffering, export and filtering. Only hosts
hold the adapter, to start root spans. Code sees spans:

- `ctx.telemetry` is the current span (`Ctx` extends `Context`, so it is the same field Durable and pi-ai read). Every
  span carries its adapter's metrics and propagation, so code with a `ctx` can record a metric or inject a carrier.
- `ctx.trace(name, attributes, fn)` runs `fn` in a child span with a child `ctx`.
- App values such as the principal stay out of Durable's context.

**Across links**, `call` and `hold` carry the caller's trace carrier as a bounded header field (R5: limited key count
and string lengths); the provider runs the method under it, and each relay adds a `chord.relay` span. The call from the
sequence above, as a trace:

```text
chord.call Notes.add            [owner's tab]
└─ chord.relay                  [server]
   └─ chord.method Notes.add    [session:S1] principal=owner
      · event chord.commit docs=2 ops=5
```

Adapters trust typed input: no validation of malformed values and no try/catch around recording. Only carriers from
another process are checked (keys present, strings), and a bad one falls back to a new root.

**Shared work** (one activation serving several `get`s, a worker start) is its own root span, linked to the trigger
that started it; each waiting span links to it. Routine runs, job runs, eviction, backoff retries and background
closes are root spans too, linked to their trigger where there is one.

| Tier | What |
| --- | --- |
| spans | calls, methods, relays, holds, activations, opens, closes, loads, revocations, resolves, routine runs, job runs |
| events | commits inside methods, retries, parking |
| metrics | state messages, WebSocket bytes, commit durations, in-flight calls, active holds, open links, park durations, backpressure waits, the cost guards |

Ids are attributes of spans, never of metrics. **Nothing is measured or walked for telemetry**; only sizes the code
already has are reported. Errors carry a fixed category and a message cut to 500 characters; cancelling is not an
error. Chord ships a typed telemetry schema, as pi-ai (`AI_TELEMETRY_SCHEMA`) and Durable
(`DURABLE_TELEMETRY_SCHEMA`) do.

**Storing and reading:** `@earendil-works/chord/telemetry-sqlite` over `chord/sqlite` (Node and Cloudflare) stores one
row per settled span (events and links inline) and metrics aggregated per series per 10 s, flushes in batches every
second, keeps 7 days, and drops (and counts) beyond a bounded queue. The read interface `TelemetryStore` is shared:
`findTraces` (by name, attributes, errors, time window, with limit and cursor) returns complete traces, `getTrace`
one, `findMetrics` metrics. One renderer, `pi-telemetry/render`, prints traces as above; it prints links and never
follows them. The playground's trace viewer reads the same store.

**Durable** already emits submit and phase spans, stores carriers on submissions and tasks (`TaskOptions.trace`),
and pi-ai emits `pi.ai.request` and `pi.ai.poll`. With the harness given the host's adapter (chapter XIV), an agent
tool that calls `Notes.add` through `chord(fn, context)` shows up as one tree from the model request down to the
commit.

:::note | Built so far
Nothing of the protocol is built in v2: messages, relays, flow control and limits are layers L6 and L7, telemetry in
Chord is L11. Built in pi: `pi-telemetry` (propagation, links, metrics, the store interface, the renderer),
`chord/context` with `Context.telemetry`, pi-ai and Durable telemetry, and `chord/telemetry-sqlite`. Delta is built;
`mapShared` and bytes as atomic leaves in `diffRevisions` are still to do. The frozen kernel sends descriptions on the
wire and closes a link on an unknown id; both are replaced.
:::
