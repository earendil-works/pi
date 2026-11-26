// The notes plugin on the server: the notebooks' store (`store.ts`), one notebook's notes as everyone holding it reads
// them (`NotebookNotes`), and the kind (`serveThing`). The things plugin makes, links, admits and deletes notebooks;
// this file says what a notebook is for one caller: its name, its notes with their authors' names, the pages of them
// the caller loaded, and Write's members. Its notes go when the thing goes (`delete`).
//
// One read per notebook, whoever holds it: a hundred people holding one notebook are one list of its notes and one
// read of its authors' names, not a hundred. Each caller's object shows a prefix of that list, as many pages as it
// loaded, so one person's "older notes" loads them once for everyone and shows them only to that person.

import {
	arr,
	type Context,
	defineFacet,
	type FacetHost,
	int,
	local,
	method,
	obj,
	type P3Principal,
	type Reference,
	type Self,
	str,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { type Note, NotesKind, NotesPage } from "./contract.ts";
import { NotesStore, type StoredNote, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

/**
 * One notebook's notes as every caller holding it reads them: its name, its notes loaded so far with their authors'
 * names, and `bounds`, where each loaded page ended (the `at` of its last note when the next page was loaded; a note's
 * `at` is unique in its notebook, so a bound is an exact place that stays where it is when notes move to the top).
 * `more` loads pages until `pages` are bounded.
 */
const NotebookNotes = local("notes.notebook", {
	version: 1,
	params: { thing: str() },
	members: {
		name: str(),
		list: NotesPage,
		bounds: arr(int()),
		more: method(obj({ pages: int({ min: 1 }) })),
	},
});

export default defineFacet((host) => {
	serveStore(host);
	serveNotebook(host);

	serveThing(host, NotesKind, {
		// A new notebook starts empty: nothing to set up. Its notes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx);
		},
		// One notebook for one caller. The things plugin admitted them and decides which members they get: `add`, `edit`
		// and `remove` only with Write. Every caller reads: the name, the pages it loaded, and pages read now.
		implement: ({ thing }, { caller }, self) => {
			const store = self.get(NotesStore, {});
			const things = self.get(ThingsStore, {});
			const notebook = self.get(NotebookNotes, { thing });
			const pages = self.writable(1);
			return {
				name: notebook.name,
				list: self.derive([notebook.list, notebook.bounds, pages], ([list, bounds, shown]) =>
					loaded(list, bounds, shown),
				),
				more: async (ctx: Context) => {
					const next = pages.value + 1;
					// Pages up to `bounds.length + 1` are loaded already: another caller loaded them.
					if (next > notebook.bounds.value.length + 1) {
						if (!notebook.list.value.moreAfter) return null;
						await notebook.more({ pages: next - 1 }, ctx);
					}
					pages.set(next);
					return null;
				},
				page: ({ after }, ctx) => pageOf(thing, after, store, things, ctx),
				add: ({ text }, ctx) => store.add({ notebook: thing, text, author: caller }, ctx),
				edit: ({ id, text }, ctx) => store.edit({ notebook: thing, id, text, author: caller }, ctx),
				remove: ({ id }, ctx) => store.remove({ notebook: thing, id }, ctx),
			};
		},
	});
});

/** The first `pages` pages of `list` by `bounds`: the whole list once the caller loaded every bounded page. */
function loaded(list: NotesPage, bounds: readonly number[], pages: number): NotesPage {
	if (pages > bounds.length) return list;
	const bound = bounds[pages - 1]!;
	const end = list.rows.findIndex((note) => note.at < bound);
	return end === -1 ? list : { rows: list.rows.slice(0, end), moreAfter: true };
}

/** A page of `thing`'s notes from the start or `after`, with their authors' names, read now. */
async function pageOf(
	thing: string,
	after: string | undefined,
	store: Reference<typeof NotesStore>,
	things: Reference<typeof ThingsStore>,
	ctx: Context,
): Promise<{ rows: Note[]; next?: string }> {
	const found = await store.notes.of.page({ notebook: thing }, PAGE, ctx, after === undefined ? {} : { after });
	const persons = authors(found.items);
	const names = await things.persons.ofIds.page({ persons }, persons.length + 1, ctx);
	return { rows: named(found.items, names.items), ...(found.next === undefined ? {} : { next: found.next }) };
}

/** Serves `NotebookNotes` on `host`. */
function serveNotebook(host: FacetHost<P3Principal>): void {
	host.serve(NotebookNotes, ({ thing }, self) => {
		const store = self.get(NotesStore, {});
		const things = self.get(ThingsStore, {});
		const found = self.liveQuery(things.things.one, { thing }, { first: 1 });
		const list = self.list("notes", [[store.notes.of, { notebook: thing }]], { first: PAGE });
		const bounds = self.writable<number[]>([]);
		// The page another caller is loading: a caller asking meanwhile waits for it before it counts the pages.
		let loading: Promise<unknown> = Promise.resolve();
		return {
			name: self.derive([found], ([{ rows }]) => rows[0]?.name ?? ""),
			list: withNames(list.value, things, self),
			// A writable is the object's own; its value goes out as state through a derive.
			bounds: self.derive([bounds], ([value]) => value),
			more: async ({ pages }, ctx) => {
				await loading.catch(() => undefined);
				while (bounds.value.length < pages && list.value.value.moreAfter) {
					const last = list.value.value.rows.at(-1);
					if (last === undefined) break;
					bounds.set([...bounds.value, last.at]);
					loading = list.more(ctx);
					await loading;
				}
				return null;
			},
		};
	});
}

/** The persons among `notes`' authors, each once, sorted: the same authors are the same arguments. */
function authors(notes: readonly StoredNote[]): string[] {
	return [...new Set(notes.flatMap(({ author }) => (author.kind === "person" ? [author.person] : [])))].sort();
}

/**
 * How many names the read of a notebook's authors may hold: every one, as its arguments (the distinct authors of the
 * loaded notes, each read by key) bound it.
 */
const EVERY = Number.MAX_SAFE_INTEGER;

/** A notebook's loaded notes with their authors, persons by their names now (read by id, following the notes). */
function withNames(
	list: Watchable<{ rows: readonly StoredNote[]; moreAfter: boolean }>,
	things: Reference<typeof ThingsStore>,
	self: Self<P3Principal>,
): Watchable<NotesPage> {
	const ids = self.derive([list], ([{ rows }]) => ({ persons: authors(rows) }));
	const persons = self.liveQuery(things.persons.ofIds, ids, { first: EVERY });
	return self.derive([list, persons], ([{ rows, moreAfter }, found]) => ({
		rows: named(rows, found.rows),
		moreAfter,
	}));
}

/** `notes` with their authors named by `persons`; a person the things store does not have shows their id. */
function named(notes: readonly StoredNote[], persons: readonly { person: string; name: string }[]): Note[] {
	const names = new Map(persons.map(({ person, name }) => [person, name]));
	return notes.map(({ author, ...note }) =>
		author.kind === "person"
			? { ...note, author: { ...author, name: names.get(author.person) ?? author.person } }
			: { ...note, author },
	);
}
