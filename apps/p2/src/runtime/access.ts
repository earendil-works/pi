// Who the browser is (browser-safe contract): the owner, or a guest sessions were shared with. Served by the server host.

import { remote } from "@earendil-works/chord";
import { obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { serverHost } from "./chord.ts";
import { literal, record } from "./schema.ts";

const Mode = union([literal("view"), literal("full")]);

/**
 * A guest's grant: every session shared with it (`sessions`), and the one it lands in (`session`, shared or joined
 * last) with that session's `mode`. `email` is set for a person Radius verified; otherwise the name is self-chosen.
 * `sessions` is optional so that servers which share one session per guest (Radius Cloud Brain's copy of this
 * contract) still serve the same UI; read modes through `grantMode`.
 */
export const GrantSchema = obj({
	id: str(),
	name: str(),
	session: str(),
	mode: Mode,
	sessions: opt(record(Mode)),
	email: opt(str()),
});
export type Grant = Static<typeof GrantSchema>;

/** A guest's mode in `session`, or undefined when that session is not shared with it. */
export function grantMode(grant: Grant | null | undefined, session: string | undefined): Grant["mode"] | undefined {
	if (!grant || session === undefined) return undefined;
	if (grant.sessions) return Object.hasOwn(grant.sessions, session) ? grant.sessions[session] : undefined;
	return grant.session === session ? grant.mode : undefined;
}

export const Access = remote("p2.access", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: {} },
		guest: { state: { grant: GrantSchema } },
	},
});
