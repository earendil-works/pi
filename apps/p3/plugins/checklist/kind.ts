// The checklist kind (`checklist.checklist`): checklists, items with a done mark. Anyone, people and agents, may make
// one; it may be linked in any number of workspaces, its items, keyed by the thing's id, the same in each. Reading is
// for everyone let in; the tick Add adds items, the tick Tick marks them done or not. A new link starts with both for
// everyone there and Tick for the agents; a Read share's guests read. It has no settings.

import { arr, bool, method, obj, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** An item's text: 1 to 500 characters. */
export const ItemText = str({ min: 1, max: 500 });

/** An item of a checklist: its id, its text, and whether it is done. */
export const Item = obj({ id: str(), text: ItemText, done: bool() });

/** An item of a checklist (see `Item`). */
export type Item = Static<typeof Item>;

/** How many items a checklist holds at most: its readers read them whole. */
export const MAX_ITEMS = 500;

/**
 * A checklist: its name (its thing's, "" while it has none) and its items (at most `MAX_ITEMS`, in the order they were
 * added), both for everyone let in. Add gives `addItem`, Tick gives `setDone`. A new link starts with both for everyone
 * there and Tick for the agents; a Read share's guests read.
 */
export const ChecklistKind = defineThing("checklist.checklist", {
	version: 1,
	makers: "anyone",
	state: { name: str(), items: arr(Item) },
	methods: {
		/** Adds an item, not done; answers its id. Refused once the checklist holds `MAX_ITEMS` items. */
		addItem: method(obj({ text: ItemText }), str()),
		/** Marks item `id` done or not; refused for an item the checklist does not have. */
		setDone: method(obj({ id: str(), done: bool() })),
	},
	ticks: {
		// Members no tick gives (`name`, `items`) are there for everyone let in: reading.
		add: { label: messages.message("tickAdd"), gives: ["addItem"] },
		tick: { label: messages.message("tickTick"), gives: ["setDone"] },
	},
	defaultGrants: { everyone: ["add", "tick"], agents: ["tick"], guests: [] },
});

/** One checklist held in a workspace: `ChecklistKind`'s contract. */
export const Checklist = ChecklistKind.contract;
