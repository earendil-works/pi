// The canvas kind (`canvas.board`): shared drawing boards. Anyone, people and agents, may make one; it may be linked in
// any number of workspaces, its shapes, keyed by the thing's id, the same in each. Looking (the shapes, everyone's
// pointers, one's own pointer shown) is for everyone let in. Draw adds shapes, removes one's own and gives the flag
// Export; Moderate, for people, clears the board and gives the flag Remove anyone's. Committed shapes are rows on the
// server; pointers and the shapes people are drawing travel as events, lossy and never stored. A new link starts with
// Draw for everyone there and the agents; a Read share's guests look.

import { arr, bool, lit, method, nul, num, obj, opt, type Static, str, union } from "@earendil-works/p3/v1";
import { Caller } from "../things/contract.ts";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** The board's width in its own units: every client draws in these, whatever its screen. */
export const BOARD_WIDTH = 1200;

/** The board's height in its own units. */
export const BOARD_HEIGHT = 900;

/** The most points one stroke holds: a longer one is cut into several as it is drawn. */
export const MAX_POINTS = 2000;

/** A coordinate on the board (a little outside it allowed: a stroke may leave the edge). */
const Coordinate = num({ min: -BOARD_WIDTH, max: 2 * BOARD_WIDTH });

/** A colour: `#rrggbb`. */
export const Color = str({ pattern: "^#[0-9a-fA-F]{6}$" });

/**
 * A shape on the board, tagged by `kind`:
 * - `line`: a stroke or polyline through `points` (`[x0, y0, x1, y1, …]`, 2 to `MAX_POINTS` points), `width` units
 *   wide;
 * - `rect`: a rectangle at `x`, `y` (its top left), `w` by `h`, outlined or `fill`ed;
 * - `text`: `text` with its baseline's start at `x`, `y`, `size` units high.
 */
export const Shape = union([
	obj({
		kind: lit("line"),
		color: Color,
		width: num({ min: 1, max: 64 }),
		points: arr(Coordinate, { min: 4, max: 2 * MAX_POINTS }),
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

/** The most shapes a board holds: an add past it is refused, so a board's view loads it whole (20 pages). */
export const MAX_SHAPES = 10_000;

/** A committed shape: its id, who drew it, as their admission said, and the shape. */
export const PlacedShape = obj({ id: str(), author: Caller, shape: Shape });

/** A committed shape (see `PlacedShape`). */
export type PlacedShape = Static<typeof PlacedShape>;

/** A board's shapes loaded so far, oldest first, and whether more follow. */
export const ShapesPage = obj({ rows: arr(PlacedShape), moreAfter: bool() });

/** Where a caller's pointer is on the board, and the shape they are drawing there (`null`: none). */
export const Pointer = obj({ x: Coordinate, y: Coordinate, draft: union([Shape, nul()]) });

/** Where a caller's pointer is (see `Pointer`). */
export type Pointer = Static<typeof Pointer>;

/**
 * Who moves on the board, as the others see them: a person with their name now (empty while the things store has
 * none), a session's agent, or the Pi itself. The view names the agent and the Pi.
 */
export const Mover = union([
	obj({ kind: lit("person"), person: str(), name: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who moves on the board (see `Mover`). */
export type Mover = Static<typeof Mover>;

/**
 * What one caller does on the board, as everyone holding it sees it: a pointer that moved (with the shape drawn so
 * far), or one that left.
 */
export const Motion = union([
	obj({ kind: lit("point"), who: Mover, x: num(), y: num(), draft: union([Shape, nul()]) }),
	obj({ kind: lit("leave"), who: Caller }),
]);

/** What one caller does on the board (see `Motion`). */
export type Motion = Static<typeof Motion>;

/** What Draw gives as members: what a drawer of a board calls. */
export const CANVAS_DRAWS = ["add", "remove"] as const;

/**
 * A board (`canvas.board`): its name (its thing's, "" while it has none), its shapes loaded so far, oldest first, with
 * `more` for the next page, a page read now, and everyone's motion where it is held as events; `point` and `leave`
 * show the caller's own pointer to the others there. All of these are for everyone let in. Draw gives `add`, `remove`
 * (one's own shapes) and the flag `export` (exporting the board as an image, the page's); Moderate, for people, gives
 * `clear` and the flag `removeAny` (anyone's shapes). A new link starts with Draw for everyone there and the agents;
 * a Read share's guests look, their pointer shown without a draft.
 */
export const CanvasKind = defineThing("canvas.board", {
	version: 3,
	makers: "anyone",
	state: { name: str(), shapes: ShapesPage },
	methods: {
		/** Loads the next page of shapes into `shapes`. */
		more: method(),
		/**
		 * A page of the shapes read now, oldest first, from the start or `after` (a page's `next`), not followed: what an
		 * agent's tool reads without growing the caller's loaded pages.
		 */
		page: method(obj({ after: opt(str()) }), obj({ rows: arr(PlacedShape), next: opt(str()) })),
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
		// Members no tick gives (`name`, `shapes`, `more`, `page`, `point`, `leave`, `motion`) are there for everyone let
		// in: looking, one's pointer shown.
		draw: { label: messages.message("tickDraw"), gives: [...CANVAS_DRAWS, "export"] },
		moderate: { label: messages.message("tickModerate"), for: "people", gives: ["clear", "removeAny"] },
		// Flag ticks (decision 97): rights that are no member, given by the ticks above or on their own.
		export: { label: messages.message("tickExport") },
		removeAny: { label: messages.message("tickRemoveAny"), for: "people" },
	},
	defaultGrants: { everyone: ["draw"], agents: ["draw"], guests: [] },
});

/** One board held in a workspace: `CanvasKind`'s contract. */
export const Canvas = CanvasKind.contract;

/** Whether `a` and `b` are the same caller, by their fields (a mover counts as the caller it is). */
export function sameCaller(a: Caller | Mover, b: Caller | Mover): boolean {
	switch (a.kind) {
		case "person":
			return b.kind === "person" && b.person === a.person;
		case "agent":
			return b.kind === "agent" && b.session === a.session;
		case "server":
			return b.kind === "server";
	}
}
