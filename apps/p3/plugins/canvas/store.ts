// The canvas store on the server (`CanvasStore`): every board's committed shapes, keyed by the board's thing id (the
// thing itself, its name and where it is linked are the things plugin's), their named query, and every write. A
// board's shapes live as long as its thing: its kind's `delete` clears them and marks the board gone. Server code of
// this plugin only: it checks no caller (`Canvas` admits them). The shapes table's version 2 stores authors as the
// things plugin's `Caller`; version 1's text keys are migrated (decision 125).

import {
	arr,
	defineTable,
	eq,
	evolveTable,
	type FacetHost,
	int,
	invalid,
	json,
	local,
	method,
	obj,
	opt,
	type P3Principal,
	queries,
	query,
	str,
	type Tx,
} from "@earendil-works/p3/v1";
import { Caller } from "../things/contract.ts";
import { PlacedShape, Shape, sameCaller } from "./kind.ts";
import { messages } from "./messages.ts";

/** The boards' shapes, once per server: each board's shapes as a named query, oldest first, and the writes. */
export const CanvasStore = local("canvas.store", {
	version: 2,
	params: {},
	members: {
		shapes: queries(PlacedShape, {
			/** Board `canvas`'s shapes, the oldest first. */
			of: obj({ canvas: str() }),
		}),
		/** Adds `shapes` to `canvas`, in order, drawn by `author`; answers their ids. Refused once the board is gone. */
		add: method(obj({ canvas: str(), shapes: arr(Shape), author: Caller }), arr(str())),
		/** Removes shape `id` of `canvas`; with `author`, only a shape they drew. */
		remove: method(obj({ canvas: str(), id: str(), author: opt(Caller) })),
		/** Removes every shape of `canvas` (cleared by a moderator). */
		clear: method(obj({ canvas: str() })),
		/**
		 * Removes every shape of `canvas` and marks it gone (its thing is gone): an add begun before, committed after, is
		 * refused, so nothing of it comes back. Safe to run again.
		 */
		drop: method(obj({ canvas: str() })),
	},
});

/**
 * Every board's shapes as version 1 stored them (Pis deployed from 7093618af): the author as a text key
 * (`person:<id>`, `agent:<session>`, `server`). Index `by_order`: a board's shapes in the order they were added.
 */
const ShapesV1 = defineTable("canvas.shapes", {
	version: 1,
	columns: { canvas: str(), id: str(), seq: int(), author: str(), shape: json(Shape, { version: 1 }) },
	key: ["canvas", "id"],
	indexes: { by_order: ["canvas", "seq"] },
});

/**
 * Version 2: who drew a shape as the things plugin's `Caller`, parsed from version 1's key; a key of none of the three
 * forms (only this plugin wrote them, always in one of them) reads as the Pi itself. A column added to rows already
 * there must be `opt(...)` (Chord's `add`): every row has one after the data step, and every write sets it.
 */
const Shapes = evolveTable(ShapesV1, (t) =>
	t
		.rename("author", "authorKey")
		.add("author", opt(json(Caller, { version: 1 })))
		.rows((row) => ({ author: callerOfKey(row.authorKey) }))
		.drop("authorKey"),
);

/** Who version 1's author key `key` names. */
function callerOfKey(key: string): Caller {
	if (key.startsWith("person:")) return { kind: "person", person: key.slice("person:".length) };
	if (key.startsWith("agent:")) return { kind: "agent", session: key.slice("agent:".length) };
	return { kind: "server" };
}

/**
 * The boards whose thing is gone (`drop`). Thing ids are never used again, so a mark stays: one row per deleted
 * board.
 */
const Gone = defineTable("canvas.gone", {
	version: 1,
	columns: { canvas: str() },
	key: ["canvas"],
});

/** Serves `CanvasStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(CanvasStore, (_params, self) => {
		const shapes = self.table(Shapes);
		const gone = self.table(Gone);
		/** Refuses a write to `canvas` once it is gone, in the write's own transaction: `drop`'s is ordered with it. */
		const present = async (tx: Tx, canvas: string) => {
			if ((await tx.get(gone, { canvas })) !== undefined) {
				throw invalid("args", `canvas: ${canvas} is gone`, { message: messages.message("gone") });
			}
		};
		return {
			shapes: self.queries(
				shapes,
				{
					// Every row has an author since version 2's data step, and every write sets one.
					map: ({ id, author, shape }) => ({ id, author: author!, shape }),
					reads: ["id", "author", "shape"],
				},
				{
					// Index `by_order`: `canvas` fixed, in the order of `seq`, then the key.
					of: ({ canvas }: { canvas: string }) =>
						query(Shapes)
							.where((shape) => eq(shape.canvas, canvas))
							.orderBy((shape) => shape.seq, "asc"),
				},
			),
			add: async ({ canvas, shapes: added, author }, ctx) => {
				const ids = added.map(() => crypto.randomUUID());
				await self.tx(async (tx) => {
					await present(tx, canvas);
					// After the board's last stored shape, whatever this process's clock or an earlier attempt gave: a
					// reload or a clock gone back keeps the order shapes were added in. Index `by_order`, one row.
					const newest = query(Shapes)
						.where((shape) => eq(shape.canvas, canvas))
						.orderBy((shape) => shape.seq, "desc");
					const [last] = (await tx.page(shapes, newest, 1)).items;
					let seq = Math.max(Date.now() * 1000, (last?.seq ?? 0) + 1);
					added.forEach((shape, at) => {
						tx.put(shapes, { canvas, id: ids[at]!, seq: seq++, author, shape });
					});
					return null;
				}, ctx);
				return ids;
			},
			remove: ({ canvas, id, author }, ctx) =>
				self.tx(async (tx) => {
					const found = await tx.get(shapes, { canvas, id });
					if (found === undefined) {
						throw invalid("args", `canvas: ${canvas} has no shape ${id}`, {
							message: messages.message("noShape"),
						});
					}
					if (author !== undefined && !sameCaller(found.author!, author)) {
						throw invalid("args", `canvas: shape ${id} was drawn by someone else`, {
							message: messages.message("notYours"),
						});
					}
					tx.delete(shapes, { canvas, id });
					return null;
				}, ctx),
			clear: ({ canvas }, ctx) =>
				self.tx(async (tx) => {
					// The key's prefix `canvas`: one statement.
					tx.deleteWhere(shapes, (shape) => eq(shape.canvas, canvas));
					return null;
				}, ctx),
			drop: ({ canvas }, ctx) =>
				self.tx(async (tx) => {
					tx.deleteWhere(shapes, (shape) => eq(shape.canvas, canvas));
					tx.put(gone, { canvas });
					return null;
				}, ctx),
		};
	});
}
