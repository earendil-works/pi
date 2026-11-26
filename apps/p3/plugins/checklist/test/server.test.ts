// The checklist plugin on the server (`testPlugin`, beside the things plugin's server facet): the kind (registered with
// the things plugin, made by anyone, linked in many workspaces, Write by default for everyone and the agents, guests
// reading; its items dropped when the checklist goes with its last link), the one admission (a person put in and the
// session's agent get Write; Write withheld leaves a reader on the same hold, live; nobody else is admitted), items
// keyed by the checklist (the same in every workspace it is linked in), ticks live for every holder, refusals, and
// the limit of 500 items.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { ThingKinds } from "../../things/kind.ts";
import { CHECKLIST_WRITES, ChecklistKind } from "../contract.ts";
import { ChecklistStore } from "../server.ts";
import { BY, type Checklists, checklists } from "./checklists.ts";

let c: Checklists;

beforeEach(async () => {
	c = await checklists();
});

afterEach(() => c.close());

/** What `principal` is granted on checklist `thing` in `where`. */
const grantedTo = (principal: P3Principal, where: string, thing: string) =>
	c.holding(principal, where, thing, async (list) => [...list.granted].sort());

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the kind", () => {
	it("is registered with the things plugin as declared: anyone makes, many workspaces, Write by default", async () => {
		const entry = (await c.t.host.registry(ThingKinds, context)).value.get(ChecklistKind.name);
		assert.ok(entry !== undefined);
		assert.equal(entry.plugin, "@earendil-works/p3-checklist");
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
		assert.deepEqual(ChecklistKind.gives.get("write"), CHECKLIST_WRITES);
	});

	it("names a checklist by its thing, else Checklist, and follows a rename", async () => {
		const ann = await c.person("Ann");
		const unnamed = await c.checklistIn(c.pi);
		await c.holding(ann, c.pi, unnamed, async (list, ctx) => {
			assert.equal(list.name.value, "Checklist");
			await c.things.rename({ thing: unnamed, name: "Packing" }, context);
			await until(list.name, (name) => name === "Packing", within("the new name", ctx));
		});
	});

	it("drops a checklist's items when it goes with its last link, and only its", async () => {
		const ann = await c.person("Ann");
		const [gone, kept] = [await c.checklistIn(c.pi), await c.checklistIn(c.pi)];
		await c.holding(ann, c.pi, gone, (list, ctx) => list.add!({ text: "gone" }, ctx));
		await c.holding(ann, c.pi, kept, (list, ctx) => list.add!({ text: "kept" }, ctx));
		await c.things.unlink({ workspace: c.pi, thing: gone }, context);
		const stored = async (checklist: string) =>
			(await (await c.t.host.get(ChecklistStore, {}, context)).items.of.page({ checklist }, 10, context)).items;
		await eventually(
			() => stored(gone),
			(rows) => rows.length === 0,
			2000,
		);
		assert.deepEqual(
			(await stored(kept)).map(({ text }) => text),
			["kept"],
		);
	});
});

describe("who may do what in a checklist", () => {
	it("gives a person put in and the session's agent Write; nobody outside is let in", async () => {
		const s1 = await c.workspace("s1");
		const ann = await c.person("Ann", s1);
		const list = await c.checklistIn(s1);
		const writes = [...CHECKLIST_WRITES].sort();
		assert.deepEqual(await grantedTo(ann, s1, list), writes);
		assert.deepEqual(await grantedTo({ kind: "worker", session: "s1" }, s1, list), writes);
		await refused(grantedTo({ kind: "worker", session: "s2" }, s1, list));
		const dana = await c.things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(grantedTo({ kind: "person", id: dana, name: "Dana" }, s1, list));
	});

	it("follows the grants live on the same hold: Write withheld leaves a reader, removed from Pi denied", async () => {
		const ann = await c.person("Ann");
		const thing = await c.checklistIn(c.pi);
		await c.holding(ann, c.pi, thing, async (list, ctx) => {
			await list.add!({ text: "milk" }, ctx);
			await c.write(c.pi, thing, { kind: "person", person: ann.id }, false);
			await until(list.state, (state) => state.kind === "live" && list.add === undefined, within("a reader", ctx));
			assert.deepEqual([list.tick, list.granted.size], [undefined, 0]);
			assert.deepEqual(
				list.items.value.map(({ text }) => text),
				["milk"],
			);
			await c.things.removeParty({ workspace: c.pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				list.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});
});

describe("a checklist's items", () => {
	it("are the checklist's: the same in every workspace it is linked in, ticked live for every holder", async () => {
		const [s1, s2] = [await c.workspace("s1"), await c.workspace("s2")];
		const [ann, ben] = [await c.person("Ann", s1), await c.person("Ben", s2)];
		const shared = await c.checklistIn(s1, "Plan");
		await c.things.link({ workspace: s2, thing: shared, by: BY }, context);
		await c.write(s2, shared, { kind: "person", person: ben.id }, false);
		await c.holding(ben, s2, shared, async (watching, outer) => {
			assert.equal(watching.add, undefined);
			await c.holding(ann, s1, shared, async (list, ctx) => {
				const [first, second] = [await list.add!({ text: "tent" }, ctx), await list.add!({ text: "stove" }, ctx)];
				await list.tick!({ id: second, done: true }, ctx);
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
		const [thing, other] = [await c.checklistIn(c.pi), await c.checklistIn(c.pi)];
		const elsewhere = await c.holding(ann, c.pi, other, (list, ctx) => list.add!({ text: "other" }, ctx));
		await c.holding(ann, c.pi, thing, async (list, ctx) => {
			await refused(list.tick!({ id: elsewhere, done: true }, ctx), "invalid");
			await refused(list.add!({ text: "" }, ctx), "invalid");
			await refused(list.add!({ text: "x".repeat(501) }, ctx), "invalid");
			for (let i = 0; i < 500; i++) await list.add!({ text: `i${i}` }, ctx);
			await refused(list.add!({ text: "one too many" }, ctx), "invalid");
			await until(list.items, (items) => items.length === 500, within("all 500", ctx));
		});
		assert.deepEqual(await c.holding(ann, c.pi, other, async (list) => list.items.value), [
			{ id: elsewhere, text: "other", done: false },
		]);
	});
});
