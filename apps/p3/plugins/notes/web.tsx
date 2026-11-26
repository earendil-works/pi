// The notes plugin's web facet, contributions only: the notes kind's view (`Views`, `notes-view.tsx`), what the kind
// has once (`ThingParts`: its icon), the plugin's title for the add-thing picker (`PluginTitles`) and its catalogs
// (`Translations`). Who may do what is the things plugin's grants, edited in its Settings view.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { DescriptionIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { PluginTitles, ThingParts, Views } from "../things/contract.web.tsx";
import { NotesKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { NotesView } from "./notes-view.tsx";

export default defineFacet((_host, self) => {
	self.contribute(Views, [
		{
			view: NotesKind.name,
			title: messages.message("view"),
			area: "main",
			for: { kind: "thing", thingKind: NotesKind.name },
			View: NotesView,
		},
	]);
	self.contribute(ThingParts, [{ kind: NotesKind.name, title: messages.message("untitled"), Icon: DescriptionIcon }]);
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: DescriptionIcon });
	self.contribute(Translations, messages.translations);
});
