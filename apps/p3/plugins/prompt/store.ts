// The prompt store on the server (`PromptStore`): the settings of every instructions thing (its text and language) and
// of every set of skills (its folder), each keyed by the thing's id, read through `settings.of`, written by one
// merging method per kind inside one transaction (two Configures at once never lose one's change). A thing whose
// settings were never set reads them unset. A thing's settings live as long as the thing: its kind's `delete`
// clears them. Server code of this plugin only: it checks no caller (the things plugin admits them).

import {
	defineTable,
	eq,
	type FacetHost,
	json,
	local,
	method,
	obj,
	opt,
	type P3Principal,
	queries,
	query,
	str,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { folderPath, skillsRoot } from "./folder.ts";
import { InstructionsSettings, InstructionsText, Language } from "./instructions-kind.ts";

/** What instructions read while never configured: no text (no prompt section), in English. */
export const UNSET_INSTRUCTIONS: InstructionsSettings = { language: "en", text: "" };

/** A set of skills' settings: its folder, relative to the Pi's skills root (`""`: none, no skills). */
export const SkillsSettings = obj({ folder: str() });

/** The prompt plugin's settings, once per server: each kind's as a named query, and the writes. */
export const PromptStore = local("prompt.store", {
	version: 1,
	params: {},
	members: {
		instructions: queries(InstructionsSettings, {
			/** Instructions `thing`'s settings: one row, none while never set (the default). */
			of: obj({ thing: str() }),
		}),
		skills: queries(SkillsSettings, {
			/** Set `thing`'s settings: one row, none while never set (no folder). */
			of: obj({ thing: str() }),
		}),
		/** Sets some of instructions `thing`'s settings, keeping the others (the default where never set). */
		configureInstructions: method(obj({ thing: str(), text: opt(InstructionsText), language: opt(Language) })),
		/** Sets set `thing`'s folder; `invalid` outside the Pi's skills root. */
		configureSkills: method(obj({ thing: str(), folder: str() })),
		/** Removes instructions `thing`'s settings (the thing is gone); safe to run twice. */
		clearInstructions: method(obj({ thing: str() })),
		/** Removes set `thing`'s settings (the thing is gone); safe to run twice. */
		clearSkills: method(obj({ thing: str() })),
	},
});

/** Every instructions thing's settings, by its id. */
const InstructionsRows = defineTable("prompt.instructions-settings", {
	version: 1,
	columns: { thing: str(), text: str(), language: json(Language, { version: 1 }) },
	key: ["thing"],
});

/** Every set of skills' settings, by its id. */
const SkillsRows = defineTable("prompt.skills-settings", {
	version: 1,
	columns: { thing: str(), folder: str() },
	key: ["thing"],
});

/** Serves `PromptStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(PromptStore, (_params, self) => {
		const instructions = self.table(InstructionsRows);
		const skills = self.table(SkillsRows);
		const root = skillsRoot(self.registry(ServerRuntime).value.dataDir);
		return {
			instructions: self.queries(
				instructions,
				{ map: ({ text, language }) => ({ text, language }), reads: ["text", "language"] },
				// The key: one row.
				{ of: ({ thing }: { thing: string }) => query(InstructionsRows).where((row) => eq(row.thing, thing)) },
			),
			skills: self.queries(
				skills,
				{ map: ({ folder }) => ({ folder }), reads: ["folder"] },
				// The key: one row.
				{ of: ({ thing }: { thing: string }) => query(SkillsRows).where((row) => eq(row.thing, thing)) },
			),
			configureInstructions: ({ thing, text, language }, ctx) =>
				self.tx(async (tx) => {
					const stored = (await tx.get(instructions, { thing })) ?? { thing, ...UNSET_INSTRUCTIONS };
					tx.put(instructions, {
						...stored,
						...(text === undefined ? {} : { text }),
						...(language === undefined ? {} : { language }),
					});
					return null;
				}, ctx),
			configureSkills: ({ thing, folder }, ctx) =>
				self.tx(async (tx) => {
					// A setting people write: the one check that it stays under the root.
					folderPath(root, folder);
					tx.put(skills, { thing, folder });
					return null;
				}, ctx),
			clearInstructions: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(instructions, { thing });
					return null;
				}, ctx),
			clearSkills: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(skills, { thing });
					return null;
				}, ctx),
		};
	});
}
