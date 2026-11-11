/**
 * The transcript's scroll controller: a virtual list that renders only the rows near the viewport, keeps the reader's
 * place while rows change size, follows the answer at the bottom (Pi Mobile's pinning), and reveals an entry anywhere
 * in the loaded history.
 *
 * Problem: a row's real height is known only once it is rendered, and older history arrives in pages above the reader.
 * Every such change above the reader moves what they look at and has to be compensated. Changes below the reader (an
 * answer streaming in, tool calls arriving, the composer growing) move nothing: the scroll position counts from the
 * top. That is the common case while an agent works, and it needs no correction at all; a scroll position counted from
 * the bottom (a reversed column) inverts this and has to correct every change below the reader while they scroll,
 * which Chrome for Android, scrolling on its own thread, shows as jumps.
 *
 * Solution: where the browser keeps the place itself (CSS scroll anchoring, `overflow-anchor`: Chrome, Firefox), it
 * does, also mid-fling and under a finger; the spacers are never anchors (a spacer below the rows moves down when rows
 * are rendered before it). Elsewhere (Safari) one anchor row, the first one visible, keeps its place on screen: written
 * to `scrollTop` when nobody scrolls; while the reader scrolls held as a transform of the rows (which changes no layout)
 * and written once the scroll settles, or right away near the edge it would push content past (after TanStack
 * Virtual's iOS handling).
 *
 * Measured heights are kept per conversation (`keptSizes`), so the spacers are exact for rows shown before and only
 * rows never shown are estimated. Layout: `.rows` holds the top spacer, the rendered rows in normal flow, and the
 * bottom spacer; rows carry their own spacing (padding), so a row's measured border box is everything it adds.
 */
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ScrollGesture } from "./scroll-gesture.ts";
import { keptSizes, RowLayout } from "./virtual-list.ts";

/** The rendered rows, inclusive; `end < start` for none. */
export type RowRange = { readonly start: number; readonly end: number };
/** A row of the list: its stable key, and the entry it shows (for revealing it). */
/** A row of the list: its key, and the entry it shows, or the entries (a turn's activity holds several responses). */
export type ListRow = { readonly key: string; readonly entryId?: number; readonly entryIds?: readonly number[] };

const NO_ROWS: readonly ListRow[] = [];
const NONE: RowRange = { start: 0, end: -1 };
/** Estimates for rows never rendered, learning from the rows that were (`RowEstimator`). */
export type RowEstimates<Row> = {
	estimate(row: Row, width: number): number;
	measured(row: Row, width: number, height: number): void;
};
const NO_ESTIMATES: RowEstimates<ListRow> = { estimate: () => 0, measured: () => {} };
/** How far beyond the viewport rows are rendered, in viewports (at least `MIN_OVERSCAN` pixels). */
const OVERSCAN = 1;
const MIN_OVERSCAN = 400;
/**
 * Older history loads while the reader is within this many viewports of the loaded start, and keeps loading while
 * they stay there: a page usually arrives before a fast scroll reaches the top.
 */
const PREFETCH = 3;
/** Within this many viewports of the list's start (beyond the overscan), the rows up to it are all rendered. */
const EDGE = 2;

// `scrollTop` counts from the top. A position past either end is the rubber band (iOS).

/** Whether the browser keeps the reader's place when content above them changes (CSS scroll anchoring). */
const NATIVE_ANCHORING = typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto");

/** The transcripts gliding (`TranscriptScroll.#glide`), by scroller: their messages, drawn lower for a moment. */
const gliding = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Where the content ends. The browser counts a gliding transcript, drawn lower, as content below the end: scrolled
 * there, the transcript would jump down at the next layout as the glide ends (the browser clamps the scroll position).
 */
function contentHeight(element: HTMLElement): number {
	const messages = gliding.get(element);
	if (!messages) return element.scrollHeight;
	const shift = new DOMMatrixReadOnly(getComputedStyle(messages).transform).m42;
	const bottom =
		messages.getBoundingClientRect().bottom -
		shift -
		element.getBoundingClientRect().top +
		element.scrollTop +
		Number.parseFloat(getComputedStyle(element).paddingBottom);
	return Math.max(element.clientHeight, Math.min(element.scrollHeight, Math.ceil(bottom)));
}

/** How far the viewport is from the bottom. */
function fromEnd(element: HTMLElement): number {
	return contentHeight(element) - element.clientHeight - element.scrollTop;
}

/** How far the viewport is from the top. */
function fromStart(element: HTMLElement): number {
	return element.scrollTop;
}

function isBottom(element: HTMLElement): boolean {
	return fromEnd(element) < 2;
}

/**
 * Scrolls to the end unless already there. Every write counts, even one that changes nothing: WebKit stops a fling's
 * momentum on it, and a streaming answer resizes the transcript many times a second.
 */
function toEnd(element: HTMLElement): void {
	if (fromEnd(element) >= 1) element.scrollTop = contentHeight(element) - element.clientHeight;
}

/** Mounted transcripts, so a search hit or a quoted message can be revealed wherever it is shown. */
const mounted = new Set<TranscriptScroll>();

/** Scrolls an entry of a shown transcript into view and highlights it; false when no transcript has it loaded. */
export function revealInTranscripts(entryId: number): boolean {
	for (const transcript of mounted) if (transcript.reveal(entryId)) return true;
	return false;
}

export class TranscriptScroll {
	layout = new RowLayout();
	/** The rows to render: React renders these, `committed` reports them in the DOM. */
	range: RowRange = NONE;
	/** Following the answer at the bottom (Pi Mobile's `pinned`). */
	pinned = true;
	atBottom = true;
	/**
	 * The loaded history: whether older entries exist, whether a page is loading, and how many items are loaded (a
	 * page that arrived changes it, even when its entries joined a row already shown, such as a turn's activity).
	 */
	history: { more: boolean; loading: boolean; size?: number } | undefined;
	onEarlier: (() => void) | undefined;

	#cache: string | undefined;
	#rows: readonly ListRow[] = NO_ROWS;
	#estimates: RowEstimates<ListRow> = NO_ESTIMATES;
	#rendered: RowRange = NONE;
	/** The range the last change replaced (`#updateRange`), while the rows are the same. */
	#replaced: RowRange | undefined;
	#version = 0;
	readonly #listeners = new Set<() => void>();

	#scroller: HTMLElement | null = null;
	#list: HTMLElement | null = null;
	#top: HTMLElement | null = null;
	#bottom: HTMLElement | null = null;
	readonly #elements = new Map<string, HTMLElement>();
	readonly #observer: ResizeObserver | undefined =
		typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => this.#resized(entries));
	#spacers = { top: Number.NaN, bottom: Number.NaN };

	/** A correction not written to `scrollTop` yet: the rows are translated up by it meanwhile. */
	#hold = 0;
	/**
	 * The first visible row, what corrections keep in place: where it is on screen (`screen`, relative to the
	 * viewport's top) and in the scrolled content (`content`, `#contentTop`). Which one a correction compares is
	 * `#moved`'s choice.
	 */
	#anchor: { key: string; screen: number; content: number } | undefined;
	/** Where the viewport's top is, as a row and an offset into it: survives rows added or removed before it. */
	#position: { key: string; offset: number } | undefined;
	/** An entry being revealed: steered to the viewport's center until it stays there. */
	#target: { key: string; entryId: number; frames: number; stable: number } | undefined;
	#viewport = 0;
	#width = 0;
	#lastScrollTop = 0;
	/** The last row's key at the last commit: rows after it were appended since (`#appended`). */
	#lastKey: string | undefined;
	/**
	 * A scroll down to the answer (the scroll-down button) is under way: its smooth scroll's events never stop
	 * following, even when the growing answer makes one of them read as a move up. The reader's input ends it.
	 */
	#following = false;
	/** The loaded history's size (or the row count) when older history was last asked for. */
	#earlierSize = -1;
	#resizing = false;
	#deferred: number | undefined;
	/** The running glide of new messages (`#glide`), if any. */
	#gliding: Animation | undefined;
	readonly #gesture = new ScrollGesture(
		() => this.#settled(),
		() => this.#scroller !== null && this.#scroller.scrollTop !== this.#lastScrollTop,
	);

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	snapshot = (): number => this.#version;

	/**
	 * The rows to render for `rows` (during render). New rows keep the reader's place: the viewport stays on the row it
	 * showed, wherever that row is now.
	 */
	prepare(cache: string | undefined, rows: readonly ListRow[], estimates: RowEstimates<ListRow>) {
		if (cache !== this.#cache) {
			this.#cache = cache;
			this.layout = new RowLayout(cache === undefined ? new Map() : keptSizes(cache));
			this.#rows = NO_ROWS;
			this.pinned = true;
			this.#hold = 0;
			this.#anchor = undefined;
			this.#position = undefined;
			this.#target = undefined;
			this.#lastKey = undefined;
			this.#earlierSize = -1;
		}
		if (rows !== this.#rows || estimates !== this.#estimates) {
			this.#rows = rows;
			this.#estimates = estimates;
			this.layout.setRows(
				rows.map((row) => row.key),
				(index) => {
					const row = rows[index];
					return row ? estimates.estimate(row, this.#rowWidth()) : 0;
				},
			);
			this.range = this.#computeRange();
			// Indices of other rows: the last change says nothing about these.
			this.#replaced = undefined;
		}
		return this.range;
	}

	/** React rendered `range` (a layout effect): place the spacers and keep the reader's place. */
	committed(range: RowRange): void {
		this.#rendered = range;
		// The spacers are already right (rendered with the rows, `spacers`); placed again before any measurement reads
		// the layout, in case a width change re-estimated rows since.
		this.#setSpacers();
		// Rows rendered now are measured now, before anything is placed by them: with estimates, a correction (real
		// heights) and the range (estimated ones) would disagree, and each render would move the range again.
		for (const [key, element] of this.#elements) {
			if (element.isConnected) this.#measure(key, element.getBoundingClientRect().height);
		}
		this.#applyHold();
		const appended = this.#appended();
		const before = this.#scroller?.scrollTop ?? 0;
		this.#sync();
		// The glide shows how far the new rows pushed the transcript up: none while it fits the viewport, and none when
		// they took space another row gave up (an answer taking the place of its wheel's thought, ThoughtSlot.tsx).
		const pushed = Math.min(appended, (this.#scroller?.scrollTop ?? 0) - before);
		if (pushed > 0) this.#glide(pushed);
	}

	/**
	 * The height of rows appended since the last commit while following the answer: rows after the previous last row,
	 * which is still there (not a row replaced in place: a streaming answer committed, a sent message the server now
	 * shows). 0 otherwise.
	 */
	#appended(): number {
		const previous = this.#lastKey;
		const count = this.layout.count;
		this.#lastKey = this.layout.keyAt(count - 1);
		if (!this.pinned || this.#gesture.active || previous === undefined) return 0;
		const at = this.layout.indexOf(previous);
		if (at === undefined || at >= count - 1) return 0;
		return this.layout.total - this.layout.offsetOf(at + 1);
	}

	/**
	 * New messages at the bottom push the transcript up by their height at once; this lets it glide there instead, as
	 * chat apps do: the messages are drawn `height` lower and move up to their place (a transform: no layout, no
	 * scroll change), while the new rows fade in (`.row.arriving`). At most a viewport of it; none with reduced motion.
	 */
	#glide(height: number): void {
		const messages = this.#list?.parentElement;
		if (!messages || typeof messages.animate !== "function") return;
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const from = Math.min(height, this.#viewport || height);
		const glide = messages.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], {
			duration: 320,
			easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
		});
		this.#gliding = glide;
		const scroller = this.#scroller;
		if (!scroller) return;
		gliding.set(scroller, messages);
		const ended = () => {
			if (this.#gliding === glide || !this.#gliding) gliding.delete(scroller);
		};
		glide.addEventListener("finish", ended);
		glide.addEventListener("cancel", ended);
	}

	/**
	 * The reader takes over: a running glide ends at once (the rows are where the layout has them). Positions read while
	 * it ran would include its transform, which corrections would take for content moving.
	 */
	#endGlide(): void {
		this.#gliding?.finish();
		this.#gliding = undefined;
	}

	scrollerRef = (element: HTMLDivElement | null) => {
		if (!element) return;
		this.#scroller = element;
		this.#viewport = element.clientHeight;
		this.#lastScrollTop = element.scrollTop;
		mounted.add(this);
		this.#observer?.observe(element);
		const capture = { capture: true, passive: true } as const;
		// A touch alone does not stop following the answer (a tap on a button at the bottom); dragging up does. While
		// the finger rests, the transcript does not scroll to the end under it either: the gesture holds every write.
		const press = () => {
			this.#endGlide();
			this.#gesture.press();
			this.#target = undefined;
			this.#following = false;
		};
		const pointerDown = (event: PointerEvent) => {
			// Touches are followed by their touch events: a scrolling touch cancels its pointer.
			if (event.pointerType !== "touch") press();
		};
		const lift = () => {
			this.#gesture.lift();
			this.#release();
		};
		const pointerUp = (event: PointerEvent) => {
			if (event.pointerType !== "touch") lift();
		};
		const wheel = (event: WheelEvent) => {
			this.#endGlide();
			this.#gesture.wheel();
			this.#target = undefined;
			this.#following = false;
			if (event.deltaY < 0) this.unpin();
		};
		const touchMove = () => this.unpin();
		element.addEventListener("scroll", this.#scrolled, { passive: true });
		element.addEventListener("touchstart", press, capture);
		element.addEventListener("touchmove", touchMove, capture);
		element.addEventListener("touchend", lift, capture);
		element.addEventListener("touchcancel", lift, capture);
		element.addEventListener("pointerdown", pointerDown, capture);
		element.addEventListener("wheel", wheel, capture);
		// The mouse can be released outside the transcript (dragging its scrollbar).
		window.addEventListener("pointerup", pointerUp, capture);
		window.addEventListener("pointercancel", pointerUp, capture);
		return () => {
			element.removeEventListener("scroll", this.#scrolled);
			element.removeEventListener("touchstart", press, capture);
			element.removeEventListener("touchmove", touchMove, capture);
			element.removeEventListener("touchend", lift, capture);
			element.removeEventListener("touchcancel", lift, capture);
			element.removeEventListener("pointerdown", pointerDown, capture);
			element.removeEventListener("wheel", wheel, capture);
			window.removeEventListener("pointerup", pointerUp, capture);
			window.removeEventListener("pointercancel", pointerUp, capture);
			this.#observer?.unobserve(element);
			this.#gesture.dispose();
			mounted.delete(this);
			if (this.#scroller === element) this.#scroller = null;
		};
	};

	/** The `.rows` element; its parent (`.messages`) is observed for changes around the rows (Earlier, Working). */
	listRef = (element: HTMLDivElement | null) => {
		if (!element) return;
		this.#list = element;
		this.#width = element.clientWidth;
		const parent = element.parentElement;
		if (parent) this.#observer?.observe(parent);
		return () => {
			if (parent) this.#observer?.unobserve(parent);
			if (this.#list === element) this.#list = null;
		};
	};
	topRef = (element: HTMLDivElement | null) => {
		this.#top = element;
		this.#spacers.top = Number.NaN;
	};
	bottomRef = (element: HTMLDivElement | null) => {
		this.#bottom = element;
		this.#spacers.bottom = Number.NaN;
	};

	/** A rendered row (`data-row` is its key): measured whenever its size changes. */
	rowRef = (element: HTMLDivElement | null) => {
		if (!element) return;
		const key = element.dataset.row ?? "";
		this.#elements.set(key, element);
		this.#observer?.observe(element);
		return () => {
			this.#observer?.unobserve(element);
			if (this.#elements.get(key) === element) this.#elements.delete(key);
		};
	};

	/** The composer dock floats over the transcript's bottom: the transcript keeps room for it. */
	dockRef = (docked: HTMLDivElement | null) => {
		const element = this.#scroller;
		if (!docked || !element) return;
		const observer = new ResizeObserver(() => {
			element.style.paddingBottom = `${docked.offsetHeight}px`;
			docked.style.right = `${Math.max(element.offsetWidth - element.clientWidth, 4)}px`;
			// The room is below the rows: a taller composer (a second line, a queued chip) moves nothing the reader
			// sees, and a transcript following the answer stays at its end.
			this.#sync();
		});
		observer.observe(element);
		observer.observe(docked);
		return () => observer.disconnect();
	};

	/** The reader scrolls up or touches the transcript: stop following the answer. */
	unpin(): void {
		if (!this.pinned) return;
		this.pinned = false;
		this.#captureAnchor();
		this.#capturePosition();
	}

	/** Follow the answer again; the transcript scrolls down to it. */
	toBottom = (): void => {
		const element = this.#scroller;
		this.#target = undefined;
		this.pinned = true;
		this.#anchor = undefined;
		this.#updateRange();
		this.#updateBottom();
		if (!element) return;
		this.#flushHold();
		// Far away, the rows in between are not rendered: jump. Near, scroll smoothly; the animation holds corrections.
		if (fromEnd(element) > element.clientHeight) toEnd(element);
		else {
			this.#following = true;
			this.#gesture.wheel();
			element.scrollTo({ top: contentHeight(element) - element.clientHeight, behavior: "smooth" });
		}
	};

	/** Scrolls entry `entryId` to the viewport's center and highlights it; false when it is not loaded here. */
	reveal(entryId: number): boolean {
		const row = this.#rows.find(
			(candidate) => candidate.entryId === entryId || candidate.entryIds?.includes(entryId),
		);
		const element = this.#scroller;
		if (!row || !element) return false;
		this.pinned = false;
		this.#flushHold();
		const shown = this.#elements.get(row.key);
		const rect = shown?.isConnected ? shown.getBoundingClientRect() : undefined;
		const view = element.getBoundingClientRect();
		if (shown && rect && rect.bottom > view.top - view.height && rect.top < view.bottom + view.height) {
			// Near: a smooth scroll, as before virtualization; corrections wait for it.
			this.#gesture.wheel();
			(shown.querySelector(`[data-entry="${entryId}"]`) ?? shown).scrollIntoView({
				block: "center",
				behavior: "smooth",
			});
			this.#flash(row.key, entryId);
			return true;
		}
		this.#target = { key: row.key, entryId, frames: 0, stable: 0 };
		this.#updateRange();
		this.#steer();
		return true;
	}

	#emit(): void {
		// A render from inside a resize observation adds rows the observation cannot deliver any more (the browser
		// reports "ResizeObserver loop completed with undelivered notifications"); measurements change only the
		// overscan, so that render can wait a frame.
		if (this.#resizing) {
			if (this.#deferred === undefined)
				this.#deferred = requestAnimationFrame(() => {
					this.#deferred = undefined;
					this.#emit();
				});
			return;
		}
		this.#version++;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Where the viewport's top is in the layout (rows' offsets). */
	#layoutTop(): number | undefined {
		const scroller = this.#scroller;
		const list = this.#list;
		if (!scroller || !list) return undefined;
		// The rows' box is translated by the held correction, and the layout with it: what is on screen counts.
		return scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
	}

	#computeRange(): RowRange {
		const layout = this.layout;
		if (layout.count === 0) return NONE;
		const view = this.#viewport || window.innerHeight;
		const overscan = Math.max(view * OVERSCAN, MIN_OVERSCAN);
		let top: number;
		const target = this.#target && layout.indexOf(this.#target.key);
		const position = this.#position && layout.indexOf(this.#position.key);
		if (target !== undefined) top = layout.offsetOf(target) + layout.sizeOf(target) / 2 - view / 2;
		else if (this.pinned) top = layout.total - view;
		else if (position !== undefined) top = layout.offsetOf(position) + (this.#position?.offset ?? 0);
		else top = this.#layoutTop() ?? layout.total - view;
		const found = layout.range(top - overscan, top + view + overscan) ?? NONE;
		// Near the list's start, every row up to it is rendered (and measured): above the reader, a row that turns out
		// shorter than its estimate shrinks the content there, and with less than that left to the top edge the
		// browser has to clamp the scroll position, which shows as a jump. Measured early, the top edge is exact
		// by the time the reader gets there.
		const range = top - overscan < view * EDGE ? { start: 0, end: found.end } : found;
		return range.start === this.range.start && range.end === this.range.end ? this.range : range;
	}

	/**
	 * Rendering rows at an end of the range can move the scroll position (the browser's scroll anchoring shifted a real
	 * transcript by a few pixels for one row), and with it the range: a change that drops exactly the rows the last one
	 * added would bring that layout back, and the next change would add them again, every render. Such a change keeps
	 * them: at each end the range takes the larger of the two. Adding rows is never held back, and the next change that
	 * is not such a reversal applies as computed.
	 */
	#updateRange(): void {
		const computed = this.#computeRange();
		if (computed === this.range) return;
		const replaced = this.#replaced;
		const current = this.range;
		const start =
			replaced && computed.start === replaced.start && computed.start > current.start
				? current.start
				: computed.start;
		const end = replaced && computed.end === replaced.end && computed.end < current.end ? current.end : computed.end;
		if (start === current.start && end === current.end) return;
		this.#replaced = current;
		this.range = start === computed.start && end === computed.end ? computed : { start, end };
		this.#emit();
	}

	#updateBottom(): void {
		const element = this.#scroller;
		const value = this.pinned || (element ? isBottom(element) : true);
		if (value === this.atBottom) return;
		this.atBottom = value;
		this.#emit();
	}

	/**
	 * The heights of the spacers standing for the rows before and after `range`. Rendered together with the rows: a
	 * layout in between, with rows gone and the spacer not grown yet, would shorten the content for a moment, and at
	 * the top edge the browser clamps the scroll position to that and keeps it (a jump).
	 */
	spacers(range: RowRange): { before: number; after: number } {
		const layout = this.layout;
		if (range.end < range.start || range.end >= layout.count) return { before: 0, after: 0 };
		return { before: layout.offsetOf(range.start), after: layout.total - layout.offsetOf(range.end + 1) };
	}

	#setSpacers(): void {
		const { before: top, after: bottom } = this.spacers(this.#rendered);
		if (this.#top && top !== this.#spacers.top) {
			this.#spacers.top = top;
			this.#top.style.height = `${top}px`;
		}
		if (this.#bottom && bottom !== this.#spacers.bottom) {
			this.#spacers.bottom = bottom;
			this.#bottom.style.height = `${bottom}px`;
		}
	}

	/**
	 * Translates the rows by the held correction (a transform changes no layout). Content it pushes past an edge is out
	 * of reach until the hold is written, which happens near that edge (`#nearEdge`) or when the scroll settles.
	 */
	#applyHold(): void {
		if (this.#list) this.#list.style.transform = this.#hold === 0 ? "" : `translateY(${-this.#hold}px)`;
	}

	/** The first rendered row whose bottom is below the viewport's top, and where its top is. */
	#captureAnchor(): void {
		const scroller = this.#scroller;
		const { start, end } = this.#rendered;
		if (!scroller || this.pinned || end < start) {
			this.#anchor = undefined;
			return;
		}
		const top = scroller.getBoundingClientRect().top;
		let low = start;
		let high = end;
		while (low < high) {
			const middle = (low + high) >> 1;
			const key = this.layout.keyAt(middle);
			const element = key === undefined ? undefined : this.#elements.get(key);
			if (element && element.getBoundingClientRect().bottom <= top) low = middle + 1;
			else high = middle;
		}
		const key = this.layout.keyAt(low);
		const element = key === undefined ? undefined : this.#elements.get(key);
		this.#anchor =
			key !== undefined && element
				? {
						key,
						screen: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
						content: this.#contentTop(scroller, element),
					}
				: undefined;
	}

	/**
	 * How far the anchor moved by layout since it was captured. While the reader scrolls, its place in the content: the
	 * browser scrolls on its own thread, so a place on screen read later can include scrolling no scroll event
	 * reported yet, which would read as the layout moving the row. Otherwise its place on screen: nothing scrolls then
	 * but the browser itself, which clamps the scroll position when content near an edge shrinks, and that clamp keeps
	 * what the reader sees (compared in content, it would read as a move and be corrected twice).
	 */
	#moved(scroller: HTMLElement, element: Element, anchor: { screen: number; content: number }): number {
		if (this.#gesture.active) return this.#contentTop(scroller, element) - anchor.content;
		return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.screen;
	}

	/** Where `element` is in the scrolled content: its place on screen plus the scroll position, read together. */
	#contentTop(scroller: HTMLElement, element: Element): number {
		return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
	}

	#capturePosition(): void {
		const top = this.#layoutTop();
		if (top === undefined || this.layout.count === 0) return;
		const index = this.layout.rowAt(top);
		const key = this.layout.keyAt(index);
		if (key !== undefined) this.#position = { key, offset: top - this.layout.offsetOf(index) };
	}

	/** Moves content by `delta` under the reader: written when possible, else held as the rows' transform. */
	#correct(delta: number): void {
		const scroller = this.#scroller;
		if (!scroller) return;
		if (this.#gesture.active && !this.#nearEdge(this.#hold + delta)) {
			this.#hold += delta;
			this.#applyHold();
			return;
		}
		const shift = delta + this.#hold;
		this.#hold = 0;
		this.#applyHold();
		scroller.scrollTop += shift;
		this.#lastScrollTop = scroller.scrollTop;
	}

	/** Writes a held correction: the spacer gets its height back and `scrollTop` moves with it, in one paint. */
	#flushHold(): void {
		const scroller = this.#scroller;
		if (this.#hold === 0 || !scroller) return;
		const shift = this.#hold;
		this.#hold = 0;
		this.#applyHold();
		if (this.pinned) toEnd(scroller);
		else scroller.scrollTop += shift;
		this.#lastScrollTop = scroller.scrollTop;
	}

	/** The reader's scroll ended. */
	#settled(): void {
		this.#following = false;
		this.#flushHold();
		if (this.pinned && this.#scroller) toEnd(this.#scroller);
		this.#captureAnchor();
		this.#capturePosition();
		this.#updateRange();
		this.#updateBottom();
	}

	/** After any layout change: place the spacers, then keep the anchor where it was (or the end, when pinned). */
	#sync(): void {
		const scroller = this.#scroller;
		if (!scroller) return;
		this.#viewport = scroller.clientHeight;
		const width = this.#list?.clientWidth ?? this.#width;
		if (width !== this.#width) {
			// Estimates depend on the width (measured heights are kept: they are closer than any estimate).
			this.#width = width;
			this.layout.invalidate();
		}
		this.#setSpacers();
		let moved = true;
		if (this.#target) {
			// The reveal steers the scroll position; it runs per frame.
		} else if (this.pinned) {
			if (!this.#gesture.active) toEnd(scroller);
		} else if (this.#anchor && !NATIVE_ANCHORING) {
			const element = this.#elements.get(this.#anchor.key);
			if (element?.isConnected) {
				const delta = this.#moved(scroller, element, this.#anchor);
				// Sub-pixel noise keeps the old anchor, so small shifts that add up are still corrected.
				if (Math.abs(delta) >= 0.5) this.#correct(delta);
				else moved = false;
			}
		}
		if (moved) this.#captureAnchor();
		this.#capturePosition();
		this.#updateRange();
		this.#updateBottom();
		if (!this.#resizing) this.#loadEarlier(false);
	}

	#resized(entries: ResizeObserverEntry[]): void {
		this.#resizing = true;
		try {
			this.#measured(entries);
		} finally {
			this.#resizing = false;
		}
	}

	#measured(entries: ResizeObserverEntry[]): void {
		for (const entry of entries) {
			const element = entry.target as HTMLElement;
			const key = element.dataset.row;
			if (key === undefined || this.#elements.get(key) !== element) continue;
			const size = entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
			this.#measure(key, size);
		}
		this.#sync();
	}

	/** The rows' width, for estimates (before the list is laid out, a guess that is never measured against). */
	#rowWidth(): number {
		return this.#width || this.#list?.clientWidth || 600;
	}

	/** Records a row's height; a row measured for the first time teaches the estimates. */
	#measure(key: string, size: number): void {
		const first = !this.layout.measured(key);
		if (!this.layout.measure(key, size) || !first) return;
		const index = this.layout.indexOf(key);
		const row = index === undefined ? undefined : this.#rows[index];
		if (row) this.#estimates.measured(row, this.#rowWidth(), size);
	}

	#scrolled = (): void => {
		const scroller = this.#scroller;
		if (!scroller) return;
		this.#gesture.scrolled();
		const top = scroller.scrollTop;
		const down = top > this.#lastScrollTop;
		// The browser moving the position up by a pixel without the reader is a clamp (the content's end came up by a
		// rounding difference, as when a glide ends), not the reader leaving the bottom: by the time its event arrives,
		// content may have grown again (a thought streaming in), so it would read as a move away from the bottom.
		const clamped = !down && !this.#gesture.active && this.#lastScrollTop - top < 2;
		this.#lastScrollTop = top;
		const bottom = isBottom(scroller) || clamped;
		// Pi Mobile's rule: reaching the bottom while scrolling down follows the answer; anything else stops.
		if (!this.#target && !this.#following) this.pinned = bottom ? this.pinned || down : this.pinned && down;
		// A held correction pushes its amount of content past an edge, out of reach: a reader scrolling into that
		// edge would be stopped there until the scroll settles. Near it, it is written (see `#nearEdge`).
		if (this.#hold !== 0 && this.#nearEdge(this.#hold)) this.#flushHold();
		this.#captureAnchor();
		this.#capturePosition();
		this.#updateRange();
		this.#updateBottom();
		this.#loadEarlier(true);
	};

	/**
	 * Whether a hold of `hold` would push content past the edge the viewport is within half a viewport of: a positive
	 * hold translates the rows up (past the top), a negative one down (past the bottom). Such a hold is written even
	 * while the reader scrolls: the scroll is about to stop at the edge anyway. Not while a finger is down (iOS ignores
	 * the write) or the scroll bounces past the edge (the rubber band).
	 */
	#nearEdge(hold: number): boolean {
		const scroller = this.#scroller;
		if (!scroller || this.#gesture.pressed || hold === 0) return false;
		const distance = hold > 0 ? fromStart(scroller) : fromEnd(scroller);
		return distance >= 0 && distance < scroller.clientHeight / 2;
	}

	/**
	 * Loads older history while the reader is within `PREFETCH` viewports of the loaded start; following the answer at
	 * the bottom, while less than a viewport of history is above it, so there is always something to scroll back to.
	 * (A turn's many tool calls are one row: a page of them can add next to no height, and without this a short
	 * transcript would show only that row under "Earlier messages", with nothing to scroll.) A scroll asks for it; a
	 * layout change (a page arrived) asks again only when the last page added to the loaded history, so a failing load
	 * is not retried in a loop.
	 */
	#loadEarlier(scrolled: boolean): void {
		const scroller = this.#scroller;
		if (!scroller || !this.history?.more || this.history.loading) return;
		const size = this.history.size ?? this.layout.count;
		if (!scrolled && size === this.#earlierSize) return;
		const top = this.#layoutTop();
		if (top === undefined || top >= scroller.clientHeight * (this.pinned ? 1 : PREFETCH)) return;
		this.#earlierSize = size;
		this.onEarlier?.();
	}

	/** The finger or mouse lifted at the bottom: follow the answer again. */
	#release(): void {
		const element = this.#scroller;
		if (this.pinned || !element || !isBottom(element)) return;
		this.pinned = true;
		this.#anchor = undefined;
		this.#updateBottom();
	}

	/** One step of a reveal: moves the target toward the viewport's center until it stays there two frames. */
	#steer(): void {
		const target = this.#target;
		const scroller = this.#scroller;
		const index = target && this.layout.indexOf(target.key);
		if (!target || !scroller || index === undefined) {
			this.#target = undefined;
			return;
		}
		const view = scroller.getBoundingClientRect();
		const visible = scroller.clientHeight - (Number.parseFloat(scroller.style.paddingBottom) || 0);
		const element = this.#elements.get(target.key);
		let delta: number;
		if (element?.isConnected) {
			const rect = element.getBoundingClientRect();
			delta = rect.top - view.top - Math.max(0, (visible - rect.height) / 2);
		} else {
			const top = this.#layoutTop() ?? 0;
			const size = this.layout.sizeOf(index);
			delta = this.layout.offsetOf(index) - top - Math.max(0, (visible - size) / 2);
		}
		// The ends of the list cannot be centered: stop where the scroll position stops.
		const before = scroller.scrollTop;
		if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
		const settled = Math.abs(delta) < 1 || scroller.scrollTop === before;
		this.#lastScrollTop = scroller.scrollTop;
		target.stable = settled && element?.isConnected ? target.stable + 1 : 0;
		target.frames++;
		this.#updateRange();
		if (target.stable >= 2 || target.frames > 60) {
			this.#target = undefined;
			this.#captureAnchor();
			this.#capturePosition();
			this.#updateRange();
			this.#updateBottom();
			this.#flash(target.key, target.entryId);
			return;
		}
		requestAnimationFrame(() => {
			if (this.#target === target) this.#steer();
		});
	}

	#flash(key: string, entryId: number): void {
		const row = this.#elements.get(key);
		const element = row?.querySelector<HTMLElement>(`[data-entry="${entryId}"]`) ?? row;
		if (!element) return;
		element.classList.remove("flash");
		void element.offsetWidth; // restart the animation
		element.classList.add("flash");
	}
}

/**
 * The transcript's scroll controller for React: `rows` are rendered as `range` (see `Messages`), `cache` names the
 * conversation whose measured row heights are kept. Without rows it only keeps room for the composer dock.
 */
export function useChatScroll<Row extends ListRow>(
	options: {
		cache?: string;
		rows?: readonly Row[];
		estimates?: RowEstimates<Row>;
		history?: { more: boolean; loading: boolean; size?: number };
		onEarlier?: () => void;
	} = {},
) {
	const [scroll] = useState(() => new TranscriptScroll());
	scroll.history = options.history;
	scroll.onEarlier = options.onEarlier;
	useSyncExternalStore(scroll.subscribe, scroll.snapshot);
	const rows = options.rows ?? NO_ROWS;
	const range = scroll.prepare(
		options.cache,
		rows,
		(options.estimates as RowEstimates<ListRow> | undefined) ?? NO_ESTIMATES,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: new rows in the same range move the anchor too.
	useLayoutEffect(() => scroll.committed(range), [scroll, range, rows]);
	return {
		scroller: scroll.scrollerRef,
		dock: scroll.dockRef,
		atBottom: scroll.atBottom,
		toBottom: scroll.toBottom,
		list: scroll,
		range,
	};
}
