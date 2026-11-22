// The canvas store on the server (`CanvasStore`): one table of every board's committed shapes, keyed by the session's
// address and the board's thing (so a session's export, import and delete carry them), its named query, and every
// write. Server code of this plugin only: it checks no caller (`Canvas` admits them).

import {
	and,
	arr,
	defineTable,
	eq,
	type FacetHost,
	host as hostColumn,
	int,
	invalid,
	json,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	Session,
	str,
} from "@earendil-works/p3/v1";
import { PlacedShape, Shape } from "./contract.ts";

/** The boards' shapes, once per server: each board's shapes as a named query, oldest first, and the writes. */
export const CanvasStore = local("canvas.store", {
	version: 1,
	params: {},
	members: {
		shapes: queries(PlacedShape, {
			/** Board `thing` of session `session`: its shapes, the oldest first. */
			of: obj({ session: str(), thing: str() }),
		}),
		/** Adds `shapes` to a board, in order, drawn by `author`; answers their ids. */
		add: method(obj({ session: str(), thing: str(), shapes: arr(Shape), author: str() }), arr(str())),
		remove: method(obj({ session: str(), thing: str(), id: str() })),
		/** Removes every shape of a board. */
		clear: method(obj({ session: str(), thing: str() })),
	},
});

/**
 * Every board's shapes: the session's address, the board's thing, the shape's id, its place in the board's order
 * (`seq`), who drew it and the shape. Index `by_order`: a board's shapes in the order they were added.
 */
const Shapes = defineTable("canvas.shapes", {
	version: 1,
	columns: {
		session: hostColumn(Session),
		thing: str(),
		id: str(),
		seq: int(),
		author: str(),
		shape: json(Shape, { version: 1 }),
	},
	key: ["session", "thing", "id"],
	indexes: { by_order: ["session", "thing", "seq"] },
});

/** Serves `CanvasStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(CanvasStore, (_params, self) => {
		const shapes = self.table(Shapes);
		// The last `seq` this attempt gave: shapes added in one millisecond keep the order they were added in.
		let last = 0;
		const next = () => {
			last = Math.max(Date.now() * 1000, last + 1);
			return last;
		};
		return {
			shapes: self.queries(
				shapes,
				{ map: ({ id, author, shape }) => ({ id, author, shape }), reads: ["id", "author", "shape"] },
				{
					// Index `by_order`: `session` and `thing` fixed, in the order of `seq`, then the key.
					of: ({ session, thing }: { session: string; thing: string }) =>
						query(Shapes)
							.where((shape) => and(eq(shape.session, Session({ id: session })), eq(shape.thing, thing)))
							.orderBy((shape) => shape.seq, "asc"),
				},
			),
			add: async ({ session, thing, shapes: added, author }, ctx) => {
				const ids = added.map(() => crypto.randomUUID());
				await self.tx(async (tx) => {
					added.forEach((shape, at) => {
						tx.put(shapes, {
							session: Session({ id: session }),
							thing,
							id: ids[at]!,
							seq: next(),
							author,
							shape,
						});
					});
					return null;
				}, ctx);
				return ids;
			},
			remove: ({ session, thing, id }, ctx) =>
				self.tx(async (tx) => {
					const key = { session: Session({ id: session }), thing, id };
					if ((await tx.get(shapes, key)) === undefined) {
						throw invalid("args", `canvas: board ${thing} of ${session} has no shape ${id}`);
					}
					tx.delete(shapes, key);
					return null;
				}, ctx),
			clear: ({ session, thing }, ctx) =>
				self.tx(async (tx) => {
					tx.deleteWhere(shapes, (shape) =>
						and(eq(shape.session, Session({ id: session })), eq(shape.thing, thing)),
					);
					return null;
				}, ctx),
		};
	});
}
