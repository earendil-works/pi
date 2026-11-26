// The layout plugin's web facet: it offers apps the pane layout (`PaneLayoutView`). A change of this plugin reloads
// the layout in place; the tree it shows is the app's.

import { defineFacet } from "@earendil-works/p3/v1";
import { Components, componentOf } from "@earendil-works/p3/v1/web";
import { PaneLayoutView } from "./contract.web.tsx";
import { PaneLayout } from "./pane-layout.tsx";

export default defineFacet((_host, self) => self.contribute(Components, [componentOf(PaneLayoutView, PaneLayout)]));
