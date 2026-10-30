// The notes plugin's server facet: its label.

import { constant, defineFacet } from "@earendil-works/chord/next";
import { labelOf } from "../contracts/contract.ts";
import { label } from "./label.ts";

export default defineFacet((host) =>
	host.serve(labelOf("notes"), () => ({ text: constant(`${label} on the server`) })),
);
