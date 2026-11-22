// The notes plugin on the server: the notebooks' store (`store.ts`), the kind in `ThingKinds` with each caller's own
// notebook as the record they may bring, and `Notes`, one notebook of a session for whom `admitThing` admits: an
// editor (write access and options that say `edit`) or a reader. A note's author is who `Me` says the caller is,
// asked as the caller at each write; authors' names are read by id, live, never copied into the notes.

import {
	admitThing,
	type Context,
	type Ctx,
	contribute,
	defineFacet,
	Me,
	type P3Principal,
	type Reference,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { PeopleStore, type RecordsFor, ThingKinds } from "@earendil-works/p3/v1/server";
import { type Author, type Note, Notes, NotesKind } from "./contract.ts";
import { NotesStore, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

/**
 * How many authors' names a notebook's view reads at most: the persons among the loaded notes' authors, read whole;
 * a view that loaded notes of more fails its list (closed and visible, never a part of the names).
 */
const READ_WHOLE = 1000;

export default defineFacet((host) => {
	serveStore(host);

	contribute(host, "notes.kind", (self) => {
		const people = self.get(PeopleStore, {});
		self.contribute(ThingKinds, {
			kind: NotesKind,
			title: "Notes",
			records: (who, context) => recordsOf(who, people, context),
		});
	});

	host.serve(
		Notes,
		({ session }, _principal, { access, ref, options }, self) => {
			// A thing without a record (an app's) is its session's own notebook.
			const notebook = ref === "" ? `session:${session}` : ref;
			const store = self.get(NotesStore, {});
			const list = self.list("notes", [[store.notes.of, { notebook }]], { first: PAGE });
			const reader = { list: shown(list.value, self), more: (ctx: Ctx<P3Principal>) => list.more(ctx) };
			if (access === "read" || !options.edit) return { variant: "reader", members: reader };
			return {
				variant: "editor",
				members: {
					...reader,
					add: async ({ text }, ctx) => store.add({ notebook, text, author: await authorKey(ctx) }, ctx),
					edit: async ({ id, text }, ctx) => store.edit({ notebook, id, text, author: await authorKey(ctx) }, ctx),
					remove: ({ id }, ctx) => store.remove({ notebook, id }, ctx),
				},
			};
		},
		{ admit: admitThing(NotesKind) },
	);
});

/** The notebook `who` may bring: their own (titled with their name; none for a person who left). */
async function recordsOf(who: RecordsFor, people: Reference<typeof PeopleStore>, context: Context) {
	const [found] = (await people.persons.one.page({ id: who.id }, 1, context)).items;
	return found === undefined ? [] : [{ ref: `person:${found.id}`, title: `${found.name}'s notes` }];
}

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
