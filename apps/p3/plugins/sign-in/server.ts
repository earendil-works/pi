// The sign-in plugin on the server: who someone is. The sign-ins and their authenticator (`sign-ins.ts`), the owner
// link's page, post and command (`owner.ts`), and the invite link's page and post (`invite.ts`).

import { defineFacet } from "@earendil-works/p3/v1";
import { serveInvite } from "./invite.ts";
import { serveOwner } from "./owner.ts";
import { serveSignIns } from "./sign-ins.ts";

export default defineFacet((host) => {
	serveSignIns(host);
	serveOwner(host);
	serveInvite(host);
});
