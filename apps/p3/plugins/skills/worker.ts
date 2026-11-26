// The skills plugin on a session's worker: the harness part of `prompt.skills`. One prompt section listing the skills
// of every set the agent may use (Use), name and description, a name in two sets the closer set's (the closest is
// held last); and the tool `skill_read({ name })`, which reads the skill's text from the set that owns the name, as
// the agent, through its held reference. Both read the sets' lists at use, so a skill added to a folder is listed at
// the next step. A skill's files stay on the Pi for now: the tool names them (copying them to the session's machine
// on first use comes later).

import { defineFacet, obj, str } from "@earendil-works/p3/v1";
import { defineExtension, defineTool } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Skill, type Skills, SkillsKind } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, skillsPart);
});

/** A set of skills the agent holds. */
type Set = HeldThing<typeof Skills>;

/** The skills' harness part (exported for its test). */
export const skillsPart = thingHarnessPart(SkillsKind, (things) => {
	// Use gives `read`: a set the agent is let in to without it lists nothing.
	const usable = things.filter(({ ref }) => ref.granted.has("read"));
	if (usable.length === 0) return {};
	return {
		extension: defineExtension({
			name: SkillsKind.name,
			tools: [readTool(usable)],
			sections: [{ key: "skills", render: () => listed(usable) }],
		}),
	};
});

/** The skills of `sets` by name, each from the closest set that has it, in the order listed (closest set first). */
function skillsOf(sets: readonly Set[]): Map<string, { readonly set: Set; readonly skill: Skill }> {
	const named = new Map<string, { readonly set: Set; readonly skill: Skill }>();
	for (const set of sets.toReversed()) {
		for (const skill of set.ref.skills.value) if (!named.has(skill.name)) named.set(skill.name, { set, skill });
	}
	return named;
}

/** The prompt section: the skills by name and description; none: no section. */
function listed(sets: readonly Set[]): string | undefined {
	const skills = [...skillsOf(sets).values()];
	if (skills.length === 0) return undefined;
	const lines = skills.map(({ skill }) => `- ${skill.name}: ${skill.description}`);
	return `Skills you can read with skill_read when a task matches one:\n${lines.join("\n")}`;
}

/** The tool `skill_read`: one skill's text, from the set that owns its name. */
function readTool(sets: readonly Set[]) {
	return defineTool({
		name: "skill_read",
		description: "The text of the skill `name` (one of the skills listed in the prompt), and the names of its files.",
		parameters: obj({ name: str() }),
		replay: "safe",
		execute: async ({ name }, _api, context) => {
			const owner = skillsOf(sets).get(name);
			if (owner === undefined) throw new Error(`skills: no skill ${JSON.stringify(name)}`);
			// The held reference's `read` is there while Use is granted: withheld since, it is gone.
			const read = owner.set.ref.read;
			if (read === undefined) throw new Error(`skills: you may not read ${JSON.stringify(name)} any more`);
			const { text, files } = await read({ name }, context);
			const listedFiles =
				files.length === 0 ? "" : `\n\nIts files (on the Pi, not on your machine): ${files.join(", ")}`;
			return { output: [{ type: "text", text: `${text}${listedFiles}` }] };
		},
	});
}
