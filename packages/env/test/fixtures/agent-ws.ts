// The server side of WebSocket connections for the agent tests (RFC 6455, unfragmented sends, no extensions), so the
// fake relay and local test servers need no npm dependency. Upgrades are answered by the caller, possibly later: the
// fake relay completes a client's handshake only once the agent's channel socket is there, as the relay does.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export type WsMessage = { text: string } | { binary: Buffer };
export type WsClose = { code: number; reason: string };

/** One accepted WebSocket: messages queue until read with `next`, and `closed` settles with the peer's close. */
export class WsPeer {
	readonly protocol: string | undefined;
	readonly closed: Promise<WsClose>;
	readonly #socket: Duplex;
	#buffer = Buffer.alloc(0);
	#fragments: Buffer[] = [];
	#fragmentText = false;
	#sentClose = false;
	#onClose!: (close: WsClose) => void;
	readonly #queue: WsMessage[] = [];
	readonly #waiters: ((message: WsMessage | undefined) => void)[] = [];
	readonly #listeners: ((message: WsMessage) => void)[] = [];
	#ended = false;

	constructor(socket: Duplex, protocol: string | undefined, head: Buffer) {
		this.#socket = socket;
		this.protocol = protocol;
		this.closed = new Promise((resolve) => {
			this.#onClose = resolve;
		});
		socket.on("data", (chunk: Buffer) => this.#receive(chunk));
		socket.on("close", () => this.#end({ code: 1006, reason: "" }));
		// Upgraded sockets are half-open: a peer that went away ends its side without a close frame.
		socket.on("end", () => {
			this.#end({ code: 1006, reason: "" });
			socket.destroy();
		});
		socket.on("error", () => this.#end({ code: 1006, reason: "" }));
		if (head.length > 0) this.#receive(head);
	}

	/** Every later message goes to `listener` instead of the queue. */
	onMessage(listener: (message: WsMessage) => void): void {
		this.#listeners.push(listener);
		for (const message of this.#queue.splice(0)) listener(message);
	}

	/** The next message; undefined once the connection is closed. */
	next(timeoutMs = 10_000): Promise<WsMessage | undefined> {
		const queued = this.#queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.#ended) return Promise.resolve(undefined);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no WebSocket message in time")), timeoutMs);
			this.#waiters.push((message) => {
				clearTimeout(timer);
				resolve(message);
			});
		});
	}

	send(data: string | Buffer): void {
		if (this.#sentClose) return;
		this.#frame(typeof data === "string" ? 1 : 2, typeof data === "string" ? Buffer.from(data) : data);
	}

	close(code = 1000, reason = ""): void {
		if (this.#sentClose) return;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
		payload.writeUInt16BE(code, 0);
		payload.write(reason, 2);
		this.#frame(8, payload);
		this.#sentClose = true;
	}

	terminate(): void {
		this.#socket.destroy();
	}

	#frame(opcode: number, payload: Buffer): void {
		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x80 | opcode, payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		if (!this.#socket.destroyed) this.#socket.write(Buffer.concat([header, payload]));
	}

	#receive(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			if (this.#buffer.length < 2) return;
			const first = this.#buffer[0] as number;
			const second = this.#buffer[1] as number;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.#buffer.length < 4) return;
				length = this.#buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.#buffer.length < 10) return;
				length = Number(this.#buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const masked = (second & 0x80) !== 0;
			const total = offset + (masked ? 4 : 0) + length;
			if (this.#buffer.length < total) return;
			const payload = Buffer.from(this.#buffer.subarray(total - length, total));
			if (masked) {
				const mask = this.#buffer.subarray(offset, offset + 4);
				for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4];
			}
			this.#buffer = this.#buffer.subarray(total);
			this.#handle(first & 0x0f, (first & 0x80) !== 0, payload);
		}
	}

	#handle(opcode: number, fin: boolean, payload: Buffer): void {
		if (opcode === 9) return this.#frame(10, payload);
		if (opcode === 10) return;
		if (opcode === 8) {
			const close =
				payload.length >= 2
					? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") }
					: { code: 1005, reason: "" };
			if (!this.#sentClose) this.close(close.code === 1005 ? 1000 : close.code, close.reason);
			this.#socket.end();
			return this.#end(close);
		}
		if (opcode === 1 || opcode === 2) {
			this.#fragmentText = opcode === 1;
			this.#fragments = [];
		}
		this.#fragments.push(payload);
		if (!fin) return;
		const data = Buffer.concat(this.#fragments);
		this.#fragments = [];
		this.#deliver(this.#fragmentText ? { text: data.toString("utf8") } : { binary: data });
	}

	#deliver(message: WsMessage): void {
		const listener = this.#listeners[0];
		if (listener) return listener(message);
		const waiter = this.#waiters.shift();
		if (waiter) waiter(message);
		else this.#queue.push(message);
	}

	#end(close: WsClose): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#onClose(close);
		for (const waiter of this.#waiters.splice(0)) waiter(undefined);
	}
}

/** The protocols a client offered in its upgrade. */
export function offeredProtocols(request: IncomingMessage): string[] {
	const header = request.headers["sec-websocket-protocol"];
	return (Array.isArray(header) ? header.join(",") : (header ?? ""))
		.split(",")
		.map((protocol) => protocol.trim())
		.filter((protocol) => protocol.length > 0);
}

/** Complete the upgrade of `request` with `protocol` (none: no `Sec-WebSocket-Protocol`). */
export function acceptUpgrade(
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	protocol: string | undefined,
): WsPeer {
	const key = request.headers["sec-websocket-key"] ?? "";
	const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	const lines = [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
	];
	socket.write(`${lines.join("\r\n")}\r\n\r\n`);
	return new WsPeer(socket, protocol, head);
}

/** Answer an upgrade with an HTTP error instead. */
export function refuseUpgrade(socket: Duplex, status: number, body: string): void {
	socket.end(
		`HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
	);
}
