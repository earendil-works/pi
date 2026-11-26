// The notes plugin's contract: notebooks as a kind of thing (`notes.notes`) and one notebook held in a workspace by a
// person or an agent (`Notes`, `NotesKind`'s contract). Anyone, people and agents, may make one where they may make
// things; it may be linked in any number of workspaces, and its notes, keyed by the thing's id, are the same in each.
// Who may do what is the things plugin's grants: reading is for everyone let in, the one tick Write adds, edits and
// removes notes.

import { arr, bool, lit, method, num, obj, type Static, str, union } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** Who wrote a note last: a person (their name now, from the things store), a session's agent, or the Pi itself. */
export const Author = union([
	obj({ kind: lit("person"), person: str(), name: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who wrote a note last (see `Author`). */
export type Author = Static<typeof Author>;

/** A note's text: 1 to 10,000 characters. */
export const NoteText = str({ min: 1, max: 10_000 });

/** A note: its id in its notebook, its text, when it was written last (ms since the epoch) and by whom. */
export const Note = obj({ id: str(), text: str(), at: num(), author: Author });

/** A note (see `Note`). */
export type Note = Static<typeof Note>;

/**
 * A notebook (`notes.notes`): its name (its thing's; "Notes" while it has none) and its notes loaded so far, the last
 * written first, with `more` for the next page: both for everyone let in. Write gives `add`, `edit` and `remove`. A
 * new link starts with Write for everyone there and the agents; a Read share's guests read.
 */
export const NotesKind = defineThing("notes.notes", {
	version: 1,
	makers: "anyone",
	workspaces: "many",
	state: { name: str(), list: obj({ rows: arr(Note), moreAfter: bool() }) },
	methods: {
		more: method(),
		/** Adds a note, written now by the caller; answers its id. */
		add: method(obj({ text: NoteText }), str()),
		/** Replaces a note's text: it is written now, by the caller. */
		edit: method(obj({ id: str(), text: NoteText })),
		remove: method(obj({ id: str() })),
	},
	ticks: {
		// The one tick. Members no tick gives (`name`, `list`, `more`) are there for everyone let in: reading.
		write: { label: messages.message("tickWrite"), gives: ["add", "edit", "remove"] },
	},
	defaultGrants: { everyone: ["write"], agents: ["write"], guests: [] },
});

/** One notebook held in a workspace: `NotesKind`'s contract. */
export const Notes = NotesKind.contract;

/** What a writer of a notebook is granted (Write). */
export const NOTES_WRITES = ["add", "edit", "remove"] as const;
