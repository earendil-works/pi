// A working wheel's latest thought, in a slot below the wheel (ActivityRow), and the space it hands to the row after it.
//
// Problem: the thought used to show above the wheel only while a call ran, so it appeared and vanished with every
// thought, moving the wheel and everything below it each time; the answer then arrived below while the preview vanished
// above. Below the wheel, nothing above it moves, and the note or answer can take the thought's place.
//
// - While the wheel works the slot shows its newest thought, also while it streams, in at most three lines that scroll:
//   the newest show (the words glide up as they grow) until the reader scrolls up to read on. The slot only grows: a
//   shorter thought keeps the taller space, its words on the first line. The next thought replaces the words in
//   sequence: the old fade out, then the new fade in.
// - Once the wheel is done the slot hands off: its words fade out and it leaves the layout, while the row after it (the
//   note or answer) starts where the thought was and is at least as tall as the slot was (`handoff`), so the turn's
//   height does not change; that row's content fades in as the thought fades out (`.row[data-handoff]`). The space it
//   does not need goes once another row follows it (which takes the space) or, closing smoothly, when the turn ends.
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { SparkIcon } from "./icons.tsx";
import { type ChatItem, plainText, type Words } from "./model.ts";

/** The largest height each wheel's slot reached, by row key: kept across remounts and handed to the next row. */
export type SlotHeights = Map<string, number>;

/** The transcript's slot heights (`Messages`); a wheel outside a transcript keeps its own. */
export const SlotHeightsContext = createContext<SlotHeights | undefined>(undefined);

/**
 * The minimum height of a transcript row taking a finished wheel's place: the wheel's slot height while the turn runs,
 * 0 (closing smoothly) once it ended; none unless it is the last row after a wheel that showed a thought.
 */
export function handoff(
	heights: SlotHeights,
	before: { readonly item: ChatItem } | undefined,
	last: boolean,
	working: boolean,
): number | undefined {
	if (!last || before?.item.type !== "activity" || before.item.working) return;
	const height = heights.get(before.item.key);
	if (!height) return;
	return working ? height : 0;
}

/** The slot below a wheel: `thought` while it works (`wheelThought`), the handoff once it is done. */
export function ThoughtSlot({ rowKey, thought, working }: { rowKey: string; thought?: Words; working: boolean }) {
	const shared = useContext(SlotHeightsContext);
	const [own] = useState<SlotHeights>(() => new Map());
	const heights = shared ?? own;
	const element = useRef<HTMLDivElement>(null);
	const slot = useRef<Slot>(undefined);
	useLayoutEffect(() => {
		if (!element.current) return;
		const made = new Slot(element.current, rowKey, heights);
		slot.current = made;
		return () => made.dispose();
	}, [rowKey, heights]);
	useLayoutEffect(() => {
		slot.current?.update(thought, working);
	}, [thought, working]);
	return (
		<div ref={element} className="activity-slot" data-testid="activity-slot" aria-hidden="true">
			<div className="activity-slot-content">
				<span className="activity-slot-icon">
					<SparkIcon />
				</span>
				<div className="activity-slot-window">
					{/* Its words are written by `Slot`: they change in step with the fades, not with each render. */}
					<span className="activity-slot-words" data-testid="activity-slot-words" />
				</div>
			</div>
		</div>
	);
}

/** How long words fade out before others come in; `.activity-slot-content.hidden` and `.row[data-handoff]` match. */
const FADE_OUT = 160;

/**
 * A thought's words as the slot shows them: without the blank lines around and between its paragraphs (a model's
 * summaries end in "\n\n" and separate their parts with them, which in three lines would push the words out of view),
 * and without Markdown's markers.
 */
const slotWords = (text: string): string => plainText(text.trim().replace(/\n\s*\n/g, "\n"));

/** The slot's words, height and handoff, kept in step with the fades (React renders its structure once). */
class Slot {
	readonly #element: HTMLDivElement;
	readonly #content: HTMLElement;
	readonly #window: HTMLElement;
	readonly #words: HTMLElement;
	readonly #key: string;
	readonly #heights: SlotHeights;
	#height: number;
	/** The id of the thought shown. */
	#shown: string | undefined;
	/** The thought to show once the words shown have faded out. */
	#next: Words | undefined;
	#fading: number | undefined;
	#handedOff = false;
	/** The reader scrolled the words up: they stay where the reader put them until scrolled back to the end. */
	#reading = false;
	readonly #release: () => void;

	constructor(element: HTMLDivElement, key: string, heights: SlotHeights) {
		this.#element = element;
		this.#content = element.querySelector<HTMLElement>(".activity-slot-content")!;
		this.#window = element.querySelector<HTMLElement>(".activity-slot-window")!;
		this.#words = element.querySelector<HTMLElement>(".activity-slot-words")!;
		this.#key = key;
		this.#heights = heights;
		this.#height = heights.get(key) ?? 0;
		element.style.height = `${this.#height}px`;
		// Only the reader's input leaves the end (the slot's own scrolling never does); reaching it again follows again.
		const read = () => {
			this.#reading = true;
		};
		const scrolled = () => {
			if (this.#atEnd()) this.#reading = false;
			this.#edges();
		};
		const area = this.#window;
		area.addEventListener("wheel", read, { passive: true });
		area.addEventListener("touchmove", read, { passive: true });
		area.addEventListener("scroll", scrolled, { passive: true });
		this.#release = () => {
			area.removeEventListener("wheel", read);
			area.removeEventListener("touchmove", read);
			area.removeEventListener("scroll", scrolled);
		};
	}

	update(thought: Words | undefined, working: boolean): void {
		if (!working) {
			this.#handOff();
			return;
		}
		if (!thought) return;
		if (this.#fading !== undefined || (this.#shown !== undefined && thought.id !== this.#shown)) {
			this.#next = thought;
			this.#fadeToNext();
			return;
		}
		this.#show(thought, this.#shown !== undefined);
	}

	/** Another thought: the words shown fade out, then the newest thought fades in in their place. */
	#fadeToNext(): void {
		if (this.#fading !== undefined) return;
		this.#content.classList.add("hidden");
		this.#fading = window.setTimeout(() => {
			this.#fading = undefined;
			const next = this.#next;
			this.#next = undefined;
			if (next) this.#show(next, false);
			this.#content.classList.remove("hidden");
		}, FADE_OUT);
	}

	/**
	 * Shows `thought` and grows the slot to fit. Its newest line shows unless the reader scrolled up; `smooth`: the words
	 * glide up as they grow, else (another thought) they start at their end at once.
	 */
	#show(thought: Words, smooth: boolean): void {
		if (thought.id !== this.#shown) this.#reading = false;
		this.#shown = thought.id;
		this.#content.classList.toggle("live", thought.live);
		this.#words.textContent = slotWords(thought.text);
		const end = this.#window.scrollHeight - this.#window.clientHeight;
		const glide = smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (!this.#reading) this.#window.scrollTo({ top: end, behavior: glide ? "smooth" : "instant" });
		this.#edges();
		const height = Math.max(this.#height, this.#content.offsetHeight);
		if (height === this.#height) return;
		this.#height = height;
		this.#heights.set(this.#key, height);
		this.#element.style.height = `${height}px`;
	}

	#atEnd(): boolean {
		return this.#window.scrollTop >= this.#window.scrollHeight - this.#window.clientHeight - 2;
	}

	/** Fades the edge with more words beyond it. */
	#edges(): void {
		this.#window.classList.toggle("more-above", this.#window.scrollTop > 1);
		this.#window.classList.toggle("more-below", !this.#atEnd());
	}

	/**
	 * The wheel is done: the words fade out where they are, drawn over the start of the next row, which took the slot's
	 * space (`handoff`) in this same commit.
	 */
	#handOff(): void {
		if (this.#handedOff) return;
		this.#handedOff = true;
		clearTimeout(this.#fading);
		this.#fading = undefined;
		this.#content.classList.add("hidden");
		this.#element.classList.add("handed-off");
		this.#element.style.height = "0px";
	}

	dispose(): void {
		clearTimeout(this.#fading);
		this.#release();
	}
}
