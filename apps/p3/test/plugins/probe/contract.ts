// The probe's contract: what the end-to-end tests drive a session's worker with.

import { method, num, obj, remote, Session, SessionState, str } from "@earendil-works/p3/v1";

/** The probe on a session's worker, for the owner. */
export const Probe = remote("probe.probe", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	state: { pid: num() },
	methods: {
		/** Reports the session's state to the server, as the harness does. */
		report: method(obj({ state: SessionState })),
		/** Sets the probe's `WorkerBusy` count. */
		busy: method(num()),
		/** Exits the worker with code 1. */
		crash: method(),
	},
});
