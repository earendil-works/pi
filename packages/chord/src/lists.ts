// Short lists an object keeps for its life (an attempt's declarations, a decision's requests, a hold's followed
// members): built without the slack an array grown by `push` reserves. V8 gives an empty array's first `push` room
// for 17 items (152 B), and most of these lists hold none or one; an object with ten of them paid over 1 KiB for
// nothing (the hold-memory bench).

/** No items: the shared empty list such a list starts as; never written. */
export const NO_ITEMS: readonly never[] = [];

/** A list up to this long is copied when an item is added, so it holds exactly its items; a longer one is grown. */
const SHORT = 8;

/**
 * `list` with `item` added, to keep in its place (`list` itself is not used again): an exact copy while it is short,
 * else `list` itself, grown. Only for lists made by `appended` from `NO_ITEMS`.
 */
export function appended<T>(list: readonly T[], item: T): readonly T[] {
	if (list.length === 0) return [item];
	// `concat` makes an array of exactly its length; `[...list, item]` reserves as `push` does.
	if (list.length < SHORT) return list.concat([item]);
	// Past `SHORT` the list is a copy made above: its owner's alone, so it grows in place.
	(list as T[]).push(item);
	return list;
}
