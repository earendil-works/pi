// The canvas plugin on a session's worker: the harness part of `canvas.board`, the agent's tools for the boards it
// holds. `canvas_list` (the boards: id, name, whether the agent may draw there) and `canvas_read({ canvas })` (a
// board's shapes as JSON) always; `canvas_draw({ canvas, shapes })` when the agent may draw on at least one board,
// refused with an error naming the board on the others. The tools take a board's id from `canvas_list`, so their
// descriptions stay fixed whatever boards the agent holds. Drawing goes through the agent's held reference, so a Draw
// withheld meanwhile refuses it; reading pages through a reference of its own, held for the call only.

import { arr, type Context, type Ctx, defineFacet, obj, type P3Principal, str } from "@earendil-works/p3/v1";
import { defineTool } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, Canvas, CanvasKind, Shape } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, canvasPart);
});

/** A board the agent holds. */
type Board = HeldThing<typeof Canvas>;

/** The canvas's harness part. */
const canvasPart = thingHarnessPart(CanvasKind, (boards, session) => {
	const tools = [listTool(boards), readTool(boards, session)];
	const draws = boards.some(({ ref }) => ref.granted.has("add"));
	return { extension: { tools: draws ? [...tools, drawTool(boards)] : tools } };
});

/** The tool `canvas_list`: the boards, with whether the agent may draw on each. */
function listTool(boards: readonly Board[]) {
	return defineTool({
		name: "canvas_list",
		description:
			"Lists the session's shared canvases as JSON: each one's `id` (what the other canvas tools take), its `name` " +
			"and whether you may `draw` on it.",
		parameters: obj({}),
		execute: async () => {
			const listed = boards.map(({ thing, ref }) => ({
				id: thing,
				name: ref.name.value,
				draw: ref.granted.has("add"),
			}));
			return { output: [{ type: "text", text: JSON.stringify(listed) }] };
		},
	});
}

/** What the tools say about the board's coordinates. */
const UNITS = `The board is ${BOARD_WIDTH} units wide and ${BOARD_HEIGHT} high; x grows to the right, y down.`;

/** The tool `canvas_read`: every shape of a board, oldest first, as JSON. */
function readTool(boards: readonly Board[], session: HarnessSession) {
	return defineTool({
		name: "canvas_read",
		description:
			"The shapes on one of the session's shared canvases (`canvas`: its id from `canvas_list`), oldest first, as " +
			`JSON (each with its id and who drew it). ${UNITS}`,
		parameters: obj({ canvas: str() }),
		replay: "safe",
		execute: async ({ canvas: id }, _api, context) => {
			const board = boardOf(boards, id);
			// A reference of the call's own: paging the agent's held one would keep every page loaded on the worker.
			const shapes = await session.call(async (ctx) => {
				const canvas = await own(board, ctx);
				while (canvas.shapes.value.moreAfter) await canvas.more(ctx);
				return canvas.shapes.value.rows;
			}, context);
			return { output: [{ type: "text", text: JSON.stringify(shapes) }] };
		},
	});
}

/** The tool `canvas_draw`: adds shapes to a board the agent may draw on, in order. */
function drawTool(boards: readonly Board[]) {
	return defineTool({
		name: "canvas_draw",
		description:
			"Draws shapes on one of the session's shared canvases (`canvas`: its id from `canvas_list`, one you may draw " +
			"on), which everyone in the session sees at once: lines (`points` is [x0, y0, x1, y1, ...]), rectangles and " +
			`text, each with a colour \`#rrggbb\`. ${UNITS}`,
		parameters: obj({ canvas: str(), shapes: arr(Shape, { min: 1, max: 100 }) }),
		execute: async ({ canvas: id, shapes }, _api, context: Context) => {
			const board = boardOf(boards, id);
			// The held reference's `add` is there while Draw is granted: withheld since, it is gone.
			const add = board.ref.add;
			if (add === undefined) throw new Error(`canvas: you may not draw on ${described(board)}`);
			const ids = await add({ shapes }, context);
			return { output: [{ type: "text", text: `drew ${ids.length} shape(s): ${ids.join(", ")}` }] };
		},
	});
}

/** The board `id`; an id that is none of them is the model's mistake, answered as its error result. */
function boardOf(boards: readonly Board[], id: string): Board {
	const found = boards.find(({ thing }) => thing === id);
	if (found === undefined)
		throw new Error(`canvas: the session has no canvas ${JSON.stringify(id)} (see canvas_list)`);
	return found;
}

/** A board as an error names it: its name and id. */
function described({ thing, ref }: Board): string {
	return `the canvas "${ref.name.value}" (${thing})`;
}

/** A reference to `board` of the call's own, as the session's worker, where the agent holds it. */
function own(board: Board, ctx: Ctx<P3Principal>) {
	return ctx.get(Canvas, { workspace: board.workspace, thing: board.thing });
}
