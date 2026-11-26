// The notes store on the server (`NotesStore`): every notebook's notes, keyed by the notebook's thing id (the thing
// itself, its name and where it is linked are the things plugin's), its named query, and every write. A notebook's
// notes live as long as its thing: its kind's `delete` clears them. Server code of this plugin only: it checks no
// caller (`Notes` admits them).

import {
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	json,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	type Static,
	str,
	type Tx,
} from "@earendil-works/p3/v1";
import { Caller } from "../things/contract.ts";

/** A note as the store keeps it: its id, text, when it was written last and who wrote it, as their admission said. */
export const StoredNote = obj({ id: str(), text: str(), at: int(), author: Caller });

/** A note as the store keeps it (see `StoredNote`). */
export type StoredNote = Static<typeof StoredNote>;

/**
 * The notebooks' notes, once per server: each notebook's notes as a named query, the last written first, and the
 * writes. A notebook is its thing's id.
 */
export const NotesStore = local("notes.store", {
	version: 1,
	params: {},
	members: {
		notes: queries(StoredNote, {
			/** Notebook `notebook`'s notes, the last written first. */
			of: obj({ notebook: str() }),
		}),
		/** Adds a note to `notebook`, written now by `author`; answers its id. */
		add: method(obj({ notebook: str(), text: str(), author: Caller }), str()),
		/** Replaces note `id`'s text: written now, by `author`. */
		edit: method(obj({ notebook: str(), id: str(), text: str(), author: Caller })),
		/** Removes note `id`. */
		remove: method(obj({ notebook: str(), id: str() })),
		/** Removes every note of `notebook` (its thing is gone). */
		clear: method(obj({ notebook: str() })),
	},
});

/** Every note of every notebook. Index `by_time`: a notebook's notes in the order they were written last. */
const Rows = defineTable("notes.rows", {
	version: 1,
	columns: { notebook: str(), id: str(), text: str(), at: int(), author: json(Caller, { version: 1 }) },
	key: ["notebook", "id"],
	indexes: { by_time: ["notebook", "at"] },
});

/** Serves `NotesStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(NotesStore, (_params, self) => {
		const rows = self.table(Rows);
		/**
		 * When a note of `notebook` written now is: now, or just after its last written note, so `at` is unique in a
		 * notebook and the last written stays first also within one millisecond (index `by_time`, one row).
		 */
		const nextAt = async (tx: Tx, notebook: string) => {
			const last = query(Rows)
				.where((note) => eq(note.notebook, notebook))
				.orderBy((note) => note.at, "desc");
			const [newest] = (await tx.page(rows, last, 1)).items;
			return Math.max(Date.now(), (newest?.at ?? 0) + 1);
		};
		return {
			notes: self.queries(
				rows,
				{ map: ({ id, text, at, author }) => ({ id, text, at, author }), reads: ["id", "text", "at", "author"] },
				{
					// Index `by_time`: `notebook` fixed, in the order of `at`, then the key.
					of: ({ notebook }: { notebook: string }) =>
						query(Rows)
							.where((note) => eq(note.notebook, notebook))
							.orderBy((note) => note.at, "desc"),
				},
			),
			add: async ({ notebook, text, author }, ctx) => {
				const id = crypto.randomUUID();
				await self.tx(async (tx) => {
					tx.put(rows, { notebook, id, text, at: await nextAt(tx, notebook), author });
					return null;
				}, ctx);
				return id;
			},
			edit: ({ notebook, id, text, author }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(rows, { notebook, id })) === undefined) throw noNote(notebook, id);
					tx.update(rows, { notebook, id }, { text, at: await nextAt(tx, notebook), author });
					return null;
				}, ctx),
			remove: ({ notebook, id }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(rows, { notebook, id })) === undefined) throw noNote(notebook, id);
					tx.delete(rows, { notebook, id });
					return null;
				}, ctx),
			clear: ({ notebook }, ctx) =>
				self.tx(async (tx) => {
					// The key's prefix `notebook`: one statement.
					tx.deleteWhere(rows, (note) => eq(note.notebook, notebook));
					return null;
				}, ctx),
		};
	});
}

/** The refusal of a note `notebook` does not have. */
function noNote(notebook: string, id: string) {
	return invalid("args", `notes: ${notebook} has no note ${id}`);
}
