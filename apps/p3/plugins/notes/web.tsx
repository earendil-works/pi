// The notes plugin's web facet: the notes kind's view of a notebook and its options form (`ThingViews`).

import { defineFacet } from "@earendil-works/p3/v1";
import { ThingViews } from "@earendil-works/p3/v1/web";
import { NotesKind } from "./contract.ts";
import { NotesView } from "./notes-view.tsx";
import { NotesOptions } from "./options-form.tsx";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: NotesKind.name, View: NotesView, Options: NotesOptions }),
);
