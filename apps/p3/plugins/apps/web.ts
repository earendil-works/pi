// The apps plugin's web facet: it serves `AppPages`, each app's page by its app id (the first by plugin name wins an
// id; a second is reported).

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { AppPages } from "./contract.web.ts";

export default defineFacet((host) => {
	host.serve(AppPages, {
		compose: (table, { report }) => keyedEntries(table, (page) => ({ [page.app]: page }), report),
	});
});
