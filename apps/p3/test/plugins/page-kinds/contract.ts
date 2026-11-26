// Two kinds of thing for the page's tests only: a note with no view of its own (it opens in the Settings view) whose
// new links give everyone Read and the agents Write, and a wall whose view takes the whole page.

import { defineMessages, defineThing } from "@earendil-works/p3/v1";

/** The kinds' texts: their ticks' labels, the wall's title and the plugin's. */
export const messages = defineMessages("page-kinds", {
	en: { read: "Read", write: "Write", note: "Note", wall: "Wall", plugin: "Page kinds" },
});

/** A note: no view; Read and Write as ticks, given at a new link to everyone (Read) and the agents (Write). */
export const NoteKind = defineThing("page-kinds.note", {
	version: 1,
	makers: "anyone",
	ticks: { read: { label: messages.message("read") }, write: { label: messages.message("write") } },
	defaultGrants: { everyone: ["read"], agents: ["write"] },
});

/** A wall: a view that takes the whole page. */
export const WallKind = defineThing("page-kinds.wall", {
	version: 1,
	makers: "anyone",
	ticks: { look: { label: messages.message("read") } },
});
