// A one-finger drag along one axis that a gesture takes over from the page, shared by the phone drawer's swipe
// (drawer-swipe.ts) and the bottom sheets' (sheet-swipe.ts). Modeled on native drawers and sheets and the web gesture
// code that gets close to them (Ionic's gestures, Framework7's swipe panels, MUI's SwipeableDrawer).
//
// One touch is either the page's (a scroll, a selection) or the gesture's, never both. The browser holds back the
// first moves of a touch (its touch slop) and then sends one cancelable touchmove; if nobody cancels it, the touch
// scrolls and every later touchmove is uncancelable. So the axis is decided on the first move that is far enough to
// measure: within MAX_ANGLE of the gesture's axis, and accepted by the gesture (`take`: its direction, what is under the
// finger), the gesture owns the touch and cancels every move; otherwise the touch is left to the page for good. That
// needs a non-passive touchmove listener; it returns at once for touches that are not candidates. Pointer events
// cannot cancel a scroll, so they cannot guarantee this.
//
// A gesture follows the finger 1:1 (`move`, the distance along the axis since it took the touch) and settles on
// release (`end`, with the finger's velocity: measured over VELOCITY_WINDOW, so a finger that rested has none). A
// second finger, `touchcancel`, the page being hidden mid-drag (the app switcher, a call: touchcancel may not come)
// and `cancel()` end it without a velocity: it settles back.

/** Movement (px) before the axis is decided, for browsers that report moves inside their touch slop. */
const DECIDE = 6;
/** Steepest angle (degrees from the gesture's axis) that still counts as the gesture. */
const MAX_ANGLE = 35;
/** Velocity is measured over this window (ms) before the release. */
const VELOCITY_WINDOW = 100;

/** px/ms; a release faster than this settles in the fling's direction regardless of the position. */
export const FLING = 0.3;
/** Settle easing (ease-out); its initial slope, so a settle starts at the finger's speed. */
export const SETTLE_EASING = "cubic-bezier(0.2, 0.8, 0.4, 1)";
const EASING_SLOPE = 4;
/** Settle durations (ms): a slow release takes up to SLOWEST for the whole distance, a fling at least FASTEST. */
const FASTEST = 120;
const SLOWEST = 320;

/**
 * How long a settle over `remaining` of `total` px takes, released at `toward` px/ms toward its destination: it
 * continues the finger's speed (capped), a slow or backward release takes a time in proportion to the distance.
 */
export function settleDuration(remaining: number, total: number, toward: number): number {
	const slow = FASTEST + (SLOWEST - FASTEST) * Math.min(1, remaining / Math.max(total, 1));
	return Math.round(toward > 0 ? Math.min(slow, Math.max(FASTEST, (EASING_SLOPE * remaining) / toward)) : slow);
}

export type DragGesture<C> = {
	/** "x": a horizontal drag; "y": a vertical one. */
	readonly axis: "x" | "y";
	/** Whether a touch on `target` may become this drag, and what the gesture keeps for it; undefined: not this one. */
	begin(target: Element, touch: Touch): C | undefined;
	/**
	 * The axis is decided: `along` px so far, positive rightward or downward. True takes the touch (its moves are
	 * canceled from now on); `cancelable` false means the browser already scrolls it (a touch that landed on a fling).
	 */
	take(context: C, along: number, cancelable: boolean): boolean;
	/** The finger moved: `along` px from where the drag was taken. */
	move(context: C, along: number): void;
	/** Released at `velocity` px/ms along the axis; undefined: ended otherwise (settle back). */
	end(context: C, velocity: number | undefined): void;
};

/** Follows touches for `gesture` until `stop`; `cancel` ends a drag in progress without a velocity. */
export function trackDrags<C>(gesture: DragGesture<C>): { stop: () => void; cancel: () => void } {
	const along = (touch: Touch) => (gesture.axis === "x" ? touch.clientX : touch.clientY);
	let candidate: { id: number; x: number; y: number; context: C } | undefined;
	let drag: { id: number; from: number; samples: { at: number; t: number }[]; context: C } | undefined;

	const cancel = () => {
		const current = drag;
		candidate = undefined;
		drag = undefined;
		if (current) gesture.end(current.context, undefined);
	};
	const start = (event: TouchEvent) => {
		if (drag || candidate || event.touches.length > 1) {
			// A second finger: a pinch or an accidental touch, not a drag.
			cancel();
			return;
		}
		const touch = event.changedTouches[0];
		const target = event.target instanceof Element ? event.target : null;
		if (!touch || !target) return;
		const context = gesture.begin(target, touch);
		if (context !== undefined) candidate = { id: touch.identifier, x: touch.clientX, y: touch.clientY, context };
	};
	const move = (event: TouchEvent) => {
		const touch = [...event.changedTouches].find((each) => each.identifier === (drag ?? candidate)?.id);
		if (!touch) return;
		if (drag) {
			if (event.cancelable) event.preventDefault();
			// The move belongs to the gesture, not the page under it (the transcript stops following on touchmove).
			event.stopPropagation();
			drag.samples.push({ at: along(touch), t: event.timeStamp });
			while (drag.samples.length > 2 && event.timeStamp - drag.samples[0]!.t > VELOCITY_WINDOW) drag.samples.shift();
			gesture.move(drag.context, along(touch) - drag.from);
			return;
		}
		const current = candidate!;
		const dx = touch.clientX - current.x,
			dy = touch.clientY - current.y;
		if (Math.hypot(dx, dy) < DECIDE) return;
		candidate = undefined;
		const [primary, cross] = gesture.axis === "x" ? [dx, dy] : [dy, dx];
		if (Math.abs(cross) > Math.abs(primary) * Math.tan((MAX_ANGLE * Math.PI) / 180)) return;
		if (!gesture.take(current.context, primary, event.cancelable)) return;
		if (event.cancelable) event.preventDefault();
		event.stopPropagation();
		// Measured from here, so nothing jumps by the decision distance.
		drag = {
			id: current.id,
			from: along(touch),
			samples: [{ at: along(touch), t: event.timeStamp }],
			context: current.context,
		};
		gesture.move(drag.context, 0);
	};
	const end = (event: TouchEvent) => {
		const id = (drag ?? candidate)?.id;
		if (![...event.changedTouches].some((touch) => touch.identifier === id)) return;
		const current = drag;
		candidate = undefined;
		drag = undefined;
		if (!current) return;
		if (event.type === "touchcancel") return gesture.end(current.context, undefined);
		const recent = current.samples.filter((sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW);
		const first = recent[0],
			last = recent.at(-1);
		gesture.end(current.context, first && last && last.t > first.t ? (last.at - first.at) / (last.t - first.t) : 0);
	};
	const hide = () => {
		if (document.visibilityState === "hidden") cancel();
	};

	const passive = { capture: true, passive: true },
		blocking = { capture: true, passive: false };
	window.addEventListener("touchstart", start, passive);
	window.addEventListener("touchmove", move, blocking);
	window.addEventListener("touchend", end, passive);
	window.addEventListener("touchcancel", end, passive);
	document.addEventListener("visibilitychange", hide);
	return {
		stop: () => {
			window.removeEventListener("touchstart", start, passive);
			window.removeEventListener("touchmove", move, blocking);
			window.removeEventListener("touchend", end, passive);
			window.removeEventListener("touchcancel", end, passive);
			document.removeEventListener("visibilitychange", hide);
		},
		cancel,
	};
}
