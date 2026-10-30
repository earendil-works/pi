// The paths plugin's server facet: a script has no `__dirname` or `__filename` (it is evaluated with no file of its
// own); a file of the plugin is read through `pluginFile`. Each use is a build error.

import { join } from "node:path";
import { defineFacet } from "@earendil-works/chord/next";

export default defineFacet(() => {
	console.log(join(__dirname, "data.json"));
	console.log(__filename);
});
