// The skills kind (`prompt.skills`, decision 101): a set of skills, the folders under one folder of the Pi's skills
// root (`<data directory>/skills`), each with a `SKILL.md`. Made by people. Every set that reaches a session adds its
// skills; a name in two sets is the closer set's. The list and the folder are plain: whoever is let in sees which
// skills there are. Use, for agents, gives `read`: a skill's text and the names of its files. The folder is the set's
// setting, changed with Configure where it is linked (decision 91); a set without one has no skills. No guests.

import { arr, method, obj, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** A skill in a set's list: its name and description, from its `SKILL.md`'s front matter (no name: the folder's). */
export const Skill = obj({ name: str(), description: str() });

/** A skill in a set's list (see `Skill`). */
export type Skill = Static<typeof Skill>;

/** A skill's text (its whole `SKILL.md`) and the paths of the other files in its folder, relative to it. */
export const SkillText = obj({ text: str(), files: arr(str()) });

/** A skill's text and files (see `SkillText`). */
export type SkillText = Static<typeof SkillText>;

/** What Use gives: the members an agent with Use is granted. */
export const SKILLS_USES = ["read"] as const;

/** A set of skills: the list and the folder, plain; Use gives `read`. */
export const SkillsKind = defineThing("prompt.skills", {
	version: 1,
	makers: "people",
	state: { skills: arr(Skill), folder: str() },
	methods: {
		/** The text and files of the skill `name` of this set; `invalid` for a name the set has not. */
		read: method(obj({ name: str() }), SkillText),
	},
	ticks: {
		// `skills` and `folder` are given by no tick: for everyone let in.
		use: { label: messages.message("skillsTickUse"), for: "agents", gives: SKILLS_USES },
	},
	defaultGrants: { agents: ["use"] },
	settings: ["folder"],
});

/** A set of skills held in a workspace: `SkillsKind`'s contract. */
export const Skills = SkillsKind.contract;
