// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as anyone let into the session sees
// it, and `SessionStart`, which the server's waker holds to start the worker of a `working` session after a restart.
// `SessionWorker` forwards the session's row from the server's `SessionFacts`, held as this worker (its principal names
// the session), so a rename on the server reaches it live; who may hold it is the caller's answer on the session
// workspace (`followSession`). The harness resumes Durable's run once the worker loaded; `SessionStart` only starts it.
// The holding (`holding.ts`) holds the things the session's workspace gives the agent, for the harness.

import { constant, defineFacet, forbidden } from "@earendil-works/p3/v1";
import { SessionFacts, SessionStart, SessionWorker } from "./contract.ts";
import { followSession } from "./follow.ts";
import { serveHolding } from "./holding.ts";

export default defineFacet((host) => {
	serveHolding(host);
	host.serve(
		SessionWorker,
		(_params, _principal, _admitted, self) => ({ session: self.get(SessionFacts, {}).session }),
		{ admit: followSession() },
	);
	host.serve(SessionStart, ({ session }, principal) => {
		if (principal.kind !== "server") throw forbidden("sessions: the server's waker only");
		return { session: constant(session) };
	});
});
