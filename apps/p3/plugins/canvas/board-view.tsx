// The canvas kind's view of one board (`Views`): its name, the shapes, live, on a board of fixed units that scales to
// the screen, with everyone else's pointer and name and what they are drawing as they draw it. A drawer (granted Draw)
// draws with the pen (mouse, pen or finger), rectangles and text in a few colours (`toolbar.tsx`, `drawing.ts`) and
// undoes their own last shape; with Moderate also clears the board; a viewer only looks, their pointer shown. The view
// follows the admission live: Draw taken back turns it into the viewer's at once, on the same hold.

import {
	BACKGROUND_CONTEXT,
	type Context,
	Me,
	type MessagesOf,
	type Reference,
	type Translator,
	withGranted,
} from "@earendil-works/p3/v1";
import { useHold, useLive, useMessages, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";
import type { Caller } from "../things/contract.ts";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { type ThingViewProps, useErrorText } from "../things/contract.web.tsx";
import styles from "./board-view.module.css";
import { type Drawer, type Tool, useDrawing } from "./drawing.ts";
import {
	BOARD_HEIGHT,
	BOARD_WIDTH,
	CANVAS_DRAWS,
	Canvas,
	type Mover,
	type PlacedShape,
	type Shape,
	sameCaller,
} from "./kind.ts";
import { messages } from "./messages.ts";
import { useOthers } from "./motion-hooks.ts";
import type { Other } from "./pointers.ts";
import { COLORS, Toolbar } from "./toolbar.tsx";

/** The view's texts in the viewer's language. */
type Texts = Translator<"canvas", MessagesOf<typeof messages>>;

/** Board `thing` as it is available in `workspace`, as the viewer's admission there allows. */
export function BoardView(props: ThingViewProps) {
	const ref = useHold(Canvas, { workspace: props.workspace, thing: props.thing });
	const live = useLive(ref);
	const drawer = withGranted(live, ...CANVAS_DRAWS);
	const state = useRefState(ref);
	const shapes = useWatch(live?.shapes);
	const name = useWatch(live?.name);
	const me = callerOf(useWatch(useLive(useHold(Me, {}))?.me));
	const others = useOthers(live?.motion, me);
	// The last change's failure, rendered in the viewer's language when shown.
	const [failure, setFailure] = useState<{ readonly error: unknown } | undefined>(undefined);
	const errorText = useErrorText();
	const { t } = useMessages(messages);
	const run = (call: (context: Context) => Promise<unknown>) => {
		setFailure(undefined);
		call(BACKGROUND_CONTEXT).catch((error: unknown) => setFailure({ error }));
	};
	// The whole board is shown: every page is loaded as it becomes known (`MAX_SHAPES` bounds it: 20 pages).
	useEffect(() => {
		if (live === undefined || shapes?.moreAfter !== true) return;
		live.more(BACKGROUND_CONTEXT).catch((error: unknown) => setFailure({ error }));
	}, [live, shapes]);
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>{t("denied")}</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>{t("unavailable")}</p>;
	}
	return (
		<section
			aria-label={t("canvas")}
			className={styles.board}
			data-canvas={live === undefined ? "loading" : drawer === undefined ? "viewer" : "drawer"}
		>
			<p className={styles.title} data-canvas-name="">
				{name || t("untitled")}
				{live === undefined ? (
					<span className={styles.hint}>{t("loading")}</span>
				) : drawer === undefined ? (
					<span className={styles.hint}>{t("viewOnly")}</span>
				) : null}
			</p>
			<Board drawer={drawer} live={live} me={me} others={others} run={run} shapes={shapes?.rows ?? []} />
			{failure === undefined ? null : <p className={styles.error}>{errorText(failure.error)}</p>}
		</section>
	);
}

/** The viewer as a caller, from `Me` (none while it is loading). */
function callerOf(
	me:
		| { readonly kind: "person"; readonly id: string }
		| { readonly kind: "agent"; readonly session: string }
		| undefined,
): Caller | undefined {
	if (me === undefined) return undefined;
	return me.kind === "person" ? { kind: "person", person: me.id } : { kind: "agent", session: me.session };
}

/** The board itself: the toolbar for a drawer, the shapes, the drafts and the pointers. */
function Board(props: {
	readonly live: Reference<typeof Canvas> | undefined;
	readonly drawer: Drawer | undefined;
	readonly shapes: readonly PlacedShape[];
	readonly others: readonly Other[];
	readonly me: Caller | undefined;
	readonly run: (call: (context: Context) => Promise<unknown>) => void;
}) {
	const { drawer, me } = props;
	const { t } = useMessages(messages);
	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState<string>(COLORS[0].value);
	const [text, setText] = useState("");
	const drawing = useDrawing({ ...props, tool, color, text });
	const mine = me === undefined ? undefined : props.shapes.findLast((shape) => sameCaller(shape.author, me));
	const clear = drawer?.clear;
	return (
		<>
			{drawer === undefined ? null : (
				<Toolbar
					color={color}
					empty={props.shapes.length === 0}
					onClear={clear === undefined ? undefined : () => props.run((ctx) => clear(ctx))}
					onColor={setColor}
					onText={setText}
					onTool={setTool}
					onUndo={mine === undefined ? undefined : () => props.run((ctx) => drawer.remove({ id: mine.id }, ctx))}
					text={text}
					tool={tool}
				/>
			)}
			<div className={styles.paper}>
				<svg
					aria-label={t("drawing")}
					className={drawer === undefined ? styles.surface : `${styles.surface} ${styles.drawing}`}
					data-canvas-surface=""
					onPointerCancel={drawing.up}
					onPointerDown={drawing.down}
					onPointerLeave={drawing.leave}
					onPointerMove={drawing.move}
					onPointerUp={drawing.up}
					role="img"
					viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
				>
					{props.shapes.map((placed) => (
						<ShapeSvg data-shape={placed.id} key={placed.id} shape={placed.shape} />
					))}
					{drawing.sending.map((shape, index) => (
						// Shapes in flight may have no id yet; their order is stable while they are.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<ShapeSvg key={index} shape={shape} />
					))}
					{props.others.map((other) =>
						other.draft === null ? null : <ShapeSvg data-draft="other" key={other.key} shape={other.draft} />,
					)}
					{drawing.draft === null ? null : <ShapeSvg data-draft="me" shape={drawing.draft} />}
				</svg>
				{props.others.map((other) => (
					<span
						className={styles.cursor}
						data-cursor=""
						key={other.key}
						style={{ left: `${(other.x / BOARD_WIDTH) * 100}%`, top: `${(other.y / BOARD_HEIGHT) * 100}%` }}
					>
						<span className={styles.label}>{moverName(other.who, t)}</span>
					</span>
				))}
			</div>
		</>
	);
}

/** How the view names someone on the board: a person by name, an agent, the Pi itself. */
function moverName(who: Mover, t: Texts): string {
	switch (who.kind) {
		case "person":
			return who.name || t("someone");
		case "agent":
			return t("byAgent");
		case "server":
			return t("byPi");
	}
}

/** How wide a rectangle's outline is drawn, in board units (a rectangle has no width of its own). */
const OUTLINE = 4;

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
					strokeWidth={OUTLINE}
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
