// The attach socket (`/terminals/socket`, a WebSocket per viewer): a terminal for a browser, held as the person
// (decision 25: the socket's scope holds the person's own reference to Terminals in the workspace). One binary frame
// per piece each way, no call and no reply per key (decision 133; the bench's 0.26 against 0.13 ms per keystroke):
// - to the page: `{ "kind": "kept", bytes }` first (how much of the output that follows is the kept output, a replay),
//   then the kept output and each piece as it comes, as binary frames, and the terminal's size as a text frame
//   `{ "kind": "size", columns, rows }`, at the start and after each change (another viewer resized it);
// - from the page, with Use only: what is typed, as binary frames; `{ "kind": "resize", columns, rows }`; and from
//   every viewer `{ "kind": "drawn", bytes }`, the output it drew. At most `WINDOW` bytes are sent and not drawn: a
//   viewer that falls behind further waits, and once its output left the kept ring it skips to the oldest byte kept.
// It ends with code 1000 when the terminal ends or closes, `SOCKET_REFUSED` when the person is not let in, loses Watch and
// Use, or the terminal leaves their list (they left the workspace, its machine is no longer available to them there):
// the socket holds both, live, and a loss ends it at once, a read under way included. Another code (the server going
// away, a lost connection) is one the page attaches again after.

import {
	type Context,
	type Ctx,
	checkValue,
	contribute,
	type FacetHost,
	int,
	lit,
	obj,
	type P3Principal,
	type Static,
	union,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest, type WebSocketHandle } from "@earendil-works/p3/v1/server";
import { TERMINAL_BACKLOG, type TerminalHost, TerminalHosts } from "../environments/contract.terminal-host.server.ts";
import { abortWhen, abortWhenLost } from "../things/contract.server.ts";
import { MAX_CELLS, SOCKET_PATH, SOCKET_REFUSED, Terminals } from "./kind.ts";

/** Serves the attach socket on `host`. */
export function serveSocket(host: FacetHost<P3Principal>): void {
	contribute(host, "terminals.socket", (self) => {
		const terminals = self.registry(TerminalHosts);
		self.contribute(Http, {
			sockets: { [SOCKET_PATH]: (socket, request, ctx) => attach(socket, request, terminals.value, ctx) },
		});
	});
}

/** The close code of a terminal that ended or closed. */
const ENDED = 1000;

/** How many bytes a viewer may have sent to it and not drawn: what a keystroke's echo can wait behind. */
export const WINDOW = 256 * 1024;

/** The terminal the query names, for as long as the socket is open and the person may have it. */
async function attach(
	socket: WebSocketHandle,
	request: HttpRequest,
	terminals: TerminalHost | undefined,
	ctx: Ctx,
): Promise<void> {
	// Frames that come while the socket is checked wait for it: keys typed at once are not lost.
	const early: (readonly [Buffer, boolean])[] = [];
	let received = (data: Buffer, binary: boolean) => void early.push([data, binary]);
	// ws's default binary type: a Buffer per message.
	socket.on("message", (data, binary) => received(data as Buffer, binary));
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
	const flow = { sent: 0, drawn: 0, resume: () => {} };
	received = (bytes, binary) => {
		if (lost.signal.aborted) return;
		if (binary) {
			// Use withheld since: what is typed goes nowhere.
			if (ref.type !== undefined) terminals.write(terminal, bytes);
			return;
		}
		const message = parsed(bytes.toString());
		if (message?.kind === "drawn") {
			flow.drawn += message.bytes;
			flow.resume();
		} else if (message?.kind === "resize" && ref.resize !== undefined) {
			terminals.resize(terminal, message.columns, message.rows);
		}
	};
	socket.send(JSON.stringify({ kind: "kept", bytes: Math.min(terminals.tail(terminal, 0).end, TERMINAL_BACKLOG) }));
	const stop = terminals.followSize(terminal, (size) => socket.send(JSON.stringify({ kind: "size", ...size })));
	for (const [data, binary] of early.splice(0)) received(data, binary);
	try {
		await stream(socket, terminals, terminal, flow, withAbortSignal(lost.signal, ctx));
	} finally {
		stop();
	}
}

/** What a page sends besides typed bytes. */
const Message = union([
	obj({ kind: lit("drawn"), bytes: int({ min: 0 }) }),
	obj({ kind: lit("resize"), columns: int({ min: 1, max: MAX_CELLS }), rows: int({ min: 1, max: MAX_CELLS }) }),
]);

/** A text frame as a `Message`, or `undefined` for anything else (a trust boundary: the frame is the browser's). */
function parsed(text: string): Static<typeof Message> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	// Checked against the schema just now.
	return checkValue(Message, value) === undefined ? (value as Static<typeof Message>) : undefined;
}

/**
 * Sends terminal `id`'s output from its first kept byte on, never more than `WINDOW` ahead of what the page drew,
 * until it ended (the socket closed 1000) or `reading` aborts (a loss, or the socket closed).
 */
async function stream(
	socket: WebSocketHandle,
	terminals: TerminalHost,
	id: string,
	flow: { sent: number; drawn: number; resume: () => void },
	reading: Context,
): Promise<void> {
	const signal = reading.abortSignal;
	let from = 0;
	try {
		for (;;) {
			while (flow.sent - flow.drawn > WINDOW) await drawn(flow, signal);
			const next = await terminals.next(id, from, reading);
			if (signal?.aborted) return;
			if (next.bytes.length === 0) return socket.close(ENDED, "ended");
			from = next.from + next.bytes.length;
			flow.sent += next.bytes.length;
			socket.send(next.bytes);
		}
	} catch (error) {
		// A loss or the socket's close ends the reads; anything else is the handler's failure (closed 1011).
		if (!signal?.aborted) throw error;
	}
}

/** Resolves when the page says it drew more, or `signal` aborts (then rejects). */
function drawn(flow: { resume: () => void }, signal: AbortSignal | undefined): Promise<void> {
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
