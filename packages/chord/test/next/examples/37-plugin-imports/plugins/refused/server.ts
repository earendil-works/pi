// The refused plugin's server facet: imports a facet script may not have, each a build error with its file and line.
// A script is evaluated with no module identity: no `import.meta` (a file of the plugin is read through `pluginFile`),
// no literal dynamic `import()`; and base code is reached through a host package, not by its path.

import { defineFacet } from "@earendil-works/chord/next";
import app from "../../app/index.ts";

export default defineFacet(() => {
	console.log(import.meta.url, app.name);
	void import("./other.ts");
});
