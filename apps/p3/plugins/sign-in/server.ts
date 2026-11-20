// The sign-in plugin on the server: who someone is. The sign-ins and their authenticator (`sign-ins.ts`), and the
// owner's link and token file (`owner.ts`).

import { defineFacet } from "@earendil-works/p3/v1";
import { serveOwner } from "./owner.ts";
import { serveSignIns } from "./sign-ins.ts";

export default defineFacet((host) => {
	serveSignIns(host);
	serveOwner(host);
});
