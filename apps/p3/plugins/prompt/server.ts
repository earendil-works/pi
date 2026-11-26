// The prompt plugin on the server: its two kinds (`serveThing`: the things plugin admits every caller) over one store
// of their settings (`store.ts`). Instructions read their settings live (no text while never set); Pi's first one is
// seeded at start (`one`) with a default text. A set of skills hands out its shared read (`set.ts`: the folder's skills, watched)
// and `read`, a skill's text, read from the Pi's disk when asked for.

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "../things/serve.ts";
import { InstructionsKind } from "./instructions-kind.ts";
import { SkillSet, serveSet } from "./set.ts";
import { SkillsKind } from "./skills-kind.ts";
import { type InstructionsSettings, PromptStore, serveStore, UNSET_INSTRUCTIONS } from "./store.ts";

/** This plugin's name: the maker of the things it seeds. */
const PLUGIN = "@earendil-works/p3-prompt";

/** What Pi's seeded instructions say at first. */
const SEED: InstructionsSettings = {
	language: "en",
	text: "Be direct and concise. Ask before you change or delete something you did not make.",
};

export default defineFacet((host) => {
	serveStore(host);
	serveSet(host);

	serveThing(host, InstructionsKind, {
		implement: ({ thing }, _caller, self) => {
			const found = self.liveQuery(self.get(PromptStore, {}).instructions.of, { thing }, { first: 1 });
			const settings = self.derive([found], ([{ rows }]) => rows[0] ?? UNSET_INSTRUCTIONS);
			return {
				text: self.derive([settings], ([{ text }]) => text),
				language: self.derive([settings], ([{ language }]) => language),
			};
		},
		// Pi's seed (made by this plugin, `one`) starts with the default text; a person's new instructions start empty.
		create: async (thing, _input, by, ctx) => {
			if (by.kind !== "plugin" || by.plugin !== PLUGIN) return;
			await (await ctx.get(PromptStore, {})).configureInstructions({ thing, ...SEED }, ctx);
		},
		configure: async (thing, settings, ctx) => {
			// `Workspace.configure` checked each value against its state member's schema (`text`, `language`).
			const given = settings as Partial<InstructionsSettings>;
			await (await ctx.get(PromptStore, {})).configureInstructions({ thing, ...given }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(PromptStore, {})).clearInstructions({ thing }, ctx);
		},
		one: { name: "Instructions" },
	});

	serveThing(host, SkillsKind, {
		// One object per set holds its folder's read and its watcher; every caller's object hands out that one.
		implement: ({ thing }, _caller, self) => {
			const set = self.get(SkillSet, { thing });
			return { skills: set.skills, folder: set.folder, read: (args, ctx) => set.read(args, ctx) };
		},
		configure: async (thing, { folder }, ctx) => {
			// The one setting, left out: nothing to change.
			if (folder === undefined) return;
			// `Workspace.configure` checked the value against the state member's schema (`folder`: a string).
			await (await ctx.get(PromptStore, {})).configureSkills({ thing, folder: folder as string }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(PromptStore, {})).clearSkills({ thing }, ctx);
		},
	});
});
