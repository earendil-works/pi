// The canvas plugin on a session's worker: what a `canvas.board` thing gives the agent. `canvas_read` (the board's
// shapes as JSON) always, `canvas_draw` (adds shapes) only when the agent's options say `draw`. Both reach the board's
// `Canvas` on the server through the agent's `call`, as the session's worker, so the server admits the agent with
// its own options there too.

import { arr, type Ctx, defineFacet, obj, type P3Principal } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	defineExtension,
	defineTool,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { BOARD_HEIGHT, BOARD_WIDTH, Canvas, CanvasKind, Shape } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		thingExtension(CanvasKind, (thing, agent) => ({
			extension: defineExtension({
				name: "canvas",
				tools: thing.options.draw ? [readTool(thing, agent), drawTool(thing, agent)] : [readTool(thing, agent)],
			}),
		})),
	);
});

/** What the tools say about the board's coordinates. */
const UNITS = `The board is ${BOARD_WIDTH} units wide and ${BOARD_HEIGHT} high; x grows to the right, y down.`;

/** The tool `canvas_read`: every shape of the board, oldest first, as JSON. */
function readTool(thing: AgentThing<{ draw: boolean }>, agent: Agent) {
	return defineTool({
		name: "canvas_read",
		description: `The shapes on the session's shared canvas, oldest first, as JSON (each with its id and who drew it). ${UNITS}`,
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, _api, context) => {
			const shapes = await agent.call(async (ctx) => {
				const canvas = await board(thing, agent, ctx);
				// Every page: the agent reads the whole board.
				while (canvas.shapes.value.moreAfter) await canvas.more(ctx);
				return canvas.shapes.value.rows;
			}, context);
			return { output: [{ type: "text", text: JSON.stringify(shapes) }] };
		},
	});
}

/** The tool `canvas_draw`: adds shapes to the board, in order. */
function drawTool(thing: AgentThing<{ draw: boolean }>, agent: Agent) {
	return defineTool({
		name: "canvas_draw",
		description:
			"Draws shapes on the session's shared canvas, which everyone in the session sees at once: lines (`points` is " +
			"[x0, y0, x1, y1, ...]), rectangles and text, each with a colour `#rrggbb`. " +
			UNITS,
		parameters: obj({ shapes: arr(Shape, { min: 1, max: 100 }) }),
		execute: async ({ shapes }, _api, context) => {
			const ids = await agent.call(async (ctx) => {
				const canvas = await board(thing, agent, ctx);
				// The server admits the agent with its own options: a `draw` taken back meanwhile leaves it a viewer.
				if (canvas.variant !== "drawer") throw new Error("canvas: the agent may not draw on this board now");
				return canvas.add({ shapes }, ctx);
			}, context);
			return { output: [{ type: "text", text: `drew ${ids.length} shape(s): ${ids.join(", ")}` }] };
		},
	});
}

/** The board of `thing` as the session's worker gets it. */
function board(thing: AgentThing<{ draw: boolean }>, agent: Agent, ctx: Ctx<P3Principal>) {
	return ctx.get(Canvas, { session: agent.session, thing: thing.thing });
}
