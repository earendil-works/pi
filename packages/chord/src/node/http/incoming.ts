// What the component reads of a request (decision "The HTTP core is a fetch handler"): one shape for a Web `Request`
// (`fetch`) and for Chord's own Node server, so admission, routing and the baseline have one implementation. The Node
// side reads Node's own parsed headers and builds a Web `Request` only when something asks for it (a route's
// `headers` or body, a relay's `verify`).

/** A request as the component reads it. */
export interface Incoming {
	readonly method: string;
	/** The URL as the URL parser serialized it (dot segments resolved, `\` as `/`). */
	readonly url: string;
	/** A header's value, several of one name joined with `", "` (as `Headers.get`); `null` without it. */
	header(name: string): string | null;
	/** Whether a proxy forwarded it: a `Forwarded` or `X-Forwarded-*` header. */
	forwarded(): boolean;
	/** Calls `abort` once when the client goes away before its answer is written (at once when it has). */
	cancelled(abort: (reason: unknown) => void): void;
	/** The Web `Request`, made at the first call on the Node side. */
	request(): Request;
}

/** `request` as the component reads it. */
export function webIncoming(request: Request): Incoming {
	return {
		method: request.method,
		url: request.url,
		header: (name) => request.headers.get(name),
		forwarded: () => {
			for (const name of request.headers.keys()) if (isForwarding(name)) return true;
			return false;
		},
		cancelled: (abort) => {
			const { signal } = request;
			if (signal.aborted) abort(signal.reason);
			else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
		},
		request: () => request,
	};
}

/** Whether a (lowercased) header name says a proxy forwarded the request. */
export function isForwarding(name: string): boolean {
	return name === "forwarded" || name.startsWith("x-forwarded-");
}
