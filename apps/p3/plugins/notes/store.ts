// The notes store on the server (`NotesStore`): every notebook's notes and its order (its one setting), keyed by the
// notebook's thing id (the thing itself, its name and where it is linked are the things plugin's), their named
// queries, and every write. A notebook's
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
import { NotesOrder } from "./contract.ts";

/** A note as the store keeps it: its id, text, when it was written last and who wrote it, as their admission said. */
export const StoredNote = obj({ id: str(), text: str(), at: int(), author: Caller });

/** A note as the store keeps it (see `StoredNote`). */
export type StoredNote = Static<typeof StoredNote>;

/**
 * The notebooks' notes and orders, once per server: each notebook's notes in an order and its order as named
 * queries, and the writes. A notebook is its thing's id.
 */
export const NotesStore = local("notes.store", {
	version: 1,
	params: {},
	members: {
		notes: queries(StoredNote, {
			/** Notebook `notebook`'s notes in `order`. */
			of: obj({ notebook: str(), order: NotesOrder }),
		}),
		orders: queries(obj({ order: NotesOrder }), {
			/** Notebook `notebook`'s order; none while it was never set (the default, "newest"). */
			of: obj({ notebook: str() }),
		}),
		/** Adds a note to `notebook`, written now by `author`; answers its id. */
		add: method(obj({ notebook: str(), text: str(), author: Caller }), str()),
		/** Replaces note `id`'s text: written now, by `author`. */
		edit: method(obj({ notebook: str(), id: str(), text: str(), author: Caller })),
		/** Removes note `id`. */
		remove: method(obj({ notebook: str(), id: str() })),
		/** Sets notebook `notebook`'s order. */
		setOrder: method(obj({ notebook: str(), order: NotesOrder })),
		/**
		 * Removes every note of `notebook` and its order, and marks it gone (its thing is gone): an add or an order a
		 * caller started before, committed after, is refused, so nothing of it comes back.
		 */
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

/** Every notebook's order that was set; one row per notebook. */
const Orders = defineTable("notes.orders", {
	version: 1,
	columns: { notebook: str(), order: json(NotesOrder, { version: 1 }) },
	key: ["notebook"],
});

/**
 * The notebooks whose thing is gone (`clear`). Thing ids are never used again, so a mark stays: one row per deleted
 * notebook.
 */
const Gone = defineTable("notes.gone", {
	version: 1,
	columns: { notebook: str() },
	key: ["notebook"],
});

/** Serves `NotesStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(NotesStore, (_params, self) => {
		const rows = self.table(Rows);
		const orders = self.table(Orders);
		const gone = self.table(Gone);
		/** Refuses a write to `notebook` once it is gone: checked in the write's own transaction, which `clear`'s orders. */
		const present = async (tx: Tx, notebook: string) => {
			if ((await tx.get(gone, { notebook })) !== undefined) throw invalid("args", `notes: ${notebook} is gone`);
		};
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
					// Index `by_time`: `notebook` fixed, in the order of `at` (either way), then the key.
					of: ({ notebook, order }: { notebook: string; order: NotesOrder }) =>
						query(Rows)
							.where((note) => eq(note.notebook, notebook))
							.orderBy((note) => note.at, order === "newest" ? "desc" : "asc"),
				},
			),
			orders: self.queries(
				orders,
				{ map: ({ order }) => ({ order }), reads: ["order"] },
				{
					// The key.
					of: ({ notebook }: { notebook: string }) => query(Orders).where((row) => eq(row.notebook, notebook)),
				},
			),
			setOrder: ({ notebook, order }, ctx) =>
				self.tx(async (tx) => {
					await present(tx, notebook);
					tx.put(orders, { notebook, order });
					return null;
				}, ctx),
			add: async ({ notebook, text, author }, ctx) => {
				const id = crypto.randomUUID();
				await self.tx(async (tx) => {
					await present(tx, notebook);
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
					// The key's prefix `notebook`: one statement each.
					tx.deleteWhere(rows, (note) => eq(note.notebook, notebook));
					tx.delete(orders, { notebook });
					tx.put(gone, { notebook });
					return null;
				}, ctx),
		};
	});
}

/** The refusal of a note `notebook` does not have. */
function noNote(notebook: string, id: string) {
	return invalid("args", `notes: ${notebook} has no note ${id}`);
}
