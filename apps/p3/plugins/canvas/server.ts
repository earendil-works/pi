// The canvas plugin on the server: its kind of thing (`ThingKinds`; a board stands for no record, so only the owner
// and apps add one), the store of the boards' shapes (`store.ts`), each board's motion (`BoardMotion`: pointers and
// drafts as events, shared by everyone on the board) and `Canvas`, admitted by `admitThing`: a viewer sees the shapes
// and the pointers, a drawer (writes, and `draw` applies to them) also changes the shapes.

import {
	admitThing,
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
import { ThingKinds } from "@earendil-works/p3/v1/server";
import { Canvas, CanvasKind, Motion, type Pointer } from "./contract.ts";
import { CanvasStore, serveStore } from "./store.ts";

/** How many shapes a page of a board's list holds. */
const PAGE = 500;

/**
 * One board's motion, once per board: what everyone on it does (`motion`, events), and `send`, which every holder's
 * `Canvas` calls with its caller's motion, so each holder sees every other's.
 */
const BoardMotion = local("canvas.motion", {
	version: 1,
	params: { session: str(), thing: str() },
	members: { motion: event(Motion), send: method(Motion) },
});

export default defineFacet((host, self) => {
	serveStore(host);
	self.contribute(ThingKinds, { kind: CanvasKind, title: "Canvas" });

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

	host.serve(
		Canvas,
		({ session, thing }, _principal, { access, options }, self) => {
			const store = self.get(CanvasStore, {});
			const board = self.get(BoardMotion, { session, thing });
			const list = self.list("shapes", [[store.shapes.of, { session, thing }]], { first: PAGE });
			const point = async (pointer: Pointer, ctx: Ctx<P3Principal>) => {
				const { who, name } = await caller(ctx);
				await board.send({ kind: "point", who, name, ...pointer }, ctx);
				return null;
			};
			const viewer = {
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
						store.add({ session, thing, shapes, author: (await caller(ctx)).who }, ctx),
					remove: ({ id }, ctx) => store.remove({ session, thing, id }, ctx),
					clear: (ctx) => store.clear({ session, thing }, ctx),
				},
			};
		},
		{ admit: admitThing(CanvasKind) },
	);
});

/**
 * Who the caller of a method is, as the people plugin answers them (asked as the caller): their author key (`owner`,
 * `person:<id>`, `agent` for the session's agent) and their name now.
 */
async function caller(ctx: Ctx<P3Principal>): Promise<{ readonly who: string; readonly name: string }> {
	const me = (await ctx.get(Me, {})).me.value;
	switch (me.kind) {
		case "owner":
			return { who: "owner", name: "Owner" };
		case "person":
			return { who: `person:${me.id}`, name: me.name };
		case "agent":
			return { who: "agent", name: "Agent" };
	}
}
