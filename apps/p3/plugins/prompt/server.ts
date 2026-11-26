// The prompt plugin on the server: its two kinds (`serveThing`: the things plugin admits every caller) over one store
// of their settings (`store.ts`). Instructions read their settings live, the default while never set, and Pi's first
// one is seeded at start (`one`). A set of skills hands out its shared read (`set.ts`: the folder's skills, watched)
// and `read`, a skill's text, read from the Pi's disk when asked for.

import { defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { readSkill, skillsRoot } from "./folder.ts";
import { InstructionsKind } from "./instructions-kind.ts";
import { SkillSet, serveSet } from "./set.ts";
import { SkillsKind } from "./skills-kind.ts";
import { DEFAULT_INSTRUCTIONS, type InstructionsSettings, PromptStore, serveStore } from "./store.ts";

export default defineFacet((host) => {
	serveStore(host);
	serveSet(host);

	serveThing(host, InstructionsKind, {
		implement: ({ thing }, _caller, self) => {
			const found = self.liveQuery(self.get(PromptStore, {}).instructions.of, { thing }, { first: 1 });
			const settings = self.derive([found], ([{ rows }]) => rows[0] ?? DEFAULT_INSTRUCTIONS);
			return {
				text: self.derive([settings], ([{ text }]) => text),
				language: self.derive([settings], ([{ language }]) => language),
			};
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
		implement: ({ thing }, _caller, self) => {
			const root = skillsRoot(self.registry(ServerRuntime).value.dataDir);
			const set = self.get(SkillSet, { thing });
			const found = self.liveQuery(self.get(PromptStore, {}).skills.of, { thing }, { first: 1 });
			return {
				skills: set.skills,
				folder: self.derive([found], ([{ rows }]) => rows[0]?.folder ?? ""),
				read: ({ name }) => readSkill(root, set.path.value, name),
			};
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
