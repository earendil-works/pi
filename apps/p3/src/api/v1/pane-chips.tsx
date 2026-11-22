// The pane layout on a phone (`PaneLayout`, below 48rem; decision ERNDL-696): one pane at a time, full screen, under a
// row of chips, one per open pane in the tree's order (every group's), the shown one marked and scrolled into view.
// A tap on a chip shows its pane, its × closes it; a swipe left or right on the pane goes to the neighbour, sliding
// in (unless the person asked for reduced motion). No splits and no dragging here, but the same tree: a pane opened
// here shows in its group on a wider screen.

import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import styles from "./pane-chips.module.css";
import { closeShownPane, type Pane, type PaneLayoutProps, showPane } from "./pane-layout.tsx";
import { groupsOf, panesOf } from "./pane-tree.ts";

/** The phone's form of the layout. */
export function PaneChips(props: PaneLayoutProps) {
	const byId = new Map(props.panes.map((pane) => [pane.id, pane]));
	const open = panesOf(props.tree).flatMap((id) => byId.get(id) ?? []);
	const firstActive = groupsOf(props.tree).find((group) => group.active !== null)?.active;
	const shown =
		open.find((pane) => pane.id === props.focused) ?? open.find((pane) => pane.id === firstActive) ?? open[0];
	const index = shown === undefined ? -1 : open.indexOf(shown);
	// Which way the last switch went, for the slide in: towards a later pane, or an earlier one.
	const [slide, setSlide] = useState<"next" | "previous" | undefined>(undefined);
	const chips = useRef<HTMLDivElement>(null);
	const shownId = shown?.id;
	useEffect(() => {
		// The chip marked shown by this render: `shownId` changes when another one is.
		if (shownId !== undefined)
			chips.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [shownId]);
	const go = (pane: Pane) => {
		const to = open.indexOf(pane);
		if (to === index) return;
		setSlide(to > index ? "next" : "previous");
		showPane(props, pane.id);
	};
	const swipe = useSwipe((direction) => {
		const neighbour = open[index + (direction === "next" ? 1 : -1)];
		if (neighbour !== undefined) go(neighbour);
	});
	return (
		<div className={styles.layout} data-pane-layout="chips">
			<div className={styles.chips} data-pane-chips="" ref={chips} role="tablist">
				{open.map((pane) => (
					<span
						className={styles.chip}
						data-active={pane === shown ? "" : undefined}
						data-pane-chip={pane.id}
						key={pane.id}
					>
						<button
							aria-selected={pane === shown}
							className={styles.chipButton}
							onClick={() => go(pane)}
							role="tab"
							type="button"
						>
							{pane.title}
						</button>
						{pane.closable ? (
							<button
								aria-label={`Close ${pane.title}`}
								className={styles.close}
								data-pane-close={pane.id}
								onClick={() => closeShownPane(props, pane.id)}
								type="button"
							>
								<CloseIcon />
							</button>
						) : null}
					</span>
				))}
			</div>
			{shown === undefined ? null : (
				<div
					className={styles.body}
					data-pane={shown.id}
					data-pane-body=""
					data-slide={slide}
					key={shown.id}
					onPointerCancel={swipe.cancel}
					onPointerDown={swipe.down}
					onPointerUp={swipe.up}
				>
					{shown.render()}
				</div>
			)}
		</div>
	);
}

/** How far (px) a finger moves sideways, more than it moves up or down, for a swipe. */
const SWIPE = 60;

/**
 * A swipe on an element: a touch or pen moving `SWIPE` px sideways (and clearly more than up or down) between its
 * down and its up calls `swiped` with `next` (leftwards: the next pane) or `previous`. A gesture that starts on an
 * element taking its touches itself (`ownsTouches`) is that element's, never a swipe; one the browser takes over (a
 * scroll) is cancelled.
 */
function useSwipe(swiped: (direction: "next" | "previous") => void) {
	const start = useRef<{ readonly id: number; readonly x: number; readonly y: number } | undefined>(undefined);
	return {
		down: (event: ReactPointerEvent<HTMLElement>) => {
			if (event.pointerType === "mouse" || ownsTouches(event.target, event.currentTarget)) return;
			start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
		},
		up: (event: ReactPointerEvent<HTMLElement>) => {
			const from = start.current;
			start.current = undefined;
			if (from === undefined || from.id !== event.pointerId) return;
			const dx = event.clientX - from.x;
			const dy = event.clientY - from.y;
			if (Math.abs(dx) >= SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy)) swiped(dx < 0 ? "next" : "previous");
		},
		cancel: () => {
			start.current = undefined;
		},
	};
}

/**
 * Whether an element from `target` up to `area` takes its touches itself: one whose touch action is not the one the
 * layout gives every element of a pane (`pane-chips.module.css`): a canvas one draws on (`none`), a code block
 * scrolled sideways (`pan-x`).
 */
function ownsTouches(target: EventTarget, area: Element): boolean {
	for (let element = target instanceof Element ? target : null; element !== null && element !== area; ) {
		if (getComputedStyle(element).touchAction !== PANE_TOUCH) return true;
		element = element.parentElement;
	}
	return false;
}

/** The touch action the layout gives every element of a pane: up and down scroll, pinches zoom, sideways swipes. */
const PANE_TOUCH = "pan-y pinch-zoom";
