// The notes plugin's contract: notebooks as a kind of thing (`notes.notes`) and one notebook held in a workspace by a
// person or an agent (`Notes`, `NotesKind`'s contract). Anyone, people and agents, may make one where they may make
// things; it may be linked in any number of workspaces, and its notes, keyed by the thing's id, are the same in each.
// Who may do what is the things plugin's grants: reading is for everyone let in, the one tick Write adds, edits and
// removes notes.

import { arr, bool, int, lit, method, obj, oneOf, opt, type Static, str, union } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/**
 * Who wrote a note last, as the reader sees them: a person with their name now (their id while the things store has
 * none), a session's agent, or the Pi itself.
 */
export const Author = union([
	obj({ kind: lit("person"), person: str(), name: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who wrote a note last (see `Author`). */
export type Author = Static<typeof Author>;

/** A note's text: 1 to 10,000 characters. */
export const NoteText = str({ min: 1, max: 10_000 });

/**
 * A note: its id in its notebook, its text, when it was written last (ms since the epoch, unique in its notebook: the
 * place of a note in the order) and by whom.
 */
export const Note = obj({ id: str(), text: str(), at: int(), author: Author });

/** A note (see `Note`). */
export type Note = Static<typeof Note>;

/** Notes in the order of a notebook, the last written first, and whether older ones follow. */
export const NotesPage = obj({ rows: arr(Note), moreAfter: bool() });

/** Notes in the order of a notebook (see `NotesPage`). */
export type NotesPage = Static<typeof NotesPage>;

/** The order a notebook shows its notes in: the last written first (the default), or the first written first. */
export const NotesOrder = oneOf("newest", "oldest");

/** The order a notebook shows its notes in (see `NotesOrder`). */
export type NotesOrder = Static<typeof NotesOrder>;

/** What Write gives: the members a writer of a notebook is granted. */
export const NOTES_WRITES = ["add", "edit", "remove"] as const;

/**
 * A notebook (`notes.notes`): its name (its thing's, "" while it has none), its order (its one setting) and its notes
 * loaded so far in that order, all for everyone let in. Write gives `add`, `edit` and `remove`. A new link starts with
 * Write for everyone there and the agents; a Read share's guests read.
 */
export const NotesKind = defineThing("notes.notes", {
	version: 1,
	makers: "anyone",
	state: { name: str(), order: NotesOrder, list: NotesPage },
	methods: {
		/** Loads the next page of older notes into `list`. */
		more: method(),
		/**
		 * A page of notes in the notebook's order, from the start or `after` (an earlier page's `next`), read now and
		 * not followed: what a reader that keeps no list (an agent's tool) pages through.
		 */
		page: method(obj({ after: opt(str()) }), obj({ rows: arr(Note), next: opt(str()) })),
		/** Adds a note, written now by the caller; answers its id. */
		add: method(obj({ text: NoteText }), str()),
		/** Replaces a note's text: it is written now, by the caller. */
		edit: method(obj({ id: str(), text: NoteText })),
		/** Removes a note. */
		remove: method(obj({ id: str() })),
	},
	ticks: {
		// The one tick. Members no tick gives (`name`, `order`, `list`, `more`, `page`) are there for everyone let in:
		// reading.
		write: { label: messages.message("tickWrite"), gives: NOTES_WRITES },
	},
	defaultGrants: { everyone: ["write"], agents: ["write"], guests: [] },
	// Set where the notebook is linked, through the things plugin's Workspace.configure (the `configure` hook).
	settings: ["order"],
});

/** One notebook held in a workspace: `NotesKind`'s contract. */
export const Notes = NotesKind.contract;
