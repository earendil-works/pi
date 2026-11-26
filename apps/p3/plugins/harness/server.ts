// The harness plugin on the server: the subagents as a kind of thing (`serveThing`: no members, so nothing to
// implement), and its one thing in Pi, which the things plugin makes at start (`one`).

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "../things/serve.ts";
import { SubagentsKind } from "./contract.ts";

export default defineFacet((host) => {
	serveThing(host, SubagentsKind, { implement: () => ({}), one: { name: "Subagents" } });
});
