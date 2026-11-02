// Requests (slice 10 §2, D4): what a route, a wrap, a socket handler and an authenticator see of an HTTP request (a
// Web `Request` once admitted), and its body, read only when asked: `json(limit?)` (1 MiB by default, malformed 400,
// too large 413) and `body(limit?)`, an async iterable of chunks.

import type { JsonValue } from "../../json.ts";
import type { Provenance } from "./admission.ts";
import type { Incoming } from "./incoming.ts";

/** A request as routes see it, once admitted: `origin` and `provenance` come only from admission. */
export interface HttpRequest {
	readonly method: string;
	/** The path, without the query, percent-encoded, its dot segments resolved (by the URL parser). */
	readonly path: string;
	/** The matched pattern's params, percent-decoded (`*` for the rest of a `/*` pattern). */
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	/** The request's headers; read only. */
	readonly headers: Headers;
	/** `http://<host>` on loopback, `https://<host>` for an allowed host, a relay's origin for a relayed request. */
	readonly origin: string;
	/** Where it came from (decision "The HTTP component's security baseline" (1), "Relays"). */
	readonly provenance: Provenance;
	/** The server's script nonce: a page's inline scripts carry it (`<script nonce="…">`), the CSP allows them. */
	readonly nonce: string;
	/** The body as JSON, at most `limit` bytes (1 MiB by default): `HttpFailure` 400 when malformed, 413 when larger. */
	json(limit?: number): Promise<JsonValue>;
	/** The body's chunks, at most `limit` bytes (1 MiB by default): `HttpFailure` 413 past it, 400 when cut short. */
	body(limit?: number): AsyncIterable<Uint8Array>;
}

/** A failure that answers its request with `status` when it escapes a route (400 malformed, 413 too large). */
export class HttpFailure extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpFailure";
		this.status = status;
	}
}

/** What `json` and `body` read unless a route says otherwise: 1 MiB. */
const DEFAULT_LIMIT = 1024 * 1024;

/** The params of a request no pattern matched (yet). */
const NO_PARAMS: Readonly<Record<string, string>> = {};

/** A request over what the component reads of it; the component sets its params once it matched a route. */
export class WebRequest implements HttpRequest {
	readonly method: string;
	readonly path: string;
	params: Readonly<Record<string, string>> = NO_PARAMS;
	readonly origin: string;
	readonly provenance: Provenance;
	readonly nonce: string;
	readonly #incoming: Incoming;
	/** The query string (without `?`), parsed when first read. */
	readonly #search: string;
	#query: URLSearchParams | undefined;
	/** Whether a reader took the body (it is read once). */
	#taken = false;

	constructor(
		incoming: Incoming,
		admitted: { readonly origin: string; readonly provenance: Provenance },
		nonce: string,
	) {
		this.method = incoming.method;
		// The URL is parsed and serialized already (dot segments resolved, `\` as `/`): only split it here.
		const { path, search } = splitUrl(incoming.url);
		this.path = path;
		this.#search = search;
		this.origin = admitted.origin;
		this.provenance = admitted.provenance;
		this.nonce = nonce;
		this.#incoming = incoming;
	}

	/** The headers: on Chord's Node server the Web `Request` is made only when something reads them. */
	get headers(): Headers {
		return this.#incoming.request().headers;
	}

	get query(): URLSearchParams {
		this.#query ??= new URLSearchParams(this.#search);
		return this.#query;
	}

	async json(limit = DEFAULT_LIMIT): Promise<JsonValue> {
		const chunks: Uint8Array[] = [];
		for await (const chunk of this.body(limit)) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return JSON.parse(text) as JsonValue;
		} catch {
			throw new HttpFailure(400, "the body is no JSON");
		}
	}

	async *body(limit = DEFAULT_LIMIT): AsyncIterable<Uint8Array> {
		if (this.#taken) throw new Error("request body: read twice");
		this.#taken = true;
		const declared = Number(this.#incoming.header("content-length") ?? Number.NaN);
		if (declared > limit) throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
		const stream = this.#incoming.request().body;
		if (stream === null) return;
		const reader = stream.getReader();
		let read = 0;
		try {
			for (;;) {
				let next: Awaited<ReturnType<typeof reader.read>>;
				try {
					next = await reader.read();
				} catch {
					// A body cut short (a disconnect, a broken stream) is no body: a prefix must never parse as the
					// whole (Sol's recheck N4: valid JSON then an error ran the route).
					throw new HttpFailure(400, "the body could not be read whole");
				}
				if (next.done) return;
				read += next.value.byteLength;
				if (read > limit) throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
				yield next.value;
			}
		} finally {
			// Past the limit, or a reader that stopped early: the rest stays unread (its server closes the connection
			// after the response); a cancel could reset the connection before the response is written.
			reader.releaseLock();
		}
	}
}

/** A serialized URL's path (from the first `/` after the authority) and query (without `?`, no fragment). */
export function splitUrl(url: string): { readonly path: string; readonly search: string } {
	const authority = url.indexOf("//") + 2;
	let start = url.indexOf("/", authority);
	let end = url.indexOf("#", authority);
	if (end < 0) end = url.length;
	const mark = url.indexOf("?", authority);
	if (start < 0 || (mark >= 0 && start > mark)) start = -1;
	const pathEnd = mark >= 0 && mark < end ? mark : end;
	return {
		path: start < 0 ? "/" : url.slice(start, pathEnd),
		search: mark >= 0 && mark < end ? url.slice(mark + 1, end) : "",
	};
}
