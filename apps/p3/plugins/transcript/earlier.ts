// The entries before a transcript view's window, loaded on request ("Load earlier") through `entries`, newest last.
// Durable's window drops its oldest entries in one splice once it holds too many; when entries were loaded before it,
// the ones it dropped are fetched too, so nothing a person loaded disappears from between them.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/p3/v1";
import type { ConversationView, EntryRecord } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";

/** What `Transcript`'s `entries` answers: a page of entries, newest last, and whether more lie before it. */
export type EntriesPage = { readonly items: readonly EntryRecord[]; readonly more: boolean };

/** The query `entries` takes (the transcript contract's `EntriesQuery`). */
export type EntriesQuery = { readonly minEntryId?: number; readonly maxEntryId?: number; readonly limit: number };

/** A reader of the transcript's older entries. */
export type EntriesReader = (query: EntriesQuery, context: Context) => Promise<EntriesPage>;

/** The entries loaded before the window, whether more lie before them, and the load's state. */
export type Earlier = {
	readonly entries: readonly EntryRecord[];
	readonly more: boolean;
	readonly loading: boolean;
	readonly error: string | undefined;
	load(): void;
};

/** The entries before `view`'s window as far as loaded, read through `read`. */
export function useEarlier(read: EntriesReader | undefined, view: ConversationView | undefined): Earlier {
	const [loaded, setLoaded] = useState<{ readonly entries: readonly EntryRecord[]; readonly more: boolean }>(NONE);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const newest = loaded.entries.at(-1)?.id;
	const before = view?.before;
	useEffect(() => {
		if (read === undefined || newest === undefined || before === undefined || before <= newest) return;
		let current = true;
		void between(read, newest + 1, before, BACKGROUND_CONTEXT).then(
			(items) => current && setLoaded((last) => ({ ...last, entries: [...last.entries, ...items] })),
			(failure: unknown) => current && setError(described(failure)),
		);
		return () => {
			current = false;
		};
	}, [read, newest, before]);
	const oldest = loaded.entries[0]?.id ?? before;
	return {
		entries: loaded.entries,
		more: loaded.entries.length === 0 ? before !== undefined : loaded.more,
		loading,
		error,
		load: () => {
			if (read === undefined || oldest === undefined || loading) return;
			setLoading(true);
			setError(undefined);
			// The first page ends with the entry right before the window (`before`), a later one before the oldest loaded.
			const maxEntryId = loaded.entries.length === 0 ? oldest : oldest - 1;
			read({ maxEntryId, limit: PAGE }, BACKGROUND_CONTEXT).then(
				(page) => {
					setLoading(false);
					setLoaded((last) => ({ entries: [...page.items, ...last.entries], more: page.more }));
				},
				(failure: unknown) => {
					setLoading(false);
					setError(described(failure));
				},
			);
		},
	};
}

/** Nothing loaded yet. */
const NONE = { entries: [], more: false } as const;

/** How many entries "Load earlier" loads at once. */
const PAGE = 50;

/** Every entry from `min` to `max` (both included), newest last, read a page at a time from the newest. */
async function between(read: EntriesReader, min: number, max: number, context: Context): Promise<EntryRecord[]> {
	const items: EntryRecord[] = [];
	let top = max;
	for (;;) {
		const page = await read({ minEntryId: min, maxEntryId: top, limit: 100 }, context);
		items.unshift(...page.items);
		const first = page.items[0];
		if (!page.more || first === undefined || first.id <= min) return items;
		top = first.id - 1;
	}
}

/** A failure as one line. */
function described(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
