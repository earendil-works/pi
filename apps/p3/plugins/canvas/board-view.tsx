// The board kind's view of one board in a session (`ThingViews`): the shapes, live, on a board of fixed units that
// scales to the screen, with everyone else's pointer and name and what they are drawing as they draw it. A drawer
// (admitted with write access and options that say `draw`) draws with the pen (mouse, pen or finger), rectangles and
// text in a few colours, undoes their own last shape and clears the board; a viewer only looks, their pointer shown.
// The view follows the admission live: `draw` taken back turns it into the viewer's at once.

import { Button, Input, SegmentedControl } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, Me, type Reference } from "@earendil-works/p3/v1";
import { useHold, useRefState, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import styles from "./board-view.module.css";
import { BOARD_HEIGHT, BOARD_WIDTH, Canvas, type PlacedShape, type Shape } from "./contract.ts";
import { type Other, useMotionSender, useOthers } from "./motion.ts";

/** The drawer's members, as the view calls them. */
type Drawer = Extract<Reference<typeof Canvas>, { readonly variant: "drawer" }>;

/** A shape the drawer sent, with its id once the add answered. */
type Sending = { readonly shape: Shape; readonly id: string | undefined };

/** What a drawer draws with. */
type Tool = "pen" | "rect" | "text";

/** The colours a drawer picks from, by name. */
const COLORS = [
	{ name: "Ink", value: "#1f2328" },
	{ name: "Red", value: "#cf222e" },
	{ name: "Blue", value: "#0969da" },
	{ name: "Green", value: "#1a7f37" },
	{ name: "Orange", value: "#bc4c00" },
] as const;

/** Board `thing` of session `session`, as the viewer's admission allows. */
export function BoardView(props: { readonly session: string; readonly thing: string }) {
	const ref = useHold(Canvas, { session: props.session, thing: props.thing });
	const drawer = useVariant(ref, "drawer");
	const viewer = useVariant(ref, "viewer");
	const state = useRefState(ref);
	const live = drawer ?? viewer;
	const shapes = useWatch(live?.shapes);
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const myKey = me === undefined ? undefined : me.kind === "person" ? `person:${me.id}` : me.kind;
	const others = useOthers(live?.motion, myKey);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const run = (call: (context: Context) => Promise<unknown>) => {
		setFailure(undefined);
		call(BACKGROUND_CONTEXT).catch((error: unknown) => setFailure(messageOf(error)));
	};
	// The whole board is shown: every page is loaded as it becomes known.
	useEffect(() => {
		if (live === undefined || shapes?.moreAfter !== true) return;
		live.more(BACKGROUND_CONTEXT).catch((error: unknown) => setFailure(messageOf(error)));
	}, [live, shapes]);
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You may not see this canvas.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This canvas cannot be shown now.</p>;
	}
	return (
		<section aria-label="Canvas" className={styles.board} data-canvas={live?.variant ?? "loading"}>
			{drawer === undefined ? <p className={styles.hint}>{live === undefined ? "Loading…" : "View only"}</p> : null}
			<Board drawer={drawer} live={live} myKey={myKey} run={run} others={others} shapes={shapes?.rows ?? []} />
			{failure === undefined ? null : <p className={styles.error}>{failure}</p>}
		</section>
	);
}

/** What `error` says, for the line under the board. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The board itself: the toolbar for a drawer, the shapes, the drafts and the pointers. */
function Board(props: {
	readonly live: Reference<typeof Canvas> | undefined;
	readonly drawer: Drawer | undefined;
	readonly shapes: readonly PlacedShape[];
	readonly others: readonly Other[];
	readonly myKey: string | undefined;
	readonly run: (call: (context: Context) => Promise<unknown>) => void;
}) {
	const { drawer } = props;
	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState<string>(COLORS[0].value);
	const [text, setText] = useState("");
	const [draft, setDraft] = useState<Shape | null>(null);
	// Shapes sent but not yet among the rows (the answer, with the id, may come before the row): shown meanwhile, so
	// a stroke never blinks out between up and commit.
	const [sending, setSending] = useState<readonly Sending[]>([]);
	const shown = new Set(props.shapes.map((placed) => placed.id));
	const pending = sending.filter((sent) => sent.id === undefined || !shown.has(sent.id));
	useEffect(() => {
		if (pending.length < sending.length) setSending(pending);
	}, [pending, sending]);
	// Where the drawing pointer went down, and with which tool (a tool picked meanwhile changes nothing).
	const start = useRef<{ readonly x: number; readonly y: number; readonly tool: Exclude<Tool, "text"> } | undefined>(
		undefined,
	);
	const svg = useRef<SVGSVGElement>(null);
	const sender = useMotionSender(props.live);
	const at = (event: PointerEvent): { x: number; y: number } => {
		const box = svg.current!.getBoundingClientRect();
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
		props.run(async (ctx) => {
			try {
				const [id] = await drawer.add({ shapes: [shape] }, ctx);
				setSending((current) => current.map((each) => (each === sent ? { shape, id } : each)));
			} catch (error) {
				setSending((current) => current.filter((each) => each !== sent));
				throw error;
			}
		});
	};
	const down = (event: PointerEvent<SVGSVGElement>) => {
		if (drawer === undefined) return;
		const point = at(event);
		if (tool === "text") {
			const placed = text.trim();
			if (placed !== "") commit({ kind: "text", color, x: point.x, y: point.y, text: placed, size: 40 });
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		start.current = { ...point, tool };
		const next = draftOf(tool, color, point, point, undefined);
		setDraft(next);
		sender.point({ ...point, draft: next });
	};
	const move = (event: PointerEvent<SVGSVGElement>) => {
		const point = at(event);
		if (start.current === undefined || draft === null) {
			if (event.pointerType === "mouse") sender.point({ ...point, draft: null });
			return;
		}
		const next = draftOf(start.current.tool, draft.color, start.current, point, draft);
		if (next === draft) return;
		if (next.kind === "line" && next.points.length >= MAX_COORDINATES) {
			// A stroke at its most points is committed, and the pen goes on with a new one from where it is.
			commit(next);
			start.current = { ...point, tool: "pen" };
			const rest = draftOf("pen", draft.color, point, point, undefined);
			setDraft(rest);
			sender.point({ ...point, draft: rest });
			return;
		}
		setDraft(next);
		sender.point({ ...point, draft: next });
	};
	const up = (event: PointerEvent<SVGSVGElement>) => {
		if (start.current === undefined || draft === null) return;
		start.current = undefined;
		setDraft(null);
		if (worthKeeping(draft)) commit(draft);
		if (event.pointerType === "mouse") sender.point({ ...at(event), draft: null });
		else sender.leave();
	};
	const undo = () => {
		const mine = props.shapes.findLast((shape) => shape.author === props.myKey);
		if (drawer !== undefined && mine !== undefined) props.run((ctx) => drawer.remove({ id: mine.id }, ctx));
	};
	return (
		<>
			{drawer === undefined ? null : (
				<div className={styles.toolbar} data-canvas-tools="">
					<SegmentedControl.Root
						aria-label="Tool"
						density="compact"
						onValueChange={(value) => value[0] !== undefined && setTool(value[0])}
						value={[tool]}
					>
						<SegmentedControl.Item data-tool="pen" value="pen">
							Pen
						</SegmentedControl.Item>
						<SegmentedControl.Item data-tool="rect" value="rect">
							Box
						</SegmentedControl.Item>
						<SegmentedControl.Item data-tool="text" value="text">
							Text
						</SegmentedControl.Item>
					</SegmentedControl.Root>
					<fieldset aria-label="Colour" className={styles.colors}>
						{COLORS.map((choice) => (
							<button
								aria-pressed={color === choice.value}
								aria-label={choice.name}
								className={styles.color}
								data-color={choice.value}
								key={choice.value}
								onClick={() => setColor(choice.value)}
								style={{ background: choice.value }}
								type="button"
							/>
						))}
					</fieldset>
					<div className={styles.actions}>
						<Button
							data-canvas-undo=""
							density="compact"
							disabled={!props.shapes.some((shape) => shape.author === props.myKey)}
							hierarchy="tertiary"
							onClick={undo}
						>
							Undo
						</Button>
						<Button
							data-canvas-clear=""
							density="compact"
							disabled={props.shapes.length === 0}
							hierarchy="tertiary"
							onClick={() => props.run((ctx) => drawer.clear(ctx))}
							semantic="negative"
						>
							Clear
						</Button>
					</div>
					{tool === "text" ? (
						<Input
							aria-label="Text to place"
							className={styles.text}
							data-canvas-text=""
							onValueChange={setText}
							placeholder="Type, then tap the board"
							value={text}
						/>
					) : null}
				</div>
			)}
			<div className={styles.paper}>
				<svg
					aria-label="Drawing"
					className={drawer === undefined ? styles.surface : `${styles.surface} ${styles.drawing}`}
					data-canvas-surface=""
					onPointerCancel={up}
					onPointerDown={down}
					onPointerLeave={(event) =>
						event.pointerType === "mouse" && start.current === undefined && sender.leave()
					}
					onPointerMove={move}
					onPointerUp={up}
					ref={svg}
					role="img"
					viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
				>
					{props.shapes.map((placed) => (
						<ShapeSvg data-shape={placed.id} data-author={placed.author} key={placed.id} shape={placed.shape} />
					))}
					{pending.map((sent, index) => (
						// Shapes in flight may have no id yet; their order is stable while they are.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<ShapeSvg key={index} shape={sent.shape} />
					))}
					{props.others.map((other) =>
						other.draft === null ? null : (
							<ShapeSvg data-draft={other.who} key={`draft ${other.who}`} shape={other.draft} />
						),
					)}
					{draft === null ? null : <ShapeSvg data-draft="me" shape={draft} />}
				</svg>
				{props.others.map((other) => (
					<span
						className={styles.cursor}
						data-cursor={other.who}
						key={other.who}
						style={{ left: `${(other.x / BOARD_WIDTH) * 100}%`, top: `${(other.y / BOARD_HEIGHT) * 100}%` }}
					>
						<span className={styles.label}>{other.name}</span>
					</span>
				))}
			</div>
		</>
	);
}

/** The most coordinates one stroke holds (`Shape`'s bound: 2,000 points): a longer stroke is cut into several. */
const MAX_COORDINATES = 4000;

/** The least distance, in board units, between two points of a stroke: closer moves add nothing. */
const STEP = 3;

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
	if (previous?.kind !== "line") return { kind: "line", color, width: 8, points: [from.x, from.y, to.x, to.y] };
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

/** One shape as SVG. */
function ShapeSvg(props: { readonly shape: Shape; readonly [data: `data-${string}`]: string }) {
	const { shape, ...data } = props;
	switch (shape.kind) {
		case "line": {
			const [x0, y0, ...rest] = shape.points;
			// A tap is a line of two equal points: a round cap draws it as a dot.
			const path = `M${x0} ${y0}${rest.length === 0 ? "" : ` L${rest.join(" ")}`}`;
			return (
				<path
					{...data}
					d={path}
					fill="none"
					stroke={shape.color}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={shape.width}
				/>
			);
		}
		case "rect":
			return (
				<rect
					{...data}
					fill={shape.fill ? shape.color : "none"}
					height={shape.h}
					stroke={shape.color}
					strokeWidth={4}
					width={shape.w}
					x={shape.x}
					y={shape.y}
				/>
			);
		case "text":
			return (
				<text {...data} fill={shape.color} fontSize={shape.size} x={shape.x} y={shape.y}>
					{shape.text}
				</text>
			);
	}
}
