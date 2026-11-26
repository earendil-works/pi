// The backup plugin on a session's worker. For now one job: once the session is backed up (`SessionBackup.enabled`: its
// own choice, else the default), the store's outbox is turned on, so it records every commit for the upload (a later
// step).
//
// It never turns the outbox off. When backup is turned off the session is only paused: the outbox keeps the commits it
// recorded, so turning backup on again uploads only those. Turning the outbox off would drop them, and the next upload
// would have to be a full copy. Turning it off for good is a separate action, later.

import { contribute, defineFacet } from "@earendil-works/p3/v1";
import { WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { SessionBackup } from "./contract.ts";

export default defineFacet((host) => {
	contribute(host, "backup.outbox", (self) => {
		const runtime = self.registry(WorkerRuntime);
		const backup = self.get(SessionBackup, {});
		self.on(backup.enabled, async ({ value }, ctx) => {
			if (value) await runtime.value.store.setOutbox(true, ctx);
		});
	});
});
