// Chord's own Node server (decision "The HTTP server is a native object"; "The HTTP core is a fetch handler; Chord's
// own Node server is the easy path"): the listener's native, a Node `http` server that hands each request to the
// component as it reads requests (origin-form targets only; a Web `Request` made only when something asks for one, its
// body streamed with backpressure), and writes its answer: whole, or pulled piece by piece as the socket drains. A body the route left unread is drained after the
// response when small, else the connection closes; the request's scope ends once the response is flushed or abandoned.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "../../context/index.ts";
import type { Connection } from "./admission.ts";
import { type Incoming, isForwarding } from "./incoming.ts";
import type { Answer } from "./response.ts";
import { UNCARRIED } from "./router.ts";

/** Where a listener listens. */
export type ListenAddress = { readonly host: string; readonly port: number };

/** An answer and what its consumer calls once the body is written or abandoned (the request's scope then ends). */
export type Served = { readonly answer: Answer; readonly finished: () => void };

/** What the listener needs of the component. */
export interface Handler {
	/** Serves a request: never throws. */
	serve(incoming: Incoming, connection: Connection): Promise<Served>;
	/** The answer for a request refused before it could be made one (default headers only). */
	refusal(status: number): Answer;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** The listener's native value: a listening Node server. */
export class NodeListener {
	readonly address: ListenAddress;
	readonly #server: Server;
	readonly #closed: Promise<void>;

	private constructor(server: Server, address: ListenAddress) {
		this.#server = server;
		this.address = address;
		this.#closed = new Promise((resolve) => server.once("close", () => resolve()));
	}

	/** A Node server for `handler` listening at `listen`; rejects with the listen error (a port in use). */
	static async listen(handler: Handler, listen: ListenAddress, context: Context): Promise<NodeListener> {
		const server = createServer((message, res) => {
			void request(handler, message, res).catch(() => res.destroy());
		});
		server.on("upgrade", handler.upgrade);
		await new Promise<void>((resolve, reject) => {
			const failed = (error: Error): void => reject(error);
			server.once("error", failed);
			server.listen(listen.port, listen.host, () => {
				server.removeListener("error", failed);
				resolve();
			});
		});
		if (context.abortSignal?.aborted) {
			server.close();
			throw context.abortSignal.reason;
		}
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : listen.port;
		return new NodeListener(server, { host: listen.host, port });
	}

	/** Stops accepting connections and closes the idle ones (the component's close runs next). */
	stop(): void {
		this.#server.close();
		this.#server.closeIdleConnections();
	}

	/** Closes every connection still open and resolves once the server closed. */
	async closed(): Promise<void> {
		this.#server.close();
		this.#server.closeAllConnections();
		await this.#closed;
	}
}

/**
 * A Node request as the component reads it: Node's parsed headers, its URL parsed once, the Web `Request` made only
 * when something asks for it (a route's `headers` or body, a relay).
 */
export class NodeIncoming implements Incoming {
	readonly method: string;
	readonly url: string;
	readonly #message: IncomingMessage;
	/** The response, to notice a client gone (none for an upgrade). */
	readonly #res: ServerResponse | undefined;
	#request: Request | undefined;

	private constructor(message: IncomingMessage, url: string, res: ServerResponse | undefined) {
		this.method = message.method ?? "GET";
		this.url = url;
		this.#message = message;
		this.#res = res;
	}

	/**
	 * `message` as the component reads it, or what refuses it at the wire (the listener and `nodeRequest` alike): an
	 * absolute-form target 403, a target that does not parse 400, a `Host` with userinfo 403 (never a loopback or
	 * allowed name), a method a Web `Request` cannot carry (`CONNECT`, `TRACE`, `TRACK`) 501: served for no resource.
	 */
	static of(message: IncomingMessage, res?: ServerResponse): NodeIncoming | WireRefusal {
		const target = message.url ?? "";
		// Only origin-form targets: an absolute-form one names an authority of its own, `*` none.
		if (!target.startsWith("/")) return { kind: "refused", status: 403 };
		if (UNCARRIED.has(message.method ?? "GET")) return { kind: "refused", status: 501 };
		let url: URL;
		try {
			// The authority is the `Host` the client sent; admission checks it, so a strange one parses but is refused.
			url = new URL(`http://${message.headers.host ?? "invalid"}${target}`);
		} catch {
			return { kind: "refused", status: 400 };
		}
		if (url.username !== "" || url.password !== "") return { kind: "refused", status: 403 };
		return new NodeIncoming(message, url.href, res);
	}

	header(name: string): string | null {
		return this.#message.headersDistinct[name]?.join(", ") ?? null;
	}

	forwarded(): boolean {
		for (const name in this.#message.headersDistinct) if (isForwarding(name)) return true;
		return false;
	}

	cancelled(abort: (reason: unknown) => void): void {
		const res = this.#res;
		if (res === undefined) return;
		const gone = (): void => abort(new Error("http: the client disconnected"));
		if (res.closed) gone();
		else res.once("close", () => res.writableFinished || gone());
	}

	request(): Request {
		this.#request ??= webRequestOf(this.#message, this.url);
		return this.#request;
	}
}

/** What refuses a Node request at the wire, with its status. */
export type WireRefusal = { readonly kind: "refused"; readonly status: 400 | 403 | 501 };

/** A Node request as an app mounting `fetch` on its own Node server gets it: a Web `Request`, or refused. */
export type NodeRequest =
	| { readonly kind: "request"; readonly request: Request; readonly connection: Connection }
	| WireRefusal;

/**
 * Converts `message` for `http.fetch` on an app's own Node server, the whole conversion being the wire boundary: what
 * the listener refuses is refused with the same status (`NodeIncoming.of`), any other construction failure 400, never a
 * throw (Sol's rechecks N6 and A: a hand-made `Request` crashed the app on a malformed target, `TRACE /` or
 * `Host: user@…`). Raw headers keep their duplicates (two `Host`s: admission refuses); the signal aborts when the
 * client goes away before `res` finished.
 */
export function nodeRequest(message: IncomingMessage, res: ServerResponse): NodeRequest {
	const incoming = NodeIncoming.of(message, res);
	if (!(incoming instanceof NodeIncoming)) return incoming;
	const gone = new AbortController();
	incoming.cancelled((reason) => gone.abort(reason));
	let request: Request;
	try {
		request = webRequestOf(message, incoming.url, gone.signal);
	} catch {
		return { kind: "refused", status: 400 };
	}
	return { kind: "request", request, connection: connectionOf(message) };
}

/**
 * The Web `Request` of `message` at `url`: its raw headers (duplicates kept), its body streamed when it has one, and
 * `signal` when the caller follows the client.
 */
function webRequestOf(message: IncomingMessage, url: string, signal?: AbortSignal): Request {
	const headers = new Headers();
	const raw = message.rawHeaders;
	for (let index = 0; index < raw.length; index += 2) headers.append(raw[index]!, raw[index + 1]!);
	const method = message.method ?? "GET";
	const init: RequestInit & { duplex?: "half" } = { method, headers, ...(signal === undefined ? {} : { signal }) };
	if (hasBody(message) && method !== "GET" && method !== "HEAD") {
		init.body = bodyOf(message);
		init.duplex = "half";
	}
	return new Request(url, init);
}

/** What a Node socket knows of its connection. */
export function connectionOf(message: IncomingMessage): Connection {
	const { localAddress, localPort, remoteAddress } = message.socket;
	return {
		...(localAddress === undefined ? {} : { localAddress }),
		...(localPort === undefined ? {} : { localPort }),
		...(remoteAddress === undefined ? {} : { remoteAddress }),
	};
}

/** One request: served (an absolute-form target: 403; a URL that does not parse: 400), its answer written. */
async function request(handler: Handler, message: IncomingMessage, res: ServerResponse): Promise<void> {
	const incoming = NodeIncoming.of(message, res);
	if (!(incoming instanceof NodeIncoming)) {
		return write(message, res, { answer: handler.refusal(incoming.status), finished: () => {} });
	}
	await write(message, res, await handler.serve(incoming, connectionOf(message)));
}

/** What `json` and `body` leave unread that is drained after the response, keeping the connection: 64 KiB. */
const DRAIN_LIMIT = 64 * 1024;

/** Writes `served`'s answer to `res`; what is left of the request's body is drained after it or closes the connection. */
async function write(message: IncomingMessage, res: ServerResponse, { answer, finished }: Served): Promise<void> {
	// A client gone before its answer: nothing to write.
	if (res.closed) return finished();
	res.once("close", finished);
	const left = message.complete || !hasBody(message) ? "none" : declared(message) <= DRAIN_LIMIT ? "drain" : "close";
	const headers: string[] = [];
	for (const [name, value] of answer.headers.lines()) headers.push(name, value);
	if (left === "close") headers.push("connection", "close");
	res.writeHead(answer.status, headers);
	const { body } = answer;
	if (body instanceof ReadableStream) await pump(body, res);
	else res.end(body ?? undefined);
	if (left === "drain") drain(message);
}

/** Writes `body` to `res` as the socket drains; a body that fails (reported by the component) destroys the connection. */
async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
	const reader = body.getReader();
	const cancel = (): void => void reader.cancel().catch(() => {});
	res.once("close", cancel);
	for (;;) {
		let next: Awaited<ReturnType<typeof reader.read>>;
		try {
			next = await reader.read();
		} catch {
			res.destroy();
			return;
		}
		if (next.done) break;
		if (res.destroyed) return;
		if (!res.write(next.value)) await drained(res);
	}
	res.removeListener("close", cancel);
	res.end();
}

/** Resolves once `res` drained or closed. */
function drained(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			res.removeListener("drain", done);
			res.removeListener("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}

/** A request body as a Web stream: read as its consumer pulls (the socket paused meanwhile); a disconnect errors it. */
function bodyOf(message: IncomingMessage): ReadableStream<Uint8Array> {
	// Whether the stream still takes chunks (not ended, errored or cancelled).
	let open = true;
	return new ReadableStream<Uint8Array>(
		{
			start: (controller) => {
				message.on("data", (chunk: Buffer) => {
					if (!open) return;
					controller.enqueue(chunk);
					if ((controller.desiredSize ?? 0) <= 0) message.pause();
				});
				message.once("end", () => {
					if (open) controller.close();
					open = false;
				});
				message.once("close", () => {
					if (open && !message.complete) controller.error(new Error("http: the client disconnected"));
					open = false;
				});
				message.pause();
			},
			pull: () => {
				message.resume();
			},
			// The rest stays unread: the response closes the connection (or drains a small rest).
			cancel: () => {
				open = false;
				message.pause();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: DRAIN_LIMIT }),
	);
}

/** Reads and drops the rest of the body (at most 64 KiB); more than that, or an error, closes the connection. */
function drain(message: IncomingMessage): void {
	let read = 0;
	message.on("data", (chunk: Buffer) => {
		read += chunk.byteLength;
		if (read > DRAIN_LIMIT) message.socket.destroy();
	});
	message.on("error", () => message.socket.destroy());
	message.resume();
}

/** Whether `message` carries a body (a declared length above zero, or chunked). */
function hasBody(message: IncomingMessage): boolean {
	const length = message.headers["content-length"];
	if (length !== undefined) return Number(length) > 0;
	return message.headers["transfer-encoding"] !== undefined;
}

/** The declared length of `message`'s body; infinite when chunked. */
function declared(message: IncomingMessage): number {
	const length = Number(message.headers["content-length"] ?? Number.NaN);
	return Number.isFinite(length) ? length : Number.POSITIVE_INFINITY;
}
