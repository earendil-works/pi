import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	encodeCbor,
	encodeFrame,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import {
	type ByteTransportFactory,
	Client,
	ClientDisposedError,
	createClientServiceTransport,
	DisconnectedError,
} from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const serverTarget = { serverId } as const;

async function connectClient(server: MemoryByteServer, expectedServerId = serverId): Promise<Client> {
	return Client.connect({ serverId: expectedServerId, transportFactory: (handlers) => server.connect(handlers) });
}

async function attachClient(client: Client, server: MemoryByteServer, sessionId: string): Promise<void> {
	const expectedMessages = server.messages.length + 1;
	const attaching = client.request(serverTarget, {
		serviceId: "pi.session-management",
		member: "attach",
		args: [sessionId],
	});
	await server.waitForMessages(expectedMessages);
	const request = server.messages.at(-1);
	if (request?.type !== "request") throw new Error("Missing attach request");
	server.send({
		type: "attachment",
		attachment: { serverId, sessionId, attachmentId: `attachment-${sessionId}` },
	});
	server.send({ type: "response", id: request.id, ok: true, result: null });
	await attaching;
}

test("requires a canonical UUIDv4 server identity", () => {
	expect(() => new Client({ serverId: "invalid-server", transportFactory: () => Promise.reject() })).toThrow(
		/serverId/,
	);
});

describe("Client service operations", () => {
	test("connects only to the expected logical server", async () => {
		const matching = new MemoryByteServer();
		const client = await connectClient(matching);
		expect(client.hello).toMatchObject({ serverId });
		await client.dispose();

		const wrong = new MemoryByteServer("00000000-0000-4000-8000-000000000002");
		await expect(connectClient(wrong)).rejects.toBeInstanceOf(ProtocolValidationError);
	});

	test("updates attachment state from out-of-band server routing", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const changes: Array<string | undefined> = [];
		client.onAttachmentChange((attachment) => changes.push(attachment?.sessionId));

		await attachClient(client, server, "session-1");
		expect(client.attachment).toMatchObject({ sessionId: "session-1", attachmentId: "attachment-session-1" });
		expect(server.messages[1]).toMatchObject({
			type: "request",
			target: serverTarget,
			call: { serviceId: "pi.session-management", member: "attach", args: ["session-1"] },
		});

		server.send({ type: "attachment", attachment: null });
		expect(client.attachment).toBeUndefined();
		expect(changes).toEqual(["session-1", undefined]);
		await client.dispose();
	});

	test("buffers service updates until the subscription snapshot arrives", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		await attachClient(client, server, "session-1");
		const target = client.attachment!;
		const transport = createClientServiceTransport(client, () => client.attachment);
		const updates: Array<{ readonly type: string; readonly ops?: readonly unknown[] }> = [];
		const opening = transport.subscribe(
			"pi.models",
			"singleton",
			(update) => {
				updates.push(update);
			},
			BACKGROUND_CONTEXT,
		);
		await server.waitForMessages(3);
		expect(server.messages[2]).toMatchObject({
			type: "request",
			target,
			call: {
				serviceId: "$chord.service",
				member: "subscribe",
				args: ["service-1", "pi.models", "singleton"],
			},
		});
		server.send({
			type: "service_update",
			subscriptionId: "service-1",
			update: { type: "state", member: "state", sequence: 1, ops: [["s", ["revision"], 1]] },
		});
		await Promise.resolve();
		expect(updates).toEqual([]);
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: {
				serviceId: "pi.models",
				mode: "singleton",
				instances: [{ members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] }] }],
			},
		});
		const subscription = await opening;
		expect(updates).toEqual([]);
		server.send({
			type: "service_update",
			subscriptionId: "closed-subscription",
			update: { type: "state", member: "state", sequence: 99, ops: [["s", 99, 99]] },
		});
		await Promise.resolve();
		expect(client.connected).toBe(true);
		expect(subscription.snapshot.instances[0]?.members).toEqual([
			{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] },
		]);
		subscription.activate();
		await vi.waitFor(() => expect(updates.map(({ type }) => type)).toEqual(["state"]));
		server.send({
			type: "service_update",
			subscriptionId: "service-1",
			update: { type: "state", member: "state", sequence: 2, ops: [["s", ["revision"], 2]] },
		});
		server.send({
			type: "service_update",
			subscriptionId: "service-1",
			update: {
				type: "state",
				member: "state",
				sequence: 3,
				ops: [
					["#", 0, ["revision"]],
					["s", 0, 3],
				],
			},
		});
		await vi.waitFor(() => expect(updates).toHaveLength(3));
		expect(updates[2]?.ops).toEqual([["s", ["revision"], 3]]);

		const disposing = subscription.close(BACKGROUND_CONTEXT);
		await server.waitForMessages(4);
		expect(server.messages[3]).toMatchObject({
			call: { serviceId: "$chord.service", member: "unsubscribe", args: ["service-1"] },
		});
		server.send({ type: "response", id: "request-3", ok: true });
		await disposing;
		await client.dispose();
	});

	test("correlates out-of-order generic service responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const first = client.request(serverTarget, { serviceId: "test", member: "first", args: [] });
		const second = client.request(serverTarget, { serviceId: "test", member: "second", args: [] });
		await server.waitForMessages(3);
		server.send({ type: "response", id: "request-2", ok: true, result: "second" });
		server.send({ type: "response", id: "request-1", ok: true, result: "first" });
		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
		await client.dispose();
	});

	test("exposes bounded server errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.request(serverTarget, { serviceId: "test", member: "missing", args: [] });
		await server.waitForMessages(2);
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "session_not_found", message: "Unknown session" },
		});
		await expect(pending).rejects.toMatchObject({ code: "session_not_found" });
		await client.dispose();
	});

	test("does not send a pre-aborted untyped RPC request", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);

		await expect(
			client.request(serverTarget, { serviceId: "test", member: "noop", args: [] }, controller.signal),
		).rejects.toBe(reason);
		expect(server.messages).toHaveLength(1);
		await client.dispose();
	});

	test("cancels one untyped RPC request without disconnecting", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const reason = new Error("stop this request");
		const pending = client.request(
			serverTarget,
			{ serviceId: "test", member: "mutate", args: [{ value: 42 }] },
			controller.signal,
		);
		await server.waitForMessages(2);
		expect(server.messages[1]).toMatchObject({
			type: "request",
			id: "request-1",
			target: serverTarget,
			call: { serviceId: "test", member: "mutate", args: [{ value: 42 }] },
		});

		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		await server.waitForMessages(3);
		expect(server.messages[2]).toEqual({ type: "cancel", id: "request-1", target: serverTarget });
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "cancelled", message: "cancelled" },
		});
		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("rejects pending requests after disconnect or disposal", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
		server.disconnect();
		await expect(pending).rejects.toBeInstanceOf(DisconnectedError);
		await client.dispose();
		await expect(
			client.request(serverTarget, { serviceId: "test", member: "disposed", args: [] }),
		).rejects.toBeInstanceOf(ClientDisposedError);
	});
});

describe("Client connection lifecycle", () => {
	test("rejects server data delivered before the client hello is sent", async () => {
		let closeCount = 0;
		let sendCount = 0;
		const client = new Client({
			serverId,
			transportFactory: (handlers) => {
				handlers.onData(encodeServerMessage({ type: "hello", version: PROTOCOL_VERSION, serverId }));
				return {
					async send() {
						sendCount += 1;
					},
					close() {
						closeCount += 1;
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

	test("rejects typed handshake errors and closes the transport", async () => {
		let handlers: Parameters<ByteTransportFactory>[0];
		let closeCount = 0;
		const client = new Client({
			serverId,
			transportFactory: (createdHandlers) => {
				handlers = createdHandlers;
				return {
					async send() {
						handlers.onData(
							encodeServerMessage({
								type: "hello_error",
								error: { code: "version", message: "Unsupported protocol version" },
							}),
						);
					},
					close() {
						closeCount += 1;
					},
				};
			},
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "ServerError",
			code: "version",
			message: "Unsupported protocol version",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(closeCount).toBe(1);
	});

	test("rejects pending requests and reconnects through a fresh transport", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		const transportFactory: ByteTransportFactory = (handlers) =>
			(connection++ === 0 ? first : second).connect(handlers);
		const client = new Client({ serverId, transportFactory });
		const states: string[] = [];
		client.onConnectionStateChange(({ state }) => states.push(state));
		await client.connect();
		await attachClient(client, first, "session-1");
		const target = client.attachment;
		if (target === undefined) throw new Error("Missing attachment");
		const pending = client.request(target, { serviceId: "test.session", member: "run", args: [] });
		await first.waitForMessages(3);
		expect(first.messages[2]).toMatchObject({ call: { serviceId: "test.session", member: "run" } });
		first.disconnect();

		await expect(pending).rejects.toBeInstanceOf(DisconnectedError);
		await expect(client.reconnect()).resolves.toMatchObject({ serverId });
		expect(connection).toBe(2);
		expect(client.connected).toBe(true);
		expect(second.messages).toHaveLength(1);
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
		await client.dispose();
	});

	test("reports transport failures without leaving requests pending", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
		await server.waitForMessages(2);
		server.error(new Error("read failed"));

		await expect(pending).rejects.toMatchObject({
			name: "DisconnectedError",
			message: "read failed",
			cause: expect.objectContaining({ message: "read failed" }),
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test("disconnects on invalid or truncated server framing", async () => {
		const invalidServer = new MemoryByteServer();
		const invalidClient = await connectClient(invalidServer);
		invalidServer.sendRaw(encodeFrame(encodeCbor({ type: "response", id: "unknown", ok: true, result: 1 })));
		expect(invalidClient.connectionState).toBe("disconnected");

		const truncatedServer = new MemoryByteServer();
		const truncatedClient = await connectClient(truncatedServer);
		const pending = truncatedClient.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
		await truncatedServer.waitForMessages(2);
		truncatedServer.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
		truncatedServer.disconnect();

		await expect(pending).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: expect.stringMatching(/truncated/i),
		});
		expect(truncatedClient.connectionState).toBe("disconnected");
	});

	test("disconnects when a response has no matching request", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({ type: "response", id: "unknown-request", ok: true, result: [] });

		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});
});
