// The canvas plugin on the server: the boards' store (`store.ts`), each board's motion where it is held (`motion.ts`)
// and the kind (`serveThing`). The things plugin makes, links, admits and deletes boards; this file says what a board
// is for one caller: its name, its shapes (the pages the caller loaded: one Chord list per caller), a page read now,
// the others' motion and the caller's own pointer, Draw's members (add, remove one's own) and Moderate's (clear, and
// removing anyone's with the flag `removeAny`). Its shapes go when the thing goes (`delete`).

import {
	type Context,
	type Ctx,
	constant,
	defineFacet,
	type P3Principal,
	type Reference,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import type { Caller } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { CanvasKind, type Mover, type Pointer } from "./kind.ts";
import { BoardMotion, serveMotion } from "./motion.ts";
import { CanvasStore, serveStore } from "./store.ts";

/** How many shapes a page of a board's list holds. */
const PAGE = 500;

export default defineFacet((host) => {
	serveStore(host);
	serveMotion(host);

	serveThing(host, CanvasKind, {
		// One board for one caller. The things plugin admitted them and decides which members they get: `add` and
		// `remove` with Draw, `clear` with Moderate. Every caller looks: the name, the shapes, the others' motion.
		implement: ({ workspace, thing }, { caller, granted }, self) => {
			const store = self.get(CanvasStore, {});
			const things = self.get(ThingsStore, {});
			const board = self.get(BoardMotion, { workspace, thing });
			const named = self.liveQuery(things.things.one, { thing }, { first: 1 });
			const list = self.list("shapes", [[store.shapes.of, { canvas: thing }]], { first: PAGE });
			const mover = moverOf(caller, things, self);
			const point = async (pointer: Pointer, ctx: Ctx<P3Principal>) => {
				await board.send({ kind: "point", who: mover.value, ...pointer }, ctx);
				return null;
			};
			return {
				name: self.derive([named], ([{ rows }]) => rows[0]?.name ?? ""),
				shapes: list.value,
				more: (ctx: Context) => list.more(ctx),
				page: async ({ after }, ctx) => {
					const found = await store.shapes.of.page(
						{ canvas: thing },
						PAGE,
						ctx,
						after === undefined ? {} : { after },
					);
					return { rows: found.items, ...(found.next === undefined ? {} : { next: found.next }) };
				},
				motion: board.motion,
				// A viewer shows where it looks, never a shape it could not commit.
				point: granted.has("add") ? point : (pointer, ctx) => point({ ...pointer, draft: null }, ctx),
				leave: async (ctx: Ctx<P3Principal>) => {
					await board.send({ kind: "leave", who: caller }, ctx);
					return null;
				},
				add: ({ shapes }, ctx) => store.add({ canvas: thing, shapes, author: caller }, ctx),
				remove: ({ id }, ctx) =>
					store.remove({ canvas: thing, id, ...(granted.has("removeAny") ? {} : { author: caller }) }, ctx),
				clear: (ctx) => store.clear({ canvas: thing }, ctx),
			};
		},
		// A new board starts empty: nothing to create. Its shapes go with it, and it is marked gone.
		delete: async (thing, ctx) => {
			await (await ctx.get(CanvasStore, {})).drop({ canvas: thing }, ctx);
		},
	});
});

/** How the others see the caller move: a person with their name in the things store, live; an agent; the Pi. */
function moverOf(caller: Caller, things: Reference<typeof ThingsStore>, self: Self<P3Principal>): Watchable<Mover> {
	if (caller.kind !== "person") return constant(caller);
	const found = self.liveQuery(things.persons.one, { person: caller.person }, { first: 1 });
	return self.derive([found], ([{ rows }]) => ({ ...caller, name: rows[0]?.name ?? "" }));
}
