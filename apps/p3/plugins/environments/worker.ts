// The environments plugin on a session's worker: the machine kind's harness part (harness-part.ts), the one way a
// session's tools get an environment: the machine of the conversation's location, held with Work here.

import { defineFacet } from "@earendil-works/p3/v1";
import { ThingHarnessParts } from "../things/contract.worker.ts";
import { machinePart } from "./harness-part.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, machinePart);
});
