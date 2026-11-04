// HTTP helpers shared by the server's routes (Node).
import type { IncomingMessage, ServerResponse } from "node:http";

/** A JSON response: the status, `Content-Type`, then `headers` (a `Set-Cookie`, say), and the body as JSON. */
export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, { "Content-Type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

/** The value of the request's cookie `name` (the first one), if it carries one. */
export function cookieValue(request: IncomingMessage, name: string): string | undefined {
	const prefix = `${name}=`;
	return (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
}

/**
 * A state-changing request from a page of this origin: exactly its `Origin` header, which a cross-site form or fetch
 * cannot send. (A missing `Origin` does not count.)
 */
export const fromOrigin = (request: IncomingMessage, origin: { readonly origin: string }): boolean =>
	request.headers.origin === origin.origin;
