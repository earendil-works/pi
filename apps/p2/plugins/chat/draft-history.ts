// The composer's undo history: drafts (text and caret), not the browser's edit stack. File references are placed,
// moved and removed by rewriting the draft, which the browser's own undo never sees; every undo (keys, the Edit
// menu, iOS's shake) goes through this history instead.

/** A draft and the caret in it (an offset into the text). */
export type DraftStep = { readonly text: string; readonly caret: number };

/** What changed: typing and deleting at the caret coalesce while they continue; anything else is its own step. */
export type ChangeKind = "insert" | "delete" | "edit";

const COALESCE_MS = 1000;
const LIMIT = 200;

/** Undo and redo over the composer's drafts. */
export class DraftHistory {
	#current: DraftStep;
	#past: DraftStep[] = [];
	#future: DraftStep[] = [];
	#last: { kind: ChangeKind; at: number } | undefined;

	constructor(initial: DraftStep) {
		this.#current = initial;
	}

	/** Records the draft after a change; `before` is the caret before it, where undo puts it back. */
	record(step: DraftStep, kind: ChangeKind, before: number, now = Date.now()): void {
		if (step.text === this.#current.text) {
			this.#current = step;
			return;
		}
		const last = this.#last;
		const coalesce =
			kind !== "edit" && last?.kind === kind && now - last.at < COALESCE_MS && before === this.#current.caret;
		if (!coalesce) {
			this.#past.push({ text: this.#current.text, caret: before });
			if (this.#past.length > LIMIT) this.#past.shift();
		}
		this.#current = step;
		this.#future = [];
		this.#last = { kind, at: now };
	}

	/** Moves the caret of the current draft (no change of text): the next change's undo returns here. */
	moved(caret: number): void {
		this.#current = { text: this.#current.text, caret };
	}

	/** The draft before the current one, now current; undefined when there is none. */
	undo(): DraftStep | undefined {
		const step = this.#past.pop();
		if (!step) return undefined;
		this.#future.push(this.#current);
		return this.#settle(step);
	}

	/** The draft undone last, now current again; undefined when there is none. */
	redo(): DraftStep | undefined {
		const step = this.#future.pop();
		if (!step) return undefined;
		this.#past.push(this.#current);
		return this.#settle(step);
	}

	#settle(step: DraftStep): DraftStep {
		this.#current = step;
		this.#last = undefined;
		return step;
	}
}
