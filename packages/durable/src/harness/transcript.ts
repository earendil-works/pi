import type { Context } from "@earendil-works/chord";
import { idFromNumber } from "../ids.ts";
import type { Cursor, EntryId, EntryQuery, EntryRecord, Page } from "../types.ts";
import type { ConversationView, ConversationWindow } from "./view.ts";

/** One row of a client's transcript. */
export type TranscriptItem =
	| { readonly kind: "entry"; readonly entry: EntryRecord }
	/** Entries strictly between `after` and `upTo` are missing: render "load more" and call `fillGap()`. */
	| { readonly kind: "gap"; readonly after: EntryId; readonly upTo: EntryId }
	/** The transcript continues above: render "load earlier" and call `loadEarlier()`. Always the first item. */
	| { readonly kind: "earlier" };

/** The conversation view as a renderer sees it: `items`, the client's whole transcript, instead of the window. */
export type TranscriptView = Omit<ConversationView, "entries" | "before"> & {
	readonly items: readonly TranscriptItem[];
};

/** Pages a conversation's entries, as `Conversation.entries()` does without a cursor. */
export type EntryLoader = (
	query: Omit<EntryQuery, "conversationId">,
	limit: number,
	context: Context,
) => Promise<Page<EntryRecord, Cursor>>;

export type ConversationTranscriptOptions = {
	/** Entries `loadEarlier()` and `fillGap()` load per call; default 50. */
	readonly pageSize?: number;
};

type Gap = Extract<TranscriptItem, { kind: "gap" }>;
type EntryItem = Extract<TranscriptItem, { kind: "entry" }>;

const EARLIER: TranscriptItem = Object.freeze({ kind: "earlier" });

/**
 * What a client has of one conversation: every entry it got from a view or fetched, and the gaps between (spec §9.3).
 * A layer over any `ConversationView`, wherever it comes from: call `merge()` with every value of the view; it returns
 * the view with the client's whole transcript as `items` instead of the window. Entries never change once committed,
 * so the transcript only grows; a window that dropped its oldest entries keeps them here.
 *
 * A window whose `before` lies past the newest entry the client has does not continue it, after a stall, an overflow,
 * or a reconnect: the entries in between become a gap. Nothing counts entries or computes ranges from entry IDs, which
 * have holes; only exclusive bounds are turned into the inclusive bounds of `EntryQuery`. After a drop, a new watch
 * with `resume` as its window continues the transcript.
 *
 * A merge costs O(items) and never re-sorts or re-fetches; a merge, `loadEarlier()`, or `fillGap()` that adds nothing
 * returns the previous `items` array. Concurrent calls of `loadEarlier()`, or of `fillGap()` for the same gap, share one
 * load, so a placeholder that stays visible does not fetch twice.
 */
export class ConversationTranscript {
	readonly #load: EntryLoader;
	readonly #pageSize: number;
	/** Every entry held, in ID order, as items. */
	#entries: EntryItem[] = [];
	readonly #ids = new Set<EntryId>();
	/** Gaps in ID order; each is an immutable item, replaced when it shrinks. */
	#gaps: Gap[] = [];
	/** Whether anything was merged yet. */
	#started = false;
	/** Exclusive lower bound of the known range: entries at or below it are not loaded; `-Infinity` at the start. */
	#low = Number.NEGATIVE_INFINITY;
	/** Inclusive upper bound of the known range: the newest entry, or a later empty window's `before`. */
	#tail = Number.NEGATIVE_INFINITY;
	#items: readonly TranscriptItem[] = [];
	#last: ConversationView | undefined;
	#view: TranscriptView | undefined;
	#earlier: Promise<TranscriptView> | undefined;
	readonly #filling = new Map<string, Promise<TranscriptView>>();

	constructor(load: EntryLoader, options?: ConversationTranscriptOptions) {
		const pageSize = options?.pageSize ?? 50;
		if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
			throw new RangeError(`Page size must be an integer >= 1, got ${pageSize}`);
		}
		this.#load = load;
		this.#pageSize = pageSize;
	}

	/**
	 * The ID the transcript reaches: its newest entry, or the `before` of a later window that was empty. Undefined before
	 * the first merge and for an empty transcript.
	 */
	get newest(): EntryId | undefined {
		return this.#tail === Number.NEGATIVE_INFINITY ? undefined : idFromNumber<EntryId>(this.#tail);
	}

	/**
	 * The window that resumes this transcript after a drop: `{ from }` right after `newest`, so a new watch returns only
	 * what was missed when it fits its window, otherwise its newest entries and a gap; `{}` for an empty transcript;
	 * undefined before the first merge. `conversation.watch(context, transcript.resume)`.
	 */
	get resume(): ConversationWindow | undefined {
		if (!this.#started) return undefined;
		const newest = this.newest;
		return newest === undefined ? {} : { from: idFromNumber<EntryId>(newest + 1) };
	}

	/** Take one value of the view: its window's entries join the transcript. */
	merge(view: ConversationView): TranscriptView {
		this.#last = view;
		const { entries, before } = view;
		const hi = entries.at(-1)?.id ?? before ?? Number.NEGATIVE_INFINITY;
		this.#cover(before ?? Number.NEGATIVE_INFINITY, hi, entries);
		return this.#result();
	}

	/** Load the page before the oldest entry held. Without anything earlier, returns the current view. */
	loadEarlier(context: Context): Promise<TranscriptView> {
		const last = this.#last;
		if (last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
		if (this.#low === Number.NEGATIVE_INFINITY) return Promise.resolve(this.#result());
		if (this.#earlier !== undefined) return this.#earlier;
		const low = this.#low;
		// The loader runs in a later microtask, so even its synchronous throw settles a promise that is already shared.
		const loading = Promise.resolve().then(async () => {
			const query = { maxEntryId: idFromNumber<EntryId>(low), order: "descending" } as const;
			const page = await this.#load(query, this.#pageSize, context);
			const items = [...page.items].reverse();
			const oldest = items[0];
			// No next page, or an empty one: the transcript starts here.
			if (page.next === undefined || oldest === undefined) this.#cover(Number.NEGATIVE_INFINITY, low, items);
			else this.#cover(oldest.id - 1, low, items);
			return this.#result();
		});
		this.#earlier = loading;
		const settled = (): void => {
			if (this.#earlier === loading) this.#earlier = undefined;
		};
		loading.then(settled, settled);
		return loading;
	}

	/**
	 * Load the next page of `gap`, a gap item of `items`, shrinking it from its start, or removing it once nothing is
	 * missing. A gap that has shrunk since loads the gap it became; one that is no longer there returns the current view.
	 */
	fillGap(gap: Gap, context: Context): Promise<TranscriptView> {
		const current =
			this.#gaps.find((each) => each.after === gap.after && each.upTo === gap.upTo) ??
			this.#gaps.find((each) => each.after < gap.upTo && gap.after < each.upTo);
		if (current === undefined) {
			const last = this.#last;
			if (last === undefined) return Promise.reject(new Error("ConversationTranscript: merge a view first"));
			return Promise.resolve(this.#result());
		}
		// Keyed by the gap the call resolved to, so a stale descriptor and the current one share the load.
		const key = `${current.after}:${current.upTo}`;
		const running = this.#filling.get(key);
		if (running !== undefined) return running;
		const filling = Promise.resolve().then(async () => {
			const query = {
				minEntryId: idFromNumber<EntryId>(current.after + 1),
				maxEntryId: idFromNumber<EntryId>(current.upTo - 1),
				order: "ascending",
			} as const;
			const page = await this.#load(query, this.#pageSize, context);
			const newest = page.items.at(-1);
			// No next page, or an empty one: nothing else is missing.
			if (page.next === undefined || newest === undefined) this.#cover(current.after, current.upTo - 1, page.items);
			else this.#cover(current.after, newest.id, page.items);
			return this.#result();
		});
		this.#filling.set(key, filling);
		const settled = (): void => {
			if (this.#filling.get(key) === filling) this.#filling.delete(key);
		};
		filling.then(settled, settled);
		return filling;
	}

	/**
	 * Record that every entry with an ID in (`lo`, `hi`] is known, `added` being those entries in ID order: hold the new
	 * ones, shrink the gaps they fill, extend the known range, and open a gap where the range does not continue it.
	 */
	#cover(lo: number, hi: number, added: readonly EntryRecord[]): void {
		const fresh = added.filter((entry) => !this.#ids.has(entry.id));
		for (const entry of fresh) this.#ids.add(entry.id);
		const held = this.#entries;
		// New entries past every held one: the items grow at their end.
		const appended = fresh.length === 0 || held.length === 0 || fresh[0]!.id > held.at(-1)!.entry.id;
		const items = fresh.map((entry): EntryItem => ({ kind: "entry", entry }));
		if (items.length > 0) this.#entries = appended ? held.concat(items) : mergeById(held, items);
		let rebuild = false;
		if (!this.#started || (held.length === 0 && this.#gaps.length === 0 && lo >= this.#tail)) {
			// The first range, or one after an empty transcript: it is all the client knows.
			rebuild = !this.#started || lo !== this.#low;
			this.#started = true;
			this.#low = lo;
			this.#tail = Math.max(this.#tail, hi);
		} else if (lo > this.#tail) {
			// Past the newest known ID: what lies between is missing.
			const upTo = added[0]?.id ?? lo + 1;
			this.#gaps = [...this.#gaps, gapOf(this.#tail, upTo)];
			this.#tail = hi;
			rebuild = true;
		} else if (hi !== Number.NEGATIVE_INFINITY && hi < this.#low) {
			// Below the oldest known ID: what lies between is missing.
			const upTo = held.find((item) => item.entry.id > hi)?.entry.id ?? this.#low + 1;
			this.#gaps = [gapOf(hi, upTo), ...this.#gaps];
			this.#low = lo;
			rebuild = true;
		} else {
			const gaps = this.#subtract(lo, hi);
			if (gaps !== this.#gaps) {
				this.#gaps = gaps;
				rebuild = true;
			}
			if (lo < this.#low) {
				this.#low = lo;
				rebuild = true;
			}
			if (hi > this.#tail) this.#tail = hi;
		}
		if (rebuild || !appended) this.#items = this.#build();
		else if (items.length > 0) this.#items = this.#items.concat(items);
	}

	/** The gaps without (`lo`, `hi`]; the same array when none changes, as when the range is empty. */
	#subtract(lo: number, hi: number): Gap[] {
		if (hi <= lo) return this.#gaps;
		let changed = false;
		const gaps: Gap[] = [];
		for (const gap of this.#gaps) {
			// Missing: IDs in (after, upTo); known now: IDs in (lo, hi].
			if (hi <= gap.after || lo + 1 >= gap.upTo) {
				gaps.push(gap);
				continue;
			}
			changed = true;
			if (lo > gap.after) {
				const firstKnown = this.#entries.find((item) => item.entry.id > lo)?.entry.id ?? lo + 1;
				gaps.push(gapOf(gap.after, Math.min(gap.upTo, firstKnown)));
			}
			if (hi + 1 < gap.upTo) gaps.push(gapOf(hi, gap.upTo));
		}
		return changed ? gaps : this.#gaps;
	}

	/** Items in ID order: "earlier" until the start is known, then entries with each gap before the entry after it. */
	#build(): TranscriptItem[] {
		const items: TranscriptItem[] = this.#low === Number.NEGATIVE_INFINITY ? [] : [EARLIER];
		const gaps = this.#gaps;
		let next = 0;
		for (const item of this.#entries) {
			while (next < gaps.length && gaps[next]!.after < item.entry.id) items.push(gaps[next++]!);
			items.push(item);
		}
		while (next < gaps.length) items.push(gaps[next++]!);
		return items;
	}

	/** The view with the current items; the previous one when nothing changed. */
	#result(): TranscriptView {
		const last = this.#last!;
		const previous = this.#view;
		if (
			previous !== undefined &&
			previous.items === this.#items &&
			previous.docs === last.docs &&
			previous.conversation === last.conversation
		) {
			return previous;
		}
		this.#view = { conversation: last.conversation, docs: last.docs, items: this.#items };
		return this.#view;
	}
}

function gapOf(after: number, upTo: number): Gap {
	return Object.freeze({ kind: "gap", after: idFromNumber<EntryId>(after), upTo: idFromNumber<EntryId>(upTo) });
}

/** Two ID-ordered item lists merged in one pass. */
function mergeById(left: readonly EntryItem[], right: readonly EntryItem[]): EntryItem[] {
	const merged: EntryItem[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		merged.push(left[i]!.entry.id < right[j]!.entry.id ? left[i++]! : right[j++]!);
	}
	while (i < left.length) merged.push(left[i++]!);
	while (j < right.length) merged.push(right[j++]!);
	return merged;
}
