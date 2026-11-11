// A text room's client half (docs/rooms.md): the state the server confirmed, this editor's edits it has not
// confirmed yet, and the text shown, which is the confirmed state with the pending edits replayed on top. Plain data
// and functions over `text.ts`, so it runs in the frame and in tests alike.
import { type ElementId, ElementIdGenerator } from "articulated";
import { applyEdits, editsTo, type TextDoc, type TextEdit } from "../text.ts";

/** One batch this editor sent and the server has not logged back yet. */
type Pending = { readonly n: number; readonly edits: readonly TextEdit[] };

/** A position in the text kept across others' edits: the ID left of it (null: the start). */
export type Cursor = ElementId | null;

/** The client state of one editor of a text room. */
export class TextClient {
	readonly #editor: string;
	readonly #ids: ElementIdGenerator;
	#confirmed: TextDoc;
	#pending: Pending[] = [];
	#current: TextDoc;
	#n: number;

	/** Starts from `doc` (a base) as editor `editor`; `n` is its last batch number (it survives reconnects). */
	constructor(editor: string, doc: TextDoc, n = 0) {
		this.#editor = editor;
		let bunches = 0;
		const prefix = `${editor.slice(0, 8)}${Math.random().toString(36).slice(2, 8)}`;
		this.#ids = new ElementIdGenerator(() => `${prefix}.${(bunches++).toString(36)}`);
		this.#confirmed = doc;
		this.#current = doc;
		this.#n = n;
	}

	/** The text shown: confirmed plus pending. */
	get doc(): TextDoc {
		return this.#current;
	}

	/** Batches sent and not yet logged back. */
	get pending(): readonly Pending[] {
		return this.#pending;
	}

	/** The editor's last batch number. */
	get n(): number {
		return this.#n;
	}

	/** The person changed the text to `next`: the batch to send (undefined: nothing changed). */
	input(next: string): Pending | undefined {
		const edits = editsTo(this.#current, next, (before, count) => this.#ids.generateAfter(before, count));
		if (!edits.length) return undefined;
		const batch = { n: ++this.#n, edits };
		this.#pending.push(batch);
		this.#current = applyEdits(this.#current, edits);
		return batch;
	}

	/** The server logged a batch of `editor`'s (`n`): applied to the confirmed state; this editor's drop from pending. */
	confirm(editor: string, n: number, edits: readonly TextEdit[]): void {
		this.#confirmed = applyEdits(this.#confirmed, edits);
		if (editor === this.#editor) this.#pending = this.#pending.filter((batch) => batch.n > n);
		this.#current = this.#pending.reduce((doc, batch) => applyEdits(doc, batch.edits), this.#confirmed);
	}

	/**
	 * Starts over from a base (a joiner, a reset) that holds this editor's batches up to `mark`: those leave pending, the
	 * others are replayed on it and stay pending.
	 */
	reset(doc: TextDoc, mark: number): void {
		this.#confirmed = doc;
		this.#pending = this.#pending.filter((batch) => batch.n > mark);
		this.#current = this.#pending.reduce((next, batch) => applyEdits(next, batch.edits), doc);
	}

	/** The cursor at `index` of the shown text. */
	cursorAt(index: number): Cursor {
		return this.#current.ids.cursorAt(Math.max(0, Math.min(index, this.#current.text.length)));
	}

	/** Where `cursor` is in the shown text now; undefined when its ID is not known here (yet). */
	indexOf(cursor: Cursor): number | undefined {
		if (cursor !== null && !this.#current.ids.isKnown(cursor)) return undefined;
		return this.#current.ids.cursorIndex(cursor);
	}
}
