// The checklist kind (`checklist.checklist`): items with a done mark, and one checklist held in a workspace by a person
// or an agent (`Checklist`, `ChecklistKind`'s contract). Anyone, people and agents, may make one where they may make
// things; its items, keyed by the thing's id, are the same in every workspace it is linked in. Reading is for everyone
// let in; the one tick Write adds and ticks items.

import { arr, bool, method, obj, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** An item's text: 1 to 500 characters. */
export const ItemText = str({ min: 1, max: 500 });

/** An item of a checklist: its id, its text, and whether it is done. */
export const Item = obj({ id: str(), text: ItemText, done: bool() });

/** An item of a checklist (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * A checklist: its name (its thing's; "Checklist" while it has none) and its items (at most 500, in the order they
 * were added), both for everyone let in; Write gives `add` and
 * `tick`. A new link starts with Write for everyone there and the agents; a Read share's guests read.
 */
export const ChecklistKind = defineThing("checklist.checklist", {
	version: 1,
	makers: "anyone",
	workspaces: "many",
	state: { name: str(), items: arr(Item) },
	methods: {
		/** Adds an item, not done; answers its id. Refused once the checklist holds 500 items. */
		add: method(obj({ text: ItemText }), str()),
		/** Marks item `id` done or not; refused for an item the checklist does not have. */
		tick: method(obj({ id: str(), done: bool() })),
	},
	ticks: {
		// The one tick. Members no tick gives (`name`, `items`) are there for everyone let in: reading.
		write: { label: messages.message("tickWrite"), gives: ["add", "tick"] },
	},
	defaultGrants: { everyone: ["write"], agents: ["write"], guests: [] },
});

/** One checklist held in a workspace: `ChecklistKind`'s contract. */
export const Checklist = ChecklistKind.contract;

/** What a writer of a checklist is granted (Write). */
export const CHECKLIST_WRITES = ["add", "tick"] as const;
