// Who answers a terminal's queries: a program asks its terminal (device attributes, the cursor's position) and every
// page drawing it could answer; two answering would type each answer twice (Opus, Astra, round 1, S2). One viewer per
// terminal does: the one that typed last, else the first that may type, else none. A change takes effect at one point
// of the terminal's output, its end when the change is made (`at`): every page applies it there, so a query before it
// is the old one's to answer and one after it the new one's, however late each page draws it (Astra, rounds 2 and 3).
// A page's answers are not typing: they never move the election. A viewer that loses Use keeps answering until the
// next election (one comes, goes or types): the page makes a new connection when Use changes, which is such an
// election. Each viewer's socket tells its changes in order (viewer-socket.ts), none replaced by a later one.

/**
 * One viewer as the election sees it: whether it may type now, and how it is told whether it answers from output
 * offset `at` on.
 */
export type Answerer = { readonly typable: () => boolean; readonly answer: (yes: boolean, at: number) => void };

/** One terminal's viewers and the one that answers its queries. */
export class Answering {
	readonly #all = new Set<Answerer>();
	readonly #end: () => number;
	#answering: Answerer | undefined;

	/** The election of a terminal whose output ends at `end()` now. */
	constructor(end: () => number) {
		this.#end = end;
	}

	/** Whether no viewer is left. */
	get empty(): boolean {
		return this.#all.size === 0;
	}

	/** A viewer came: it answers if none does. */
	add(viewer: Answerer): void {
		this.#all.add(viewer);
		this.#elect(this.#answering);
	}

	/** A viewer went: the next that may type answers if it did. */
	remove(viewer: Answerer): void {
		this.#all.delete(viewer);
		this.#elect(this.#answering === viewer ? undefined : this.#answering);
	}

	/** A viewer typed (a person did, not the page's answers): it answers from now on. */
	typed(viewer: Answerer): void {
		if (this.#answering !== viewer) this.#elect(viewer);
	}

	/** Makes `wanted` the one that answers, else the first that may type, and tells who changed. */
	#elect(wanted: Answerer | undefined): void {
		const before = this.#answering;
		const usable = (viewer: Answerer | undefined) =>
			viewer !== undefined && this.#all.has(viewer) && viewer.typable() ? viewer : undefined;
		this.#answering = usable(wanted) ?? [...this.#all].find((viewer) => viewer.typable());
		if (before === this.#answering) return;
		const at = this.#end();
		if (before !== undefined && this.#all.has(before)) before.answer(false, at);
		this.#answering?.answer(true, at);
	}
}
