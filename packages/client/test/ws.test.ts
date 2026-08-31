import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { PiClient } from "../src/index.ts";
import { createWebSocketTransportFactory } from "../src/ws.ts";

const serverSnapshot: ServerSnapshot = {
	serverId: "ws-server",
	protocolVersion: PROTOCOL_VERSION,
	revision: 4,
	sessions: [],
	models: [],
};

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Frame {
	opcode: number;
	payload: Uint8Array;
}

/** Minimal unmasked server-to-client frame encoder for tests. */
function encodeFrame(payload: Uint8Array, opcode: number): Uint8Array {
	let headerLength: number;
	if (payload.byteLength < 126) {
		headerLength = 2;
	} else if (payload.byteLength <= 0xffff) {
		headerLength = 4;
	} else {
		headerLength = 10;
	}
	const frame = new Uint8Array(headerLength + payload.byteLength);
	frame[0] = 0x80 | opcode;
	if (headerLength === 2) {
		frame[1] = payload.byteLength;
	} else if (headerLength === 4) {
		frame[1] = 126;
		frame[2] = payload.byteLength >>> 8;
		frame[3] = payload.byteLength;
	} else {
		frame[1] = 127;
		let value = payload.byteLength;
		for (let index = 9; index >= 2; index--) {
			frame[index] = value & 0xff;
			value = Math.floor(value / 256);
		}
	}
	frame.set(payload, headerLength);
	return frame;
}

/** Minimal masked client-frame decoder for tests (handles single-frame messages). */
function decodeClientFrames(chunk: Uint8Array): Frame[] {
	const frames: Frame[] = [];
	let offset = 0;
	while (offset + 2 <= chunk.byteLength) {
		const first = chunk[offset]!;
		const second = chunk[offset + 1]!;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			length = (chunk[offset + 2]! << 8) | chunk[offset + 3]!;
			headerLength = 4;
		} else if (length === 127) {
			let value = 0;
			for (let index = 0; index < 8; index++) value = value * 256 + chunk[offset + 2 + index]!;
			length = value;
			headerLength = 10;
		}
		if (masked) headerLength += 4;
		const payloadStart = offset + headerLength;
		if (payloadStart + length > chunk.byteLength) break;
		let payload = chunk.subarray(payloadStart, payloadStart + length);
		if (masked) {
			const key = chunk.subarray(payloadStart - 4, payloadStart);
			const unmasked = new Uint8Array(length);
			for (let index = 0; index < length; index++) unmasked[index] = payload[index]! ^ key[index % 4]!;
			payload = unmasked;
		}
		frames.push({ opcode, payload });
		offset = payloadStart + length;
	}
	return frames;
}

async function listen(server: HttpServer, port = 0): Promise<number> {
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

async function closeServer(server: HttpServer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("WebSocket transport", () => {
	test("rejects invalid WebSocket transport options", () => {
		expect(() => createWebSocketTransportFactory({ url: "" })).toThrow(/must not be empty/);
		expect(() => createWebSocketTransportFactory({ url: "not a url" })).toThrow(/invalid/);
		expect(() => createWebSocketTransportFactory({ url: "http://example.com" })).toThrow(/ws:/);
		expect(() => createWebSocketTransportFactory({ url: "ws://example.com", maxPendingBytes: 0 })).toThrow(
			/positive/,
		);
	});

	test("PiClient exchanges framed messages over a real WebSocket", async () => {
		const server = createHttpServer(() => {});
		server.on("upgrade", (request, socket) => {
			const key = request.headers["sec-websocket-key"];
			const accept = createHash("sha1")
				.update(key + WEBSOCKET_GUID)
				.digest("base64");
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decodeClientFrames(
					new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
				)) {
					for (const decoded of decoder.push(message.payload)) {
						if (decoded.type === "hello") {
							const hello = encodeFrame(
								encodeServerMessage({
									type: "hello",
									version: PROTOCOL_VERSION,
									connectionId: "ws-connection",
									snapshot: serverSnapshot,
								}),
								0x2,
							);
							socket.write(hello);
						} else {
							const response = encodeFrame(
								encodeServerMessage({
									type: "response",
									id: decoded.id,
									ok: true,
									result: { command: "list", sessions: [] },
								}),
								0x2,
							);
							socket.write(response);
						}
					}
				}
			});
		});
		const port = await listen(server);
		const client = new PiClient({
			transportFactory: createWebSocketTransportFactory({ url: `ws://127.0.0.1:${port}` }),
		});

		try {
			await expect(client.connect()).resolves.toEqual(serverSnapshot);
			await expect(Promise.all([client.listSessions(), client.listSessions()])).resolves.toEqual([[], []]);
		} finally {
			client.disconnect();
			await closeServer(server);
		}
	});
});
