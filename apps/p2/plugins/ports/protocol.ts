/**
 * Port forwards: HTTP services on this device (a dev server on port 5173, say)
 * that the owner opens through Radius. Each forward gets its own origin,
 * `https://fwd--<label>--<id>.rdtun.com`, next to the brain's own
 * `https://<label>.rdtun.com`. Radius authenticates the owner for it; the brain
 * relays its requests to `localhost:<port>`.
 *
 * A public forward is also open to anyone, without signing in, at
 * `https://pub--<label>--<id>.rdtun.com`. The brain alone decides that: Radius
 * sends unauthenticated requests on, and the brain answers them only for
 * public forwards.
 */

import type { Static } from "@earendil-works/pi-schema";
import type { ForwardBaseSchema, ForwardSchema, QuerySchema, ReplySchema } from "./contract.ts";

/** Opaque forward IDs: Radius puts them in a DNS label, so lowercase letters and digits only. */
export const FORWARD_ID = /^[a-z0-9]{1,24}$/;
export const MAX_FORWARD_NAME = 40;

/** The types of the contract's schemas (contract.ts). */
export type Forward = Static<typeof ForwardBaseSchema>;
export type ForwardView = Static<typeof ForwardSchema>;
export type PortsRequest = Static<typeof QuerySchema>;
export type PortsReply = Static<typeof ReplySchema>;

export function validateForwardPort(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535)
		throw new Error("Port must be a number from 1 to 65535");
	return value;
}

export function validateForwardName(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length > MAX_FORWARD_NAME ||
		[...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
	)
		throw new Error(`Names have at most ${MAX_FORWARD_NAME} characters`);
	return value.trim() || undefined;
}

/**
 * The forward's origin beside the brain's Radius origin, or its public one; undefined when that is not a Radius brain
 * origin.
 */
export function forwardOrigin(
	radiusOrigin: string,
	id: string,
	options: { public?: boolean } = {},
): string | undefined {
	const match = /^(https?:\/\/)([0-9a-f]{32})\.([^/]+)$/.exec(radiusOrigin);
	const prefix = options.public ? "pub" : "fwd";
	return match && FORWARD_ID.test(id) ? `${match[1]}${prefix}--${match[2]}--${id}.${match[3]}` : undefined;
}

export function forwardView(forward: Forward, radiusOrigin: string | null, sessionTitle?: string): ForwardView {
	const url = radiusOrigin ? forwardOrigin(radiusOrigin, forward.id) : undefined;
	const publicUrl =
		radiusOrigin && forward.public ? forwardOrigin(radiusOrigin, forward.id, { public: true }) : undefined;
	return {
		...forward,
		...(sessionTitle ? { sessionTitle } : {}),
		...(url ? { url: `${url}/` } : {}),
		...(publicUrl ? { publicUrl: `${publicUrl}/` } : {}),
	};
}
