// The prompt plugin's web facet, contributions only: what each of its two kinds has once on the page (`ThingParts`:
// their titles) and its texts (`Translations`), so the things plugin's Settings view shows its tick labels in words,
// not their keys.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";
import { InstructionsKind } from "./instructions-kind.ts";
import { messages } from "./messages.ts";
import { SkillsKind } from "./skills-kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingParts, [
		{ kind: InstructionsKind.name, title: messages.message("kindInstructions") },
		{ kind: SkillsKind.name, title: messages.message("kindSkills") },
	]);
	self.contribute(Translations, messages.translations);
});
