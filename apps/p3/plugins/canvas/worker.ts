// The canvas plugin on a session's worker: the harness part of `canvas.board`, the agent's tools for the boards it
// holds. `canvas_list` (the boards: id, name, whether the agent may draw there) and `canvas_read({ canvas, after? })`
// (a page of a board's shapes as JSON) always; `canvas_draw({ canvas, shapes })` when the agent may draw on at least
// one board, refused naming the board on the others. The tools take a board's id from `canvas_list`, so their
// descriptions stay fixed whatever boards the agent holds. Every call goes through the agent's held reference
// (decision 120): a Draw withheld meanwhile refuses the draw, and a read is a page read now (`page`), so nothing stays
// loaded after it. Reads and draws answer JSON.

import { arr, type Context, defineFacet, forbidden, invalid, obj, opt, str } from "@earendil-works/p3/v1";
import { defineTool } from "@earendil-works/p3/v1/worker";
import {
	type HarnessExtension,
	type HeldThing,
	ThingHarnessParts,
	thingHarnessPart,
} from "../things/contract.worker.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type Canvas, CanvasKind, Shape } from "./kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(CanvasKind, (boards) => ({ extension: canvasExtension(boards) })),
	);
});

/** A board the agent holds. */
type Board = HeldThing<typeof Canvas>;

/** The agent's canvas tools: list and read, and draw while one board gives Draw. */
function canvasExtension(boards: readonly Board[]): HarnessExtension {
	const tools = [listTool(boards), readTool(boards)];
	// Installed under the kind's name by the harness.
	return { tools: boards.some(({ ref }) => ref.add !== undefined) ? [...tools, drawTool(boards)] : tools };
}

/** The tool `canvas_list`: the boards, with whether the agent may draw on each. */
function listTool(boards: readonly Board[]) {
	return defineTool({
		name: "canvas_list",
		description:
			"Lists the session's shared canvases as JSON: each one's `id` (what the other canvas tools take), its `name` " +
			"(empty when it has none) and whether you may `draw` on it.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const listed = boards.map(({ thing, ref }) => ({
				id: thing,
				name: ref.name.value,
				draw: ref.add !== undefined,
			}));
			return { output: [{ type: "text", text: JSON.stringify(listed) }] };
		},
	});
}

/** What the tools say about the board's coordinates. */
const UNITS = `The board is ${BOARD_WIDTH} units wide and ${BOARD_HEIGHT} high; x grows to the right, y down.`;

/** The tool `canvas_read`: a page of a board's shapes, oldest first, as JSON. */
function readTool(boards: readonly Board[]) {
	return defineTool({
		name: "canvas_read",
		description:
			"A page of the shapes on one of the session's shared canvases (`canvas`: its id from `canvas_list`), oldest " +
			"first. Answers JSON: `rows` (each shape's `id`, `author`: who drew it, and `shape`) and, when there are more, " +
			`\`next\`: pass it as \`after\` for the next page. ${UNITS}`,
		parameters: obj({ canvas: str(), after: opt(str()) }),
		replay: "safe",
		execute: async ({ canvas: id, after }, _api, context) => {
			// A page read now through the held reference: nothing is kept loaded after the call (Astra, round 1).
			const page = await boardOf(boards, id).ref.page({ ...(after === undefined ? {} : { after }) }, context);
			return { output: [{ type: "text", text: JSON.stringify(page) }] };
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
			if (add === undefined) throw forbidden(`canvas: you may not draw on ${described(board)}`);
			const ids = await add({ shapes }, context);
			return { output: [{ type: "text", text: JSON.stringify({ ids }) }] };
		},
	});
}

/** The board `id`; an id that is none of them is the model's mistake, answered as its error result. */
function boardOf(boards: readonly Board[], id: string): Board {
	const found = boards.find(({ thing }) => thing === id);
	if (found === undefined)
		throw invalid("args", `canvas: the session has no canvas ${JSON.stringify(id)} (see canvas_list)`);
	return found;
}

/** A board as an error names it: its name and id. */
function described({ thing, ref }: Board): string {
	return `the canvas "${ref.name.value}" (${thing})`;
}
