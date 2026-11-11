import type { IncomingMessage } from "node:http";
import type { RequestOrigin } from "../runtime/server.ts";

/** Historical wire name; ANY value marks a proxied request. It is not an authentication secret. */
export const PROXY_MARKER_HEADER = "x-p2-proxy-secret";

/** Hosts reachable through a trusted HTTPS tunnel, e.g. `P2_ALLOWED_HOSTS=p2.example.ngrok.app`. */
export function parseAllowedHosts(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Where a request came from. The server listens on loopback only. Local hosts are served over http; an allowed tunnel
 * host is https (the tunnel terminates TLS; app authentication gates access). Any other Host header is refused (DNS
 * rebinding), and forwarded requests never pass as local.
 */
export function requestOrigin(request: IncomingMessage, allowedHosts: readonly string[]): RequestOrigin | undefined {
	const port = request.socket.localPort ?? 0;
	if (request.socket.localAddress !== "127.0.0.1") return undefined;
	const host = request.headers.host?.toLowerCase() ?? "";
	if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) {
		if (
			request.headers[PROXY_MARKER_HEADER] !== undefined ||
			request.headers["x-forwarded-for"] ||
			request.headers["x-forwarded-host"] ||
			request.headers["x-forwarded-proto"] ||
			request.headers.forwarded
		)
			return undefined;
		return { origin: `http://${host}`, remote: false, port };
	}
	if (allowedHosts.includes(host)) return { origin: `https://${host}`, remote: true, port };
	return undefined;
}

/** A browser request from another origin (a cross-site form, fetch or WebSocket) is refused. */
export const sameOrigin = (request: IncomingMessage, origin: RequestOrigin): boolean =>
	request.headers.origin === undefined || request.headers.origin === origin.origin;

const FRAMES: ReadonlySet<string> = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/**
 * Whether a browser sent this request for another site (Fetch Metadata): a cross-site or same-site (another local port)
 * page, link, form, fetch or WebSocket, or a frame or embed another site holds. Such a request never gets the loopback
 * owner: a page anywhere could otherwise frame the owner UI (clickjacking) or drive it. Requests without the headers
 * (the TUI, scripts, older browsers) are unaffected; the page's CSP `frame-ancestors` still refuses framing there.
 */
export function foreignBrowserRequest(request: IncomingMessage): boolean {
	const site = request.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") return true;
	const dest = request.headers["sec-fetch-dest"];
	return typeof dest === "string" && FRAMES.has(dest) && site !== "same-origin";
}

/**
 * App pages a link may open: the app, a session or conversation, a sidebar list, the new-session screen, a share's join
 * page, owner sign-in.
 */
const PAGE = /^\/(?:$|s\/|list\/|new$|join\/|owner$)/;

/**
 * A top-level page load (link, address bar, bookmark, home-screen app launch): the only foreign browser request that
 * may authenticate. It cannot read anything back into the foreign page, and opens the app as usual. Only browsers set
 * `navigate` (a page's fetch cannot); frames say `iframe`/`frame`. Chrome on Android launches an installed app (WebAPK)
 * with `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Dest: empty` and no cookies, so `empty` counts as a document too.
 */
export function pageNavigation(request: IncomingMessage): boolean {
	const dest = request.headers["sec-fetch-dest"];
	return (
		request.method === "GET" &&
		request.headers["sec-fetch-mode"] === "navigate" &&
		(dest === "document" || dest === "empty") &&
		PAGE.test(new URL(request.url ?? "/", "http://localhost").pathname)
	);
}

/**
 * The CSP of every response (as Pi Mobile's): the app's own scripts (the page's inline ones carry the nonce), its
 * WebSocket, and frames only from its own origin (artifact previews). Nothing may frame it but the Radius shell
 * that relays it.
 */
export function contentSecurityPolicy(nonce: string, origin: RequestOrigin | undefined): string {
	const socketOrigin = origin?.origin.replace(/^http/, "ws") ?? "";
	return [
		"default-src 'none'",
		`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
		`connect-src 'self' ${socketOrigin}`.trimEnd(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"font-src 'self' data:",
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"frame-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors ${origin?.relayShellOrigin ?? "'none'"}`,
	].join("; ");
}
