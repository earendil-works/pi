// The notes plugin's server facet: serves `Notes`.

import { constant, defineFacet } from "@acme/app/v3";
import { Notes } from "./contract.ts";

export default defineFacet((host) => host.serve(Notes, () => ({ text: constant("buy milk, call bob, ship it") })));
