import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { processLogs } from "@p2/app/v1/node";
import type { RelayUser } from "@p2/app/v1/server";

/** Marks loopback requests the Radius relay client makes on behalf of a relayed browser. */
export const RELAY_SECRET_HEADER = "x-p2-relay";
/** The brain's browser-facing origin (its cortex origin), e.g. `https://<label>.rdtun.com`. */
export const RELAY_ORIGIN_HEADER = "x-p2-relay-origin";
/** The Radius shell origin that frames the brain UI. */
export const RELAY_SHELL_HEADER = "x-p2-relay-shell";
/** A Radius user other than the owner: base64url JSON `{ id, email }`. Absent for the owner. */
export const RELAY_USER_HEADER = "x-p2-relay-user";

export type RelayedRequest = { publicOrigin: string; shellOrigin: string; user?: RelayUser };

const ORIGIN = /^https?:\/\/[^/\s]+$/;

/**
 * Distinguishes requests relayed through Radius from local and tunneled ones.
 *
 * Problem: the relay client (brain.ts) serves relayed browsers by making
 * loopback requests to this server, which would otherwise look like the device
 * itself and receive localhost-only owner powers (minting owner tokens, the
 * automatic owner cookie, provider login).
 *
 * The relay client marks its loopback requests with a per-process secret. A
 * marked request comes from a browser Radius authenticated on the cortex
 * origin, and is treated as remote, so every localhost-only path stays closed.
 * Without the user header it is the brain's owner. With it, it is a person the
 * owner shared sessions with by email: Radius vouches for their email, and
 * p2's sharing decides what they may reach, as for a guest cookie on a tunnel
 * host. Without the secret the marker headers mean nothing, so neither
 * browsers nor other local processes can claim them.
 */
export class RelayAccess {
	readonly secret = randomBytes(32).toString("hex");

	constructor() {
		processLogs.redactor.addSecret(this.secret);
	}

	verify(request: IncomingMessage): RelayedRequest | undefined {
		if (request.socket.localAddress !== "127.0.0.1") return undefined;
		const presented = request.headers[RELAY_SECRET_HEADER];
		if (typeof presented !== "string") return undefined;
		const expected = Buffer.from(this.secret);
		const actual = Buffer.from(presented);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
		const publicOrigin = request.headers[RELAY_ORIGIN_HEADER];
		const shellOrigin = request.headers[RELAY_SHELL_HEADER];
		if (typeof publicOrigin !== "string" || !ORIGIN.test(publicOrigin)) return undefined;
		if (typeof shellOrigin !== "string" || !ORIGIN.test(shellOrigin)) return undefined;
		const user = request.headers[RELAY_USER_HEADER];
		if (user === undefined) return { publicOrigin, shellOrigin };
		return typeof user === "string" ? { publicOrigin, shellOrigin, user: decodeRelayUser(user) } : undefined;
	}
}

/** The header value of a Radius user; the brain writes it, so it is plain ASCII whatever the name. */
export const encodeRelayUser = (user: RelayUser): string =>
	Buffer.from(JSON.stringify({ id: user.id, email: user.email })).toString("base64url");

const decodeRelayUser = (value: string): RelayUser => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
