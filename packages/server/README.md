# pi-server

Async Rust server for Pi protocol version 8. It serves routed concurrent requests over Unix-domain sockets, validates server/session targets, propagates cancellation, and shuts down connection work cleanly through the `ServerHost` trait.
