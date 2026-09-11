import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { parseServiceCall } from "@earendil-works/chord";
import { ClientMessageDecoder, encodeServerMessage, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "../src/index.ts";
import { createUnixTransportFactory } from "../src/unix.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const tempDirectories = new Set<string>();
const servers = new Set<Server>();
const sockets = new Set<Socket>();

async function makeSocketPath(): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "pi-client-transport-"));
	tempDirectories.add(directory);
	return join(directory, "pi.sock");
}

async function listen(server: Server, path: string): Promise<void> {
	servers.add(server);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		[...servers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

test("rejects invalid Unix transport options", () => {
	expect(() => createUnixTransportFactory({ path: "" })).toThrow(/must not be empty/);
	expect(() => createUnixTransportFactory({ path: "/tmp/pi.sock", maxPendingBytes: 0 })).toThrow(/positive/);
});

describe.runIf(process.platform !== "win32")("createUnixTransportFactory", () => {
	test("carries a complete Client handshake and request over a real Unix socket", async () => {
		const path = await makeSocketPath();
		const receivedMembers: string[] = [];
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						const frame = encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							serverId,
						});
						for (const byte of frame) socket.write(Uint8Array.of(byte));
						continue;
					}
					if (message.type === "cancel") continue;
					const call = parseServiceCall(message.call);
					receivedMembers.push(`${call.serviceId}.${call.member}`);
					const frame = encodeServerMessage({
						type: "response",
						id: message.id,
						ok: true,
						result: [],
					});
					const split = Math.floor(frame.byteLength / 2);
					socket.write(frame.subarray(0, split));
					socket.write(frame.subarray(split));
				}
			});
		});
		await listen(server, path);
		const client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path }) });

		try {
			await expect(client.connect()).resolves.toMatchObject({ serverId });
			await expect(
				client.request({ serverId }, { serviceId: "test.server", member: "list", args: [] }),
			).resolves.toEqual([]);
			expect(receivedMembers).toEqual(["test.server.list"]);
		} finally {
			await client.dispose();
		}
	});

	test("reports truncated final frames through Client", async () => {
		const path = await makeSocketPath();
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						socket.write(
							encodeServerMessage({
								type: "hello",
								version: PROTOCOL_VERSION,
								serverId,
							}),
						);
					} else {
						socket.end(new Uint8Array([0, 0, 0, 2, 1]));
					}
				}
			});
		});
		await listen(server, path);
		const client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path }) });

		try {
			await client.connect();
			await expect(
				client.request({ serverId }, { serviceId: "test.server", member: "list", args: [] }),
			).rejects.toMatchObject({
				name: "ProtocolValidationError",
				message: expect.stringMatching(/truncated/i),
			});
			expect(client.connectionState).toBe("disconnected");
		} finally {
			await client.dispose();
		}
	});

	test("rejects connection attempts to missing sockets", async () => {
		const path = await makeSocketPath();
		await expect(
			createUnixTransportFactory({ path })({
				onData: () => {},
				onClose: () => {},
				onError: () => {},
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
