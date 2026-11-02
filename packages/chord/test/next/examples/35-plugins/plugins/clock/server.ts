// The clock plugin's server facet: serves `Clock` with the time its script was evaluated. The example never edits
// this plugin, so a reload leaves it as it is: same script, same facet, same object.

import { constant, defineFacet } from "@earendil-works/chord/next";
import { Clock } from "../contracts/contract.ts";

const evaluatedAt = new Date().toISOString();

export default defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })));
