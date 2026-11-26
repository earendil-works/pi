// The canvas plugin's contract: shared drawing boards as a kind of thing (`canvas.board`, made by anyone, people and
// agents, linked in any number of workspaces), their shapes, and one canvas held in a workspace by a person or an
// agent (`Canvas`, `CanvasKind`'s contract). Who may do what is the things plugin's: the ticks Draw (add shapes,
// remove one's own) and Moderate (people only: clear the board, remove anyone's shapes). Committed shapes are rows on
// the server; cursors and the shapes people are drawing travel as events, lossy and never stored.

import { arr, bool, lit, method, nul, num, obj, type Static, str, union } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** The board's width in its own units: every client draws in these, whatever its screen. */
export const BOARD_WIDTH = 1200;

/** The board's height in its own units. */
export const BOARD_HEIGHT = 900;

/** A coordinate on the board (a little outside it allowed: a stroke may leave the edge). */
const Coordinate = num({ min: -BOARD_WIDTH, max: 2 * BOARD_WIDTH });

/** A colour: `#rrggbb`. */
export const Color = str({ pattern: "^#[0-9a-fA-F]{6}$" });

/**
 * A shape on the board, tagged by `kind`:
 * - `line`: a stroke or polyline through `points` (`[x0, y0, x1, y1, …]`, 2 to 2,000 points), `width` units wide;
 * - `rect`: a rectangle at `x`, `y` (its top left), `w` by `h`, outlined or `fill`ed;
 * - `text`: `text` with its baseline's start at `x`, `y`, `size` units high.
 */
export const Shape = union([
	obj({
		kind: lit("line"),
		color: Color,
		width: num({ min: 1, max: 64 }),
		points: arr(Coordinate, { min: 4, max: 4000 }),
	}),
	obj({
		kind: lit("rect"),
		color: Color,
		x: Coordinate,
		y: Coordinate,
		w: num({ min: 0, max: 2 * BOARD_WIDTH }),
		h: num({ min: 0, max: 2 * BOARD_WIDTH }),
		fill: bool(),
	}),
	obj({
		kind: lit("text"),
		color: Color,
		x: Coordinate,
		y: Coordinate,
		text: str({ min: 1, max: 500 }),
		size: num({ min: 8, max: 200 }),
	}),
]);

/** A shape on the board (see `Shape`). */
export type Shape = Static<typeof Shape>;

/** A committed shape: its id, who drew it (`person:<id>`, `agent:<session>`) and the shape. */
export const PlacedShape = obj({ id: str(), author: str(), shape: Shape });

/** A committed shape (see `PlacedShape`). */
export type PlacedShape = Static<typeof PlacedShape>;

/** Where a caller's pointer is on the board, and the shape they are drawing there (`null`: none). */
export const Pointer = obj({ x: Coordinate, y: Coordinate, draft: union([Shape, nul()]) });

/** Where a caller's pointer is (see `Pointer`). */
export type Pointer = Static<typeof Pointer>;

/**
 * What one caller does on the board, as everyone holding it sees it: a pointer that moved (with the shape drawn so
 * far), or one that left. `who` is the caller's author key, `name` how the people plugin names them now.
 */
export const Motion = union([
	obj({ kind: lit("point"), who: str(), name: str(), x: num(), y: num(), draft: union([Shape, nul()]) }),
	obj({ kind: lit("leave"), who: str() }),
]);

/** What one caller does on the board (see `Motion`). */
export type Motion = Static<typeof Motion>;

/**
 * A board (`canvas.board`): its name (its thing's; "Canvas" while it has none), its shapes loaded so far, oldest
 * first, with `more` for the next page, and everyone's motion where it is held as events; `point` and `leave` show
 * the caller's own pointer to the others there. Draw gives `add`, `remove` (one's own shapes) and the flag `export`
 * (exporting the board as an image, the page's); Moderate, for people, gives `clear` and the flag `removeAny`
 * (anyone's shapes). A new link starts with Draw for everyone and the agents.
 */
export const CanvasKind = defineThing("canvas.board", {
	version: 1,
	makers: "anyone",
	state: { name: str(), shapes: obj({ rows: arr(PlacedShape), moreAfter: bool() }) },
	methods: {
		more: method(),
		/** Shows the caller's pointer at `x`, `y` to everyone on the board (a viewer's draft is dropped). */
		point: method(Pointer),
		/** Takes the caller's pointer off the board. */
		leave: method(),
		/** Adds shapes, drawn now by the caller, in order; answers their ids. */
		add: method(obj({ shapes: arr(Shape, { min: 1, max: 100 }) }), arr(str())),
		/** Removes a shape: the caller's own, anyone's with `removeAny`. */
		remove: method(obj({ id: str() })),
		/** Removes every shape of the board. */
		clear: method(),
	},
	events: { motion: Motion },
	ticks: {
		draw: { label: messages.message("tickDraw"), gives: ["add", "remove", "export"] },
		moderate: { label: messages.message("tickModerate"), for: "people", gives: ["clear", "removeAny"] },
		// Flag ticks (decision 97): rights that are no member, given by the ticks above or on their own.
		export: { label: messages.message("tickExport") },
		removeAny: { label: messages.message("tickRemoveAny"), for: "people" },
	},
	defaultGrants: { everyone: ["draw"], agents: ["draw"] },
});

/** One board held in a workspace: `CanvasKind`'s contract. */
export const Canvas = CanvasKind.contract;

/** What a drawer of a board is granted (Draw). */
export const CANVAS_DRAWS = ["add", "remove"] as const;
