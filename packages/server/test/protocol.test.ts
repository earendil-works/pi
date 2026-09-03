import { encodeCbor, encodeClientMessage, encodeFrame, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { Server } from "../src/server.ts";
import { ProtocolTestClient, TestServerHost, type WireChannel } from "../src/testing/index.ts";

let server: Server | undefined;

function connect(): ProtocolTestClient {
	server = new Server(new TestServerHost(), { listeners: [], serverId: "00000000-0000-4000-8000-000000000001" });
	let handler: ByteConnectionHandler;
	let client: ProtocolTestClient;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClient(channel);
	handler = server.accept(connection);
	return client;
}

afterEach(async () => {
	await server?.close();
	server = undefined;
});

test("requires hello as the first message", async () => {
	const client = connect();
	await client.sendMessage({
		type: "request",
		id: "request-1",
		target: { serverId: "00000000-0000-4000-8000-000000000001" },
		call: { serviceId: "pi.session-directory", member: "list", args: [] },
	});
	await expect(client.next((message) => message.type === "hello_error")).resolves.toMatchObject({
		type: "hello_error",
		error: { code: "invalid_request" },
	});
	await client.waitForClose();
});

test("rejects unsupported protocol versions", async () => {
	const client = connect();
	await expect(client.hello(PROTOCOL_VERSION + 1)).resolves.toMatchObject({
		type: "hello_error",
		error: { code: "version" },
	});
	await client.waitForClose();
});

test("accepts fragmented hello and request frames", async () => {
	const client = connect();
	const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION });
	const helloResponse = client.next((message) => message.type === "hello");
	await client.sendFragmentedMessage({ type: "hello", version: PROTOCOL_VERSION }, Math.floor(hello.byteLength / 2));
	await expect(helloResponse).resolves.toMatchObject({
		type: "hello",
		serverId: "00000000-0000-4000-8000-000000000001",
	});

	const response = client.next((message) => message.type === "response");
	const request = {
		type: "request" as const,
		id: "request-1",
		target: { serverId: "00000000-0000-4000-8000-000000000001" },
		call: { serviceId: "pi.session-directory" as const, member: "list" as const, args: [] as [] },
	};
	const frame = encodeClientMessage(request);
	await client.sendFragmentedMessage(request, Math.floor(frame.byteLength / 2));
	await expect(response).resolves.toMatchObject({ ok: false, error: { code: "internal_error" } });
});

test.each([
	["malformed CBOR", encodeFrame(Uint8Array.of(0xff))],
	["schema-invalid CBOR", encodeFrame(encodeCbor({ type: "hello", version: 1, extra: true }))],
	["oversized frame", new Uint8Array([1, 0, 0, 1])],
] as const)("rejects hostile framed input: %s", async (_label, bytes) => {
	const client = connect();
	await client.sendBytes(bytes);
	await expect(client.next((message) => message.type === "hello_error")).resolves.toMatchObject({
		type: "hello_error",
		error: { code: "invalid_request" },
	});
	await client.waitForClose();
});

test("rejects a second hello after completing the handshake", async () => {
	const client = connect();
	await client.hello();
	await client.sendMessage({ type: "hello", version: PROTOCOL_VERSION });
	await expect(client.next((message) => message.type === "hello_error")).resolves.toMatchObject({
		type: "hello_error",
		error: { code: "invalid_request", message: expect.stringMatching(/first message/) },
	});
	await client.waitForClose();
});

test("processes a hello and request coalesced in one byte chunk", async () => {
	const client = connect();
	const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION });
	const request = encodeClientMessage({
		type: "request",
		id: "request-1",
		target: { serverId: "00000000-0000-4000-8000-000000000001" },
		call: { serviceId: "pi.session-directory", member: "list", args: [] },
	});
	const wire = new Uint8Array(hello.byteLength + request.byteLength);
	wire.set(hello);
	wire.set(request, hello.byteLength);

	await client.sendBytes(wire);
	await expect(client.next((message) => message.type === "hello")).resolves.toMatchObject({ type: "hello" });
	await expect(client.next((message) => message.type === "response")).resolves.toMatchObject({
		type: "response",
		id: "request-1",
		ok: false,
		error: { code: "internal_error" },
	});
});

test("reports a truncated final frame when the peer closes", async () => {
	const errors: Error[] = [];
	server = new Server(new TestServerHost(), {
		listeners: [],
		serverId: "00000000-0000-4000-8000-000000000001",
		onError: (error) => errors.push(error),
	});
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send() {},
		close() {
			closed = true;
		},
	};
	const handler: ByteConnectionHandler = server.accept(connection);
	handler.onData(new Uint8Array([0, 0, 0, 2, 1]));
	handler.onClose();

	expect(closed).toBe(false);
	expect(errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/truncated/i) })]);
});
