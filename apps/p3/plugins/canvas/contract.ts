// The canvas plugin's contract: a shared drawing board as a kind of thing (`canvas.board`; the thing is the board, it
// stands for no record), its shapes, and one board in a session as its members and its agent see it (`Canvas`).
// Committed shapes are rows on the server; cursors and the shapes people are drawing travel as events, lossy and
// never stored, so everyone sees everyone draw as it happens.

import {
	arr,
	bool,
	defineThingKind,
	lit,
	method,
	nul,
	num,
	obj,
	remote,
	Server,
	type Static,
	str,
	thingAdmission,
	union,
} from "@earendil-works/p3/v1";

/** A board in a session; `draw: false` leaves whoever it applies to (a member, the agent) looking only. */
export const CanvasKind = defineThingKind("canvas.board", {
	version: 1,
	options: obj({ draw: bool() }),
	initial: { draw: true },
});

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

/**
 * A committed shape: its id, who drew it (`owner`, `person:<id>`, `agent`: the session's agent) and the shape.
 */
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
 * The viewer's members: the board's shapes loaded so far, oldest first, and `more` for the next page; everyone's
 * motion as events; `point` and `leave`, which show the caller's own pointer to the others.
 */
const viewer = {
	state: { shapes: obj({ rows: arr(PlacedShape), moreAfter: bool() }) },
	methods: {
		more: method(),
		/** Shows the caller's pointer at `x`, `y` to everyone on the board (a viewer's draft is dropped). */
		point: method(Pointer),
		/** Takes the caller's pointer off the board. */
		leave: method(),
	},
	events: { motion: Motion },
};

/**
 * One board of a session (`thing`, a thing of `CanvasKind`), for its members and its agent: a viewer sees the shapes
 * and everyone's pointers; a drawer (who writes in the session and whose options say `draw`) also adds and removes
 * shapes and clears the board.
 */
export const Canvas = remote("canvas.board", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(CanvasKind),
	variants: {
		viewer,
		drawer: {
			state: viewer.state,
			methods: {
				...viewer.methods,
				/** Adds shapes, drawn now by the caller, in order; answers their ids. */
				add: method(obj({ shapes: arr(Shape, { min: 1, max: 100 }) }), arr(str())),
				remove: method(obj({ id: str() })),
				/** Removes every shape of the board. */
				clear: method(),
			},
			events: viewer.events,
		},
	},
});
