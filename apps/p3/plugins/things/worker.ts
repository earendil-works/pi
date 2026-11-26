// The things plugin on a session's worker: the registries the harness reads, `ThingHarnessParts` (each kind's part, by
// kind name) and `HeldThings` (what the worker holds as its agent, from its one contributor, the holding).

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { type HeldThing, HeldThings, ThingHarnessParts } from "./contract.worker.ts";

/** What the worker holds before the holding contributed. */
const NOTHING_HELD: ReadonlyMap<string, readonly HeldThing[]> = new Map();

export default defineFacet((host) => {
	host.serve(ThingHarnessParts, {
		compose: (table, { report }) => keyedEntries(table, (part) => ({ [part.kind.name]: part }), report),
	});
	host.serve(HeldThings, { compose: (table) => table[0]?.value ?? NOTHING_HELD });
});
