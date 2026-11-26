// The skills store on the server (`SkillsStore`): every set's folder (its setting), keyed by the thing's id, its named
// query and its writes. A set's setting lives as long as the thing: its kind's `delete` clears it. Server code of this
// plugin only: it checks no caller (`Skills` admits them).

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

/** The sets' folders, once per server: one set's as a named query, and the writes. */
export const SkillsStore = local("skills.store", {
	version: 1,
	params: {},
	members: {
		settings: queries(obj({ folder: str() }), {
			/** Set `thing`'s folder: one row, none before it was first set. */
			of: obj({ thing: str() }),
		}),
		/** Sets set `thing`'s folder (relative to the skills root, checked by the caller). */
		set: method(obj({ thing: str(), folder: str() })),
		/** Removes set `thing`'s setting (the thing is gone). */
		clear: method(obj({ thing: str() })),
	},
});

/** Every set's folder, by its id. */
const Rows = defineTable("skills.rows", {
	version: 1,
	columns: { thing: str(), folder: str() },
	key: ["thing"],
});

/** Serves `SkillsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SkillsStore, (_params, self) => {
		const rows = self.table(Rows);
		return {
			settings: self.queries(
				rows,
				{ map: ({ folder }) => ({ folder }), reads: ["folder"] },
				{
					// The key: one row.
					of: ({ thing }: { thing: string }) => query(Rows).where((row) => eq(row.thing, thing)),
				},
			),
			set: ({ thing, folder }, ctx) =>
				self.tx(async (tx) => {
					tx.put(rows, { thing, folder });
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
