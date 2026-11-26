// The notes plugin's contract: notebooks as a kind of thing (`notes.notes`, content: a writer of a session or its
// agent makes one there), and one notebook in a session as its members and its agent see it (`Notes`). A notebook is
// a thing (its id, name and owner the sessions plugin's); its notes live on the server, keyed by the thing's id, so a
// notebook kept and used in two sessions shows the same notes there.

import {
	arr,
	bool,
	defineThing,
	grantable,
	lit,
	method,
	num,
	obj,
	remote,
	Server,
	type Static,
	str,
	thingAdmission,
	union,
} from "@earendil-works/p3/v1";

/** A notebook in a session; `edit: false` leaves whoever it applies to (a member, the agent) reading only. */
export const NotesKind = defineThing("notes.notes", {
	version: 1,
	options: obj({ edit: bool() }),
	initial: { edit: true },
});

/**
 * Who wrote a note last: a person (the owner too; their name as the people plugin has it now), or an agent (which
 * session's is implicit: the notebook's use there).
 */
export const Author = union([obj({ kind: lit("person"), id: str(), name: str() }), obj({ kind: lit("agent") })]);

/** Who wrote a note last (see `Author`). */
export type Author = Static<typeof Author>;

/** A note's text: 1 to 10,000 characters. */
export const NoteText = str({ min: 1, max: 10_000 });

/** A note: its id in its notebook, its text, when it was written last (ms since the epoch) and by whom. */
export const Note = obj({ id: str(), text: str(), at: num(), author: Author });

/** A note (see `Note`). */
export type Note = Static<typeof Note>;

/**
 * One notebook of a session (`thing`: the thing's id, a thing of `NotesKind` the session has), for its members and its
 * agent: the notes, and for an editor (who writes in the session and whose options say `edit`) adding, editing and
 * removing them.
 */
export const Notes = remote("notes.notes", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(NotesKind),
	// The notebook's name (its thing's; none: its kind's title), its notes loaded so far, the last written first, and
	// `more` for the next page; an editor is also granted `add`, `edit` and `remove` (`NOTES_EDITS`).
	state: { name: str(), list: obj({ rows: arr(Note), moreAfter: bool() }) },
	methods: {
		more: method(),
		/** Adds a note; answers its id. */
		add: grantable(method(obj({ text: NoteText }), str())),
		/** Replaces a note's text: it is written now, by the caller. */
		edit: grantable(method(obj({ id: str(), text: NoteText }))),
		remove: grantable(method(obj({ id: str() }))),
	},
});

/** What an editor of a notebook is granted. */
export const NOTES_EDITS = ["add", "edit", "remove"] as const;
