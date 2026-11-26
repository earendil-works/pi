// The faux inbox on a session's worker, for tests only: it gives the agent nothing (no tools, no providers), so a
// session that has one has a kind the harness knows rather than one no plugin serves.

import { defineFacet } from "@earendil-works/p3/v1";
import { ThingExtensions, thingExtension } from "@earendil-works/p3/v1/worker";
import { FauxInboxKind } from "./contract.ts";

export default defineFacet((_host, self) =>
	self.contribute(
		ThingExtensions,
		thingExtension(FauxInboxKind, () => ({})),
	),
);
