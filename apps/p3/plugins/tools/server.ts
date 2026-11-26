// The tools plugin on the server: the coding tools as a kind of thing (`serveThing`: no members, so nothing to
// implement; who may is the things plugin's), and the one thing of the kind in Pi, which the things plugin makes at
// start (`one`).

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "../things/serve.ts";
import { CodingToolsKind } from "./contract.ts";

export default defineFacet((host) => {
	serveThing(host, CodingToolsKind, { implement: () => ({}), one: { name: "Coding tools" } });
});
