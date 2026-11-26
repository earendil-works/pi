// The notes plugin on the server (`testPlugin`, beside the real sessions, people, environments, apps, coding and
// sign-in facets): notebooks are content (a writer or the agent makes them in a session, a reader none), two in one
// session hold their own notes, one kept and used in a second session shows the same notes, its name is its thing's,
// its notes go with it; a notebook's list with `more`; the admission (a reader, a writer whose options say no edit,
// an editor, the default changed live, the agent by its options, a removed member denied live) and authors as `Me`
// says (an agent as `agent`) with names read live.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	type OptionsFor,
	type P3Principal,
	type Reference,
	SESSION_THINGS_WRITES,
	SessionThings,
	THIS_DEVICE,
	until,
	type With,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { NOTES_EDITS, Notes, NotesKind } from "../contract.ts";
import { NotesStore } from "../store.ts";

/** The owner's person in this test's Pi (made at its first start). */
let OWNER: Person;

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-notes-test" };

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** `Notes` as a test holds it. */
type NotesRef = Reference<typeof Notes>;

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "server",
			stubs: [
				{ name: "@earendil-works/p3-apps", facet: appsServer },
				{ name: "@earendil-works/p3-coding", facet: codingServer },
				{ name: "@earendil-works/p3-environments", facet: environmentsServer },
				{ name: "@earendil-works/p3-people", facet: peopleServer },
				{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
				{ name: "@earendil-works/p3-sign-in", facet: signInServer },
			],
		},
		context,
	);
	const [owner] = await t.root(
		async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
		context,
	);
	OWNER = { kind: "person", id: owner!.id, name: owner!.name };
});

afterEach(() => t.close(context));

/** Makes person `name`; their principal. */
async function person(name: string): Promise<Person> {
	const id = await t.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** Makes a coding session with `members`, following nobody; its id. */
function session(members: Member[]): Promise<string> {
	return t.root(
		async (ctx) => (await ctx.get(SessionsStore, {})).create({ app: "coding", location: HERE, members }, ctx),
		context,
	);
}

/** Runs `fn` with `principal`'s writer of session `id`'s things, failing the test for a reader. */
function managing<T>(
	principal: P3Principal,
	id: string,
	fn: (
		things: With<Reference<typeof SessionThings>, (typeof SESSION_THINGS_WRITES)[number]>,
		ctx: Ctx<P3Principal>,
	) => Promise<T>,
): Promise<T> {
	return t.root(
		async (ctx) => {
			const things = await ctx.get(SessionThings, { session: id });
			assertGranted(things, ...SESSION_THINGS_WRITES);
			return fn(things, ctx);
		},
		context,
		{ principal },
	);
}

/** `who` makes a notebook (named `name`) in session `id`; its thing's id. */
function make(who: Person, id: string, name?: string): Promise<string> {
	return managing(who, id, (things, ctx) =>
		things.create({ kind: NotesKind.name, ...(name === undefined ? {} : { name }) }, ctx),
	);
}

/** Sets the options of thing `thing` of session `id` for `forWhom`, as the owner. */
function setOptions(id: string, thing: string, forWhom: OptionsFor, edit: boolean | null): Promise<null> {
	return managing(OWNER, id, (things, ctx) =>
		things.setOptions({ thing, for: forWhom, options: edit === null ? null : { edit } }, ctx),
	);
}

/** Runs `fn` with `principal`'s `Notes` of thing `thing` of session `id`. */
function holding<T>(
	principal: P3Principal,
	id: string,
	thing: string,
	fn: (notes: NotesRef, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(async (ctx) => fn(await ctx.get(Notes, { session: id, thing }), ctx), context, { principal });
}

/** The texts of notebook `thing` of session `id`, as `who` reads them. */
function texts(who: P3Principal, id: string, thing: string): Promise<string[]> {
	return holding(who, id, thing, async (notes) => notes.list.value.rows.map(({ text }) => text));
}

/** The editor of `notes`, failing the test for a reader. */
function editorOf(notes: NotesRef) {
	assertGranted(notes, ...NOTES_EDITS);
	return notes;
}

/** `notes`' variant now (a reference's variant changes with its admission). */
function variantOf(notes: NotesRef): string {
	return notes.granted.has("add") ? "editor" : "reader";
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("making notebooks", () => {
	it("is a writer's: two notebooks of one session hold their own notes; a reader makes none", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const id = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
		]);
		assert.ok(
			(await managing(ann, id, async (things) => things.kinds.value)).some(({ kind }) => kind === NotesKind.name),
		);
		const work = await make(ann, id, "Work");
		const home = await make(ann, id);
		await holding(ann, id, work, (notes, ctx) => editorOf(notes).add({ text: "ship it" }, ctx));
		await holding(ann, id, home, (notes, ctx) => editorOf(notes).add({ text: "water the plants" }, ctx));
		assert.deepEqual(await texts(ann, id, work), ["ship it"]);
		assert.deepEqual(await texts(ann, id, home), ["water the plants"]);
		// Its name is its thing's; none shows the kind's title.
		assert.equal(await holding(ben, id, work, async (notes) => notes.name.value), "Work");
		assert.equal(await holding(ben, id, home, async (notes) => notes.name.value), "Notes");
		assert.equal(
			await t.root(
				async (ctx) =>
					(await ctx.get(SessionThings, { session: id })).granted.has("create") ? "writer" : "reader",
				context,
				{
					principal: ben,
				},
			),
			"reader",
		);
	});

	it("renames live, and shows the same notes in a second session once kept and added there", async () => {
		const ann = await person("Ann");
		const first = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const second = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const thing = await make(ann, first, "Shared");
		const note = await holding(ann, first, thing, (notes, ctx) => editorOf(notes).add({ text: "shared" }, ctx));
		await managing(ann, first, (things, ctx) => things.keep({ thing, owner: { kind: "person", id: ann.id } }, ctx));
		await managing(ann, second, (things, ctx) => things.add({ thing }, ctx));
		await holding(ann, second, thing, async (notes, ctx) => {
			assert.deepEqual(
				notes.list.value.rows.map(({ id, text, author }) => [id, text, author]),
				[[note, "shared", { kind: "person", id: ann.id, name: "Ann" }]],
			);
			await managing(ann, first, (things, inner) => things.rename({ thing, name: "Ours" }, inner));
			await until(notes.name, (name) => name === "Ours", within("the new name", ctx));
		});
	});

	it("drops a notebook's notes with it: deleted, or nobody's content unlinked from its last session", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const stored = (notebook: string) =>
			t.root(
				async (ctx) => (await (await ctx.get(NotesStore, {})).notes.of.page({ notebook }, 10, ctx)).items,
				context,
			);
		const deleted = await make(ann, id);
		const removed = await make(ann, id);
		for (const thing of [deleted, removed]) {
			await holding(ann, id, thing, (notes, ctx) => editorOf(notes).add({ text: "gone soon" }, ctx));
		}
		await managing(ann, id, (things, ctx) => things.delete({ thing: deleted }, ctx));
		await managing(ann, id, (things, ctx) => things.remove({ thing: removed }, ctx));
		assert.deepEqual(await stored(deleted), []);
		assert.deepEqual(await stored(removed), []);
	});
});

describe("a notebook's list", () => {
	it("loads a page of 50, the last written first, and the next with more", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const thing = await make(ann, id);
		await holding(ann, id, thing, async (notes, ctx) => {
			for (let i = 0; i < 55; i++) await editorOf(notes).add({ text: `note ${i}` }, ctx);
		});
		// A new list (the rows exist before it opens): the first page, then `more`.
		await holding(ann, id, thing, async (notes, ctx) => {
			assert.equal(notes.list.value.rows.length, 50);
			assert.equal(notes.list.value.rows[0]?.text, "note 54");
			assert.equal(notes.list.value.moreAfter, true);
			await notes.more(ctx);
			assert.equal(notes.list.value.rows.length, 55);
			assert.equal(notes.list.value.rows.at(-1)?.text, "note 0");
		});
	});
});

describe("who may do what in a notebook", () => {
	/** A session with Ann (writes, makes a notebook), Ben (reads) and Cleo (writes); the notebook's thing. */
	async function setup() {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const cleo = await person("Cleo");
		const id = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
			{ kind: "person", id: cleo.id, access: "write" },
		]);
		return { ann, ben, cleo, id, thing: await make(ann, id) };
	}

	it("gives a reader and a writer whose options say no edit the reader; an editor adds, edits and removes", async () => {
		const { ann, ben, cleo, id, thing } = await setup();
		await setOptions(id, thing, { kind: "person", id: cleo.id }, false);
		assert.equal(
			await holding(ben, id, thing, async (notes) => (notes.granted.has("add") ? "editor" : "reader")),
			"reader",
		);
		assert.equal(
			await holding(cleo, id, thing, async (notes) => (notes.granted.has("add") ? "editor" : "reader")),
			"reader",
		);
		await holding(ann, id, thing, async (notes, ctx) => {
			const editor = editorOf(notes);
			const first = await editor.add({ text: "one" }, ctx);
			const second = await editor.add({ text: "two" }, ctx);
			await editor.edit({ id: first, text: "one, edited" }, ctx);
			// An edit writes the note now: it is the last written.
			assert.deepEqual(
				notes.list.value.rows.map(({ id: note, text }) => [note, text]),
				[
					[first, "one, edited"],
					[second, "two"],
				],
			);
			await editor.remove({ id: second }, ctx);
			assert.deepEqual(
				notes.list.value.rows.map(({ text }) => text),
				["one, edited"],
			);
			await refused(editor.remove({ id: second }, ctx), "invalid");
			await refused(editor.add({ text: "" }, ctx), "invalid");
		});
		// The default turned to no edit: Ann, without options of her own, reads only, at once.
		await holding(ann, id, thing, async (notes, ctx) => {
			assert.equal(notes.granted.has("add") ? "editor" : "reader", "editor");
			await setOptions(id, thing, { kind: "everyone" }, false);
			// The reference's variant follows its object's new admission.
			await until(
				notes.state,
				(state) => state.kind === "live" && variantOf(notes) === "reader",
				within("the reader", ctx),
			);
		});
	});

	it("records who wrote a note as Me says, a person's name read live, an agent as the agent", async () => {
		const { ann, id, thing } = await setup();
		await holding(OWNER, id, thing, (notes, ctx) => editorOf(notes).add({ text: "by the owner" }, ctx));
		await holding({ kind: "worker", session: id }, id, thing, (notes, ctx) =>
			editorOf(notes).add({ text: "by the agent" }, ctx),
		);
		await holding(ann, id, thing, async (notes, ctx) => {
			await editorOf(notes).add({ text: "by Ann" }, ctx);
			assert.deepEqual(
				notes.list.value.rows.map(({ text, author }) => [text, author]),
				[
					["by Ann", { kind: "person", id: ann.id, name: "Ann" }],
					["by the agent", { kind: "agent" }],
					["by the owner", { kind: "person", id: OWNER.id, name: OWNER.name }],
				],
			);
			await t.root(async (server) => {
				await (await server.get(PeopleStore, {})).renamePerson({ person: ann.id, name: "Anna" }, server);
			}, context);
			await until(
				notes.list,
				(list) => list.rows[0]?.author.kind === "person" && list.rows[0].author.name === "Anna",
				within("Anna's name", ctx),
			);
		});
	});

	it("gives the agent the editor or the reader as its own options say", async () => {
		const { id, thing } = await setup();
		const agent: P3Principal = { kind: "worker", session: id };
		assert.equal(
			await holding(agent, id, thing, async (notes) => (notes.granted.has("add") ? "editor" : "reader")),
			"editor",
		);
		await setOptions(id, thing, { kind: "agent" }, false);
		assert.equal(
			await holding(agent, id, thing, async (notes) => (notes.granted.has("add") ? "editor" : "reader")),
			"reader",
		);
		// Another session's worker has no access.
		await refused(
			t.root(async (ctx) => ctx.get(Notes, { session: id, thing }, { readyTimeout: 500 }), context, {
				principal: { kind: "worker", session: "other" },
			}),
		);
	});

	it("denies a member the moment they are removed, and a person outside at once", async () => {
		const { ann, ben, id, thing } = await setup();
		const dana = await person("Dana");
		await refused(
			t.root(async (ctx) => ctx.get(Notes, { session: id, thing }, { readyTimeout: 500 }), context, {
				principal: dana,
			}),
		);
		await holding(ben, id, thing, async (notes, ctx) => {
			assert.equal(notes.granted.has("add") ? "editor" : "reader", "reader");
			await t.root(
				async (server) =>
					(await server.get(SessionsStore, {})).removeMember(
						{ session: id, party: { kind: "person", id: ben.id } },
						server,
					),
				context,
			);
			await until(
				notes.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ben denied", ctx),
			);
		});
		// Ann leaves the session: the notebook is the session's content, it stays.
		await t.root(
			async (server) =>
				(await server.get(SessionsStore, {})).removeMember(
					{ session: id, party: { kind: "person", id: ann.id } },
					server,
				),
			context,
		);
		assert.equal(
			await holding(OWNER, id, thing, async (notes) => (notes.granted.has("add") ? "editor" : "reader")),
			"editor",
		);
	});
});
