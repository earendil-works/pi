// A panel size the reader drags with a handle, kept per browser: the sidebar's and the right-hand panels' widths, the
// terminal's height.
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useState } from "react";

/** A dragged size: the style setting its CSS variable, and the handle's `pointerdown`. */
export type DragSize = {
	/** Sets the size's CSS variable while one is kept; `undefined` leaves the stylesheet's default. */
	readonly style: CSSProperties | undefined;
	/**
	 * Starts a drag on the handle's pointer: `sizeAt` maps each move to the size (clamped by the caller), shown on
	 * `element` until the pointer is released, then kept.
	 */
	readonly drag: (
		event: ReactPointerEvent<HTMLElement>,
		element: HTMLElement,
		sizeAt: (moved: PointerEvent) => number,
	) => void;
};

/** A size kept in `localStorage` under `key`, shown through the CSS variable `variable`. */
export function useDragSize(key: string, variable: string): DragSize {
	const [size, setSize] = useState(() => {
		try {
			return Number(localStorage.getItem(key)) || undefined;
		} catch {
			return undefined;
		}
	});
	// The handle captures its pointer, so the drag goes on off the handle. During the drag only the CSS variable
	// changes; React renders the panel once at the end.
	const drag = useCallback<DragSize["drag"]>(
		(event, element, sizeAt) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			event.preventDefault();
			const handle = event.currentTarget;
			const pointer = event.pointerId;
			handle.setPointerCapture(pointer);
			let last: number | undefined;
			const move = (moved: PointerEvent) => {
				if (moved.pointerId !== pointer) return;
				last = Math.round(sizeAt(moved));
				element.style.setProperty(variable, `${last}px`);
			};
			const end = (ended: PointerEvent) => {
				if (ended.pointerId !== pointer) return;
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", end);
				handle.removeEventListener("pointercancel", end);
				if (last === undefined) return;
				setSize(last);
				try {
					localStorage.setItem(key, String(last));
				} catch {}
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		},
		[key, variable],
	);
	return { style: size ? ({ [variable]: `${size}px` } as CSSProperties) : undefined, drag };
}
