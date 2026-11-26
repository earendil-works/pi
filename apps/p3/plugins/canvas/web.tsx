// The canvas plugin's web facet: the board kind's view of a board (`ThingViews`). Its old options form went with the
// old sessions layer; who may draw is the things plugin's grants, edited in its Settings view (slice 4).

import { defineFacet } from "@earendil-works/p3/v1";
import { EditIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { BoardView } from "./board-view.tsx";
import { CanvasKind } from "./contract.ts";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: CanvasKind.name, Icon: EditIcon, View: BoardView }),
);
