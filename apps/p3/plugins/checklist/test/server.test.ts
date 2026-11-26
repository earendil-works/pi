// The checklist plugin on the server (`kindServer`: its server facet beside the things plugin's): the kind (registered
// by its plugin, made by anyone; its items dropped when the checklist goes with its last link, also when its delete
// runs again), the admission (a person put in gets Add and Tick, the session's agent Tick only; each tick on its own;
// `@open` alone, or a tick withheld, leaves a reader on the same hold, live; the owner gets both without being put in;
// a checklist hidden in a workspace, or a caller removed, is denied), items keyed by the checklist (the same in every
// workspace it is linked in), ticks live for every holder, refusals and the limit of 500 items, an add committed after
// the delete refused. The cost of the read, one however many hold the checklist (Chord shares identical reads), is
// counted (`chord.query.runs`), and so is its release with the last holder.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { collected, eventually, within } from "../../../test/until.ts";
import { ThingHooks } from "../../things/contract.server.ts";
import { OPEN } from "../../things/contract.ts";
import { ThingKinds } from "../../things/kind.ts";
import { BY, type KindServer, kindServer, refused } from "../../things/test/kind-server.ts";
import { type Checklist, ChecklistKind } from "../kind.ts";
import checklistServer from "../server.ts";
import { ChecklistStore } from "../store.ts";

/** The checklist plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent of workspace `s1`. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

let c: KindServer<typeof Checklist>;

beforeEach(async () => {
	c = await kindServer(
		{ name: "@earendil-works/p3-checklist", root: ROOT, server: checklistServer },
		ChecklistKind,
		context,
	);
});

afterEach(() => c.close());

describe("the kind", () => {
	it("is registered by the checklist plugin, made by anyone", async () => {
		const entry = (await c.host.registry(ThingKinds, context)).value.get(ChecklistKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-checklist", "anyone"]);
	});

	it("names a checklist by its thing, empty while it has none, and follows a rename", async () => {
		const ann = await c.person("Ann");
		const unnamed = await c.thingIn(c.pi);
		await c.holding(ann, c.pi, unnamed, async (list, ctx) => {
			assert.equal(list.name.value, "");
			await c.things.rename({ thing: unnamed, name: "Packing" }, context);
			await until(list.name, (name) => name === "Packing", within("the new name", ctx));
		});
	});

	it("refuses an add that commits after the delete: no item under a dead id (Opus, explainer check)", async () => {
		const ann = await c.person("Ann");
		const thing = await c.thingIn(c.pi);
		const store = await c.host.get(ChecklistStore, {}, context);
		const stored = async () => (await store.items.of.page({ checklist: thing }, 10, context)).items;
		await c.holding(ann, c.pi, thing, async (list, ctx) => {
			await list.addItem!({ text: "before" }, ctx);
			// The last link goes while Ann still holds the checklist; her add, in flight, reaches the store after the
			// delete hook's clear.
			await c.things.unlink({ workspace: c.pi, thing }, context);
			await eventually(stored, (rows) => rows.length === 0, 2000);
			await refused(store.add({ checklist: thing, text: "in flight" }, context), "invalid", "gone");
		});
		assert.deepEqual(await stored(), []);
	});

	it("drops a checklist's items when it goes with its last link, and only its; its delete may run again", async () => {
		const ann = await c.person("Ann");
		const [gone, kept] = [await c.thingIn(c.pi), await c.thingIn(c.pi)];
		await c.holding(ann, c.pi, gone, (list, ctx) => list.addItem!({ text: "gone" }, ctx));
		await c.holding(ann, c.pi, kept, (list, ctx) => list.addItem!({ text: "kept" }, ctx));
		await c.things.unlink({ workspace: c.pi, thing: gone }, context);
		const stored = async (checklist: string) =>
			(await (await c.host.get(ChecklistStore, {}, context)).items.of.page({ checklist }, 10, context)).items;
		await eventually(
			() => stored(gone),
			(rows) => rows.length === 0,
			2000,
		);
		// The things plugin runs a delete again after a failure or a restart: a second run finds nothing and succeeds.
		const hook = (await c.host.registry(ThingHooks, context)).value.get(ChecklistKind.name)?.value.delete;
		await c.host.root((ctx) => hook!(gone, ctx), context);
		assert.deepEqual(
			(await stored(kept)).map(({ text }) => text),
			["kept"],
		);
	});
});

describe("who may do what in a checklist", () => {
	it("gives a person put in Add and Tick, the session's agent Tick only; nobody outside is let in", async () => {
		const s1 = await c.workspace("s1");
		const ann = await c.person("Ann", s1);
		const list = await c.thingIn(s1);
		assert.deepEqual(await c.granted(ann, s1, list), ["addItem", "setDone"]);
		assert.deepEqual(await c.granted(AGENT, s1, list), ["setDone"]);
		await refused(c.granted({ kind: "worker", session: "s2" }, s1, list));
		const dana = await c.things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(c.granted({ kind: "person", id: dana, name: "Dana" }, s1, list));
	});

	it("gives each tick its own member: Add without Tick adds, Tick without Add ticks", async () => {
		const [ann, ben] = [await c.person("Ann"), await c.person("Ben")];
		const thing = await c.thingIn(c.pi);
		await c.tick(c.pi, thing, { kind: "person", person: ann.id }, "tick", false);
		await c.tick(c.pi, thing, { kind: "person", person: ben.id }, "add", false);
		const id = await c.holding(ann, c.pi, thing, async (list, ctx) => {
			assert.equal(list.setDone, undefined);
			return list.addItem!({ text: "tent" }, ctx);
		});
		await c.holding(ben, c.pi, thing, async (list, ctx) => {
			assert.equal(list.addItem, undefined);
			await list.setDone!({ id, done: true }, ctx);
			await until(list.items, (items) => items[0]?.done === true, within("ticked", ctx));
		});
	});

	it("lets in with @open alone a reader, who reads the items but has neither member", async () => {
		const ann = await c.person("Ann");
		const thing = await c.thingIn(c.pi);
		await c.holding(ann, c.pi, thing, (list, ctx) => list.addItem!({ text: "milk" }, ctx));
		const everyone = { kind: "everyone" } as const;
		// The kind's rows of everyone removed, one of no tick (`OPEN`) instead.
		await c.things.setGrants(
			{
				source: { kind: "plugin", plugin: "@earendil-works/p3-checklist" },
				grants: ["add", "tick"].map((tick) => ({ workspace: c.pi, thing, party: everyone, tick })),
			},
			context,
		);
		await c.tick(c.pi, thing, everyone, OPEN, true);
		await c.holding(ann, c.pi, thing, async (list) => {
			assert.deepEqual([list.addItem, list.setDone, list.granted.size], [undefined, undefined, 0]);
			assert.deepEqual(
				list.items.value.map(({ text }) => text),
				["milk"],
			);
		});
	});

	it("gives the owner both ticks without being put in, also where they are withheld from everyone", async () => {
		const id = await c.things.createPerson({ name: "Olga", madeBy: BY }, context);
		await c.things.setOwner({ person: id, owner: true }, context);
		const thing = await c.thingIn(c.pi);
		for (const tick of ["add", "tick"]) await c.tick(c.pi, thing, { kind: "everyone" }, tick, false);
		assert.deepEqual(await c.granted({ kind: "person", id, name: "Olga" }, c.pi, thing), ["addItem", "setDone"]);
	});

	it("follows the grants live, on the same hold: Tick withheld leaves no setDone, removed from Pi denied", async () => {
		const ann = await c.person("Ann");
		const thing = await c.thingIn(c.pi);
		await c.holding(ann, c.pi, thing, async (list, ctx) => {
			await list.addItem!({ text: "milk" }, ctx);
			await c.tick(c.pi, thing, { kind: "person", person: ann.id }, "tick", false);
			await until(
				list.state,
				(state) => state.kind === "live" && list.setDone === undefined,
				within("no Tick", ctx),
			);
			assert.ok(list.addItem !== undefined);
			await c.things.removeParty({ workspace: c.pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				list.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});

	it("denies a checklist hidden in a workspace there, live", async () => {
		const s1 = await c.workspace("s1");
		const ann = await c.person("Ann", s1);
		const thing = await c.thingIn(c.pi, "Packing");
		await c.holding(ann, s1, thing, async (list, ctx) => {
			assert.equal(list.name.value, "Packing");
			await c.things.setSwitch({ workspace: s1, item: { kind: "thing", thing }, shown: false }, context);
			await until(
				list.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
	});
});

describe("a checklist's items", () => {
	it("are the checklist's: the same in every workspace it is linked in, ticked live for every holder", async () => {
		const [s1, s2] = [await c.workspace("s1"), await c.workspace("s2")];
		const [ann, ben] = [await c.person("Ann", s1), await c.person("Ben", s2)];
		const shared = await c.thingIn(s1, "Plan");
		await c.things.link({ workspace: s2, thing: shared }, context);
		await c.tick(s2, shared, { kind: "person", person: ben.id }, "add", false);
		await c.holding(ben, s2, shared, async (watching, outer) => {
			assert.equal(watching.addItem, undefined);
			await c.holding(ann, s1, shared, async (list, ctx) => {
				const first = await list.addItem!({ text: "tent" }, ctx);
				const second = await list.addItem!({ text: "stove" }, ctx);
				await list.setDone!({ id: second, done: true }, ctx);
				await until(watching.items, (items) => items.some(({ done }) => done), within("the tick", outer));
				assert.deepEqual(watching.items.value, [
					{ id: first, text: "tent", done: false },
					{ id: second, text: "stove", done: true },
				]);
			});
		});
	});

	it("refuses an item of another checklist, texts outside the schema, and a 501st item", async () => {
		const ann = await c.person("Ann");
		const [thing, other] = [await c.thingIn(c.pi), await c.thingIn(c.pi)];
		const elsewhere = await c.holding(ann, c.pi, other, (list, ctx) => list.addItem!({ text: "other" }, ctx));
		await c.holding(ann, c.pi, thing, async (list, ctx) => {
			await refused(list.setDone!({ id: elsewhere, done: true }, ctx), "invalid", "noItem");
			await refused(list.addItem!({ text: "" }, ctx), "invalid");
			await refused(list.addItem!({ text: "x".repeat(501) }, ctx), "invalid");
			for (let i = 0; i < 500; i++) await list.addItem!({ text: `i${i}` }, ctx);
			await refused(list.addItem!({ text: "one too many" }, ctx), "invalid", "full");
			await until(list.items, (items) => items.length === 500, within("all 500", ctx));
		});
		assert.deepEqual(await c.holding(ann, c.pi, other, async (list) => list.items.value), [
			{ id: elsewhere, text: "other", done: false },
		]);
	});
});

describe("the cost of a checklist's read", () => {
	// Each caller's object reads the items with its own live query; Chord shares identical reads (ERNDL-1176).
	it("is one run of its items per tick, however many hold it", async () => {
		const persons = [await c.person("Ann"), await c.person("Ben"), await c.person("Cy")];
		const thing = await c.thingIn(c.pi);
		const holders = await c.holders(persons, c.pi, thing);
		try {
			const [ann] = holders.held;
			const id = await ann!.ref.addItem!({ text: "tent" }, ann!.ctx);
			const all = (done: boolean) =>
				Promise.all(
					holders.held.map(({ ref, ctx }) =>
						until(ref.items, (items) => items[0]?.done === done, within(`done: ${done}`, ctx)),
					),
				);
			await all(false);
			const before = c.count("chord.query.runs");
			await ann!.ref.setDone!({ id, done: true }, ann!.ctx);
			await all(true);
			assert.equal(c.count("chord.query.runs") - before, 1);
		} finally {
			await holders.release();
		}
	});
});

describe("a released checklist", () => {
	it("releases the shared read with its last holder: the next holder opens it again", async () => {
		const [ann, ben] = [await c.person("Ann"), await c.person("Ben")];
		const thing = await c.thingIn(c.pi);
		const first = await c.holders([ann, ben], c.pi, thing);
		// Another holder joins the open read (Chord shares it): it reads nothing.
		const joined = c.count("chord.query.runs");
		const third = await c.holders([await c.person("Cy")], c.pi, thing);
		assert.equal(c.count("chord.query.runs"), joined);
		await third.release();
		await first.release();
		// With every holder gone the read closes; a new holder opens it again.
		await eventually(
			async () => {
				const before = c.count("chord.query.runs");
				await c.holding(ann, c.pi, thing, async (list) => list.items.value);
				return c.count("chord.query.runs") - before;
			},
			(runs) => runs > 0,
			5000,
		);
	});

	it("is collected", async () => {
		const ann = await c.person("Ann");
		const thing = await c.thingIn(c.pi);
		const refs: WeakRef<object>[] = [];
		await c.holding(ann, c.pi, thing, async (list) => {
			refs.push(new WeakRef(list), new WeakRef(list.items));
		});
		assert.ok(await collected(refs));
	});
});
