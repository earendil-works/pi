// The todo app's API, version 1, for every host kind (`@todo/app/v1`): the part of Chord its plugins use, `defineFacet`
// typed with the app's principals, the app's host kind (a list, one worker each) and its contract for a list's todos.
// Plugins import this module, never Chord: their builds leave it out and each process passes its own instance in.

import {
	arr,
	bool,
	defineFacet as chordFacet,
	type FacetHost,
	type FacetSelf,
	hostKind,
	int,
	method,
	num,
	obj,
	remote,
	type Static,
	str,
} from "../../../../../../src/index.ts";
import type { TodoPrincipal } from "../../principals.ts";

export { BACKGROUND_CONTEXT } from "../../../../../../src/context/index.ts";
export {
	arr,
	bool,
	type Ctx,
	defineTable,
	eq,
	int,
	local,
	method,
	num,
	obj,
	PluginError,
	query,
	str,
	type Theme,
	Themes,
} from "../../../../../../src/index.ts";
export type { TodoPrincipal } from "../../principals.ts";

/** Defines a facet of the todo app: its factories get the app's principals. */
export function defineFacet(setup: (host: FacetHost<TodoPrincipal>, self: FacetSelf) => void) {
	return chordFacet<TodoPrincipal>(setup);
}

/** A todo list: a worker process of its own, with its own store. */
export const List = hostKind("list", { id: str() });

/** A todo: its number in the list, its text, whether it is done, who added it and when. */
export const Item = obj({ id: int(), text: str(), done: bool(), by: str(), at: num() });

/** A todo (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * A list's todos as one principal sees them, on the list's worker: the newest 50 (live), adding one and ticking one
 * off (or on again); the owner also clears the done ones.
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
