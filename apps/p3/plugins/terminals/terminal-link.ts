// A terminal's link on the page (`TerminalLink`, screen.ts) over its attach socket (socket.ts, where the frames are
// described): the address comes from the person's held Terminals (`attach`, which checks Watch or Use and the
// machine), one WebSocket while the screen follows it. A connection lost (the server restarting, the network) is
// made again, after 0.5 s doubling up to 10 s, and starts over with the kept output; a terminal that ended or a
// person refused or no longer let in (`SOCKET_REFUSED`) is not attached again.

import { BACKGROUND_CONTEXT, isChordError, type Reference, reportError } from "@earendil-works/p3/v1";
import {
	SOCKET_ENDED,
	SOCKET_FRAME,
	SOCKET_REFUSED,
	type SocketMessage,
	type SocketTold,
	type Terminals,
} from "./kind.ts";
import type { ScreenFeed, TerminalLink } from "./screen.ts";

/** Terminal `terminal` of the held Terminals `live`, typable and resizable where `live` gives Use. */
export function terminalLink(live: Reference<typeof Terminals>, terminal: string): TerminalLink {
	const open: { socket: WebSocket | undefined } = { socket: undefined };
	const send = (data: string | Uint8Array<ArrayBuffer>) => {
		if (open.socket?.readyState === WebSocket.OPEN) open.socket.send(data);
	};
	const tell = (message: SocketMessage) => send(JSON.stringify(message));
	const link: TerminalLink = {
		follow: (feed) => follow(live, terminal, feed, open),
		drawn: (bytes) => tell({ kind: "drawn", bytes }),
	};
	if (live.type === undefined) return link;
	return {
		...link,
		// The socket takes frames of at most `SOCKET_FRAME` bytes: a long paste goes in pieces, in order. The screen
		// hands over arrays of its own (an `ArrayBuffer` each).
		type: (bytes) => {
			for (let at = 0; at < bytes.length; at += SOCKET_FRAME) {
				send(bytes.subarray(at, at + SOCKET_FRAME) as Uint8Array<ArrayBuffer>);
			}
		},
		resize: (columns, rows) => tell({ kind: "resize", columns, rows }),
	};
}

/** How long the first attempt to attach again waits; each next one twice as long, at most `MAX_RETRY`. */
const FIRST_RETRY = 500;

/** The longest wait between two attempts to attach again. */
const MAX_RETRY = 10_000;

/** Tells `feed` about the terminal until the returned stop; `open.socket` is the socket open now. */
function follow(
	live: Reference<typeof Terminals>,
	terminal: string,
	feed: ScreenFeed,
	open: { socket: WebSocket | undefined },
): () => void {
	let stopped = false;
	let tries = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const again = () => {
		timer = setTimeout(start, Math.min(MAX_RETRY, FIRST_RETRY * 2 ** tries++));
	};
	const connect = async () => {
		const attached = await live.attach?.({ terminal }, BACKGROUND_CONTEXT);
		if (stopped || attached === undefined) return;
		const url = new URL(attached.url, location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		open.socket = socket;
		socket.onopen = () => {
			tries = 0;
		};
		socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
			if (typeof event.data !== "string") return feed.output(new Uint8Array(event.data));
			// The server's own frames (socket.ts).
			const told = JSON.parse(event.data) as SocketTold;
			switch (told.kind) {
				case "kept":
					return feed.restart(told.bytes);
				case "size":
					return feed.size(told.columns, told.rows);
				case "answer":
					return feed.answer(told.yes);
			}
		};
		socket.onclose = (event) => {
			if (open.socket === socket) open.socket = undefined;
			if (!stopped && event.code !== SOCKET_ENDED && event.code !== SOCKET_REFUSED) again();
		};
	};
	const start = () => {
		connect().catch((error: unknown) => {
			if (stopped) return;
			// Refused (Watch and Use withheld, the terminal gone): the view's list shows it; anything else is tried again.
			if (isChordError(error, "forbidden") || isChordError(error, "invalid")) return;
			reportError("terminals: attaching to a terminal", error, BACKGROUND_CONTEXT);
			again();
		});
	};
	start();
	return () => {
		stopped = true;
		clearTimeout(timer);
		open.socket?.close();
		open.socket = undefined;
	};
}
