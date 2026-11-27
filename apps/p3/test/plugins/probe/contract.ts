// The probe's contract: what the end-to-end tests drive a session's worker with.

import { arr, bool, method, num, OwnerAdmission, obj, remote, Session, SessionState, str } from "@earendil-works/p3/v1";

/** The probe on a session's worker, for the owner. */
export const Probe = remote("probe.probe", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: OwnerAdmission,
	state: { pid: num() },
	methods: {
		/** Reports the session's state to the server, as the harness does. */
		report: method(obj({ state: SessionState })),
		/** Sets the probe's `WorkerBusy` count. */
		busy: method(num()),
		/** Exits the worker with code 1. */
		crash: method(),
		/** Switches the session store's outbox, as the backup plugin does (`store.setOutbox`). */
		outbox: method(bool()),
		/** Every line the worker reported since it loaded the probe (`reportError`, the host's `onError`). */
		reported: method(obj({}), arr(str())),
	},
});
