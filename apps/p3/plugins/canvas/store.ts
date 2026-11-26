// The canvas store on the server (`CanvasStore`): every canvas's committed shapes, keyed by the canvas's thing id (a
// canvas is a thing, made and owned through the sessions plugin; its shapes are this plugin's), their named query, and
// every write. Server code of this plugin only: it checks no caller (`Canvas` admits them).

import {
	arr,
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
	str,
} from "@earendil-works/p3/v1";
import { PlacedShape, Shape } from "./contract.ts";

/** The canvases' shapes, once per server: each canvas's shapes as a named query, oldest first, and the writes. */
export const CanvasStore = local("canvas.store", {
	version: 1,
	params: {},
	members: {
		shapes: queries(PlacedShape, {
			/** Canvas `canvas`'s shapes, the oldest first. */
			of: obj({ canvas: str() }),
		}),
		/** Adds `shapes` to `canvas`, in order, drawn by `author`; answers their ids. */
		add: method(obj({ canvas: str(), shapes: arr(Shape), author: str() }), arr(str())),
		remove: method(obj({ canvas: str(), id: str() })),
		/** Removes every shape of `canvas` (cleared, or the canvas deleted). */
		clear: method(obj({ canvas: str() })),
	},
});

/**
 * Every canvas's shapes: the canvas (its thing id), the shape's id, its place in the canvas's order (`seq`), who drew
 * it and the shape. Index `by_order`: a canvas's shapes in the order they were added.
 */
const Shapes = defineTable("canvas.shapes", {
	version: 1,
	columns: { canvas: str(), id: str(), seq: int(), author: str(), shape: json(Shape, { version: 1 }) },
	key: ["canvas", "id"],
	indexes: { by_order: ["canvas", "seq"] },
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
					added.forEach((shape, at) => {
						tx.put(shapes, { canvas, id: ids[at]!, seq: next(), author, shape });
					});
					return null;
				}, ctx);
				return ids;
			},
			remove: ({ canvas, id }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(shapes, { canvas, id })) === undefined) {
						throw invalid("args", `canvas: ${canvas} has no shape ${id}`);
					}
					tx.delete(shapes, { canvas, id });
					return null;
				}, ctx),
			clear: ({ canvas }, ctx) =>
				self.tx(async (tx) => {
					tx.deleteWhere(shapes, (shape) => eq(shape.canvas, canvas));
					return null;
				}, ctx),
		};
	});
}
