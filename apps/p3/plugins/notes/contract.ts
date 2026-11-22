// The notes plugin's contract: notebooks as a kind of thing (`notes.notes`), and one notebook in a session as its
// members and its agent see it (`Notes`). A notebook is a person's own (record `person:<id>`, the owner's too)
// and lives on the server across sessions: the same notebook brought into two sessions shows the same notes. A thing
// of the kind without a record (an app's `thingOf(NotesKind)`) is its session's own notebook.

import {
	arr,
	bool,
	defineThingKind,
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
export const NotesKind = defineThingKind("notes.notes", {
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

/** The reader's members: the notebook's notes loaded so far, the last written first, and `more` for the next page. */
const reader = {
	state: { list: obj({ rows: arr(Note), moreAfter: bool() }) },
	methods: { more: method() },
};

/**
 * One notebook of a session (`thing`, a thing of `NotesKind`), for its members and its agent: the notes, and for an
 * editor (who writes in the session and whose options say `edit`) adding, editing and removing them. The notebook
 * is the thing's record, from the admission, never from the params.
 */
export const Notes = remote("notes.notes", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(NotesKind),
	variants: {
		reader,
		editor: {
			state: reader.state,
			methods: {
				...reader.methods,
				/** Adds a note; answers its id. */
				add: method(obj({ text: NoteText }), str()),
				/** Replaces a note's text: it is written now, by the caller. */
				edit: method(obj({ id: str(), text: NoteText })),
				remove: method(obj({ id: str() })),
			},
		},
	},
});
