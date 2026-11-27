// The harness plugin's web facet, contributions only: what the subagents kind has once on the page (`ThingParts`: its
// title) and its texts (`Translations`), so the things plugin's Settings view shows its tick labels in words, not their
// keys.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";
import { SubagentsKind } from "./kind.ts";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingParts, [{ kind: SubagentsKind.name, title: messages.message("kindSubagents") }]);
	self.contribute(Translations, messages.translations);
});
