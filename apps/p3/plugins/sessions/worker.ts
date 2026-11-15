// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as the owner sees it. It follows the
// session's facts from the server (held as this worker: its principal names the session, design §4), so a rename on the
// server reaches it live.

import { defineFacet, forbidden } from "@p3/app/v1";
import { SessionFacts, SessionWorker } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(SessionWorker, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const facts = self.get(SessionFacts, {});
		return { variant: "owner", members: { facts: facts.facts } };
	});
});
