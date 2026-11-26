// The notes plugin on the server: the notebooks' store (`store.ts`) and the kind (`serveThing`). The things plugin
// makes, links, admits and deletes notebooks; this file says only what a notebook is for one caller: its name, its
// notes with their authors' names, and Write's members. Its notes go when the thing goes (`delete`).

import {
	type Context,
	defineFacet,
	type P3Principal,
	type Reference,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import type { Caller } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { type Author, type Note, NotesKind } from "./contract.ts";
import { NotesStore, serveStore } from "./store.ts";

/** How many notes a page of a notebook holds. */
const PAGE = 50;

/** The name of a notebook nobody named: its kind's title. */
const TITLE = "Notes";

export default defineFacet((host) => {
	serveStore(host);

	serveThing(host, NotesKind, {
		// A new notebook starts empty: nothing to set up. Its notes go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx);
		},
		// One notebook for one caller. The things plugin admitted them and decides which members they get: `add`, `edit`
		// and `remove` only with Write. Every caller gets the name and the notes.
		implement: ({ thing }, { caller }, self) => {
			const store = self.get(NotesStore, {});
			const things = self.get(ThingsStore, {});
			const named = self.liveQuery(things.things.one, { thing }, { first: 1 });
			const list = self.list("notes", [[store.notes.of, { notebook: thing }]], { first: PAGE });
			const author = authorKey(caller);
			return {
				name: self.derive([named], ([{ rows }]) => rows[0]?.name || TITLE),
				list: shown(list.value, things, self),
				more: (ctx: Context) => list.more(ctx),
				add: ({ text }, ctx) => store.add({ notebook: thing, text, author }, ctx),
				edit: ({ id, text }, ctx) => store.edit({ notebook: thing, id, text, author }, ctx),
				remove: ({ id }, ctx) => store.remove({ notebook: thing, id }, ctx),
			};
		},
	});
});

/** An author key's prefix for a person. */
const PERSON = "person:";

/** An author key's prefix for a session's agent. */
const AGENT = "agent:";

/** Who wrote a note, as the store keeps it: `person:<id>`, `agent:<session>`, `server`. */
function authorKey(caller: Caller): string {
	switch (caller.kind) {
		case "person":
			return `${PERSON}${caller.person}`;
		case "agent":
			return `${AGENT}${caller.session}`;
		case "server":
			return "server";
	}
}

/** A note as the store keeps it. */
type StoredNote = { readonly id: string; readonly text: string; readonly at: number; readonly author: string };

/**
 * How many authors' names a notebook reads at most: the persons among its loaded notes' authors, read whole. A list
 * that loaded notes of more fails (closed and visible, never some of the names).
 */
const READ_WHOLE = 1000;

/** A notebook's loaded notes with their authors, persons by their names now (read by id, following the notes). */
function shown(
	list: Watchable<{ rows: readonly StoredNote[]; moreAfter: boolean }>,
	things: Reference<typeof ThingsStore>,
	self: Self<P3Principal>,
): Watchable<{ rows: Note[]; moreAfter: boolean }> {
	// The same authors keep the same arguments: a note written by someone already shown reads no names again.
	let last: { persons: string[] } = { persons: [] };
	const ids = self.derive([list], ([{ rows }]) => {
		const persons = new Set(
			rows.flatMap(({ author }) => (author.startsWith(PERSON) ? [author.slice(PERSON.length)] : [])),
		);
		if (persons.size !== last.persons.length || last.persons.some((person) => !persons.has(person))) {
			last = { persons: [...persons] };
		}
		return last;
	});
	const persons = self.liveQuery(things.persons.ofIds, ids, { first: READ_WHOLE });
	return self.derive([list, persons], ([{ rows, moreAfter }, found]) => {
		if (found.more) throw new Error(`notes: the loaded notes have more than ${READ_WHOLE} authors`);
		const names = new Map(found.rows.map(({ person, name }) => [person, name]));
		return { rows: rows.map((note) => ({ ...note, author: authorOf(note.author, names) })), moreAfter };
	});
}

/** The author of key `key` (written by `authorKey`); a person who is gone shows their id. */
function authorOf(key: string, names: ReadonlyMap<string, string>): Author {
	if (key.startsWith(PERSON)) {
		const person = key.slice(PERSON.length);
		return { kind: "person", person, name: names.get(person) ?? person };
	}
	if (key.startsWith(AGENT)) return { kind: "agent", session: key.slice(AGENT.length) };
	return { kind: "server" };
}
