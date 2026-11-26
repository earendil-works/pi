// The canvas plugin on the server: its kind (`serveThing`: the things plugin admits every caller and registers the
// kind; the shapes go with the thing), the store of the canvases' shapes (`store.ts`), each canvas's motion where it
// is held (`BoardMotion`: pointers and drafts as events), and the board's members for one caller: a viewer sees the
// shapes and the pointers; Draw adds shapes and removes one's own; Moderate clears and removes anyone's.

import {
	type Context,
	type Ctx,
	constant,
	defineFacet,
	event,
	local,
	method,
	type P3Principal,
	type Reference,
	type Self,
	str,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import type { Caller } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { CanvasKind, Motion, type Pointer } from "./contract.ts";
import { CanvasStore, serveStore } from "./store.ts";

/** How many shapes a page of a canvas's list holds. */
const PAGE = 500;

/** The name of a canvas nobody named. */
const CANVAS = "Canvas";

/**
 * One canvas's motion in one workspace: what everyone holding it there does on it (`motion`, events), and `send`,
 * which each holder's object calls with its caller's motion. Per workspace: a canvas linked in two shows each
 * workspace's people only to that workspace's.
 */
const BoardMotion = local("canvas.motion", {
	version: 1,
	params: { workspace: str(), thing: str() },
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
		// A new canvas starts empty: nothing to set up. Its shapes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(CanvasStore, {})).clear({ canvas: thing }, ctx);
		},
		implement: ({ workspace, thing }, { caller, granted }, self) => {
			const store = self.get(CanvasStore, {});
			const things = self.get(ThingsStore, {});
			const board = self.get(BoardMotion, { workspace, thing });
			const named = self.liveQuery(things.things.one, { thing }, { first: 1 });
			const list = self.list("shapes", [[store.shapes.of, { canvas: thing }]], { first: PAGE });
			const who = authorOf(caller);
			const name = nameOf(caller, things, self);
			const point = async (pointer: Pointer, ctx: Ctx<P3Principal>) => {
				await board.send({ kind: "point", who, name: name.value, ...pointer }, ctx);
				return null;
			};
			return {
				name: self.derive([named], ([{ rows }]) => rows[0]?.name || CANVAS),
				shapes: list.value,
				more: (ctx: Context) => list.more(ctx),
				leave: async (ctx: Ctx<P3Principal>) => {
					await board.send({ kind: "leave", who }, ctx);
					return null;
				},
				motion: board.motion,
				// A viewer shows where it looks, never a shape it could not commit.
				point: granted.has("add") ? point : (pointer, ctx) => point({ ...pointer, draft: null }, ctx),
				add: ({ shapes }, ctx) => store.add({ canvas: thing, shapes, author: who }, ctx),
				remove: ({ id }, ctx) =>
					store.remove({ canvas: thing, id, ...(granted.has("removeAny") ? {} : { author: who }) }, ctx),
				clear: (ctx) => store.clear({ canvas: thing }, ctx),
			};
		},
	});
});

/** Who drew a shape, as the shapes store it: `person:<id>`, `agent:<session>`, `server`. */
function authorOf(caller: Caller): string {
	switch (caller.kind) {
		case "person":
			return `person:${caller.person}`;
		case "agent":
			return `agent:${caller.session}`;
		case "server":
			return "server";
	}
}

/** How the others see the caller named: a person by their name in the things store, live; an agent as "Agent". */
function nameOf(caller: Caller, things: Reference<typeof ThingsStore>, self: Self<P3Principal>): Watchable<string> {
	if (caller.kind !== "person") return constant(caller.kind === "agent" ? "Agent" : "Pi");
	const found = self.liveQuery(things.persons.one, { person: caller.person }, { first: 1 });
	return self.derive([found], ([{ rows }]) => rows[0]?.name ?? "");
}
