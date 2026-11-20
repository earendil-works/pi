// Who reaches a session's worker: the policy of the route from the server to session workers. Its `authorize` decides
// by the principal alone, before anything else; its admission then reads the sessions table, so no worker starts for
// a session that does not exist. The kit gives both to the workers component, the test topology to its own route.

import { type Address, type AdmitSelf, allow, deny } from "@earendil-works/chord";
import type { Session } from "@earendil-works/p3/v1";
import { SessionRoute } from "@earendil-works/p3/v1/server";
import type { P3Principal } from "./principals.ts";

/** Who may reach a session's worker: the owner and the server (persons come with admission, slice 5). */
export function mayReachSession(principal: P3Principal): boolean {
	return principal.kind === "owner" || principal.kind === "server";
}

/**
 * The route's admission: allowed while the session at `address` exists. It reads the sessions table through
 * `SessionRoute`, a contract the API owns (a route is base code and never reloads) and the sessions plugin serves.
 */
export function sessionExists(_principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	const route = self.get(SessionRoute, { session: address.params.id });
	return self.derive([route.exists], ([exists]) => (exists ? allow(null) : deny("no such session")));
}
