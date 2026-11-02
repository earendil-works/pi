// The counter plugin's server facet: serves `Counter`. The example makes its factory throw.

import { constant, defineFacet, int, local } from "@earendil-works/chord/next";

const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });

export default defineFacet((host) => host.serve(Counter, () => ({ start: constant(1) })));
