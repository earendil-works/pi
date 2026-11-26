// The things plugin on the server: the store with its access index (`store.ts`), `Gives` (what every thing's
// admission derives from), `OneThing` (a kind's seeded thing), and the registries kinds and admissions meet in:
// `ThingKinds` (each kind's data), `ThingHooks` (each kind's hooks), `AccessHandles` (the store's index, R5).

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { serveGives } from "./admission.ts";
import { AccessHandles, ThingHooks } from "./contract.server.ts";
import { ThingKinds } from "./kind.ts";
import { serveOne } from "./one.ts";
import { serveStore } from "./store.ts";

export default defineFacet((host) => {
	host.serve(ThingKinds, {
		compose: (table, { report }) => keyedEntries(table, (info) => ({ [info.name]: info }), report),
	});
	host.serve(ThingHooks, {
		compose: (table, { report }) => keyedEntries(table, (hook) => ({ [hook.kind]: hook }), report),
	});
	// Only the store contributes: the one live store object's index.
	host.serve(AccessHandles, { compose: (table) => table[0]?.value });
	serveStore(host);
	serveGives(host);
	serveOne(host);
});
