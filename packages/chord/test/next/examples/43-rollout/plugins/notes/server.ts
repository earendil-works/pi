// The notes plugin's server facet.

import { constant, defineFacet } from "@earendil-works/chord/next";
import { Banner } from "./contract.ts";
import { label } from "./label.ts";

export default defineFacet((host) => host.serve(Banner, () => ({ text: constant(`server: ${label}`) })));
