# link

Links between hosts and the protocol on them (§3, §22, slices 3a 2b, 4a and 4b): one `Message` type checked after
every decode (skipped on trusted links), the codecs that turn it into bytes, opaque parts with their limits and
compression at the origin, the handshake, the heartbeat, in-order handling of messages waiting for an asynchronous
inflate, the IPC and WebSocket transports, values with raw byte segments, and errors on the wire.

## For apps (`index.ts`)

```ts
import { memoryLinkPair, textCodec } from "./index.ts";

const [up, down] = memoryLinkPair();
server.accept(up, { principal: { kind: "guest", session: "S1" } }, ctx);   // the entry point authenticated it
client.connect(down, { principal: { kind: "server" } }, ctx);             // both ends: binaryCodec by default
// For a readable wire while debugging: { principal, codec: textCodec } on both ends.

// A forked worker over IPC (the parent end; the child uses ipcLink(process)), trusted: no message schema check.
const child = fork("worker.ts", [], { serialization: "advanced" });
server.accept(ipcLink(child), { principal: { kind: "worker" }, trusted: true }, ctx);
// A browser tab over a WebSocket (`ws` on the server, the browser's WebSocket in the tab).
wss.on("connection", (ws, req) => server.accept(webSocketLink(ws), { principal: authenticate(req) }, ctx));
tab.connect(webSocketLink(new WebSocket(url)), { principal: { kind: "server" } }, ctx);
```

- `Link`: an ordered, bidirectional channel of `Uint8Array` messages: `send(message)` (a no-op once closed),
  `onMessage(listener)` (messages that arrived earlier are delivered to it first; not kept on a closed link),
  `close()` (both ends; undelivered messages are dropped), `onClose(listener)` (runs at once on a closed link).
  Adapters only move whole messages, in order, and close both ends.
- `memoryLinkPair()`: two ends in one process; each message arrives a microtask later (`queueMicrotask`), in order.
  Closing one end closes it at once and the other a microtask later.
- `ipcLink(port)`: over a Node IPC channel, a `ChildProcess` forked with `serialization: "advanced"` or `process` in
  the child (`IpcPort`, typed structurally: Chord imports nothing from Node). Each message is one `Uint8Array`; other
  messages on the channel (the app's own, such as a start message) are skipped, and messages that arrive before the
  link's listener is set are queued, so a child makes its link before awaiting its start message. `send` returning
  `false` is backpressure, not a failure; a thrown `send`, an error in its callback or `disconnect` closes the link once
  and removes its listeners.
- `webSocketLink(socket)`: over a WebSocket, the browser's or `ws`'s (`WebSocketLike`, typed structurally): binary
  frames, `binaryType = "arraybuffer"`; messages sent while it connects wait for `open`; a socket closing or closed
  already gives a closed link; `close`, `error` and a text frame close the link once. The transport's `maxPayload`
  is its hard cap (a larger frame closes the socket, code 1009); the limits per part are the host's (`host/`).
- `Compression` (`{ deflate(bytes), inflate(bytes, limit) }`, synchronous): what `createHost({ compression })` takes.
  `deflate` is raw deflate at level 1; `inflate` gives a tagged `Inflated`: `{ kind: "bytes", bytes }` (at most
  `limit` bytes; `Infinity`: none; 0 allowed), `{ kind: "too_large" }` when the output would be larger, `{ kind:
  "corrupt", error }` for data that is no raw deflate stream. Chord ships `nodeCompression`
  (zlib's `deflateRawSync`/`inflateRawSync` with `maxOutputLength`) in `src/next-node/compression.ts`, outside the
  portable code. `PartLimits` (`{ part?, decoded? }`, bytes) is what a link's `limits` take.
- `Codec { name, encode(message), decode(bytes) }`, chosen per link (`codec` in `accept`/`connect` and a route's
  `resolve` result, the same at both ends; no negotiation). Two links of one relay may use different codecs:
  - `binaryCodec` (the default): a kind byte (its high bit set when an `origin` follows as a varint), then the kind's
    fields: unsigned varints (ids, indexes, counts,
    lengths), length-prefixed UTF-8 strings, the incarnation as 16 and the fingerprint as 8 raw bytes, parts as
    length-prefixed bytes (decoded as views of the received message, never parsed), other JSON fields (a hold's
    address and principal, errors) as length-prefixed JSON; a hold's optional fields behind one flags byte; a payload
    marked as carrying bytes adds its segments (count, lengths, raw bytes); `failed`'s `retryIn` as one more than it
    (0: absent). A part's length prefix is its length doubled, plus one when the part is deflated. A hold's `chain`
    as a count and 16 raw bytes per instance id, its `limit` as a varint. No outer length.
  - `textCodec`, for debugging: one JSON tuple per message with a short kind tag and positional fields (`["R", hold]`,
    `["c", call, hold, method, args?]`, `["b", [[hold, variant, [[member, value]…], [[member, error]…]?]…]]`, `["s",
    [[hold, [[member, ops]…], [[member, error]…]?]…]]`, `["f", hold, "t" | "b", error, retryIn?]`, `["T", hold]` for
    `retry`, `["l", hold]` for `loading`, `["a"]` ack, `["C"]` closed, `["p"]` ping, `["P"]` pong, …; a message with an origin wrapped as
    `["@", origin, tuple]`); parts are
    spliced into the tuple as their JSON text and re-serialized at decode (one parse per part per hop, accepted for a
    debugging codec); a payload marked as carrying bytes ends with its segments' lengths, the segments following the
    tuple after a newline (JSON text has no raw one). Every part is tagged with its codec, so no JSON value is
    reserved: `[0, json]`, or `[1, base64]` for a part its origin deflated (the text codec itself never compresses);
    `["V", revocation]` is `revoke`.
  - `describeMessage(message)`: the text tuple form of any message, for logs and tests.
- `accept`, `connect` and a route's `resolve` take `trusted` (default `false`): a trusted link skips the `MESSAGE`
  schema check (framing, the codec's decode and the owners' checks still run). For links to the app's own processes;
  trust never grants a hold's principal fields (they are read only on a parent link, `remote/`).

## For Chord's layers (`internal.ts`)

- `Message` (`message.ts`): the protocol's one tagged union, from the TypeBox schema `MESSAGE`: `hello { protocol,
  incarnation, calls }` (`calls`: how many concurrent calls this side accepts per origin, its call window),
  `hold { hold, type, version, fingerprint, params, address?, principal?, incarnation? }` (`address`: `{ kind, params }`
  the caller's placement computed, it routes the hold; the provider places it by its params; absent for a type without placement; `principal` and `incarnation`: whom it acts for, read only
  on a parent link; `chain?`: the instance ids of the activations waiting for the hold, at most 32, read only on a
  trusted link; `limit?`: the decoded limit per part of the link a relay admitted it on, read only on a parent link), `release`, `call { call, hold, method, args?, segments? }`, `abort`, `bound { holds: [{ hold,
  variant, members: [{ member, value }], failed }] }` (one message may bind several holds: first bindings, re-holds),
  `state { holds: [{ hold, members: [{ member, ops }], failed }] }`, `ack {}` (one per applied `bound` or `state` of
  its origin), `closed { origin }` (a relay's downstream origin ended: its holds and calls go), `ping {}`, `pong {}`,
  `revoke { revocation }` (from the parent, applied with the child's own `revokedBy`; no origin), `failed { hold, cause,
  retryIn? }` (`retryIn`: the milliseconds left of the provider's backoff window, absent for a broken failure),
  `loading { hold }` (the hold's object, or a relay's upstream, starts over), `retry { hold }` (the consumer asks for an
  attempt now), `result { call, value?, segments? }`, `error`, `gone`. `error`, `gone` and a `failed` cause carry the
  wire error format (`WireError`: a ChordError's JSON, or a plugin's code and message). `args` absent is a method without arguments,
  `value` absent is `null`; `segments` present marks a payload with byte segments (its method's schema has a `bytes()`
  leaf, `Snapshot.bytes`). `member`, `method` and `variant` are indexes into the hold's bound version's names, each
  variant's sorted (`variantNames`, `variantOrder` in contracts). Every kind but `hello`, `revoke`, `ping` and `pong` may carry
  `origin` (an integer from 1; absent: the sender's own work): a relay's number for one of its downstream origins,
  keying holds, calls, windows and acks with the ids (`OriginMessage`; decision "Relay flow control per origin").
  `PROTOCOL_VERSION` is 1.
- `Part = string | Uint8Array | DeflatedPart` (`params`, `args`, `value`, `bound` member values, `state` member ops,
  `part.ts`): a value's JSON text at its origin (and after a text decode), its UTF-8 bytes once a binary codec
  received it, or those bytes deflated by an origin that compresses. A part is opaque on the way and opened and parsed
  only where it is owned, while its message is handled (a malformed part is still a protocol error that closes the
  link): the provider opens `params` and `args`, the consumer results, snapshots and ops. A relay forwards parts
  unparsed and still deflated; a message naming an unknown id is ignored before its parts are parsed (Q1).
- Parts and their limits (`part.ts`): `originPart(json, compression, ctx)` (a JSON part at its origin, deflated above
  16 KiB of UTF-8, `COMPRESS_ABOVE`, when the host compresses and only if it got smaller, else the bytes encoded for
  the attempt; counted `chord.link.deflates`),
  `oversized(part, limit)` (the `too_large/part` error of a part past a wire limit: one comparison),
  `openPart(part, limits, compression, ctx)` (the JSON its owner parses: the wire size checked, then the decoded size,
  a deflated part inflated within it; counted `chord.link.inflates`), `inflateAsync(part, limit, signal, ctx)` (the
  `DecompressionStream` fallback, counting output bytes and stopping past the limit; it leaves its tagged `Inflated`
  on the part for `openPart`; `signal`, the link's close, cancels it at once), `linkLimits(trusted, limits?)` (none on
  trusted links, 16 MiB on the wire and 64 MiB decoded otherwise). Sizes are UTF-8 bytes (a text part's counted
  without encoding it); byte segments are not parts and no part limit bounds them (the transport's cap does).
- `Channel`: a host's end of a link. It sends `hello { protocol, incarnation, calls }` first and queues its own messages
  until the peer's arrived. Every received message is decoded by the codec and, unless the link is trusted, checked
  with `checkMessage` (the compiled `MESSAGE` schema, counted in `chord.link.checks`); a first message that is no
  `hello` of this codec ("the first message is no binary message"), another protocol version, a second `hello`, a
  failed check, or a throw while its `ChannelHandler` handles a message, is a protocol error: reported
  (`protocol_error`), and the link closes. `peer` is the peer's incarnation, `peerCalls` its call window. A handler
  that returns a promise (a message waiting for an asynchronous inflate) holds every later message, `ping` included,
  until it settles; they are then handled in order, and dropped when the link closes meanwhile; a rejection is a
  protocol error.
- The heartbeat, in `Channel`: every received message stamps `lastReceived` (sends do not count); the host's one
  interval timer calls `tick(now, ping, close)` on every link: a link silent for `close` ms (30 s by default), the
  handshake included, closes; an open one silent for `ping` ms (15 s) sends one `ping`. A `ping` is answered with
  `pong` at once, never queued behind the window; neither reaches the handler. It detects a silent transport, not a
  peer that answers pings but withholds acks (the window and the pending cap bound that).
- Who checks what (layers 1-3 failing close the link):
  1. the codec's `decode`: lengths and varints fit, the bytes consumed exactly, a known kind and arity, strict UTF-8,
     each JSON value parses, segment references valid and only in payloads marked as carrying bytes;
  2. `checkMessage`: the envelope (kinds, ids and indexes, lists, error shapes), not the parts; skipped on a trusted
     link;
  3. the remote side (`remote/`): ids not reused while live (unknown ids ignored), indexes within the bound version,
     `bound` before `state`, at most N concurrent calls;
  4. owners, where a part is owned: `checkParams`, `checkArgs`, a route's address check, Delta's decoder and
     `applyImmutable` before adoption, `chordErrorFromJson`; snapshots and results are never validated.
- Parts (`values.ts`): `jsonPart(value)` (a value's JSON text), `payloadPart(value, bytes)` (a payload's JSON, with
  segments and `{"$bytes": i}` references when marked: an own key `$bytes` there fails `invalid/args`; elsewhere it is
  plain data), `parsePart(part)` and `parsePayload(part, segments)` (strict UTF-8 JSON; references read back as views
  of the message, no copy).
- Errors: `wireError(thrown)` is `{ kind: "chord", error }` for a ChordError, `{ kind: "plugin", code, message,
  details? }` for a PluginError, and `{ kind: "plugin", code: "internal", message }` for anything else; never a stack
  or a cause. `errorFromWire` rebuilds a ChordError (L1's envelope check; a malformed one throws, a protocol error) or
  a PluginError. Failure causes and `gone` carry ChordError JSON directly.
