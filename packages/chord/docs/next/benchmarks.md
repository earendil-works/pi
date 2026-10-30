# Chord v2 benchmarks

Light benchmarks of hot paths, run by hand (not in CI), recorded per slice for later slices to compare against
(owner, 2026-10-22). Each section names its script, the machine and what the numbers include.

## Slice 3a: remote objects over one link

Script: `test/next/bench/links.ts`, run from `packages/chord` with
`node --conditions=source --experimental-strip-types --expose-gc test/next/bench/links.ts` (about 15 s). Node 24.4.1,
Intel Core i9-13900, one process: server and client host on one memory link (`queueMicrotask`), every case once per
codec, side by side.

Payloads, modelled on p2: entries `{ id, text, author, at }` in one document of a local store, exposed by a remote
view; "1,000 items" are entries with 80-character texts (the notes list), "500 KB" are 500 entries of 960 characters
(a conversation document). Commits are server-side method calls (one transaction each) on the store.

What the numbers include:

- *first hold to live*: the first `client.get`, which also activates the view on the server; one sample, so it moves
  by a few hundred µs between runs (JIT and collector state).
- *hold to live (mean of 100)*: further `client.get`s of the live view, each released: the `hold`, the snapshot, the
  `bound` message encoded, decoded and checked, the replicas built (two link hops).
- *wire bytes*: one whole message as its codec writes it (memory links add nothing).
- *encode / decode*: that message through the codec alone (`decode` without the schema check), averaged over 10,000
  runs (1,000 for snapshots and the 1 MiB call), the fastest of five such loops (one loop of a microsecond-sized
  message is at the mercy of the collector and the JIT).
- *heap per encode + decode*: heap bytes allocated per message while encoding and decoding it that many times,
  measured with `GCProfiler` (the growth plus what the collections freed); `ArrayBuffer` backing stores (the message
  bytes themselves) are outside the heap.
- *array buffer kept per encoded message*: the `process.memoryUsage().arrayBuffers` growth while 50 encoded copies of
  the message are kept, per message: the backing store a queued or held message keeps. Freed buffers are not reported
  reliably inside a loop, so allocation of temporary buffers is not measured. V8 keeps very small typed arrays on the
  heap, so the smallest binary messages show 0 B here.
- *commit to frame*: from the server's method call to the client's watch listener, averaged over 1,000 commits: the
  call and its transaction, the encodes, the hop, decode, check, apply, and the watch's delivery.
- *heap / array buffers retained per hold*: the heap and `arrayBuffers` growth of holding the 1,000-item view, after full collections, divided by the
  holds; both ends (the provider's member encoders and subscriptions, the consumer's member decoders and replicas,
  each its own decoded copy of the snapshot), median of seven trials.

| Case                                                                            | binary | text |
| ------------------------------------------------------------------------------- | --- | --- |
| notes list of 1,000 items: first hold to live (activation, one sample)          | 0.958 ms | 1.041 ms |
| notes list of 1,000 items: hold to live (two hops, mean of 100)                 | 0.666 ms | 0.686 ms |
| notes list of 1,000 items: snapshot: wire bytes                                 | 133.7 KiB | 133.7 KiB |
| notes list of 1,000 items: snapshot: encode / decode                            | 291.1 µs / 266.4 µs | 312.3 µs / 302.8 µs |
| notes list of 1,000 items: snapshot: heap per encode + decode                   | 441.5 KiB | 441.8 KiB |
| notes list of 1,000 items: snapshot: array buffer kept per encoded message      | 137.7 KiB | 133.7 KiB |
| 500 KB document: first hold to live (activation, one sample)                    | 1.461 ms | 1.555 ms |
| 500 KB document: hold to live (two hops, mean of 100)                           | 1.138 ms | 1.309 ms |
| 500 KB document: snapshot: wire bytes                                           | 496.5 KiB | 496.5 KiB |
| 500 KB document: snapshot: encode / decode                                      | 615.4 µs / 390.8 µs | 687.5 µs / 528.3 µs |
| 500 KB document: snapshot: heap per encode + decode                             | 1511.2 KiB | 1511.2 KiB |
| 500 KB document: snapshot: array buffer kept per encoded message                | 500.5 KiB | 496.5 KiB |
| one appended item: commit to frame                                              | 0.037 ms | 0.031 ms |
| one appended item: messages per commit, encodes per hold                        | 1, 1 | 1, 1 |
| one appended item: state message: wire bytes                                    | 165 B | 175 B |
| one appended item: state message: encode / decode                               | 1.4 µs / 1.4 µs | 0.9 µs / 1.1 µs |
| one appended item: state message: heap per encode + decode                      | 2607 B | 3034 B |
| one appended item: state message: array buffer kept per encoded message         | 165 B | 175 B |
| one changed field: commit to frame                                              | 0.036 ms | 0.031 ms |
| one changed field: messages per commit, encodes per hold                        | 1, 1 | 1, 1 |
| one changed field: state message: wire bytes                                    | 27 B | 38 B |
| one changed field: state message: encode / decode                               | 0.6 µs / 1.0 µs | 0.5 µs / 0.7 µs |
| one changed field: state message: heap per encode + decode                      | 2005 B | 2527 B |
| one changed field: state message: array buffer kept per encoded message         | 0 B | 38 B |
| one removed item: commit to frame                                               | 0.031 ms | 0.029 ms |
| one removed item: messages per commit, encodes per hold                         | 1, 1 | 1, 1 |
| one removed item: state message: wire bytes                                     | 23 B | 34 B |
| one removed item: state message: encode / decode                                | 0.6 µs / 1.0 µs | 0.5 µs / 0.7 µs |
| one removed item: state message: heap per encode + decode                       | 1704 B | 2575 B |
| one removed item: state message: array buffer kept per encoded message          | 0 B | 34 B |
| streamed reply, 2,000 appends: time per append                                  | 0.031 ms | 0.027 ms |
| streamed reply: bytes per append, total                                         | 23 B, 45.0 KiB | 34 B, 66.5 KiB |
| streamed token: wire bytes                                                      | 23 B | 34 B |
| streamed token: encode / decode                                                 | 0.5 µs / 1.0 µs | 0.5 µs / 0.6 µs |
| streamed token: heap per encode + decode                                        | 1696 B | 2527 B |
| streamed token: array buffer kept per encoded message                           | 0 B | 34 B |
| 1 hold(s) of 1,000 items: heap / array buffers retained per hold (both ends)    | 154.1 KiB / 47 B | 159.7 KiB / 21 B |
| 1 hold(s): messages per commit                                                  | 1 | 1 |
| 10 hold(s) of 1,000 items: heap / array buffers retained per hold (both ends)   | 175.2 KiB / 41 B | 175.2 KiB / 44 B |
| 10 hold(s): messages per commit                                                 | 1 | 1 |
| call, small argument: round trip                                                | 0.016 ms | 0.015 ms |
| call, small argument: call message: wire bytes                                  | 16 B | 23 B |
| call, small argument: call message: encode / decode                             | 0.6 µs / 0.4 µs | 0.5 µs / 0.6 µs |
| call, small argument: call message: heap per encode + decode                    | 1580 B | 1603 B |
| call, small argument: call message: array buffer kept per encoded message       | 0 B | 23 B |
| call, small argument: result message: wire bytes                                | 9 B | 14 B |
| call, small argument: result message: encode / decode                           | 0.4 µs / 0.3 µs | 0.5 µs / 0.5 µs |
| call, small argument: result message: heap per encode + decode                  | 1219 B | 1509 B |
| call, small argument: result message: array buffer kept per encoded message     | 0 B | 14 B |
| call, 1 MiB bytes argument: round trip                                          | 0.192 ms | 0.159 ms |
| call, 1 MiB bytes argument: call message: wire bytes                            | 1024.0 KiB | 1024.0 KiB |
| call, 1 MiB bytes argument: call message: encode / decode                       | 113.7 µs / 1.4 µs | 123.5 µs / 1.5 µs |
| call, 1 MiB bytes argument: call message: heap per encode + decode              | 3042 B | 3383 B |
| call, 1 MiB bytes argument: call message: array buffer kept per encoded message | 1028.0 KiB | 1024.0 KiB |

Observations:

- One message per commit and one encode per hold in every case (W1).
- The binary codec makes small messages 30-45 % smaller (a streamed token 23 B against 34 B; a changed field 27 B
  against 38 B) and allocates less heap per message; both are about 1 µs per small message each way. Binary decodes
  small messages a little slower than text: it makes one call per field (varints, strings, one `JSON.parse` per value)
  where text makes one `JSON.parse` of the whole tuple; the difference is under 1 µs per message and not worth
  optimizing. Snapshots are JSON in both and about the same size; binary decodes them faster, text encodes them a
  little faster (binary encodes the JSON text, then copies it into the message once).
- A binary message keeps a right-sized backing store (a 500 KB snapshot keeps about 500 KiB, not the 1.5 MB a buffer
  reserved for the worst-case UTF-8 length kept before the review).
- Kept backing stores of small binary messages (owner, 2026-10-22): a message is written into a 256-byte starting
  buffer, whose exact size is not known before the message is written, so in-place encoding does not right-size it.
  `finish` copies to an exact-size buffer when the spare room is at least 64 bytes and more than an eighth of the
  message. The appended-item state message (165 B) now keeps 165 B instead of 256 B, for about 0.2 µs more per encode
  (1.1 against 1.3-1.4 µs); messages up to about 100 B were copied before already (they show 0 B: V8 keeps such small
  arrays on the heap); large ones end within their 4 KiB of room and are not copied (the 1 MiB call keeps 1028 KiB).
- Large snapshots (owner's profiling request, 2026-10-22): the earlier "hold to live" gap (2.67 ms binary, 1.67 ms
  text) was one sample each; averaged over 200 holds both codecs took about 1.2 ms. The remaining real gap was the
  encode (886 against 718 µs): binary encoded the JSON text into its own buffer, then copied it into the message.
  Long strings (from 4,096 UTF-16 units) are now encoded straight into the message buffer behind a fixed five-byte
  length (a padded varint), and short ones (up to 42 units, a one-byte length) too: binary now encodes a 500 KB
  snapshot in 650 µs against text's 690 µs and holds it in 1.14 ms against 1.30 ms.
- A 1 MiB `bytes()` argument travels as 1 MiB plus a few bytes in both codecs (not base64's 1.33 MiB); its decode is a
  view (under 2 µs), its encode the one copy into the message.
- Encoding is not the bottleneck at these sizes; no CBOR.
- Each hold's replica is its own decoded copy (about 160-175 KiB for 1,000 entries); two references from one host are
  two holds by design.

## Slice 3b: surviving drops

Script and machine as for slice 3a (`test/next/bench/links.ts` now runs the 3b cases after the 3a ones, about 37 s).

New cases, both on the 1,000-item notes list view (133.7 KiB snapshot):

- *reconnect, N reference(s)*: N references held on the client (N holds of one provider object); the server's end
  of the link closes, the client sees the drop, then a new link is accepted and connected. *Time to all live*: from
  `connect` to every reference's `ref.state` being `live` again (the re-holds, N snapshots encoded, decoded and
  adopted as one frame `[["r", value]]` per member); the mean of 20 reconnects for one reference, 5 for 100. *Bytes*:
  what the new link carried both ways until then (the handshake included).
- *1,000 calls parked while down*: a small call (`ping`) made 1,000 times right after `connect`, before the re-hold is
  bound, so every call parks; time from `connect` to the last result (the re-hold, then 1,000 calls sent in order and
  answered), mean of 10; the order is checked at the provider and in the results.

| Case | binary | text |
| --- | --- | --- |
| reconnect, 1 reference of 1,000 items: time to all live (mean of 20) | 0.870 ms | 0.791 ms |
| reconnect, 1 reference of 1,000 items: bytes down / up | 133.7 KiB / 63 B | 133.8 KiB / 110 B |
| reconnect, 100 references of 1,000 items: time to all live (mean of 5) | 63.1 ms | 66.4 ms |
| reconnect, 100 references of 1,000 items: bytes down / up | 13370.5 KiB / 4718 B | 13371.1 KiB / 6736 B |
| 1,000 calls parked while down, flushed on reconnect: time to the last result | 14.9 ms | 13.8 ms |
| 1,000 parked calls: run in the order they were made | yes | yes |

Regression rows (the live paths of 3a, same run):

| Case | binary | text |
| --- | --- | --- |
| notes list of 1,000 items: hold to live (two hops, mean of 100) | 0.750 ms | 0.682 ms |
| 500 KB document: hold to live (two hops, mean of 100) | 1.134 ms | 1.308 ms |
| one appended item: commit to frame | 0.037 ms | 0.031 ms |
| one changed field: commit to frame | 0.036 ms | 0.029 ms |
| streamed reply, 2,000 appends: time per append | 0.031 ms | 0.027 ms |
| 1 hold of 1,000 items: heap / array buffers retained per hold (both ends) | 154.6 KiB / 47 B | 160.1 KiB / 21 B |
| 10 holds of 1,000 items: heap / array buffers retained per hold (both ends) | 175.1 KiB / 41 B | 175.4 KiB / 44 B |
| call, small argument: round trip | 0.016 ms | 0.014 ms |
| call, 1 MiB bytes argument: round trip | 0.192 ms | 0.191 ms |
| messages per commit, encodes per hold (every commit case) | 1, 1 | 1, 1 |

Observations:

- The live paths are unchanged within noise (3a: 0.67 / 0.69 ms per hold, 0.037 / 0.031 ms per appended item, 154.1 /
  159.7 KiB per hold); message sizes and encodes per commit are identical. A live reference's call checks its state
  once and makes no queue; `ref.state` is not made until read.
- A reconnect costs what the holds cost the first time: about 0.63 ms and one 133.7 KiB snapshot per reference of
  this size (100 references: 63 ms, 13 MiB). The consumer sends only the `hold`s (47 B each binary).
- 1,000 parked calls take about 14 ms to flush and answer, a little less than 1,000 sequential round trips (16 ms):
  they leave in one turn once the re-hold is bound. Each parked call keeps its arguments and one timer until sent.

## Slice 4a: links and relays

Script: `test/next/bench/relay.ts`, run from `packages/chord` with
`node --conditions=source --experimental-strip-types --expose-gc --no-flush-bytecode test/next/bench/relay.ts` (about
5 s; the forked workers are the same file run with the argument `worker`). Machine as for slice 3a. Binary codec
throughout. The topology is the one of slice 4a's example: a tab (a client host), a server with an address and a
route for `Session`, and per session a worker host whose `Store` (a local document) backs a remote `View` placed on
the session; the tab holds the view through the server, which relays (no part parsed).

What the numbers include:

- *call to frame*: the tab calls `stream` (one commit appending `" tok"` on the worker) and waits for both the result
  and its watch frame; mean of 1,000 after 100 warm-up calls. Through a relay that is four hops for the call and four
  for the frame and result (tab → server → worker → server → tab); the baseline is a tab directly on the worker.
  Slice 3a's *commit to frame* started at the provider, so these are not comparable with it.
- *bytes per commit*: bytes the server sent to the tab, and received from the worker, per commit (the `state`
  message and the call's result; acks and the call go the other way). From the worker the messages carry the tab
  link's origin (two bytes each).
- *first hold, `resolve` included*: a `tab.get` of a new session: the route resolves (an in-process worker host is
  created, connects, loads its facet with 1,000 entries and activates the view), the relayed hold, the 133.7 KiB
  snapshot through two links. The IPC row's first hold includes forking a Node process with strip-types (one sample).
- *the throttled tab*: the tab's end of its link delivers at 64 KiB/s (whole messages, in order; idle time banks no
  budget) in **virtual time**, 10 ms steps, so 60 s stalls run in well under a second. Per step: one token committed
  on the worker (100 tokens/s), the throttle's delivery, then every host's turn. Phases: the first snapshot of the
  500 KB view (8 s of virtual time at 64 KiB/s), 2 s of streaming, the pause (a stall: the tab receives nothing, so
  it acknowledges nothing; or the control: the same streaming without a stall), then 10 s more of streaming and
  until the tab's text equals the worker's. *Caught up after the stall*: virtual time from the end of the pause to
  the first step where the tab's view equals the worker's document; *bytes until then*: what the throttle delivered
  meanwhile. *Heap growth during the stall*: the
  process's heap after full collections at the end of the pause minus at its start (all hosts share one process;
  compare with the control row, which is the same streaming without a stall). *Commit at the worker*: the mean time
  of `store.stream` (the transaction, its flush: an encode when the window has room, a push into the pending queues
  when it is full), outside the pause and during it. *Longest message handling at the provider*: the longest single
  received message handled after the pause at the worker, the provider of the tab's state: its end of the tab link
  directly, of the route link relayed (the `ack` that sends the folded `state`).
- *calls*: tab B's sequential `ping`s through the relay, alone and while tab A has issued 10,000 `ping`s at once on
  the same session (two holds, two origins at the worker, each with its N = 256 running calls; the relay forwards at
  once).

| Topology (1,000 streamed tokens into the 1,000-item notes list view) | call to frame | bytes per commit: to the tab / from the worker |
| --- | --- | --- |
| memory tab, in-process worker (memory links) | 0.053 ms | 27 B / 29 B |
| memory tab, forked worker (IPC) | 0.097 ms | 27 B / 29 B |
| first hold to live, the fork included (one sample) | 240 ms | - |
| loopback WebSocket tab (`ws` serving, Node's `WebSocket`), forked worker (IPC) | 0.148 ms | 27 B / 29 B |
| no relay: memory tab on the worker (baseline) | 0.034 ms | 27 B / - |

| Hold to live, the 1,000-item notes list view (133.7 KiB snapshot) | time |
| --- | --- |
| first hold, `resolve` of an in-process worker included (mean of 20) | 1.375 ms |
| hold of a resolved session through the relay (four hops, mean of 100) | 0.763 ms |
| no relay: hold on the worker (two hops, mean of 100, baseline) | 0.703 ms |

| Throttled tab (64 KiB/s), 100 tokens/s into the 500 KB view | caught up after the pause | bytes to the tab until then | heap growth during the pause | commit at the worker, outside / during the pause | longest message handling at the worker after the pause |
| --- | --- | --- | --- | --- | --- |
| direct, 1 s stall | 0.02 s | 485 B | 28.0 KiB | 0.018 ms / 0.030 ms | 0.169 ms |
| direct, 10 s stall | 0.08 s | 4147 B | 134.2 KiB | 0.029 ms / 0.023 ms | 0.053 ms |
| direct, 60 s stall | 0.38 s | 23.7 KiB | 392.2 KiB | 0.028 ms / 0.017 ms | 0.138 ms |
| direct, 60 s without a stall (control) | 0.01 s | 23 B | 482.7 KiB | 0.025 ms / 0.017 ms | 0.005 ms |
| relayed, 1 s stall | 0.02 s | 485 B | 7.5 KiB | 0.025 ms / 0.025 ms | 0.057 ms |
| relayed, 10 s stall | 0.08 s | 4147 B | -25.3 KiB | 0.030 ms / 0.015 ms | 0.059 ms |
| relayed, 60 s stall | 0.38 s | 23.7 KiB | 513.5 KiB | 0.026 ms / 0.015 ms | 0.146 ms |
| relayed, 60 s without a stall (control) | 0.01 s | 23 B | 257.1 KiB | 0.023 ms / 0.021 ms | 0.003 ms |

| Calls through the relay (in-process worker, memory links) | p50 | p95 | max | calls |
| --- | --- | --- | --- | --- |
| tab B alone | 0.012 ms | 0.018 ms | 0.600 ms | 1,000 |
| tab B while tab A has 10,000 calls in flight or queued | 4.851 ms | 10.701 ms | 10.708 ms | 27 |
| tab A: 10,000 calls at once, until the last result | 657 ms | - | - | 10,000 |

Observations:

- A relay hop costs about 0.019 ms per commit-to-frame on memory links (0.053 against 0.034 ms for call, commit, frame
  and result) and adds no bytes to the tab: the server forwards the worker's message with the origin taken off (ids
  unchanged, parts copied once); the origin costs two bytes per message on the route link. IPC to a forked worker adds about 0.04 ms, a loopback WebSocket to the tab another 0.05 ms.
- Hold to live through the relay is within 9% of a direct hold (0.763 against 0.703 ms): the relay never parses the
  133.7 KiB snapshot. A first hold that resolves an in-process worker (create, connect, load, activate) takes 1.4 ms;
  forking a strip-types Node process takes about 240 ms, which is the app's to hide (start workers ahead).
- Directly, the provider's pending queue folds a stall of any length into one append (24 KiB of text after 60 s,
  sent in 0.38 s at 64 KiB/s); committing while the window is full costs no more than committing with room (about
  0.02 ms), and the folded message is encoded in under 0.2 ms. The stall adds no heap beyond the control's, which is
  the streamed text itself on the worker and the tab.
- Through the relay a stall now costs what it costs directly (decision "Relay flow control per origin"): the worker
  keeps the tab origin's window and folds its commits into its pending queues, the relay forwards and acknowledges
  per message. Before this rework the relay ran the tab's window itself and recovered with `reset`: every stall, even
  1 s, cost three full snapshots (about 1.5 MiB) and about 24 s to catch up under sustained streaming.
- Tab B's calls are their own origin at the worker, with their own N, but B's call still waits behind the up to 256
  calls of A running there (one worker, one event loop): about 4.9 ms median, 11 ms p95, against 0.01 ms alone. A's
  10,000 calls take 0.07 ms each (its window of 256 refills one reply round trip through the relay at a time).
- A first run of this script found about 350 B retained per call or commit: `AbortSignal.any` on Node 24.4.1 keeps
  cleanup entries per call while its sources live (nodejs/node#62367, fixed in 24.16.0). Calls and gets now link
  their signals only until they settle (`withLinkedAbortSignal`); the numbers above are after that fix (heap during a
  60 s stall: 2.3 MiB before, 0.4 MiB after).

## Slice 4b: authority and housekeeping

Script: `test/next/bench/compression.ts`, run from `packages/chord` with
`node --conditions=source --experimental-strip-types --expose-gc test/next/bench/compression.ts` (about 5 s). Node
24.4.1, Intel Core i9-13900, one process.

Payloads: the 500 KB document of slice 3a (500 entries `{ id, text, author, at }` of 960 characters), but with
prose-like text (words from a small vocabulary in a fixed pseudo-random order, some with numbers: it compresses about
3.6x at level 1, as conversation JSON does; the `"x".repeat` texts of the earlier benchmarks would compress about
100x and say nothing), and a 1 MiB string as a call's result (a file export). Compression is option (b) as built:
`nodeCompression` (zlib's raw deflate at level 1) at the origin; the owner inflates with `nodeCompression`
(synchronous, a Node client) or `DecompressionStream` (asynchronous, a browser).

- *deflate at the origin / inflate*: one part through the adapter alone, mean of 20, the fastest of three loops.
- *end to end*: a server and a client host on a memory link (binary codec); *hold to live* is a further `get` of the
  live view (snapshot encoded, deflated, sent, inflated, parsed, replicas built), *call to result* a call returning
  the 1 MiB string; *bytes received* is the one message as the client's link delivered it.

| Payload | JSON | deflated (level 1) | deflate at the origin | inflate, sync (`nodeCompression`) | inflate, async (`DecompressionStream`) |
| --- | --- | --- | --- | --- | --- |
| 500 KB snapshot | 494.9 KiB | 137.4 KiB | 3.308 ms | 0.915 ms | 1.400 ms |
| 1 MiB result | 1024.0 KiB | 286.1 KiB | 6.856 ms | 1.757 ms | 3.113 ms |

| End to end over a memory link (binary codec) | snapshot: bytes received | hold to live (mean of 20) | 1 MiB result: bytes received | call to result (mean of 20) |
| --- | --- | --- | --- | --- |
| uncompressed | 494.9 KiB | 1.197 ms | 1024.0 KiB | 1.939 ms |
| deflated, inflated synchronously (Node client) | 137.5 KiB | 5.632 ms | 286.1 KiB | 10.868 ms |
| deflated, inflated asynchronously (browser client) | 137.5 KiB | 6.356 ms | 286.1 KiB | 12.198 ms |

Rerun after the review fixes (inflate only after admission by the part's owner, a tagged adapter result, byte counts
for the threshold): the same within noise (the asynchronous inflate of the 500 KB part varies between 1.4 and 2.0 ms
from run to run).

Observations:

- Level 1 cuts prose-like JSON to 28% (494.9 to 137.4 KiB, 1 MiB to 286 KiB) at about 6.7 ms per MiB deflated at the
  origin and 1.8 ms per MiB inflated synchronously; `DecompressionStream` takes about twice as long as zlib's
  synchronous inflate (3.1 against 1.8 ms per MiB) and adds its own turns, which the in-order holding of the link's
  later messages absorbs.
- On a memory link (no transport time) compression only costs: hold to live 1.2 → 5.6 ms, the 1 MiB call 2.0 →
  10.9 ms. It pays where bytes take time: at 10 MB/s a 500 KB snapshot takes about 50 ms uncompressed and 14 ms
  compressed (plus 4.3 ms of deflate and inflate); at 1 MB/s (a phone) 500 ms against 140 ms. On IPC to a worker
  (gigabytes per second) it does not pay for itself on that hop: it pays on the tab's WebSocket, where the relay
  forwards the worker's deflated part as it is (a test counts no inflate at the relay).
- Parts at or below 16 KiB (UTF-8 bytes) are never compressed (a state change, most call arguments), nor is a part
  that deflating does not make smaller (sent as the bytes encoded for the attempt, never encoded twice), nor hold
  params, nor call arguments sent up a parent link: the cost per message of the slices 3a-4a benchmarks is unchanged. The binary codec's part prefix (length doubled, plus one when deflated) costs
  a byte more for parts between 64 and 127 bytes.

## Slice 6a: the store

`test/next/bench/store.ts` (run by hand: `node --conditions=source --experimental-strip-types --expose-gc
test/next/bench/store.ts` from `packages/chord`): Node 24.4.1, `chord/sqlite/node` on a fresh SQLite file per burst
for both sides (the same pragmas and file system), 7 bursts of 1,000 commits after a warm-up burst; per commit, the
median and p95 of single commits and the burst's mean.

The gate (decision "The commit-step benchmark"): the store without outbox no slower than Durable's `SqliteStorage`.

| Case | Durable | Chord store | Chord store + outbox |
| --- | --- | --- | --- |
| (a) one document delta per commit (step level) | 23.7 / 31.4 / 32.9 µs | 13.4 / 18.7 / 20.9 µs | 16.6 / 29.2 / 26.7 µs |
| (b) one table `put` (Durable: one entry append) | 19.3 / 27.1 / 29.5 µs | 13.2 / 23.6 / 20.6 µs | 17.5 / 28.1 / 26.3 µs |
| (c) whole transactions back to back, no watch (Durable `Session`, Chord host) | 35.0 / 61.1 / 44.4 µs | 18.1 / 27.2 / 25.7 µs | 20.3 / 38.8 / 30.7 µs |
| (c) the same with a watched document | 34.1 / 55.4 / 42.4 µs | 20.6 / 26.3 / 27.1 µs | 20.2 / 39.0 / 29.9 µs |
| (d) one in-memory document per transaction (no store) | | 2.5 / 2.9 / 2.7 µs | |
| (d) the same, watched | | 2.6 / 4.4 / 2.7 µs | |

Every gate case passes. The outbox adds 3-5 µs per commit (one `INSERT` of the commit's writes as JSON). The heap after
GC at the end of the whole script is about 3 MiB above its start (the modules and statement caches loaded on the way).

In-memory transactions against HEAD (before slice 6a), after the second fix round (`Transaction.draft` returns its
draft's promise as it is: an in-memory `change` settles in 5 microtask turns, HEAD 6, a test guards it): one `change`
per transaction through a host, 15 bursts of 1,000 per process with a timer around each `change`, HEAD's source
extracted beside this checkout, the same script on both, alternating processes pinned to one CPU (`taskset -c 4`),
three runs; median / p95 / burst mean:

| Case | HEAD | now |
| --- | --- | --- |
| unwatched document | 2.52-2.55 / 4.96-5.02 / 5.41-5.44 µs | 2.56-2.60 / 5.02-5.06 / 5.69-5.71 µs |
| watched document | 2.96-3.07 / 6.44-6.54 / 6.81-6.90 µs | 2.96-3.01 / 6.35-6.42 / 6.88-6.95 µs |
| watched derive through a reference | 3.14-3.29 / 6.77-6.93 / 8.38-8.50 µs | 3.06-3.08 / 6.49-6.53 / 7.52-7.54 µs |

What the differences are (the second review's measurements, Opus):

- The change path itself is at HEAD's level or below. Without the per-operation timer, a tight loop of 200,000 changes
  costs 3.67-3.69 µs against HEAD's 3.70-3.78 µs (and the loop of the timed harness 4.85-5.06 µs against
  5.15-5.24 µs). Allocation per change is lower (7,703 B against 8,035 B, measured with a semi-space of 128 MB so no
  scavenge lands in a burst), and so are the collections (40 hosts of 2,000 changes: 34 scavenges against 38, 2
  mark-compacts on both).
- The median difference of the timed harness (+1-2% here, up to +3-7% elsewhere) comes from the per-operation timer:
  it stays with zero collections in the bursts and disappears without the timer, so it is harness-sensitive (code
  layout, inline caches), not work in the change path.
- The burst means differ by where a mark-compact lands: the worst burst per process coincides with a mark-compact over
  a larger old space (67 MB against 45 MB before the collection, about 18 MB after on both; a pause of 5.2-7.1 ms
  against 3.0-3.7 ms), which is heap-growth timing, not extra garbage. Host setup is about 3% above HEAD (21.9-23.2 µs
  against 21.1-21.9 µs per host, create, load and get; close equal), which the burst means include too.

Calls and references (`taskset -c 4`, five alternating pairs of processes; one host, 21 bursts of 3,000 operations
after 3 warm-up bursts, a timer around each; reads: 200,000 per burst, burst means). Every call admits its handler to
the drain and its cleanup (call count, `ctx.get` references) in one map entry with one reaction: 19 promises per call
against HEAD's 20, a test guards it. A reference's state members are its object's member sources (one per object and
member, re-bound when a new attempt goes live): a watch through a reference gets the member's frame passed on as it is
(one call more per frame), a read goes through one getter more.

| Case | HEAD | now |
| --- | --- | --- |
| local call: median / p95 / burst median / burst p95 | 1.49-1.51 / 1.93-1.99 / 1.64-1.67 / 2.51-2.75 µs | 1.47-1.48 / 1.93-1.96 / 1.59-1.61 / 2.40-2.47 µs |
| `change` under a watch through a reference, derive member: median / p95; frames per second | 2.80-2.92 / 4.64-4.80 µs; 268,000-282,000 | 2.76-2.87 / 4.75-4.84 µs; 278,000-288,000 |
| the same, document member | 2.68-2.79 / 4.58-4.79 µs; 285,000-306,000 | 2.67-2.76 / 4.57-4.79 µs; 285,000-306,000 |
| `ref.member.value`, derive member | 9.24-10.82 ns | 8.53-8.57 ns |
| `ref.member.value`, document member | 10.02-10.10 ns | 10.30-10.32 ns |

Calls are 1-3% faster than HEAD (bursts' p95 10% lower), watches through a reference at HEAD's level (p95 +1-2% for a
derive member, more frames per second), a derive member's read faster; a document member's read costs 0.25 ns more
(the member source's getter in front of the slot's).

A local document member re-exposed by a remote object and held over a memory link (one `change` and its state message
per operation; Astra's third review harness, `taskset -c 4`, alternating pairs, 41 bursts of 10,000 after 3 warm-up
bursts): a member source passes its subscribers (holds, member sources re-exposing it) on to the member it follows, so
their frames take no extra hop. Burst median 7.80-8.38 µs against HEAD's 7.82-8.35 µs, burst p95 8.84-9.44 against
9.52-10.06 µs, median per operation 6.76-7.34 against 6.82-7.29 µs (before the pass-through, one run: 8.51 / 13.05 µs
against 7.99 / 10.36 µs). Host setup (+2-4%) and a document member's read through a reference (+0.25 ns) are accepted
as they are.

After Delta's tracker stopped allocating a `WeakRef` per change (pi a92283056, merged as 95ec93a08), against HEAD
95ec93a08 (which has that change too) extracted at a path as long as this checkout's (44 characters). Sol's tight
harness without a per-operation timer (`taskset -c 4`, five alternating pairs of processes, 31 bursts of 10,000 after
3 warm-up bursts; medians of the burst medians, ranges in parentheses):

| Case | HEAD | now |
| --- | --- | --- |
| unwatched `change` | 1.96 µs | 1.96 µs (0.0%) |
| `change` under a watch of the document | 2.24 µs | 2.19 µs (-2.1%) |
| `change` under a watch through a reference | 2.23 µs | 2.21 µs (-0.8%) |
| `change` under a watch of a derive through a reference | 2.33 µs | 2.26 µs (-2.9%) |
| local call | 1.36 µs | 1.33 µs (-1.9%) |
| a document member forwarded into a remote object, held over a memory link | 6.60 µs (6.54-6.63) | 6.52 µs (6.48-6.59) (-1.2%) |
| the same, yielding a macrotask every 1,000 operations | 6.67 µs (6.57-7.02) | 6.54 µs (6.42-6.79) (-1.9%) |

Collections over one forwarded-link run (`--trace-gc-nvp`, 340,000 operations, two processes each; scavenges and
promotion were the same in both):

| Run | Promoted | Scavenges | Mark-compacts | GC pauses |
| --- | --- | --- | --- | --- |
| HEAD | 6 MB | 158 | 2 | 154 ms |
| now | 7 MB | 148 | 2 | 147-148 ms |
| HEAD, yielding every 1,000 | 6 MB | 186 | 2-3 | 149-162 ms |
| now, yielding every 1,000 | 7 MB | 178 | 2-3 | 145-149 ms |

History: the fifth fix round's measurement, before the Delta change (failure calls once per episode, watches on
failed sources, keyed pins still loading). Sol's tight harness without a per-operation timer (`taskset -c 4`, five
alternating pairs of processes, 31 bursts of 10,000 after 3 warm-up bursts; burst medians, HEAD's source at
`/tmp/chord-head4`, this checkout at its own path):

| Case | HEAD | now |
| --- | --- | --- |
| unwatched `change` | 2.91 µs | 2.95 µs (+1.5%) |
| `change` under a watch of the document | 3.14 µs | 3.10 µs (-1.4%) |
| `change` under a watch through a reference | 3.10 µs | 3.08 µs (-0.4%) |
| `change` under a watch of a derive through a reference | 3.21 µs | 3.26 µs (+1.6%) |
| local call | 1.37 µs | 1.35 µs (-2.0%) |
| a document member forwarded into a remote object, held over a memory link | 7.80 µs | 8.32 µs (+6.6%) |
| the same, `--no-allocation-site-pretenuring` | 8.12 µs | 8.04 µs (-1.0%) |
| the same, yielding a macrotask every 1,000 operations | 7.17 µs | 8.61 µs (+20%) |
| the same, yielding, `--no-allocation-site-pretenuring` | 7.21 µs | 7.52 µs (+4.2%) |

Allocation per operation, with a fixed semi-space of 256 MB so no scavenge lands in the measured 20,000 operations, is
below HEAD's in every case: 6,942 B against 7,317 B unwatched, 8,383-8,393 B against 8,764 B watched, 8,935-8,939 B
against 9,338 B for a derive, 8,405-8,413 B against 8,764 B through a reference, 2,885 B against 3,089 B over the
link. What stays after the link drains and a GC is equal (18.9 against 19.0 B per operation).

The forwarded-link gap is not work or retention in 6a's code. It is a V8 decision that depends on heap layout:

- With huge semi-spaces (no scavenges) the two take the same time (10.01 against 10.00 µs). Without pretenuring (the
  flag above) they are equal too.
- An identical copy of this checkout's source runs at HEAD's level (7.1 µs, 7 MB promoted over the run) when its path
  is at most 40 characters long (`/tmp/wexp/packages/chord/src`). From 44 characters on it flips: 46 MB promoted, 4
  mark-compacts instead of 2, about 9 µs. The repository's own path is 44 characters. HEAD's source does not flip at
  any tested path length (28 to 62 characters).
- `--trace-deopt` shows the flip: V8 marks the allocation site of the delta tracker's per-change overlay context
  (`createContext`, inlined into `beginChange` and `Transaction.#begin`) as tenured. From then on every change's context
  is allocated in old space and dies there.
- The contexts survive scavenges because each change registers its context as a `WeakRef` target
  (`TrackerImpl.#register`). A `WeakRef` keeps its target alive until the current job ends, and scavenges do not
  clear it. So a site that allocates one context per change shows a high survival rate.
- Heap snapshots taken during and after the run are equal between the two trees, and no 6a object outlives its
  change.
- pi a92283056 ("Delta's tracker holds its one open change without a WeakRef") removed the cause: the numbers above
  it show the forwarded link at HEAD's level with 6-7 MB promoted and 2 mark-compacts on both.

A retirement under a diamond of derives (`test/next/bench/derives.ts`: 40 derives in 13 layers of two derives joined
by a third, 2^13 paths from top to bottom, the bottom watched; one step retires and recreates the document in one
transaction): 9.8 µs median, 17.7 µs p95 per step with one visit per derive per batch; 349 µs without the visited set
(one visit per path).

Binary `state` messages (`test/next/bench/links.ts`, against HEAD, alternating, pinned): an entry without retirements
costs no extra byte (165 / 27 / 23 B for one appended item, one changed field, one removed item, as at HEAD); encode
and decode are at HEAD's level (one changed field, 200,000 runs, best of 9: encode 1,167-1,203 ns against
1,172-1,275 ns, decode 692 against 685-705 ns); heap per encode and decode 1,592 / 1,631 / 1,363 B against 1,684 /
1,726 / 1,355 B; commit to frame within HEAD's range (0.112-0.166 ms against 0.111-0.164 ms). After the second fix
round (`taskset -c 4`, two runs each): commit to frame 0.086-0.087 / 0.097-0.099 / 0.065 ms against 0.084-0.089 /
0.098-0.099 / 0.064 ms, a streamed append 0.053 ms against 0.051-0.053 ms, the same bytes and heap.

Other costs (one run each):

| Cost | Result |
| --- | --- |
| 100 commits submitted at once: time waiting in the queue against the step itself | median wait 956 µs, step 11.3 µs |
| a query page of 100 rows in an index's order (10,000 rows, cursors) | 113 µs per page |
| one `updateWhere` over 10,000 rows | one step of 10.6 ms (every owner's commits wait behind it) |
| `put` with 10-character text cells / 10,000-character cells (2,000 rows, one commit) | 2.4 / 58.4 µs per row |
| a `rows` migration of 10,000 rows (100 chunks; `taskset -c 4`) | 69-71 ms in all, 7.0 µs per row; chunk commits: first 0.34 ms, last 0.21 ms, median 0.22 ms |

Observations:

- The commit step is cheaper than Durable's per commit: Chord keeps no generic entry log beside the documents engine
  and its tables, and serializes writes before the queue (rule 8).
- Between chunks a migration yields one macrotask without the 1 ms clamp of `setTimeout(0)`: `setImmediate` where the
  runtime has it, else a `MessageChannel` message (Workers, browsers). The same 10,000-row migration takes 191 ms with
  `setTimeout(0)` (99 clamped yields) and 100 ms with messages in Node (0.27 ms per yield there, against 13 µs for
  `setImmediate`).
- Late migration chunks cost what early ones do (paging forward by the last key keeps each chunk's read bounded); the
  spec's estimate of about 15 µs per migrated row holds with room.
- A bulk write's step is the one place a single commit holds every owner's commits for milliseconds; the guide says so.

## Slice 6b: Durable on the store, persisted jobs (2026-10-28)

Node 24.4.1, one CPU (`taskset -c 6`), SQLite files in `tmpdir()`. HEAD is `b2fcfee08`, extracted at a path of the same
length (`/home/badlogic/pi-6h`); runs alternate HEAD and the build.

**Durable's storage benchmark** (`packages/durable/test/storage.bench.ts`, `TIMING_SCALE`), `StoreStorage` (outbox off)
against `SqliteStorage` in the same process, mean ms per operation over three runs (p75 where the mean is one outlier):

| Case | SqliteStorage | StoreStorage | |
| --- | --- | --- | --- |
| exact entry lookup | 0.0030 | 0.0030 | 0% |
| entry page scan (100) | 0.0942 | 0.0940 | 0% |
| filtered task scan (50) | 0.0206 (p75 0.0200) | 0.0220 (p75 0.0207) | +7% mean, +3% p75 |
| exact document address among many | 0.0037 | 0.0037 | 0% |
| document replay tail (0) | 0.0089 (p75 0.0084) | 0.0092 (p75 0.0085) | +3% mean, +1% p75 |
| document replay tail (16 / 128 / 1024) | 0.0300 / 0.1726 / 1.224 | 0.0270 / 0.1522 / 1.135 | -10% / -12% / -7% |
| ancient / recent historical read | 0.1681 / 0.1611 | 0.1541 / 0.1513 | -8% / -6% |
| fork-depth history scan (100) | 0.1177 (p75 0.1156) | 0.1208 (p75 0.1159) | +3% mean, 0% p75 |
| fork-depth head lookup | 0.0361 | 0.0332 | -8% |
| commit one entry (20 samples) | 0.0439 (p75 0.0416) | 0.0601 (p75 0.0373) | +37% mean, -10% p75 |
| commit 100 entries | 0.743 | 0.620 | -17% |
| commit mixed entry/task/submission/document | 0.195 | 0.187 | -4% |
| reopen and first exact read | 0.294 | 0.443 | +51% |

Warm micro-benchmarks behind the same cases (each read 20,000 times; commits 10,000 after 2,000 warm-up): page scan
91.2 vs 90.6 µs, task scan 19.9 vs 20.1 µs, fork-depth scan 114.1 vs 114.9 µs, head lookup 35.3 vs 32.9 µs, document
address 3.57 vs 3.68 µs, replay tail (0) 8.41 vs 8.44 µs; one entry per commit 29.6 vs 27.8 µs mean, 18.4 vs 17.1 µs
median. What it took, beyond the first build's compiled reads, point lookups without a bound `LIMIT`, version columns
selected only past version 1 and the counting read guard:

- **Reads select only the record.** A scan selected an entry's `commit_seq` too (only `entry(id)` needs it): 7% of a
  page scan.
- **No index for head markers on every entry.** `entries.by_head (conversation_id, has_head, id)` cost about 5.5 µs per
  commit (a raw insert: 39.7 vs 45.2 µs); `SqliteStorage` has a partial index (`WHERE head IS NOT NULL`), which the
  table vocabulary does not have. The head markers are an `entry_heads` table instead, written only with an entry that
  has one: a commit without one writes no second index, and a head lookup reads the newest head's id, then the entry.
- **A document record is one JSON text.** `meta` keeps the whole Durable record, its creation seq included; a read
  selects `meta` (and `retired_at` only at a point).
- **A store already at the newest schema opens with one read** (schema version, encoding and metadata row), without
  the migrations' write transaction: 84 → 71 µs on a fresh connection.

Commit one entry: the mean is one sample (Maglev compiling the commit path on the first fixtures: 130 and 386 µs at
fixtures 25 and 30 of the first store round of a 60-fixture replay, none in the second round, no GC or deopt traced);
the median and p75 are lower than `SqliteStorage`'s. Reopen: a fresh connection on a copied file, measured in parts
(`openNodeSqliteDatabase` is the same for both): `SqliteStorage.open` 42-60 µs; `openStore` 63-71 µs (the schema read,
the catalog with its JSON parse) plus `StoreStorage.open` 75 µs (declaring six tables: their SQL rendered, claims; the
catalog check of the table preparation; `max(record_ids.id)` for the allocator, as §2.1 asks; compiling the point
reads), first read +3 µs: about 0.1-0.15 ms once per open, cold code, not on any hot path.

**Statements per commit** (cost guard in `packages/durable/test/store-storage.test.ts`): an entry append and a document
delta take 4 each (`SqliteStorage`: 5 and about 7).

**Memory** (`packages/durable/test/storage-memory.ts`): heap after seeding 0.16 → 0.30 MiB (1k), 0.17 → 0.32 MiB (10k):
a fixed cost of the store (catalog, compiled statements, claims, the store's code), the same at both scales; heap after
reads 0.13 → 0.16-0.18 MiB. Disk 0.61 → 0.58 MiB (1k), 4.34 → 4.38 MiB (10k).

**Chord's commit gate** (`test/next/bench/store.ts`), HEAD → build, two alternating runs each, medians:

| Case | HEAD | build |
| --- | --- | --- |
| (a) one document delta per commit | 13.6-13.7 µs | 13.8-14.0 µs (+2%) |
| (b) one table put per commit | 12.8-13.3 µs | 13.0-13.2 µs |
| (c) whole transactions (no watch / watched) | 17.2-17.3 / 17.1-17.2 µs | 17.4-17.7 / 17.2-17.7 µs (+2%) |
| (d) one in-memory document (median / burst) | 2.1 / 2.9-3.0 µs | 2.1 / 4.9 µs |
| heap after GC | 2940 KiB | 2996 KiB |

The revisions index is a partial index on bases (`(document_id, seq) WHERE kind = 'base'`): a delta writes no index
entry (the first build's `(document_id, kind, seq)` cost (a) 15%). (d)'s burst is not the in-memory path: run alone
(only section (d), three alternating runs) HEAD gives 4.9-5.1 µs and the build 4.9-5.0 µs per commit, and 40 bursts of
1,000 in a fresh process 2.17 vs 2.18-2.38 µs; in the full gate, HEAD's in-memory path runs warm from the persisted
sections before it, the build's does not share as much of their code (`StoredChange`'s variants).

**Durable's conversation view benchmark** (`test/conversation-view-bench.ts`, `PI_DURABLE_BENCH_STORAGE`), two runs
each, `SqliteStorage` → `StoreStorage`: append one entry per commit 56.1-57.2 → 56.2-57.0 µs with one watch, 61.0-62.1
→ 62.7-63.1 µs with four (+2%); bursts of 50 884-888 → 891 µs; `pi.live` only 62.7-63.0 → 65.1-66.6 µs (+4-6%); a
long-lived watch over 20,000 appends 0.83-0.85 → 0.84-0.85 s CPU; heaps 21.5 → 21.7 MiB.

**Fix round 1** (2026-10-28, after the build reviews): `StoreStorage`'s reads take one promise besides the store's guard
(no `#call` wrapper; `close` waits for its commits, a read changes nothing), their request errors in a tagged result.
Warm micro-benchmark (20,000 runs, two runs each, `SqliteStorage` → `StoreStorage`): filtered task scan 19.8 → 19.8-20.1
µs, `entry(conversation, id)` over the fork chain 23.1 → 21.9-22.3 µs. `storage.bench.ts` (two runs): task scan mean
0.0207 → 0.0217-0.0218 ms (p75 0.0200-0.0203 → 0.0204-0.0206), fork-depth scan 0.1177-0.1188 → 0.1210-0.1242 (p75
0.1154-0.1167 → 0.1160-0.1193), the rest as above.
`conversation-view-bench` "resume 20 back", three runs: CPU 4.23-4.47 → 4.50-5.14 ms for a 3 ms scenario (one sample
each; the head lookup and scans under it are at parity or faster in the micro-benchmark). The persisted-job fixes
(one invocation per call of `run`, held state folded in a `PendingOps`): start 55.5 → 55.2 µs, immediate state change
21.3 → 21.2 µs, deferred 3.2 → 3.5 µs (the fold), in memory unchanged.

**Persisted jobs** (`test/next/bench/jobs.ts`, 7 bursts of 500, medians): a start (resolved after its commit) 8.4 µs in
memory, 55.5 µs persisted (two commits: the record and state created, then the reservation); a state change inside
`run` 2.7 µs in memory, 21.3 µs persisted (one delta commit, as the gate's (c)), 3.2 µs deferred (stored with the
outcome).

## Slice 8: registries and `host.root` (2026-10-28)

Node 24.4.1, one CPU (`taskset -c 6`), runs alternating. HEAD is `391e83fb1`, extracted at a path of the same length
(`/home/badlogic/pi-h8`); the build was measured in the worktree and, where the worktree itself skewed a result (below),
in an extract of the same sources at `/home/badlogic/pi-x8`.

**Paths under every object** (`test/next/bench/calls.ts`, new: runs on HEAD as it is), median per operation over nine
bursts, heap allocated per operation, three alternating runs each, HEAD → build:

| Case | HEAD | build |
| --- | --- | --- |
| local method call (its ctx) | 2.80-2.81 µs, 6,894 B | 2.81-2.83 µs, 6,894 B |
| commit through a watched derive (`batch.compute`) | 10.34-10.43 µs, 15,312 B | 10.46-10.51 µs, 15,310 B |
| activation churn: get, live, release (an object with params) | 57.5-59.3 µs, 43,696-43,717 B | 58.1-58.9 µs, 43,782-43,787 B |
| retained per live object (10,000 kept) | 6,586 B | 6,602 B |

The attempt keeps its registry reads, contributions, wake signals and writables in one record made by the first such
declaration, and iterates nothing when there is none: the first build allocated 1,020 B more per activation (six
arrays per attempt, an array iterator per `for … of` over an empty list, a copy from `splice`) and retained 72 B more
per live object; now +70 B allocated and +16 B retained (one field on the attempt, one on the object).

**Existing benchmarks**, HEAD → build: the derive diamond (`derives.ts`, three runs) 9.4-9.8 → 9.5-9.9 µs median; its
pooled p95 16.5-17.1 → 18.4-20.8 µs comes from the run in which V8 tiers the commit path up (per run, after it: HEAD
10.7-11.3 µs, build 10.1-11.3 µs; the first measured runs 15.0-25.6 µs on either side, in another run each), the same
with HEAD's `batch.ts` and `derive.ts` in the build. The store gate (`store.ts`, three runs): every median within
0.4 µs (Chord store 13.0-13.9 → 13.0-14.2 µs, Chord host 17.3-18.2 → 17.3-17.8 µs, in-memory document 2.1 → 2.2 µs),
heap 3,498 → 3,144 KiB. Jobs (`jobs.ts`): start 8.4 → 8.5 µs in memory, 55.4 → 56.2 µs persisted; state change 2.7 →
2.7, 21.3 → 21.8, 3.4 → 3.5 µs. Links (`links.ts`, three runs): wire sizes, encodes, decodes and heap per message
unchanged; its round trips are one cold burst each and vary as much between HEAD runs (commit to frame, text codec,
0.055-0.076 ms). A warmed remote call (2,000 calls per burst, nine bursts, a memory link): binary 7.16-7.24 → 7.17-7.29
µs, text 7.66-7.72 → 7.70-7.83 µs in the extracts; the worktree itself runs the same sources at 7.8-7.9 µs (binary),
an effect of the tree, not the code.

**Registries and writables** (`test/next/bench/registries.ts`, new), median over nine bursts: `writable.set` delivered
to one watch 0.81-0.91 µs (2.9 KB allocated: the batch and the watch's call); a set of the same value 0.008 µs, 0 B
(one comparison: its batch work is a method of its own, so `set` allocates no closure context); one of 10 contributions
changed while the registry is watched 0.74-0.77 µs, of 100 1.52-1.59 µs (the table built again over every entry, one
compose per set: the counted `chord.registry.composes` is 1.00 per set).

**Fix round 1** (2026-10-28), HEAD extract → build extract (`/home/badlogic/pi-x8`), CPU 6. `calls.ts`, two runs: local
method call 2.80 → 2.80-2.81 µs, 6,894 B both; commit through a watched derive 10.51-10.65 → 10.72 µs; activation churn
57.9-59.0 → 59.3-60.0 µs, 43,714 → 43,769-43,787 B. The derive diamond (five runs): median 9.4-9.8 → 9.5 µs, pooled p95
16.4-16.7 → 19.0-19.2 µs. Per run, both have one slow run while V8 tiers the commit path up (HEAD its second, median/p95
15.5/22.6-22.9 µs; the build its first, 16.4/26.7-27.2 µs) and equal runs after it (HEAD 8.8-9.6/9.6-11.2 µs, build
8.9-9.8/9.7-10.6 µs). `batch.compute` is not the cause: HEAD's `batch.ts` and `derive.ts` in the build give the same
p95, and swapping host files moves it without a pattern (code layout, not work on the path). `registries.ts`:
`writable.set` 0.87 µs, the same value 0.011-0.016 µs and 0 B (the seal check now comes first: a set of an ended
attempt's writable throws whatever its value); one of 10 contributions set 0.71-0.78 µs, of 100 1.43-1.61 µs (one run
in six 3.4 µs on either variant tried: JIT).

## Slice 7a: the dependency model (2026-10-29)

Node 24.4.1, one CPU (`taskset -c 6`), runs alternating. HEAD is `babe30a7e`, extracted at a path of the same length
(`/home/badlogic/pi-h7`); the build in the worktree (`/home/badlogic/pi-7a`).

**Paths under every object** (`test/next/bench/calls.ts`), median per operation over nine bursts, heap allocated per
operation, three alternating runs each, HEAD → build:

| Case | HEAD | build |
| --- | --- | --- |
| local method call (its ctx) | 2.81-2.82 µs, 6,894 B | 2.80-2.82 µs, 6,894 B |
| commit through a watched derive | 10.43-10.70 µs, 15,310 B | 10.38-10.53 µs, 15,310 B |
| activation churn: get, live, release (an object with params and one dependency) | 58.5-59.9 µs, 43,716-43,719 B | 53.7-55.4 µs, 41,540-41,559 B |
| retained per live object with one dependency (10,000 kept, an ad-hoc probe) | 7,398-7,406 B | 6,931-6,936 B |

An activation whose dependencies are live at the check does not park: one check of its bindings, then its own steps a
microtask later (as HEAD's wait did). The first build parked every attempt with a dependency (a waiter list, a
`parked_long` record, a microtask per wake even outside parking) and cost 62.0-63.6 µs and 580 B more per activation;
now a wake outside parking is a flag, the first-outcome promise is made only for whoever waits (the start barrier),
and an object keeps no `Set` of waits and no settlement promise per attempt (R18's), hence the lower numbers.

**Links** (`links.ts`, three runs each): wire sizes, encodes, decodes, heap per message and retained heap per hold
(176.0 → 175.4-176.0 KiB) unchanged. Hold to live over two hops (mean of 100), binary: 1,000-item list 0.781-0.817 →
0.807-0.811 ms, 500 KB document 1.250-1.278 → 1.289-1.310 ms (+1-3%: the hold counted at its arrival, the index
check of the publication); text 1.545-1.580 → 1.521-1.573 and 3.299-3.379 → 3.317-3.393 ms. Commits to frames,
streamed appends, call round trips and reconnects within the runs' spread.

**Existing benchmarks**, HEAD → build: the derive diamond (`derives.ts`, three runs) 9.4-10.1 → 9.5-9.6 µs median,
p95 19.3-19.9 → 19.3-19.4 µs. Registries (`registries.ts`, three runs): `writable.set` 0.82-0.97 → 0.77-0.87 µs; one of
10 contributions set 0.72-2.71 → 0.70-1.06 µs; of 100 1.50-3.46 → 1.44-3.40 µs (one slow run per side: JIT);
allocation within 20 B. A registry's last good composition keeps the list of contributions it was built from: the
list is replaced (not spliced) when a contributor comes or goes, so a composition costs no copy.

**Fix round 1** (2026-10-29: revocation over paths, retry operations on the wire, the provider's own host-address
check for same-host remote requests, mapped values' provenance), `calls.ts`, three alternating runs, HEAD → build:
local call 2.81 → 2.79-2.82 µs (6,894 B both), watched derive commit 10.45-10.70 → 10.35-10.47 µs, activation churn
58.6-59.8 → 53.9-54.2 µs (43,716-43,720 → 41,559 B); retained per live object with one dependency 7,399-7,405 →
6,930-6,938 B. The address check runs only for a remote type whose consumer and provider `hostAddress` differ; a
retry's operation id is made per `ref.retry()`, and an object keeps its handled ids only once it was retried.

## Slice 7b: reload in the kernel (2026-10-29)

Node 24.4.1, one CPU (`taskset -c 6`), runs alternating. HEAD is `0c3675e64`, extracted at a path of the same length
(`/home/badlogic/pi-hb`); the build in the worktree (`/home/badlogic/pi-7b`).

**Paths under every object** (`test/next/bench/calls.ts`), median per operation over nine bursts, heap allocated per
operation, alternating runs (the last two after the fixes below), HEAD → build:

| Case | HEAD | build |
| --- | --- | --- |
| local method call (its ctx) | 2.80-2.83 µs, 6,894 B | 2.67-2.70 µs, 6,757 B |
| commit through a watched derive | 10.38-10.69 µs, 15,309 B | 10.22-10.39 µs, 15,312 B |
| activation churn: get, live, release (an object with params) | 53.6-55.3 µs, 41,539-41,560 B | 54.2-55.6 µs, 41,606-41,630 B |
| retained per live object with params and one dependency (10,000 kept, an ad-hoc probe, median of 5) | 8,696-8,700 B | 8,761 B |

The first build cost 60.4-62.7 µs and 2,480 B more per activation: every attempt made an `AbortController` for its
routines and two maps (routine calls, job invocations) whether it had any. Now they are made when routines start or a
run is admitted, and the first dependency check's answer is a shared constant unless someone asks for it; what a reload
did to an attempt is one record made by the first such step. What remains: a few fields on the object (its params key)
and the attempt (its routines, its reload record, its first check), +46-70 B allocated and +61-65 B retained (0.7%).
A local call allocates 137 B less: the method path is split (`#invoke`) so the current version's call builds no
mapping closure.

**Links** (`links.ts`, two runs each): wire sizes, encodes, decodes and heap per message unchanged. Hold to live over
two hops (mean of 100), binary: 1,000-item list 0.780-0.794 → 0.797-0.821 ms (+1-4%), 500 KB document 1.246-1.275 →
1.270-1.275 ms; commits to frames and streamed appends within the runs' spread. Retained per hold of 10: 175.8 → 176.2-176.5
KiB (the hold keeps its request, to be placed again after a reload); the single-hold row 176.0 → 180.2 KiB is one
fixed amount (~4 KiB, code of the new paths), divided by ten in the other row.

**Existing benchmarks**, HEAD → build: the derive diamond (`derives.ts`, two runs) 9.5-9.6 → 9.6 µs median, p95
16.4-19.3 → 14.1-14.3 µs. Registries (`registries.ts`, two runs): `writable.set` 0.94-0.96 → 0.77-0.86 µs; one of 10
contributions set 0.77-1.05 → 0.69-0.72 µs; of 100 1.57-1.58 → 1.54-3.30 µs (one slow run: JIT, as in 7a). Jobs
(`jobs.ts`, two runs): start 8.6-8.7 → 8.5 µs in memory, 55.3-56.1 → 55.3-55.6 µs persisted; state changes within 0.1
µs. The store (`store.ts`): every median within 0.3 µs. The relay (`relay.ts`, three runs): tab B alone 0.014 ms both;
10,000 calls at once 530-723 → 491-785 ms (the spread of either side).

**Reload** (`test/next/bench/reload.ts`, new): 20 plugins, 1,000 live objects (with params, a document, a derive and a
method each), one plugin reloaded 20 times; medians after two warm-up reloads, two runs:

| Case | reload resolves | all live again | heap after 20 reloads, above after the first |
| --- | --- | --- | --- |
| swap, 50 of the 1,000 objects in the reloaded plugin | 1.58-1.59 ms | 1.64-1.65 ms | 332-338 KiB |
| swap, all 1,000 in it | 35.5-36.3 ms | 36.6-37.2 ms | 191-192 KiB |
| restart (a native each), 50 of 1,000 | 1.20-1.54 ms | 1.90-2.05 ms | 105-106 KiB |
| restart, all 1,000 | 20.0-20.2 ms | 35.8-40.8 ms | 57-58 KiB |

A swap costs about 36 µs per object (its staging record, the new attempt's activation, the hand-over of its old one),
a restart about 20 µs until the reload resolves (staging and the start of each fate; the new attempts activate after
the drains). The heap after reloads levels off (swap, 50 objects: 332 KiB after 20, 437 KiB after 80, 550 KiB after
300 reloads): compiled code and feedback of the new facets, not objects (the GC tests collect old attempts, removed
objects, providers and facets).

**Fix round 1**, CPU 6, alternating against HEAD. `calls.ts`, three runs: local call 2.80-2.82 → 2.66-2.68 µs
(6,894 → 6,757 B); watched derive commit 10.42-10.66 → 10.31-10.47 µs; activation churn 53.7-55.8 → 54.3-55.9 µs,
41,540-41,560 → 41,566-41,584 B (an `?? []` per end, found here, is gone: the round's first measurement allocated
41,698 B); retained per live object with one dependency 8,699-8,700 → 8,768 B. Links (a review measured binary
commit-to-frame +19% and small calls +6% on another CPU): `links.ts`, two runs, binary commit to frame
0.085/0.097-0.099/0.063-0.065 → 0.087/0.097/0.064 ms (append/change/removal), small call 0.038-0.039 → 0.035 ms. A
warmed ad-hoc probe (binary memory link, 2,000 calls and 1,000 commits per burst) measures no regression: call round
trip 9.8-10.2 → 9.9-10.1 µs, commit to frame 60.6-65.1 → 61.0-61.6 µs. Reload benchmark after the round: swap 50 /
1,000 objects 1.50 / 35.9 ms, restart 1.67 / 21.4 ms until the reload resolves (2.12 / 38.1 ms until all are live);
heap after 20 reloads 339 / 193 / 104 / 68 KiB.

**Fix round 2**, alternating against HEAD. Stock `links.ts` on CPU 22, six rounds each before and after the fix
(medians, binary / text): before, small call 0.062 → 0.068 / 0.058 → 0.064 ms (+10%), commit to frame within 1%
(append 0.156 → 0.156, changed field 0.165 → 0.162, removal 0.120 → 0.119 ms binary). Cut-down copies located it:
calls alone, or after the snapshot, commit and stream sections, or after the hold-memory trials alone, measured
equal; only the full sequence showed the gap, and a CPU profile of its calls section put the difference in the
remote call path (`Hold.call` with the attempt's call inlined, about 6.7 µs per call). The cause was `Attempt.call`
delegating the invocation to a helper method shared with the older-version path; one body for every version, and
no `async` (a local call allocated about 250 B more as an async function), fixed it. After: small call 0.063 →
0.065 / 0.058 → 0.058 ms, append 0.156 → 0.157, changed field 0.164 → 0.163, removal 0.119 → 0.120 ms, hold to live
(1,000 items) 1.037 → 1.023 ms. `calls.ts` on CPU 6: local call 2.89-2.92 → 2.77-2.85 µs (6,894 → 6,660 B), watched
derive commit 10.44-10.58 → 10.65-10.81 µs (15,309 → 14,969 B), activation churn 54.8-55.1 → 54.6-54.7 µs (41,560 →
41,592 B); retained per live object with one dependency 8,700 → 8,777 B. Reload benchmark: swap 50 / 1,000 objects
1.84 / 33.7 ms, restart 1.31 / 22.3 ms until the reload resolves (2.18 / 41.0 ms all live); heap after 20 reloads
323 / 200 / 104 / 70 KiB.

**Fix round 3: the commit-to-frame gap is V8's young generation, not frame work.** Astra (CPU 22, five pairs) measured
binary append commit-to-frame 132 → 161 µs, changed field 148 → 168, removal 112 → 121 on the stock `links.ts`.
- *Path length.* The HEAD copy `/home/badlogic/pi-hb` measured append 0.155 ms; Astra's `/tmp/s7b-hd-astra`, with
  identical sources, 0.129 ms. A copy of the same tree at a path of Astra's length (17 characters) measured 0.130 ms,
  at a longer one 0.155 ms: on the same code the result depends on the checkout path alone. Compare copies at paths of
  equal length.
- *Stock numbers, equal paths* (`/tmp/s7b-hd-astra` vs a fresh build copy `/tmp/s7b-xx-astra`, CPU 22, three
  alternating runs, means): append 0.128-0.129 → 0.155-0.156 ms binary, 0.106-0.107 → 0.116-0.117 text; changed field
  0.144-0.145 → 0.161-0.162 binary, 0.097-0.098 → 0.107-0.110 text; small call 0.061-0.063 → 0.065-0.066 binary,
  0.058-0.059 → 0.058-0.059 text.
- *Same work.* Heap allocated per commit is equal (191.9 vs 191.4 KB including the codec rows); so are the telemetry
  records per commit (5.012, the same names: two validations, two link checks, one encode).
- *The difference is scavenges.* In the timed append loop HEAD ran 5 scavenges costing 3.6 ms in total, the build 3
  costing 21 ms (changed field: 2 for 2.7 ms vs 1 for 10.9 ms). At the loop's start the young generation was 33.5 MB
  in HEAD and 67 MB in the build (134 MB by the changed-field loop): V8 grows it from the bytes surviving its
  collections, and the build crossed that threshold a few scavenges earlier. Over the whole run the GC work is equal
  (scavenge time 1,620 vs 1,605 ms, survived bytes 471 vs 480 MB, 285 vs 284 scavenges); where the expensive
  scavenges fall relative to the timed loops differs. Tracing the GC (`--trace-gc-nvp`) moves HEAD into the build's
  pattern by itself.
- *With the young generation pinned* the two are equal: means 0.139/0.139 ms (append), 0.145/0.144 (changed field),
  0.116/0.115 (removal), 0.065/0.064 (small call), HEAD/build; per-commit medians and p90s too (three runs, warmed
  script): append 0.085-0.086 / 0.085-0.086 ms median, 0.101 / 0.101-0.103 p90; changed field 0.073 / 0.072-0.073,
  0.083-0.084 / 0.083; removal 0.060-0.061 / 0.060-0.061, 0.073 / 0.072-0.073 (binary; text alike, within 1 µs).
- *The extra live heap is code.* Build minus HEAD after a full collection: +249 KB right after loading the modules
  (old space +229 KB, before any object), +290 KB after a snapshot section, +296 KB after 1,000 appends, +281 KB after
  1,000 edits, +345 KB after 70 hold trials (old space +259 KB, the rest bytecode and code as more paths compile). It
  does not grow with commits or holds beyond the retained-per-hold and per-object figures above.

So `links.ts` changed: each commit section runs 1,000 untimed commits first (`WARM_UP_COMMITS`; the removal section
starts with 1,000 more notes for them), and reports commit-to-frame as mean, median and p90 of the 1,000 timed commits.
The warm-up stays because the timed loop then runs nearer the young generation's steady size: the warmed medians
match the pinned ones (append 0.082 vs 0.085 ms, changed field 0.072 vs 0.073, removal 0.060 vs 0.060), and HEAD and
build agree in five of six sections, against two of six without it (run-to-run spread is about 1 µs either way). The
mean still carries the scavenges that fall in the loop. After the change, equal paths, CPU 22, three alternating runs,
HEAD → build (mean; median; p90, ms):

| Section | binary | text |
| --- | --- | --- |
| append | 0.106-0.108 → 0.142-0.144; 0.081-0.083 → 0.090-0.091; 0.093-0.096 → 0.125-0.127 | 0.095-0.119 → 0.121-0.125; 0.078-0.080 → 0.080-0.082; 0.090 → 0.094-0.095 |
| changed field | 0.084-0.087 → 0.098-0.099; 0.071-0.075 → 0.072-0.073; 0.081-0.084 → 0.081-0.082 | 0.086-0.090 → 0.099-0.101; 0.067-0.071 → 0.070-0.071; 0.079-0.082 → 0.082-0.084 |
| removal | 0.103-0.104 → 0.107-0.109; 0.060-0.061 → 0.060-0.061; 0.071-0.073 → 0.072-0.073 | 0.100-0.102 → 0.077-0.103; 0.058-0.060 → 0.059; 0.067-0.069 → 0.067-0.070 |
| small call | 0.052-0.058 → 0.053-0.054 | 0.054-0.065 → 0.059-0.069 |

The binary append differs unpinned (median +11%, p90 +31%) and is equal pinned: the young generation's size in that
section, not per-append work. To compare commit-to-frame across two copies, run both at paths of equal length, pinned
to one CPU, alternating, with the young generation pinned:

    taskset -c 22 node --min-semi-space-size=16 --max-semi-space-size=16 --conditions=source --expose-gc test/next/bench/links.ts

Fix round 3 hot paths, `/tmp/s7b-hd-astra` → a build copy at a path of equal length, CPU 22, three alternating runs
(`calls.ts`): local call 3.69-3.71 → 3.56-3.63 µs (6,894 → 6,660 B), watched derive commit 17.39-17.50 → 17.41-17.53
µs (15,310 → 14,967 B), activation churn 104.2-104.8 → 107.6-108.3 µs (+3%; 41,526 → 41,426 B); retained per live
object with one dependency 8,700 → 8,585 B (one table per version replaced the current version's separate member
map). Reload benchmark, same CPU: swap 50 / 1,000 objects 2.88 / 51.9 ms, restart 2.49 / 35.7 ms until the reload
resolves (3.22 / 65.7 ms all live); heap after 20 reloads 345 / 188 / 119 / 85 KiB.

Sol's independent runs (CPU 24, five pairs of the stock `links.ts`) show the same commit-to-frame gap (binary append
135 → 162 µs, changed field 145 → 168, text 109 → 119 and 100 → 108): the young-generation effect above. Sol's
isolated round trips (`sol-isolated-links.ts`, nine bursts each, no telemetry) measured a binary call at 44.83 → 47.20
µs (+5.3%) on the round-2 code. On this round's code, `/tmp/s7b-hd-astra` → a build copy at a path of equal length,
CPU 24, five alternating pairs, medians: binary call 47.23 → 45.74 µs (-3.2%; HEAD's samples are bimodal, 44.3 or
46.9-47.9), binary commit 92.68 → 93.28 (+0.6%), text call 39.02 → 39.76 (+1.9%), text commit 82.86 → 85.28 (+2.9%);
with the young generation pinned: binary call 45.45 → 43.85 (-3.5%), binary commit 92.73 → 93.06, text call 39.97 →
39.65, text commit 83.65 → 85.46 (+2.2%).

**Rework: references are the only indirection** (decision of the same name). `/tmp/s7b-hd-astra` (HEAD) → a build
copy at a path of equal length, CPU 22, three alternating runs. `calls.ts`: local call 3.72-4.03 → 3.62-3.77 µs
(6,894 → 6,660 B); watched derive commit 17.46-17.92 → 17.53-18.40 µs (15,310 → 14,900 B); activation churn
104.7-107.9 → 114.7-118.3 µs (+9.6%, accepted by the owner, 2026-10-29; 41,507-41,526 → 41,473-41,501 B). The churn's object derives over its dependency's
member: that derive now attaches through its own reference's member (one `ReferenceSource` made, bound and ended per
cycle) where HEAD shared the provider's one member source; the allocation is HEAD's, the time is the new node's (a
copy of round 6, before the rework, measured 55.2 µs against HEAD's 53.5-54.6 µs and the rework's 58.4 µs on CPU 6).
Retained per live object with one dependency (an ad-hoc probe, 2,000 objects, median of five): 6,924 → 6,738 B; a
first cut made a source for every member at the binding and allocated four sets per source (8,627 B): sources are made
on first use or when a reference that had values detaches, and a source's watch, subscriber and pass-through sets are
made by their first user. `links.ts` (warmed, mean / median / p90 in ms), binary: append 0.107-0.113 / 0.082-0.083 /
0.095-0.097 → 0.141-0.142 / 0.089-0.090 / 0.123-0.124 (the young-generation effect above), changed field 0.084-0.086 /
0.071-0.072 / 0.081-0.082 → 0.098-0.099 / 0.072-0.073 / 0.081-0.082, removal 0.102-0.108 / 0.060 / 0.071-0.073 →
0.107-0.109 / 0.060-0.061 / 0.072; with the young generation pinned, append 0.140-0.143 / 0.086 / 0.100-0.102 →
0.143-0.147 / 0.085-0.087 / 0.101-0.103, changed field 0.091-0.092 / 0.072-0.073 / 0.082-0.084 → 0.091-0.092 /
0.073-0.074 / 0.082-0.084, removal 0.108-0.111 / 0.061-0.062 / 0.072-0.075 → 0.108-0.110 / 0.060-0.062 / 0.072-0.076;
text alike within 3 µs. Small call 0.058-0.060 → 0.053-0.056 ms. Retained per hold (both ends): 175.4-176.0 →
176.4-177.0 KiB with one hold, 175.8 → 176.4 KiB with ten.

The 1 MiB call row (final review): one burst of 50 calls read 0.389 → 1.088 ms (binary, young generation pinned) in
one review run. Not per-call work: a probe with the row's setup and a collected heap before each of 20 bursts of 50
(CPU 22, three alternating pairs) measured, per call without the collector's pauses, 0.27-0.31 → 0.30-0.31 ms binary
and 0.31-0.36 → 0.33-0.36 ms text, heap 23,025 → 22,707 B binary and 23,964 → 23,650 B text. A burst's time is about
0.3 ms per call plus 0.2-0.27 ms per call when a full collection falls in it (the arguments fill memory outside the
heap); one burst of 50 sees one or none, in either tree. `links.ts` now collects the heap before each of 20 bursts and
reports the median and p90; three alternating pairs of the new row, stock, binary median / p90 0.386-0.455 /
0.409-0.473 → 0.279-0.357 / 0.306-0.394, text 0.344-0.395 / 0.510-0.566 → 0.363-0.500 / 0.522-0.621; pinned,
binary 0.689-0.910 / 0.738-1.050 → 0.695-0.882 / 0.829-0.992, text 0.415-0.896 / 0.958-1.049 → 0.534-0.864 /
1.042-1.175. The row still moves by run with the collector's phase; compare it across several runs, not one.
The small call, measured apart (ten bursts of 1,000 after 3,000 warm-up calls, three alternating pairs): stock, binary
29.5-30.6 → 27.6-27.9 µs and text 25.1-25.9 → 27.5-28.3 µs; with the young generation pinned, binary 29.7-30.7 →
30.3-30.7 µs and text 23.6-23.7 → 23.9-24.1 µs. The stock text gap is the young generation's sizing, as for commit to
frame above (pinned, the two match); the snapshot before the final review's fixes measures the same.

## Simplification audit (2026-10-30)

HEAD `4b535d57e` → the audit build (A1, A2, A5, A9-A12), copies at paths of equal length, CPU 6, alternating.
`calls.ts`, three runs: local call 2.70-2.73 → 2.69-2.73 µs (6,660 B both), watched derive commit 10.41-10.75 →
10.42-10.74 µs (14,899 B both), activation churn 59.0-60.9 → 59.1-61.4 µs (41,473-41,482 → 41,478 B). Retained per live
object with one dependency (10,000 kept) 6,745-6,754 → 6,745-6,752 B; a first cut of the declaration-ordered
dependency list (A11) kept it on live attempts, +225 B, and is now let go after the dependency check. `links.ts` with
the young generation pinned: commit to frame, hold to live and retained per hold equal within run spread (176.4 →
176.2-176.6 KiB per hold).

**Text-codec calls in isolation** (Sol's probe: a remote object over one memory link, 5,000 warm-up calls, ten bursts
of 1,000 small calls, then 200 warm-up and 30 bursts of 10 calls with a 1 MiB argument; binary first, then text; the
heap collected before each burst and the collections in it recorded: none in any burst), seven alternating pairs,
median of the pairs' medians:

| Case | stock | young generation pinned |
| --- | --- | --- |
| binary small | 26.53 → 26.37 µs | 25.72 → 25.90 µs |
| text small | 19.31 → 20.95 µs (+8.5%) | 19.11 → 19.93 µs (+4.3%) |
| binary 1 MiB | 985 → 993 µs | 539 → 412 µs (bimodal: 187-607 µs per run) |
| text 1 MiB | 958 → 963 µs | 273 → 284 µs (221-352 µs per run) |

Heap per call is the same (text small 15,171 → 15,160-15,202 B). The text small gap is not per-call work: the codec
alone (encode, decode and the message check of a call and a result message, 20,000 per burst) measures the same in both
trees (text call 1.55 µs and 52 B, result 1.52 µs and 171 B), deoptimizations and inlining decisions are the same, and
the gap follows the shape of the text decoder's `fromFields`, not what runs: the build with HEAD's `text.ts` matches HEAD
(19.0-19.2 µs), the one change in it that matters is the never-executed `T` (retry) case, and writing that case with an
object spread again (`...(f.length >= 2 ? { hops } : …)`) restores HEAD's 19.1 µs while other edits of the same size do
not. With text measured first the gap is 22.4-22.5 → 23.0-23.3 µs (+2-3%). V8 code generation, recorded as noise.

## Slice 7c: plugins (2026-10-30)

**The plugins component** (`test/next/bench/plugins.ts`, new): 20 plugins, one worker facet each (a store object over a
document, a derive, a method, a helper module and a copied contract; 80.9 KiB of scripts in all), Node 24.4.1. Medians
of seven runs; three runs pinned to CPU 8, one unpinned:

| Measurement | CPU 8 | unpinned (32 CPUs) |
| --- | --- | --- |
| cold build of the 20 worker facets (one esbuild build each, all at once) | 240.1-240.7 ms | 26.4 ms |
| rebuild of one facet after an edit | 13.1-13.3 ms | 11.0 ms |
| evaluation of one facet (`vm.Script`, its source map registered) | 0.16-0.27 ms | 0.09 ms |
| reload of one plugin on a host (evaluation and `host.reload`, a pure swap) | 0.44-0.45 ms | 0.44 ms |
| heap after 100 reloads of one plugin, against after a warm-up | +230-235 KiB | +229 KiB |

The heap does not grow per reload: 2,000, 4,000 and 8,000 reloads leave +897, +1,186 and +1,432 KiB (sublinear); the
same evaluations through plain `vm.Script` with V8's compilation cache off leave +420 KiB at 8,000 against +465 KiB
through `evaluateFacet` (V8's own per-script bookkeeping), and the kernel's reloads alone wander between +200 and
+600 KiB at any count. Old facets and their closures are collected (the GC test: 200 reloads, every facet but the last
two collected, the heap within 2 MiB of the warm-up).

Fix round 1 (inline source maps without `sourcesContent`: positions only), CPU 8: the 20 scripts take 53.4 KiB (80.9
KiB before); cold build 241.1 ms, rebuild 13.0 ms, evaluation 0.14 ms per facet, a reload 0.39 ms, heap after 100
reloads +238 KiB.

**Kernel hot paths** (per plugin at load and reload changes only staging), HEAD `18a155e2f` → build at paths of equal
length, CPU 6, three alternating runs. `calls.ts`: local call 2.69-2.71 → 2.71-2.75 µs (6,660 B both), watched
derive commit 10.34-10.36 → 10.43-10.49 µs (14,899 → 14,901 B), activation churn 58.93-59.58 → 59.44-59.73 µs
(41,452-41,470 → 41,470 B). `links.ts` binary commit to frame (median / p90): append 0.035-0.036 / 0.058-0.059 →
0.034-0.036 / 0.058-0.060 ms, changed field 0.027-0.028 / 0.031-0.033 → 0.027-0.028 / 0.031-0.033 ms, removal 0.022 /
0.026-0.028 → 0.022 / 0.026-0.027 ms; with the young generation pinned alike within 2 µs; text alike; small call
0.026-0.030 → 0.028-0.033 ms (pinned 0.030-0.035 → 0.030-0.032 ms); retained per hold equal (one binary hold 176.2 →
170.1 KiB). `reload.ts`: swap of 50 / 1,000 objects 1.44-1.73 / 30.83-32.71 → 1.52-1.53 / 30.55-33.25 ms, restart
1.01-1.05 / 15.54-16.87 → 0.95-0.99 / 15.90-16.02 ms until the reload resolves.
