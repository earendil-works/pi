// Swipe for the phone drawer, modeled on native drawers and the web gesture code that gets close to them (Ionic's
// menu gesture, Framework7's swipe panels, MUI's SwipeableDrawer): a drag toward the inline end (rightward; leftward
// in RTL) anywhere on the chat column drags the drawer open, a drag toward the inline start on the open drawer or
// its scrim drags it closed. The drawer follows the finger 1:1; on release it settles by fling velocity, else by
// position, with a duration that continues the finger's speed. Following the touch, deciding its axis, owning it and
// measuring the release are shared with the sheets' swipe (drag-gesture.ts).
//
// A touch that interrupts a fling gets no cancelable moves at all (Chromium), yet swiping the drawer open right after
// flicking the transcript must work. style.css sets `touch-action: pan-y pinch-zoom` on the phone layout and its
// vertical scrollers, so the browser does not scroll a mostly horizontal drag either way (the 35 degree limit is
// stricter than its 45 degree split). Should the page scroll under such a drag anyway, the drawer gives the touch up
// and settles back.
//
// Left to the page: text fields, elements with `touch-action: none` (the terminal, resize handles: they handle their
// own drags), horizontal scrollers that can still scroll in the drag's direction (a code block scrolled away from its
// start), drags extending a text selection, and the workspace panel (full screen above the drawer on phones).
import { type RefObject, useEffect, useRef } from "react";
import { getNavigation, setDrawer } from "../runtime/web.tsx";
import { FLING, SETTLE_EASING, settleDuration, trackDrags } from "./drag-gesture.ts";

const wide = () => window.matchMedia("(min-width: 900px)").matches;
// Fields where a horizontal drag moves a caret, selects text or moves a slider.
const OWN_DRAG = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

type Swipe = {
	/** The drawer's state when the touch started. */
	open: boolean;
	/** 1 in LTR, -1 in RTL: the sign of a drag toward the inline end. */
	sign: 1 | -1;
	target: Element;
	root: Element;
	width: number;
	progress: number;
	/** Captured without a cancelable move: a scroll of the page under it ends the drag. */
	uncancelable: boolean;
	/** Taken: the drawer follows this touch. */
	taken: boolean;
};

// Whether a horizontal scroller between the touch and the area root can still scroll the way the finger pushes it.
// A finger moving toward the inline end scrolls content toward its inline start, and the reverse. `scrollLeft` is 0
// at the inline start in both directions (negative toward the end in RTL), so its magnitude is the distance from it.
function scrollerTakes(target: Element, root: Element, towardEnd: boolean): boolean {
	for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
		const room = element.scrollWidth - element.clientWidth;
		if (room < 1) continue;
		const overflow = getComputedStyle(element).overflowX;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const offset = Math.abs(element.scrollLeft);
		if (towardEnd ? offset > 0.5 : offset < room - 0.5) return true;
	}
	return false;
}

export function useDrawerSwipe(): {
	main: RefObject<HTMLElement | null>;
	drawer: RefObject<HTMLElement | null>;
	scrim: RefObject<HTMLButtonElement | null>;
} {
	const main = useRef<HTMLElement>(null),
		drawer = useRef<HTMLElement>(null),
		scrim = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		let settling: { frame: number; timer: ReturnType<typeof setTimeout> } | undefined;
		/** The swipe the drawer follows now. */
		let active: Swipe | undefined;

		const elements = () => [drawer.current, scrim.current].filter((element) => element !== null);
		const clear = () => {
			for (const element of elements()) element.style.removeProperty("transition");
			drawer.current?.style.removeProperty("transform");
			drawer.current?.style.removeProperty("will-change");
			scrim.current?.style.removeProperty("opacity");
		};
		const stopSettling = () => {
			if (!settling) return;
			cancelAnimationFrame(settling.frame);
			clearTimeout(settling.timer);
			settling = undefined;
		};
		const paint = (current: Swipe) => {
			const offset = (current.progress - 1) * current.width * current.sign;
			if (drawer.current) drawer.current.style.transform = `translateX(${offset}px)`;
			if (scrim.current) scrim.current.style.opacity = String(current.progress);
		};

		// Animates from the finger's position to the destination, then hands the drawer back to its CSS state. The
		// inline styles stay until the route has re-rendered the matching drawer-open class, so nothing jumps.
		const settle = (current: Swipe, open: boolean, velocity: number) => {
			stopSettling();
			const remaining = Math.abs((open ? 1 : 0) - current.progress) * current.width;
			const duration = settleDuration(remaining, current.width, open ? velocity : -velocity);
			for (const element of elements())
				element.style.transition = `transform ${duration}ms ${SETTLE_EASING}, opacity ${duration}ms ${SETTLE_EASING}`;
			if (drawer.current) drawer.current.style.transform = open ? "none" : `translateX(${-102 * current.sign}%)`;
			if (scrim.current) scrim.current.style.opacity = open ? "1" : "0";
			if (open !== current.open) setDrawer(open);
			const started = performance.now();
			const handBack = () => {
				const routed = drawer.current?.parentElement?.classList.contains("drawer-open") === open;
				// Give up waiting for the route after a second: the CSS state wins then.
				if (routed || performance.now() - started > duration + 1000) {
					settling = undefined;
					clear();
				} else if (settling) settling.frame = requestAnimationFrame(handBack);
			};
			settling = { frame: 0, timer: setTimeout(handBack, duration + 20) };
		};

		const drags = trackDrags<Swipe>({
			axis: "x",
			begin: (target) => {
				if (wide() || !drawer.current || !main.current) return undefined;
				const layers = getNavigation().route.layers;
				const open = layers.at(-1)?.kind === "drawer";
				if (!open && layers.length > 0) return undefined;
				const roots = open ? elements() : [main.current];
				const root = roots.find((element) => element.contains(target));
				if (!root || target.closest(OWN_DRAG)) return undefined;
				for (let element: Element | null = target; element; element = element.parentElement)
					if (getComputedStyle(element).touchAction === "none") return undefined;
				const sign = getComputedStyle(drawer.current).direction === "rtl" ? -1 : 1;
				return { open, sign, target, root, width: 0, progress: open ? 1 : 0, uncancelable: false, taken: false };
			},
			take: (swipe, along, cancelable) => {
				const towardEnd = along * swipe.sign > 0;
				if (towardEnd === swipe.open) return false;
				if (document.getSelection()?.isCollapsed === false) return false;
				if (scrollerTakes(swipe.target, swipe.root, towardEnd)) return false;
				const width = drawer.current?.getBoundingClientRect().width ?? 0;
				if (!width) return false;
				stopSettling();
				// Drop the keyboard (and its viewport resize) while the drawer covers the composer.
				if (!swipe.open && document.activeElement instanceof HTMLElement) document.activeElement.blur();
				for (const element of elements()) element.style.transition = "none";
				if (drawer.current) drawer.current.style.willChange = "transform";
				swipe.width = width;
				swipe.uncancelable = !cancelable;
				swipe.taken = true;
				active = swipe;
				return true;
			},
			move: (swipe, along) => {
				swipe.progress = Math.min(1, Math.max(0, (swipe.open ? 1 : 0) + (along * swipe.sign) / swipe.width));
				paint(swipe);
			},
			end: (swipe, velocity) => {
				if (active === swipe) active = undefined;
				if (!swipe.taken) return;
				if (velocity === undefined) return settle(swipe, swipe.open, 0);
				const toward = velocity * swipe.sign;
				const open = Math.abs(toward) > FLING ? toward > 0 : swipe.progress > 0.5;
				settle(swipe, open, toward);
			},
		});
		// A drag the browser scrolls anyway (taken without a cancelable move) gives the touch up.
		const scrolled = (event: Event) => {
			if (!active?.uncancelable || !(event.target instanceof Node) || !active.root.contains(event.target)) return;
			drags.cancel();
		};
		const passive = { capture: true, passive: true };
		document.addEventListener("scroll", scrolled, passive);
		return () => {
			document.removeEventListener("scroll", scrolled, passive);
			drags.stop();
			stopSettling();
			clear();
		};
	}, []);
	return { main, drawer, scrim };
}
