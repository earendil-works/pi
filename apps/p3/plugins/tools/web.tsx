// The tools plugin's web facet: the coding tools' view of a thing (their title) and their options form
// (`ThingViews`).

import { CodingTools, defineFacet } from "@earendil-works/p3/v1";
import { ThingViews } from "@earendil-works/p3/v1/web";
import { CodingToolsOptions } from "./options-form.tsx";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: CodingTools.name, View: CodingToolsView, Options: CodingToolsOptions }),
);

/** The coding tools as a session's things show them. */
function CodingToolsView() {
	return <span data-coding-tools="">Coding tools</span>;
}
