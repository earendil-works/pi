// The extra plugin's server facet: not in plugins/ at first; the example copies the plugin in while the app runs. It
// declares its type itself (the same shape as `labelOf("extra")`).

import { constant, defineFacet, local, str } from "@earendil-works/chord/next";

const Extra = local("example.label.extra", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) => host.serve(Extra, () => ({ text: constant("extra on the server") })));
