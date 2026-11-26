// A session's own facts for its worker (`SessionFacts`): its row, and its report of what the agent does.

import { type FacetHost, forbidden, type P3Principal, SessionFacts } from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { SessionHas } from "./follow.ts";

/** Serves `SessionFacts` on `host`. */
export function serveFacts(host: FacetHost<P3Principal>): void {
	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const session = principal.session;
		const store = self.get(SessionsStore, {});
		return {
			session: self.get(SessionHas, { session }).session,
			report: ({ state }, ctx) => store.report({ session, state }, ctx),
		};
	});
}
