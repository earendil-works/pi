// A session's own facts for its worker (`SessionFacts`): its row, and its report of what the agent does.

import { type FacetHost, forbidden, type P3Principal } from "@earendil-works/p3/v1";
import { SessionsStore } from "./contract.server.ts";
import { SessionFacts } from "./contract.ts";
import { sessionRow } from "./session.ts";

/** Serves `SessionFacts` on `host`. */
export function serveFacts(host: FacetHost<P3Principal>): void {
	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const session = principal.session;
		const store = self.get(SessionsStore, {});
		return {
			session: sessionRow(session, self),
			report: ({ state }, ctx) => store.report({ session, state }, ctx),
		};
	});
}
