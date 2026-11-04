// Per-connection limits of browser and TUI Chord sockets (`/chord`), as Pi Mobile's (apps/mobile/src/server/app.ts).

import type { WebSocketLike } from "@earendil-works/chord";
import type { WebSocket } from "ws";

/** Largest frame a client may send. Uploads go over HTTP; a 1,000,000-character message fits. */
export const MAX_CLIENT_FRAME = 1024 * 1024;
/** Unsent data beyond the frame being sent: a client that stops reading is cut off instead of growing the server. */
export const MAX_UNSENT_BYTES = 4 * 1024 * 1024;

/**
 * The socket Chord's link sees for one client connection (Chord queues calls behind its own window).
 *
 * - Errors (an oversized frame) terminate the socket instead of crashing the server.
 * - Output: before each send, data still buffered beyond the largest unfinished frame (one snapshot may itself be
 *   large) must stay under `MAX_UNSENT_BYTES`, or the socket is terminated; the client reconnects from snapshots.
 *   chord2's flow control normally keeps a reading client far below it; this catches clients that stop reading.
 */
export function limitedSocket(socket: WebSocket): WebSocketLike {
	// A protocol error (an oversized frame: "Max payload size exceeded") is emitted as an `error` event, which would
	// crash the server without a listener. The socket closes (1009); the link sees the close.
	socket.on("error", () => socket.terminate());
	const unsent = new Set<{ readonly bytes: number }>();
	const send = (data: Uint8Array<ArrayBuffer>): void => {
		if (socket.readyState !== socket.OPEN) return;
		let sending = 0;
		for (const frame of unsent) sending = Math.max(sending, frame.bytes);
		if (socket.bufferedAmount - sending > MAX_UNSENT_BYTES) {
			socket.terminate();
			return;
		}
		const frame = { bytes: data.byteLength + 10 }; // Largest server frame header.
		unsent.add(frame);
		socket.send(data, (error) => {
			unsent.delete(frame);
			if (error) socket.terminate();
		});
	};
	return {
		get readyState() {
			return socket.readyState;
		},
		get binaryType() {
			return socket.binaryType;
		},
		set binaryType(value: string) {
			socket.binaryType = value as WebSocket["binaryType"];
		},
		send,
		close: () => socket.close(),
		addEventListener: socket.addEventListener.bind(socket) as WebSocketLike["addEventListener"],
		removeEventListener: socket.removeEventListener.bind(socket) as WebSocketLike["removeEventListener"],
	};
}
