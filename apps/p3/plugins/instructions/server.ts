// The instructions plugin on the server: its kind (`serveThing`: the things plugin admits every caller), the store of
// the instructions' settings (`store.ts`), and Pi's first instructions, which the things plugin makes at start
// (`one`) with the default text. A thing whose settings were never set reads the default too.

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "../things/serve.ts";
import { InstructionsKind, type InstructionsSettings } from "./contract.ts";
import { InstructionsStore, serveStore } from "./store.ts";

/** What instructions say before anyone set them: Pi's seed. */
const DEFAULT: InstructionsSettings = {
	language: "en",
	text: "Be direct and concise. Ask before you change or delete something you did not make.",
};

export default defineFacet((host) => {
	serveStore(host);
	serveThing(host, InstructionsKind, {
		implement: ({ thing }, _caller, self) => {
			const store = self.get(InstructionsStore, {});
			const found = self.liveQuery(store.settings.of, { thing }, { first: 1 });
			const settings = self.derive([found], ([{ rows }]) => rows[0] ?? DEFAULT);
			return {
				text: self.derive([settings], ([{ text }]) => text),
				language: self.derive([settings], ([{ language }]) => language),
			};
		},
		configure: async (thing, settings, ctx) => {
			const store = await ctx.get(InstructionsStore, {});
			const [stored] = (await store.settings.of.page({ thing }, 1, ctx)).items;
			// `Workspace.configure` checked each value against its state member's schema (`text`, `language`).
			const given = settings as Partial<InstructionsSettings>;
			await store.set({ thing, ...(stored ?? DEFAULT), ...given }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(InstructionsStore, {})).clear({ thing }, ctx);
		},
		one: { name: "Instructions" },
	});
});
