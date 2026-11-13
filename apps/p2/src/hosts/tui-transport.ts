// How the launcher reaches its server: HTTP requests and the chord WebSocket, directly with a cookie or through Radius
// (tui-radius.ts). Credentials stay inside a transport; callers name only paths on the server.
import { WebSocket } from "ws";
import { connectionHeaders, type TuiCredentials } from "./tui-config.ts";

/** Chord link frames and every queued message are bounded by this. */
export const MAX_LINK_FRAME = 4 * 1024 * 1024;

export type TuiRequestInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | AsyncIterable<Uint8Array>;
	signal: AbortSignal;
};

export type TuiSocketEvents = {
	open(): void;
	message(data: Buffer, binary: boolean): void;
	/** The server refused the WebSocket with this HTTP status; `close` follows. */
	refused(status: number): void;
	close(): void;
};

export type TuiSocket = {
	readonly open: boolean;
	send(data: Uint8Array): void;
	terminate(): void;
};

/** The launcher's link to one server. Redirects are refused. */
export type TuiTransport = {
	request(path: string, init: TuiRequestInit): Promise<Response>;
	socket(path: string, events: TuiSocketEvents): TuiSocket;
};

/** Direct requests to `url`'s origin with the launcher's exact Origin and its cookie, if any. */
export function cookieTransport(url: URL, credentials: TuiCredentials): TuiTransport {
	const headers = connectionHeaders(url, credentials);
	return {
		request: (path, init) =>
			fetch(new URL(path, url), {
				method: init.method,
				headers: { ...headers, ...init.headers },
				body: init.body as BodyInit | undefined,
				redirect: "error",
				signal: init.signal,
				// Node's fetch needs this for a streamed request body.
				...(init.body && Symbol.asyncIterator in Object(init.body) ? { duplex: "half" } : {}),
			} as RequestInit),
		socket: (path, events) => {
			const target = new URL(path, url);
			target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(target, {
				headers,
				maxPayload: MAX_LINK_FRAME,
				handshakeTimeout: 10_000,
				followRedirects: false,
			});
			socket.on("open", () => events.open());
			socket.on("message", (data: Buffer, binary) => events.message(data, binary));
			socket.on("error", () => {});
			socket.on("unexpected-response", (_request, response) => {
				response.resume();
				socket.terminate();
				events.refused(response.statusCode ?? 502);
			});
			socket.on("close", () => events.close());
			return {
				get open() {
					return socket.readyState === WebSocket.OPEN;
				},
				send: (data) => socket.send(data),
				terminate: () => socket.terminate(),
			};
		},
	};
}
