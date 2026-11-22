// The coding app on the server: it says it exists (`Apps`), with the full top bar. Its sessions are the sessions
// plugin's; its page is its web facet.

import { defineFacet } from "@earendil-works/p3/v1";
import { Apps } from "@earendil-works/p3/v1/server";

export default defineFacet((_host, self) => {
	self.contribute(Apps, { id: "coding", title: "Coding", chrome: "bar" });
});
