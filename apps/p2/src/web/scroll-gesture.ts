/**
 * Whether the reader is moving a scroll area right now: a finger or the mouse is down on it, or the scroll it started
 * (a fling's momentum, the wheel's smooth scroll) is still running. While it is, the transcript must not write
 * `scrollTop`: iOS ignores a write under a finger and stops a fling's momentum on one, and a write cancels the wheel's
 * smooth scroll in desktop browsers. Corrections wait, held in the layout instead (see use-chat-scroll.ts), until the
 * scroll settles. Modeled on TanStack Virtual's iOS gesture tracking (`ios-gesture.ts`), applied on every platform.
 *
 * After the input ends, a tail stays open while scroll events keep coming: momentum fires scroll events but no touch
 * events, so each one re-arms the tail, which closes `SETTLE_MS` after the last one. The slow end of a fling can move
 * less than a pixel per event, so a tail whose area still moved since the last event stays open.
 */
export const SETTLE_MS = 150;

export class ScrollGesture {
	#down = false;
	#tail: ReturnType<typeof setTimeout> | undefined;
	readonly #settled: () => void;
	readonly #moving: () => boolean;

	/**
	 * `settled`: the scroll ended, a write is possible again. `moving`: whether the area moved since the last scroll
	 * event (a fling slower than one event per `SETTLE_MS`).
	 */
	constructor(settled: () => void, moving: () => boolean = () => false) {
		this.#settled = settled;
		this.#moving = moving;
	}

	/** Whether the reader moves the area (writes must wait). */
	get active(): boolean {
		return this.#down || this.#tail !== undefined;
	}

	/** Whether a finger or the mouse is down on the area. */
	get pressed(): boolean {
		return this.#down;
	}

	/** A finger or the mouse went down on the area. */
	press(): void {
		this.#close();
		this.#down = true;
	}

	/** It lifted: the momentum it started runs in the tail. */
	lift(): void {
		if (!this.#down) return;
		this.#down = false;
		this.#open();
	}

	/** A wheel step (or a programmatic smooth scroll): its animation runs in the tail. */
	wheel(): void {
		if (!this.#down) this.#open();
	}

	/** A scroll event: momentum keeps an open tail open. Events without input before them (our writes) open none. */
	scrolled(): void {
		if (this.#tail !== undefined) this.#open();
	}

	dispose(): void {
		this.#close();
		this.#down = false;
	}

	#open(): void {
		this.#close();
		this.#tail = setTimeout(() => {
			this.#tail = undefined;
			if (this.#moving()) {
				this.#open();
				return;
			}
			if (!this.#down) this.#settled();
		}, SETTLE_MS);
	}

	#close(): void {
		if (this.#tail !== undefined) clearTimeout(this.#tail);
		this.#tail = undefined;
	}
}
