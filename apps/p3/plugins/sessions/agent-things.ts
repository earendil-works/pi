// `AgentThings` on the server: what a session's workspace gives its agent, read from the things plugin's `Gives` for
// the session's worker, so its worker learns which things to hold without asking the index itself (`Gives` is server
// code's only).

import { AgentThings, callerKey, type FacetHost, forbidden, type P3Principal } from "@earendil-works/p3/v1";
import { Gives } from "../things/contract.server.ts";

/** Serves `AgentThings` on `host`: for a session's worker only, its agent's things in its session's workspace. */
export function serveAgentThings(host: FacetHost<P3Principal>): void {
	host.serve(AgentThings, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const gives = self.get(Gives, { workspace: principal.session, caller: callerKey(principal) });
		return {
			things: self.derive([gives.answers], ([answers]) =>
				Object.entries(answers)
					.map(([thing, { kind }]) => ({ thing, kind }))
					// By id: the order the worker holds them in, the same at every change.
					.sort((a, b) => (a.thing < b.thing ? -1 : a.thing > b.thing ? 1 : 0)),
			),
		};
	});
}
