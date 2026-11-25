// Swipe back in a Drawer.Stack (drawer.tsx): a horizontal swipe towards the inline end pulls the top page off, the
// one below following. Ported from Elanor (not in its npm release yet); replace with Elanor's Drawer once it ships.
import { IGNORE_SELECTOR, rubberBand } from "./sheet-drag.ts";

/** A swipe completes past this share of the width, or faster than this (px/ms). */
const BACK_DISTANCE = 0.4;
const BACK_VELOCITY = 0.45;
/** Rubber band of a pull towards the inline start. */
const OVERPULL_RESISTANCE = 0.15;
/** Movement (px) before a touch is read as horizontal or vertical. */
const SLOP = 8;
/** Without a move this long (ms) before release, the finger was still: no flick. */
const STILL = 100;

/** Whether a touch starts on something that scrolls sideways itself or asks to be left alone. */
function handlesSideways(target: EventTarget | null, stack: HTMLElement): boolean {
	if (!(target instanceof Element) || !stack.contains(target)) return true;
	const ignored = target.closest(IGNORE_SELECTOR);
	if (ignored && ignored !== stack && stack.contains(ignored)) return true;
	for (let element: Element | null = target; element && element !== stack; element = element.parentElement)
		if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "hidden")
			return true;
	return false;
}

type Gesture = {
	x: number;
	y: number;
	time: number;
	velocity: number;
	distance: number;
	sign: number;
	sideways: boolean;
	axis?: "x" | "none";
};

/** Attaches swipe back to `popup`; returns the cleanup. */
export function attachSwipeBack(
	popup: HTMLElement,
	options: {
		stack: HTMLElement;
		canGoBack: () => boolean;
		swipe: (offset: number) => void;
		swipeEnd: (back: boolean) => void;
	},
): () => void {
	const { stack, canGoBack, swipe, swipeEnd } = options;
	let gesture: Gesture | undefined;
	const start = (event: TouchEvent) => {
		const touch = event.touches[0];
		gesture =
			touch && event.touches.length === 1 && canGoBack()
				? {
						x: touch.clientX,
						y: touch.clientY,
						time: event.timeStamp,
						velocity: 0,
						distance: 0,
						sign: getComputedStyle(stack).direction === "rtl" ? -1 : 1,
						sideways: handlesSideways(event.target, stack),
					}
				: undefined;
	};
	const move = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!gesture || !touch) return;
		const distance = gesture.sign * (touch.clientX - gesture.x);
		if (!gesture.axis) {
			const dy = touch.clientY - gesture.y;
			if (Math.abs(distance) < SLOP && Math.abs(dy) < SLOP) return;
			gesture.axis = Math.abs(distance) > Math.abs(dy) && !gesture.sideways ? "x" : "none";
		}
		if (gesture.axis !== "x") return;
		if (event.cancelable) event.preventDefault();
		const elapsed = Math.max(1, event.timeStamp - gesture.time);
		gesture.velocity = 0.8 * ((distance - gesture.distance) / elapsed) + 0.2 * gesture.velocity;
		gesture.distance = distance;
		gesture.time = event.timeStamp;
		swipe(distance >= 0 ? distance : rubberBand(distance, stack.clientWidth, OVERPULL_RESISTANCE));
	};
	const end = (event: TouchEvent) => {
		const done = gesture;
		gesture = undefined;
		if (done?.axis !== "x") return;
		const velocity = event.timeStamp - done.time > STILL ? 0 : done.velocity;
		const width = stack.clientWidth || 1;
		swipeEnd(done.distance / width > BACK_DISTANCE || velocity > BACK_VELOCITY);
	};
	const listenerOptions = { passive: false };
	popup.addEventListener("touchstart", start, listenerOptions);
	popup.addEventListener("touchmove", move, listenerOptions);
	popup.addEventListener("touchend", end);
	popup.addEventListener("touchcancel", end);
	return () => {
		popup.removeEventListener("touchstart", start);
		popup.removeEventListener("touchmove", move);
		popup.removeEventListener("touchend", end);
		popup.removeEventListener("touchcancel", end);
	};
}
