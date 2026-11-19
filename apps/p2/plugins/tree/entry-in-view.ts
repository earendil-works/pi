// Which message the reader is at in the transcript, for the tree panel's indicator (docs/tree.md, "Tree panel"). Read
// from the page: the transcript's rows carry their entry's ID (`data-entry`, src/web/Chat.tsx) and render only near
// the viewport, so the rows in the DOM are the ones that can be in view.
import { useEffect, useState } from "react";

/**
 * The entry of the last transcript row starting above the middle of the transcript's viewport, as the reader scrolls;
 * undefined without a transcript. `refresh` re-reads it (the rows changed without a scroll). The middle, because a
 * revealed message (a search hit, a turn chosen in the panel) is scrolled there: the indicator then marks it.
 */
export function useEntryInView(refresh: unknown): number | undefined {
	const [entry, setEntry] = useState<number>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` only re-runs the measurement.
	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			setEntry(entryInView());
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		// Scroll events do not bubble: captured at the document, every scroller's reach the panel, the transcript's
		// included when it remounts (another conversation).
		document.addEventListener("scroll", schedule, { capture: true, passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("scroll", schedule, { capture: true });
			window.removeEventListener("resize", schedule);
		};
	}, [refresh]);
	return entry;
}

/**
 * Calls `listener` when the reader starts scrolling the transcript themselves (wheel, touch, its scrollbar, keys), not
 * when the page scrolls it (a reveal, the answer growing). Returns the unsubscribe function.
 */
export function onReaderScroll(listener: () => void): () => void {
	const input = (event: Event) => {
		const target = event.target;
		if (!(target instanceof Node)) return;
		const rows = document.querySelector<HTMLElement>(".messages .rows");
		const scroller = rows && scrollerOf(rows);
		// Keys scroll the transcript when nothing editable has the focus (the page's body has it then).
		if (scroller?.contains(target) || (event.type === "keydown" && target === document.body)) listener();
	};
	const types = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
	for (const type of types) document.addEventListener(type, input, { capture: true, passive: true });
	return () => {
		for (const type of types) document.removeEventListener(type, input, { capture: true });
	};
}

/** The entry at the reading line of the transcript now. */
function entryInView(): number | undefined {
	const rows = document.querySelector<HTMLElement>(".messages .rows");
	const scroller = rows && scrollerOf(rows);
	if (!rows || !scroller) return undefined;
	const box = scroller.getBoundingClientRect();
	const line = box.top + box.height / 2;
	let found: number | undefined;
	for (const element of rows.querySelectorAll<HTMLElement>("[data-entry]")) {
		if (element.getBoundingClientRect().top > line) break;
		const entry = Number(element.dataset.entry);
		if (Number.isInteger(entry)) found = entry;
	}
	return found;
}

/** The nearest ancestor that scrolls vertically. */
function scrollerOf(element: HTMLElement): HTMLElement | undefined {
	for (let at = element.parentElement; at; at = at.parentElement)
		if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
	return undefined;
}
