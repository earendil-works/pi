// The notes plugin on the server (`testPlugin`, beside the real sessions, people, environments, apps, coding and
// sign-in facets): each caller's own notebook offered to bring, the same notebook in two sessions, the admission
// (a reader, a writer whose options say no edit, an editor, the agent by its options, a removed member denied
// live), authors as `Me` says (an agent as `agent`) with names read live, a session's own notebook for a thing without a record, and a
// notebook's list with `more`.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BringThings,
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	type OptionsFor,
	type P3Principal,
	type Reference,
	Sessions,
	THIS_DEVICE,
	thingOf,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { Notes, NotesKind } from "../contract.ts";

/** The owner's person in this test's Pi (made at its first start). */
let OWNER: Extract<P3Principal, { kind: "person" }>;

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

/** Makes a coding session with `members` and no things; its id. */
function session(members: Member[]): Promise<string> {
	return t.root(
		async (ctx) => (await ctx.get(SessionsStore, {})).create({ app: "coding", location: HERE, members }, ctx),
		context,
	);
}

/** `who` brings their own notebook into session `id`; the thing's id. */
function bring(who: Person, id: string): Promise<string> {
	return t.root(
		async (ctx) => {
			const bringing = await ctx.get(BringThings, { session: id });
			if (bringing.variant !== "writer") return assert.fail(bringing.variant);
			return bringing.bring({ kind: NotesKind.name, ref: `person:${who.id}` }, ctx);
		},
		context,
		{ principal: who },
	);
}

/** Sets the options of thing `thing` of session `id` for `forWhom`, as the owner. */
function setOptions(id: string, thing: string, forWhom: OptionsFor, edit: boolean | null): Promise<null> {
	return t.root(
		async (ctx) =>
			(await ctx.get(Sessions, {})).setOptions(
				{ session: id, thing, for: forWhom, options: edit === null ? null : { edit } },
				ctx,
			),
		context,
		{ principal: OWNER },
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

/** The editor of `notes`, failing the test for a reader. */
function editorOf(notes: NotesRef) {
	if (notes.variant !== "editor") return assert.fail(`a ${notes.variant}`);
	return notes;
}

/** `notes`' variant now (a reference's variant changes with its admission). */
function variantOf(notes: NotesRef): string {
	return notes.variant;
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the notebooks a caller may bring", () => {
	it("offer each person their own, titled with their name, the owner theirs, and nobody another's", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const id = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "write" },
		]);
		const offered = (principal: P3Principal) =>
			t.root(
				async (ctx) => {
					const bringing = await ctx.get(BringThings, { session: id });
					if (bringing.variant !== "writer") return assert.fail(bringing.variant);
					return (await bringing.kinds({}, ctx)).find(({ kind }) => kind === NotesKind.name)?.records;
				},
				context,
				{ principal },
			);
		assert.deepEqual(await offered(ann), [{ ref: `person:${ann.id}`, title: "Ann's notes" }]);
		assert.deepEqual(await offered(OWNER), [{ ref: `person:${OWNER.id}`, title: `${OWNER.name}'s notes` }]);
		await refused(
			t.root(
				async (ctx) => {
					const bringing = await ctx.get(BringThings, { session: id });
					if (bringing.variant !== "writer") return assert.fail(bringing.variant);
					return bringing.bring({ kind: NotesKind.name, ref: `person:${ann.id}` }, ctx);
				},
				context,
				{ principal: ben },
			),
		);
	});
});

describe("a notebook", () => {
	it("is the same in every session it is brought into", async () => {
		const ann = await person("Ann");
		const first = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const second = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const here = await bring(ann, first);
		const there = await bring(ann, second);
		const id = await holding(ann, first, here, (notes, ctx) => editorOf(notes).add({ text: "shared" }, ctx));
		const shown = await holding(ann, second, there, async (notes) => notes.list.value.rows);
		assert.deepEqual(
			shown.map(({ id: note, text, author }) => [note, text, author]),
			[[id, "shared", { kind: "person", id: ann.id, name: "Ann" }]],
		);
	});

	it("is its session's own for a thing without a record", async () => {
		const ann = await person("Ann");
		const first = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const second = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const add = (id: string) =>
			t.root(
				async (ctx) => (await ctx.get(SessionsStore, {})).addThing({ session: id, thing: thingOf(NotesKind) }, ctx),
				context,
			);
		const here = await add(first);
		const there = await add(second);
		await holding(OWNER, first, here, (notes, ctx) => editorOf(notes).add({ text: "only here" }, ctx));
		assert.equal((await holding(ann, first, here, async (notes) => notes.list.value.rows)).length, 1);
		assert.deepEqual(await holding(ann, second, there, async (notes) => notes.list.value.rows), []);
	});

	it("loads a page of 50, the last written first, and the next with more", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const thing = await bring(ann, id);
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
	/** A session with Ann (writes, brings her notebook), Ben (reads) and Cleo (writes); the notebook's thing. */
	async function setup() {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const cleo = await person("Cleo");
		const id = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
			{ kind: "person", id: cleo.id, access: "write" },
		]);
		return { ann, ben, cleo, id, thing: await bring(ann, id) };
	}

	it("gives a reader and a writer whose options say no edit the reader; an editor adds, edits and removes", async () => {
		const { ann, ben, cleo, id, thing } = await setup();
		await setOptions(id, thing, { kind: "person", id: cleo.id }, false);
		assert.equal(await holding(ben, id, thing, async (notes) => notes.variant), "reader");
		assert.equal(await holding(cleo, id, thing, async (notes) => notes.variant), "reader");
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
			assert.equal(notes.variant, "editor");
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
		assert.equal(await holding(agent, id, thing, async (notes) => notes.variant), "editor");
		await setOptions(id, thing, { kind: "agent" }, false);
		assert.equal(await holding(agent, id, thing, async (notes) => notes.variant), "reader");
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
			assert.equal(notes.variant, "reader");
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
		// Ann leaves the session: her notebook goes with her, and her notes stay hers.
		await t.root(
			async (server) =>
				(await server.get(SessionsStore, {})).removeMember(
					{ session: id, party: { kind: "person", id: ann.id } },
					server,
				),
			context,
		);
		await refused(
			t.root(async (ctx) => ctx.get(Notes, { session: id, thing }, { readyTimeout: 500 }), context, {
				principal: OWNER,
			}),
		);
	});
});
