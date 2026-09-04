# pi-protocol

Strict Rust implementation of Pi protocol version 8. Messages use validated routed envelopes, definite-length CBOR, and a four-byte big-endian frame length. Incremental decoders accept arbitrary fragmentation, enforce the 16 MiB default limit, and reject malformed or nonconforming messages.
