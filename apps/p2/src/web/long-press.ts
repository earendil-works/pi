// A long press on touch screens: a finger resting on an element for half a second. p2's touch path for what a pointer
// reaches by hover or right-click (a message's reply, a row's command menu).
import { type PointerEvent, type TouchEvent, useEffect, useRef } from "react";

/** The handlers an element spreads to take long presses. */
export type LongPressHandlers = {
	readonly onPointerDown: (event: PointerEvent) => void;
	readonly onPointerUp: () => void;
	readonly onPointerMove: (event: PointerEvent) => void;
	readonly onPointerCancel: () => void;
	readonly onTouchEnd: (event: TouchEvent) => void;
};

/**
 * A long press: `handlers` to spread; `touching()`, whether a touch rests on the element now; `fire()`, the press
 * itself, at most once per touch (also from another event of the same touch, as Android's context menu event).
 */
export type LongPress = {
	readonly handlers: LongPressHandlers;
	readonly touching: () => boolean;
	readonly fire: () => void;
};

/** How long a touch rests before it is a long press. */
const LONG_PRESS_MS = 500;

/** How far a resting finger may drift (px) before the touch counts as a move (a scroll), not a long press. */
const LONG_PRESS_SLOP = 8;

/**
 * Calls `onPress` (the latest one passed) when a touch rests 500ms within 8px, with a short vibration. The touch that
 * ends a long press makes no click: on the element, or on what opened under the finger.
 */
export function useLongPress(onPress: () => void): LongPress {
	const latest = useRef(onPress);
	latest.current = onPress;
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const touch = useRef({ down: false, x: 0, y: 0, fired: false });
	// A press still waiting when the element unmounts never fires.
	useEffect(() => () => clearTimeout(timer.current), []);
	const cancel = () => clearTimeout(timer.current);
	const fire = () => {
		if (touch.current.fired) return;
		touch.current.fired = true;
		navigator.vibrate?.(10);
		latest.current();
	};
	const release = () => {
		cancel();
		touch.current.down = false;
	};
	return {
		handlers: {
			onPointerDown: (event) => {
				cancel();
				touch.current = { down: event.pointerType === "touch", x: event.clientX, y: event.clientY, fired: false };
				if (touch.current.down) timer.current = setTimeout(fire, LONG_PRESS_MS);
			},
			onPointerUp: release,
			onPointerMove: (event) => {
				const { down, x, y } = touch.current;
				if (down && Math.hypot(event.clientX - x, event.clientY - y) > LONG_PRESS_SLOP) cancel();
			},
			onPointerCancel: release,
			onTouchEnd: (event) => {
				if (touch.current.fired) event.preventDefault();
			},
		},
		touching: () => touch.current.down,
		fire,
	};
}
