// The files plugin's web facet, contributions only: the Files view (`Views`, files-view.tsx), what the kind has once
// (`ThingParts`: its title and icon), the plugin's title for the add-thing picker (`PluginTitles`) and its catalogs,
// with the machine's, whose refusals the view shows (`Translations`).

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { FolderIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { PluginTitles, ThingParts, Views } from "../things/contract.web.tsx";
import { FilesView } from "./files-view.tsx";
import { FilesKind } from "./kind.ts";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(Views, [
		{
			view: FilesKind.name,
			title: messages.message("view"),
			area: "main",
			for: { kind: "thing", thingKind: FilesKind.name },
			View: FilesView,
		},
	]);
	self.contribute(ThingParts, [{ kind: FilesKind.name, title: messages.message("kind"), Icon: FolderIcon }]);
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: FolderIcon });
	self.contribute(Translations, messages.translations);
});
