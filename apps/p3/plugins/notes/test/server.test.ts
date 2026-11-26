// The notes plugin on the server (`testPlugin`, beside the things plugin's server facet): the kind (registered with the
// things plugin, made by anyone, linked in many workspaces, Write by default for everyone and the agents, guests
// reading; its notes dropped when the notebook goes with its last link), the one admission (a person put in and the
// session's agent get Write; Write withheld leaves a reader on the same hold, live; nobody else is admitted), notes
// keyed by the notebook (the same in every workspace it is linked in), authors as the admission says with persons'
// names read by id, edits and removals, refusals, and the list with `more`.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { ThingKinds } from "../../things/kind.ts";
import { NOTES_WRITES, NotesKind } from "../contract.ts";
import { NotesStore } from "../store.ts";
import { BY, type Notebooks, notebooks } from "./notebooks.ts";

let n: Notebooks;

beforeEach(async () => {
	n = await notebooks();
});

afterEach(() => n.close());

/** What `principal` is granted on notebook `thing` in `where`. */
const grantedTo = (principal: P3Principal, where: string, thing: string) =>
	n.holding(principal, where, thing, async (notes) => [...notes.granted].sort());

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the kind", () => {
	it("is registered with the things plugin as declared: anyone makes, many workspaces, Write by default", async () => {
		const entry = (await n.t.host.registry(ThingKinds, context)).value.get(NotesKind.name);
		assert.equal(entry?.plugin, "@earendil-works/p3-notes");
		const { makers, workspaces, ticks, defaultGrants } = entry.value;
		assert.deepEqual(
			{ makers, workspaces, ticks: ticks.map(({ name, for: forWhom }) => [name, forWhom]), defaultGrants },
			{
				makers: "anyone",
				workspaces: "many",
				ticks: [["write", "all"]],
				defaultGrants: { everyone: ["write"], agents: ["write"], guests: [] },
			},
		);
		assert.deepEqual(NotesKind.gives.get("write"), NOTES_WRITES);
	});

	it("names a notebook by its thing, else Notes, and follows a rename", async () => {
		const ann = await n.person("Ann");
		const named = await n.notebookIn(n.pi, "Plan");
		const unnamed = await n.notebookIn(n.pi);
		assert.equal(await n.holding(ann, n.pi, named, async (notes) => notes.name.value), "Plan");
		await n.holding(ann, n.pi, unnamed, async (notes, ctx) => {
			assert.equal(notes.name.value, "Notes");
			await n.things.rename({ thing: unnamed, name: "Ideas" }, context);
			await until(notes.name, (name) => name === "Ideas", within("the new name", ctx));
		});
	});

	it("drops a notebook's notes when it goes with its last link, and only its", async () => {
		const ann = await n.person("Ann");
		const [notebook, other] = [await n.notebookIn(n.pi), await n.notebookIn(n.pi)];
		await n.holding(ann, n.pi, notebook, (notes, ctx) => notes.add!({ text: "gone" }, ctx));
		await n.holding(ann, n.pi, other, (notes, ctx) => notes.add!({ text: "kept" }, ctx));
		await n.things.unlink({ workspace: n.pi, thing: notebook }, context);
		const stored = async (of: string) =>
			(await (await n.t.host.get(NotesStore, {}, context)).notes.of.page({ notebook: of }, 10, context)).items;
		await eventually(
			() => stored(notebook),
			(rows) => rows.length === 0,
			2000,
		);
		assert.deepEqual(
			(await stored(other)).map(({ text }) => text),
			["kept"],
		);
	});
});

describe("who may do what in a notebook", () => {
	it("gives a person put in and the session's agent Write; nobody outside is let in", async () => {
		const s1 = await n.workspace("s1");
		const ann = await n.person("Ann", s1);
		const notebook = await n.notebookIn(s1);
		const writes = [...NOTES_WRITES].sort();
		assert.deepEqual(await grantedTo(ann, s1, notebook), writes);
		assert.deepEqual(await grantedTo({ kind: "worker", session: "s1" }, s1, notebook), writes);
		await refused(grantedTo({ kind: "worker", session: "s2" }, s1, notebook));
		const dana = await n.things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(grantedTo({ kind: "person", id: dana, name: "Dana" }, s1, notebook));
	});

	it("follows the grants live on the same hold: Write withheld leaves a reader, removed from Pi denied", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.notebookIn(n.pi);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			await notes.add!({ text: "first" }, ctx);
			await n.write(n.pi, notebook, { kind: "person", person: ann.id }, false);
			await until(notes.state, (state) => state.kind === "live" && notes.add === undefined, within("a reader", ctx));
			assert.deepEqual([notes.edit, notes.remove, notes.granted.size], [undefined, undefined, 0]);
			// A reader still reads, and loads older notes.
			assert.deepEqual(
				notes.list.value.rows.map(({ text }) => text),
				["first"],
			);
			await notes.more(ctx);
			await n.things.removeParty({ workspace: n.pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				notes.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});
});

describe("a notebook's notes", () => {
	it("are the notebook's: the same in every workspace it is linked in; who may write each link's", async () => {
		const [s1, s2] = [await n.workspace("s1"), await n.workspace("s2")];
		const ann = await n.person("Ann", s1);
		await n.things.putParty({ workspace: s2, party: { kind: "person", person: ann.id }, source: BY }, context);
		const shared = await n.notebookIn(s1, "Plan");
		await n.things.link({ workspace: s2, thing: shared, by: BY }, context);
		await n.write(s2, shared, { kind: "person", person: ann.id }, false);
		const id = await n.holding(ann, s1, shared, (notes, ctx) => notes.add!({ text: "linked twice" }, ctx));
		await n.holding(ann, s2, shared, async (notes) => {
			assert.equal(notes.add, undefined);
			assert.equal(notes.name.value, "Plan");
			assert.deepEqual(
				notes.list.value.rows.map((note) => [note.id, note.text]),
				[[id, "linked twice"]],
			);
		});
	});

	it("show who wrote them last as the admission says, persons by their names, the last written first", async () => {
		const s1 = await n.workspace("s1");
		const [ann, ben] = [await n.person("Ann", s1), await n.person("Ben", s1)];
		const notebook = await n.notebookIn(s1);
		await n.holding(ben, s1, notebook, async (watching, outer) => {
			const first = await n.holding(ann, s1, notebook, (notes, ctx) => notes.add!({ text: "Ann's" }, ctx));
			await n.holding({ kind: "worker", session: "s1" }, s1, notebook, (notes, ctx) =>
				notes.add!({ text: "the agent's" }, ctx),
			);
			await until(watching.list, (list) => list.rows.length === 2, within("two notes", outer));
			assert.deepEqual(
				watching.list.value.rows.map(({ text, author }) => [text, author]),
				[
					["the agent's", { kind: "agent", session: "s1" }],
					["Ann's", { kind: "person", person: ann.id, name: "Ann" }],
				],
			);
			// Ben edits Ann's note: it is his now, and the last written.
			await watching.edit!({ id: first, text: "Ben's edit" }, outer);
			await until(watching.list, (list) => list.rows[0]?.text === "Ben's edit", within("the edit first", outer));
			const [edited] = watching.list.value.rows;
			assert.deepEqual([edited?.id, edited?.author], [first, { kind: "person", person: ben.id, name: "Ben" }]);
			await watching.remove!({ id: first }, outer);
			await until(watching.list, (list) => list.rows.length === 1, within("one removed", outer));
		});
	});

	it("refuses a note of another notebook, one that is gone, and texts outside the schema", async () => {
		const ann = await n.person("Ann");
		const [notebook, other] = [await n.notebookIn(n.pi), await n.notebookIn(n.pi)];
		const elsewhere = await n.holding(ann, n.pi, other, (notes, ctx) => notes.add!({ text: "other" }, ctx));
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			await refused(notes.edit!({ id: elsewhere, text: "taken" }, ctx), "invalid");
			await refused(notes.remove!({ id: elsewhere }, ctx), "invalid");
			const id = await notes.add!({ text: "mine" }, ctx);
			await notes.remove!({ id }, ctx);
			await refused(notes.remove!({ id }, ctx), "invalid");
			await refused(notes.add!({ text: "" }, ctx), "invalid");
			await refused(notes.add!({ text: "x".repeat(10_001) }, ctx), "invalid");
		});
		assert.deepEqual(
			await n.holding(ann, n.pi, other, async (notes) => notes.list.value.rows.map(({ text }) => text)),
			["other"],
		);
	});

	it("loads a page of 50, the last written first, and the next with more", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.notebookIn(n.pi);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			for (let i = 0; i < 60; i++) await notes.add!({ text: `n${i}` }, ctx);
		});
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			assert.equal(notes.list.value.rows.length, 50);
			assert.equal(notes.list.value.moreAfter, true);
			await notes.more(ctx);
			assert.deepEqual(
				notes.list.value.rows.map(({ text }) => text),
				Array.from({ length: 60 }, (_, i) => `n${59 - i}`),
			);
			assert.equal(notes.list.value.moreAfter, false);
		});
	});
});
