// The environments plugin's web facet, contributions only: the machine's view (`Views`, machine-view.tsx), what the
// machine kind has once (`ThingParts`: its title and icon), the plugin's title for the add-thing picker
// (`PluginTitles`) and its catalogs (`Translations`; Files and Terminals render the machine's refusals with them).

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { BuildIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { PluginTitles, ThingParts, Views } from "../things/contract.web.tsx";
import { MachineKind } from "./kind.ts";
import { MachineView } from "./machine-view.tsx";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(Views, [
		{
			view: MachineKind.name,
			title: messages.message("view"),
			area: "main",
			for: { kind: "thing", thingKind: MachineKind.name },
			View: MachineView,
		},
	]);
	self.contribute(ThingParts, [{ kind: MachineKind.name, title: messages.message("kind"), Icon: BuildIcon }]);
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: BuildIcon });
	self.contribute(Translations, messages.translations);
});
