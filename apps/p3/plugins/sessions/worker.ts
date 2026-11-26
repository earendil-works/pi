// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as its members see it, and
// `SessionStart`, which the server's waker holds to start the worker of a `working` session after a restart.
// `SessionWorker` forwards the session's row from the server's `SessionFacts`, held as this worker (its principal names
// the session), so a rename on the server reaches it live; who may hold it is the session's access (`admitSession`).
// The harness resumes Durable's run once the worker loaded; `SessionStart` only starts it.

import {
	admitSession,
	constant,
	defineFacet,
	forbidden,
	SessionFacts,
	SessionStart,
	SessionWorker,
} from "@earendil-works/p3/v1";

export default defineFacet((host) => {
	host.serve(
		SessionWorker,
		(_params, _principal, _admitted, self) => ({
			variant: "view",
			members: { session: self.get(SessionFacts, {}).session },
		}),
		{ admit: admitSession },
	);
	host.serve(SessionStart, ({ session }, principal) => {
		if (principal.kind !== "server") throw forbidden("sessions: the server's waker only");
		return { variant: "server", members: { session: constant(session) } };
	});
});
