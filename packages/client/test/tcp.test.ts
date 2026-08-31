import { createServer, type Server, type Socket } from "node:net";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { PiClient } from "../src/index.ts";
import { createTcpTransportFactory } from "../src/tcp.ts";

const serverSnapshot: ServerSnapshot = {
	serverId: "tcp-server",
	protocolVersion: PROTOCOL_VERSION,
	revision: 4,
	sessions: [],
	models: [],
};

async function listen(server: Server, port = 0): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	return typeof address === "object" && address !== null ? address.port : port;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("TCP transport", () => {
	test("rejects invalid TCP transport options", () => {
		expect(() => createTcpTransportFactory({ host: "", port: 1 })).toThrow(/must not be empty/);
		expect(() => createTcpTransportFactory({ host: "127.0.0.1", port: 0 })).toThrow(/between 1 and 65535/);
		expect(() => createTcpTransportFactory({ host: "127.0.0.1", port: 70000 })).toThrow(/between 1 and 65535/);
		expect(() => createTcpTransportFactory({ host: "127.0.0.1", port: 8080, maxPendingBytes: 0 })).toThrow(
			/positive/,
		);
	});

	test("PiClient exchanges fragmented framed messages over a real TCP socket", async () => {
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						const hello = encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "tcp-connection",
							snapshot: serverSnapshot,
						});
						for (const byte of hello) socket.write(new Uint8Array([byte]));
					} else {
						const response = encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: { command: "list", sessions: [] },
						});
						const split = Math.floor(response.byteLength / 2);
						socket.write(response.subarray(0, split));
						socket.write(response.subarray(split));
					}
				}
			});
		});
		const port = await listen(server);
		const client = new PiClient({
			transportFactory: createTcpTransportFactory({ host: "127.0.0.1", port }),
		});

		try {
			await expect(client.connect()).resolves.toEqual(serverSnapshot);
			await expect(Promise.all([client.listSessions(), client.listSessions()])).resolves.toEqual([[], []]);
		} finally {
			client.disconnect();
			await closeServer(server, sockets);
		}
	});

	test("PiClient rejects a truncated final frame from a real TCP socket", async () => {
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						socket.write(
							encodeServerMessage({
								type: "hello",
								version: PROTOCOL_VERSION,
								connectionId: "tcp-truncated",
								snapshot: serverSnapshot,
							}),
						);
					} else {
						socket.end(new Uint8Array([0, 0, 0, 2, 1]));
					}
				}
			});
		});
		const port = await listen(server);
		const client = new PiClient({
			transportFactory: createTcpTransportFactory({ host: "127.0.0.1", port }),
		});

		try {
			await client.connect();
			await expect(client.listSessions()).rejects.toMatchObject({ name: "ProtocolValidationError" });
			expect(client.connectionState).toBe("disconnected");
		} finally {
			client.disconnect();
			await closeServer(server, sockets);
		}
	});

	test("rejects connection errors to a closed port", async () => {
		const sockets = new Set<Socket>();
		const server = createServer((socket) => sockets.add(socket));
		const port = await listen(server);
		await closeServer(server, sockets);

		await expect(
			createTcpTransportFactory({ host: "127.0.0.1", port })({
				onData: () => {},
				onClose: () => {},
				onError: () => {},
			}),
		).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});
});
