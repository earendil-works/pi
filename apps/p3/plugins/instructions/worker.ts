// The instructions plugin on a session's worker: the harness part of `prompt.instructions`. One prompt section per
// thing the agent may use (the flag `use`), in the order the agent holds them (down the tree, the closest last): the
// base text of the thing's language, then its text. A section reads the text and the language at each prompt, so a
// change made with Configure reaches the agent's next step.

import { defineFacet } from "@earendil-works/p3/v1";
import type { PromptSection } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { de } from "./base/de.ts";
import { en } from "./base/en.ts";
import { fr } from "./base/fr.ts";
import { type Instructions, InstructionsKind, type Language } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, instructionsPart);
});

/** The instructions' harness part (exported for its test). */
export const instructionsPart = thingHarnessPart(InstructionsKind, (things) => ({
	prompt: things.filter(({ ref }) => ref.granted.has("use")).map(sectionOf),
}));

/** The base text of each language, code kept with the plugin (a message catalog renders per viewer, not per thing). */
const BASE: Readonly<Record<Language, string>> = { en, de, fr };

/** One thing's prompt section: keyed by the thing, so its place in the prompt stays while its text changes. */
function sectionOf({ thing, ref }: HeldThing<typeof Instructions>): PromptSection {
	return {
		key: `instructions-${thing}`,
		// Nothing written yet: no section.
		render: () => (ref.text.value === "" ? undefined : `${BASE[ref.language.value]}\n\n${ref.text.value}`),
	};
}
