// The layout plugin's web facet: it offers views the pane layout (`PaneLayout`). A change of this plugin reloads
// the layout in place; the tree it shows is the app's.

import { defineFacet } from "@earendil-works/p3/v1";
import { Components, componentOf } from "@earendil-works/p3/v1/web";
import { PaneLayout } from "./contract.web.tsx";
import { PaneLayout as PaneLayoutImpl } from "./pane-layout.tsx";

export default defineFacet((_host, self) => self.contribute(Components, [componentOf(PaneLayout, PaneLayoutImpl)]));
