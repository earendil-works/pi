// Swipe down to close a bottom sheet (phones; wide screens show sheets as dialogs), after native sheets: a drag down
// moves the sheet with the finger and fades its scrim; on release it closes on a downward fling or past CLOSE_AT of its
// height, else it settles back, with a duration that continues the finger's speed. The sheet closes (its route) when
// the slide out ends, so it is seen leaving. Following the touch, deciding its axis, owning it and measuring the
// release are shared with the drawer's swipe (drag-gesture.ts).
//
// Anywhere on the sheet, as iOS's sheets: the top edge (grip and header) always; the content when it is scrolled to its
// top, else the drag scrolls it, and once it reaches its top the same finger goes on pulling the sheet down. The grip
// and header take no browser gestures (`touch-action: none` in style.css), so their moves are always cancelable. Text
// fields and elements that take touches themselves (`touch-action: none`: a terminal, a wheel) keep theirs.
import { type RefObject, useEffect, useRef } from "react";
import { FLING, SETTLE_EASING, settleDuration, trackDrags } from "./drag-gesture.ts";

/** Share of the sheet's height past which a slow release closes it. */
const CLOSE_AT = 0.3;
/** Upward drags (past where the sheet rests) move this share of the finger's distance: a little give, no more. */
const RESIST = 0.2;

/** The sheet's top edge: a drag down there is always the sheet's (the content's only when it is at its top). */
const EDGE = ".sheet-grip, .sheet-head";
/** Elements whose touches are their own. */
const OWN = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const bottomSheet = () => !window.matchMedia("(min-width: 700px)").matches;

type Pull = { height: number; offset: number; edge: boolean; target: Element };

/** Whether `target`, or an element between it and the sheet, takes touches itself (a field, `touch-action: none`). */
function ownsTouches(target: Element, sheet: Element): boolean {
	if (target.closest(OWN)) return true;
	for (let element: Element | null = target; element && element !== sheet; element = element.parentElement)
		if (getComputedStyle(element).touchAction === "none") return true;
	return false;
}

/** Whether every element that scrolls between `target` and the sheet is at its top. */
function atTop(target: Element, sheet: Element): boolean {
	for (let element: Element | null = target; element && element !== sheet; element = element.parentElement)
		if (element.scrollTop > 0) return false;
	return true;
}

export function useSheetSwipe(
	sheet: RefObject<HTMLElement | null>,
	scrim: RefObject<HTMLElement | null>,
	close: () => void,
): void {
	const onClose = useRef(close);
	onClose.current = close;
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closing = false;

		const elements = () => [sheet.current, scrim.current].filter((element) => element !== null);
		const clear = () => {
			for (const element of elements())
				for (const property of ["transition", "transform", "opacity", "will-change"])
					element.style.removeProperty(property);
		};
		const paint = (pull: Pull) => {
			if (sheet.current) sheet.current.style.transform = `translateY(${pull.offset}px)`;
			if (scrim.current) scrim.current.style.opacity = String(Math.max(0, 1 - pull.offset / pull.height));
		};
		const settle = (pull: Pull, out: boolean, velocity: number) => {
			const remaining = out ? pull.height - pull.offset : Math.abs(pull.offset);
			const duration = settleDuration(remaining, pull.height, out ? velocity : -velocity);
			for (const element of elements())
				element.style.transition = `transform ${duration}ms ${SETTLE_EASING}, opacity ${duration}ms ${SETTLE_EASING}`;
			if (sheet.current) sheet.current.style.transform = out ? "translateY(100%)" : "none";
			if (scrim.current) scrim.current.style.opacity = out ? "0" : "1";
			clearTimeout(timer);
			if (out) {
				closing = true;
				timer = setTimeout(() => onClose.current(), duration);
			} else timer = setTimeout(clear, duration + 20);
		};

		/** The sheet follows the finger from now on. */
		const grab = (pull: Pull) => {
			if (!sheet.current) return false;
			clearTimeout(timer);
			for (const element of elements()) element.style.transition = "none";
			sheet.current.style.willChange = "transform";
			pull.height = sheet.current.getBoundingClientRect().height;
			return true;
		};
		const drags = trackDrags<Pull>({
			axis: "y",
			begin: (target) => {
				const element = sheet.current;
				if (closing || !bottomSheet() || !element?.contains(target)) return undefined;
				const edge = Boolean(target.closest(EDGE));
				return edge || !ownsTouches(target, element) ? { height: 0, offset: 0, edge, target } : undefined;
			},
			// Down from the edge, or from content at its top while the browser has not started scrolling it.
			take: (pull, along, cancelable) =>
				along > 0 &&
				Boolean(sheet.current) &&
				(pull.edge || (cancelable && atTop(pull.target, sheet.current!))) &&
				grab(pull),
			// Content scrolled up to its top by a finger that goes on down: the sheet takes over.
			resume: (pull, delta) =>
				delta > 0 && !closing && Boolean(sheet.current) && atTop(pull.target, sheet.current!) && grab(pull),
			move: (pull, along) => {
				pull.offset = along > 0 ? along : along * RESIST;
				paint(pull);
			},
			end: (pull, velocity) => {
				if (velocity === undefined) return settle(pull, false, 0);
				const out = Math.abs(velocity) > FLING ? velocity > 0 : pull.offset / pull.height > CLOSE_AT;
				settle(pull, out, velocity);
			},
		});
		return () => {
			drags.stop();
			clearTimeout(timer);
		};
	}, [sheet, scrim]);
}
