// The canvas plugin's web facet: the board view of a canvas (`Views`), what the kind has once (`ThingParts`: its
// icon), the plugin's title for the add-thing picker (`PluginTitles`), and its texts for whoever renders its labels.
// Who may draw is the things plugin's grants, edited in its Settings view.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { EditIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web` (see `board-view.tsx`).
import { PluginTitles, ThingParts, Views } from "../things/contract.web.tsx";
import { BoardView } from "./board-view.tsx";
import { CanvasKind } from "./contract.ts";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(Views, {
		view: "canvas.board",
		title: messages.message("viewBoard"),
		area: "main",
		for: { kind: "thing", thingKind: CanvasKind.name },
		View: BoardView,
	});
	self.contribute(ThingParts, { kind: CanvasKind.name, Icon: EditIcon });
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: EditIcon });
	self.contribute(Translations, messages.translations);
});
