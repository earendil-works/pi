// The notes plugin's web facet, contributions only: the notes kind's view of a notebook (`ThingViews`) and the plugin's
// catalogs (`Translations`: the page renders its tick's label and the view's texts from them). Who may write is the
// things plugin's grants; the order, the notebook's one setting, gets its form with slice 4's `ThingParts`.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { DescriptionIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { NotesKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { NotesView } from "./notes-view.tsx";

export default defineFacet((_host, self) => {
	self.contribute(ThingViews, { kind: NotesKind.name, Icon: DescriptionIcon, View: NotesView });
	self.contribute(Translations, messages.translations);
});
