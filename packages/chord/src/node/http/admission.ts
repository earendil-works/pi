// Admission (slice 10 §2, R4; decision "The HTTP component's security baseline" (1)-(3), "Relays"): where a request
// comes from, decided before anything else. Local only when the connection arrived on a loopback address, its `Host`
// is a loopback name with the listening port, and it carries no forwarded header; a forwarded request on loopback only
// when a contributed relay verifies it; otherwise only through an allowed host (https); else refused. Foreign requests
// (another site's, by Fetch Metadata) and a foreign `Origin` are classified here; the handler applies them per route.

import type { Incoming } from "./incoming.ts";
import type { HttpRelay } from "./router.ts";

/** Where an admitted request came from. */
export type Provenance =
	| { readonly kind: "local" }
	| { readonly kind: "remote"; readonly host: string }
	| { readonly kind: "relayed"; readonly relay: string; readonly origin: string };

/** The connection a request arrived on, as its listener knows it (a mounted handler passes what it has). */
export type Connection = {
	readonly localAddress?: string;
	readonly localPort?: number;
	readonly remoteAddress?: string;
};

/** An admitted request: its provenance, its own origin, the origin allowed to frame it (a relay's), how it came. */
export type Admitted = {
	readonly provenance: Provenance;
	readonly origin: string;
	readonly framer: string | undefined;
	/** The allowed host it came through: its connections end when that host leaves. */
	readonly allowed: string | undefined;
	/** The relay that verified it: its connections end when that relay leaves. */
	readonly relay: HttpRelay | undefined;
};

/** What admission refuses, and the relay hook that threw (reported by the caller). */
export type Refused = {
	readonly kind: "refused";
	readonly failed?: { readonly relay: string; readonly error: unknown };
};

/**
 * Admits `request` arriving on `connection` with the allowed `hosts` and contributed `relays`, or refuses it (403):
 * no or several `Host`s, a host neither loopback nor allowed, a loopback `Host` on another connection, forwarded
 * headers no relay verifies.
 */
export function admit(
	request: Incoming,
	connection: Connection,
	hosts: ReadonlySet<string>,
	relays: readonly HttpRelay[],
): Admitted | Refused {
	const host = request.header("host")?.toLowerCase();
	// Several `Host` headers arrive joined with commas.
	if (host === undefined || host === "" || host.includes(",")) return REFUSED;
	const { localAddress, localPort } = connection;
	if (isLoopbackName(host, localPort)) {
		if (localAddress === undefined || !isLoopbackAddress(localAddress)) return REFUSED;
		if (!request.forwarded())
			return {
				provenance: LOCAL,
				origin: `http://${host}`,
				framer: undefined,
				allowed: undefined,
				relay: undefined,
			};
		return relayed(request, relays);
	}
	if (!hosts.has(host)) return REFUSED;
	return {
		provenance: { kind: "remote", host },
		origin: `https://${host}`,
		framer: undefined,
		allowed: host,
		relay: undefined,
	};
}

/** What the Fetch Metadata and `Origin` checks read: a request's headers by name. */
export type HeaderSource = Pick<Incoming, "header">;

/** Whether `admission` refused its request. */
export function refused(admission: Admitted | Refused): admission is Refused {
	return "kind" in admission;
}

/**
 * Whether a request is another site's (Fetch Metadata, p2's rule): `Sec-Fetch-Site` neither `same-origin` nor `none`,
 * or a frame or embed not from this origin. A request without the headers (a script, the TUI) is not.
 */
export function isForeign(headers: HeaderSource): boolean {
	const site = headers.header("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return true;
	return site !== "same-origin" && FRAMES.has(headers.header("sec-fetch-dest") ?? "");
}

/**
 * Whether a foreign request is a top-level navigation (a link followed to a page): `GET`, `navigate`, a `document` (or
 * `empty`: Chrome on Android launching an installed app).
 */
export function isNavigation(method: string, headers: HeaderSource): boolean {
	const dest = headers.header("sec-fetch-dest");
	return (
		method === "GET" && headers.header("sec-fetch-mode") === "navigate" && (dest === "document" || dest === "empty")
	);
}

/**
 * Whether `headers`' `Origin` is acceptable for a request whose own origin is `origin`: absent or equal, and for an
 * unsafe method from a browser (one sending Fetch Metadata) present and equal.
 */
export function originAccepted(method: string, headers: HeaderSource, origin: string): boolean {
	const sent = headers.header("origin");
	if (sent !== null) return sent === origin;
	return SAFE.has(method) || headers.header("sec-fetch-site") === null;
}

const REFUSED: Refused = { kind: "refused" };

const LOCAL: Provenance = { kind: "local" };

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** Whether `host` (lowercased) names this server on loopback with `port` (without it on port 80). */
function isLoopbackName(host: string, port: number | undefined): boolean {
	if (port === undefined) return false;
	for (const name of LOOPBACK_NAMES) {
		if (host === `${name}:${port}`) return true;
		if (port === 80 && host === name) return true;
	}
	return false;
}

/** Whether `address` is a loopback address: 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
function isLoopbackAddress(address: string): boolean {
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** A forwarded request on loopback: admitted as relayed when a relay verifies it, else refused. */
function relayed(request: Incoming, relays: readonly HttpRelay[]): Admitted | Refused {
	for (const relay of relays) {
		let verified: ReturnType<HttpRelay["verify"]>;
		try {
			verified = relay.verify(request.request());
		} catch (error) {
			return { kind: "refused", failed: { relay: relay.name, error } };
		}
		if (verified === undefined) continue;
		// Its origins reach the CSP: each must be one origin and nothing else (Fable's recheck N2).
		for (const origin of [verified.origin, verified.framer]) {
			if (origin === undefined || isOrigin(origin)) continue;
			const error = new Error(`relay ${relay.name}: ${JSON.stringify(origin)} is no origin`);
			return { kind: "refused", failed: { relay: relay.name, error } };
		}
		return {
			provenance: { kind: "relayed", relay: relay.name, origin: verified.origin },
			origin: verified.origin,
			framer: verified.framer,
			allowed: undefined,
			relay,
		};
	}
	return REFUSED;
}

/** Whether `text` is exactly an origin (`https://host[:port]`): what the URL parser serializes it to. */
function isOrigin(text: string): boolean {
	try {
		const url = new URL(text);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text;
	} catch {
		return false;
	}
}

/** The `Sec-Fetch-Dest` of a frame or an embed. */
const FRAMES: ReadonlySet<string> = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/** The methods that change nothing. */
const SAFE: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
