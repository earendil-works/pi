import {
	type ClientMessage,
	encodeCbor,
	encodeFrame,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { type ByteTransportFactory, PiClient, PiDisconnectedError } from "../src/index.ts";
import {
	attachSession,
	baseServerSnapshot,
	connectClient,
	createClient,
	MemoryByteServer,
	sessionSnapshot,
} from "./support.ts";

describe("PiClient", () => {
	test("sends a framed version before accepting a fragmented server hello", async () => {
		const server = new MemoryByteServer();
		const received: ClientMessage[] = [];
		server.onMessage((message) => {
			received.push(message);
			if (message.type === "hello") {
				server.send(
					{
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: "connection-1",
						snapshot: baseServerSnapshot,
					},
					3,
				);
			}
		});
		const client = createClient(server);

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(received[0]).toEqual({ type: "hello", version: PROTOCOL_VERSION });
		expect(client.connectionState).toBe("connected");
	});

	test("rejects server data delivered before sending the client hello", async () => {
		let closeCount = 0;
		let sendCount = 0;
		const client = new PiClient({
			transportFactory: (handlers) => {
				handlers.onData(
					encodeServerMessage({
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: "connection-1",
						snapshot: baseServerSnapshot,
					}),
				);
				return {
					async send() {
						sendCount++;
					},
					close() {
						closeCount++;
					},
				};
			},
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: "Received server data before the client hello was sent",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(sendCount).toBe(0);
		expect(closeCount).toBe(1);
	});

	test("isolates subscriber failures from handshake and transport state", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = createClient(server);
		client.subscribe(() => {
			throw new Error("consumer failure");
		});

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(client.connectionState).toBe("connected");
	});

	test("reports subscriber failures without changing connection state", async () => {
		const server = new MemoryByteServer();
		const listenerErrors: Error[] = [];
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = new PiClient({
			transportFactory: (handlers) => server.connect(handlers),
			onListenerError: (error) => listenerErrors.push(error),
		});
		client.subscribe(() => {
			throw new Error("consumer failure");
		});

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(listenerErrors).toEqual([expect.objectContaining({ message: "consumer failure" })]);
		expect(client.connectionState).toBe("connected");
	});

	test("does not restore a connection after a snapshot listener disconnects during handshake", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type !== "hello") return;
			server.send({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "connection-1",
				snapshot: baseServerSnapshot,
			});
		});
		const client = createClient(server);
		client.subscribe(() => client.disconnect());

		await expect(client.connect()).rejects.toBeInstanceOf(PiDisconnectedError);
		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});

	test("does not restore a stale connection when a snapshot listener reconnects during handshake", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type !== "hello") return;
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: `connection-${connection}`,
					snapshot: { ...baseServerSnapshot, revision: connection },
				});
			});
		}
		const client = new PiClient({
			transportFactory: (handlers) => (connection++ === 0 ? first : second).connect(handlers),
		});
		let reconnect: Promise<ServerSnapshot> | undefined;
		let reconnectRequested = false;
		client.subscribe(() => {
			if (reconnectRequested) return;
			reconnectRequested = true;
			client.disconnect();
			reconnect = client.reconnect();
		});

		await expect(client.connect()).rejects.toBeInstanceOf(PiDisconnectedError);
		expect(reconnect).toBeDefined();
		await expect(reconnect).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
		expect(first.clientCloseCount).toBe(1);
	});

	test("rejects a typed handshake version error", async () => {
		const server = new MemoryByteServer();
		server.onMessage(() => {
			server.send({
				type: "hello_error",
				error: { code: "version", message: "Unsupported protocol version" },
			});
		});
		const client = createClient(server);

		await expect(client.connect()).rejects.toMatchObject({
			name: "PiServerError",
			code: "version",
			message: "Unsupported protocol version",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});

	test("rejects pending requests on close and reconnects through a fresh factory result", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type === "hello") {
					server.send({
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: `connection-${connection}`,
						snapshot: { ...baseServerSnapshot, revision: connection },
					});
				}
			});
		}
		const transportFactory: ByteTransportFactory = (handlers) =>
			(connection++ === 0 ? first : second).connect(handlers);
		const client = new PiClient({ transportFactory });
		const states: string[] = [];
		client.onConnectionStateChange(({ state }) => states.push(state));
		await client.connect();
		const pending = client.listSessions();
		first.close();
		await expect(pending).rejects.toBeInstanceOf(PiDisconnectedError);
		expect(client.connectionState).toBe("disconnected");

		await expect(client.reconnect()).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
	});

	test("supports synchronous reconnect from a disconnection listener", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type !== "hello") return;
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: `connection-${connection}`,
					snapshot: { ...baseServerSnapshot, revision: connection },
				});
			});
		}
		const client = new PiClient({
			transportFactory: (handlers) => (connection++ === 0 ? first : second).connect(handlers),
		});
		await client.connect();
		let reconnect: Promise<ServerSnapshot> | undefined;
		client.onConnectionStateChange(({ state }) => {
			if (state === "disconnected") reconnect = client.reconnect();
		});

		first.close();
		expect(reconnect).toBeDefined();
		await expect(reconnect).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
	});

	test("rejects pending requests on transport errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		server.error(new Error("read failed"));

		await expect(pending).rejects.toMatchObject({ name: "PiDisconnectedError", message: "read failed" });
		expect(client.connectionState).toBe("disconnected");
	});

	test("enforces the configured frame limit for outbound and inbound messages", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = new PiClient({
			maxFrameLength: 512,
			transportFactory: (handlers) => server.connect(handlers),
		});
		await client.connect();
		const handle = await attachSession(client, server, sessionSnapshot("session-1"));
		const sentBefore = server.sentByClient.length;
		await expect(handle.prompt("x".repeat(1_000))).rejects.toBeInstanceOf(ProtocolValidationError);
		expect(server.sentByClient).toHaveLength(sentBefore);

		server.sendRaw(new Uint8Array([0, 0, 2, 1]));
		expect(client.connectionState).toBe("disconnected");
	});

	test("disconnects on invalid protocol data", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.sendRaw(encodeFrame(encodeCbor({ type: "event", event: { type: "session_removed", sessionId: 1 } })));
		expect(client.connectionState).toBe("disconnected");
	});

	test("reports truncated framing when the transport closes", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		server.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
		server.close();

		await expect(pending).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: expect.stringMatching(/truncated/i),
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test("rejects frame limits outside the unsigned 32-bit range", () => {
		const server = new MemoryByteServer();
		expect(
			() =>
				new PiClient({
					maxFrameLength: 0x1_0000_0000,
					transportFactory: (handlers) => server.connect(handlers),
				}),
		).toThrow(/maxFrameLength/);
	});
});
