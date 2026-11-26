// The skills plugin on the server: its kind (`serveThing`: the things plugin admits every caller), the store of the
// sets' folders (`store.ts`), each set's skills as read from its folder and watched (`set.ts`), and `read`, a skill's
// text, read from the Pi's disk when it is asked for. The store refuses a folder outside the Pi's skills root.

import { defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { SkillsKind } from "./contract.ts";
import { readSkill, skillsRoot } from "./folder.ts";
import { SkillSet, serveSet } from "./set.ts";
import { SkillsStore, serveStore } from "./store.ts";

export default defineFacet((host) => {
	serveStore(host);
	serveSet(host);
	serveThing(host, SkillsKind, {
		implement: ({ thing }, _caller, self) => {
			const root = skillsRoot(self.registry(ServerRuntime).value.dataDir);
			const set = self.get(SkillSet, { thing });
			const found = self.liveQuery(self.get(SkillsStore, {}).settings.of, { thing }, { first: 1 });
			return {
				skills: set.skills,
				folder: self.derive([found], ([{ rows }]) => rows[0]?.folder ?? ""),
				read: ({ name }) => readSkill(root, set.path.value, name),
			};
		},
		configure: async (thing, { folder }, ctx) => {
			// `Workspace.configure` checked the value against the state member's schema (`folder`: a string).
			await (await ctx.get(SkillsStore, {})).set({ thing, folder: folder as string }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(SkillsStore, {})).clear({ thing }, ctx);
		},
	});
});
