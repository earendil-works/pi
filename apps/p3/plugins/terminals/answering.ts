// Who answers a terminal's queries: a program asks its terminal (device attributes, the cursor's position) and every
// page drawing it could answer; two answering would type each answer twice (Opus, Astra, round 1, S2). One viewer per
// terminal does: the one that typed last, else the first that may type, else none. A viewer is told when it starts or
// stops answering; its page applies that from the output byte the socket names (`at`), so a page that draws late
// answers the output it drew as it was then (Astra, round 2, S1). A page's answers are not typing: they never move the
// election. A viewer that loses Use keeps answering until the next election (one comes, goes or types): the page makes
// a new connection when Use changes, which is such an election.

/** One viewer as the election sees it: whether it may type now, and how it is told whether it answers. */
export type Answerer = { readonly typable: () => boolean; readonly answer: (yes: boolean) => void };

/** One terminal's viewers and the one that answers its queries. */
export class Answering {
	readonly #all = new Set<Answerer>();
	#answering: Answerer | undefined;

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
		if (before !== undefined && this.#all.has(before)) before.answer(false);
		this.#answering?.answer(true);
	}
}
