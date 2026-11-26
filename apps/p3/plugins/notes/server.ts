// The notes plugin on the server: the notebooks' store (`store.ts`), one notebook's notes as everyone holding it reads
// them (`NotebookRead`), and the kind (`serveThing`). The things plugin makes, links, admits and deletes notebooks;
// this file says what a notebook is for one caller: its name, its notes with their authors' names, as far as the
// caller loaded them, and Write's members. Its notes go when the thing goes (`delete`).
//
// One read per notebook, whoever holds it: a hundred people holding one notebook are one list of its notes and one
// read of its authors' names, not a hundred. Each caller's object keeps where its own view ends (its bound) and shows
// the shared list down to it; the shared list loads at least as far as the deepest holder asked, and keeps that until
// its last holder leaves (Chord cannot unload a list's pages: a holder who leaves after reading deep pages leaves them
// loaded for the others, filtered out of their views). A caller's object is one per caller and notebook (its params
// are the workspace and the thing): one person's two screens share it, and with it one bound (decided).

import {
	type Context,
	defineFacet,
	type FacetHost,
	int,
	local,
	method,
	nul,
	obj,
	type P3Principal,
	type Reference,
	type Self,
	str,
	union,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { type Note, NotesKind, NotesPage } from "./contract.ts";
import { NotesStore, type StoredNote, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

/**
 * Where a caller's view of a notebook ends: the `at` of its last note (a note's `at` is unique in its notebook, so it
 * is an exact place that stays where it is when notes move to the top), `null` for the whole notebook (it had no more
 * when the caller loaded), `undefined` while the caller has not loaded yet (its first page by count).
 */
type Bound = number | null | undefined;

/**
 * One notebook's notes as every caller holding it reads them: its name, and its notes loaded so far with their authors'
 * names. `load` loads until it holds `rows` notes or the notebook has no more, and answers the `at` of its `rows`-th
 * note (`null`: it has fewer).
 */
const NotebookRead = local("notes.read", {
	version: 1,
	params: { thing: str() },
	members: {
		name: str(),
		list: NotesPage,
		load: method(obj({ rows: int({ min: 1 }) }), union([int(), nul()])),
	},
});

export default defineFacet((host) => {
	serveStore(host);
	serveRead(host);

	serveThing(host, NotesKind, {
		// A new notebook starts empty: nothing to set up. Its notes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx);
		},
		// One notebook for one caller. The things plugin admitted them and decides which members they get: `add`, `edit`
		// and `remove` only with Write. Every caller reads: the name, the notes down to its bound, and pages read now.
		implement: ({ thing }, { caller }, self) => {
			const store = self.get(NotesStore, {});
			const things = self.get(ThingsStore, {});
			const read = self.get(NotebookRead, { thing });
			const bound = self.writable<Bound>(undefined);
			// The first page's bound, fixed once the shared list holds it; a reload starts it again.
			self.onLive(async (ctx) => {
				const first = await read.load({ rows: PAGE }, ctx);
				if (bound.value === undefined) bound.set(first);
			});
			return {
				name: read.name,
				list: self.derive([read.list, bound], ([list, at]) => visible(list, at)),
				more: async (ctx: Context) => {
					const shown = visible(read.list.value, bound.value).rows.length;
					bound.set(await read.load({ rows: shown + PAGE }, ctx));
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

/** The notes of the shared `list` a caller whose view ends at `bound` sees: a prefix of it. */
function visible(list: NotesPage, bound: Bound): NotesPage {
	if (bound === null) return list;
	const below = bound === undefined ? PAGE : list.rows.findIndex((note) => note.at < bound);
	const end = below === -1 ? list.rows.length : Math.min(below, list.rows.length);
	return end === list.rows.length ? list : { rows: list.rows.slice(0, end), moreAfter: true };
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
	// No person among the authors: no names to read.
	const names = persons.length === 0 ? [] : (await things.persons.ofIds.page({ persons }, persons.length, ctx)).items;
	return { rows: named(found.items, names), ...(found.next === undefined ? {} : { next: found.next }) };
}

/** Serves `NotebookRead` on `host`. */
function serveRead(host: FacetHost<P3Principal>): void {
	host.serve(NotebookRead, ({ thing }, self) => {
		const store = self.get(NotesStore, {});
		const things = self.get(ThingsStore, {});
		const found = self.liveQuery(things.things.one, { thing }, { first: 1 });
		const list = self.list("notes", [[store.notes.of, { notebook: thing }]], { first: PAGE });
		// The most notes a holder asked for. The routine below loads them, one page at a time, with this object's own
		// context: a caller that stops waiting stops nobody else's load.
		const wanted = self.writable(PAGE);
		const short = self.derive(
			[wanted, list.value],
			([rows, loaded]) => loaded.moreAfter && loaded.rows.length < rows,
		);
		self.on(short, async (_change, ctx) => {
			while (list.value.value.moreAfter && list.value.value.rows.length < wanted.value) await list.more(ctx);
		});
		return {
			name: self.derive([found], ([{ rows }]) => rows[0]?.name ?? ""),
			list: withNames(list.value, things, self),
			load: async ({ rows }, ctx) => {
				if (rows > wanted.value) wanted.set(rows);
				const loaded = await until(list.value, (now) => now.rows.length >= rows || !now.moreAfter, ctx);
				return loaded.rows[rows - 1]?.at ?? null;
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
 * loaded notes, each read by key) bound it. They are the parameters of one statement: past SQLite's limit of 32,766
 * distinct authors among the loaded notes the read fails, visibly.
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
