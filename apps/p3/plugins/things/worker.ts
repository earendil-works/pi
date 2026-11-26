// The things plugin on a session's worker: the registries the harness reads, `ThingHarnessParts` (each kind's part, by
// kind name) and `HeldThings` (what the worker holds as its agent, from its one contributor, the holding).

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { HeldThings, ThingHarnessParts } from "./contract.worker.ts";

export default defineFacet((host) => {
	host.serve(ThingHarnessParts, {
		compose: (table, { report }) => keyedEntries(table, (part) => ({ [part.kind.name]: part }), report),
	});
	// None contributed yet, or the holding not ready: `undefined`, never an empty map (the agent would lose its tools).
	host.serve(HeldThings, { compose: (table) => table[0]?.value });
});
