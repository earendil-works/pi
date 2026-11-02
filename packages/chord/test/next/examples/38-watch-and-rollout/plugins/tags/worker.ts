// The tags plugin's worker facet.

import { constant, defineFacet } from "@earendil-works/chord/next";
import { labelOf } from "../contracts/contract.ts";

export default defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("tags on the worker") })));
