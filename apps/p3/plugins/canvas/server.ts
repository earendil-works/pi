// The canvas plugin on the server: its kind (`serveThing`: content, which any writer of a session or its agent makes
// there; its shapes dropped with it), the store of the canvases' shapes (`store.ts`), each canvas's motion in a
// session (`BoardMotion`: pointers and drafts as events) and `Canvas`, admitted by the thing's admission: a viewer
// sees the shapes and the pointers, a drawer (writes, and `draw` applies to them) also changes the shapes. A canvas
// is a thing: its shapes are keyed by the thing's id, its name is the thing's.

import {
	type Context,
	type Ctx,
	defineFacet,
	event,
	local,
	Me,
	method,
	type P3Principal,
	str,
} from "@earendil-works/p3/v1";
import { SessionsStore, serveThing } from "@earendil-works/p3/v1/server";
import { Canvas, CanvasKind, Motion, type Pointer } from "./contract.ts";
import { CanvasStore, serveStore } from "./store.ts";

/** How many shapes a page of a canvas's list holds. */
const PAGE = 500;

/** The name of a canvas nobody named. */
const CANVAS = "Canvas";

/**
 * One canvas's motion in one session: what everyone there does on it (`motion`, events), and `send`, which every
 * holder's `Canvas` calls with its caller's motion. Per session, not per canvas: a canvas used in two sessions shows
 * each session's people only to that session's.
 */
const BoardMotion = local("canvas.motion", {
	version: 1,
	params: { session: str(), thing: str() },
	members: { motion: event(Motion), send: method(Motion) },
});

export default defineFacet((host) => {
	serveStore(host);

	host.serve(BoardMotion, (_params, self) => {
		const motion = self.events<Motion>();
		return {
			motion,
			send: async (value) => {
				motion.emit(value);
				return null;
			},
		};
	});

	serveThing(host, CanvasKind, {
		title: CANVAS,
		creation: "content",
		// A new canvas starts empty: nothing to set up. Its shapes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(CanvasStore, {})).clear({ canvas: thing }, ctx);
		},
		object: {
			contract: Canvas,
			factory: ({ session, thing }, { access, options }, self) => {
				const store = self.get(CanvasStore, {});
				const board = self.get(BoardMotion, { session, thing });
				const named = self.liveQuery(self.get(SessionsStore, {}).things.one, { id: thing }, { first: 1 });
				const list = self.list("shapes", [[store.shapes.of, { canvas: thing }]], { first: PAGE });
				const point = async (pointer: Pointer, ctx: Ctx<P3Principal>) => {
					const { who, name } = await caller(ctx);
					await board.send({ kind: "point", who, name, ...pointer }, ctx);
					return null;
				};
				const viewer = {
					name: self.derive([named], ([{ rows }]) => rows[0]?.name || CANVAS),
					shapes: list.value,
					more: (ctx: Context) => list.more(ctx),
					leave: async (ctx: Ctx<P3Principal>) => {
						await board.send({ kind: "leave", who: (await caller(ctx)).who }, ctx);
						return null;
					},
					motion: board.motion,
				};
				if (access !== "write" || !options.draw) {
					// A viewer shows where it looks, never a shape it could not commit.
					return {
						variant: "viewer",
						members: { ...viewer, point: (pointer, ctx) => point({ ...pointer, draft: null }, ctx) },
					};
				}
				return {
					variant: "drawer",
					members: {
						...viewer,
						point,
						add: async ({ shapes }, ctx) =>
							store.add({ canvas: thing, shapes, author: (await caller(ctx)).who }, ctx),
						remove: ({ id }, ctx) => store.remove({ canvas: thing, id }, ctx),
						clear: (ctx) => store.clear({ canvas: thing }, ctx),
					},
				};
			},
		},
	});
});

/**
 * Who the caller of a method is, as the people plugin answers them (asked as the caller): their author key
 * (`person:<id>`, the owner's too; `agent` for the session's agent) and their name now.
 */
async function caller(ctx: Ctx<P3Principal>): Promise<{ readonly who: string; readonly name: string }> {
	const me = (await ctx.get(Me, {})).me.value;
	switch (me.kind) {
		case "person":
			return { who: `person:${me.id}`, name: me.name };
		case "agent":
			return { who: "agent", name: "Agent" };
	}
}
