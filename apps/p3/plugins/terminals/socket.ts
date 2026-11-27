// The attach socket (`/terminals/socket`, a WebSocket per viewer): a terminal for a browser, held as the person
// (decision 25: the socket's scope holds the person's own reference to Terminals in the workspace) and ending with the
// sign-in that opened it, as a `/chord` link does (`LinkOpened`). One binary frame per piece each way, no call and no
// reply per key (decision 133; the bench's 0.26 against 0.13 ms per keystroke). Frames (`SocketTold`,
// `SocketMessage`, kind.ts):
// - to the page: `{ kind: "kept", bytes }` first (how much of the output that follows is the kept output, a replay),
//   then the kept output and each piece as it comes, as binary frames; the terminal's size (`size`) at the start and
//   after each change (another viewer resized it); and whether this page answers the program's queries (`answer`):
//   one viewer that may type per terminal does, the one that typed last, else the first, so a query is answered once;
// - from the page, with Use only: what is typed, binary, at most `SOCKET_FRAME` bytes a frame, and `resize`; from
//   every viewer `drawn`, the output it drew. At most `WINDOW` bytes are sent and not drawn (a `drawn` counts only
//   what was sent) and at most `WINDOW` wait in the socket's own buffer: a viewer that falls behind further waits, and
//   once its output left the kept ring it skips to the oldest byte kept.
// It ends with code 1000 when the terminal ends or closes, `SOCKET_REFUSED` when the person is not let in, loses Watch
// and Use, its sign-in ends, or the terminal leaves their list (they left the workspace, its machine is no longer
// available to them there): the socket holds all of them, live, and a loss ends it at once, a read under way included.
// Another code (the server going away, a lost connection) is one the page attaches again after.

import {
	type Context,
	type Ctx,
	checkValue,
	contribute,
	type FacetHost,
	type P3Principal,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import {
	Http,
	type HttpRequest,
	LinkOpened,
	type LinkOpenedHook,
	type WebSocketHandle,
} from "@earendil-works/p3/v1/server";
import { TERMINAL_BACKLOG, type TerminalHost, TerminalHosts } from "../environments/contract.terminal-host.server.ts";
import { abortWhen, abortWhenLost } from "../things/contract.server.ts";
import {
	SOCKET_ENDED,
	SOCKET_FRAME,
	SOCKET_PATH,
	SOCKET_REFUSED,
	SocketMessage,
	type SocketTold,
	Terminals,
} from "./kind.ts";

/** Serves the attach socket on `host`. */
export function serveSocket(host: FacetHost<P3Principal>): void {
	contribute(host, "terminals.socket", (self) => {
		const terminals = self.registry(TerminalHosts);
		const opened = self.registry(LinkOpened);
		// The viewers of each terminal, for the one that answers its queries; this object's, so a reload starts over.
		const viewers = new Map<string, Viewers>();
		self.contribute(Http, {
			sockets: {
				[SOCKET_PATH]: (socket, request, ctx) =>
					attach(socket, request, { terminals: terminals.value, opened: opened.value, viewers }, ctx),
			},
			maxPayload: SOCKET_FRAME,
		});
	});
}

/** How many bytes a viewer may have sent to it and not drawn: what a keystroke's echo can wait behind. */
export const WINDOW = 256 * 1024;

/** What frames a page may send before its socket was checked, in bytes: keys typed at once, never a flood. */
const EARLY = 64 * 1024;

/** What the handler reaches: the terminal host, the sign-ins' hook, and each terminal's viewers. */
type Reach = {
	readonly terminals: TerminalHost | undefined;
	readonly opened: LinkOpenedHook;
	readonly viewers: Map<string, Viewers>;
};

/** The terminal the query names, for as long as the socket is open and the person may have it. */
async function attach(socket: WebSocketHandle, request: HttpRequest, reach: Reach, ctx: Ctx): Promise<void> {
	const { terminals } = reach;
	// Frames that come while the socket is checked wait for it: keys typed at once are not lost.
	const early: (readonly [Buffer, boolean])[] = [];
	let earlyBytes = 0;
	let received = (data: Buffer, binary: boolean) => {
		earlyBytes += data.length;
		if (earlyBytes > EARLY) socket.close(SOCKET_REFUSED, "too much before attaching");
		else early.push([data, binary]);
	};
	// ws's default binary type: a Buffer per message.
	socket.on("message", (data, binary) => received(data as Buffer, binary));
	// The socket ends with its sign-in (a revoke, a sign-out), as a `/chord` link does (Astra, round 1, M3). A signed-in
	// socket no hook tracks could never be closed by a revoke: refused.
	const signedIn = reach.opened(request, () => socket.close(SOCKET_REFUSED, "signed out"));
	if (signedIn === undefined) return socket.close(SOCKET_REFUSED, "refused");
	socket.once("close", signedIn);
	// A trust boundary: the query is the browser's.
	const [workspace, thing, terminal] = ["workspace", "thing", "terminal"].map((name) => request.query.get(name));
	if (!workspace || !thing || !terminal || terminals === undefined) return socket.close(SOCKET_REFUSED, "refused");
	const ref = await ctx.get(Terminals, { workspace, thing }).catch(() => undefined);
	const attached =
		ref?.attach === undefined || ref.terminals === undefined
			? false
			: await ref.attach({ terminal }, ctx).then(
					() => true,
					() => false,
				);
	if (ref === undefined || !attached || ref.terminals === undefined) return socket.close(SOCKET_REFUSED, "refused");
	const lost = new AbortController();
	abortWhenLost(ref, "attach", lost, ctx);
	abortWhen(ref.terminals, (rows) => !rows.some((row) => row.id === terminal), lost, ctx);
	lost.signal.addEventListener("abort", () => socket.close(SOCKET_REFUSED, "lost"), { once: true });
	const flow: Flow = { sent: 0, drawn: 0, buffered: 0, resume: () => {} };
	const viewer: Viewer = { tell: (told) => socket.send(JSON.stringify(told)), typable: () => ref.type !== undefined };
	const viewers = reach.viewers.get(terminal) ?? new Viewers();
	reach.viewers.set(terminal, viewers);
	received = (bytes, binary) => {
		if (lost.signal.aborted) return;
		if (binary) {
			// Use withheld since: what is typed goes nowhere.
			if (ref.type === undefined) return;
			terminals.write(terminal, bytes);
			viewers.typed(viewer);
			return;
		}
		const message = parsed(bytes.toString());
		if (message?.kind === "drawn") {
			// Only what was sent counts: a page that claims more gets no more ahead (Opus, round 1, S1).
			flow.drawn = Math.min(flow.sent, flow.drawn + message.bytes);
			flow.resume();
		} else if (message?.kind === "resize" && ref.type !== undefined) {
			terminals.resize(terminal, message.columns, message.rows);
		}
	};
	viewer.tell({ kind: "kept", bytes: Math.min(terminals.tail(terminal, 0).end, TERMINAL_BACKLOG) });
	const stop = terminals.followSize(terminal, ({ columns, rows }) => viewer.tell({ kind: "size", columns, rows }));
	viewers.add(viewer);
	for (const [data, binary] of early.splice(0)) received(data, binary);
	try {
		await stream(socket, terminals, terminal, flow, withAbortSignal(lost.signal, ctx));
	} finally {
		stop();
		viewers.remove(viewer);
		if (viewers.empty && reach.viewers.get(terminal) === viewers) reach.viewers.delete(terminal);
	}
}

/** A text frame as a `SocketMessage`, or `undefined` for anything else (a trust boundary: the browser's frame). */
function parsed(text: string): SocketMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	// Checked against the schema just now.
	return checkValue(SocketMessage, value) === undefined ? (value as SocketMessage) : undefined;
}

/** One viewer's socket as its terminal's viewers see it: what it is told, and whether it may type now. */
type Viewer = { readonly tell: (told: SocketTold) => void; readonly typable: () => boolean };

/**
 * A terminal's viewers and the one that answers the program's queries (device attributes, the cursor's position): the
 * one that typed last, else the first that may type; two answering would type each answer twice (Opus, Astra, round
 * 1, S2). Every viewer that may type is told whether it answers when that changes.
 */
class Viewers {
	readonly #all = new Set<Viewer>();
	#answering: Viewer | undefined;

	/** Whether no viewer is left. */
	get empty(): boolean {
		return this.#all.size === 0;
	}

	/** A viewer came: it answers if none does. */
	add(viewer: Viewer): void {
		this.#all.add(viewer);
		this.#elect(this.#answering);
	}

	/** A viewer went: the next that may type answers if it did. */
	remove(viewer: Viewer): void {
		this.#all.delete(viewer);
		this.#elect(this.#answering === viewer ? undefined : this.#answering);
	}

	/** A viewer typed: it answers from now on. */
	typed(viewer: Viewer): void {
		if (this.#answering !== viewer) this.#elect(viewer);
	}

	/** Makes `wanted` the one that answers, else the first that may type, and tells who changed. */
	#elect(wanted: Viewer | undefined): void {
		const before = this.#answering;
		const usable = (viewer: Viewer | undefined) =>
			viewer !== undefined && this.#all.has(viewer) && viewer.typable() ? viewer : undefined;
		this.#answering = usable(wanted) ?? [...this.#all].find((viewer) => viewer.typable());
		if (before === this.#answering) return;
		if (before !== undefined && this.#all.has(before)) before.tell({ kind: "answer", yes: false });
		this.#answering?.tell({ kind: "answer", yes: true });
	}
}

/** A viewer's flow: bytes sent, drawn (as the page says, at most those sent), still in the socket's buffer. */
type Flow = { sent: number; drawn: number; buffered: number; resume: () => void };

/**
 * Sends terminal `id`'s output from its first kept byte on, never more than `WINDOW` ahead of what the page drew nor
 * `WINDOW` in the socket's buffer, until it ended (the socket closed 1000) or `reading` aborts (a loss, or the socket
 * closed).
 */
async function stream(
	socket: WebSocketHandle,
	terminals: TerminalHost,
	id: string,
	flow: Flow,
	reading: Context,
): Promise<void> {
	const signal = reading.abortSignal;
	let from = 0;
	try {
		for (;;) {
			while (flow.sent - flow.drawn >= WINDOW || flow.buffered >= WINDOW) await more(flow, signal);
			const next = await terminals.next(id, from, reading);
			if (signal?.aborted) return;
			if (next.bytes.length === 0) return socket.close(SOCKET_ENDED, "ended");
			// No more than the window has room for; the rest is read again next.
			const bytes = next.bytes.subarray(0, WINDOW - (flow.sent - flow.drawn));
			from = next.from + bytes.length;
			flow.sent += bytes.length;
			flow.buffered += bytes.length;
			socket.send(bytes, () => {
				flow.buffered -= bytes.length;
				flow.resume();
			});
		}
	} catch (error) {
		// A loss or the socket's close ends the reads; anything else is the handler's failure (closed 1011).
		if (!signal?.aborted) throw error;
	}
}

/** Resolves when the page drew more or the socket's buffer emptied some, or `signal` aborts (then rejects). */
function more(flow: Flow, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal?.reason);
		signal?.addEventListener("abort", aborted, { once: true });
		flow.resume = () => {
			signal?.removeEventListener("abort", aborted);
			flow.resume = () => {};
			resolve();
		};
	});
}
