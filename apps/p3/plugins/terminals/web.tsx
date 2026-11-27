// The terminals plugin's web facet, contributions only: the Terminals view (`Views`, terminals-view.tsx), what the
// kind has once (`ThingParts`: its title and icon), the plugin's title for the add-thing picker (`PluginTitles`) and
// its catalogs (`Translations`).

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { TerminalIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { PluginTitles, ThingParts, Views } from "../things/contract.web.tsx";
import { TerminalsKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { TerminalsView } from "./terminals-view.tsx";

export default defineFacet((_host, self) => {
	self.contribute(Views, [
		{
			view: TerminalsKind.name,
			title: messages.message("view"),
			area: "main",
			for: { kind: "thing", thingKind: TerminalsKind.name },
			View: TerminalsView,
		},
	]);
	self.contribute(ThingParts, [{ kind: TerminalsKind.name, title: messages.message("kind"), Icon: TerminalIcon }]);
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: TerminalIcon });
	self.contribute(Translations, messages.translations);
});
