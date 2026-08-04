# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental pi protocol.

Protocol version `1` uses binary messages with this wire layout:

1. A four-byte unsigned big-endian payload length.
2. One definite-length CBOR item containing the message.

The first client message is always `hello`, containing `PROTOCOL_VERSION`. Subsequent messages use correlated request/response envelopes and server event envelopes. Session and server snapshots are authoritative. Progress events are transient UI hints and must not be reduced into authoritative state. Transports complete authentication before protocol bytes are exchanged.

## Validated message API

`encodeClientMessage()` and `encodeServerMessage()` validate a message and return a complete framed `Uint8Array`. The incremental decoders accept arbitrary fragmentation or coalescing, so they work with streams, sockets, and custom byte transports.

```ts
import {
  PROTOCOL_VERSION,
  createServerMessageDecoder,
  encodeClientMessage,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = {
  type: "hello",
  version: PROTOCOL_VERSION,
};

transport.send(encodeClientMessage(hello));

const decoder = createServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) {
  handleServerMessage(message);
}
decoder.end(); // Call when the byte stream closes to detect truncation.
```

`ClientMessageDecoder` and `ServerMessageDecoder` are also available directly. Schema violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Validation errors do not retain rejected payloads.

`parseClientMessage()` and `parseServerMessage()` only validate already-decoded values. They do not parse JSON strings.

## Transport support

Every transport carries the same complete bytes: `[uint32-be CBOR length][CBOR payload]`. Transports may split or coalesce those bytes arbitrarily.

This package does not bundle a transport. Consumers provide a byte-stream transport that preserves byte order and reports stream closure. Custom transports must handle arbitrary frame fragmentation and coalescing.

All transports are untrusted. Configure matching frame limits and enforce access controls appropriate for the transport before exposing a connection to the protocol. Unix sockets can use filesystem permissions, while network transports can authenticate during connection establishment.

## Encoding and framing

`encodeCbor()` and `decodeCbor()` implement the protocol's strict RFC 8949 subset. `encodeFrame()` and `FrameDecoder` handle framing independently of schemas and CBOR.

The CBOR subset supports:

- `null` and booleans
- finite numbers, with integers restricted to JavaScript's safe range and non-integers encoded as float64
- UTF-8 strings
- `Uint8Array` byte strings
- definite-length arrays
- definite-length maps represented by objects with unique string keys

Undefined object properties are omitted. JSON-valued protocol fields reject CBOR byte strings and non-plain objects. Top-level undefined, undefined array entries, sparse arrays, non-finite or unsafe numbers, tags, indefinite-length items, malformed UTF-8, trailing data, excessive nesting, and oversized values are rejected.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. Options can configure these limits. A frame decoder validates the declared length before buffering payload bytes.

All schemas reject unknown object properties. The protocol is experimental and has no compatibility guarantees.
