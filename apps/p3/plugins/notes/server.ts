// The notes plugin on the server: the notebooks' store (`store.ts`), and the kind (`serveThing`): content any writer
// of a session or its agent makes there, its notes cleared with its thing (`delete`), and `Notes`, one notebook of a
// session for whom `admitThing` admits: an editor (write access and options that say `edit`) or a reader. A notebook
// is a thing: its notes are keyed by the thing's id, its name is the thing's. A note's author is who `Me` says the
// caller is, asked as the caller at each write; authors' names are read by id, live, never copied into the notes.

import { type Ctx, defineFacet, Me, type P3Principal, type Self, type Watchable } from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore, serveThing } from "@earendil-works/p3/v1/server";
import { type Author, NOTES_EDITS, type Note, Notes, NotesKind } from "./contract.ts";
import { NotesStore, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

/**
 * How many authors' names a notebook's view reads at most: the persons among the loaded notes' authors, read whole;
 * a view that loaded notes of more fails its list (closed and visible, never a part of the names).
 */
const READ_WHOLE = 1000;

/** What a notebook whose thing has no name shows: its kind's title. */
const TITLE = "Notes";

export default defineFacet((host) => {
	serveStore(host);

	serveThing(host, NotesKind, {
		title: TITLE,
		creation: "content",
		// A notebook starts empty; its notes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx);
		},
		object: {
			contract: Notes,
			// An editor writes in the session and its options say `edit`.
			grants: ({ access, options }) => (access === "write" && options.edit ? NOTES_EDITS : []),
			factory: ({ thing }, _admitted, self) => {
				const notebook = thing;
				const store = self.get(NotesStore, {});
				const named = self.liveQuery(self.get(SessionsStore, {}).things.one, { id: thing }, { first: 1 });
				const list = self.list("notes", [[store.notes.of, { notebook }]], { first: PAGE });
				return {
					name: self.derive([named], ([{ rows }]) => rows[0]?.name || TITLE),
					list: shown(list.value, self),
					more: (ctx: Ctx<P3Principal>) => list.more(ctx),
					add: async ({ text }, ctx) => store.add({ notebook, text, author: await authorKey(ctx) }, ctx),
					edit: async ({ id, text }, ctx) => store.edit({ notebook, id, text, author: await authorKey(ctx) }, ctx),
					remove: ({ id }, ctx) => store.remove({ notebook, id }, ctx),
				};
			},
		},
	});
});

/** The caller's key as an author, as `Me` answers it for them. */
async function authorKey(ctx: Ctx<P3Principal>): Promise<string> {
	const me = (await ctx.get(Me, {})).me.value;
	switch (me.kind) {
		case "person":
			return `person:${me.id}`;
		case "agent":
			return "agent";
	}
}

/** A note as the store keeps it. */
type StoredNote = { readonly id: string; readonly text: string; readonly at: number; readonly author: string };

/** An author key's prefix for a person. */
const PERSON = "person:";

/** A notebook's loaded notes with their authors, persons by their names now (read by id, following the notes). */
function shown(
	list: Watchable<{ rows: readonly StoredNote[]; moreAfter: boolean }>,
	self: Self<P3Principal>,
): Watchable<{ rows: Note[]; moreAfter: boolean }> {
	const ids = self.derive([list], ([{ rows }]) => ({
		ids: [...new Set(rows.flatMap(({ author }) => (author.startsWith(PERSON) ? [author.slice(PERSON.length)] : [])))],
	}));
	const persons = self.liveQuery(self.get(PeopleStore, {}).persons.ofIds, ids, { first: READ_WHOLE });
	return self.derive([list, persons], ([{ rows, moreAfter }, found]) => {
		if (found.more) throw new Error(`notes: the loaded notes have more than ${READ_WHOLE} authors`);
		const names = new Map(found.rows.map(({ id, name }) => [id, name]));
		return { rows: rows.map((note) => ({ ...note, author: authorOf(note.author, names) })), moreAfter };
	});
}

/** The author of key `key` (written by `authorKey`); a person who left shows their id. */
function authorOf(key: string, names: ReadonlyMap<string, string>): Author {
	if (key.startsWith(PERSON)) {
		const id = key.slice(PERSON.length);
		return { kind: "person", id, name: names.get(id) ?? id };
	}
	return { kind: "agent" };
}
