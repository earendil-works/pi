/**
 * RFC 6455 server-side handshake for the PiServer WS transport.
 *
 * The Node HTTP server performs the request parsing; this module validates the
 * Upgrade request and produces the 101 Switching Protocols response bytes.
 */

import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WsHandshakeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WsHandshakeError";
	}
}

export interface WsHandshakeRequest {
	readonly headers: Record<string, string | string[] | undefined>;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	const value = headers[name];
	if (Array.isArray(value)) return value[0];
	return value;
}

/**
 * Validates an Upgrade request and returns the accept key for the response.
 * Throws WsHandshakeError when the request is not a valid WebSocket upgrade.
 */
export function prepareWsHandshake(request: WsHandshakeRequest): string {
	const upgrade = headerValue(request.headers, "upgrade");
	if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
		throw new WsHandshakeError("Request is not a WebSocket upgrade");
	}
	const connection = headerValue(request.headers, "connection");
	if (typeof connection !== "string" || !connection.toLowerCase().includes("upgrade")) {
		throw new WsHandshakeError("Connection header does not include upgrade");
	}
	const key = headerValue(request.headers, "sec-websocket-key");
	if (typeof key !== "string" || key.length === 0) {
		throw new WsHandshakeError("Missing Sec-WebSocket-Key header");
	}
	const version = headerValue(request.headers, "sec-websocket-version");
	if (version !== "13") {
		throw new WsHandshakeError(`Unsupported Sec-WebSocket-Version: ${version ?? "missing"}`);
	}
	const accept = createHash("sha1")
		.update(key + WEBSOCKET_GUID)
		.digest("base64");
	return accept;
}

/** Builds the 101 Switching Protocols response bytes for an accept key. */
export function buildWsHandshakeResponse(acceptKey: string): Uint8Array {
	const head = [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${acceptKey}`,
		"",
		"",
	].join("\r\n");
	return new TextEncoder().encode(head);
}
