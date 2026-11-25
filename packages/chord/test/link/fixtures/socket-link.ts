// A link over a Node socket for tests across processes: each message one frame, its length first (4 bytes, little
// endian). The stall test's server and its clients use it: a real transport whose peer runs in another event loop.
import type { Socket } from "node:net";
import { type Link, LinkEnd } from "../../../src/link/link.ts";

/** A link over `socket`; closing either end ends the socket, and the socket's end closes the link. */
export function socketLink(socket: Socket): Link {
	return new SocketLink(socket);
}

class SocketLink extends LinkEnd {
	readonly #socket: Socket;
	#buffer: Buffer = Buffer.alloc(0);

	constructor(socket: Socket) {
		super();
		this.#socket = socket;
		socket.on("data", (chunk: Buffer) => this.#data(chunk));
		socket.on("close", () => this.ended());
		socket.on("error", () => this.ended());
	}

	send(message: Uint8Array): void {
		if (this.closed) return;
		const head = Buffer.alloc(4);
		head.writeUInt32LE(message.byteLength, 0);
		this.#socket.write(head);
		this.#socket.write(message);
	}

	close(): void {
		this.#socket.destroy();
		this.ended();
	}

	#data(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 4) {
			const length = this.#buffer.readUInt32LE(0);
			if (this.#buffer.length < 4 + length) return;
			// A copy: the consumer may keep the bytes beyond this buffer's reuse.
			const message = new Uint8Array(this.#buffer.subarray(4, 4 + length));
			this.#buffer = this.#buffer.subarray(4 + length);
			this.deliver(message);
		}
	}
}
