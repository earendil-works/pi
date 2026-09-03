# @earendil-works/pi-protocol

Runtime-neutral routed envelopes, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `8` defines:

- a version handshake that identifies the logical `serverId`;
- explicit server and Session request targets;
- correlated requests and responses with opaque strict-JSON payloads;
- request cancellation, opaque subscription updates, and out-of-band attachment changes;
- non-empty opaque error codes and bounded transport messages.

A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. The combined route fences calls to one logical server, durable Session, and live presentation attachment. Management `attach()` and `detach()` return no routing identifiers; the server publishes the selected live route in an out-of-band `attachment` message. Disconnecting releases only that presentation's attachment after admitted calls settle.

Chord owns the payload semantics carried inside these envelopes: `{ serviceId, instance?, member, args }` calls, the `$chord.service` control vocabulary, service catalogues, subscription snapshots and updates, service error codes, and the independent Delta path codecs for replicated states. `pi-protocol` validates that each opaque payload is strict JSON but does not validate or export its Chord grammar. Clients and servers parse those values through `@earendil-works/chord` at the service adapter boundary.

Session-directory state, management results, transcripts, models, plugins, and all other application values remain opaque service data. The real `Session` and `AgentHarness` remain process-local. Server and Session calls route opaquely to their owning providers, where Chord and the application validate and invoke them.

Server and worker lifecycle is intentionally outside this public protocol. The experimental local coordinator is only an opaque message router; each replaceable server process owns the private lifecycle protocol.

Each wire frame consists of a four-byte unsigned big-endian payload length followed by one definite-length CBOR item. `encodeClientMessage()` and `encodeServerMessage()` validate and encode complete frames. `ClientMessageDecoder` and `ServerMessageDecoder` accept arbitrary stream fragmentation and coalescing.

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

All envelope schemas reject unknown object properties, and codecs recursively reject non-JSON opaque payloads, including non-finite numbers, byte arrays, `undefined`, prototypes, and cycles. Envelope violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Payload-specific adapters must perform their own semantic validation after decoding. Transports must preserve byte order. Peer authentication and authenticated service contexts are not implemented by the experimental transport.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. The protocol is experimental and has no compatibility guarantees.
