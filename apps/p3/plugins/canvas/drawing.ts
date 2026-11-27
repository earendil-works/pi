// A drawer's drawing on the page (`useDrawing`): the pointer's way over the board as a draft (a stroke with the pen, a
// rectangle with the box, text placed with a tap), shown to the others as it grows, committed when the pointer goes
// up, and the shapes sent but not yet among the board's rows, shown meanwhile so a stroke never blinks out between up
// and commit. A viewer's pointer only travels.

import type { Context, Reference, With } from "@earendil-works/p3/v1";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
	BOARD_HEIGHT,
	BOARD_WIDTH,
	type CANVAS_DRAWS,
	type Canvas,
	MAX_POINTS,
	type PlacedShape,
	type Shape,
} from "./kind.ts";
import { useMotionSender } from "./motion-hooks.ts";

/** The drawer's members, as the view calls them. */
export type Drawer = With<Reference<typeof Canvas>, (typeof CANVAS_DRAWS)[number]>;

/** What a drawer draws with. */
export type Tool = "pen" | "rect" | "text";

/** What the drawing needs: the board, its drawer's members (none: a viewer), the shapes shown, what is picked. */
export type DrawingOf = {
	readonly live: Reference<typeof Canvas> | undefined;
	readonly drawer: Drawer | undefined;
	readonly shapes: readonly PlacedShape[];
	readonly tool: Tool;
	readonly color: string;
	/** The text the text tool places. */
	readonly text: string;
	/** Runs a change; its failure is the view's to show. */
	readonly run: (call: (context: Context) => Promise<unknown>) => void;
};

/** The drawing's handlers for the board's surface, its own draft and the shapes still on their way. */
export type Drawing = {
	readonly draft: Shape | null;
	readonly sending: readonly Shape[];
	readonly down: (event: PointerEvent<SVGSVGElement>) => void;
	readonly move: (event: PointerEvent<SVGSVGElement>) => void;
	readonly up: (event: PointerEvent<SVGSVGElement>) => void;
	readonly leave: (event: PointerEvent<SVGSVGElement>) => void;
};

/** How high text is placed, in board units. */
const TEXT_SIZE = 40;

/** A shape the drawer sent, with its id once the add answered. */
type Sending = { readonly shape: Shape; readonly id: string | undefined };

/** Draws on the board as `of` says: the pointer's handlers, and what to show of the drawer's own. */
export function useDrawing(of: DrawingOf): Drawing {
	const { drawer } = of;
	const [draft, setDraft] = useState<Shape | null>(null);
	const [sending, setSending] = useState<readonly Sending[]>([]);
	// A sent shape is shown until its row is (the answer, with the id, may come before the row).
	const shown = new Set(of.shapes.map((placed) => placed.id));
	const pending = sending.filter((sent) => sent.id === undefined || !shown.has(sent.id));
	useEffect(() => {
		if (pending.length < sending.length) setSending(pending);
	}, [pending, sending]);
	// Where the drawing pointer went down, and with which tool (a tool picked meanwhile changes nothing).
	const start = useRef<{ readonly x: number; readonly y: number; readonly tool: Exclude<Tool, "text"> } | undefined>(
		undefined,
	);
	const sender = useMotionSender(of.live);
	// The handlers are the surface's own: the event's current target is the board.
	const at = (event: PointerEvent<SVGSVGElement>): { x: number; y: number } => {
		const box = event.currentTarget.getBoundingClientRect();
		const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), max) * 10) / 10;
		return {
			x: clamp(((event.clientX - box.left) / box.width) * BOARD_WIDTH, BOARD_WIDTH),
			y: clamp(((event.clientY - box.top) / box.height) * BOARD_HEIGHT, BOARD_HEIGHT),
		};
	};
	const commit = (shape: Shape) => {
		if (drawer === undefined) return;
		const sent: Sending = { shape, id: undefined };
		setSending((current) => [...current, sent]);
		of.run(async (ctx) => {
			try {
				const [id] = await drawer.add({ shapes: [shape] }, ctx);
				setSending((current) => current.map((each) => (each === sent ? { shape, id } : each)));
			} catch (error) {
				setSending((current) => current.filter((each) => each !== sent));
				throw error;
			}
		});
	};
	const begin = (point: { x: number; y: number }, tool: Exclude<Tool, "text">, color: string) => {
		start.current = { ...point, tool };
		const next = draftOf(tool, color, point, point, undefined);
		setDraft(next);
		sender.point({ ...point, draft: next });
	};
	return {
		draft,
		sending: pending.map((sent) => sent.shape),
		down: (event) => {
			if (drawer === undefined) return;
			const point = at(event);
			if (of.tool === "text") {
				const placed = of.text.trim();
				if (placed !== "")
					commit({ kind: "text", color: of.color, x: point.x, y: point.y, text: placed, size: TEXT_SIZE });
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			begin(point, of.tool, of.color);
		},
		move: (event) => {
			const point = at(event);
			if (start.current === undefined || draft === null) {
				if (event.pointerType === "mouse") sender.point({ ...point, draft: null });
				return;
			}
			const next = draftOf(start.current.tool, draft.color, start.current, point, draft);
			if (next === draft) return;
			if (next.kind === "line" && next.points.length >= 2 * MAX_POINTS) {
				// A stroke at its most points is committed, and the pen goes on with a new one from where it is.
				commit(next);
				begin(point, "pen", draft.color);
				return;
			}
			setDraft(next);
			sender.point({ ...point, draft: next });
		},
		up: (event) => {
			if (start.current === undefined || draft === null) return;
			start.current = undefined;
			setDraft(null);
			if (worthKeeping(draft)) commit(draft);
			if (event.pointerType === "mouse") sender.point({ ...at(event), draft: null });
			else sender.leave();
		},
		leave: (event) => {
			if (event.pointerType === "mouse" && start.current === undefined) sender.leave();
		},
	};
}

/** The least distance, in board units, between two points of a stroke: closer moves add nothing. */
const STEP = 3;

/** How wide the pen draws, in board units. */
const PEN_WIDTH = 8;

/**
 * The draft of `tool` from `from` to `to`: a stroke `previous` with `to` added (itself when `to` is too close), or a
 * rectangle spanning both.
 */
function draftOf(
	tool: Exclude<Tool, "text">,
	color: string,
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number },
	previous: Shape | undefined,
): Shape {
	if (tool === "rect") {
		const x = Math.min(from.x, to.x);
		const y = Math.min(from.y, to.y);
		return { kind: "rect", color, x, y, w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y), fill: false };
	}
	if (previous?.kind !== "line")
		return { kind: "line", color, width: PEN_WIDTH, points: [from.x, from.y, to.x, to.y] };
	const points = previous.points;
	const dx = to.x - points[points.length - 2]!;
	const dy = to.y - points[points.length - 1]!;
	if (dx * dx + dy * dy < STEP * STEP) return previous;
	return { ...previous, points: [...points, to.x, to.y] };
}

/** Whether a finished draft is worth a shape: a tap with the pen is a dot, a rectangle needs some size. */
function worthKeeping(shape: Shape): boolean {
	return shape.kind !== "rect" || (shape.w >= STEP && shape.h >= STEP);
}
