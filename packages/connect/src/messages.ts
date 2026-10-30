// The messages between an app and pi.dev's sign-in popup, sent with window.postMessage.

import type { OAuthCredential } from "@earendil-works/pi-ai";

/**
 * 1. The app opens `<pi.dev>/connect` with `window.open` and listens for messages from that window.
 * 2. The popup sends `ready` to its opener with target origin "*"; it carries nothing.
 * 3. The app answers `hello` with target origin pi.dev's: provider, method, a nonce, and whether it
 *    allows manual sign-ins.
 * 4. The popup takes the app's origin from the `hello` event. The browser sets `event.origin`, so the
 *    page cannot claim another. The popup shows that origin, runs the sign-in and sends `credential`,
 *    `error` or `cancelled` to that origin only.
 *
 * The app accepts only messages from the window it opened, from pi.dev's origin, with its nonce.
 */
export const CONNECT_PROTOCOL = "pi-connect/1";

/** From the app to the popup. */
export interface HelloMessage {
	protocol: typeof CONNECT_PROTOCOL;
	type: "hello";
	nonce: string;
	provider: string;
	method: string;
	manual: boolean;
}

/** From the popup to the app. */
export type PopupMessage =
	| { protocol: typeof CONNECT_PROTOCOL; type: "ready" }
	| { protocol: typeof CONNECT_PROTOCOL; type: "credential"; nonce: string; credential: OAuthCredential }
	| { protocol: typeof CONNECT_PROTOCOL; type: "error"; nonce: string; message: string }
	| { protocol: typeof CONNECT_PROTOCOL; type: "cancelled"; nonce: string };

/** Parse a message the popup received (wire input from any page that opened it). */
export function parseHelloMessage(data: unknown): HelloMessage | undefined {
	if (!isProtocolMessage(data) || data.type !== "hello") return undefined;
	const { nonce, provider, method, manual } = data;
	if (typeof nonce !== "string" || typeof provider !== "string" || typeof method !== "string") return undefined;
	if (typeof manual !== "boolean") return undefined;
	return { protocol: CONNECT_PROTOCOL, type: "hello", nonce, provider, method, manual };
}

/** Parse a message the app received from the popup (wire input across origins). */
export function parsePopupMessage(data: unknown): PopupMessage | undefined {
	if (!isProtocolMessage(data)) return undefined;
	if (data.type === "ready") return { protocol: CONNECT_PROTOCOL, type: "ready" };
	if (typeof data.nonce !== "string") return undefined;
	const nonce = data.nonce;
	switch (data.type) {
		case "credential":
			return isOAuthCredential(data.credential)
				? { protocol: CONNECT_PROTOCOL, type: "credential", nonce, credential: data.credential }
				: undefined;
		case "error":
			return typeof data.message === "string"
				? { protocol: CONNECT_PROTOCOL, type: "error", nonce, message: data.message }
				: undefined;
		case "cancelled":
			return { protocol: CONNECT_PROTOCOL, type: "cancelled", nonce };
		default:
			return undefined;
	}
}

function isProtocolMessage(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null && (data as { protocol?: unknown }).protocol === CONNECT_PROTOCOL;
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
	if (typeof value !== "object" || value === null) return false;
	const credential = value as Record<string, unknown>;
	return (
		credential.type === "oauth" &&
		typeof credential.access === "string" &&
		typeof credential.refresh === "string" &&
		typeof credential.expires === "number"
	);
}
