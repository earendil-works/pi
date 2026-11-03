// The lists plugin's contract: a list's todos as one principal sees them, on the list's worker. Its facets of every
// kind import it, and so do code and tests outside the plugin (they resolve `@todo/app/v1` as plugins do).

import { arr, bool, int, List, method, num, obj, remote, type Static, str } from "@todo/app/v1";

/** A todo: its number in the list, its text, whether it is done, who added it and when. */
export const Item = obj({ id: int(), text: str(), done: bool(), by: str(), at: num() });

/** A todo (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * A list's todos as one principal sees them: the newest 50 (live), adding one and ticking one off (or on again); the
 * owner also clears the done ones.
 */
export const Todos = remote("todo.todos", {
	version: 1,
	params: { list: str() },
	hostAddress: ({ list }) => List({ id: list }),
	variants: {
		member: {
			state: { items: arr(Item) },
			methods: { add: method(str()), tick: method(obj({ id: int(), done: bool() })) },
		},
		owner: {
			state: { items: arr(Item) },
			methods: { add: method(str()), tick: method(obj({ id: int(), done: bool() })), clear: method() },
		},
	},
});
