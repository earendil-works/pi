// Swipe down to close a bottom sheet (phones; wide screens show sheets as dialogs), after native sheets: a drag that
// starts on the sheet's top edge (its grip and header) and goes down moves the sheet with the finger and fades its
// scrim; on release it closes on a downward fling or past CLOSE_AT of its height, else it settles back, with a duration
// that continues the finger's speed. The sheet closes (its route) when the slide out ends, so it is seen leaving.
// Following the touch, deciding its axis, owning it and measuring the release are shared with the drawer's swipe
// (drag-gesture.ts).
//
// Only the top edge: the sheet's content scrolls vertically, and a drag there stays a scroll. The grip and header take
// no browser gestures (`touch-action: none` in style.css), so their moves are always cancelable.
import { type RefObject, useEffect, useRef } from "react";
import { FLING, SETTLE_EASING, settleDuration, trackDrags } from "./drag-gesture.ts";

/** Share of the sheet's height past which a slow release closes it. */
const CLOSE_AT = 0.3;
/** Upward drags (past where the sheet rests) move this share of the finger's distance: a little give, no more. */
const RESIST = 0.2;

/** Where a downward drag may start: the grip and the header (the content scrolls). */
const EDGE = ".sheet-grip, .sheet-head";
const bottomSheet = () => !window.matchMedia("(min-width: 700px)").matches;

type Pull = { height: number; offset: number };

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

		const drags = trackDrags<Pull>({
			axis: "y",
			begin: (target) =>
				!closing && bottomSheet() && sheet.current?.contains(target) && target.closest(EDGE)
					? { height: 0, offset: 0 }
					: undefined,
			take: (pull, along) => {
				if (along <= 0 || !sheet.current) return false;
				clearTimeout(timer);
				for (const element of elements()) element.style.transition = "none";
				sheet.current.style.willChange = "transform";
				pull.height = sheet.current.getBoundingClientRect().height;
				return true;
			},
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
