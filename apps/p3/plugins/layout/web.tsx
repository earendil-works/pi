// The layout plugin's web facet: it offers views the pane layout (`PaneLayout`), and its texts (`Translations`). A
// change of this plugin reloads the layout in place; the tree it shows is the view's.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { Components, componentOf } from "@earendil-works/p3/v1/web";
import { PaneLayout } from "./contract.web.tsx";
import { messages } from "./messages.ts";
import { PaneLayout as PaneLayoutImpl } from "./pane-layout.tsx";

export default defineFacet((_host, self) => {
	self.contribute(Components, [componentOf(PaneLayout, PaneLayoutImpl)]);
	self.contribute(Translations, messages.translations);
});
