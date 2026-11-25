// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as the owner sees it, and
// `SessionStart`, which the server's waker holds to start the worker of a `working` session after a restart.
// `SessionWorker` forwards the session's row from the server's `SessionFacts`, held as this worker (its principal names
// the session, design §4), so a rename on the server reaches it live. The harness core resumes Durable's run once the
// worker loaded; `SessionStart` only starts it.

import { constant, defineFacet, forbidden, forward } from "@earendil-works/p3/v1";
import { SessionFacts, SessionStart, SessionWorker } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(SessionWorker, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		return forward(self.get(SessionFacts, {}), SessionWorker);
	});
	host.serve(SessionStart, ({ session }, principal) => {
		if (principal.kind !== "server") throw forbidden("sessions: the server's waker only");
		return { session: constant(session) };
	});
});
