// The canvas store on the server (`CanvasStore`): every board's committed shapes, keyed by the board's thing id (the
// thing itself, its name and where it is linked are the things plugin's), their named query, and every write. A
// board's shapes live as long as its thing: its kind's `delete` clears them and marks the board gone. Server code of
// this plugin only: it checks no caller (`Canvas` admits them). A board holds `MAX_SHAPES` at most, counted in its row
// of `canvas.boards`, which also marks it gone. The shapes table's version 2 stores authors as the things plugin's
// `Caller`; version 1's text keys are migrated (decision 125).

import {
	arr,
	bool,
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
	sub,
	type Tx,
} from "@earendil-works/p3/v1";
import { Caller } from "../things/contract.ts";
import { MAX_SHAPES, PlacedShape, Shape, sameCaller } from "./kind.ts";
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
		/**
		 * Adds `shapes` to `canvas`, in order, drawn by `author`; answers their ids. Refused past `MAX_SHAPES` and once the
		 * board is gone.
		 */
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
 * Each board's count of shapes (what `MAX_SHAPES` bounds) and whether its thing is gone (`drop`). Thing ids are never
 * used again, so a gone board's row stays. A board without a row (new, or drawn on before version 2 of the shapes
 * table) is counted once through its index by its first add.
 */
const Boards = defineTable("canvas.boards", {
	version: 1,
	columns: { canvas: str(), shapes: int(), gone: bool() },
	key: ["canvas"],
});

/** Serves `CanvasStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(CanvasStore, (_params, self) => {
		const shapes = self.table(Shapes);
		const boards = self.table(Boards);
		/**
		 * Board `canvas`'s count of shapes, in a write's own transaction (`drop`'s is ordered with it): refused once it is
		 * gone. A board without a row is counted once through its index and the count stored now, whatever the write
		 * does next, so no later write counts it again (a board from before version 2 may already be full).
		 */
		const counted = async (tx: Tx, canvas: string) => {
			const board = await tx.get(boards, { canvas });
			if (board?.gone === true) {
				throw invalid("args", `canvas: ${canvas} is gone`, { message: messages.message("gone") });
			}
			if (board !== undefined) return board.shapes;
			// The key's prefix `canvas`: once per board.
			let count = 0;
			for await (const _ of tx.rows(
				shapes,
				query(Shapes).where((shape) => eq(shape.canvas, canvas)),
			))
				count++;
			tx.put(boards, { canvas, shapes: count, gone: false });
			return count;
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
				// A full board commits nothing but a count stored by this transaction; the refusal follows the commit.
				const full = await self.tx(async (tx) => {
					const count = await counted(tx, canvas);
					if (count + added.length > MAX_SHAPES) return true;
					tx.put(boards, { canvas, shapes: count + added.length, gone: false });
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
					return false;
				}, ctx);
				if (full) {
					throw invalid("args", `canvas: ${canvas} holds ${MAX_SHAPES} shapes at most`, {
						message: messages.message("full", MAX_SHAPES),
					});
				}
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
					// Every row has an author (see the map above).
					if (author !== undefined && !sameCaller(found.author!, author)) {
						throw invalid("args", `canvas: shape ${id} was drawn by someone else`, {
							message: messages.message("notYours"),
						});
					}
					tx.delete(shapes, { canvas, id });
					// A board without a row was never counted: its first add counts it, so nothing to change here.
					tx.update(boards, { canvas }, (board) => ({ shapes: sub(board.shapes, 1) }));
					return null;
				}, ctx),
			clear: ({ canvas }, ctx) =>
				self.tx(async (tx) => {
					// The key's prefix `canvas`: one statement.
					tx.deleteWhere(shapes, (shape) => eq(shape.canvas, canvas));
					tx.update(boards, { canvas }, { shapes: 0 });
					return null;
				}, ctx),
			drop: ({ canvas }, ctx) =>
				self.tx(async (tx) => {
					tx.deleteWhere(shapes, (shape) => eq(shape.canvas, canvas));
					tx.put(boards, { canvas, shapes: 0, gone: true });
					return null;
				}, ctx),
		};
	});
}
