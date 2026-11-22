// The notes test plugin's contract: a kind of thing whose records are each person's own notes (a stand-in for a
// mail account or a calendar), and one note as a session's members see it, admitted by `admitThing`.

import { defineThingKind, obj, oneOf, remote, Server, str, thingAdmission } from "@earendil-works/p3/v1";

/** Notes in a colour: each person has their own (record `person:<id>`), the owner theirs (`owner`). */
export const NotesKind = defineThingKind("notes.notes", {
	version: 1,
	options: obj({ color: str() }),
	initial: { color: "red" },
});

/** One thing of `NotesKind` in a session, as the caller gets it: whose notes, their colour, the caller's access. */
export const Note = remote("notes.note", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(NotesKind),
	variants: {
		reader: { state: { ref: str(), color: str(), access: oneOf("read", "write") } },
		writer: { state: { ref: str(), color: str(), access: oneOf("read", "write") } },
	},
});
