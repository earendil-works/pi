// The checklist kind: its options, an item, and the object people and the agent use. A checklist is content (a writer
// of a session or its agent makes one there); its items live on the server, keyed by the thing's id.

import {
	arr,
	bool,
	defineThing,
	grantable,
	method,
	obj,
	remote,
	Server,
	type Static,
	str,
	thingAdmission,
} from "@earendil-works/p3/v1";

/** A checklist; one option: whether a writer may tick items (and add them). */
export const ChecklistKind = defineThing("checklist.checklist", {
	version: 1,
	options: obj({ check: bool() }),
	initial: { check: true },
});

/** An item's text: 1 to 500 characters. */
export const ItemText = str({ min: 1, max: 500 });

/** An item of a checklist: its id, its text, and whether it is done. */
export const Item = obj({ id: str(), text: ItemText, done: bool() });

/** An item of a checklist (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * One checklist (`thing`: its id) in one session, for one caller: a reader sees its items (at most 500, in the order
 * they were added), a checker (who writes and whose options say `check`) also adds and ticks them.
 */
export const Checklist = remote("checklist.checklist", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(ChecklistKind),
	state: { items: arr(Item) },
	// A checker's (`CHECKLIST_CHECKS`).
	methods: {
		/** Adds an item, not done; answers its id. Refused once the checklist holds 500 items. */
		add: grantable(method(obj({ text: ItemText }), str())),
		/** Marks item `id` done or not. */
		tick: grantable(method(obj({ id: str(), done: bool() }))),
	},
});

/** What a checker of a checklist is granted. */
export const CHECKLIST_CHECKS = ["add", "tick"] as const;
