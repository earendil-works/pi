// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as the owner sees it. It forwards
// the session's row from the server's `SessionFacts`, held as this worker (its principal names the session, design
// §4), so a rename on the server reaches it live.

import { defineFacet, forbidden, forward } from "@earendil-works/p3/v1";
import { SessionFacts, SessionWorker } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(SessionWorker, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		return forward(self.get(SessionFacts, {}), SessionWorker, "owner");
	});
});
