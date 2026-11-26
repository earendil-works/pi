// The notes plugin's web facet: the notes kind's view of a notebook (`ThingViews`). Who may write is the things
// plugin's grants, edited in its Settings view; a notebook has no settings of its own.

import { defineFacet } from "@earendil-works/p3/v1";
import { DescriptionIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { NotesKind } from "./contract.ts";
import { NotesView } from "./notes-view.tsx";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: NotesKind.name, Icon: DescriptionIcon, View: NotesView }),
);
