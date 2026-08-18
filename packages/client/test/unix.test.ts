import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { PiClient } from "../src/index.ts";
import { createUnixTransportFactory } from "../src/unix.ts";

const serverSnapshot: ServerSnapshot = {
	serverId: "unix-server",
	protocolVersion: PROTOCOL_VERSION,
	revision: 4,
	sessions: [],
	models: [],
};

async function listen(server: Server, path: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

test("rejects invalid Unix transport options", () => {
	expect(() => createUnixTransportFactory({ path: "" })).toThrow(/must not be empty/);
	expect(() => createUnixTransportFactory({ path: `/tmp/${"x".repeat(512)}` })).toThrow(/too long/);
	expect(() => createUnixTransportFactory({ path: "/tmp/pi.sock", maxPendingBytes: 0 })).toThrow(/positive/);
});

describe.runIf(process.platform !== "win32")("Unix-domain sockets", () => {
	test("PiClient exchanges fragmented framed messages over a real Unix socket", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-"));
		const socketPath = join(directory, "pi.sock");
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
							connectionId: "unix-connection",
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
		await listen(server, socketPath);
		const client = new PiClient({
			transportFactory: createUnixTransportFactory({ path: socketPath }),
		});

		try {
			await expect(client.connect()).resolves.toEqual(serverSnapshot);
			await expect(Promise.all([client.listSessions(), client.listSessions()])).resolves.toEqual([[], []]);
		} finally {
			client.disconnect();
			await closeServer(server, sockets);
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("bounds pending writes, preserves order, and reports remote end once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-"));
		const socketPath = join(directory, "pi.sock");
		const sockets = new Set<Socket>();
		const first = new Uint8Array(2 * 1024 * 1024).fill(1);
		const second = new Uint8Array(2 * 1024 * 1024).fill(2);
		const expectedLength = first.byteLength + second.byteLength;
		let receivedLength = 0;
		let invalidOrder = false;
		let resolveReceived: (() => void) | undefined;
		const received = new Promise<void>((resolve) => {
			resolveReceived = resolve;
		});
		let resumeServer: (() => void) | undefined;
		let resolveServerReady: (() => void) | undefined;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.pause();
			resumeServer = () => socket.resume();
			resolveServerReady?.();
			socket.on("data", (chunk) => {
				for (let index = 0; index < chunk.byteLength; index++) {
					const expected = receivedLength + index < first.byteLength ? 1 : 2;
					if (chunk[index] !== expected) invalidOrder = true;
				}
				receivedLength += chunk.byteLength;
				if (receivedLength === expectedLength) {
					socket.end(new Uint8Array([9]));
					resolveReceived?.();
				}
			});
		});
		await listen(server, socketPath);
		const inbound: number[] = [];
		const errors: Error[] = [];
		let closeCount = 0;
		let resolveClosed: (() => void) | undefined;
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		const transport = await createUnixTransportFactory({ path: socketPath, maxPendingBytes: expectedLength })({
			onData: (chunk) => inbound.push(...chunk),
			onClose: () => {
				closeCount += 1;
				resolveClosed?.();
			},
			onError: (error) => errors.push(error),
		});

		try {
			await serverReady;
			const firstWrite = transport.send(first);
			const secondWrite = transport.send(second);
			await expect(transport.send(Uint8Array.of(3))).rejects.toThrow(/pending byte limit/);
			resumeServer?.();
			await Promise.all([firstWrite, secondWrite, received, closed]);
			expect(receivedLength).toBe(expectedLength);
			expect(invalidOrder).toBe(false);
			expect(inbound).toEqual([9]);
			expect(errors).toEqual([]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closeCount).toBe(1);
		} finally {
			transport.close();
			await closeServer(server, sockets);
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("PiClient rejects a truncated final frame from a real Unix socket", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-"));
		const socketPath = join(directory, "pi.sock");
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
								connectionId: "unix-truncated",
								snapshot: serverSnapshot,
							}),
						);
					} else {
						socket.end(new Uint8Array([0, 0, 0, 2, 1]));
					}
				}
			});
		});
		await listen(server, socketPath);
		const client = new PiClient({
			transportFactory: createUnixTransportFactory({ path: socketPath }),
		});

		try {
			await client.connect();
			await expect(client.listSessions()).rejects.toMatchObject({ name: "ProtocolValidationError" });
			expect(client.connectionState).toBe("disconnected");
		} finally {
			client.disconnect();
			await closeServer(server, sockets);
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects connection errors", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-"));
		const missingPath = join(directory, "missing.sock");
		try {
			await expect(
				createUnixTransportFactory({ path: missingPath })({
					onData: () => {},
					onClose: () => {},
					onError: () => {},
				}),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
