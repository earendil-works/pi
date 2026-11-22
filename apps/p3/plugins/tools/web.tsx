// The tools plugin's web facet: the coding tools' options form (`ThingViews`). The tools have no view of their own:
// a session's things show them by their kind's title, and an app offers no pane for them.

import { CodingTools, defineFacet } from "@earendil-works/p3/v1";
import { ThingViews } from "@earendil-works/p3/v1/web";
import { CodingToolsOptions } from "./options-form.tsx";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: CodingTools.name, Options: CodingToolsOptions }),
);
