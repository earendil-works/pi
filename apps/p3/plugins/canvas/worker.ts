// The canvas plugin on a session's worker: what the session's `canvas.board` things give the agent. Out of scope until
// slice 5 (ERNDL-704, sessions as session workspaces): the harness still hands it the session's things of the old
// sessions layer (`LegacyCanvas`, the old kind's options `draw`), and the tools hold the board in the workspace named
// by the session's id, where the things plugin admits the agent by its own answer. `canvas_list` (the session's boards:
// id, name, whether the agent may draw there) and `canvas_read({ canvas })` (a board's shapes as JSON) always;
// `canvas_draw({ canvas, shapes })` when the agent may draw on at least one board, refused with an error naming the
// board on the others. The tools take a board's id from `canvas_list`, so their descriptions stay fixed whatever boards
// the session has. Both reach the board's `Canvas` on the server through the agent's `call`, as the session's worker,
// so the server admits the agent with its own options there too.

import { arr, bool, type Ctx, defineFacet, defineThing, obj, type P3Principal, str } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	defineExtension,
	defineTool,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { BOARD_HEIGHT, BOARD_WIDTH, Canvas, CanvasKind, Shape } from "./contract.ts";

/**
 * The board kind as the harness's old sessions layer knows it, until slice 5: its options say whether the agent draws.
 */
const LegacyCanvas = defineThing(CanvasKind.name, {
	version: 1,
	options: obj({ draw: bool() }),
	initial: { draw: true },
});

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		thingExtension(LegacyCanvas, (things, agent) => {
			const tools = [listTool(things), readTool(things, agent)];
			return {
				extension: defineExtension({
					name: "canvas",
					tools: things.some(({ options }) => options.draw) ? [...tools, drawTool(things, agent)] : tools,
				}),
			};
		}),
	);
});

/** A board of the session as the canvas tools get it. */
type Board = AgentThing<{ draw: boolean }>;

/** The tool `canvas_list`: the session's boards, with whether the agent may draw on each. */
function listTool(things: readonly Board[]) {
	return defineTool({
		name: "canvas_list",
		description:
			"Lists the session's shared canvases as JSON: each one's `id` (what the other canvas tools take), its `name` " +
			"and whether you may `draw` on it.",
		parameters: obj({}),
		execute: async () => {
			const boards = things.map(({ thing, name, options }) => ({ id: thing, name, draw: options.draw }));
			return { output: [{ type: "text", text: JSON.stringify(boards) }] };
		},
	});
}

/** What the tools say about the board's coordinates. */
const UNITS = `The board is ${BOARD_WIDTH} units wide and ${BOARD_HEIGHT} high; x grows to the right, y down.`;

/** The tool `canvas_read`: every shape of a board, oldest first, as JSON. */
function readTool(things: readonly Board[], agent: Agent) {
	return defineTool({
		name: "canvas_read",
		description:
			"The shapes on one of the session's shared canvases (`canvas`: its id from `canvas_list`), oldest first, as " +
			`JSON (each with its id and who drew it). ${UNITS}`,
		parameters: obj({ canvas: str() }),
		replay: "safe",
		execute: async ({ canvas: id }, _api, context) => {
			const thing = boardOf(things, id);
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

/** The tool `canvas_draw`: adds shapes to a board the agent may draw on, in order. */
function drawTool(things: readonly Board[], agent: Agent) {
	return defineTool({
		name: "canvas_draw",
		description:
			"Draws shapes on one of the session's shared canvases (`canvas`: its id from `canvas_list`, one you may draw " +
			"on), which everyone in the session sees at once: lines (`points` is [x0, y0, x1, y1, ...]), rectangles and " +
			`text, each with a colour \`#rrggbb\`. ${UNITS}`,
		parameters: obj({ canvas: str(), shapes: arr(Shape, { min: 1, max: 100 }) }),
		execute: async ({ canvas: id, shapes }, _api, context) => {
			const thing = boardOf(things, id);
			if (!thing.options.draw) throw new Error(`canvas: you may not draw on ${described(thing)}`);
			const ids = await agent.call(async (ctx) => {
				const canvas = await board(thing, agent, ctx);
				// The server admits the agent with its own options: a `draw` taken back meanwhile leaves it a viewer.
				if (canvas.add === undefined) throw new Error(`canvas: you may not draw on ${described(thing)} now`);
				return canvas.add({ shapes }, ctx);
			}, context);
			return { output: [{ type: "text", text: `drew ${ids.length} shape(s): ${ids.join(", ")}` }] };
		},
	});
}

/** The session's board `id`; an id that is none of them is the model's mistake, answered as its error result. */
function boardOf(things: readonly Board[], id: string): Board {
	const found = things.find(({ thing }) => thing === id);
	if (found === undefined)
		throw new Error(`canvas: the session has no canvas ${JSON.stringify(id)} (see canvas_list)`);
	return found;
}

/** A board as an error names it: its name and id. */
function described({ thing, name }: Board): string {
	return name === "" ? `the canvas ${thing}` : `the canvas "${name}" (${thing})`;
}

/** The board of `thing` as the session's worker gets it. */
function board(thing: Board, agent: Agent, ctx: Ctx<P3Principal>) {
	return ctx.get(Canvas, { workspace: agent.session, thing: thing.thing });
}
