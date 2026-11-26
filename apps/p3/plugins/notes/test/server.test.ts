// The notes plugin on the server (`kindServer`: its server facet beside the things plugin's): the kind (registered by
// its plugin, made by anyone; its notes dropped when the notebook goes with its last link, also when its delete runs
// again), the one admission (a person put in and the session's agent get Write; `@open` alone, or Write withheld,
// leaves a reader on the same hold, live; the owner gets Write without being put in; a notebook hidden in a workspace,
// or a caller removed, is denied), notes keyed by the notebook (the same in every workspace it is linked in), authors
// as the admission says with persons' names read by id (any number of them), edits and removals, refusals, each
// caller's pages (its own Chord list: the newest 50, 50 more with Older, older ones reachable after removals, new and
// edited notes on top, kept across a reload), its order (newest first by default; `configure` flips it for a holder
// already holding it; it goes with the notebook), a page read now (`page`), and the counted cost of a note. Authors'
// names following a rename wait for people's names to be editable (the things store cannot rename a person yet).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { collected, eventually, within } from "../../../test/until.ts";
import { ThingHooks } from "../../things/contract.server.ts";
import { OPEN } from "../../things/contract.ts";
import { ThingKinds } from "../../things/kind.ts";
import { BY, type KindServer, kindServer, type Person } from "../../things/test/kind-server.ts";
import { NOTES_WRITES, type Notes, NotesKind } from "../contract.ts";
import notesServer from "../server.ts";
import { NotesStore } from "../store.ts";

/** The notes plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent of workspace `s1`. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

let n: KindServer<typeof Notes>;

beforeEach(async () => {
	n = await kindServer({ name: "@earendil-works/p3-notes", root: ROOT, server: notesServer }, NotesKind, context);
});

afterEach(() => n.close());

/** What `principal` is granted on notebook `thing` in `where`. */
const grantedTo = (principal: P3Principal, where: string, thing: string) =>
	n.holding(principal, where, thing, async (notes) => [...notes.granted].sort());

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

/** The texts of `notes`' loaded notes, in order. */
const texts = (notes: Reference<typeof Notes>) => notes.list.value.rows.map(({ text }) => text);

/** `count` notes' texts as `fill` writes them, the last written first. */
const newestFirst = (count: number) => Array.from({ length: count }, (_, i) => `n${count - 1 - i}`);

/** Adds `count` notes `n0`, `n1`, … to `thing` in Pi as `who`. */
async function fill(who: Person, thing: string, count: number): Promise<void> {
	await n.holding(who, n.pi, thing, async (notes, ctx) => {
		for (let i = 0; i < count; i++) await notes.add!({ text: `n${i}` }, ctx);
	});
}

describe("the kind", () => {
	it("is registered by the notes plugin, made by anyone", async () => {
		const entry = (await n.host.registry(ThingKinds, context)).value.get(NotesKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-notes", "anyone"]);
	});

	it("names a notebook by its thing, empty while it has none, and follows a rename", async () => {
		const ann = await n.person("Ann");
		const named = await n.thingIn(n.pi, "Plan");
		const unnamed = await n.thingIn(n.pi);
		assert.equal(await n.holding(ann, n.pi, named, async (notes) => notes.name.value), "Plan");
		await n.holding(ann, n.pi, unnamed, async (notes, ctx) => {
			assert.equal(notes.name.value, "");
			await n.things.rename({ thing: unnamed, name: "Ideas" }, context);
			await until(notes.name, (name) => name === "Ideas", within("the new name", ctx));
		});
	});

	it("drops a notebook's notes when it goes with its last link, and only its; its delete may run again", async () => {
		const ann = await n.person("Ann");
		const [notebook, other] = [await n.thingIn(n.pi), await n.thingIn(n.pi)];
		await n.holding(ann, n.pi, notebook, (notes, ctx) => notes.add!({ text: "gone" }, ctx));
		await n.holding(ann, n.pi, other, (notes, ctx) => notes.add!({ text: "kept" }, ctx));
		await n.things.unlink({ workspace: n.pi, thing: notebook }, context);
		const stored = async (of: string) =>
			(
				await (
					await n.host.get(NotesStore, {}, context)
				).notes.of.page({ notebook: of, order: "newest" }, 10, context)
			).items;
		await eventually(
			() => stored(notebook),
			(rows) => rows.length === 0,
			2000,
		);
		// The things plugin runs a delete again after a failure or a restart: a second run finds nothing and succeeds.
		const hook = (await n.host.registry(ThingHooks, context)).value.get(NotesKind.name)?.value.delete;
		await n.host.root((ctx) => hook!(notebook, ctx), context);
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
		const notebook = await n.thingIn(s1);
		const writes = [...NOTES_WRITES].sort();
		assert.deepEqual(await grantedTo(ann, s1, notebook), writes);
		assert.deepEqual(await grantedTo(AGENT, s1, notebook), writes);
		await refused(grantedTo({ kind: "worker", session: "s2" }, s1, notebook));
		const dana = await n.things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(grantedTo({ kind: "person", id: dana, name: "Dana" }, s1, notebook));
	});

	it("lets in with @open alone a reader, who reads and pages but has no writing members", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 2);
		const everyone = { kind: "everyone" } as const;
		// The kind's Write row of everyone replaced by one of no tick (`OPEN`).
		await n.things.setGrants(
			{
				source: { kind: "plugin", plugin: "@earendil-works/p3-notes" },
				grants: [{ workspace: n.pi, thing: notebook, party: everyone, tick: "write" }],
			},
			context,
		);
		await n.tick(n.pi, notebook, everyone, OPEN, true);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			assert.deepEqual(
				[notes.add, notes.edit, notes.remove, notes.granted.size],
				[undefined, undefined, undefined, 0],
			);
			assert.deepEqual(texts(notes), ["n1", "n0"]);
			assert.equal((await notes.page({}, ctx)).rows.length, 2);
			await notes.more(ctx);
		});
	});

	it("gives the owner Write without being put in, also where Write is withheld from everyone", async () => {
		const id = await n.things.createPerson({ name: "Olga", madeBy: BY }, context);
		await n.things.setOwner({ person: id, owner: true }, context);
		const notebook = await n.thingIn(n.pi);
		await n.tick(n.pi, notebook, { kind: "everyone" }, "write", false);
		assert.deepEqual(await grantedTo({ kind: "person", id, name: "Olga" }, n.pi, notebook), [...NOTES_WRITES].sort());
	});

	it("follows the grants live, on the same hold: Write withheld leaves a reader, removed from Pi denied", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			await notes.add!({ text: "first" }, ctx);
			await n.tick(n.pi, notebook, { kind: "person", person: ann.id }, "write", false);
			await until(notes.state, (state) => state.kind === "live" && notes.add === undefined, within("a reader", ctx));
			assert.deepEqual([notes.edit, notes.remove, notes.granted.size], [undefined, undefined, 0]);
			assert.deepEqual(texts(notes), ["first"]);
			await n.things.removeParty({ workspace: n.pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				notes.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});

	it("denies a notebook hidden in a workspace there, live, and still lets it in where it is shown", async () => {
		const s1 = await n.workspace("s1");
		const ann = await n.person("Ann", s1);
		await n.things.putParty({ workspace: n.pi, party: { kind: "person", person: ann.id }, source: BY }, context);
		const notebook = await n.thingIn(n.pi, "Plan");
		await n.holding(ann, s1, notebook, async (notes, ctx) => {
			assert.equal(notes.name.value, "Plan");
			await n.things.setSwitch({ workspace: s1, item: { kind: "thing", thing: notebook }, shown: false }, context);
			await until(
				notes.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
		assert.equal(await n.holding(ann, n.pi, notebook, async (notes) => notes.name.value), "Plan");
	});
});

describe("a notebook's notes", () => {
	it("are the notebook's: the same in every workspace it is linked in; who may write each link's", async () => {
		const [s1, s2] = [await n.workspace("s1"), await n.workspace("s2")];
		const ann = await n.person("Ann", s1);
		await n.things.putParty({ workspace: s2, party: { kind: "person", person: ann.id }, source: BY }, context);
		const shared = await n.thingIn(s1, "Plan");
		await n.things.link({ workspace: s2, thing: shared }, context);
		await n.tick(s2, shared, { kind: "person", person: ann.id }, "write", false);
		const id = await n.holding(ann, s1, shared, (notes, ctx) => notes.add!({ text: "linked twice" }, ctx));
		await n.holding(ann, s2, shared, async (notes) => {
			assert.equal(notes.add, undefined);
			assert.deepEqual(
				notes.list.value.rows.map((note) => [note.id, note.text]),
				[[id, "linked twice"]],
			);
		});
	});

	it("show who wrote them last as the admission says, persons by their names, the last written first", async () => {
		const s1 = await n.workspace("s1");
		const [ann, ben] = [await n.person("Ann", s1), await n.person("Ben", s1)];
		const notebook = await n.thingIn(s1);
		await n.holding(ben, s1, notebook, async (watching, outer) => {
			const first = await n.holding(ann, s1, notebook, (notes, ctx) => notes.add!({ text: "Ann's" }, ctx));
			await n.holding(AGENT, s1, notebook, (notes, ctx) => notes.add!({ text: "the agent's" }, ctx));
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

	it("name any number of authors (Astra: 1,001 persons among the loaded notes)", async () => {
		const notebook = await n.thingIn(n.pi, "Team journal");
		const viewer = await n.person("Viewer");
		const store = await n.host.get(NotesStore, {}, context);
		for (let i = 0; i < 1001; i++) {
			const person = await n.things.createPerson({ name: `Author ${i}`, madeBy: BY }, context);
			await store.add({ notebook, text: `entry ${i}`, author: { kind: "person", person } }, context);
		}
		await n.holding(viewer, n.pi, notebook, async (notes, ctx) => {
			while (notes.list.value.moreAfter) await notes.more(ctx);
			const rows = notes.list.value.rows;
			const oldest = rows.at(-1);
			assert.equal(rows.length, 1001);
			assert.deepEqual(
				[oldest?.text, oldest?.author.kind === "person" && oldest.author.name],
				["entry 0", "Author 0"],
			);
		});
	});

	it("refuses a note of another notebook, one that is gone, and texts outside the schema", async () => {
		const ann = await n.person("Ann");
		const [notebook, other] = [await n.thingIn(n.pi), await n.thingIn(n.pi)];
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
		assert.deepEqual(await n.holding(ann, n.pi, other, async (notes) => texts(notes)), ["other"]);
	});
});

describe("a notebook's pages", () => {
	it("are each caller's: a fresh holder sees the newest 50, Older loads 50 more, for that caller only", async () => {
		const [ann, ben] = [await n.person("Ann"), await n.person("Ben")];
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 120);
		await n.holding(ben, n.pi, notebook, async (bens, _outer) => {
			await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
				assert.deepEqual([texts(notes), notes.list.value.moreAfter], [newestFirst(120).slice(0, 50), true]);
				await notes.more(ctx);
				assert.deepEqual([notes.list.value.rows.length, bens.list.value.rows.length], [100, 50]);
				await notes.more(ctx);
				assert.deepEqual([texts(notes), notes.list.value.moreAfter], [newestFirst(120), false]);
				assert.deepEqual(texts(bens), newestFirst(120).slice(0, 50));
			});
		});
	});

	it("show a fresh holder the newest 50, however many notes another holder wrote meanwhile", async () => {
		const [cy, ann] = [await n.person("Cy"), await n.person("Ann")];
		const notebook = await n.thingIn(n.pi);
		await n.holding(cy, n.pi, notebook, async (cys, outer) => {
			for (let i = 0; i < 300; i++) await cys.add!({ text: `n${i}` }, outer);
			await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
				assert.deepEqual(texts(notes), newestFirst(300).slice(0, 50));
				await notes.more(ctx);
				assert.deepEqual(texts(notes), newestFirst(300).slice(0, 100));
			});
		});
	});

	it("reach older notes after every shown one was removed", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 120);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			for (const { id } of notes.list.value.rows) await notes.remove!({ id }, ctx);
			await until(notes.list, (list) => list.rows.length === 0, within("all shown removed", ctx));
			assert.equal(notes.list.value.moreAfter, true);
			await notes.more(ctx);
			assert.deepEqual(texts(notes), newestFirst(70).slice(0, 50));
			await notes.more(ctx);
			assert.deepEqual([texts(notes), notes.list.value.moreAfter], [newestFirst(70), false]);
		});
	});

	it("show new and edited notes on top, keeping every loaded note: no gap, no duplicate", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 120);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			await notes.more(ctx);
			const before = notes.list.value.rows;
			for (const text of ["a", "b", "c"]) await notes.add!({ text }, ctx);
			await notes.edit!({ id: before.at(-1)!.id, text: "moved" }, ctx);
			await until(notes.list, (list) => list.rows[0]?.text === "moved", within("the edit on top", ctx));
			const rows = notes.list.value.rows;
			assert.deepEqual(
				rows.slice(0, 4).map(({ text }) => text),
				["moved", "c", "b", "a"],
			);
			assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length);
			assert.deepEqual(
				rows.slice(4).map(({ id }) => id),
				before.slice(0, -1).map(({ id }) => id),
			);
		});
	});

	it("keep each caller's pages across a reload of the plugin", async () => {
		const [ann, ben] = [await n.person("Ann"), await n.person("Ben")];
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 150);
		const holders = await n.holders([ann, ben], n.pi, notebook);
		try {
			const [anns, bens] = holders.held;
			await anns!.ref.more(anns!.ctx);
			await n.reload();
			await anns!.ref.add!({ text: "after the reload" }, anns!.ctx);
			for (const { ref, ctx } of holders.held) {
				await until(ref.list, (list) => list.rows[0]?.text === "after the reload", within("the new note", ctx));
			}
			assert.deepEqual([anns!.ref.list.value.rows.length, bens!.ref.list.value.rows.length], [101, 51]);
		} finally {
			await holders.release();
		}
	});

	it("can be read a page at a time without changing what the caller holds", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 120);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			const first = await notes.page({}, ctx);
			assert.equal(first.rows.length, 50);
			const second = await notes.page({ after: first.next! }, ctx);
			const third = await notes.page({ after: second.next! }, ctx);
			assert.deepEqual(
				[...first.rows, ...second.rows, ...third.rows].map(({ text }) => text),
				newestFirst(120),
			);
			assert.equal(third.next, undefined);
			assert.deepEqual(first.rows[0]?.author, { kind: "person", person: ann.id, name: "Ann" });
			assert.equal(notes.list.value.rows.length, 50);
		});
	});
});

describe("a notebook's order", () => {
	it("is newest first by default; configure flips it for a holder already holding it, and back", async () => {
		const [ann, ben] = [await n.person("Ann"), await n.person("Ben")];
		const notebook = await n.thingIn(n.pi);
		await fill(ann, notebook, 120);
		const configure = (await n.host.registry(ThingHooks, context)).value.get(NotesKind.name)?.value.configure;
		assert.ok(configure !== undefined);
		await n.holding(ben, n.pi, notebook, async (notes, ctx) => {
			assert.deepEqual([notes.order.value, texts(notes)], ["newest", newestFirst(120).slice(0, 50)]);
			await notes.more(ctx);
			await n.host.root((call) => configure(notebook, { order: "oldest" }, call), context);
			// A new order starts the list again at its first page.
			await until(notes.list, (list) => list.rows[0]?.text === "n0", within("oldest first", ctx));
			assert.deepEqual([notes.order.value, texts(notes)], ["oldest", newestFirst(120).reverse().slice(0, 50)]);
			// The agent's page read follows it.
			assert.deepEqual(
				(await notes.page({}, ctx)).rows.slice(0, 2).map(({ text }) => text),
				["n0", "n1"],
			);
			await notes.more(ctx);
			assert.equal(notes.list.value.rows.at(-1)?.text, "n99");
			// A new note is the newest: last in this order, once the list reaches it.
			await notes.add!({ text: "latest" }, ctx);
			await n.host.root((call) => configure(notebook, { order: "newest" }, call), context);
			await until(notes.list, (list) => list.rows[0]?.text === "latest", within("newest first again", ctx));
			assert.equal(notes.order.value, "newest");
		});
	});

	it("goes with the notebook: one made after it starts newest first again", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		const configure = (await n.host.registry(ThingHooks, context)).value.get(NotesKind.name)?.value.configure;
		await n.host.root((call) => configure!(notebook, { order: "oldest" }, call), context);
		await n.things.unlink({ workspace: n.pi, thing: notebook }, context);
		const store = await n.host.get(NotesStore, {}, context);
		await eventually(
			async () => (await store.orders.of.page({ notebook }, 1, context)).items,
			(rows) => rows.length === 0,
			2000,
		);
		const other = await n.thingIn(n.pi);
		assert.equal(await n.holding(ann, n.pi, other, async (notes) => notes.order.value), "newest");
	});
});

describe("the cost of a notebook's read", () => {
	it("is one run of its list per note; a note by an author already shown reads no names", async () => {
		const [ann, ben] = [await n.person("Ann"), await n.person("Ben")];
		const notebook = await n.thingIn(n.pi);
		await n.holding(ann, n.pi, notebook, async (notes, ctx) => {
			const added = async (by: typeof notes, text: string) => {
				const before = n.count("chord.query.runs");
				await by.add!({ text }, ctx);
				await until(notes.list, (list) => list.rows[0]?.text === text, within(text, ctx));
				return n.count("chord.query.runs") - before;
			};
			await added(notes, "first");
			assert.equal(await added(notes, "second"), 1, "the list only");
			await n.holding(ben, n.pi, notebook, async (bens) => {
				const before = n.count("chord.query.runs");
				await bens.add!({ text: "Ben's" }, ctx);
				await until(notes.list, (list) => list.rows[0]?.text === "Ben's", within("Ben's", ctx));
				// Ann's list and the names of its new author; Ben's own list and names.
				assert.equal(n.count("chord.query.runs") - before, 4);
			});
		});
	});
});

describe("a released notebook", () => {
	it("is collected", async () => {
		const ann = await n.person("Ann");
		const notebook = await n.thingIn(n.pi);
		const refs: WeakRef<object>[] = [];
		await n.holding(ann, n.pi, notebook, async (notes) => {
			refs.push(new WeakRef(notes), new WeakRef(notes.list));
		});
		assert.ok(await collected(refs));
	});
});
