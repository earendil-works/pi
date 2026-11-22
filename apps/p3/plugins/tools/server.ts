// The tools plugin on the server: the coding tools as a kind of thing a session can have (`ThingKinds`).

import { CodingTools, defineFacet } from "@earendil-works/p3/v1";
import { ThingKinds } from "@earendil-works/p3/v1/server";

export default defineFacet((_host, self) => {
	self.contribute(ThingKinds, { kind: CodingTools, title: "Coding tools" });
});
