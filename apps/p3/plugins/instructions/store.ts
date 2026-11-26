// The instructions store on the server (`InstructionsStore`): every instructions thing's settings (its text and its
// language), keyed by the thing's id, its named query and its writes. A thing's settings live as long as the thing:
// its kind's `delete` clears them. Server code of this plugin only: it checks no caller (`Instructions` admits them).

import {
	defineTable,
	eq,
	type FacetHost,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	str,
} from "@earendil-works/p3/v1";
import { InstructionsSettings, InstructionsText, Language } from "./contract.ts";

/** The instructions' settings, once per server: one thing's as a named query, and the writes. */
export const InstructionsStore = local("instructions.store", {
	version: 1,
	params: {},
	members: {
		settings: queries(InstructionsSettings, {
			/** Thing `thing`'s settings: one row, none before they were first set. */
			of: obj({ thing: str() }),
		}),
		/** Sets thing `thing`'s text and language. */
		set: method(obj({ thing: str(), text: InstructionsText, language: Language })),
		/** Removes thing `thing`'s settings (the thing is gone). */
		clear: method(obj({ thing: str() })),
	},
});

/** Every instructions thing's settings, by its id. */
const Rows = defineTable("instructions.rows", {
	version: 1,
	columns: { thing: str(), text: str(), language: str() },
	key: ["thing"],
});

/** Serves `InstructionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(InstructionsStore, (_params, self) => {
		const rows = self.table(Rows);
		return {
			settings: self.queries(
				rows,
				// The column holds only what `set` wrote, a `Language`: a column's schema cannot say so.
				{ map: ({ text, language }) => ({ text, language: language as Language }), reads: ["text", "language"] },
				{
					// The key: one row.
					of: ({ thing }: { thing: string }) => query(Rows).where((row) => eq(row.thing, thing)),
				},
			),
			set: ({ thing, text, language }, ctx) =>
				self.tx(async (tx) => {
					tx.put(rows, { thing, text, language });
					return null;
				}, ctx),
			clear: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(rows, { thing });
					return null;
				}, ctx),
		};
	});
}
