// The todo app's API, version 1, for every host kind (`@todo/app/v1`): the part of Chord its plugins use, `defineFacet`
// typed with the app's principals, and the app's host kind (a list, one worker each). Plugins import this module, never
// Chord: their builds leave it out and each process passes its own instance in.

import {
	defineFacet as chordFacet,
	type FacetHost,
	type FacetSelf,
	hostKind,
	str,
} from "../../../../../../src/index.ts";
import type { TodoPrincipal } from "../../principals.ts";

export { BACKGROUND_CONTEXT } from "../../../../../../src/context/index.ts";
export {
	arr,
	bool,
	type Ctx,
	defineMessages,
	defineState,
	defineTable,
	eq,
	forbidden,
	int,
	invalid,
	local,
	MessageSchema,
	type MessagesOf,
	method,
	nul,
	num,
	obj,
	PluginError,
	query,
	remote,
	type Static,
	str,
	type Theme,
	Themes,
	type Translation,
	Translations,
	union,
} from "../../../../../../src/index.ts";
export type { TodoPrincipal } from "../../principals.ts";

/** Defines a facet of the todo app: its factories get the app's principals. */
export function defineFacet(setup: (host: FacetHost<TodoPrincipal>, self: FacetSelf) => void) {
	return chordFacet<TodoPrincipal>(setup);
}

/** A todo list: a worker process of its own, with its own store. */
export const List = hostKind("list", { id: str() });
