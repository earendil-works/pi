// Upgraded connections (slice 10 §2, D6, Q6): the links endpoint (`host.accept` over a WebSocket with a per-socket
// output cap) and plugin sockets (a `ws` WebSocket handed to the contribution's handler for its own protocol, in a scope
// lasting until it closes, kept alive by a heartbeat). Each connection is kept with what admitted it: when that leaves
// (its allowed host, its relay, its socket handler) it is terminated at once and its scope sealed (decision "Slice 10
// fix round, allowed hosts only through contributions"); the component's close closes all (1001), terminating at its
// timeout those that never acknowledge.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import type { Principal } from "../../next/data/index.ts";
import type { Ctx, Host } from "../../next/host/index.ts";
import { type PartLimits, type WebSocketLike, webSocketLink } from "../../next/link/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpRelay, HttpSocket, Router, SocketMatch } from "./router.ts";

/** What admitted an upgrade: the allowed host or the relay it came through (local: neither), and its principal. */
export type Admission<P extends Principal> = {
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
	readonly principal: P;
};

/** What the links endpoint gives one socket: its parts' limits and its largest frame (1 MiB by default). */
export type LinkOptions = { readonly limits?: PartLimits; readonly maxPayload?: number };

/** A plugin socket's handler failed: reported, the socket closed (1011). */
export type SocketFailure = { readonly pattern: string; readonly plugin: string; readonly error: unknown };

/** One upgraded connection, with what admitted it and how to seal its scope. */
type Upgraded = {
	readonly socket: WebSocket;
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
	/** The handler that took it (plugin sockets only). */
	readonly handler: HttpSocket | undefined;
	/** Ends its work at once: the link closed, or the handler's scope sealed. */
	readonly seal: () => void;
};

/** A link socket's largest frame unless `links.options` says otherwise: 1 MiB. */
const DEFAULT_LINK_PAYLOAD = 1024 * 1024;

/** The upgraded connections of one HTTP component. */
export class Upgrades {
	readonly #open = new Set<Upgraded>();

	/**
	 * Upgrades `message` to the links endpoint: `host.accept` over the socket (its output capped) as the admitted
	 * principal, with `options`' limits; `context` is the parent of the work on the link.
	 */
	link<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & LinkOptions,
		host: Host<P>,
		context: Context,
	): void {
		const { principal, limits } = admission;
		upgrade(message, stream, head, admission.maxPayload ?? DEFAULT_LINK_PAYLOAD, (socket) => {
			const link = webSocketLink(limitedSocket(socket));
			this.#keep({
				socket,
				allowed: admission.allowed,
				relay: admission.relay,
				handler: undefined,
				seal: () => link.close(),
			});
			host.accept(link, { principal, ...(limits === undefined ? {} : { limits }) }, context);
		});
	}

	/**
	 * Upgrades `message` to the plugin socket `match`: its handler gets the socket and `request` in a `host.root` scope
	 * acting as the admitted principal that lasts until the socket closes; a handler that throws is reported and closes
	 * it (1011).
	 */
	socket<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & { readonly match: SocketMatch; readonly request: HttpRequest },
		host: Host<P>,
		context: Context,
		failed: (failure: SocketFailure) => void,
	): void {
		const { principal, match, request } = admission;
		upgrade(message, stream, head, match.maxPayload, (socket) => {
			const closed = new AbortController();
			const seal = (): void => closed.abort(new Error("http: the socket closed"));
			socket.once("close", seal);
			this.#keep({ socket, allowed: admission.allowed, relay: admission.relay, handler: match.handler, seal });
			heartbeat(socket);
			const scope = withAbortSignal(closed.signal, withoutAbortSignal(context));
			const run = async (ctx: Ctx<P>): Promise<void> => {
				try {
					await match.handler(socket, request, ctx);
				} catch (error) {
					failed({ pattern: match.pattern, plugin: match.plugin, error });
					socket.close(1011, "internal error");
					return;
				}
				if (!closed.signal.aborted) {
					await new Promise((resolve) => closed.signal.addEventListener("abort", resolve, { once: true }));
				}
			};
			// The scope sealed (its socket closed, the host closing) is no failure of the handler.
			void host.root(run, scope, { principal }).catch(() => {});
		});
	}

	/**
	 * The router changed: connections through a host or a relay no longer there, and plugin sockets whose handler left,
	 * are terminated at once and their scopes sealed (no close handshake a peer could ignore).
	 */
	revoke(router: Router): void {
		for (const upgraded of this.#open) {
			const gone =
				(upgraded.allowed !== undefined && !router.hosts.has(upgraded.allowed)) ||
				(upgraded.relay !== undefined && !router.relays.includes(upgraded.relay)) ||
				(upgraded.handler !== undefined && !router.socketHandlers.has(upgraded.handler));
			if (gone) end(upgraded);
		}
	}

	/** Closes every connection (1001, "going away"); those still open at `deadline` are terminated. */
	async close(deadline: Promise<void>): Promise<void> {
		const open = [...this.#open];
		const closed = open.map(
			({ socket }) =>
				new Promise<void>((resolve) => {
					if (socket.readyState === socket.CLOSED) resolve();
					else socket.once("close", () => resolve());
				}),
		);
		for (const { socket } of open) socket.close(1001, "going away");
		await Promise.race([Promise.all(closed), deadline]);
		for (const upgraded of this.#open) end(upgraded);
	}

	/** Keeps `upgraded` until its socket closes; an error (an oversized frame) terminates only that socket. */
	#keep(upgraded: Upgraded): void {
		const { socket } = upgraded;
		socket.on("error", () => socket.terminate());
		this.#open.add(upgraded);
		socket.once("close", () => this.#open.delete(upgraded));
	}
}

/**
 * Completes the upgrade with a `ws` server of its own (no listener, no client tracking, no compression), dropped with
 * the upgrade: nothing is kept per frame size.
 */
function upgrade(
	message: IncomingMessage,
	stream: Duplex,
	head: Buffer,
	maxPayload: number,
	then: (socket: WebSocket) => void,
): void {
	const server = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload, perMessageDeflate: false });
	server.handleUpgrade(message, stream, head, then);
}

/** Terminates `upgraded` and seals its scope at once. */
function end(upgraded: Upgraded): void {
	// Terminated first: a link's close would send a close frame.
	upgraded.socket.terminate();
	upgraded.seal();
}

/** Silence after which a plugin socket is pinged, and after the ping terminated: 15 s each (the link heartbeat's). */
const SILENCE = 15_000;

/**
 * Keeps a plugin socket honest (decision "plugin sockets get a heartbeat"): after 15 s without a frame from the peer it
 * is pinged, after 15 s more terminated; browsers and `ws` answer pings by themselves.
 */
function heartbeat(socket: WebSocket): void {
	let pinged = false;
	const timer = setTimeout(() => {
		if (pinged) {
			socket.terminate();
			return;
		}
		pinged = true;
		socket.ping();
		timer.refresh();
	}, SILENCE);
	timer.unref();
	const heard = (): void => {
		pinged = false;
		timer.refresh();
	};
	socket.on("message", heard);
	socket.on("pong", heard);
	socket.on("ping", heard);
	socket.once("close", () => clearTimeout(timer));
}

/** Unsent data beyond the frame being sent at which a link socket is cut off: a client that stopped reading. */
const MAX_UNSENT_BYTES = 4 * 1024 * 1024;

/**
 * `socket` as the link sees it, its output capped (p2's `limitedSocket`): before each send, what is still buffered
 * beyond the largest frame being sent must stay under 4 MiB, or the socket is terminated (the client reconnects from
 * snapshots); Chord's flow control keeps a reading client far below it.
 */
export function limitedSocket(socket: WebSocket): WebSocketLike {
	const unsent = new Set<{ readonly bytes: number }>();
	return {
		get readyState() {
			return socket.readyState;
		},
		get binaryType() {
			return socket.binaryType;
		},
		set binaryType(type: string) {
			socket.binaryType = type as WebSocket["binaryType"];
		},
		send(data) {
			if (socket.readyState !== socket.OPEN) return;
			let sending = 0;
			for (const frame of unsent) sending = Math.max(sending, frame.bytes);
			if (socket.bufferedAmount - sending > MAX_UNSENT_BYTES) {
				socket.terminate();
				return;
			}
			// The largest server frame header is 10 bytes.
			const frame = { bytes: data.byteLength + 10 };
			unsent.add(frame);
			socket.send(data, (error) => {
				unsent.delete(frame);
				if (error) socket.terminate();
			});
		},
		close: () => socket.close(),
		addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.addEventListener(type as "message", listener as never),
		removeEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.removeEventListener(type as "message", listener as never),
	} as WebSocketLike;
}
