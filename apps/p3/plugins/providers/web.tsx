// The providers plugin's web facet, contributions only: what the login kind and the model settings kind have once on
// the page (`ThingParts`: their titles) and their texts (`Translations`), so the things plugin's Settings view shows
// their tick labels in words, not their keys.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";
import { LoginKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { ModelSettingsKind } from "./model-settings-kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingParts, [
		{ kind: LoginKind.name, title: messages.message("kindLogin") },
		{ kind: ModelSettingsKind.name, title: messages.message("kindModelSettings") },
	]);
	self.contribute(Translations, messages.translations);
});
