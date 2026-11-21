// The probe on a session's worker (see `contract.ts`): a plugin under test of the end-to-end tests (`testServer`'s
// `plugins`), of a root of its own, so it reaches the sessions plugin's contracts through p3's API as a third party's.

import { constant, contribute, defineFacet, forbidden, SessionFacts, type Writable } from "@earendil-works/p3/v1";
import { WorkerBusy } from "@earendil-works/p3/v1/worker";
import { Probe } from "./contract.ts";

export default defineFacet((host) => {
	let busy: Writable<number> | undefined;
	contribute(host, "probe.busy", (self) => {
		busy = self.writable(0);
		self.contribute(WorkerBusy, busy);
	});
	host.serve(Probe, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("probe: the owner's");
		const facts = self.get(SessionFacts, {});
		return {
			variant: "owner",
			members: {
				pid: constant(process.pid),
				report: ({ state }, ctx) => facts.report({ state }, ctx),
				busy: async (count) => {
					busy?.set(count);
					return null;
				},
				crash: async () => {
					setImmediate(() => process.exit(1));
					return null;
				},
			},
		};
	});
});
