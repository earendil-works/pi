// WebSocket links (§3): a link over a WebSocket, the browser's or `ws` in Node, typed structurally; binary frames,
// messages sent while it still connects buffered until it opens.

import { type Link, LinkEnd } from "./link.ts";

/** The part of a WebSocket a link uses (the browser's `WebSocket`, `ws`'s `WebSocket`). */
export interface WebSocketLike {
	/** 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: number;
	binaryType: string;
	/** Typed as the browser's `WebSocket` takes bytes: on an `ArrayBuffer`, never shared memory. */
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

const CONNECTING = 0;

const OPEN = 1;

/**
 * A link over `socket`, one binary frame per message (`binaryType = "arraybuffer"`). Messages sent while it connects
 * wait for `open`; a socket closing or closed already gives a closed link; `close` and `error` close the link once, and
 * so does a text frame (no message of this protocol). A frame above the transport's `maxPayload` closes the socket
 * (code 1009), which closes the link.
 */
export function webSocketLink(socket: WebSocketLike): Link {
	return new WebSocketLink(socket);
}

class WebSocketLink extends LinkEnd {
	/** The socket while the link is open. */
	#socket: WebSocketLike | undefined;
	/** Messages sent while the socket connects; `undefined` once it is open. */
	#connecting: Uint8Array[] | undefined;
	readonly #onOpen = (): void => {
		const queued = this.#connecting ?? [];
		this.#connecting = undefined;
		for (const message of queued) this.send(message);
	};
	readonly #onMessage = (event: { readonly data: unknown }): void => {
		if (event.data instanceof ArrayBuffer) this.deliver(new Uint8Array(event.data));
		else this.close();
	};
	readonly #onError = (): void => this.#end();

	constructor(socket: WebSocketLike) {
		super();
		if (socket.readyState !== CONNECTING && socket.readyState !== OPEN) {
			this.ended();
			return;
		}
		this.#socket = socket;
		socket.binaryType = "arraybuffer";
		if (socket.readyState === CONNECTING) {
			this.#connecting = [];
			socket.addEventListener("open", this.#onOpen);
		}
		socket.addEventListener("message", this.#onMessage);
		// `error` and `close` stay handled until the socket's own close, after this end closed: `ws` emits an `error`
		// for a socket closed while it connects, and an unhandled one would end the process.
		const onClose = (): void => {
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("error", this.#onError);
			this.#end();
		};
		socket.addEventListener("close", onClose);
		socket.addEventListener("error", this.#onError);
	}

	send(message: Uint8Array): void {
		const socket = this.#socket;
		if (socket === undefined) return;
		if (this.#connecting !== undefined) {
			this.#connecting.push(message);
			return;
		}
		try {
			// A link's messages are codec output or received frames, both on plain `ArrayBuffer`s.
			socket.send(message as Uint8Array<ArrayBuffer>);
		} catch {
			this.close();
		}
	}

	close(): void {
		const socket = this.#socket;
		if (socket === undefined) return;
		this.#end();
		socket.close();
	}

	/** Stops listening for frames, drops what waits to be sent and closes this end. */
	#end(): void {
		const socket = this.#socket;
		if (socket === undefined) return;
		this.#socket = undefined;
		this.#connecting = undefined;
		socket.removeEventListener("open", this.#onOpen);
		socket.removeEventListener("message", this.#onMessage);
		this.ended();
	}
}
