// The attach socket (`/terminals/socket`, a WebSocket per viewer): a terminal for a browser, held as the person
// (decision 25: the socket's scope holds the person's own reference to Terminals in the workspace) and ending with the
// sign-in that opened it, as a `/chord` link does (`LinkOpened`). One binary frame per piece each way, no call and no
// reply per key (decision 133; the bench's 0.26 against 0.13 ms per keystroke). Frames (`SocketTold`,
// `SocketMessage`, kind.ts):
// - to the page: `{ kind: "kept", bytes }` first (how much of the output that follows is the kept output, a replay),
//   then the kept output and each piece as it comes, as binary frames; the terminal's size (`size`) at the start and
//   after each change (another viewer resized it); and whether this page answers the program's queries (`answer`):
//   one viewer that may type per terminal does, the one that typed last, else the first, so a query is answered once;
// - from the page, with Use only: what is typed, binary, at most `SOCKET_FRAME` bytes a frame, `resize`, and `reply`
//   (the page's answer to a query: written like typing, but it moves no election); from every viewer `drawn`, the
//   output it drew. The flow and the socket's lifetime are viewer-socket.ts's, the election answering.ts's.
// It ends with code 1000 when the terminal ends or closes, `SOCKET_REFUSED` when the person is not let in, loses Watch
// and Use, its sign-in ends, or the terminal leaves their list (they left the workspace, its machine is no longer
// available to them there): the socket holds all of them, live, and a loss ends it at once, a read under way and
// frames received before its close handshake included.
// Another code (the server going away, a lost connection) is one the page attaches again after.

import {
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
import { type Answerer, Answering } from "./answering.ts";
import { SOCKET_FRAME, SOCKET_PATH, SocketMessage, Terminals } from "./kind.ts";
import { ViewerSocket } from "./viewer-socket.ts";

/** Serves the attach socket on `host`. */
export function serveSocket(host: FacetHost<P3Principal>): void {
	contribute(host, "terminals.socket", (self) => {
		const terminals = self.registry(TerminalHosts);
		const opened = self.registry(LinkOpened);
		// Each terminal's election of the viewer that answers; this object's, so a reload starts over.
		const answering = new Map<string, Answering>();
		self.contribute(Http, {
			sockets: {
				[SOCKET_PATH]: (socket, request, ctx) =>
					attach(socket, request, { terminals: terminals.value, opened: opened.value, answering }, ctx),
			},
			maxPayload: SOCKET_FRAME,
		});
	});
}

/** What frames a page may send before its socket was checked: keys typed at once, never a flood. */
const EARLY = { bytes: 64 * 1024, frames: 256 };

/** What the handler reaches: the terminal host, the sign-ins' hook, and each terminal's election. */
type Reach = {
	readonly terminals: TerminalHost | undefined;
	readonly opened: LinkOpenedHook;
	readonly answering: Map<string, Answering>;
};

/** The terminal the query names, for as long as the socket is open and the person may have it. */
async function attach(socket: WebSocketHandle, request: HttpRequest, reach: Reach, ctx: Ctx): Promise<void> {
	const viewer = new ViewerSocket(socket);
	// Frames that come while the socket is checked wait for it (keys typed at once are not lost), bounded.
	const early: (readonly [Buffer, boolean])[] = [];
	let earlyBytes = 0;
	let received = (data: Buffer, binary: boolean) => {
		earlyBytes += data.length;
		if (earlyBytes > EARLY.bytes || early.length >= EARLY.frames) viewer.end("too much before attaching");
		else early.push([data, binary]);
	};
	// ws's default binary type: a Buffer per message. Nothing is taken once the viewer ended, though ws still delivers
	// frames until the close handshake completes (Astra, round 2, M2).
	socket.on("message", (data, binary) => {
		if (!viewer.lost.aborted) received(data as Buffer, binary);
	});
	// The socket ends with its sign-in (a revoke, a sign-out), as a `/chord` link does (Astra, round 1, M3); a signed-in
	// socket no hook tracks could never be closed by a revoke: refused.
	const signedIn = reach.opened(request, () => viewer.end("signed out"));
	if (signedIn === undefined) return viewer.end("refused");
	socket.once("close", signedIn);
	const held = await hold(request, reach.terminals, ctx);
	if (viewer.lost.aborted) return;
	if (held === undefined) return viewer.end("refused");
	const { ref, list, terminals, terminal } = held;
	const loss = new AbortController();
	loss.signal.addEventListener("abort", () => viewer.end("lost"), { once: true });
	abortWhenLost(ref, "attach", loss, ctx);
	abortWhen(list, (rows) => !rows.some((row) => row.id === terminal), loss, ctx);
	const election = reach.answering.get(terminal) ?? new Answering();
	reach.answering.set(terminal, election);
	const answerer: Answerer = { typable: () => ref.type !== undefined, answer: (yes) => viewer.answer(yes) };
	received = (bytes, binary) => {
		// Use withheld since: what is typed, a size, an answer go nowhere.
		if (binary) {
			if (ref.type === undefined) return;
			terminals.write(terminal, bytes);
			election.typed(answerer);
			return;
		}
		const message = parsed(bytes.toString());
		if (message?.kind === "drawn") viewer.drawn(message.bytes);
		else if (message?.kind === "resize" && ref.type !== undefined) {
			terminals.resize(terminal, message.columns, message.rows);
		} else if (message?.kind === "reply" && ref.type !== undefined) terminals.write(terminal, message.text);
	};
	viewer.tell({ kind: "kept", bytes: Math.min(terminals.tail(terminal, 0).end, TERMINAL_BACKLOG) });
	const stop = terminals.followSize(terminal, ({ columns, rows }) => viewer.tell({ kind: "size", columns, rows }));
	election.add(answerer);
	for (const [data, binary] of early.splice(0)) received(data, binary);
	try {
		await viewer.stream(terminals, terminal, withAbortSignal(viewer.lost, ctx));
	} finally {
		stop();
		election.remove(answerer);
		if (election.empty && reach.answering.get(terminal) === election) reach.answering.delete(terminal);
	}
}

/**
 * The person's Terminals and the terminal the query names, once `attach` let them have it (Watch or Use, a machine
 * available to them there); `undefined` when not (a trust boundary: the query is the browser's).
 */
async function hold(request: HttpRequest, terminals: TerminalHost | undefined, ctx: Ctx) {
	const [workspace, thing, terminal] = ["workspace", "thing", "terminal"].map((name) => request.query.get(name));
	if (!workspace || !thing || !terminal || terminals === undefined) return undefined;
	const ref = await ctx.get(Terminals, { workspace, thing }).catch(() => undefined);
	if (ref?.attach === undefined || ref.terminals === undefined) return undefined;
	const attached = await ref.attach({ terminal }, ctx).then(
		() => true,
		() => false,
	);
	// The reference itself, not a copy: its members are live (a tick withheld takes them away).
	return attached ? { ref, list: ref.terminals, terminals, terminal } : undefined;
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
