/*
 * The Ticker's drum (ticker.tsx), with iOS's picker physics (UIScrollView; Apple's "Designing Fluid Interfaces", WWDC
 * 2018): it follows the finger one to one. On release, the release velocity is projected to where iOS's deceleration
 * would stop it; the drum picks the item nearest that point and decays to it at the same rate, so the motion carries on
 * from the finger. A slow release settles quickly to the nearest item. Past the ends: the rubber band. Catching it
 * stops it.
 *
 * It follows the newest item: a new one rolls in. While the reader scrolls it holds still, and once they have left it
 * alone for a few seconds it rolls to the newest item if new ones came in meanwhile. Positions are in items: 0 is the
 * oldest, `last` the newest.
 *
 * Ported from Elanor's Ticker (not in its npm release yet); replace with Elanor's once it ships.
 */

/** Height of an item (px), as `semantic.dimension.size.small`. */
export const FACE = 24;
/** Movement (px) before a press is a drag, not a tap. */
const SLOP = 6;
/** After the reader last scrolled, new items wait this long (ms) before the drum rolls to the newest. */
const IDLE = 4000;
/** iOS's normal deceleration: velocity is multiplied by this every millisecond. */
const DECELERATION = 0.998;
/** How far a release velocity (items per ms) carries: iOS's projection, v · d / (1 − d). */
const project = (velocity: number) => (velocity * DECELERATION) / (1 - DECELERATION);
/** A slow release or a short move (an item or less) settles faster: a crisp snap. */
const SNAP_DECELERATION = 0.986;
/** Velocity (items per ms) below which a release is a snap to the nearest item, not a fling. */
const FLING = 0.0015;
/** Samples of the finger in this window (ms) give the release velocity. */
const VELOCITY_WINDOW = 80;
/** The motion has ended within this distance (items). */
const REST = 0.004;
/** More items than this arriving at once are a catch-up (loading): the drum cuts to the newest, without rolling. */
const CATCH_UP = 2;
/** The mouse wheel settles this long (ms) after its last event. */
const WHEEL_SETTLE = 90;
/** iOS's rubber band constant. */
const RUBBER_BAND = 0.55;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Past the ends, the drum gives less and less (iOS's rubber band, over one item). */
function band(position: number, last: number): number {
	const rubber = (over: number) => 1 - 1 / (over * RUBBER_BAND + 1);
	if (position < 0) return -rubber(-position);
	return position > last ? last + rubber(position - last) : position;
}

type Drag = { y: number; start: number; moved: boolean; samples: { time: number; position: number }[] };

export type Drum = ReturnType<typeof createDrum>;

/** Creates a drum resting on item `initial`; `onMove` receives each new position. */
export function createDrum(initial: number, onMove: (position: number) => void) {
	let at = initial;
	let last = initial;
	let pending = false;
	let touched = 0;
	let frame = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let wheelTimer: ReturnType<typeof setTimeout> | undefined;
	let drag: Drag | undefined;
	let dragged = false;
	const place = (next: number) => {
		at = next;
		onMove(next);
	};
	/** Decays from where the drum is to item `target`: each ms the way left shrinks by `rate`. */
	const settle = (target: number, rate: number) => {
		cancelAnimationFrame(frame);
		const from = at;
		let start = 0;
		const tick = (now: number) => {
			start ||= now;
			const left = (target - from) * rate ** (now - start);
			if (Math.abs(left) < REST) {
				place(target);
				return;
			}
			place(target - left);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
	};
	/** Rolls to the newest item: a crisp snap for one item, iOS's deceleration for a longer way. */
	const follow = () => {
		pending = false;
		cancelAnimationFrame(frame);
		const distance = Math.abs(last - at);
		if (distance <= REST) return;
		settle(last, distance <= 1 ? SNAP_DECELERATION : DECELERATION);
	};
	/** The reader touched the drum: hold still, and look again once they have left it alone for IDLE. */
	const interacted = () => {
		touched = Date.now();
		clearTimeout(idleTimer);
		const check = () => {
			if (drag) {
				idleTimer = setTimeout(check, IDLE);
				return;
			}
			if (pending) follow();
		};
		idleTimer = setTimeout(check, IDLE);
	};
	/** Released at `velocity` (items per ms): a fling goes where iOS would stop it, a slow release to the nearest item. */
	const release = (velocity: number) => {
		const fling = Math.abs(velocity) > FLING;
		const target = clamp(Math.round(at + (fling ? project(velocity) : 0)), 0, last);
		settle(target, fling && Math.abs(target - at) > 1 ? DECELERATION : SNAP_DECELERATION);
	};
	const handlers = {
		setLast: (next: number) => {
			const added = next - last;
			last = next;
			if (added === 0) return;
			if (drag || Date.now() - touched < IDLE) {
				pending = Math.round(at) !== last;
				return;
			}
			// Many items at once are a catch-up: straight to the newest, without spinning through them.
			if (added > CATCH_UP || added < 0) {
				cancelAnimationFrame(frame);
				place(last);
				return;
			}
			follow();
		},
		index: () => clamp(Math.round(at), 0, last),
		takeDragged: () => {
			const was = dragged;
			dragged = false;
			return was;
		},
		// Like a scroll area inside the page: the wheel turns the drum one to one until it is at its end in that
		// direction; there the page scrolls.
		wheel: (event: WheelEvent) => {
			const delta = event.deltaY / (FACE * 2);
			const rest = Math.round(at);
			if ((delta < 0 && rest <= 0 && at <= 0) || (delta > 0 && rest >= last && at >= last)) return;
			event.preventDefault();
			interacted();
			cancelAnimationFrame(frame);
			place(clamp(at + delta, 0, last));
			clearTimeout(wheelTimer);
			wheelTimer = setTimeout(() => release(0), WHEEL_SETTLE);
		},
		pointerDown: (event: PointerEvent) => {
			if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId);
			// Catching the drum stops it where it is, as a finger on iOS does.
			cancelAnimationFrame(frame);
			dragged = false;
			drag = { y: event.clientY, start: at, moved: false, samples: [] };
			interacted();
		},
		pointerMove: (event: PointerEvent) => {
			if (!drag) return;
			// A mouse whose button is no longer down was released where no pointerup reached the drum (outside the
			// window).
			if (event.pointerType === "mouse" && event.buttons === 0) {
				handlers.pointerUp(event);
				return;
			}
			const dy = event.clientY - drag.y;
			if (!drag.moved && Math.abs(dy) < SLOP) return;
			drag.moved = true;
			interacted();
			// One to one with the finger, in items.
			const raw = drag.start - dy / FACE;
			drag.samples.push({ time: event.timeStamp, position: raw });
			while (drag.samples.length > 2 && event.timeStamp - (drag.samples[0]?.time ?? 0) > VELOCITY_WINDOW)
				drag.samples.shift();
			place(band(raw, last));
		},
		pointerUp: (event: PointerEvent) => {
			const done = drag;
			drag = undefined;
			if (!done) return;
			if (!done.moved) {
				// A tap while it moved only catches it: settle where it is.
				release(0);
				return;
			}
			dragged = true;
			const first = done.samples[0];
			const latest = done.samples.at(-1);
			// No move in the window before release: the finger was held still, no fling.
			const velocity =
				first && latest && latest.time > first.time && event.timeStamp - latest.time < VELOCITY_WINDOW
					? (latest.position - first.position) / (latest.time - first.time)
					: 0;
			release(velocity);
		},
		pointerCancel: () => {
			if (!drag) return;
			drag = undefined;
			release(0);
		},
		lostCapture: () => {
			// After a pointerup the drag is over already; otherwise this is the drag's end, and the drum must settle.
			if (!drag) return;
			dragged = drag.moved;
			drag = undefined;
			release(0);
		},
		step: (direction: number) => {
			interacted();
			settle(clamp(Math.round(at) + direction, 0, last), SNAP_DECELERATION);
		},
		destroy: () => {
			cancelAnimationFrame(frame);
			clearTimeout(idleTimer);
			clearTimeout(wheelTimer);
		},
	};
	return handlers;
}
