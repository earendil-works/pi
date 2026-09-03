# @earendil-works/pi-client

Transport-neutral client for the experimental Pi service protocol.

```ts
import { Client, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver bytes in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = await Client.connect({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const result = await client.request(
  { serverId: client.hello.serverId },
  { serviceId: "example.service", member: "read", args: [] },
);
```

The client verifies that the physical endpoint reports the expected logical `serverId`. Server-wide requests carry that ID, and every Session request carries the full live target `{ serverId, sessionId, attachmentId }`. The combined durable address prevents cross-server or cross-session misrouting; the server-generated attachment ID rejects delayed frames after switching or reattaching.

Typed server and Session APIs are provided by Chord service bindings owned by the application. `createClientServiceTransport()` adapts a lazily resolved server or Session route to a Chord transport; `request()` and `subscribeService()` remain its low-level primitives. The client uses Chord's service-control parsers and per-subscription state decoder; `pi-protocol` only validates the routed envelope and strict-JSON boundary. A service subscription returns a complete provider snapshot; the binding installs it and then calls `start()` to release updates buffered during hydration. `Client` applies ordered out-of-band attachment changes but deliberately does not construct typed service proxies or interpret application contracts.

Application observation APIs such as the coding agent's `Transcript` are ordinary Chord services. The client does not interpret their snapshots or updates.

On disconnect or disposal, pending requests reject locally, but accepted work may still complete remotely before the attachment is released. The client clears its live attachment route. It never reconnects or replays requests automatically. After disconnection, call `reconnect()`, attach through the application's management service again, and explicitly repeat only operations known to be safe.

The experimental local coordinator only provides a stable endpoint and relays traffic. Replaceable server processes own Session and worker lifecycle outside the public client protocol.

Call transport handlers as follows:

- `handlers.onData(chunk)` for inbound bytes;
- `handlers.onClose()` for an orderly terminal close;
- `handlers.onError(error)` for transport failures.

A transport factory creates a fresh authenticated connection for each attempt. Requests are correlated by ID, and server failures are exposed as `ServerError`.

## Unix-domain sockets

Node.js and Bun consumers can use the separate Unix transport:

```ts
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new Client({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});
await client.connect();
```

Unix discovery scans an explicit physical-route directory, derives each expected server ID from its filename, and verifies it through the existing handshake:

```ts
import { discoverUnixServers } from "@earendil-works/pi-client/unix";

const routes = await discoverUnixServers({ directory: "/run/user/1000/pi" });
// [{ serverId: "...", path: "/run/user/1000/pi/<serverId>.sock" }]
```

Malformed entries, non-sockets, stale or unresponsive endpoints, and server-ID mismatches are ignored. Discovery is read-only and probes at most 16 sockets concurrently. Unexpected filesystem and socket errors reject discovery. Pass `timeoutMs` to override the default probe timeout.

`ClientOptions.maxFrameLength` bounds protocol payloads. `maxPendingBytes` bounds queued Unix transport output. Configure matching limits on both peers.
