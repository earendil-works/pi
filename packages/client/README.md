# @earendil-works/pi-client

Transport-neutral client for remote pi sessions. `PiClient` exchanges length-prefixed CBOR messages through a small `ByteTransport` interface. The package has no Node-specific imports.

```ts
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver chunks in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = new PiClient({ transportFactory });
await client.connect();
const session = await client.createSession({ cwd: "/workspace" });
const unsubscribe = session.subscribe((snapshot) => render(snapshot));
await session.prompt("Inspect this project");
unsubscribe();
```

Call `handlers.onData(chunk)` for inbound bytes, `handlers.onClose()` for an orderly terminal close, and `handlers.onError(error)` for transport failures. A factory must create a fresh transport for every connection attempt and complete any transport-specific authentication before resolving. For example, a WebSocket factory can provide credentials in its upgrade request.

`PiClient` does not reconnect automatically. Call `reconnect()` after disconnection. One connection can attach several sessions. Requests are correlated by ID. Server snapshots and successful response snapshots are authoritative, while progress events do not mutate snapshot state optimistically. Read cached session metadata from `client.snapshot?.sessions`; call `listSessions()` to request refreshed durable metadata from the server. Runtime state is available after acquiring a session.

`acquireSession()` returns an independent `SessionLease`; leases cannot be constructed directly. Use `{ mode: "exclusive" }` for a lifecycle or mutation coordinator and `{ mode: "shared" }` when multiple low-level consumers intentionally share the session. Exclusive acquisition fails with `PiSessionOwnershipError` while any lease exists, and shared acquisition fails while an exclusive lease exists. `attachSession()` is a shared-acquisition convenience method. `createSession()` returns an exclusive lease for the newly created session.

Calling `dispose()` or `detach()` releases only that lease. A lease rejects commands as soon as release begins. The client sends the protocol detach request after the final lease is released. If explicit `detach()` fails, the lease becomes active again for retry. If cleanup-oriented `dispose()` fails, it reports the protocol error but relinquishes local ownership; `PiClient` reconciles the failed protocol cleanup before the next acquisition. A released lease becomes unavailable without affecting other shared leases. Server removal or disconnection invalidates every lease for the affected attachment, and disposing an invalidated lease is a no-op. Commands fail with `PiDisconnectedError` while the client is disconnected and `PiSessionDetachedError` when the client is connected but a lease is releasing, released, or invalidated. Leases implement `AsyncDisposable`.

`subscribe()` observes authoritative snapshots. `onEvent()` observes protocol events. Both return an unsubscribe function. Structured errors returned by the server are exposed as `PiServerError`.

## Limits and security

`PiClientOptions.maxFrameLength` bounds inbound and outbound CBOR payloads. Configure matching limits on the client and server. Transports should separately bound queued outbound bytes and preserve send order.

Treat peers as untrusted. Use a secure transport with appropriate access controls and authenticate during transport establishment.

Subscriber exceptions are isolated from protocol state. Set `onListenerError` in `PiClientOptions` to report them to application logging or diagnostics.

## Unix-domain sockets

Node.js and Bun consumers can use the separately exported Unix-domain socket transport:

```ts
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new PiClient({
  transportFactory: createUnixTransportFactory({
    path: "/tmp/pi.sock",
  }),
});

await client.connect();
```

`maxPendingBytes` bounds queued outbound data. It defaults to four times the protocol frame limit. The transport preserves send order and waits for socket backpressure before resolving each send.

The `@earendil-works/pi-client` root remains transport- and runtime-neutral. Importing the Node-compatible transport requires the explicit `@earendil-works/pi-client/unix` subpath.
