// The canvas plugin's web facet: the board kind's view of a board and its options form (`ThingViews`).

import { defineFacet } from "@earendil-works/p3/v1";
import { EditIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { BoardView } from "./board-view.tsx";
import { CanvasKind } from "./contract.ts";
import { CanvasOptions } from "./options-form.tsx";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: CanvasKind.name, Icon: EditIcon, View: BoardView, Options: CanvasOptions }),
);
