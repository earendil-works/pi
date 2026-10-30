// The boot plugin's server facet: serves `Boot`. The example makes this module throw while it is evaluated.

import { constant, defineFacet, local, str } from "@earendil-works/chord/next";

const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });

export default defineFacet((host) => host.serve(Boot, () => ({ mode: constant("v1") })));
