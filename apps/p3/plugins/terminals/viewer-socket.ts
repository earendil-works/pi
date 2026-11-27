// One viewer's attach socket as the server drives it (socket.ts has the protocol): its lifetime, which a loss ends at
// once (`end`: nothing is read, sent or taken from it after, before the socket's close handshake even starts), and its
// flow: at most `WINDOW` bytes of output sent and not drawn (a page's `drawn` counts only what was sent), and at most
// `WINDOW` bytes, output and text frames alike, in the socket's own buffer (a page that stopped reading). A size or an
// election that comes while the buffer is full waits, the newest of each kind kept (they supersede each other), and
// no output goes while an election waits (it names the output offset it starts at). Output frames say where in the
// terminal's output they start (`from`) before the first and after a skip.

import type { Context } from "@earendil-works/p3/v1";
import type { WebSocketHandle } from "@earendil-works/p3/v1/server";
import type { TerminalHost } from "../environments/contract.terminal-host.server.ts";
import { SOCKET_ENDED, SOCKET_REFUSED, type SocketTold } from "./kind.ts";

/** How many bytes a viewer may have sent to it and not drawn, or waiting in its socket's buffer. */
export const WINDOW = 256 * 1024;

/** A viewer's socket: its lifetime, what it is told, and its output. */
export class ViewerSocket {
	readonly #socket: WebSocketHandle;
	readonly #lost = new AbortController();
	/** Output bytes sent, and drawn as the page says (at most those sent). */
	#sent = 0;
	#drawn = 0;
	/** Bytes handed to the socket and not written out yet. */
	#buffered = 0;
	/** The newest size and election not sent yet: the buffer was full. */
	readonly #waiting = new Map<"size" | "answer", SocketTold>();
	#resume: () => void = () => {};

	constructor(socket: WebSocketHandle) {
		this.#socket = socket;
	}

	/** Aborted once the socket ended: everything of the viewer's stops at once. */
	get lost(): AbortSignal {
		return this.#lost.signal;
	}

	/** Ends the viewer's socket now (refused, lost, signed out): it is closed with `SOCKET_REFUSED` and `reason`. */
	end(reason: string): void {
		if (this.#lost.signal.aborted) return;
		this.#lost.abort(new Error(`terminals: the socket ended: ${reason}`));
		this.#waiting.clear();
		this.#socket.close(SOCKET_REFUSED, reason);
	}

	/**
	 * Tells the page a size or an election: at once while the buffer has room for it and none of its kind waits (an
	 * older one would else come after it), else it waits, the newest of its kind kept.
	 */
	tell(told: Extract<SocketTold, { kind: "size" | "answer" }>): void {
		if (this.#lost.signal.aborted) return;
		const text = JSON.stringify(told);
		if (this.#waiting.has(told.kind) || this.#buffered + Buffer.byteLength(text) > WINDOW) {
			this.#waiting.set(told.kind, told);
			return;
		}
		this.#write(text);
	}

	/** Tells the page, as the first frame, how many bytes of the output that follows are kept output (a replay). */
	kept(bytes: number): void {
		this.#write(JSON.stringify({ kind: "kept", bytes } satisfies SocketTold));
	}

	/** The page drew `bytes` more: counted up to what was sent. */
	drawn(bytes: number): void {
		this.#drawn = Math.min(this.#sent, this.#drawn + bytes);
		this.#resume();
	}

	/**
	 * Sends terminal `id`'s output from its first kept byte on, within the window, until it ended (the socket is then
	 * closed 1000) or the viewer is lost; rejects only on a failure of its own.
	 */
	async stream(terminals: TerminalHost, id: string, context: Context): Promise<void> {
		const signal = this.#lost.signal;
		// Where the page's next byte is in the terminal's output: unknown before the first frame.
		let from = -1;
		try {
			for (;;) {
				while (this.#room() <= 0) await this.#more();
				const next = await terminals.next(id, Math.max(from, 0), context);
				if (signal.aborted) return;
				if (next.bytes.length === 0) {
					this.#lost.abort(new Error("terminals: the terminal ended"));
					this.#socket.close(SOCKET_ENDED, "ended");
					return;
				}
				// The first frame, and one after bytes skipped, says where it starts, before it and within the buffer.
				if (next.from !== from) {
					const text = JSON.stringify({ kind: "from", offset: next.from } satisfies SocketTold);
					while (this.#buffered + Buffer.byteLength(text) > WINDOW) await this.#more();
					this.#write(text);
					from = next.from;
				}
				// No more than both have room for; the rest is read again next.
				const bytes = next.bytes.subarray(0, Math.max(this.#room(), 0));
				if (bytes.length === 0) continue;
				from += bytes.length;
				this.#sent += bytes.length;
				this.#write(bytes);
			}
		} catch (error) {
			// A loss or the socket's close ends the reads; anything else is the handler's failure (closed 1011).
			if (!signal.aborted && !context.abortSignal?.aborted) throw error;
		}
	}

	/** How many output bytes may go now: the least of the window's room and the buffer's; none while an election waits. */
	#room(): number {
		if (this.#waiting.has("answer")) return 0;
		return Math.min(WINDOW - (this.#sent - this.#drawn), WINDOW - this.#buffered);
	}

	/** Hands `data` to the socket, counted in its buffer until written out. */
	#write(data: string | Uint8Array): void {
		const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
		this.#buffered += size;
		this.#socket.send(data, () => {
			this.#buffered -= size;
			this.#flush();
			this.#resume();
		});
	}

	/** Sends what waited for room in the buffer, as far as there is room. */
	#flush(): void {
		for (const [kind, told] of this.#waiting) {
			const text = JSON.stringify(told);
			if (this.#lost.signal.aborted || this.#buffered + Buffer.byteLength(text) > WINDOW) return;
			this.#waiting.delete(kind);
			this.#write(text);
		}
	}

	/** Resolves when the page drew more or the buffer emptied some, or the viewer is lost (then rejects). */
	#more(): Promise<void> {
		const signal = this.#lost.signal;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const aborted = () => reject(signal.reason);
			signal.addEventListener("abort", aborted, { once: true });
			this.#resume = () => {
				signal.removeEventListener("abort", aborted);
				this.#resume = () => {};
				resolve();
			};
		});
	}
}
