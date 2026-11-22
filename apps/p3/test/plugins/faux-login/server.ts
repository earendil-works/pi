// The faux login on the server: its kind of thing, so a session can have one.

import { defineFacet } from "@earendil-works/p3/v1";
import { ThingKinds } from "@earendil-works/p3/v1/server";
import { FauxLogin } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingKinds, { kind: FauxLogin, title: "Faux login" });
});
