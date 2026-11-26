// The prompt plugin on a session's worker: the harness parts of its two kinds. Instructions give one prompt section per
// thing the agent may use (the flag `use`), in the order held (the closest last, once the holding orders by depth):
// the base text of the thing's language, then its text, both read at each prompt, so a change made with Configure
// reaches the next step. Skills give one prompt section listing the skills of every set the agent may use (Use gives
// `read`), a name in two sets the closer set's, and the tool `skills_read({ name })`, which reads the text through the
// held reference of the set that owns the name. A skill's files stay on the Pi for now: the tool names them.

import { contribute, defineFacet, forbidden, invalid, obj, str } from "@earendil-works/p3/v1";
import { defineTool, type PromptSection } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Instructions, InstructionsKind, type Language } from "./instructions-kind.ts";
import { type Skill, type Skills, SkillsKind } from "./skills-kind.ts";

export default defineFacet((host) => {
	// One contributing object per kind: an object contributes to a registry once.
	contribute(host, "prompt.instructions-part", (self) =>
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(InstructionsKind, (things) => ({
				extension: { sections: things.filter(({ ref }) => ref.granted.has("use")).map(instructionsSection) },
			})),
		),
	);
	contribute(host, "prompt.skills-part", (self) =>
		self.contribute(ThingHarnessParts, thingHarnessPart(SkillsKind, skillsPart)),
	);
});

/**
 * What the agent reads before an instructions thing's text, per language: code kept with the plugin, since a message
 * catalog renders per viewer, not per thing.
 */
const BASE: Readonly<Record<Language, string>> = {
	en: "The people of this place gave you these instructions. Follow them:",
	de: "Die Menschen hier haben dir diese Anweisungen gegeben. Halte dich daran:",
	fr: "Les personnes d'ici t'ont donné ces instructions. Suis-les :",
};

/** One instructions thing's section: keyed by the thing, so its place in the prompt stays while its text changes. */
function instructionsSection({ thing, ref }: HeldThing<typeof Instructions>): PromptSection {
	return {
		key: `instructions-${thing}`,
		// Nothing written yet: no section.
		render: () => (ref.text.value === "" ? undefined : `${BASE[ref.language.value]}\n\n${ref.text.value}`),
	};
}

/** A set of skills the agent holds (`Set` would shadow the global). */
type HeldSet = HeldThing<typeof Skills>;

/** What the sets give: the list section and `skills_read`, over the sets the agent may read; none: nothing. */
function skillsPart(things: readonly HeldSet[]) {
	// Use gives `read`: a set the agent is let in to without it lists nothing.
	const usable = things.filter(({ ref }) => ref.granted.has("read"));
	if (usable.length === 0) return {};
	return { extension: { tools: [readTool(usable)], sections: [{ key: "skills", render: () => listed(usable) }] } };
}

/** The skills of `sets` by name, each from the closest set that has it (held last), the closest set's first. */
function skillsOf(sets: readonly HeldSet[]): Map<string, { readonly set: HeldSet; readonly skill: Skill }> {
	const named = new Map<string, { readonly set: HeldSet; readonly skill: Skill }>();
	for (const set of sets.toReversed()) {
		for (const skill of set.ref.skills.value) if (!named.has(skill.name)) named.set(skill.name, { set, skill });
	}
	return named;
}

/** The skills section: the skills by name and description; none: no section. */
function listed(sets: readonly HeldSet[]): string | undefined {
	const skills = [...skillsOf(sets).values()];
	if (skills.length === 0) return undefined;
	const lines = skills.map(({ skill }) => `- ${skill.name}: ${skill.description}`);
	return `Skills you can read with skills_read when a task matches one:\n${lines.join("\n")}`;
}

/** The tool `skills_read`: one skill's text and files as JSON, from the set that owns its name. */
function readTool(sets: readonly HeldSet[]) {
	return defineTool({
		name: "skills_read",
		description:
			"Reads the skill `name` (one of the skills listed in the prompt). Answers JSON: its `text`, and the paths of " +
			"its other `files` (on the Pi, not on your machine).",
		parameters: obj({ name: str() }),
		replay: "safe",
		execute: async ({ name }, _api, context) => {
			const owner = skillsOf(sets).get(name);
			if (owner === undefined)
				throw invalid("args", `prompt: no skill ${JSON.stringify(name)} (see the skills list)`);
			// The held reference's `read` is there while Use is granted: withheld since, it is gone.
			const read = owner.set.ref.read;
			if (read === undefined) throw forbidden(`prompt: you may not read the skill ${JSON.stringify(name)} any more`);
			const skill = await read({ name }, context);
			return { output: [{ type: "text", text: JSON.stringify(skill) }] };
		},
	});
}
