/*
 * Drag to close for bottom sheets (drawer.tsx), in place of Base UI's swipe (which closes at half the height or on any
 * light flick, with no resistance). Like iOS sheets and Vaul: the sheet follows the finger through a rubber band, light
 * at first and heavier the further it goes; on release it closes past a share of its height or on a clear flick, and
 * otherwise springs back. Dragging up gives only a little. A drag starts only where the content under the finger is
 * scrolled to its top; otherwise the content scrolls, and once it reaches the top the same finger takes over the sheet.
 *
 * The sheet's offset is `--drawer-drag` on the popup and its progress towards closing `--drawer-drag-progress` on the
 * backdrop; `data-dragging` on both turns transitions off while the finger moves.
 *
 * Ported from Elanor (not in its npm release yet); replace with Elanor's Drawer once it ships.
 */

/** Rubber band of a drag down: offset = (1 - 1 / (distance * k / height + 1)) * height. */
const DRAG_RESISTANCE = 0.8;
/** Rubber band of a drag up, past the resting place: much stiffer. */
const OVERPULL_RESISTANCE = 0.15;
/** A release past this share of the height closes the sheet, or a flick down faster than this (px/ms). */
const CLOSE_DISTANCE = 0.3;
const CLOSE_VELOCITY = 0.7;
/** Movement (px) before a touch is read as a drag or a scroll. */
const SLOP = 8;
/** Without a move this long (ms) before release, the finger was held still: no flick. */
const STILL = 100;
export const IGNORE_SELECTOR = "[data-base-ui-swipe-ignore]";

/** The rubber band: how far the sheet moves for a finger `distance` past its rest, in a sheet of `size`. */
export function rubberBand(distance: number, size: number, constant: number): number {
	if (size <= 0) return 0;
	return Math.sign(distance) * (1 - 1 / ((Math.abs(distance) * constant) / size + 1)) * size;
}

/** Whether every scrolling element from `target` up to `popup` is at its top. */
function atTop(target: EventTarget | null, popup: HTMLElement): boolean {
	for (
		let element: Element | null = target instanceof Element ? target : null;
		element;
		element = element === popup ? null : element.parentElement
	)
		if (element.scrollTop > 0) return false;
	return true;
}

type Gesture = {
	startX: number;
	startY: number;
	lastY: number;
	time: number;
	velocity: number;
	distance: number;
	target: EventTarget | null;
	mode?: "drag" | "scroll" | "none";
};

/** Attaches drag to close to a bottom sheet's popup; returns the cleanup. */
export function attachSheetDrag(
	popup: HTMLElement,
	{ backdrop, close }: { backdrop: () => HTMLElement | null; close: () => void },
): () => void {
	let gesture: Gesture | undefined;
	const setDragging = (dragging: boolean) => {
		popup.toggleAttribute("data-dragging", dragging);
		backdrop()?.toggleAttribute("data-dragging", dragging);
	};
	const place = (offset: number) => {
		popup.style.setProperty("--drawer-drag", `${offset}px`);
		backdrop()?.style.setProperty(
			"--drawer-drag-progress",
			String(Math.min(1, Math.max(0, offset) / popup.offsetHeight)),
		);
	};
	const reset = () => {
		popup.style.removeProperty("--drawer-drag");
		backdrop()?.style.removeProperty("--drawer-drag-progress");
	};
	const start = (event: TouchEvent) => {
		const touch = event.touches[0];
		const ignored = event.target instanceof Element && event.target.closest(IGNORE_SELECTOR) !== popup;
		gesture =
			touch && event.touches.length === 1 && !ignored
				? {
						startX: touch.clientX,
						startY: touch.clientY,
						lastY: touch.clientY,
						time: event.timeStamp,
						velocity: 0,
						distance: 0,
						target: event.target,
					}
				: undefined;
	};
	const move = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!gesture || !touch) return;
		if (!gesture.mode) {
			const dy = touch.clientY - gesture.startY;
			const dx = Math.abs(touch.clientX - gesture.startX);
			if (Math.abs(dy) < SLOP && dx < SLOP) return;
			gesture.mode = dx > Math.abs(dy) ? "none" : dy > 0 && atTop(gesture.target, popup) ? "drag" : "scroll";
			if (gesture.mode === "drag") setDragging(true);
		}
		// The handover: scrolling up, the content reaches its top while the finger still moves down.
		if (gesture.mode === "scroll" && touch.clientY > gesture.lastY && atTop(gesture.target, popup)) {
			Object.assign(gesture, { mode: "drag", startY: touch.clientY, distance: 0, velocity: 0 });
			setDragging(true);
		}
		const lastY = gesture.lastY;
		gesture.lastY = touch.clientY;
		if (gesture.mode !== "drag") return;
		if (event.cancelable) event.preventDefault();
		const distance = touch.clientY - gesture.startY;
		const elapsed = Math.max(1, event.timeStamp - gesture.time);
		gesture.velocity = 0.8 * ((touch.clientY - lastY) / elapsed) + 0.2 * gesture.velocity;
		gesture.time = event.timeStamp;
		gesture.distance = distance;
		const size = popup.offsetHeight;
		place(rubberBand(distance, size, distance >= 0 ? DRAG_RESISTANCE : OVERPULL_RESISTANCE));
	};
	const end = (event: TouchEvent) => {
		const done = gesture;
		gesture = undefined;
		if (done?.mode !== "drag") return;
		setDragging(false);
		const size = popup.offsetHeight;
		const offset = rubberBand(Math.max(0, done.distance), size, DRAG_RESISTANCE);
		const velocity = event.timeStamp - done.time > STILL ? 0 : done.velocity;
		// The exit starts where the finger left the sheet.
		if (offset > size * CLOSE_DISTANCE || velocity > CLOSE_VELOCITY) close();
		else reset();
	};
	const options = { passive: false };
	popup.addEventListener("touchstart", start, options);
	popup.addEventListener("touchmove", move, options);
	popup.addEventListener("touchend", end);
	popup.addEventListener("touchcancel", end);
	return () => {
		popup.removeEventListener("touchstart", start);
		popup.removeEventListener("touchmove", move);
		popup.removeEventListener("touchend", end);
		popup.removeEventListener("touchcancel", end);
		reset();
	};
}
