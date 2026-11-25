// Session locks (server): every locked session's picked resources, persisted, and the remote view the owner sets them
// through and each session's worker follows its own lock with.
import { obj } from "@earendil-works/pi-schema";
import {
	defineState,
	deriveTyped,
	type FacetHost,
	forbidden,
	grantBy,
	isOwner,
	isWorker,
	notGranted,
	record,
	SessionLockSchema,
} from "@p2/app/v1";
import { SessionLock, SessionLocks } from "./contract.ts";

const Locks = defineState("p2.session-locks", {
	schema: obj({ locks: record(SessionLockSchema) }),
	version: 1,
	initial: () => ({ locks: {} }),
	persist: true,
	checkpointWhen: () => true,
});

export function serveLocks(host: FacetHost): void {
	host.serve(SessionLocks, (_params, self) => {
		const state = self.state(Locks);
		return {
			locks: deriveTyped(self, [state], ([value]) => value.locks),
			set: async ({ session, lock }, ctx) => {
				await state.change((draft) => {
					if (lock === null) delete draft.locks[session];
					else draft.locks[session] = lock;
				}, ctx);
				return null;
			},
		};
	});
	host.serve(
		SessionLock,
		(_params, principal, _admitted, self) => {
			const locks = self.get(SessionLocks, {});
			if (isWorker(principal)) {
				const session = principal.session;
				return {
					lock: () => deriveTyped(self, [locks.locks], ([all]) => all[session] ?? null),
					locks: notGranted,
					set: notGranted,
				};
			}
			if (!isOwner(principal)) throw forbidden("session locks are the owner's");
			return { locks: () => locks.locks, set: (args, ctx) => locks.set(args, ctx), lock: notGranted };
		},
		{ admit: grantBy((principal) => (isWorker(principal) ? ["lock"] : isOwner(principal) ? ["locks", "set"] : [])) },
	);
}
