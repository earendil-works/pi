import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { processLogs } from "@p2/app/v1/node";
import type { RelayGuest, RelayUser } from "@p2/app/v1/server";

/** Marks loopback requests the Radius relay client makes on behalf of a relayed browser. */
export const RELAY_SECRET_HEADER = "x-p2-relay";
/** The brain's browser-facing origin (its cortex origin), e.g. `https://<label>.rdtun.com`. */
export const RELAY_ORIGIN_HEADER = "x-p2-relay-origin";
/** The Radius shell origin that frames the brain UI; absent for a Pi client of the owner, which no page frames. */
export const RELAY_SHELL_HEADER = "x-p2-relay-shell";
/** A Radius user other than the owner: base64url JSON `{ id, email }`. Absent for the owner. */
export const RELAY_USER_HEADER = "x-p2-relay-user";
/** A guest Radius admitted through an invite: base64url JSON `{ admission, invite }`. Never with the user header. */
export const RELAY_GUEST_HEADER = "x-p2-relay-guest";

export type RelayedRequest = { publicOrigin: string; shellOrigin?: string; user?: RelayUser; guest?: RelayGuest };

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
 * host. With the guest header it is someone who redeemed one of this server's
 * invites, without a Radius account (brain.ts, "Guests"): sharing maps the
 * admission to what they joined. Without the secret the marker headers mean nothing, so neither
 * browsers nor other local processes can claim them. Without the shell header
 * it is the owner's Pi client, the TUI launcher through Radius (brain.ts,
 * "Client channels").
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
		const user = request.headers[RELAY_USER_HEADER];
		const guest = request.headers[RELAY_GUEST_HEADER];
		if (shellOrigin === undefined) {
			// Clients are the owner's only; sharing admits people and guests on the brain's UI.
			return user === undefined && guest === undefined ? { publicOrigin } : undefined;
		}
		if (typeof shellOrigin !== "string" || !ORIGIN.test(shellOrigin)) return undefined;
		if (user !== undefined && guest !== undefined) return undefined;
		if (typeof guest === "string") return { publicOrigin, shellOrigin, guest: decodeHeader(guest) };
		if (typeof user === "string") return { publicOrigin, shellOrigin, user: decodeHeader(user) };
		return user === undefined && guest === undefined ? { publicOrigin, shellOrigin } : undefined;
	}
}

/** The header value of a Radius user or guest; the brain writes it, so it is plain ASCII whatever the name. */
export const encodeRelayHeader = (value: RelayUser | RelayGuest): string =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

/** A header the brain wrote with `encodeRelayHeader` (the relay secret vouches for it). */
const decodeHeader = <T>(value: string): T => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
