// The notes plugin on the server: the notebooks' store (`store.ts`) and the kind (`serveThing`). The things plugin
// makes, links, admits and deletes notebooks; this file says what a notebook is for one caller: its name, its notes
// with their authors' names, in its order (its one setting, `configure`), the pages of them the caller loaded (one
// Chord list per caller), a page read now, and Write's members. Its notes go when the thing goes (`delete`).

import {
	type Context,
	defineFacet,
	type P3Principal,
	type Reference,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { type Note, NotesKind, type NotesOrder, type NotesPage } from "./contract.ts";
import { NotesStore, type StoredNote, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

export default defineFacet((host) => {
	serveStore(host);

	serveThing(host, NotesKind, {
		// A new notebook starts empty, the last written first: nothing to set up. Its notes and its order go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx);
		},
		// Its one setting; the things plugin checked the value against `order`'s schema.
		configure: async (thing, { order }, ctx) => {
			if (order !== undefined)
				await (await ctx.get(NotesStore, {})).setOrder({ notebook: thing, order: order as NotesOrder }, ctx);
		},
		// One notebook for one caller. The things plugin admitted them and decides which members they get: `add`, `edit`
		// and `remove` only with Write. Every caller reads: the name, the pages it loaded, and pages read now.
		implement: ({ thing }, { caller }, self) => {
			const store = self.get(NotesStore, {});
			const things = self.get(ThingsStore, {});
			const named = self.liveQuery(things.things.one, { thing }, { first: 1 });
			const set = self.liveQuery(store.orders.of, { notebook: thing }, { first: 1 });
			const order = self.derive([set], ([{ rows }]): NotesOrder => rows[0]?.order ?? "newest");
			// A new order is a new list: it starts again at its first page.
			const args = self.derive([order], ([by]) => ({ notebook: thing, order: by }));
			const list = self.list("notes", [[store.notes.of, args]], { first: PAGE });
			return {
				name: self.derive([named], ([{ rows }]) => rows[0]?.name ?? ""),
				order,
				list: withNames(list.value, things, self),
				more: (ctx: Context) => list.more(ctx),
				page: ({ after }, ctx) => pageOf({ notebook: thing, order: order.value }, after, store, things, ctx),
				add: ({ text }, ctx) => store.add({ notebook: thing, text, author: caller }, ctx),
				edit: ({ id, text }, ctx) => store.edit({ notebook: thing, id, text, author: caller }, ctx),
				remove: ({ id }, ctx) => store.remove({ notebook: thing, id }, ctx),
			};
		},
	});
});

/** A page of a notebook's notes in an order, from the start or `after`, with their authors' names, read now. */
async function pageOf(
	of: { readonly notebook: string; readonly order: NotesOrder },
	after: string | undefined,
	store: Reference<typeof NotesStore>,
	things: Reference<typeof ThingsStore>,
	ctx: Context,
): Promise<{ rows: Note[]; next?: string }> {
	const found = await store.notes.of.page(of, PAGE, ctx, after === undefined ? {} : { after });
	const persons = authors(found.items);
	// No person among the authors: no names to read.
	const names = persons.length === 0 ? [] : (await things.persons.ofIds.page({ persons }, persons.length, ctx)).items;
	return { rows: withAuthors(found.items, names), ...(found.next === undefined ? {} : { next: found.next }) };
}

/** The persons among `notes`' authors, each once, sorted: the same authors are the same arguments. */
function authors(notes: readonly StoredNote[]): string[] {
	return [...new Set(notes.flatMap(({ author }) => (author.kind === "person" ? [author.person] : [])))].sort();
}

/**
 * How many names the read of a notebook's authors may hold: every one, as its arguments (the distinct authors of the
 * caller's loaded notes, each read by key) bound it. They are the parameters of one statement: past SQLite's limit of
 * 32,766 distinct authors among the loaded notes the read fails, visibly.
 */
const EVERY = Number.MAX_SAFE_INTEGER;

/** A caller's loaded notes with their authors, persons by their names now (read by id, following the notes). */
function withNames(
	list: Watchable<{ rows: readonly StoredNote[]; moreAfter: boolean }>,
	things: Reference<typeof ThingsStore>,
	self: Self<P3Principal>,
): Watchable<NotesPage> {
	const ids = self.derive([list], ([{ rows }]) => ({ persons: authors(rows) }));
	const persons = self.liveQuery(things.persons.ofIds, ids, { first: EVERY });
	return self.derive([list, persons], ([{ rows, moreAfter }, found]) => ({
		rows: withAuthors(rows, found.rows),
		moreAfter,
	}));
}

/** `notes` with their authors named by `persons`; a person the things store does not have shows their id. */
function withAuthors(notes: readonly StoredNote[], persons: readonly { person: string; name: string }[]): Note[] {
	const names = new Map(persons.map(({ person, name }) => [person, name]));
	return notes.map(({ author, ...note }) =>
		author.kind === "person"
			? { ...note, author: { ...author, name: names.get(author.person) ?? author.person } }
			: { ...note, author },
	);
}
