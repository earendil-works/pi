import { WebSocket } from "node:http";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface WebSocketTransportOptions {
	/** ws:// or wss:// URL of the remote endpoint. */
	url: string;
	maxPendingBytes?: number;
}

/** Creates fresh WebSocket transports for PiClient connection attempts. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	if (typeof options.url !== "string" || options.url.length === 0) {
		throw new TypeError("WebSocket transport URL must not be empty");
	}
	let parsed: URL;
	try {
		parsed = new URL(options.url);
	} catch {
		throw new TypeError(`WebSocket transport URL is invalid: ${options.url}`);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new TypeError(`WebSocket transport URL must use ws: or wss: (got ${parsed.protocol})`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket transport maxPendingBytes must be a positive safe integer");
	}
	return (handlers) => connectWebSocket(options.url, maxPendingBytes, handlers);
}

function connectWebSocket(
	url: string,
	maxPendingBytes: number,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = new WebSocket(url);
		let connected = false;
		let terminal = false;

		socket.binaryType = "arraybuffer";

		const close = (): void => {
			if (terminal) return;
			terminal = true;
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				try {
					socket.close();
				} catch {
					// Already closing or closed.
				}
			}
			if (connected) handlers.onClose();
			else reject(new Error("WebSocket transport closed before connecting"));
		};

		socket.addEventListener("open", () => {
			if (terminal) return;
			connected = true;
			resolve(
				new WebSocketByteTransport(socket, maxPendingBytes, () => {
					terminal = true;
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			if (terminal) return;
			const data = event.data;
			if (data instanceof ArrayBuffer) {
				handlers.onData(new Uint8Array(data));
			} else if (ArrayBuffer.isView(data)) {
				handlers.onData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			// Text frames are ignored; the protocol is binary-only.
		});
		socket.addEventListener("close", close);
		socket.addEventListener("error", (event) => {
			if (terminal) return;
			terminal = true;
			const message = event instanceof Error ? event.message : "WebSocket transport error";
			if (connected) handlers.onError(new Error(message));
			else reject(new Error(message));
		});
	});
}

class WebSocketByteTransport implements ByteTransport {
	readonly #socket: WebSocket;
	readonly #maxPendingBytes: number;
	readonly #markLocalClose: () => void;
	#closed = false;

	constructor(socket: WebSocket, maxPendingBytes: number, markLocalClose: () => void) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markLocalClose = markLocalClose;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("WebSocket transport is closed"));
		if (this.#socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket transport is not open"));
		}
		if (this.#socket.bufferedAmount + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket transport exceeded its pending byte limit"));
		}
		this.#socket.send(chunk);
		return Promise.resolve();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		try {
			this.#socket.close();
		} catch {
			// Already closing or closed.
		}
	}
}
