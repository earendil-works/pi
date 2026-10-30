// Table helpers for `compose` (slice 8 §1, Q8): a map by key (the first by plugin name wins, duplicates reported) and
// an ordered list; both keep each item's plugin, so a use site reports the contributor of an entry that throws.

import type { ComposeContext, RegistryTable } from "./registry.ts";

/** An item taken from a table, with the contributor it came from. */
export type TableItem<I> = { readonly value: I; readonly plugin: string; readonly type?: string };

/**
 * A map of every entry's keyed items (`entriesOf`, e.g. its routes), in table order: a key taken already is reported
 * through `report` (`compose`'s) naming both plugins, and the first by plugin name keeps it.
 */
export function keyedEntries<C, I>(
	table: RegistryTable<C>,
	entriesOf: (value: C) => Readonly<Record<string, I>> | undefined,
	report: ComposeContext["report"],
): ReadonlyMap<string, TableItem<I>> {
	const map = new Map<string, TableItem<I>>();
	for (const entry of table) {
		const items = entriesOf(entry.value);
		if (items === undefined) continue;
		for (const [key, value] of Object.entries(items)) {
			const taken = map.get(key);
			if (taken !== undefined) {
				report({ message: `"${key}" is contributed twice`, plugins: [taken.plugin, entry.plugin] });
				continue;
			}
			map.set(key, item(value, entry.plugin, entry.type));
		}
	}
	return map;
}

/**
 * Every entry's items (`itemsOf`) in one list: in table order, or sorted by `orderOf` (a phase's index, for example),
 * table order kept among equals.
 */
export function orderedEntries<C, I>(
	table: RegistryTable<C>,
	itemsOf: (value: C) => readonly I[] | undefined,
	orderOf?: (item: I) => number,
): readonly TableItem<I>[] {
	const items: TableItem<I>[] = [];
	for (const entry of table) {
		for (const value of itemsOf(entry.value) ?? []) items.push(item(value, entry.plugin, entry.type));
	}
	// `sort` is stable: equal orders keep table order.
	if (orderOf !== undefined) items.sort((a, b) => orderOf(a.value) - orderOf(b.value));
	return items;
}

function item<I>(value: I, plugin: string, type: string | undefined): TableItem<I> {
	return type === undefined ? { value, plugin } : { value, plugin, type };
}
